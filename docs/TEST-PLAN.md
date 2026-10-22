# Tente Buyer – test plan

Run everything against the **copy** of the sheet first. Keep the paper receipt books going for the
first weeks whatever the results.

## Already tested automatically (by Claude, before handover)
These run with `npm test`. They drive the app in a small-screen Chrome against the real backend code on
a simulated sheet. All 26 passed on 22 Oct 2026.

| Scenario | Result |
|---|---|
| App opens and records after a reload with no network | ✅ |
| 24 purchases + 1 void in airplane mode, then back online: auto-sync, 25 rows, no duplicates, phone totals = sheet totals (incl. cash split) | ✅ |
| Signal lost after the sheet saved a batch but before the phone got the answer: re-sent, stored once | ✅ |
| Connection cut before reaching the sheet, and phone going offline half-way through a sync | ✅ |
| 500 records on one phone: saving 0.4 s, Today screen 0.1 s, sync 2–3 s (51 calls)* | ✅ |
| Two phones syncing at the same moment: 24 rows, no clashes | ✅ |
| 24 h warning, logout blocked with waiting purchases, PIN changed in the sheet | ✅ |
| Validation rules, 60 kg and price warnings, remembered tare and price | ✅ |
| Backend: never writes I or K, ignores a Record ID already in Q, refuses inactive agents, locks after 5 wrong PINs, formula-looking names stored as text, sheet grows when it runs out of rows | ✅ |

*The real Google script is slower: expect about 2–5 seconds per batch of 10 → roughly 2–4 minutes for
500 records on a good signal.

**What the simulation cannot prove:** real Google speed and limits, Android killing the app in the
background, cheap-phone performance, real weak signal, and your company account settings. That is what
the field tests below are for.

## Field tests (you, with 2 phones)
Tick each one. Write down anything odd with the time and the agent code.

### 1. Install and log in
- [ ] Open the link in Chrome, log in, Add to Home screen. Icon appears.
- [ ] Wrong PIN shows a clear message. 5 wrong PINs → "Too many wrong PINs".

### 2. Airplane mode for a day
- [ ] Turn on airplane mode. Close the app fully (swipe it away) and open it from the icon. It opens.
- [ ] Record ~20 purchases across the day: all grades, cash and mobile money, one Reject at price 0,
      one over 60 kg (warning appears), one void.
- [ ] Note the Today totals: purchases, net kg, kwacha, cash, mobile money.
- [ ] Turn airplane mode off and open the app. Within a minute: **0 waiting**.
- [ ] In the sheet: same number of rows, I and K filled by the formulas, voids negative.
- [ ] **Daily summary** for that day matches the phone's Today screen (net kg, paid, cash, mobile money).

### 3. Signal off in the middle of a sync
- [ ] Record 30 purchases offline. Turn data on, tap **Sync now**, and after 2–3 seconds turn airplane mode on.
- [ ] Some are still waiting. Turn data back on and sync. **0 waiting**.
- [ ] In the sheet, check column Q has no repeated IDs: type `=COUNTA(Q4:Q)-COUNTUNIQUE(Q4:Q)` in a
      spare cell of the **copy**. It must show 0.
- [ ] Number of new rows = 30.

### 4. 500 records on one phone
- [ ] On the copy only, with the cheapest phone: record as many purchases as you can in 30 minutes.
      The app should stay quick and Today should still open fast. (The full 500 was tested automatically above.)
- [ ] Sync on weak signal. Time it. 0 waiting at the end.

### 5. Two phones at the same time
- [ ] Two agents (different codes) each record 10 offline, turn data on together, tap Sync together.
- [ ] 20 new rows, no duplicate receipts.

### 6. Clearing app data
The app **cannot** warn when Android's *Settings → Apps → Chrome → Clear storage* is used. The app is
not running then. What it does instead:
- [ ] Sync tab shows "Storage protected: yes" after install (Chrome keeps the data even when the phone is full).
- [ ] With purchases waiting, **Log out** is refused.
- [ ] Red bar after 24 h without sync. Purchase count on every screen.
- [ ] Try it on the copy: record 3 offline, export by WhatsApp, then clear Chrome's site data.
      The 3 are gone from the phone; the WhatsApp backup and paper book are the safety net. Log in
      again: receipt numbers continue from the last *synced* number. Note: numbers of the lost unsynced
      purchases may then be reused. The sheet flags any clash.

### 7. Totals check (each evening of the trial)
- [ ] Each agent's Today screen = cash in hand = paper book = Daily summary for that day (after sync).

### 8. Daily use
- [ ] Bright sun: readable? Wet fingers: buttons big enough? Landscape works?
- [ ] Receipt screenshot readable when sent by WhatsApp.

## Known limits of phase 1
- The phone syncs while the app is **open** (on opening, every 3 minutes, on signal returning, Sync now).
  Android does not let a web app run freely in the background, so agents should open the app when
  they reach signal.
- The PIN is kept on the phone so it can sync offline-entered work. Anyone holding an unlocked phone
  could record purchases as that agent. Set the agent to Active = No if a phone is lost.
