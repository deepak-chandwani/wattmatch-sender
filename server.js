'use strict';
// Load a local .env file if present (so `npm start` works on your own computer)
try {
  require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* no .env file: use real environment variables */ }
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const XLSX = require('xlsx');
const { createClient } = require('@libsql/client');
const { google } = require('googleapis');
const MailComposer = require('nodemailer/lib/mail-composer');
const L = require('./lib');

const env = process.env;
// Tidy pasted values: strip spaces, line breaks, quotes and an accidental "NAME=" prefix
for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'TOKEN_KEY', 'BASE_URL', 'ALLOWED_DOMAIN', 'ALLOWED_EMAILS', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'DEFAULT_CC']) {
  if (env[k] != null) env[k] = String(env[k]).trim().replace(new RegExp('^' + k + '\\s*=\\s*'), '').replace(/^["']+|["']+$/g, '').trim();
}
const PORT = +env.PORT || 3000;
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DAILY_LIMIT = +env.DAILY_LIMIT || 400;
const SEND_DELAY = Math.max(5, +env.SEND_DELAY_SECONDS || 20);
const ALLOWED_EMAILS = (env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_DOMAIN = (env.ALLOWED_DOMAIN || '').toLowerCase().replace(/^@/, '').trim();
const DEFAULT_CC = (env.DEFAULT_CC || 'enquiries@wattmatch.in').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const WEBSITE = env.SIGNATURE_WEBSITE || 'https://www.wattmatch.in/';

const problems = [];
for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'TOKEN_KEY']) if (!env[k]) problems.push(`Missing ${k}.`);
if (env.TOKEN_KEY && !/^[0-9a-fA-F]{64}$/.test(env.TOKEN_KEY)) problems.push(`TOKEN_KEY must be exactly 64 characters of 0-9 and a-f. The value set is ${env.TOKEN_KEY.length} characters long${/[^0-9a-fA-F]/.test(env.TOKEN_KEY) ? ' and contains other characters' : ''}.`);
if (process.env.VERCEL && !env.TURSO_DATABASE_URL) problems.push('Missing TURSO_DATABASE_URL (required on Vercel, which has no disk).');
if (process.env.VERCEL && env.TURSO_DATABASE_URL && !env.TURSO_AUTH_TOKEN) problems.push('Missing TURSO_AUTH_TOKEN.');
if (process.env.VERCEL && !/^https:\/\//.test(env.BASE_URL || '')) problems.push('BASE_URL must be set to your Vercel address, e.g. https://wattmatch-sender.vercel.app');
if (problems.length) {
  const msg = 'Setup problem - fix these Environment Variables, then redeploy:\n\n- ' + problems.join('\n- ');
  console.error(msg);
  // On Vercel, show the problem on the page instead of crashing with a bare 500 error
  if (process.env.VERCEL) { module.exports = (req, res) => { res.statusCode = 500; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(msg); }; return; }
  process.exit(1);
}
const KEY = Buffer.from(env.TOKEN_KEY, 'hex');

/* ---------- database ---------- */
/* Database: a free Turso cloud database (set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN) or, if those are
   not set, a local SQLite file at DB_PATH (fine on your own computer or a server with a disk). */
const DB_PATH = env.DB_PATH || path.join(__dirname, 'data', 'sender.db');
let client;
let clientErr = null;
if (env.TURSO_DATABASE_URL) { try { client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN }); } catch (e) { clientErr = new Error('TURSO_DATABASE_URL looks wrong (it should start with libsql://): ' + e.message); } }
else { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); client = createClient({ url: 'file:' + DB_PATH }); }
const rowsOf = r => r.rows.map(row => Object.fromEntries(r.columns.map(c => [c, row[c]])));
const db = { prepare: sql => ({
  get: async (...a) => rowsOf(await client.execute({ sql, args: a }))[0],
  all: async (...a) => rowsOf(await client.execute({ sql, args: a })),
  run: async (...a) => { await client.execute({ sql, args: a }); }
}) };
const dbReady = (async () => {
  if (clientErr) throw clientErr;
  await client.executeMultiple(`
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY, google_name TEXT, token TEXT,
  sig_name TEXT, sig_title TEXT, sig_phone TEXT,
  subject TEXT, body TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, to_email TEXT, company TEXT,
  contact TEXT, designation TEXT, subject TEXT, status TEXT, error TEXT,
  sent_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS sent_to ON sent(to_email);
CREATE INDEX IF NOT EXISTS sent_company ON sent(company);
`);
  try { await client.execute('ALTER TABLE users ADD COLUMN onboarded INTEGER DEFAULT 0'); } catch (e) { /* already exists */ }
})();
dbReady.catch(e => console.error('Database error:', e.message));

