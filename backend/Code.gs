/**
 * Tente Buyer – Google Apps Script backend.
 *
 * Lives inside the "Tente Buyers Log" Google Sheet (Extensions > Apps Script).
 * The phone app sends purchases here and gets the dropdown lists back.
 *
 * Golden rules this script follows:
 *  - It never writes to Purchases columns I (Net kg) and K (Amount paid):
 *    those are filled by ARRAYFORMULAs in row 3.
 *  - A purchase whose Record ID is already in column Q is never written twice.
 *  - Only one phone writes at a time (LockService), so rows never overwrite.
 *  - Agent code + PIN are checked on every request; inactive agents are refused.
 */

var CFG = {
  PURCHASES: 'Purchases',
  LISTS: 'Lists',
  AGENTS: 'Agents',
  HEADER_ROW: 3,
  FIRST_ROW: 4,
  MAX_BATCH: 50,
  LOCK_WAIT_MS: 30000,
  MAX_FAILED_LOGINS: 5,
  LOCKOUT_MINUTES: 30,
  VERSION: '1.0.0'
};

// Purchases columns (1-based). I (9) and K (11) are deliberately absent.
var COL = {
  DATE: 1, POINT: 2, AGENT: 3, PICKER: 4, SPECIES: 5, GRADE: 6, GROSS: 7, TARE: 8,
  PRICE: 10, PAYMENT: 12, RECEIPT: 13, LOT: 14, SENT_TO: 15, NOTES: 16,
  RECORD_ID: 17, DEVICE: 18, SYNCED_AT: 19, RECORDED_AT: 20
};
var SYNC_HEADERS = ['Record ID', 'Device / agent code', 'Synced at', 'Recorded at (phone)'];

// Agents tab columns (1-based).
var AG = { CODE: 1, NAME: 2, HOME: 3, ACTIVE: 4, NEW_PIN: 5, PIN_HASH: 6, LAST_SYNC: 7, WAITING: 8, DEVICE: 9 };
var AGENT_HEADERS = ['Agent code', 'Name', 'Home buying point', 'Active (Yes/No)', 'New PIN (type here)',
  'PIN hash (do not edit)', 'Last sync', 'Waiting on phone', 'Device / app version'];

var DEFAULT_POINT_CODES = {
  'Mwinilunga': 'MW', 'Solwezi': 'SZ', 'Mkushi': 'MK', 'Kaoma': 'KA',
  'Mufulira': 'MF', 'Lusaka': 'LS', 'Other': 'OT'
};

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------- web app

/** Opening the web app URL in a browser shows this: a quick "is it alive" check. */
function doGet() {
  return json_({ ok: true, app: 'Tente Buyer backend', version: CFG.VERSION });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  try {
    if (req.action === 'login') return json_(login_(req));
    if (req.action === 'sync') return json_(sync_(req));
    return json_({ ok: false, error: 'bad_request' });
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'server', message: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- login

function login_(req) {
  var auth = auth_(req.agent, req.pin);
  if (!auth.ok) return auth;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var last = lastReceiptFor_(ss.getSheetByName(CFG.PURCHASES), auth.agent.code);
  touchAgent_(auth.agent, req, null);
  return {
    ok: true,
    agent: { code: auth.agent.code, name: auth.agent.name, home: auth.agent.home },
    lastSeq: last.seq,
    lastLot: last.lot,
    lists: readLists_(ss),
    serverTime: new Date().toISOString()
  };
}

/** Checks agent code + PIN. Hashes a freshly typed PIN on the way. */
function auth_(rawCode, rawPin) {
  var code = String(rawCode || '').trim().toUpperCase();
  var pin = String(rawPin || '').trim();
  if (!code || !pin) return { ok: false, error: 'bad_login' };

  var cache = CacheService.getScriptCache();
  var failKey = 'fail:' + code;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= CFG.MAX_FAILED_LOGINS) return { ok: false, error: 'locked' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.AGENTS);
  if (!sheet || sheet.getLastRow() < 2) return { ok: false, error: 'bad_login' };
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, AGENT_HEADERS.length).getValues();

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r[AG.CODE - 1]).trim().toUpperCase() !== code) continue;
    var rowNum = i + 2;
    var hash = String(r[AG.PIN_HASH - 1] || '');
    var typedPin = String(r[AG.NEW_PIN - 1] || '').trim();
    if (typedPin) {
      hash = pinHash_(code, typedPin);
      sheet.getRange(rowNum, AG.PIN_HASH).setValue(hash);
      sheet.getRange(rowNum, AG.NEW_PIN).setValue('');
    }
    if (!hash || pinHash_(code, pin) !== hash) break;
    if (!isYes_(r[AG.ACTIVE - 1])) return { ok: false, error: 'inactive' };
    cache.remove(failKey);
    return {
      ok: true,
      agent: { code: code, name: String(r[AG.NAME - 1] || code), home: String(r[AG.HOME - 1] || ''), row: rowNum }
    };
  }
  cache.put(failKey, String(fails + 1), CFG.LOCKOUT_MINUTES * 60);
  return { ok: false, error: 'bad_login' };
}

