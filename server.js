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
const PORT = +env.PORT || 3000;
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DAILY_LIMIT = +env.DAILY_LIMIT || 400;
const SEND_DELAY = Math.max(5, +env.SEND_DELAY_SECONDS || 20);
const ALLOWED_EMAILS = (env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_DOMAIN = (env.ALLOWED_DOMAIN || '').toLowerCase().replace(/^@/, '').trim();
const DEFAULT_CC = (env.DEFAULT_CC || 'enquiries@wattmatch.in').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const WEBSITE = env.SIGNATURE_WEBSITE || 'https://www.wattmatch.in/';
const LEADS_SECRET = env.LEADS_WEBHOOK_SECRET || '';   // shared secret for the lead webhook and the morning digest
const LEADS_VIEW_CODE = env.LEADS_VIEW_CODE || ''; // optional: if set, people who are not signed in must type this code to view leads
const DIGEST_SENDER = (env.DIGEST_SENDER || '').toLowerCase().trim(); // a signed-in user whose Gmail sends the digest
const DIGEST_TO = (env.DIGEST_TO || '').split(',').map(x => x.trim()).filter(Boolean);

for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'TOKEN_KEY']) {
  if (!env[k]) { console.error(`Missing ${k}. Copy .env.example to .env and fill it in (see README).`); process.exit(1); }
}
const KEY = Buffer.from(env.TOKEN_KEY, 'hex');
if (KEY.length !== 32) { console.error('TOKEN_KEY must be 64 hex characters (32 bytes).'); process.exit(1); }

/* ---------- database ---------- */
/* Database: a free Turso cloud database (set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN) or, if those are
   not set, a local SQLite file at DB_PATH (fine on your own computer or a server with a disk). */
