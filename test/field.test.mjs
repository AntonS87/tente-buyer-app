// The test plan's hard cases, run in a phone-sized Chromium against the real backend code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

async function phone(server, code = 'MW1', pin = '1234') {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => { throw e; });
  await page.goto(server.url);
  await page.fill('#login-code', code);
  await page.fill('#login-pin', pin);
  await page.click('#login-btn');
  await page.waitForSelector('#view-new:not(.hidden)');
  await page.evaluate(() => navigator.serviceWorker.ready);
  return { ctx, page };
}

async function buy(page, { picker, grade = 'A', gross = 12.4, tare = 1.2, price = 25, payment = 'Cash' }) {
  if (await page.isVisible('#view-receipt:not(.hidden)')) await page.click('#receipt-new');
  await page.fill('#f-picker', picker);
  await page.click(`#f-grade .choice[data-value="${grade}"]`);
  await page.fill('#f-gross', String(gross));
  await page.fill('#f-tare', String(tare));
  await page.fill('#f-price', String(price));
  await page.click(`#f-payment .choice[data-value="${payment}"]`);
  await page.click('#save-btn');
  await page.click('#dialog-ok');
  await page.waitForSelector('#view-receipt:not(.hidden)');
}

const pendingCount = page => page.evaluate(async () => (await import('./js/db.js')).countPending());

async function waitSynced(page, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await pendingCount(page)) === 0) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`still ${await pendingCount(page)} waiting`);
}

async function syncNow(page) {
  await page.click('#sync-btn');
  await page.waitForFunction(() => !document.getElementById('sync-btn').disabled);
}

function assertNoDuplicates(rows) {
  const ids = rows.map(r => r.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'duplicate record IDs in sheet');
  const receipts = rows.map(r => r.receipt);
  assert.equal(new Set(receipts).size, receipts.length, 'duplicate receipt numbers in sheet');
}

test('app opens and records with no network after first login', async () => {
  const s = await startServer();
  const { ctx, page } = await phone(s);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('#view-new:not(.hidden)');
  await buy(page, { picker: 'Offline Olga' });
  assert.equal(await pendingCount(page), 1);
  assert.match(await page.textContent('#pending-badge'), /1 waiting/);
  await ctx.close(); await s.close();
});

test('a day in airplane mode, then sync: everything arrives once and totals match the sheet', async () => {
  const s = await startServer();
  const { ctx, page } = await phone(s);
  await ctx.setOffline(true);
  const grades = ['A', 'B', 'C', 'Reject'];
  for (let i = 0; i < 24; i++) {
    const grade = grades[i % 4];
    await buy(page, { picker: `Picker ${i}`, grade, gross: 5 + i, tare: 1, price: grade === 'Reject' ? 0 : 20 + (i % 4),
      payment: i % 3 ? 'Cash' : 'Mobile money' });
  }
  // Void the last purchase.
  await page.click('#receipt-void');
  await page.fill('#void-reason', 'wrong grade');
  await page.click('#dialog-ok');
  await page.waitForSelector('.void-stamp');
  assert.equal(await pendingCount(page), 25);
  assert.equal(s.purchases().length, 1, 'only the example row while offline');

  await ctx.setOffline(false); // the phone's "online" event starts the sync by itself
  await waitSynced(page);
  const rows = s.purchases().slice(1);
  assert.equal(rows.length, 25);
  assertNoDuplicates(rows);
  assert.match(rows[24].notes, /^VOID of MW1-0024: wrong grade$/);

  // Phone's Today screen vs what the sheet's formulas compute.
  await page.click('.tab[data-view=today]');
  await page.waitForSelector('#today-list li:nth-child(25)');
  const phoneTotals = await page.$$eval('.stat strong', els => els.map(e => e.textContent));
  const sheetNet = rows.reduce((a, r) => a + r.net, 0);
  const sheetPaid = rows.reduce((a, r) => a + r.amount, 0);
  const fmt = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.equal(phoneTotals[0], '24');
  assert.equal(phoneTotals[1], `${sheetNet.toLocaleString('en-US', { minimumFractionDigits: 1 })} kg`);
  assert.equal(phoneTotals[2], `K ${fmt(sheetPaid)}`);
  const cashSheet = rows.filter(r => r.payment === 'Cash').reduce((a, r) => a + r.amount, 0);
  const cashPhone = await page.textContent('#today-totals table tbody tr:first-child td:last-child');
  assert.equal(cashPhone, `K ${fmt(cashSheet)}`);
  await ctx.close(); await s.close();
});

