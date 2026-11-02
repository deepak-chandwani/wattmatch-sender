'use strict';
// Quick self-test of sheet reading and email rendering (no Google needed): npm test
const assert = require('assert');
const XLSX = require('xlsx');
const L = require('./lib');

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['Email', 'Full name', 'Designation', 'Company', 'Short name', 'Intro'],
  ['a@x.com', 'Asha Rao', 'CFO', 'Acme Cements Limited', '', 'We understand Acme runs a 3 MTPA plant.'],
  ['b@x.com', 'Bhavin Shah', '', 'Beta Steel Pvt Ltd', 'Beta', ''],
  ['bad-email', 'No One', '', 'Gamma', '', ''],
  ['a@x.com', 'Dup', '', 'Acme Cements Limited', '', '']
]), 'Send');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Email'], ['hold@x.com']]), 'Hold');
const r = L.parseSheet(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
assert.equal(r.sheet, 'Send');
assert.equal(r.rows.length, 4);
assert.equal(r.rows[0].short, 'Acme Cements');
assert.equal(r.rows[1].short, 'Beta');
assert.ok(r.rows[2].issues.includes('Invalid email'));
assert.ok(r.rows[3].issues.includes('Duplicate in this sheet'));

const sig = { name: 'Test User', title: 'Consultant', phone: '+91 99999 99999', email: 'test@wattmatch.in', website: 'https://www.wattmatch.in/' };
const t1 = L.renderText(L.DEFAULT_BODY, r.rows[0], sig);
assert.ok(t1.startsWith('Dear Asha Rao,'));
assert.ok(t1.includes('We understand Acme runs'));
assert.ok(t1.includes('companies like Acme Cements Limited'));
assert.ok(t1.trim().endsWith('W: https://www.wattmatch.in/'));
const t2 = L.renderText(L.DEFAULT_BODY, r.rows[1], sig);
assert.ok(!t2.includes('{intro}') && !/\n\n\n/.test(t2), 'intro line dropped cleanly');
assert.equal(L.renderSubject(L.DEFAULT_SUBJECT, r.rows[1]), "Cut Beta's electricity bill by up to 45% – with zero upfront fee");
const h = L.textToHtml(t1);
assert.ok(h.includes('<ul') && h.includes('<a href="https://www.wattmatch.in/files/Wattmatch-Company-Profile.pdf">company profile</a>'));
// LinkedIn lead normalisation (field names vary between Zapier / Make / LinkedIn)
const n1 = L.normalizeLead({ 'First Name': 'Asha', 'Last Name': 'Rao', 'Work Email': 'Asha@Acme.com', 'Company Name': 'Acme Cements Limited', 'Job Title': 'CFO', 'Monthly electricity bill': '₹40 lakh', lead_id: 'urn:li:123' });
assert.equal(n1.name, 'Asha Rao'); assert.equal(n1.email, 'asha@acme.com'); assert.equal(n1.company, 'Acme Cements Limited');
assert.equal(n1.title, 'CFO'); assert.equal(n1.monthly_bill, '₹40 lakh'); assert.equal(n1.external_id, 'urn:li:123');
const lr = L.leadToRow({ name: 'Asha Rao', email: 'asha@acme.com', company: 'Acme Cements Limited', title: 'CFO' }, 0);
assert.equal(lr.short, 'Acme Cements'); assert.deepEqual(lr.issues, []);
assert.ok(L.leadToRow({ email: 'bad', company: '' }, 1).issues.length === 2);
console.log('All tests passed');
