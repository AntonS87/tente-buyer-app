// Pure rules: numbers, receipt and lot numbers, validation, totals, export.
// No browser APIs here, so the tests can run this file directly in Node.

export const APP_VERSION = '1.0.1';
export const BIG_PURCHASE_KG = 60;
export const PRICE_WARN_SHARE = 0.3; // warn when price is 30 % away from the usual one
export const REJECT_GRADE = 'Reject';

/** "12,5" and "12.5" both mean 12.5. Anything else that is not a plain number is NaN. */
export function parseNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim().replace(',', '.');
  return /^\d*\.?\d+$/.test(s) ? Number(s) : NaN;
}

export function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round((n + Math.sign(n) * Number.EPSILON) * f) / f;
}

export const netKg = (gross, tare) => round(gross - (tare || 0), 3);
export const amountK = (net, price) => round(net * price, 2);

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kilos = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 3 });

/** 1234.5 -> "K 1,234.50"; -425 -> "K -425.00" */
export function formatK(n) {
  if (!isFinite(n)) return 'K –';
  return 'K ' + (n < 0 ? '-' : '') + money.format(Math.abs(n));
}

export function formatKg(n) {
  if (!isFinite(n)) return '– kg';
  return (n < 0 ? '-' : '') + kilos.format(Math.abs(n)) + ' kg';
}

const pad = (n, w) => String(n).padStart(w, '0');

/** Phone's local date as YYYY-MM-DD. */
export function localISODate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

/** "2026-11-02" -> "02/11/2026", the way the sheet shows dates. */
export function displayDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export const receiptNo = (agentCode, seq) => `${agentCode}-${pad(seq, 4)}`;

/** Lot: buying point code + date + agent code + lot number, e.g. MW-261102-MW1-01 */
export function lotNo(pointCode, isoDate, agentCode, n) {
  return `${pointCode}-${isoDate.slice(2).replace(/-/g, '')}-${agentCode}-${pad(n, 2)}`;
}

/** Reads "MW-261102-MW1-03" back into its parts (used after a reinstall). */
export function parseLot(lot) {
  const m = /^([A-Z0-9]+)-(\d{2})(\d{2})(\d{2})-([A-Z0-9]+)-(\d+)$/.exec(String(lot || ''));
  if (!m) return null;
  return { pointCode: m[1], date: `20${m[2]}-${m[3]}-${m[4]}`, agent: m[5], n: Number(m[6]) };
}

/**
 * Checks a purchase form. Errors block saving; warnings ask "are you sure?".
 * f: { picker, point, species, grade, gross, tare, price, payment, sentTo, date }
 * ctx: { usualPrice: number|undefined, today: 'YYYY-MM-DD' }
 */
export function checkPurchase(f, ctx = {}) {
  const errors = [];
  const warnings = [];
  const isReject = f.grade === REJECT_GRADE;

  if (!String(f.picker || '').trim()) errors.push('Type the picker’s name.');
  if (!f.point) errors.push('Choose the buying point.');
  if (!f.species) errors.push('Choose the species.');
  if (!f.grade) errors.push('Choose the grade.');
  if (!f.payment) errors.push('Choose cash or mobile money.');
  if (!f.sentTo) errors.push('Choose where it is sent.');
  if (!f.date) errors.push('Choose the date.');

  if (!(f.gross > 0)) errors.push('Gross kg must be more than 0.');
  if (!(f.tare >= 0)) errors.push('Crate tare kg must be 0 or more.');
  else if (f.gross > 0 && !(f.tare < f.gross)) errors.push('Tare must be less than gross kg.');

  if (!isFinite(f.price) || f.price < 0) errors.push('Type the price per kg.');
  else if (!isReject && !(f.price > 0)) errors.push('Price must be more than 0 (only Reject can be 0).');

  if (f.gross > BIG_PURCHASE_KG) warnings.push(`Big purchase: over ${BIG_PURCHASE_KG} kg in one go.`);
  const usual = ctx.usualPrice;
  if (!isReject && usual > 0 && f.price > 0 && Math.abs(f.price - usual) / usual > PRICE_WARN_SHARE) {
    warnings.push(`Price K ${money.format(f.price)} is far from the usual K ${money.format(usual)} for grade ${f.grade}.`);
  }
  if (ctx.today && f.date && f.date !== ctx.today) warnings.push(`Date is ${displayDate(f.date)}, not today.`);

  return { errors, warnings };
}