function isYes_(v) {
  return v === true || /^(yes|y|true|1)$/i.test(String(v).trim());
}

function pinHash_(code, pin) {
  var props = PropertiesService.getScriptProperties();
  var salt = props.getProperty('PIN_SALT');
  if (!salt) {
    salt = Utilities.getUuid();
    props.setProperty('PIN_SALT', salt);
  }
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + code + ':' + pin,
    Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** Highest receipt sequence (and its lot) already in the sheet for this agent. */
function lastReceiptFor_(sheet, code) {
  var out = { seq: 0, lot: '' };
  var n = sheet.getLastRow() - CFG.FIRST_ROW + 1;
  if (n < 1) return out;
  var vals = sheet.getRange(CFG.FIRST_ROW, COL.RECEIPT, n, 2).getValues();
  var prefix = code + '-';
  for (var i = 0; i < vals.length; i++) {
    var receipt = String(vals[i][0]);
    if (receipt.indexOf(prefix) !== 0) continue;
    var seq = parseInt(receipt.slice(prefix.length), 10);
    if (seq > out.seq) out = { seq: seq, lot: String(vals[i][1] || '') };
  }
  return out;
}

function touchAgent_(agent, req, waiting) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.AGENTS);
  sheet.getRange(agent.row, AG.LAST_SYNC).setValue(new Date());
  if (waiting !== null) sheet.getRange(agent.row, AG.WAITING).setValue(waiting);
  sheet.getRange(agent.row, AG.DEVICE).setValue(String(req.device || '') + ' / v' + String(req.appVersion || '?'));
}

// ---------------------------------------------------------------- sync

function sync_(req) {
  var auth = auth_(req.agent, req.pin);
  if (!auth.ok) return auth;
  var agent = auth.agent;
  var records = Array.isArray(req.records) ? req.records.slice(0, CFG.MAX_BATCH) : [];
  var results = [];

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG.LOCK_WAIT_MS)) return { ok: false, error: 'busy' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(CFG.PURCHASES);
    var existing = readExisting_(sheet);
    var newRows = [];
    var seenInBatch = {};

    records.forEach(function (rec) {
      var id = rec && String(rec.id || '');
      if (existing.ids[id] || seenInBatch[id]) {
        results.push({ id: id, status: 'duplicate' });
        return;
      }
      var problem = validate_(rec, agent);
      if (problem) {
        results.push({ id: id, status: 'rejected', error: problem });
        return;
      }
      seenInBatch[id] = true;
      var note = String(rec.notes || '');
      if (existing.receipts[rec.receipt]) note = (note ? note + ' ' : '') + '⚠ Receipt no. used twice – check';
      existing.receipts[rec.receipt] = true;
      newRows.push(toRow_(rec, agent, req.device, note));
      results.push({ id: id, status: 'saved' });
    });

    if (newRows.length) writeRows_(sheet, existing.lastRow + 1, newRows);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  var done = results.filter(function (r) { return r.status !== 'rejected'; }).length;
  var waiting = Math.max(0, Number(req.pending || 0) - done);
  touchAgent_(agent, req, waiting);

  return {
    ok: true,
    results: results,
    lists: req.wantLists === false ? undefined : readLists_(SpreadsheetApp.getActiveSpreadsheet()),
    serverTime: new Date().toISOString()
  };
}