const DB_PATH = env.DB_PATH || path.join(__dirname, 'data', 'sender.db');
let client;
if (env.TURSO_DATABASE_URL) client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
else { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); client = createClient({ url: 'file:' + DB_PATH }); }
const rowsOf = r => r.rows.map(row => Object.fromEntries(r.columns.map(c => [c, row[c]])));
const db = { prepare: sql => ({
  get: async (...a) => rowsOf(await client.execute({ sql, args: a }))[0],
  all: async (...a) => rowsOf(await client.execute({ sql, args: a })),
  run: async (...a) => { await client.execute({ sql, args: a }); }
}) };
const dbReady = (async () => {
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
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT, name TEXT, email TEXT, company TEXT, title TEXT, phone TEXT,
  monthly_bill TEXT, re_share TEXT, timeline TEXT, campaign TEXT, raw TEXT,
  status TEXT DEFAULT 'new', owner TEXT DEFAULT '', notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS leads_ext ON leads(external_id);
`);
  try { await client.execute('ALTER TABLE users ADD COLUMN onboarded INTEGER DEFAULT 0'); } catch (e) { /* already exists */ }
})();

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
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieSession({ name: 'ws', secret: env.SESSION_SECRET, maxAge: 7 * 24 * 3600 * 1000, sameSite: 'lax', httpOnly: true, secure: BASE_URL.startsWith('https') }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

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


/* ---------- LinkedIn leads ---------- */
const secretOk = req => {
  const given = String(req.get('x-webhook-secret') || req.query.key || '');
  const a = Buffer.from(given), b = Buffer.from(LEADS_SECRET);
  return !!LEADS_SECRET && a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Called by Zapier / Make (or anything else) each time a LinkedIn lead-gen form is submitted
app.post('/api/webhooks/leads', async (req, res) => {
  if (!LEADS_SECRET) return res.status(503).json({ error: 'LEADS_WEBHOOK_SECRET is not set on the server' });
  if (!secretOk(req)) return res.status(401).json({ error: 'Bad secret' });
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const out = { added: 0, duplicates: 0, rejected: 0 };
  for (const item of items.slice(0, 200)) {
    const l = L.normalizeLead(item);
    if (!l.email && !l.name) { out.rejected++; continue; }
    let dup = null;
    if (l.external_id) dup = await db.prepare('SELECT id FROM leads WHERE external_id=?').get(l.external_id);
    if (!dup && l.email) dup = await db.prepare(`SELECT id FROM leads WHERE email=? AND created_at > datetime('now','-30 day')`).get(l.email);
    if (dup) { out.duplicates++; continue; }
    await db.prepare('INSERT INTO leads(external_id,name,email,company,title,phone,monthly_bill,re_share,timeline,campaign,raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(l.external_id, l.name, l.email, l.company, l.title, l.phone, l.monthly_bill, l.re_share, l.timeline, l.campaign, JSON.stringify(item).slice(0, 8000));
    out.added++;
  }
  res.json({ ok: true, ...out });
});

// Viewing leads needs no Google sign-in. If LEADS_VIEW_CODE is set, a signed-out visitor must enter it first.
const canViewLeads = req => !!(req.session && req.session.email) || !LEADS_VIEW_CODE || !!(req.session && req.session.leadsUnlocked);
const unlockTries = new Map();
app.post('/api/leads/unlock', (req, res) => {
  if (!LEADS_VIEW_CODE) return res.json({ ok: true });
  const t = unlockTries.get(req.ip) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 15 * 60 * 1000) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 10) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
  const a = Buffer.from(String((req.body || {}).code || '').trim()), b = Buffer.from(LEADS_VIEW_CODE);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { t.n++; unlockTries.set(req.ip, t); return res.status(401).json({ error: 'Wrong code' }); }
  req.session = Object.assign({}, req.session || {}, { leadsUnlocked: true });
  res.json({ ok: true });
});
app.get('/api/leads', async (req, res) => {
  if (!canViewLeads(req)) return res.status(401).json({ error: 'Enter the access code to view leads', needCode: true });
  const st = String(req.query.status || '');
  const rows = L.LEAD_STATUSES.includes(st)
    ? await db.prepare('SELECT * FROM leads WHERE status=? ORDER BY id DESC LIMIT 2000').all(st)
    : await db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 2000').all();
  const counts = await db.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status').all();
  for (const r of rows) delete r.raw;
  for (const r of rows) r.emailed = r.email ? !!(await db.prepare(`SELECT 1 x FROM sent WHERE to_email=? AND status='sent' LIMIT 1`).get(r.email)) : false;
  res.json({ rows, counts, statuses: L.LEAD_STATUSES });
});

app.put('/api/leads/:id', needUser, async (req, res) => {
  const { status, notes, owner } = req.body || {};
  const cur = await db.prepare('SELECT * FROM leads WHERE id=?').get(+req.params.id);
  if (!cur) return res.status(404).json({ error: 'Lead not found' });
  const st = status === undefined ? cur.status : status;
  if (!L.LEAD_STATUSES.includes(st)) return res.status(400).json({ error: 'Bad status' });
  const own = owner === undefined ? cur.owner : (owner ? req.user.email : '');
  const nt = notes === undefined ? cur.notes : String(notes).slice(0, 4000);
  await db.prepare('UPDATE leads SET status=?, owner=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(st, own, nt, cur.id);
  res.json({ ok: true });
});

// Turn selected leads into rows for the "Send emails" tab (same shape as an uploaded sheet)
app.post('/api/leads/to-rows', needUser, async (req, res) => {
  const ids = (req.body && Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 500);
  const rows = [];
  for (const id of ids) {
    const l = await db.prepare('SELECT * FROM leads WHERE id=?').get(id);
    if (!l) continue;
    const r = L.leadToRow(l, rows.length);
    if (r.email && rows.some(x => x.email === r.email)) r.issues.push('Duplicate in this sheet');
    r.contacted = await contactedInfo(r);
    rows.push(r);
  }
  res.json({ rows, warnings: [], sheet: 'LinkedIn leads', mapping: { Source: 'LinkedIn leads tab' } });
});

app.get('/api/leads.xlsx', async (req, res) => {
  if (!canViewLeads(req)) return res.status(401).send('Enter the access code on the leads page first.');
  const rows = await db.prepare('SELECT created_at "Received (UTC)", name Name, email Email, company Company, title Designation, phone Phone, monthly_bill "Monthly bill", re_share "Current RE share", timeline Timeline, campaign Campaign, status Status, owner Owner, notes Notes FROM leads ORDER BY id DESC').all();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'LinkedIn leads');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="linkedin-leads.xlsx"');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

// Morning digest. Point a free scheduler (cron-job.org / GitHub Actions) at this once a day; it also wakes the free Render service.
app.get('/api/cron/leads-digest', async (req, res) => {
  if (!LEADS_SECRET) return res.status(503).json({ error: 'LEADS_WEBHOOK_SECRET is not set on the server' });
  if (!secretOk(req)) return res.status(401).json({ error: 'Bad secret' });
  if (!DIGEST_SENDER || !DIGEST_TO.length) return res.json({ ok: true, sent: false, reason: 'DIGEST_SENDER / DIGEST_TO not set' });
  const leads = await db.prepare(`SELECT * FROM leads WHERE created_at > datetime('now','-1 day') ORDER BY id`).all();
  if (!leads.length) return res.json({ ok: true, sent: false, reason: 'No new leads in the last 24 hours' });
  const u = await db.prepare('SELECT * FROM users WHERE email=?').get(DIGEST_SENDER);
  if (!u) return res.status(400).json({ error: `${DIGEST_SENDER} has not signed in to the site yet` });
  const open = (await db.prepare(`SELECT COUNT(*) n FROM leads WHERE status='new'`).get()).n;
  const lines = leads.map(l => `* ${l.name || l.email} | ${l.company || '-'} | ${l.email || '-'}${l.phone ? ' | ' + l.phone : ''} | bill: ${l.monthly_bill || '-'} | RE share: ${l.re_share || '-'} | timeline: ${l.timeline || '-'}`).join('\n');
  const text = `${leads.length} new LinkedIn lead${leads.length === 1 ? '' : 's'} in the last 24 hours (${open} still marked New in total).\n\n${lines}\n\nOpen the site and use the LinkedIn leads tab: ${BASE_URL}`;
  const mail = new MailComposer({ from: `WattMatch Sender <${u.email}>`, to: DIGEST_TO.join(', '), subject: `${leads.length} new LinkedIn lead${leads.length === 1 ? '' : 's'} (${new Date().toISOString().slice(0, 10)})`, text, html: L.textToHtml(text) });
  const raw = await new Promise((ok, no) => mail.compile().build((e, b) => e ? no(e) : ok(b)));
  await (await gmailFor(u)).users.messages.send({ userId: 'me', requestBody: { raw: raw.toString('base64url') } });
  res.json({ ok: true, sent: true, leads: leads.length });
});

app.get('/healthz', (req, res) => res.send('ok'));
// Serve the page from public/index.html, or from index.html next to server.js if the public folder is missing
const PAGE = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(p => fs.existsSync(p));
if (!PAGE) console.error('WARNING: index.html not found. Upload public/index.html (or index.html) to the repository.');
app.get(['/', '/index.html'], (req, res) => PAGE ? res.sendFile(PAGE) : res.status(500).send('The page file (index.html) is missing from the repository. Upload it next to server.js.'));
app.use(express.static(path.join(__dirname, 'public')));
dbReady.then(() => app.listen(PORT, () => console.log(`WattMatch Sender running on ${BASE_URL} (port ${PORT})`))).catch(e => { console.error('Database error:', e.message); process.exit(1); });