const enc = txt => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', KEY, iv); const e = Buffer.concat([c.update(txt, 'utf8'), c.final()]); return [iv, c.getAuthTag(), e].map(b => b.toString('base64')).join('.'); };
const dec = s => { const [iv, tag, e] = s.split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString('utf8'); };

/* ---------- app ---------- */
const app = express();
// Make async route handlers report errors instead of hanging
['get', 'post', 'put'].forEach(m => {
  const orig = app[m].bind(app);
  app[m] = (p, ...handlers) => orig(p, ...handlers.map(f => (typeof f === 'function' && f.length < 4)
    ? (req, res, next) => Promise.resolve(f(req, res, next)).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Server error: ' + e.message }); })
    : f));
});
app.set('trust proxy', 1);
// Wait for the database to be ready (matters on Vercel, where each cold start re-runs this file)
app.use((req, res, next) => dbReady.then(() => next(), e => res.status(500).send('Database error: ' + e.message)));
app.use(express.json({ limit: '2mb' }));
app.use(cookieSession({ name: 'ws', secret: env.SESSION_SECRET, maxAge: 7 * 24 * 3600 * 1000, sameSite: 'lax', httpOnly: true, secure: BASE_URL.startsWith('https') }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: (process.env.VERCEL ? 4 : 8) * 1024 * 1024 } });

const oauthClient = () => new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, `${BASE_URL}/auth/callback`);
const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.send'];
const allowed = email => {
  email = email.toLowerCase();
  if (!ALLOWED_EMAILS.length && !ALLOWED_DOMAIN) return true;
  return ALLOWED_EMAILS.includes(email) || (ALLOWED_DOMAIN && email.endsWith('@' + ALLOWED_DOMAIN));
};

app.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;
  res.redirect(oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state, include_granted_scopes: true }));
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (req.query.error) return res.redirect('/?msg=' + encodeURIComponent('Google sign-in was cancelled.'));
    if (!req.query.state || req.query.state !== req.session.state) return res.redirect('/?msg=' + encodeURIComponent('Sign-in expired. Please try again.'));
    const client = oauthClient();
    const { tokens } = await client.getToken(String(req.query.code));
    client.setCredentials(tokens);
    if (!(tokens.scope || '').includes('gmail.send')) return res.redirect('/?msg=' + encodeURIComponent('Please tick the box that lets this site send email for you, then try again.'));
    const info = (await google.oauth2({ version: 'v2', auth: client }).userinfo.get()).data;
    const email = String(info.email).toLowerCase();
    if (!allowed(email)) return res.redirect('/?msg=' + encodeURIComponent(`${email} is not allowed to use this site. Ask the admin to add you.`));
    const existing = await db.prepare('SELECT token FROM users WHERE email=?').get(email);
    const token = tokens.refresh_token ? enc(tokens.refresh_token) : existing && existing.token;
    if (!token) return res.redirect('/?msg=' + encodeURIComponent('Google did not return a long-lived permission. Remove this app at myaccount.google.com/permissions and sign in again.'));
    if (existing) await db.prepare('UPDATE users SET google_name=?, token=? WHERE email=?').run(info.name || '', token, email);
    else await db.prepare('INSERT INTO users(email, google_name, token, sig_name, subject, body) VALUES (?,?,?,?,?,?)').run(email, info.name || '', token, info.name || '', L.DEFAULT_SUBJECT, L.DEFAULT_BODY);
    req.session = { email };
    res.redirect('/');
  } catch (e) {
    console.error('auth error', e.message);
    res.redirect('/?msg=' + encodeURIComponent('Sign-in failed: ' + e.message));
  }
});

