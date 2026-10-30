# WattMatch Sender

A small website for your team. Each person signs in with Google, uploads their Excel sheet, checks the preview and sends personalised emails **from their own Gmail**. The site cannot read anyone's inbox (it only has permission to send). A shared team log warns when someone has already emailed an address.

## What you need
- Someone to host it (about 15 minutes). Render, Railway or any VPS works; steps below use Render.
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
Load `.env` values into your shell or use `node --env-file=.env server.js` (Node 20+).
Generate the two secrets with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Step 3: Put it online (Render example)
1. Upload this folder to a private GitHub repo.
2. On https://render.com: New > Web Service > connect the repo. Build command `npm install`, start command `npm start`.
3. Add a **Disk** (1 GB) mounted at `/var/data` and set `DB_PATH=/var/data/sender.db`. Without a disk the team log and saved templates are lost on every restart.
4. Environment variables: everything in `.env.example`. Set `BASE_URL` to your Render URL (https, no trailing slash). Set `ALLOWED_EMAILS` to the 10 addresses (or `ALLOWED_DOMAIN=wattmatch.in`).
5. Add the final URL + `/auth/callback` to the redirect URIs in Google (Step 1.4).

## Using it
On first sign-in each person gets an animated 7-step guide: signature setup, exactly which sheet headers to use (with a downloadable sample sheet), how the template fills itself, the preview and test, and safe sending. A setup checklist stays at the top of the page, and the guide can be replayed from **How to use**.

Each person: Sign in with Google > set signature > check template > upload sheet > send a test to themselves > send selected.
- Sheet columns: **Email, Name** (or Full name), **Company**; optional Designation, Short name, Intro, CC. A tab named "Hold" is ignored.
- Rows already emailed by anyone on the team are unticked and flagged. Tick "also send to people already emailed" to override.
- Emails go one at a time with a ~20 second gap (set `SEND_DELAY_SECONDS`). The browser tab must stay open while sending; use Stop to pause.
- Daily cap per person defaults to 400 (Gmail allows about 500/day for normal accounts, 2000 for Workspace). Change with `DAILY_LIMIT`.

## Notes
- Refresh tokens are stored encrypted (AES-256-GCM) with `TOKEN_KEY`. Keep that key safe and never commit `.env`.
- Run `npm test` to check the sheet reader and email rendering.
- Sending bulk cold email can hurt a mailbox's reputation. Keep personalised content, small batches and the delay on.