test('signal lost after the sheet saved but before the phone heard back: no duplicates, nothing lost', async () => {
  const s = await startServer();
  const { ctx, page } = await phone(s);
  await ctx.setOffline(true);
  for (let i = 0; i < 15; i++) await buy(page, { picker: `P${i}` });
  s.faults.dropAfterSave = 1; // first batch of 10 is written, then the line "drops"
  s.faults.failNext = 0;
  await ctx.setOffline(false); // auto sync starts; its first batch is saved but the answer is lost
  while (s.faults.dropAfterSave > 0) await page.waitForTimeout(100);
  await syncNow(page);
  await waitSynced(page);
  const rows = s.purchases().slice(1);
  assert.equal(rows.length, 15);
  assertNoDuplicates(rows);
  assert.ok(s.stats.recordsReceived >= 25, 'the 10 unconfirmed records really were sent again');
  await ctx.close(); await s.close();
});

test('connection cut before reaching the sheet, and phone going offline mid-sync', async () => {
  const s = await startServer();
  const { ctx, page } = await phone(s);
  await ctx.setOffline(true);
  for (let i = 0; i < 25; i++) await buy(page, { picker: `Q${i}` });
  s.faults.failNext = 1;
  await ctx.setOffline(false);
  await page.waitForTimeout(1500);
  s.faults.delayMs = 800; // slow line
  const run = syncNow(page);
  await page.waitForTimeout(1200);
  await ctx.setOffline(true); // signal gone half-way through the batches
  await run;
  const left = await pendingCount(page);
  assert.ok(left > 0 && left < 25, `some got through, some waiting (${left} waiting)`);
  s.faults.delayMs = 0;
  await ctx.setOffline(false);
  await syncNow(page);
  await waitSynced(page);
  const rows = s.purchases().slice(1);
  assert.equal(rows.length, 25);
  assertNoDuplicates(rows);
  await ctx.close(); await s.close();
});

test('500 records on one phone', async () => {
  const s = await startServer();
  const { ctx, page } = await phone(s);
  await ctx.setOffline(true);
  const t0 = Date.now();
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    for (let i = 0; i < 500; i++) {
      await db.saveWithNextSeq('seq:MW1', seq => ({
        id: crypto.randomUUID(), type: 'purchase', agent: 'MW1', agentName: 'Grace Mwansa', device: 'test',
        date: new Date().toISOString().slice(0, 10), createdAt: new Date(Date.now() + i).toISOString(),
        point: 'Mwinilunga', pointCode: 'MW', picker: `Bulk ${i}`, species: 'Chanterelle', grade: 'A',
        gross: 10, tare: 1, price: 25, net: 9, amount: 225, payment: 'Cash',
        receipt: `MW1-${String(seq).padStart(4, '0')}`, lot: 'MW-261102-MW1-01', sentTo: 'Dryer', notes: '', pending: 1
      }));
    }
  });
  const tSave = Date.now() - t0;
  await page.click('.tab[data-view=today]');
  await page.waitForSelector('#today-list li:nth-child(500)');
  const tToday = Date.now() - t0 - tSave;
  await ctx.setOffline(false);
  const t1 = Date.now();
  await syncNow(page);
  await waitSynced(page, 120000);
  const rows = s.purchases().slice(1);
  assert.equal(rows.length, 500);
  assertNoDuplicates(rows);
  console.log(`500 records: saved in ${tSave} ms, Today screen ${tToday} ms, synced in ${Date.now() - t1} ms (${s.stats.syncCalls} calls)`);
  await ctx.close(); await s.close();
});

