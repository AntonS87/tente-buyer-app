// Runs the real backend/Code.gs against a fake copy of the sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadBackend, PURCHASE_COLS } from './fake-gas.mjs';

function rec(n, extra = {}) {
  return { id: randomUUID(), type: 'purchase', agent: 'MW1', agentName: 'Grace Mwansa', device: 'abc123',
    date: '2026-11-02', createdAt: new Date().toISOString(), point: 'Mwinilunga', pointCode: 'MW',
    picker: `Picker ${n}`, species: 'Chanterelle', grade: 'A', gross: 10 + n, tare: 1, price: 25,
    net: 9 + n, amount: (9 + n) * 25, payment: 'Cash', receipt: `MW1-${String(n).padStart(4, '0')}`,
    lot: 'MW-261102-MW1-01', sentTo: 'Dryer', notes: '', ...extra };
}
const auth = { agent: 'MW1', pin: '1234', device: 'abc123' };
const rows = ss => ss.getSheetByName('Purchases').rowsFrom(4, PURCHASE_COLS);

test('setup adds sync columns, buying point codes and hashed PINs', () => {
  const { ss } = loadBackend();
  const p = ss.getSheetByName('Purchases');
  assert.deepEqual(p.getRange('Q3:T3').getValues()[0], ['Record ID', 'Device / agent code', 'Synced at', 'Recorded at (phone)']);
  assert.equal(ss.getSheetByName('Lists').read(2, 8), 'MW');
  const agents = ss.getSheetByName('Agents');
  assert.equal(agents.read(2, 5), '', 'typed PIN is cleared');
  assert.match(agents.read(2, 6), /^[0-9a-f]{64}$/);
});

test('login checks PIN and active flag, and returns lists', () => {
  const { post } = loadBackend();
  assert.equal(post({ action: 'login', agent: 'MW1', pin: '0000' }).error, 'bad_login');
  assert.equal(post({ action: 'login', agent: 'NOPE', pin: '1234' }).error, 'bad_login');
  assert.equal(post({ action: 'login', agent: 'OLD1', pin: '1111' }).error, 'inactive');
  const ok = post({ action: 'login', agent: 'mw1', pin: '1234' });
  assert.equal(ok.ok, true);
  assert.equal(ok.agent.name, 'Grace Mwansa');
  assert.equal(ok.lastSeq, 0);
  assert.deepEqual(ok.lists.points[0], { name: 'Mwinilunga', code: 'MW' });
  assert.deepEqual(ok.lists.grades.map(g => g.grade), ['A', 'B', 'C', 'Reject']);
});

test('five wrong PINs lock the agent code', () => {
  const { post } = loadBackend();
  for (let i = 0; i < 5; i++) post({ action: 'login', agent: 'MW1', pin: '9999' });
  assert.equal(post({ action: 'login', agent: 'MW1', pin: '1234' }).error, 'locked');
});

test('sync writes rows below the existing ones and never touches I or K', () => {
  const { post, ss } = loadBackend();
  const r = [rec(1), rec(2)];
  const res = post({ action: 'sync', ...auth, pending: 2, records: r });
  assert.deepEqual(res.results.map(x => x.status), ['saved', 'saved']);
  const all = rows(ss);
  assert.equal(all.length, 3, 'example row + 2');
  assert.equal(all[1].picker, 'Picker 1');
  assert.equal(all[1].net, 10, 'sheet formula computes net');
  assert.equal(all[1].amount, 250);
  assert.equal(all[1].agentName, 'Grace Mwansa');
  assert.equal(all[1].id, r[0].id);
  assert.equal(all[1].device, 'MW1 / abc123');
  assert.deepEqual(ss.getSheetByName('Purchases').forbiddenWrites, []);
  assert.equal(ss.getSheetByName('Agents').read(2, 8), 0, 'waiting count reported');
});

test('a record sent twice is stored once', () => {
  const { post, ss } = loadBackend();
  const r = rec(1);
  post({ action: 'sync', ...auth, records: [r] });
  const again = post({ action: 'sync', ...auth, records: [r, r] });
  assert.deepEqual(again.results.map(x => x.status), ['duplicate', 'duplicate']);
  assert.equal(rows(ss).length, 2);
});

test('the same ID twice inside one batch is stored once', () => {
  const { post, ss } = loadBackend();
  const r = rec(1);
  const res = post({ action: 'sync', ...auth, records: [r, r] });
  assert.deepEqual(res.results.map(x => x.status), ['saved', 'duplicate']);
  assert.equal(rows(ss).length, 2);
});

test('bad records are refused, others in the batch still saved', () => {
  const { post, ss } = loadBackend();
  const res = post({ action: 'sync', ...auth, records: [
    rec(1, { agent: 'SZ1' }), rec(2, { gross: 1, tare: 2 }), rec(3, { id: 'nope' }), rec(4)] });
  assert.deepEqual(res.results.map(x => x.status), ['rejected', 'rejected', 'rejected', 'saved']);
  assert.equal(rows(ss).length, 2);
});

test('formula-looking text is stored as text', () => {
  const { post, ss } = loadBackend();
  post({ action: 'sync', ...auth, records: [rec(1, { picker: '=IMPORTXML("x")' })] });
  assert.equal(rows(ss)[1].picker, '\'=IMPORTXML("x")');
});

test('voids are written with negative weights', () => {
  const { post, ss } = loadBackend();
  const p = rec(1);
  const v = rec(2, { type: 'void', gross: -11, tare: -1, notes: 'VOID of MW1-0001: wrong grade' });
  post({ action: 'sync', ...auth, records: [p, v] });
  const all = rows(ss);
  assert.equal(all[2].net, -10);
  assert.equal(all[2].amount, -250);
  assert.equal(all[1].amount + all[2].amount, 0);
});

test('login after reinstall continues receipt numbers and lot', () => {
  const { post } = loadBackend();
  post({ action: 'sync', ...auth, records: [rec(7, { lot: 'MW-261102-MW1-02' }), rec(3)] });
  const ok = post({ action: 'login', agent: 'MW1', pin: '1234' });
  assert.equal(ok.lastSeq, 7);
  assert.equal(ok.lastLot, 'MW-261102-MW1-02');
});

test('a receipt number used twice is saved but flagged', () => {
  const { post, ss } = loadBackend();
  post({ action: 'sync', ...auth, records: [rec(1), rec(1)] });
  const all = rows(ss);
  assert.equal(all.length, 3);
  assert.match(all[2].notes, /Receipt no. used twice/);
});

test('sheet grows when it runs out of rows', () => {
  const { post, ss } = loadBackend();
  const p = ss.getSheetByName('Purchases');
  p.maxRows = 10;
  const batch = Array.from({ length: 20 }, (_, i) => rec(i + 1));
  const res = post({ action: 'sync', ...auth, records: batch });
  assert.ok(res.results.every(x => x.status === 'saved'));
  assert.equal(rows(ss).length, 21);
});

test('inactive agents cannot sync', () => {
  const { post, ss } = loadBackend();
  ss.getSheetByName('Agents').write(2, 4, 'No');
  assert.equal(post({ action: 'sync', ...auth, records: [rec(1)] }).error, 'inactive');
  assert.equal(rows(ss).length, 1);
});
