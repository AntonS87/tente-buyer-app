// A small stand-in for Google Sheets + Apps Script so the real backend/Code.gs
// can run in tests. Purchases columns I and K behave like the sheet's ARRAYFORMULAs,
// and any attempt to write to them is recorded so tests can fail on it.

import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

const colNum = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

function parseA1(a1) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
  if (!m) throw new Error(`Unsupported range ${a1}`);
  const r1 = Number(m[2]), c1 = colNum(m[1]);
  const r2 = m[4] ? Number(m[4]) : r1, c2 = m[3] ? colNum(m[3]) : c1;
  return [r1, c1, r2 - r1 + 1, c2 - c1 + 1];
}

class FakeRange {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) line.push(this.sheet.read(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    if (vals.length !== this.rows || vals.some(v => v.length !== this.cols)) throw new Error('Wrong dimensions');
    vals.forEach((line, r) => line.forEach((v, c) => this.sheet.write(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet.write(this.row, this.col, v); return this; }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setDataValidation() { return this; }
}

export class FakeSheet {
  constructor(name, { arrayFormulaCols = false } = {}) {
    this.name = name;
    this.cells = new Map(); // "r,c" -> value
    this.maxRows = 1000;
    this.arrayFormulaCols = arrayFormulaCols;
    this.forbiddenWrites = [];
  }
  read(r, c) {
    if (this.arrayFormulaCols && r >= 4 && (c === 9 || c === 11)) {
      const g = this.read(r, 7);
      if (g === '') return '';
      const h = this.read(r, 8);
      const net = g - (h === '' ? 0 : h);
      return c === 9 ? net : net * (this.read(r, 10) || 0);
    }
    const v = this.cells.get(`${r},${c}`);
    return v === undefined ? '' : v;
  }
  write(r, c, v) {
    if (this.arrayFormulaCols && r >= 3 && (c === 9 || c === 11)) this.forbiddenWrites.push(`${r},${c}`);
    if (r > this.maxRows) throw new Error(`Row ${r} beyond sheet size ${this.maxRows}`);
    if (v === '' || v === null) this.cells.delete(`${r},${c}`);
    else this.cells.set(`${r},${c}`, v);
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') return new FakeRange(this, ...parseA1(a));
    return new FakeRange(this, a, b, c || 1, d || 1);
  }
  getLastRow() {
    let last = 0;
    for (const k of this.cells.keys()) last = Math.max(last, Number(k.split(',')[0]));
    return last;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_after, n) { this.maxRows += n; }
  setFrozenRows() {}
  autoResizeColumns() {}
  /** Purchases rows from row 4 as objects, for assertions. */
  rowsFrom(first, cols) {
    const out = [];
    for (let r = first; r <= this.getLastRow(); r++) {
      out.push(Object.fromEntries(cols.map((name, i) => [name, this.read(r, i + 1)])));
    }
    return out;
  }
}

export const PURCHASE_COLS = ['date', 'point', 'agentName', 'picker', 'species', 'grade', 'gross', 'tare', 'net',
  'price', 'amount', 'payment', 'receipt', 'lot', 'sentTo', 'notes', 'id', 'device', 'syncedAt', 'recordedAt'];

/** Builds a fake spreadsheet that looks like the copy of "Tente Buyers Log 2026-27". */
export function makeSpreadsheet() {
  const purchases = new FakeSheet('Purchases', { arrayFormulaCols: true });
  const header = ['Date', 'Buying point', 'Buyer / agent', 'Picker name', 'Species', 'Grade', 'Gross kg',
    'Crate tare kg', 'Net kg', 'Price (K/kg)', 'Amount paid (K)', 'Payment', 'Receipt no.', 'Lot no.', 'Sent to', 'Notes'];
  purchases.write(1, 1, 'Tente buyers log, season 2026-27');
  header.forEach((h, i) => { if (i !== 8 && i !== 10) purchases.write(3, i + 1, h); });
  // Row 4: the example row that is already in the sheet.
  const example = [new Date(2026, 10, 2), 'Mwinilunga', 'Agent 1', 'Picker 001', 'Chanterelle', 'A', 18.6, 1.6, '', 25,
    '', 'Cash', '0001', 'MW-261102-01', 'Dryer', 'Example row'];
  example.forEach((v, i) => { if (v !== '') purchases.write(4, i + 1, v); });

  const lists = new FakeSheet('Lists');
  const listCols = [
    ['Buying point', 'Mwinilunga', 'Solwezi', 'Mkushi', 'Kaoma', 'Mufulira', 'Lusaka', 'Other'],
    ['Species', 'Chanterelle', 'Other edible'],
    ['Grade', 'A', 'B', 'C', 'Reject'],
    ['Payment', 'Cash', 'Mobile money'],
    ['Sent to', 'Dryer', 'Brine', 'Fresh', 'Rejected'],
    ['Grade', 'A', 'B', 'C', 'Reject'],
    ['What it means', 'Whole, firm, clean', 'Small blemishes', 'Pieces, soft or small', 'Slimy, maggoty or sandy']
  ];
  listCols.forEach((col, c) => col.forEach((v, r) => lists.write(r + 1, c + 1, v)));

  const sheets = { Purchases: purchases, Lists: lists };
  return {
    sheets,
    getSheetByName: name => sheets[name] || null,
    insertSheet: name => (sheets[name] = new FakeSheet(name))
  };
}

/** Loads backend/Code.gs into a sandbox wired to the fake spreadsheet. */
export function loadBackend(ss = makeSpreadsheet()) {
  const props = new Map();
  const cache = new Map();
  const toSignedBytes = buf => [...buf].map(b => (b > 127 ? b - 256 : b));
  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      flush: () => {},
      getUi: () => ({ alert: () => {}, createMenu: () => ({ addItem() { return this; }, addToUi() {} }) }),
      newDataValidation: () => ({
        requireValueInList() { return this; }, requireValueInRange() { return this; },
        setAllowInvalid() { return this; }, build() { return {}; }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, v),
        remove: k => cache.delete(k)
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: k => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => toSignedBytes(createHash(alg).update(s, 'utf8').digest()),
      getUuid: () => randomUUID()
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: s => ({ setMimeType() { return this; }, getContent: () => s })
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../backend/Code.gs', import.meta.url), 'utf8'), sandbox);
  sandbox.setupSheet();

  const agents = ss.getSheetByName('Agents');
  [['MW1', 'Grace Mwansa', 'Mwinilunga', 'Yes', '1234'],
    ['SZ1', 'Peter Banda', 'Solwezi', 'Yes', '5678'],
    ['OLD1', 'Former Agent', 'Kaoma', 'No', '1111']]
    .forEach((row, i) => row.forEach((v, c) => agents.write(i + 2, c + 1, v)));
  sandbox.secureNewPins();

  const post = body => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  return { ss, sandbox, post, cache };
}