test('two phones syncing at the same time', async () => {
  const s = await startServer();
  const a = await phone(s, 'MW1', '1234');
  const b = await phone(s, 'SZ1', '5678');
  await a.ctx.setOffline(true);
  await b.ctx.setOffline(true);
  for (let i = 0; i < 12; i++) {
    await buy(a.page, { picker: `A${i}` });
    await buy(b.page, { picker: `B${i}` });
  }
  s.faults.delayMs = 200;
  await Promise.all([a.ctx.setOffline(false), b.ctx.setOffline(false)]);
  await Promise.all([syncNow(a.page), syncNow(b.page)]);
  await Promise.all([waitSynced(a.page), waitSynced(b.page)]);
  const rows = s.purchases().slice(1);
  assert.equal(rows.length, 24);
  assertNoDuplicates(rows);
  assert.equal(rows.filter(r => r.receipt.startsWith('SZ1-')).length, 12);
  await a.ctx.close(); await b.ctx.close(); await s.close();
});

test('warnings: 24 h without sync, logout blocked, wrong PIN after a change', async () => {
  const s = await startServer();
  const { ctx, page } = await phone(s);
  await ctx.setOffline(true);
  await buy(page, { picker: 'Late Larry' });
  await page.evaluate(async () => {
    const db = await import('./js/db.js');
    await db.setMeta('lastSync', new Date(Date.now() - 25 * 3600 * 1000).toISOString());
  });
  await page.click('.tab[data-view=sync]');
  await page.waitForSelector('#stale-warning:not(.hidden)');
  assert.match(await page.textContent('#stale-warning'), /over 24 hours.*1 purchases are only on this phone/);

  await page.click('#logout-btn');
  await page.waitForFunction(() => /cannot log out/.test(document.getElementById('dialog-body').textContent));
  await page.click('#dialog-ok');

  // Anton changes the PIN in the sheet: the phone keeps the record and says why.
  s.backend.ss.getSheetByName('Agents').write(2, 5, '9999');
  await ctx.setOffline(false);
  await syncNow(page);
  assert.match(await page.textContent('#stale-warning'), /PIN not accepted/);
  assert.equal(await pendingCount(page), 1);
  await page.click('.tab[data-view=sync]');
  await page.fill('#repin', '9999');
  await page.click('#repin-btn');
  await waitSynced(page);
  assert.equal(s.purchases().length, 2, 'synced with the new PIN, no log-out needed');
  await ctx.close(); await s.close();
});

test('price warning and validation messages', async () => {
  const s = await startServer();
  const { ctx, page } = await phone(s);
  await buy(page, { picker: 'Usual', price: 25 });
  await page.click('#receipt-new');
  await page.click('#save-btn');
  assert.match(await page.textContent('#form-errors'), /picker’s name/);
  await page.fill('#f-picker', 'Odd');
  await page.click('#f-grade .choice[data-value="A"]');
  assert.equal(await page.inputValue('#f-price'), '25', 'remembers price per grade');
  assert.equal(await page.inputValue('#f-tare'), '1.2', 'remembers tare');
  await page.fill('#f-gross', '70');
  await page.fill('#f-price', '60');
  assert.equal(await page.textContent('#calc-amount'), 'K 4,128.00');
  await page.click('#save-btn');
  const body = await page.textContent('#dialog-body');
  assert.match(body, /over 60 kg/);
  assert.match(body, /far from the usual/);
  assert.equal(await page.textContent('#dialog-ok'), 'Save anyway');
  await ctx.close(); await s.close();
});
