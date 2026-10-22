import * as db from './db.js';
import { Syncer, callApi, AUTH_ERRORS } from './sync.js';
import {
  APP_VERSION, REJECT_GRADE, parseNum, netKg, amountK, formatK, formatKg, localISODate, displayDate,
  receiptNo, lotNo, parseLot, checkPurchase, makeVoid, totals, toCSV, toWhatsAppText, ago
} from './logic.js';

const config = window.TENTE_CONFIG || {};
const SYNC_EVERY_MS = 3 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  session: null,
  lists: null,
  prefs: { tare: '', prices: {}, species: '', payment: '', sentTo: '', point: '' },
  pick: { species: '', grade: '', payment: '', sentTo: '' },
  receiptRecord: null,
  view: 'login'
};

const syncer = new Syncer({ apiUrl: config.apiUrl, onChange: () => refreshStatus() });

// ------------------------------------------------------------------ helpers

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function deviceId() {
  let id = await db.getMeta('device');
  if (!id) {
    id = [...crypto.getRandomValues(new Uint8Array(3))].map(x => x.toString(16).padStart(2, '0')).join('');
    await db.setMeta('device', id);
  }
  return id;
}

const dialog = $('dialog');
/** Shows a message. Resolves true for OK, false for Back. */
function ask(html, { ok = 'OK', cancel = 'Back', okClass = 'primary' } = {}) {
  $('dialog-body').innerHTML = html;
  $('dialog-ok').textContent = ok;
  $('dialog-ok').className = `btn ${okClass}`;
  $('dialog-cancel').textContent = cancel;
  $('dialog-cancel').classList.toggle('hidden', !cancel);
  dialog.showModal();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}
const tell = html => ask(html, { cancel: '' });

