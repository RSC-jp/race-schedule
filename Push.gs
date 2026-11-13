/**
 * Push.gs  ―  Apps Script プロジェクトに「新しいファイル」として追加
 *
 * 【Code.gs の doGet を、下のものに置き換えてください】
 *
 * function doGet(e) {
 *   if (e && e.parameter && e.parameter.action) return handleApi_(e);
 *   return HtmlService.createTemplateFromFile('Index')
 *     .evaluate()
 *     .setTitle('Race Event Live Schedule')
 *     .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
 * }
 *
 * （action が無いアクセスは従来どおり Index.html を返すので、既存ページは壊れません）
 *
 * 【スクリプトプロパティに登録するもの】
 *   SA_JSON : Firebase のサービスアカウント鍵(JSON)の中身を丸ごと貼り付け
 */

const PUSH = {
  SUB_SHEET: 'Subscribers',
  LEADS: [10, 15, 30],     // 選べる「何分前」
  WINDOW_MIN: 2,           // トリガーのズレを吸収する幅(分)
  HORIZON_MIN: 31,         // これより先のセッションは見ない
  DEDUP_SEC: 6 * 60 * 60,  // 重複送信防止の保持時間
  APP_URL: 'https://YOUR_NAME.github.io/YOUR_REPO/'  // 通知タップ時に開くURL
};

/* ===================== API ===================== */

function handleApi_(e) {
  try {
    const action = e.parameter.action;
    if (action === 'schedule') {
      return json_({ ok: true, data: getSchedule(), serverTime: Date.now(), timezone: CONFIG.TIMEZONE });
    }
    throw new Error('unknown action');
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'subscribe') {
      upsertSubscriber_(body.token, Number(body.leadMin));
      return json_({ ok: true });
    }
    if (body.action === 'unsubscribe') {
      removeSubscriber_(body.token);
      return json_({ ok: true });
    }
    throw new Error('unknown action');
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ===================== 登録情報(Subscribers シート) ===================== */

function getSubSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(PUSH.SUB_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PUSH.SUB_SHEET);
    sh.appendRow(['token', 'leadMin', 'createdAt', 'updatedAt']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function upsertSubscriber_(token, leadMin) {
  if (!/^[\w:\-]{50,400}$/.test(String(token || ''))) throw new Error('invalid token');
  if (PUSH.LEADS.indexOf(leadMin) === -1) throw new Error('invalid leadMin');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = getSubSheet_();
    const now = new Date();
    const hit = sh.createTextFinder(token).matchEntireCell(true).findNext();
    if (hit && hit.getColumn() === 1) {
      sh.getRange(hit.getRow(), 2).setValue(leadMin);
      sh.getRange(hit.getRow(), 4).setValue(now);
    } else {
      sh.appendRow([token, leadMin, now, now]);
    }
  } finally {
    lock.releaseLock();
  }
}

function removeSubscriber_(token) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = getSubSheet_();
    const hit = sh.createTextFinder(String(token)).matchEntireCell(true).findNext();
    if (hit && hit.getColumn() === 1 && hit.getRow() > 1) sh.deleteRow(hit.getRow());
  } finally {
    lock.releaseLock();
  }
}

function loadSubscribers_() {
  const sh = getSubSheet_();
  const values = sh.getDataRange().getValues();
  return values.slice(1)
    .filter(r => r[0] && PUSH.LEADS.indexOf(Number(r[1])) !== -1)
    .map(r => ({ token: String(r[0]), lead: Number(r[1]) }));
}

/* ===================== 通知判定(1分ごとのトリガーで実行) ===================== */

function checkAndNotify() {
  const now = new Date();
  const subs = loadSubscribers_();
  if (!subs.length) return;

  const sessions = getUpcomingSessions_(now, PUSH.HORIZON_MIN);
  if (!sessions.length) return;

  const cache = CacheService.getScriptCache();
  const jobs = [];

  sessions.forEach(s => {
    const minutesUntil = (s.start.getTime() - now.getTime()) / 60000;
    PUSH.LEADS.forEach(lead => {
      // 開始まで lead 分以内、かつ lead - WINDOW_MIN 分より前
      if (minutesUntil > lead || minutesUntil <= lead - PUSH.WINDOW_MIN) return;
      subs.filter(x => x.lead === lead).forEach(sub => {
        const key = dedupKey_(sub.token, s, lead);
        if (cache.get(key)) return;
        jobs.push({ sub, s, lead, key });
      });
    });
  });

  if (!jobs.length) return;
  sendJobs_(jobs, cache);
}