app.post('/auth/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

const needUser = async (req, res, next) => {
  if (!req.session || !req.session.email) return res.status(401).json({ error: 'Not signed in' });
  const u = await db.prepare('SELECT * FROM users WHERE email=?').get(req.session.email);
  if (!u || !allowed(u.email)) { req.session = null; return res.status(401).json({ error: 'Not signed in' }); }
  req.user = u; next();
};
const sigOf = u => ({ name: u.sig_name || u.google_name || '', title: u.sig_title || '', phone: u.sig_phone || '', email: u.email, website: WEBSITE });
const sentToday = async email => (await db.prepare(`SELECT COUNT(*) n FROM sent WHERE user_email=? AND status='sent' AND sent_at > datetime('now','-1 day')`).get(email)).n;

app.get('/api/me', async (req, res) => {
  if (!req.session || !req.session.email) return res.json({ signedIn: false, config: { allowedHint: ALLOWED_DOMAIN || '' } });
  const u = await db.prepare('SELECT * FROM users WHERE email=?').get(req.session.email);
  if (!u) return res.json({ signedIn: false });
  res.json({ signedIn: true, onboarded: !!u.onboarded, email: u.email, sig: sigOf(u), subject: u.subject || L.DEFAULT_SUBJECT, body: u.body || L.DEFAULT_BODY, sentToday: await sentToday(u.email), cc: DEFAULT_CC, dailyLimit: DAILY_LIMIT, delay: SEND_DELAY });
});

app.post('/api/onboarded', needUser, async (req, res) => {
  await db.prepare('UPDATE users SET onboarded=1 WHERE email=?').run(req.user.email);
  res.json({ ok: true });
});

app.get('/api/sample.xlsx', needUser, (req, res) => {
  const send = [
    ['Email', 'Name', 'Designation', 'Company', 'Short name', 'Intro'],
    ['asha.rao@acmecements.com', 'Asha Rao', 'Chief Financial Officer', 'Acme Cements Limited', 'Acme Cements', 'We understand that Acme Cements runs a 3 MTPA plant in Rajasthan, where grid power is a major cost.'],
    ['bhavin.shah@betasteel.in', 'Bhavin Shah', 'Managing Director', 'Beta Steel Private Limited', '', ''],
    ['info@gammaalloys.com', '', '', 'Gamma Alloys Limited', 'Gamma Alloys', '']
  ];
  const guide = [
    ['Column', 'Required?', 'What to put there'],
    ['Email', 'REQUIRED', 'One email address per row. This is where the email is sent.'],
    ['Name', 'Recommended', 'Full name exactly as it should appear after "Dear" (e.g. Asha Rao). Empty = "Dear Sir/Madam". A column called "Full name" also works.'],
    ['Company', 'REQUIRED', 'Company name, used in the email text (e.g. Acme Cements Limited).'],
    ['Designation', 'Optional', 'Job title. Shown in the table only.'],
    ['Short name', 'Optional', 'Short company name used in the subject (e.g. Acme Cements). Empty = made from Company by dropping Limited / Pvt Ltd.'],
    ['Intro', 'Optional', 'One personalised paragraph about this company. Empty = that paragraph is skipped for the row.'],
    ['Tabs', '', 'The first tab is read. A tab named Hold, Skip or Exclude is ignored.']
  ];
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(send); ws1['!cols'] = [30, 20, 24, 30, 18, 60].map(w => ({ wch: w }));
  const ws2 = XLSX.utils.aoa_to_sheet(guide); ws2['!cols'] = [16, 14, 100].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws1, 'Send');
  XLSX.utils.book_append_sheet(wb, ws2, 'How to fill');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="sample-outreach-sheet.xlsx"');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

app.put('/api/profile', needUser, async (req, res) => {
  const { name, title, phone } = req.body || {};
  await db.prepare('UPDATE users SET sig_name=?, sig_title=?, sig_phone=? WHERE email=?').run(L.clean(name), L.clean(title), L.clean(phone), req.user.email);
  res.json({ ok: true });
});
app.put('/api/template', needUser, async (req, res) => {
  const { subject, body } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body are required' });
  await db.prepare('UPDATE users SET subject=?, body=? WHERE email=?').run(String(subject), String(body), req.user.email);
  res.json({ ok: true });
});
app.post('/api/template/reset', needUser, async (req, res) => {
  await db.prepare('UPDATE users SET subject=?, body=? WHERE email=?').run(L.DEFAULT_SUBJECT, L.DEFAULT_BODY, req.user.email);
  res.json({ subject: L.DEFAULT_SUBJECT, body: L.DEFAULT_BODY });
});

/* contacted-before lookup across the whole team */
async function contactedInfo(row) {
  const byEmail = await db.prepare(`SELECT user_email, sent_at FROM sent WHERE to_email=? AND status='sent' ORDER BY id DESC LIMIT 1`).get(row.email);
  if (byEmail) return { level: 'email', by: byEmail.user_email, at: byEmail.sent_at };
  if (row.company) {
    const byCo = await db.prepare(`SELECT user_email, sent_at, to_email FROM sent WHERE lower(company)=lower(?) AND status='sent' ORDER BY id DESC LIMIT 1`).get(row.company);
    if (byCo) return { level: 'company', by: byCo.user_email, at: byCo.sent_at, to: byCo.to_email };
  }
  return null;
}

app.post('/api/upload', needUser, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  try {
    const out = L.parseSheet(req.file.buffer);
    for (const r of out.rows) r.contacted = await contactedInfo(r);
    res.json(out);
  } catch (e) { res.status(400).json({ error: 'Could not read that file. Please upload an .xlsx or .csv. (' + e.message + ')' }); }
});

app.post('/api/preview', needUser, (req, res) => {
  const { row, subject, body } = req.body || {};
  const sig = sigOf(req.user);
  const text = L.renderText(body, row || {}, sig);
  res.json({ subject: L.renderSubject(subject, row || {}), text, html: L.textToHtml(text) });
});

async function gmailFor(u) {
  const c = oauthClient();
  c.setCredentials({ refresh_token: dec(u.token) });
  return google.gmail({ version: 'v1', auth: c });
}

async function sendOne(u, row, subject, body, toOverride) {
  const sig = sigOf(u);
  const text = L.renderText(body, row, sig);
  const mail = new MailComposer({
    from: `${sig.name || u.email} <${u.email}>`,
    to: toOverride || row.email,
    cc: toOverride ? undefined : (DEFAULT_CC.filter(c => c !== String(row.email).toLowerCase() && c !== u.email).join(', ') || undefined),
    subject: toOverride ? '[Test] ' + L.renderSubject(subject, row) : L.renderSubject(subject, row),
    text, html: L.textToHtml(text)
  });
  const raw = await new Promise((ok, no) => mail.compile().build((e, b) => e ? no(e) : ok(b)));
  const gmail = await gmailFor(u);
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: raw.toString('base64url') } });
  return L.renderSubject(subject, row);
}