/** Record IDs and receipt numbers already in the sheet, and the last used row. */
function readExisting_(sheet) {
  var ids = {}, receipts = {};
  var lastRow = CFG.HEADER_ROW;
  var n = sheet.getLastRow() - CFG.FIRST_ROW + 1;
  if (n > 0) {
    var vals = sheet.getRange(CFG.FIRST_ROW, 1, n, COL.RECORDED_AT).getValues();
    for (var i = 0; i < vals.length; i++) {
      var row = vals[i];
      var id = String(row[COL.RECORD_ID - 1] || '');
      var receipt = String(row[COL.RECEIPT - 1] || '');
      if (id) ids[id] = true;
      if (receipt) receipts[receipt] = true;
      // A row counts as used if anything people or the app type into it is filled.
      if (row[COL.DATE - 1] !== '' || row[COL.PICKER - 1] !== '' || row[COL.GROSS - 1] !== '' || id) {
        lastRow = CFG.FIRST_ROW + i;
      }
    }
  }
  return { ids: ids, receipts: receipts, lastRow: lastRow };
}

function validate_(rec, agent) {
  if (!rec || typeof rec !== 'object') return 'not a record';
  if (!UUID_RE.test(String(rec.id || ''))) return 'bad record id';
  if (rec.type !== 'purchase' && rec.type !== 'void') return 'bad type';
  if (String(rec.agent || '').toUpperCase() !== agent.code) return 'record belongs to another agent';
  if (!DATE_RE.test(String(rec.date || ''))) return 'bad date';
  if (String(rec.receipt || '').indexOf(agent.code + '-') !== 0) return 'bad receipt number';
  if (!String(rec.picker || '').trim()) return 'picker name missing';
  var gross = Number(rec.gross), tare = Number(rec.tare), price = Number(rec.price);
  if (!isFinite(gross) || !isFinite(tare) || !isFinite(price)) return 'bad number';
  if (rec.type === 'purchase' && !(gross > 0 && tare >= 0 && tare < gross)) return 'bad weights';
  if (rec.type === 'void' && !(gross < 0)) return 'void must have negative weight';
  if (price < 0) return 'negative price';
  return '';
}

function toRow_(rec, agent, device, note) {
  var m = DATE_RE.exec(rec.date);
  var recorded = rec.createdAt ? new Date(rec.createdAt) : '';
  return {
    main: [new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), text_(rec.point), text_(agent.name),
      text_(rec.picker), text_(rec.species), text_(rec.grade), Number(rec.gross), Number(rec.tare)],
    price: [Number(rec.price)],
    tail: [text_(rec.payment), text_(rec.receipt), text_(rec.lot), text_(rec.sentTo), text_(note)],
    sync: [rec.id, text_(agent.code + ' / ' + String(device || '')), new Date(), recorded]
  };
}

/** Stops a picker name like "=1+1" from turning into a formula. */
function text_(v) {
  var s = String(v === undefined || v === null ? '' : v).slice(0, 500);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/**
 * Writes rows in four blocks, skipping I and K. The Record ID block goes last:
 * if anything fails half-way, the row has no ID and the phone simply sends it again.
 */
function writeRows_(sheet, startRow, rows) {
  var n = rows.length;
  var needed = startRow + n - 1;
  if (needed > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows() + 100);

  sheet.getRange(startRow, COL.DATE, n, 1).setNumberFormat('dd/mm/yyyy');
  sheet.getRange(startRow, COL.POINT, n, 5).setNumberFormat('@');
  sheet.getRange(startRow, COL.GROSS, n, 2).setNumberFormat('0.0');
  sheet.getRange(startRow, COL.PRICE, n, 1).setNumberFormat('0.00');
  sheet.getRange(startRow, COL.PAYMENT, n, 5).setNumberFormat('@');
  sheet.getRange(startRow, COL.RECORD_ID, n, 2).setNumberFormat('@');
  sheet.getRange(startRow, COL.SYNCED_AT, n, 2).setNumberFormat('dd/mm/yyyy hh:mm');

  sheet.getRange(startRow, COL.DATE, n, 8).setValues(rows.map(function (r) { return r.main; }));
  sheet.getRange(startRow, COL.PRICE, n, 1).setValues(rows.map(function (r) { return r.price; }));
  sheet.getRange(startRow, COL.PAYMENT, n, 5).setValues(rows.map(function (r) { return r.tail; }));
  sheet.getRange(startRow, COL.RECORD_ID, n, 4).setValues(rows.map(function (r) { return r.sync; }));
}

// ---------------------------------------------------------------- lists

function readLists_(ss) {
  var vals = ss.getSheetByName(CFG.LISTS).getRange('A2:H30').getValues();
  var col = function (i) {
    return vals.map(function (r) { return String(r[i]).trim(); }).filter(String);
  };
  var desc = {};
  vals.forEach(function (r) { if (String(r[5]).trim()) desc[String(r[5]).trim()] = String(r[6]).trim(); });
  var points = [];
  vals.forEach(function (r) {
    var name = String(r[0]).trim();
    if (!name) return;
    var code = String(r[7]).trim().toUpperCase() || DEFAULT_POINT_CODES[name] || name.slice(0, 2).toUpperCase();
    points.push({ name: name, code: code });
  });
  return {
    points: points,
    species: col(1),
    grades: col(2).map(function (g) { return { grade: g, desc: desc[g] || '' }; }),
    payments: col(3),
    sentTo: col(4)
  };
}

// ---------------------------------------------------------------- admin menu

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Tente app')
    .addItem('Set up sheet for the app (run once)', 'setupSheet')
    .addItem('Secure new PINs now', 'secureNewPins')
    .addToUi();
}