function getUpcomingSessions_(now, horizonMin) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const limit = new Date(now.getTime() + horizonMin * 60000);
  const out = [];

  ss.getSheets()
    .filter(sh => sh.getName().startsWith(CONFIG.SHEET_PREFIX))
    .forEach(sh => {
      sh.getDataRange().getValues().slice(1).forEach(row => {
        if (!row[0] || !row[1] || !row[2] || !row[3]) return;
        const start = parseDateTime_(row[0], row[1]);
        if (!start || start <= now || start > limit) return;
        out.push({
          start,
          startStr: formatTime(row[1]),
          name: String(row[3] || ''),
          category: String(row[4] || ''),
          className: String(row[5] || ''),
          venue: String(row[6] || '')
        });
      });
    });
  return out;
}

function dedupKey_(token, s, lead) {
  const raw = [token, s.start.getTime(), s.name, lead].join('|');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  return 'sent_' + Utilities.base64EncodeWebSafe(digest);
}

/* ===================== FCM 送信 ===================== */

function sendJobs_(jobs, cache) {
  const sa = JSON.parse(PropertiesService.getScriptProperties().getProperty('SA_JSON'));
  const accessToken = getAccessToken_(sa);
  const url = 'https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send';

  const requests = jobs.map(j => {
    const detail = [j.s.className || j.s.category, j.s.venue].filter(Boolean).join(' / ');
    return {
      url: url,
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + accessToken },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        message: {
          token: j.sub.token,
          data: {
            title: j.lead + '分後に開始：' + j.s.name,
            body: j.s.startStr + ' 開始' + (detail ? '（' + detail + '）' : ''),
            tag: 'session-' + j.s.start.getTime() + '-' + j.lead,
            url: PUSH.APP_URL
          },
          webpush: { headers: { TTL: '600', Urgency: 'high' } }
        }
      })
    };
  });

  const responses = UrlFetchApp.fetchAll(requests);
  responses.forEach((res, i) => {
    const code = res.getResponseCode();
    if (code === 200) {
      cache.put(jobs[i].key, '1', PUSH.DEDUP_SEC);
    } else if (code === 404 || (code === 400 && /INVALID_ARGUMENT|UNREGISTERED/.test(res.getContentText()))) {
      removeSubscriber_(jobs[i].sub.token);   // 無効トークンを掃除
    } else {
      console.error('FCM error ' + code + ': ' + res.getContentText());
    }
  });
}

function getAccessToken_(sa) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('fcm_access_token');
  if (cached) return cached;

  const now = Math.floor(Date.now() / 1000);
  const enc = o => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  });
  const sig = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(unsigned, sa.private_key)
  ).replace(/=+$/, '');

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + sig
    }
  });
  const token = JSON.parse(res.getContentText()).access_token;
  cache.put('fcm_access_token', token, 3000);
  return token;
}

/* ===================== セットアップ用(手動で1回ずつ実行) ===================== */

// 1分ごとのトリガーを作成(重複を避けるため既存は削除)
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkAndNotify')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkAndNotify').timeBased().everyMinutes(1).create();
}

// Subscribers シートの全員にテスト通知を送る
function testPush() {
  const subs = loadSubscribers_();
  if (!subs.length) { console.log('登録者がいません'); return; }
  const fake = { start: new Date(Date.now() + 10 * 60000), startStr: '--:--', name: 'テスト通知', className: '', venue: '', category: '' };
  const jobs = subs.map(sub => ({ sub, s: fake, lead: sub.lead, key: 'test_' + Math.random() }));
  sendJobs_(jobs, CacheService.getScriptCache());
}
