import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNum, netKg, amountK, formatK, formatKg, receiptNo, lotNo, parseLot, checkPurchase, makeVoid, totals, toCSV
} from '../app/js/logic.js';

const good = { picker: 'Grace', point: 'Mwinilunga', species: 'Chanterelle', grade: 'A', gross: 18.6, tare: 1.6,
  price: 25, payment: 'Cash', sentTo: 'Dryer', date: '2026-11-02' };

test('numbers and money format', () => {
  assert.equal(parseNum('12,5'), 12.5);
  assert.ok(Number.isNaN(parseNum('12kg')));
  assert.equal(netKg(18.6, 1.6), 17);
  assert.equal(amountK(17, 25), 425);
  assert.equal(amountK(0.1 + 0.2, 10), 3);
  assert.equal(formatK(1234.5), 'K 1,234.50');
  assert.equal(formatK(-425), 'K -425.00');
  assert.equal(formatKg(17), '17.0 kg');
});

test('receipt and lot numbers', () => {
  assert.equal(receiptNo('MW1', 1), 'MW1-0001');
  assert.equal(receiptNo('MW1', 12345), 'MW1-12345');
  const lot = lotNo('MW', '2026-11-02', 'MW1', 1);
  assert.equal(lot, 'MW-261102-MW1-01');
  assert.deepEqual(parseLot(lot), { pointCode: 'MW', date: '2026-11-02', agent: 'MW1', n: 1 });
  assert.equal(parseLot('MW-261102-01'), null);
});

test('validation rules from the brief', () => {
  assert.deepEqual(checkPurchase(good, { today: '2026-11-02' }), { errors: [], warnings: [] });
  assert.equal(checkPurchase({ ...good, picker: ' ' }).errors.length, 1);
  assert.equal(checkPurchase({ ...good, gross: 0 }).errors.length, 1);
  assert.equal(checkPurchase({ ...good, tare: 20 }).errors.length, 1);
  assert.equal(checkPurchase({ ...good, price: 0 }).errors.length, 1);
  assert.equal(checkPurchase({ ...good, grade: 'Reject', price: 0 }).errors.length, 0);
  assert.match(checkPurchase({ ...good, gross: 61, tare: 1 }).warnings[0], /over 60 kg/);
  assert.match(checkPurchase(good, { usualPrice: 40 }).warnings[0], /far from the usual/);
  assert.equal(checkPurchase({ ...good, price: 27 }, { usualPrice: 25 }).warnings.length, 0);
  assert.match(checkPurchase(good, { today: '2026-11-03' }).warnings[0], /not today/);
});

test('a void cancels the original in the day totals', () => {
  const p = { ...good, id: 'a', type: 'purchase', agent: 'MW1', receipt: 'MW1-0001', lot: 'L', net: 17, amount: 425 };
  const m = { ...good, id: 'b', type: 'purchase', agent: 'MW1', receipt: 'MW1-0002', lot: 'L', net: 10, amount: 300,
    grade: 'B', price: 30, gross: 10, tare: 0, payment: 'Mobile money' };
  const v = makeVoid(p, { id: 'c', receipt: 'MW1-0003', reason: 'wrong scale', createdAt: 'x', date: '2026-11-02', device: 'd' });
  assert.equal(v.gross, -18.6);
  assert.equal(v.notes, 'VOID of MW1-0001: wrong scale');
  const t = totals([p, m, v]);
  assert.equal(t.purchases, 2);
  assert.equal(t.voids, 1);
  assert.equal(t.net, 10);
  assert.equal(t.paid, 300);
  assert.equal(t.byPayment.Cash.paid, 0);
  assert.equal(t.byPayment.Cash.count, 0);
  assert.equal(t.byPayment['Mobile money'].paid, 300);
});

test('CSV quotes awkward text', () => {
  const csv = toCSV([{ ...good, id: 'x', agent: 'MW1', agentName: 'Grace', device: 'd', receipt: 'MW1-0001',
    lot: 'L', net: 17, amount: 425, notes: 'said "ok", paid', createdAt: 't' }]);
  assert.match(csv, /"said ""ok"", paid"/);
  assert.equal(csv.split('\r\n')[0].split(',')[0], 'Date');
});
