# WattMatch Sender

A small website for your team. Each person signs in with Google, uploads their Excel sheet, checks the preview and sends personalised emails **from their own Gmail**. The site cannot read anyone's inbox (it only has permission to send). A shared team log warns when someone has already emailed an address.

## What you need
- Someone to host it (about 30 minutes). The steps below use free plans on Render (hosting) and Turso (database).
- A Google Cloud project (free) for "Sign in with Google".

## Step 1: Google sign-in (OAuth)
1. Go to https://console.cloud.google.com, create a project (e.g. "WattMatch Sender").
2. **APIs & Services > Library**: enable **Gmail API**.
3. **APIs & Services > OAuth consent screen** (Google may call it "Google Auth platform"):
   - User type: **External** (needed because some people use personal Gmail). If everyone uses @wattmatch.in Workspace mail, choose **Internal** and skip the test-user step.
   - App name "WattMatch Sender", your support email.
   - Scopes: add `.../auth/gmail.send` (plus email, profile, openid).
   - **Publishing status: leave as "Testing".** Under **Test users** add the email of every person who will use it (up to 100). This avoids Google's multi-week app verification.
   - Note: in Testing mode Google expires each person's login permission after 7 days, so people click "Sign in with Google" again about once a week. Workspace-only teams on "Internal" do not have this limit.
4. **Credentials > Create credentials > OAuth client ID > Web application.**
   - Authorised redirect URI: `https://YOUR-SITE-URL/auth/callback` (for local testing also add `http://localhost:3000/auth/callback`).
   - Copy the Client ID and Client secret.

## Step 2: Run it locally (optional check)
```
cp .env.example .env     # fill in the values
npm install
npm start                # open http://localhost:3000
```
The server reads the `.env` file automatically. Open http://localhost:3000 (add `http://localhost:3000/auth/callback` as a redirect URI in Google). Google allows plain http only on localhost, so this is the quickest free test.
Generate the two secrets with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Step 3: Put it online for free (Render Free + Turso)
Render's Free plan has no permanent disk, so the data (saved templates, team sent log, sign-ins) lives in a free Turso cloud database instead.

**A. Free database (Turso)**
1. Sign up at https://turso.tech (no credit card needed on the free plan).
2. Create a database (any name, e.g. `wattmatch-sender`).
3. Copy its **URL** (starts with `libsql://`) and create an **auth token** for it. These two go into the settings below as `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.

**B. Free web hosting (Render)**
1. Put this folder in a private GitHub repo (upload all files, including `public/`; never upload `.env`).
2. On https://render.com: New > Web Service > connect the repo. Runtime Node, build command `npm install`, start command `npm start`, instance type **Free**. Do not add a disk.
3. Environment variables: everything in `.env.example` except `DB_PATH`. Set `BASE_URL` to the address Render gives you (https, no trailing slash) and fill `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`. Set `ALLOWED_EMAILS` to your team's addresses.
4. Add `<your Render address>/auth/callback` as an authorised redirect URI in Google (Step 1.4).

**What to expect on the free plan:** the site goes to sleep after about 15 minutes without visitors, so the first page load can take around a minute. Everything saved in Turso is kept. A long send keeps the site awake because the browser calls it every ~20 seconds, but keep the tab open.

Other free hosts: Fly.io, Railway and Koyeb have limited or no permanent free plans for new accounts at the time of writing. Oracle Cloud's "Always Free" virtual machine is a free alternative if someone is comfortable with a server (set `DB_PATH` there, no Turso needed).

## Using it
On first sign-in each person gets an animated 7-step guide: signature setup, exactly which sheet headers to use (with a downloadable sample sheet), how the template fills itself, the preview and test, and safe sending. A setup checklist stays at the top of the page, and the guide can be replayed from **How to use**.

Each person: Sign in with Google > set signature > check template > upload sheet > send a test to themselves > send selected.
- Sheet columns: **Email, Name** (or Full name), **Company**; optional Designation, Short name, Intro, CC. A tab named "Hold" is ignored.
- Rows already emailed by anyone on the team are unticked and flagged. Tick "also send to people already emailed" to override.
- Emails go one at a time with a ~20 second gap (set `SEND_DELAY_SECONDS`). The browser tab must stay open while sending; use Stop to pause.
- Daily cap per person defaults to 400 (Gmail allows about 500/day for normal accounts, 2000 for Workspace). Change with `DAILY_LIMIT`.

## Notes
- Data is stored in Turso (free hosting) or a local SQLite file. Refresh tokens are stored encrypted (AES-256-GCM) with `TOKEN_KEY`. Keep that key safe and never commit `.env`.
- Run `npm test` to check the sheet reader and email rendering.
- Sending bulk cold email can hurt a mailbox's reputation. Keep personalised content, small batches and the delay on.
