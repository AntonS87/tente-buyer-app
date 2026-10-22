// Phone storage (IndexedDB). Purchases stay here until the sheet confirms them,
// and are then kept for a while longer so the Today screen and voids still work.

const DB_NAME = 'tente-buyer';
const DB_VERSION = 1;
const KEEP_SYNCED_DAYS = 60;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const records = db.createObjectStore('records', { keyPath: 'id' });
      records.createIndex('pending', 'pending'); // 1 = waiting for the sheet, 0 = confirmed
      records.createIndex('date', 'date');
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Storage write cancelled'));
});

const result = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function getMeta(key, fallback = null) {
  const db = await open();
  const row = await result(db.transaction('meta').objectStore('meta').get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await open();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  return done(tx);
}

/**
 * Takes the next receipt number and saves the record in ONE storage transaction,
 * so a receipt number can never be used twice on this phone, even if the app is
 * closed half-way. build(seq) returns the record to store.
 */
export async function saveWithNextSeq(seqKey, build) {
  const db = await open();
  const tx = db.transaction(['meta', 'records'], 'readwrite');
  const meta = tx.objectStore('meta');
  let record;
  meta.get(seqKey).onsuccess = e => {
    const seq = (e.target.result ? e.target.result.value : 0) + 1;
    record = build(seq);
    meta.put({ key: seqKey, value: seq });
    tx.objectStore('records').add(record);
  };
  await done(tx);
  return record;
}

export async function getRecord(id) {
  const db = await open();
  return result(db.transaction('records').objectStore('records').get(id));
}

export async function allRecords() {
  const db = await open();
  const rows = await result(db.transaction('records').objectStore('records').getAll());
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function recordsOn(date) {
  const db = await open();
  const rows = await result(db.transaction('records').objectStore('records').index('date').getAll(date));
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function pendingRecords(limit) {
  const db = await open();
  const rows = await result(db.transaction('records').objectStore('records').index('pending').getAll(1));
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return limit ? rows.slice(0, limit) : rows;
}

export async function countPending() {
  const db = await open();
  return result(db.transaction('records').objectStore('records').index('pending').count(1));
}

/** Only called with IDs the sheet has confirmed. */
export async function markSynced(ids, syncedAt) {
  if (!ids.length) return;
  const db = await open();
  const tx = db.transaction('records', 'readwrite');
  const store = tx.objectStore('records');
  for (const id of ids) {
    store.get(id).onsuccess = e => {
      const r = e.target.result;
      if (r) store.put(Object.assign(r, { pending: 0, syncedAt, problem: '' }));
    };
  }
  return done(tx);
}

export async function markProblem(id, problem) {
  const db = await open();
  const tx = db.transaction('records', 'readwrite');
  const store = tx.objectStore('records');
  store.get(id).onsuccess = e => {
    const r = e.target.result;
    if (r) store.put(Object.assign(r, { problem }));
  };
  return done(tx);
}

/** Removes old records that the sheet already has. Never touches pending ones. */
export async function pruneSynced(now = Date.now()) {
  const cutoff = new Date(now - KEEP_SYNCED_DAYS * 86400000).toISOString();
  const db = await open();
  const tx = db.transaction('records', 'readwrite');
  const index = tx.objectStore('records').index('pending');
  index.openCursor(IDBKeyRange.only(0)).onsuccess = e => {
    const cursor = e.target.result;
    if (!cursor) return;
    if (cursor.value.syncedAt && cursor.value.syncedAt < cutoff) cursor.delete();
    cursor.continue();
  };
  return done(tx);
}
