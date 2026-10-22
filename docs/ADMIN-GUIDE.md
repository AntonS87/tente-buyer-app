# Tente Buyer – admin guide (Anton)

Everything is managed in the Google Sheet. You never need to touch the code for day-to-day work.

## Add an agent
1. **Agents** tab, new row: Agent code (short, unique, e.g. `SZ2`), Name, Home buying point,
   Active = `Yes`, and a 4-digit PIN in **New PIN (type here)**.
2. **Tente app → Secure new PINs now**.
3. Give the agent their code and PIN by phone or in person, plus the app link.

Never reuse an agent code: receipt numbers are built from it (`SZ2-0001`, `SZ2-0002`, …).

## Stop an agent, or a lost or stolen phone
Set **Active** to `No`. The phone can still record offline, but the sheet refuses everything it
sends. If the agent should continue on a new phone, set Active back to `Yes` and give them a **new
PIN** (type it in New PIN, then Secure new PINs).

## Reset a forgotten PIN, or unlock after 5 wrong tries
Type a new PIN in **New PIN** → **Tente app → Secure new PINs now**. This also lifts the 30-minute lock.

**The phone must then use the new PIN.** Until it does, it shows a red "PIN not accepted" bar and
keeps its waiting purchases safe. The agent taps **Sync**, types the new PIN in **New PIN from Anton**,
and taps **Use new PIN and sync**. No log-out needed, nothing is lost.

An agent who simply forgot their PIN does not need a reset to keep working: the phone remembers it.
They only need it to log in on a new phone.

## Change lists
Edit the **Lists** tab: buying points (A), species (B), grades (C), payment types (D), sent to (E),
grade descriptions (F:G), and **buying point codes (H)**, used in lot numbers.
Phones pick up the changes at their next sync.

Keep the grade called exactly `Reject`: the app allows price 0 only for that grade.

## Check syncs
**Agents** tab, grey columns:
- **Last sync**: the last time this agent's phone talked to the sheet.
- **Waiting on phone**: purchases still on the phone after that sync.
- **Device / app version**: which phone and app version.

Phone an agent if Last sync is more than a day old in buying season. (Phase 2 adds an automatic
"not synced for 48 hours" list.)

## Read the Purchases tab
- Rows from the app have a **Record ID** (Q) and **Device / agent code** (R).
- **Voids** have negative kg and kwacha, and Notes like `VOID of MW1-0007: wrong weight`.
  They cancel the original in all totals.
- A note **"⚠ Receipt no. used twice – check"** means two different purchases came in with the same
  receipt number (for example the same agent code on two phones). Both are kept. Check with the agent.
- You may add or type rows by hand as before. The app's rows never overwrite them.
- **Do not edit or delete rows the app wrote.** Add a correction row or ask the agent to void.
- **Never** type in columns I and K, or in Q (Record ID).

## Emergency CSV from an agent
The CSV columns are in the same order as the Purchases tab, plus Record ID. Before pasting rows
in by hand, check each Record ID is not already in column Q, so nothing is entered twice. Better:
let the phone sync when it gets signal. Its records are still on it.
