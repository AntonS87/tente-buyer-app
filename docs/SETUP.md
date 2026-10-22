# Setting up Tente Buyer (one time, about 45 minutes)

You do this **twice**: first with the *copy* of the sheet, to test; then, when you are happy,
with the *live* sheet "Tente Buyers Log 2026-27". The steps are the same.

There are three parts:

1. Put the backend script in the Google Sheet (Part A).
2. Put the phone app on GitHub Pages, a free website (Part B).
3. Install the app on one phone and try it (Part C).

---

## Part A – the script in the Google Sheet

### A1. Open the script editor
1. Open the Google Sheet (start with the **copy**).
2. In the menu click **Extensions → Apps Script**. A new tab opens with a file called `Code.gs`.
3. Click the project name at the top ("Untitled project") and rename it **Tente Buyer backend**.

### A2. Paste the code
1. In `Code.gs`, select everything (Ctrl+A) and delete it.
2. Open [`backend/Code.gs`](../backend/Code.gs) from this project, copy all of it, and paste it in.
3. Click the **Save** icon (the floppy disk).

### A3. Set the time zone
1. On the left, click the **cog wheel (Project Settings)**.
2. Tick **Show "appsscript.json" manifest file in editor**.
3. Go back to the **Editor** (the `< >` icon), click `appsscript.json`, replace everything with the
   content of [`backend/appsscript.json`](../backend/appsscript.json), and save.

### A4. Run the setup once
1. Go back to the Google Sheet tab and **reload the page**. After a few seconds a new menu
   **Tente app** appears next to *Help*.
2. Click **Tente app → Set up sheet for the app (run once)**.
3. Google asks for permission the first time: click **Continue**, choose your account, and click
   **Allow**. (If you see "Google hasn't verified this app", click **Advanced → Go to Tente Buyer
   backend**. That warning appears because you wrote the script yourself; it is normal.)
4. Run the menu item again if it stopped after the permission screen. You should see "Done".

What setup changes, and nothing else:

- **Purchases** headers in Q3:T3: *Record ID*, *Device / agent code*, *Synced at*, *Recorded at (phone)*.
- **Lists** column H: *Buying point code* (MW, SZ, MK, KA, MF, LS, OT). You can change these.
- A new **Agents** tab.

It never writes to columns I or K and does not touch the Daily summary.

### A5. Add the agents
On the **Agents** tab, one row per agent:

| Agent code | Name | Home buying point | Active (Yes/No) | New PIN (type here) |
|---|---|---|---|---|
| MW1 | Grace Mwansa | Mwinilunga | Yes | 4821 |

Then click **Tente app → Secure new PINs now**. The PIN disappears and a long code appears in
"PIN hash". That is normal: nobody, including you, can read the PIN in the sheet any more.

Avoid PINs that start with 0 (Sheets may drop the zero).

### A6. Publish the script as a web app
1. In the Apps Script tab click **Deploy → New deployment**.
2. Click the cog next to "Select type" and choose **Web app**.
3. Description: `Tente Buyer v1`.
4. **Execute as: Me**.
5. **Who has access: Anyone**.
   - If **Anyone** is not in the list, your company Google account blocks it. Whoever manages your
     Google Workspace (admin.google.com) must allow Apps Script web apps to be used by people outside
     the organisation. This normally follows *Apps → Google Workspace → Drive and Docs → Sharing
     settings → Sharing outside of your organisation*. Ask Claude for a message to send them.
6. Click **Deploy**, then **Authorize access** again if asked.
7. Copy the **Web app URL** (it ends in `/exec`). Keep it for Part B.

**Check it works:** paste the URL into your browser. You should see
`{"ok":true,"app":"Tente Buyer backend","version":"1.0.0"}`.

### When the script changes later
Paste the new code, save, then **Deploy → Manage deployments → pencil icon → Version: New version →
Deploy**. This keeps the same URL, so the phones need no change. (Do not use "New deployment"
again: that makes a new URL.)

---

## Part B – the app on GitHub Pages

1. Sign in at [github.com](https://github.com) as **AntonS87**.
2. Click **+** (top right) → **New repository**.
   - Name: `tente-buyer`
   - **Public** (free Pages needs public. The code holds no passwords or data. The script URL
     is useless without an agent code and PIN.)
   - Leave "Add a README" **unticked**. Click **Create repository**.
3. Get the code in, either way:
   - **Easiest:** tell Claude "the repo is created". Claude asks you to approve access and uploads it.
   - **By hand:** on the new repo page click **uploading an existing file**, drag in *everything* from
     the project folder (including the hidden `.nojekyll` file), and click **Commit changes**.
4. Put the script URL into the app: in the repo open `app/config.js`, click the **pencil**, paste the
   URL between the quotes after `apiUrl:`, and click **Commit changes**.
   ```js
   window.TENTE_CONFIG = {
     apiUrl: 'https://script.google.com/macros/s/AKfy...../exec'
   };
   ```
5. Turn on Pages: **Settings → Pages → Build and deployment → Source: Deploy from a branch →
   Branch: main, folder: / (root) → Save**.
6. After 1–2 minutes the app is at
   **https://antons87.github.io/tente-buyer/app/**. This is the link you send to agents.

### Updating the app later
Every app update must also change the version in two places, or phones keep the old copy:
`app/sw.js` (`const VERSION = 'tente-1.0.1'`) and `app/js/logic.js` (`APP_VERSION`).
Phones then show **"New version ready – Update"** the next time they open the app with signal.

---

## Part C – install on a phone and test

1. On the Android phone, open **Chrome** and go to the app link.
2. Log in with the agent code and PIN (needs signal **this once**).
3. Chrome menu (⋮) → **Add to Home screen** (or **Install app**) → **Install**.
4. From now on, open it from the home screen icon.
5. Follow [`TEST-PLAN.md`](TEST-PLAN.md).

## Switching to the live sheet

1. Repeat Part A in the **live** sheet. Add the agents and secure the PINs there.
2. Delete the example and test rows in the live Purchases tab (rows 4–7 at the moment).
3. Put the **live** script URL in `app/config.js` and bump the version (see "Updating the app later").
4. Phones that tested against the copy: sync until **0 waiting**, then **Log out** and log in again.