const log = async (u, row, subject, status, error) => await db.prepare('INSERT INTO sent(user_email,to_email,company,contact,designation,subject,status,error) VALUES (?,?,?,?,?,?,?,?)')
  .run(u.email, row.email, row.company || '', row.name || '', row.designation || '', subject || '', status, error || '');

app.post('/api/test-send', needUser, async (req, res) => {
  try {
    const { row, subject, body } = req.body || {};
    await sendOne(req.user, row, subject, body, req.user.email);
    res.json({ ok: true, to: req.user.email });
  } catch (e) { res.status(500).json({ error: gmailError(e) }); }
});

app.post('/api/send', needUser, async (req, res) => {
  const { row, subject, body, force } = req.body || {};
  const u = req.user;
  if (!row || !L.EMAIL_RE.test(L.clean(row.email))) return res.status(400).json({ error: 'Invalid email address' });
  row.email = L.clean(row.email).toLowerCase();
  if ((await sentToday(u.email)) >= DAILY_LIMIT) return res.status(429).json({ error: `Daily limit of ${DAILY_LIMIT} reached. Try again tomorrow.`, stop: true });
  const prev = await contactedInfo(row);
  if (prev && prev.level === 'email' && !force) return res.status(409).json({ error: `Already emailed by ${prev.by} on ${prev.at}`, skipped: true });
  try {
    const subj = await sendOne(u, row, subject, body);
    await log(u, row, subj, 'sent');
    res.json({ ok: true });
  } catch (e) {
    const msg = gmailError(e);
    await log(u, row, subject, 'failed', msg);
    res.status(500).json({ error: msg, stop: /invalid_grant|sign in again|limit/i.test(msg) });
  }
});
function gmailError(e) {
  const m = (e && (e.response && e.response.data && e.response.data.error_description || e.message)) || 'Unknown error';
  if (/invalid_grant/.test(m)) return 'Your Google permission has expired. Sign out and sign in again.';
  if (/rateLimit|quota|User-rate/i.test(m)) return 'Gmail sending limit reached. Wait and try later.';
  return m;
}

app.get('/api/log', needUser, async (req, res) => {
  const mine = req.query.mine === '1';
  const rows = mine
    ? await db.prepare('SELECT * FROM sent WHERE user_email=? ORDER BY id DESC LIMIT 2000').all(req.user.email)
    : await db.prepare('SELECT * FROM sent ORDER BY id DESC LIMIT 2000').all();
  res.json({ rows });
});
app.get('/api/log.xlsx', needUser, async (req, res) => {
  const rows = await db.prepare('SELECT sent_at "Sent at (UTC)", user_email "Sent by", company Company, contact Contact, designation Designation, to_email Email, subject Subject, status Status, error Error FROM sent ORDER BY id DESC').all();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sent log');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="team-sent-log.xlsx"');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

app.get('/healthz', (req, res) => res.send('ok'));
// Serve the page from public/index.html, or from index.html next to server.js if the public folder is missing
const PAGE = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(p => fs.existsSync(p));
if (!PAGE) console.error('WARNING: index.html not found. Upload public/index.html (or index.html) to the repository.');
app.get(['/', '/index.html'], (req, res) => PAGE ? res.sendFile(PAGE) : res.status(500).send('The page file (index.html) is missing from the repository. Upload it next to server.js.'));
app.use(express.static(path.join(__dirname, 'public')));
// On Vercel the app is exported and run as a serverless function (see api/index.js); elsewhere it listens on a port.
if (process.env.VERCEL) module.exports = app;
else dbReady.then(() => app.listen(PORT, () => console.log(`WattMatch Sender running on ${BASE_URL} (port ${PORT})`))).catch(e => { console.error('Database error:', e.message); process.exit(1); });