function showView(name) {
  state.view = name;
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('hidden', v.id !== `view-${name}`);
  const loggedIn = name !== 'login';
  $('status').classList.toggle('hidden', !loggedIn);
  $('tabs').classList.toggle('hidden', !loggedIn);
  const tab = name === 'receipt' ? 'new' : name;
  for (const t of document.querySelectorAll('.tab')) {
    if (t.dataset.view === tab) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  if (name === 'today') renderToday();
  if (name === 'sync') renderSync();
}

// ------------------------------------------------------------------ status bar

async function refreshStatus() {
  if (!state.session) return;
  const [pending, lastSync, syncError] = await Promise.all([
    db.countPending(), db.getMeta('lastSync'), db.getMeta('syncError')
  ]);
  const badge = $('pending-badge');
  badge.textContent = `${pending} waiting`;
  badge.classList.toggle('has-pending', pending > 0);
  $('tab-badge').textContent = pending;
  $('tab-badge').classList.toggle('hidden', pending === 0);
  $('last-sync').textContent = syncer.running ? 'Syncing…' : `Last sync: ${ago(lastSync)}`;
  $('sync-btn').disabled = !!syncer.running;
  $('sync-now-2').disabled = !!syncer.running;

  const warn = $('stale-warning');
  let msg = '';
  if (syncError && AUTH_ERRORS[syncError.error]) msg = AUTH_ERRORS[syncError.error];
  else if (!lastSync || Date.now() - Date.parse(lastSync) > STALE_MS) {
    msg = `Not synced for over 24 hours. Find signal and tap Sync now.${pending ? ` ${pending} purchases are only on this phone.` : ''}`;
  }
  warn.textContent = msg;
  warn.classList.toggle('hidden', !msg);
  if (state.view === 'sync') renderSync();
  if (state.view === 'receipt' && state.receiptRecord && state.receiptRecord.pending) {
    const fresh = await db.getRecord(state.receiptRecord.id);
    if (fresh && !fresh.pending) { state.receiptRecord = fresh; $('receipt-sync-state').textContent = syncStateText(fresh); }
  }
  state.lists = (await db.getMeta('lists')) || state.lists;
}

async function syncNow(reason) {
  if (!navigator.onLine && reason !== 'button') return;
  const res = await syncer.sync(reason);
  await refreshStatus();
  return res;
}

// ------------------------------------------------------------------ login

async function doLogin(e) {
  e.preventDefault();
  const code = $('login-code').value.trim().toUpperCase();
  const pin = $('login-pin').value.trim();
  const err = $('login-error');
  err.textContent = '';
  if (!config.apiUrl) { err.textContent = 'App is not set up: the sheet link is missing (config.js).'; return; }
  $('login-btn').disabled = true;
  $('login-btn').textContent = 'Checking…';
  try {
    const device = await deviceId();
    const res = await callApi(config.apiUrl, { action: 'login', agent: code, pin, device });
    if (!res.ok) { err.textContent = AUTH_ERRORS[res.error] || `Login failed (${res.error}).`; return; }

    // Continue receipt and lot numbers from what the sheet already has (e.g. after a reinstall).
    const seqKey = `seq:${res.agent.code}`;
    const localSeq = await db.getMeta(seqKey, 0);
    if (res.lastSeq > localSeq) await db.setMeta(seqKey, res.lastSeq);
    const lot = parseLot(res.lastLot);
    if (lot) {
      const lots = await db.getMeta(`lots:${res.agent.code}`, {});
      const key = `${lot.date}|${lot.pointCode}`;
      if (!(lots[key] >= lot.n)) { lots[key] = lot.n; await db.setMeta(`lots:${res.agent.code}`, lots); }
    }
    state.session = { code: res.agent.code, name: res.agent.name, home: res.agent.home, pin, device };
    await db.setMeta('session', state.session);
    await db.setMeta('lists', res.lists);
    await db.setMeta('lastSync', new Date().toISOString());
    await db.setMeta('syncError', null);
    state.lists = res.lists;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    $('login-pin').value = '';
    await startApp();
  } catch (ex) {
    err.textContent = 'No connection to the sheet. Find signal (or Wi-Fi) and try again.';
  } finally {
    $('login-btn').disabled = false;
    $('login-btn').textContent = 'Log in';
  }
}

async function logout() {
  const pending = await db.countPending();
  if (pending > 0) {
    await tell(`<p><strong>You cannot log out yet.</strong></p><p>${pending} purchases are only on this phone. Sync first.</p>`);
    return;
  }
  if (!(await ask('<p>Log out from this phone? You will need internet to log in again.</p>', { ok: 'Log out', okClass: 'danger' }))) return;
  await db.setMeta('session', null);
  state.session = null;
  showView('login');
}

// ------------------------------------------------------------------ purchase form

function renderChoices(containerId, options, selected, onPick) {
  const box = $(containerId);
  box.innerHTML = '';
  for (const opt of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'choice';
    b.textContent = opt;
    b.dataset.value = opt;
    b.setAttribute('aria-pressed', String(opt === selected));
    b.addEventListener('click', () => {
      for (const other of box.children) other.setAttribute('aria-pressed', String(other === b));
      onPick(opt);
    });
    box.appendChild(b);
  }
}

function pointCode(name) {
  const p = (state.lists.points || []).find(x => x.name === name);
  return p ? p.code : String(name || 'XX').slice(0, 2).toUpperCase();
}

async function currentLot() {
  const date = $('f-date').value;
  const code = pointCode($('f-point').value);
  const lots = await db.getMeta(`lots:${state.session.code}`, {});
  return lotNo(code, date || localISODate(), state.session.code, lots[`${date}|${code}`] || 1);
}

async function refreshLotAndReceipt() {
  $('f-lot').textContent = await currentLot();
  const seq = await db.getMeta(`seq:${state.session.code}`, 0);
  $('f-receipt').textContent = receiptNo(state.session.code, seq + 1);
}

async function newLot() {
  const date = $('f-date').value;
  const code = pointCode($('f-point').value);
  const key = `${date}|${code}`;
  const lots = await db.getMeta(`lots:${state.session.code}`, {});
  const next = (lots[key] || 1) + 1;
  const label = lotNo(code, date, state.session.code, next);
  if (!(await ask(`<p>Close the current lot and start lot <strong>${esc(label)}</strong>?</p>`, { ok: 'Start new lot' }))) return;
  lots[key] = next;
  await db.setMeta(`lots:${state.session.code}`, lots);
  refreshLotAndReceipt();
}

function setGrade(g) {
  state.pick.grade = g;
  const info = (state.lists.grades || []).find(x => x.grade === g);
  $('grade-desc').textContent = info ? info.desc : '';
  const remembered = state.prefs.prices[g];
  if (g === REJECT_GRADE) {
    $('f-price').value = '0';
    const rejected = (state.lists.sentTo || []).find(s => /reject/i.test(s));
    if (rejected) pickChoice('f-sentto', rejected, v => { state.pick.sentTo = v; });
  } else if (remembered !== undefined) {
    $('f-price').value = String(remembered);
  } else if ($('f-price').value === '0') {
    $('f-price').value = '';
  }
  updateCalc();
}

function pickChoice(containerId, value, setter) {
  for (const b of $(containerId).children) b.setAttribute('aria-pressed', String(b.dataset.value === value));
  setter(value);
}

async function renderForm() {
  const lists = state.lists || { points: [], species: [], grades: [], payments: [], sentTo: [] };
  const sel = $('f-point');
  const chosenPoint = state.prefs.point || state.session.home || (lists.points[0] || {}).name || '';
  sel.innerHTML = lists.points.map(p => `<option${p.name === chosenPoint ? ' selected' : ''}>${esc(p.name)}</option>`).join('');

  const keep = (list, v) => (list.includes(v) ? v : list[0] || '');
  state.pick.species = keep(lists.species, state.prefs.species);
  state.pick.payment = keep(lists.payments, state.prefs.payment);
  state.pick.sentTo = keep(lists.sentTo, state.prefs.sentTo);
  state.pick.grade = '';

  renderChoices('f-species', lists.species, state.pick.species, v => { state.pick.species = v; });
  renderChoices('f-grade', lists.grades.map(g => g.grade), '', setGrade);
  renderChoices('f-payment', lists.payments, state.pick.payment, v => { state.pick.payment = v; });
  renderChoices('f-sentto', lists.sentTo, state.pick.sentTo, v => { state.pick.sentTo = v; });
  $('grade-desc').textContent = '';

  $('f-date').value = localISODate();
  $('f-date').max = localISODate();
  $('f-picker').value = '';
  $('f-gross').value = '';
  $('f-tare').value = state.prefs.tare === '' ? '' : String(state.prefs.tare);
  $('f-price').value = '';
  $('f-notes').value = '';
  $('form-errors').textContent = '';

  const recent = (await db.allRecords()).slice(-300).map(r => r.picker);
  $('pickers').innerHTML = [...new Set(recent.reverse())].slice(0, 80).map(p => `<option value="${esc(p)}">`).join('');
  await refreshLotAndReceipt();
  updateCalc();
}

function readForm() {
  return {
    date: $('f-date').value,
    point: $('f-point').value,
    picker: $('f-picker').value.trim().replace(/\s+/g, ' '),
    species: state.pick.species,
    grade: state.pick.grade,
    gross: parseNum($('f-gross').value),
    tare: $('f-tare').value.trim() === '' ? 0 : parseNum($('f-tare').value),
    price: parseNum($('f-price').value),
    payment: state.pick.payment,
    sentTo: state.pick.sentTo,
    notes: $('f-notes').value.trim()
  };
}

function updateCalc() {
  const f = readForm();
  const ok = f.gross > 0 && f.tare >= 0;
  const net = ok ? netKg(f.gross, f.tare) : NaN;
  $('calc-net').textContent = formatKg(net);
  $('calc-amount').textContent = ok && f.price >= 0 ? formatK(amountK(net, f.price)) : 'K –';
}

async function submitPurchase(e) {
  e.preventDefault();
  const f = readForm();
  const today = localISODate();
  const { errors, warnings } = checkPurchase(f, { usualPrice: state.prefs.prices[f.grade], today });
  $('form-errors').innerHTML = errors.map(esc).join('<br>');
  if (errors.length) { $('form-errors').scrollIntoView({ block: 'center' }); return; }

  const net = netKg(f.gross, f.tare);
  const amount = amountK(net, f.price);
  const html = `
    ${warnings.map(w => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}
    <div class="summary">
      <p>${esc(f.picker)} · Grade <b>${esc(f.grade)}</b> · ${esc(f.species)}</p>
      <p>${formatKg(f.gross)} − ${formatKg(f.tare)} = <strong>${formatKg(net)}</strong></p>
      <p>Pay ${esc(f.payment)}: <strong>${formatK(amount)}</strong></p>
    </div>
    <p class="muted">Saved purchases cannot be changed, only voided.</p>`;
  if (!(await ask(html, { ok: warnings.length ? 'Save anyway' : 'Save', cancel: 'Back' }))) return;

  const s = state.session;
  const lot = await currentLot();
  const pc = pointCode(f.point);
  const record = await db.saveWithNextSeq(`seq:${s.code}`, seq => ({
    id: uuid(),
    type: 'purchase',
    agent: s.code,
    agentName: s.name,
    device: s.device,
    date: f.date,
    createdAt: new Date().toISOString(),
    point: f.point,
    pointCode: pc,
    picker: f.picker,
    species: f.species,
    grade: f.grade,
    gross: f.gross,
    tare: f.tare,
    price: f.price,
    net,
    amount,
    payment: f.payment,
    receipt: receiptNo(s.code, seq),
    lot,
    sentTo: f.sentTo,
    notes: f.notes,
    pending: 1
  }));

  if (f.grade !== REJECT_GRADE) state.prefs.prices[f.grade] = f.price;
  Object.assign(state.prefs, { tare: f.tare, species: f.species, payment: f.payment, point: f.point,
    sentTo: f.grade === REJECT_GRADE ? state.prefs.sentTo : f.sentTo });
  await db.setMeta('prefs', state.prefs);

  await showReceipt(record);
  refreshStatus();
  syncNow('saved');
}

// ------------------------------------------------------------------ receipt and voids

async function findVoidOf(id) {
  return (await db.allRecords()).find(r => r.type === 'void' && r.voids === id) || null;
}

async function showReceipt(r) {
  state.receiptRecord = r;
  const voidedBy = r.type === 'purchase' ? await findVoidOf(r.id) : null;
  const created = new Date(r.createdAt);
  $('receipt').innerHTML = `
    <h2>Tente Mushrooms</h2>
    <p style="text-align:center;margin:0">${r.type === 'void' ? 'VOID RECEIPT' : 'Purchase receipt'}</p>
    ${r.type === 'void' ? `<p class="void-stamp">VOID – ${esc(r.notes)}</p>` : ''}
    ${voidedBy ? `<p class="void-stamp">VOIDED by ${esc(voidedBy.receipt)}</p>` : ''}
    <p class="big">${formatK(r.amount)}</p>
    <dl>
      <dt>Receipt</dt><dd>${esc(r.receipt)}</dd>
      <dt>Date</dt><dd>${displayDate(r.date)} ${created.toTimeString().slice(0, 5)}</dd>
      <dt>Picker</dt><dd>${esc(r.picker)}</dd>
      <dt>Species</dt><dd>${esc(r.species)}</dd>
      <dt>Grade</dt><dd>${esc(r.grade)}</dd>
      <dt>Gross</dt><dd>${formatKg(r.gross)}</dd>
      <dt>Crate</dt><dd>${formatKg(r.tare)}</dd>
      <dt>Net</dt><dd>${formatKg(r.net)}</dd>
      <dt>Price</dt><dd>${formatK(r.price)} /kg</dd>
      <dt>Paid by</dt><dd>${esc(r.payment)}</dd>
      <dt>Buying point</dt><dd>${esc(r.point)}</dd>
      <dt>Lot</dt><dd>${esc(r.lot)}</dd>
      <dt>Buyer</dt><dd>${esc(r.agentName)} (${esc(r.agent)})</dd>
      ${r.notes && r.type !== 'void' ? `<dt>Notes</dt><dd>${esc(r.notes)}</dd>` : ''}
    </dl>
    <p id="receipt-sync-state" class="muted small-text" style="text-align:center">${syncStateText(r)}</p>`;
  $('receipt-void').classList.toggle('hidden', r.type !== 'purchase' || !!voidedBy);
  showView('receipt');
}

const syncStateText = r => (r.pending ? 'Saved on phone – waiting to sync' : 'Synced to office');

function receiptText(r) {
  return [`Tente Mushrooms – ${r.type === 'void' ? 'VOID ' : ''}receipt ${r.receipt}`,
    `${displayDate(r.date)} · ${r.point} · lot ${r.lot}`,
    `Picker: ${r.picker}`, `${r.species}, grade ${r.grade}`,
    `Gross ${formatKg(r.gross)} − crate ${formatKg(r.tare)} = net ${formatKg(r.net)}`,
    `Price ${formatK(r.price)}/kg · Paid ${formatK(r.amount)} (${r.payment})`,
    r.type === 'void' ? r.notes : '', `Buyer: ${r.agentName} (${r.agent})`].filter(Boolean).join('\n');
}

async function shareReceipt() {
  const text = receiptText(state.receiptRecord);
  if (navigator.share) {
    try { await navigator.share({ text }); } catch (e) { /* agent closed the share sheet */ }
  } else {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }
}

async function voidCurrent() {
  const orig = state.receiptRecord;
  if (!orig || orig.type !== 'purchase' || (await findVoidOf(orig.id))) return;
  const ok = await ask(`
    <p><strong>Void receipt ${esc(orig.receipt)}?</strong></p>
    <p>${esc(orig.picker)} · ${formatKg(orig.net)} · ${formatK(orig.amount)}</p>
    <label>Reason (required)<input id="void-reason" class="big-input" maxlength="150"></label>
    <p class="muted small-text">The original stays in the records. A void receipt cancels it. If needed, record the purchase again correctly.</p>`,
  { ok: 'Void it', okClass: 'danger' });
  if (!ok) return;
  const reason = ($('void-reason') || {}).value ? $('void-reason').value.trim() : '';
  if (!reason) { await tell('<p>A reason is needed to void a purchase. Nothing was changed.</p>'); return; }

  const s = state.session;
  const record = await db.saveWithNextSeq(`seq:${s.code}`, seq => makeVoid(orig, {
    id: uuid(), receipt: receiptNo(s.code, seq), reason,
    createdAt: new Date().toISOString(), date: localISODate(), device: s.device
  }));
  await showReceipt(record);
  refreshStatus();
  syncNow('void');
}

// ------------------------------------------------------------------ today

async function renderToday() {
  const dateInput = $('today-date');
  if (!dateInput.value) dateInput.value = localISODate();
  const date = dateInput.value;
  $('today-title').textContent = date === localISODate() ? 'Today' : displayDate(date);
  const recs = (await db.recordsOn(date)).filter(r => r.agent === state.session.code);
  const t = totals(recs);

  const rows = (map, label) => {
    const keys = Object.keys(map).sort();
    if (!keys.length) return '';
    return `<table><thead><tr><th>${label}</th><th>Count</th><th>Net kg</th><th>Paid</th></tr></thead><tbody>
      ${keys.map(k => `<tr><td>${esc(k)}</td><td>${map[k].count}</td><td>${formatKg(map[k].net)}</td><td>${formatK(map[k].paid)}</td></tr>`).join('')}
      </tbody></table>`;
  };
  $('today-totals').innerHTML = `
    <div class="totals-head">
      <div class="stat">Purchases<strong>${t.purchases}</strong></div>
      <div class="stat">Net<strong>${formatKg(t.net)}</strong></div>
      <div class="stat">Paid<strong>${formatK(t.paid)}</strong></div>
    </div>
    ${t.voids ? `<p class="muted">${t.voids} void(s) included – their amounts are taken off.</p>` : ''}
    ${rows(t.byPayment, 'Payment')}
    ${rows(t.byGrade, 'Grade')}
    ${recs.length ? '' : '<p class="muted">No purchases on this day.</p>'}`;

  const list = $('today-list');
  list.innerHTML = '';
  for (const r of recs.slice().reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button">
      <span><strong>${esc(r.receipt)}</strong> ${esc(r.picker)}</span><strong class="${r.type === 'void' ? 'void' : ''}">${formatK(r.amount)}</strong>
      <span class="sub">${r.type === 'void' ? 'VOID · ' : ''}Grade ${esc(r.grade)} · ${formatKg(r.net)} · ${esc(r.payment)}</span>
      <span class="sub ${r.pending ? 'wait' : ''}">${r.pending ? 'waiting' : 'synced'}</span></button>`;
    li.firstChild.addEventListener('click', () => showReceipt(r));
    list.appendChild(li);
  }
}

// ------------------------------------------------------------------ sync screen and backup

async function renderSync() {
  const [pending, lastSync, lastAttempt, syncError, persisted] = await Promise.all([
    db.pendingRecords(), db.getMeta('lastSync'), db.getMeta('lastAttempt'), db.getMeta('syncError'),
    navigator.storage && navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false)
  ]);
  const problems = pending.filter(r => r.problem);
  const errText = syncError
    ? (AUTH_ERRORS[syncError.error] || (syncError.error === 'network' ? 'No connection (normal with no signal).' : `Sheet problem: ${syncError.error} ${syncError.message || ''}`))
    : '';
  const typedPin = $('repin') ? $('repin').value : '';
  const pinFocused = document.activeElement && document.activeElement.id === 'repin';
  $('sync-details').innerHTML = `
    <p><strong>${pending.length}</strong> purchases waiting to sync</p>
    <p>Last successful sync: <strong>${lastSync ? `${new Date(lastSync).toLocaleString('en-GB')} (${ago(lastSync)})` : 'never'}</strong></p>
    <p>Last try: ${lastAttempt ? ago(lastAttempt.at) : 'never'}${errText ? ` – <span class="error-text">${esc(errText)}</span>` : ''}</p>
    ${problems.length ? `<p class="error-text">${problems.length} purchase(s) refused by the sheet: ${problems.map(p => `${esc(p.receipt)} (${esc(p.problem)})`).join(', ')}. Tell Anton.</p>` : ''}
    <p class="muted small-text">The phone syncs by itself every few minutes when it has signal.</p>
    ${syncError && syncError.error === 'bad_login' ? `
      <label>New PIN from Anton <input id="repin" class="big-input" type="password" inputmode="numeric" pattern="[0-9]*"></label>
      <button type="button" id="repin-btn" class="btn primary block">Use new PIN and sync</button>` : ''}`;
  const repin = $('repin-btn');
  if (repin) {
    repin.onclick = useNewPin;
    $('repin').value = typedPin; // the screen refreshes itself; keep what the agent typed
    if (pinFocused) $('repin').focus();
  }
  $('phone-details').innerHTML = `
    <p>Agent: <strong>${esc(state.session.name)} (${esc(state.session.code)})</strong></p>
    <p>Phone ID: ${esc(state.session.device)} · App version ${APP_VERSION}</p>
    <p>Storage protected: ${persisted ? 'yes' : 'no – keep the app installed on the home screen'}</p>
    <p class="warning-text"><strong>Never clear this app’s data or uninstall it while purchases are waiting.</strong></p>`;
}

/** Anton changed the PIN in the sheet: take the new one without logging out (purchases may be waiting). */
async function useNewPin() {
  const pin = $('repin').value.trim();
  if (!pin) return;
  state.session.pin = pin;
  await db.setMeta('session', state.session);
  await db.setMeta('syncError', null);
  await syncNow('button');
  renderSync();
}

async function exportCSV() {
  const recs = await db.pendingRecords();
  if (!recs.length) { await tell('<p>Nothing waiting – everything is already synced.</p>'); return; }
  const name = `tente-${state.session.code}-unsynced-${localISODate()}.csv`;
  const file = new File([toCSV(recs)], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function exportWhatsApp() {
  const recs = await db.pendingRecords();
  if (!recs.length) { await tell('<p>Nothing waiting – everything is already synced.</p>'); return; }
  const text = toWhatsAppText(recs, state.session.code);
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

// ------------------------------------------------------------------ start up

async function startApp() {
  state.prefs = Object.assign(state.prefs, await db.getMeta('prefs', {}));
  state.lists = await db.getMeta('lists');
  await renderForm();
  showView('new');
  refreshStatus();
  syncNow('start');
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let updating = false;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = worker => {
      $('update-bar').classList.remove('hidden');
      $('update-btn').onclick = () => { updating = true; worker.postMessage('skipWaiting'); };
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  });
  // Reload only when the agent tapped Update, never on the very first install.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updating) { updating = false; location.reload(); }
  });
}

function wireEvents() {
  $('login-form').addEventListener('submit', doLogin);
  $('purchase-form').addEventListener('submit', submitPurchase);
  for (const id of ['f-gross', 'f-tare', 'f-price']) $(id).addEventListener('input', updateCalc);
  $('f-date').addEventListener('change', refreshLotAndReceipt);
  $('f-point').addEventListener('change', refreshLotAndReceipt);
  $('new-lot-btn').addEventListener('click', newLot);
  $('receipt-new').addEventListener('click', async () => { await renderForm(); showView('new'); });
  $('receipt-share').addEventListener('click', shareReceipt);
  $('receipt-void').addEventListener('click', voidCurrent);
  $('today-date').addEventListener('change', renderToday);
  $('sync-btn').addEventListener('click', () => syncNow('button'));
  $('sync-now-2').addEventListener('click', () => syncNow('button'));
  $('export-csv').addEventListener('click', exportCSV);
  $('export-wa').addEventListener('click', exportWhatsApp);
  $('logout-btn').addEventListener('click', logout);
  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', async () => {
      if (t.dataset.view === 'new' && state.view === 'receipt') await renderForm();
      if (t.dataset.view === 'today') $('today-date').value = localISODate();
      showView(t.dataset.view);
      refreshStatus();
    });
  }
  window.addEventListener('online', () => syncNow('online'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.session) { syncNow('opened'); refreshStatus(); }
  });
  setInterval(() => { if (state.session) syncNow('timer'); }, SYNC_EVERY_MS);
  setInterval(() => refreshStatus(), 30 * 1000);
}

async function boot() {
  wireEvents();
  registerServiceWorker();
  state.session = await db.getMeta('session');
  if (state.session) await startApp();
  else showView('login');
}

boot();
