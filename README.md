# Tente Buyer

Offline-first phone app (PWA) for Tente Mushrooms buying agents. Agents record purchases from pickers
with or without signal; the app syncs to the Google Sheet "Tente Buyers Log 2026-27" whenever it can.

| Folder | What it is |
|---|---|
| `app/` | The phone app: plain HTML, CSS and JavaScript, no build step. Published with GitHub Pages. |
| `backend/` | Google Apps Script that lives in the sheet: checks agent PINs, writes purchases, sends lists. |
| `docs/` | [Setup](docs/SETUP.md) · [Agent guide](docs/AGENT-GUIDE.md) · [Admin guide](docs/ADMIN-GUIDE.md) · [Test plan](docs/TEST-PLAN.md) |
| `test/` | Automated tests: the real backend on a simulated sheet, plus the app in a headless phone browser. |

## How it works

```
 Phone (Chrome PWA)                                    Google Sheet
 ┌──────────────────────────────┐   POST, 10 at a time  ┌──────────────────────────────┐
 │ service worker: app offline  │ ───────────────────▶ │ Apps Script web app          │
 │ IndexedDB: every purchase    │   agent code + PIN    │  · checks PIN hash, Active   │
 │  stays until sheet says      │ ◀─────────────────── │  · skips IDs already in Q    │
 │  "saved" or "duplicate"      │  per-record answer    │  · one writer at a time      │
 └──────────────────────────────┘  + Lists tab          │  · never writes I or K       │
                                                        └──────────────────────────────┘
```

- **Unique IDs:** every purchase gets a UUID when saved. The sheet stores it in column Q and ignores any
  record whose ID is already there, so re-sending after a dropped connection never duplicates.
- **Receipts** are `AGENTCODE-0001`, numbered on the phone in the same storage transaction as the
  save. At login the sheet returns the agent's highest receipt number, so a reinstalled phone continues.
- **Lots** are `MW-261102-MW1-01`: buying point code (Lists!H), date, agent code, lot number. The agent
  code keeps two phones at one buying point from clashing.
- **No edits:** a mistake is corrected with a void row: negative gross and tare, same price. The sheet's
  own formulas then cancel the original in every total. Notes say `VOID of MW1-0007: reason`.
- **Sync** runs when the app opens, when signal returns, every 3 minutes while open, after each save,
  and on "Sync now".
- **PINs** are stored in the sheet only as salted SHA-256 hashes. No secret is in the app code. 5 wrong
  PINs lock the code for 30 minutes.

## Purchases columns written by the app
A Date · B Buying point · C Buyer / agent (name) · D Picker · E Species · F Grade · G Gross kg ·
H Crate tare kg · ~~I~~ · J Price · ~~K~~ · L Payment · M Receipt no. · N Lot no. · O Sent to · P Notes ·
Q Record ID · R Device / agent code · S Synced at · T Recorded at (phone)

I and K are left to the sheet's ARRAYFORMULAs.

## Running the tests (developers)
Needs Node 20+ and Playwright with Chromium.

```bash
npm install            # installs Playwright
npm test               # 26 tests: rules, backend, and the field scenarios in a browser
npm run serve          # app + simulated sheet on http://localhost:8080  (MW1 / 1234)
```

## Releasing a change
1. Bump `VERSION` in `app/sw.js` and `APP_VERSION` in `app/js/logic.js`.
2. Commit to `main`. GitHub Pages updates in 1–2 minutes. Phones show "New version ready".
3. Backend changes: paste into Apps Script, then **Deploy → Manage deployments → Edit → New version**.

## Phase 2 (after field testing)
Admin sync overview with a 48-hour alert · price list per grade and buying point from the sheet ·
optional crate photo · optional GPS stamp · background sync where Android allows it.