/**
 * One-time setup: adds the sync columns Q–T, the buying point codes in Lists!H
 * and the Agents tab. Safe to run again: it never overwrites anything filled in.
 */
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var p = ss.getSheetByName(CFG.PURCHASES);

  var head = p.getRange(CFG.HEADER_ROW, COL.RECORD_ID, 1, 4).getValues()[0];
  for (var i = 0; i < 4; i++) {
    if (head[i] !== '' && head[i] !== SYNC_HEADERS[i]) {
      ui.alert('Purchases cell ' + String.fromCharCode(81 + i) + '3 already says "' + head[i] +
        '". Clear Q3:T3 or move that column, then run setup again. Nothing was changed.');
      return;
    }
  }
  p.getRange(CFG.HEADER_ROW, COL.RECORD_ID, 1, 4).setValues([SYNC_HEADERS]).setFontWeight('bold');
  p.getRange(CFG.HEADER_ROW + 1, COL.RECORD_ID, p.getMaxRows() - CFG.HEADER_ROW, 4).setBackground('#eeeeee');

  var lists = ss.getSheetByName(CFG.LISTS);
  if (lists.getRange('H1').getValue() === '') lists.getRange('H1').setValue('Buying point code').setFontWeight('bold');
  var names = lists.getRange('A2:A30').getValues();
  var codes = lists.getRange('H2:H30').getValues();
  for (var r = 0; r < names.length; r++) {
    var name = String(names[r][0]).trim();
    if (name && String(codes[r][0]).trim() === '') {
      codes[r][0] = DEFAULT_POINT_CODES[name] || name.slice(0, 2).toUpperCase();
    }
  }
  lists.getRange('H2:H30').setValues(codes);

  var ag = ss.getSheetByName(CFG.AGENTS);
  if (!ag) {
    ag = ss.insertSheet(CFG.AGENTS);
    ag.getRange(1, 1, 1, AGENT_HEADERS.length).setValues([AGENT_HEADERS]).setFontWeight('bold');
    ag.setFrozenRows(1);
    ag.getRange('E2:E200').setNumberFormat('@');
    ag.getRange('F2:I200').setBackground('#eeeeee');
    ag.getRange('D2:D200').setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).build());
    ag.getRange('C2:C200').setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInRange(lists.getRange('A2:A30'), true).setAllowInvalid(true).build());
    ag.getRange('G2:G200').setNumberFormat('dd/mm/yyyy hh:mm');
    ag.autoResizeColumns(1, AGENT_HEADERS.length);
  }
  pinHash_('setup', 'setup'); // makes sure the PIN salt exists
  ui.alert('Done. Next: add your agents on the Agents tab (code, name, home buying point, Active = Yes, ' +
    'and a 4-digit PIN in "New PIN"). Then choose Tente app > Secure new PINs now.');
}

/** Replaces every typed PIN on the Agents tab with its hash. */
function secureNewPins() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.AGENTS);
  var n = sheet.getLastRow() - 1;
  var count = 0;
  if (n > 0) {
    var rows = sheet.getRange(2, 1, n, AG.PIN_HASH).getValues();
    rows.forEach(function (r, i) {
      var code = String(r[AG.CODE - 1]).trim().toUpperCase();
      var pin = String(r[AG.NEW_PIN - 1]).trim();
      if (!code || !pin) return;
      sheet.getRange(i + 2, AG.PIN_HASH).setValue(pinHash_(code, pin));
      sheet.getRange(i + 2, AG.NEW_PIN).setValue('');
      CacheService.getScriptCache().remove('fail:' + code);
      count++;
    });
  }
  SpreadsheetApp.getUi().alert(count + ' PIN(s) secured. Give each agent their PIN in person or by phone call.');
}
