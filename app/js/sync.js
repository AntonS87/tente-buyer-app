// Sends waiting purchases to the Google Sheet in small batches.
// A purchase is only marked as synced after the sheet answers "saved" or
// "duplicate" (= already there). Anything else leaves it waiting on the phone.

import * as db from './db.js';
import { APP_VERSION } from './logic.js';

export const BATCH_SIZE = 10;
const TIMEOUT_MS = 60000;

export async function callApi(apiUrl, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // text/plain keeps this a "simple" request, which Google Apps Script accepts from any website.
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ appVersion: APP_VERSION }, body)),
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`Server answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const AUTH_ERRORS = {
  bad_login: 'Agent code or PIN not accepted. Ask Anton to check your PIN.',
  inactive: 'Your agent code is switched off. Contact Anton.',
  locked: 'Too many wrong PINs. Wait 30 minutes or ask Anton to reset your PIN.'
};

export class Syncer {
  constructor({ apiUrl, onChange }) {
    this.apiUrl = apiUrl;
    this.onChange = onChange || (() => {});
    this.running = null;
  }

  /** Safe to call any time; if a sync is already running it just waits for that one. */
  sync(reason = 'auto') {
    if (!this.running) this.running = this.run(reason).finally(() => { this.running = null; });
    return this.running;
  }

  async run(reason) {
    const session = await db.getMeta('session');
    if (!session || !this.apiUrl) return { ok: false, error: 'not_ready' };
    await db.setMeta('lastAttempt', { at: new Date().toISOString(), reason });
    this.onChange();

    const skip = new Set(); // records the sheet refused this round; retried next round
    let sent = 0;
    let firstCall = true;
    try {
      for (;;) {
        const batch = (await db.pendingRecords()).filter(r => !skip.has(r.id)).slice(0, BATCH_SIZE);
        if (!batch.length && !firstCall) break;
        const pending = await db.countPending();
        const res = await callApi(this.apiUrl, {
          action: 'sync',
          agent: session.code,
          pin: session.pin,
          device: session.device,
          pending,
          wantLists: firstCall,
          records: batch.map(stripLocal)
        });
        if (!res || !res.ok) return this.fail(res && res.error || 'server', res && res.message);

        const confirmed = [];
        for (const r of res.results || []) {
          if (r.status === 'saved' || r.status === 'duplicate') confirmed.push(r.id);
          else { skip.add(r.id); await db.markProblem(r.id, r.error || r.status); }
        }
        const now = new Date().toISOString();
        await db.markSynced(confirmed, now);
        sent += confirmed.length;
        if (res.lists) await db.setMeta('lists', res.lists);
        await db.setMeta('lastSync', now);
        await db.setMeta('syncError', null);
        firstCall = false;
        this.onChange();
        if (!batch.length) break;
      }
      await db.pruneSynced();
      return { ok: true, sent, refused: skip.size };
    } catch (err) {
      return this.fail('network', err && err.message);
    } finally {
      this.onChange();
    }
  }

  async fail(error, message) {
    await db.setMeta('syncError', { error, message: message || '', at: new Date().toISOString() });
    return { ok: false, error, message };
  }
}

/** Only what the sheet needs; local bookkeeping stays on the phone. */
function stripLocal(r) {
  const { pending, syncedAt, problem, ...rest } = r;
  return rest;
}
