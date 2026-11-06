'use strict';
const XLSX = require('xlsx');

const DEFAULT_SUBJECT = "Cut {short}'s electricity bill by up to 45% – with zero upfront fee";
const DEFAULT_BODY = `Dear {name},

I'm reaching out on behalf of WattMatch – India's neutral marketplace for commercial and industrial (C&I) renewable power.

{intro}

Under the Green Energy Open Access framework, companies like {company} can switch to solar, wind and battery power and cut electricity bills by up to 40–45%. Your investment is under 10% of plant capex – the generator funds and builds the rest.

How WattMatch works:

* We study your consumption and size the right solar, wind and battery plant.
* 100s of vetted generators compete for your business, so you get the best tariff.
* We handle PPA structuring, approvals and open access filings end-to-end.

You pay nothing upfront. WattMatch is founded by a former Director of SECI, alongside entrepreneurs from IIM Bangalore, Bain & Company and Olectra Greentech.

Would you have 45 minutes over the next two weeks for a call? We'd be happy to share an indicative savings estimate for {short}.

Please refer to our [company profile](https://www.wattmatch.in/files/Wattmatch-Company-Profile.pdf) for more details.`;

const clean = v => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function deriveShort(company) {
  const s = clean(company);
  return s.replace(/\b(private|pvt\.?|limited|ltd\.?|llp|inc\.?|co\.?)(?=\s|$)/gi, '')
    .replace(/\(\s*(india|i)\s*\)/gi, '').replace(/[\s,.-]+$/, '').replace(/\s+/g, ' ').trim() || s;
}

/* ---------- sheet parsing ---------- */
function parseSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.find(n => !/hold|skip|exclude/i.test(n)) || wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', blankrows: false });
  if (!aoa.length) return { sheet: sheetName, rows: [], mapping: {}, warnings: ['The sheet is empty.'] };

  // header row = first row (within 5) that has an "email" cell
  let h = aoa.findIndex((r, i) => i < 5 && r.some(c => /e-?mail/i.test(clean(c))));
  if (h < 0) h = 0;
  const head = aoa[h].map(c => clean(c).toLowerCase());
  const map = { email: -1, name: -1, designation: -1, company: -1, short: -1, intro: -1 };
  head.forEach((c, i) => {
    if (!c) return;
    if (map.email < 0 && /e-?mail/.test(c) && !/cc/.test(c)) map.email = i;
    else if (map.short < 0 && /short/.test(c)) map.short = i;
    else if (map.intro < 0 && /(intro|opening|personali[sz]|hook|context|paragraph)/.test(c)) map.intro = i;
    else if (map.designation < 0 && /(designation|title|role|position)/.test(c)) map.designation = i;
    else if (map.company < 0 && /(company|organi[sz]ation|institute|firm)/.test(c)) map.company = i;
  });
  // name: prefer "full name", then "name"
  let fn = head.findIndex(c => /full\s*name/.test(c));
  if (fn < 0) fn = head.findIndex((c, i) => /name/.test(c) && ![map.company, map.short].includes(i) && !/company|short|org/.test(c));
  map.name = fn;

  const warnings = [];
  if (map.email < 0) warnings.push('No Email column found. Add a column headed "Email".');
  const rows = [];
  const seen = new Set();
  aoa.slice(h + 1).forEach((r, idx) => {
    const email = clean(r[map.email]).toLowerCase();
    if (!email && !clean(r.join(''))) return;
    const company = map.company >= 0 ? clean(r[map.company]) : '';
    const row = {
      row: h + idx + 2,
      email,
      name: map.name >= 0 ? clean(r[map.name]) : '',
      designation: map.designation >= 0 ? clean(r[map.designation]) : '',
      company,
      short: map.short >= 0 && clean(r[map.short]) ? clean(r[map.short]) : deriveShort(company),
      intro: map.intro >= 0 ? clean(r[map.intro]) : '',
      issues: []
    };
    if (!EMAIL_RE.test(email)) row.issues.push('Invalid email');
    else if (seen.has(email)) row.issues.push('Duplicate in this sheet');
    seen.add(email);
    if (!company) row.issues.push('No company');
    rows.push(row);
  });
  const col = i => (i >= 0 ? `"${clean(aoa[h][i])}"` : 'not found');
  return {
    sheet: sheetName, rows, warnings,
    mapping: { Email: col(map.email), Name: col(map.name), Company: col(map.company), 'Short name': map.short >= 0 ? col(map.short) : 'made from Company', Intro: col(map.intro) }
  };
}

/* ---------- template rendering ---------- */
const PH = /\{\s*(name|company|short|intro|email|designation)\s*\}/gi;
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function values(row) {
  const company = clean(row.company) || clean(row.short) || 'your company';
  return {
    name: clean(row.name) || 'Sir/Madam',
    company,
    short: clean(row.short) || deriveShort(company),
    intro: clean(row.intro),
    email: clean(row.email),
    designation: clean(row.designation)
  };
}
function fill(tpl, v) { return tpl.replace(PH, (_, k) => v[k.toLowerCase()] || ''); }

function renderText(body, row, sig) {
  const v = values(row);
  let t = body.replace(/\r\n?/g, '\n');
  if (!v.intro) t = t.replace(/^[ \t]*\{\s*intro\s*\}[ \t]*(\n|$)/gim, '').replace(/\n{3,}/g, '\n\n');
  t = fill(t, v).trim();
  return t + '\n\n' + sigText(sig);
}
function renderSubject(subject, row) { return fill(subject, values(row)).replace(/\s+/g, ' ').trim(); }

function sigText(sig) {
  const lines = ['Regards,', sig.name, sig.title, sig.phone ? 'M: ' + sig.phone : '', sig.email ? 'E: ' + sig.email : '', sig.website ? 'W: ' + sig.website : ''];
  return lines.filter(Boolean).join('\n');
}

function inline(line) {
  let s = esc(line);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
  return s;
}
function textToHtml(text) {
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push('<ul style="margin:0 0 14px 20px;padding:0">' + list.map(x => `<li style="margin:0 0 6px">${inline(x)}</li>`).join('') + '</ul>'); list = []; } };
  text.split(/\n{2,}/).forEach(block => {
    const lines = block.split('\n');
    const bullets = lines.filter(l => /^\s*[*•-]\s+/.test(l));
    if (bullets.length === lines.length) { lines.forEach(l => list.push(l.replace(/^\s*[*•-]\s+/, ''))); flush(); return; }
    flush();
    // a "lead-in" line followed by bullets
    const firstBullet = lines.findIndex(l => /^\s*[*•-]\s+/.test(l));
    if (firstBullet > 0) {
      out.push(`<p style="margin:0 0 10px">${lines.slice(0, firstBullet).map(inline).join('<br>')}</p>`);
      lines.slice(firstBullet).forEach(l => list.push(l.replace(/^\s*[*•-]\s+/, ''))); flush(); return;
    }
    out.push(`<p style="margin:0 0 14px">${lines.map(inline).join('<br>')}</p>`);
  });
  flush();
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124">${out.join('')}</div>`;
}

module.exports = { DEFAULT_SUBJECT, DEFAULT_BODY, parseSheet, renderText, renderSubject, textToHtml, clean, EMAIL_RE, deriveShort, values };