/** Builds the void record for an earlier purchase. It cancels the original in the sheet totals. */
export function makeVoid(orig, { id, receipt, reason, createdAt, date, device }) {
  return {
    id,
    type: 'void',
    voids: orig.id,
    agent: orig.agent,
    agentName: orig.agentName,
    device,
    date,
    createdAt,
    point: orig.point,
    pointCode: orig.pointCode,
    picker: orig.picker,
    species: orig.species,
    grade: orig.grade,
    gross: -orig.gross,
    tare: -orig.tare,
    price: orig.price,
    net: -orig.net,
    amount: -orig.amount,
    payment: orig.payment,
    receipt,
    lot: orig.lot,
    sentTo: orig.sentTo,
    notes: `VOID of ${orig.receipt}: ${reason}`,
    pending: 1
  };
}

const blankBucket = () => ({ count: 0, net: 0, paid: 0 });

/** Day totals for the Today screen. Voids subtract, exactly as they do in the sheet. */
export function totals(records) {
  const t = { purchases: 0, voids: 0, net: 0, paid: 0, byGrade: {}, byPayment: {} };
  for (const r of records) {
    if (r.type === 'void') t.voids++;
    else t.purchases++;
    const sign = r.type === 'void' ? -1 : 1;
    t.net += r.net;
    t.paid += r.amount;
    for (const [key, map] of [[r.grade, t.byGrade], [r.payment, t.byPayment]]) {
      if (!map[key]) map[key] = blankBucket();
      const b = map[key];
      b.count += sign;
      b.net += r.net;
      b.paid += r.amount;
    }
  }
  t.net = round(t.net, 3);
  t.paid = round(t.paid, 2);
  for (const map of [t.byGrade, t.byPayment]) {
    for (const b of Object.values(map)) { b.net = round(b.net, 3); b.paid = round(b.paid, 2); }
  }
  return t;
}

const CSV_COLUMNS = [
  ['Date', r => displayDate(r.date)], ['Buying point', r => r.point], ['Buyer / agent', r => r.agentName],
  ['Picker name', r => r.picker], ['Species', r => r.species], ['Grade', r => r.grade],
  ['Gross kg', r => r.gross], ['Crate tare kg', r => r.tare], ['Net kg', r => r.net],
  ['Price (K/kg)', r => r.price], ['Amount paid (K)', r => r.amount], ['Payment', r => r.payment],
  ['Receipt no.', r => r.receipt], ['Lot no.', r => r.lot], ['Sent to', r => r.sentTo], ['Notes', r => r.notes],
  ['Record ID', r => r.id], ['Device / agent code', r => `${r.agent} / ${r.device}`],
  ['Recorded at (phone)', r => r.createdAt]
];

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Same column order as the Purchases tab, so it can be pasted straight in if needed. */
export function toCSV(records) {
  const lines = [CSV_COLUMNS.map(c => c[0]).join(',')];
  for (const r of records) lines.push(CSV_COLUMNS.map(c => csvCell(c[1](r))).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Short text version for WhatsApp, one line per purchase. */
export function toWhatsAppText(records, agentCode) {
  const t = totals(records);
  const lines = [`Tente backup – ${agentCode} – ${records.length} unsynced`,
    `Total ${formatKg(t.net)}, ${formatK(t.paid)}`, ''];
  for (const r of records) {
    lines.push([displayDate(r.date), r.receipt, r.point, r.picker, r.species, r.grade,
      `G${r.gross} T${r.tare}`, `@${r.price}`, formatK(r.amount), r.payment, r.lot, r.sentTo,
      r.notes, r.id.slice(0, 8)].filter(x => x !== '' && x !== undefined).join(' | '));
  }
  return lines.join('\n');
}

/** How long ago, in plain words. */
export function ago(iso, now = Date.now()) {
  if (!iso) return 'never';
  const mins = Math.round((now - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ${mins % 60} min ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? 's' : ''} ${hours % 24} h ago`;
}
