// backend/test/reportSend.test.js
//
// Prompt 12b — sending reports by e-mail / WhatsApp:
//  - human-approved: a request is only a request; nothing is delivered
//    until another send_reports holder approves (adaptive separation of
//    duties: the requester cannot approve while another holder exists;
//    the owner may break glass with a written reason, audited);
//  - permission-gated (send_reports) with explicit recipients (1..20, each a
//    company user, a phone or an e-mail; no wildcard);
//  - payroll / cost data never goes to a recipient without that permission:
//    such a run is sent only to company users holding it — checked when
//    requested AND again when approved;
//  - every request / approval / rejection is audited with recipients and
//    per-recipient results; delivery goes through the channel transport
//    (WhatsApp: the existing session; e-mail: not configured -> failed);
//  - a double approval cannot send twice; another company touches nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-send-'));
process.env.ATLAS_DB_PATH = path.join(scratch, 'data.sqlite');
process.env.ATLAS_REPORT_RUNS_DIR = path.join(scratch, 'runs');
process.env.NODE_ENV = 'test';
process.env.ATLAS_FACT_SWEEP_MS = String(24 * 3600 * 1000);

const app = require('../server');
const db = require('../db/init');
const RB = require('../lib/reportBuilder');
const h = require('./salesHelpers');
const { createRep } = require('./helpers');
const { buildReportsScenario, Y } = require('./fixtures/reportsScenario');

let listener;
let base;
let ctx;
const ok = (r, status) => {
  if (status ? r.status !== status : r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const delivered = [];
const audits = (action, id) => db.prepare('SELECT * FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY id').all(action, id);

test.before(async () => {
  listener = app.listen(0);
  base = `http://localhost:${listener.address().port}`;
  const co = await h.createUsdCompany(base, 'شركة الإرسال');
  ctx = { co, m: co.manager, cid: co.companyId };
  ctx.s = await buildReportsScenario({ manager: co.manager, dbPath: process.env.ATLAS_DB_PATH, companyId: co.companyId, h, createRep, baseUrl: base });
  const mk = (name, contact, perms) => createRep(base, co.manager, { name, contact, permissions: ['view_app', ...perms] });
  ctx.sender = await mk('طالب الإرسال', '+963 944 000 001', ['view_financial_reports', 'send_reports', 'view_costs']);
  ctx.approver = await mk('معتمد الإرسال', '+963944000002', ['view_financial_reports', 'send_reports', 'view_costs']);
  ctx.costReader = await mk('مدير يرى التكاليف', '+963944000003', ['view_financial_reports', 'view_costs']);
  ctx.plain = await mk('موظف بلا تكاليف', '+963944000004', ['view_financial_reports']);
  ctx.mailUser = await mk('مستخدم بريد', `mail-${Date.now()}@example.com`, ['view_financial_reports', 'view_costs']);
  RB.setTransportForTests('whatsapp', async (m) => { delivered.push({ channel: 'whatsapp', ...m }); return m.address.endsWith('99') ? { ok: false, error: 'whatsapp_not_connected' } : { ok: true }; });
  const save = async (client, name, spec) => ok(await client.post('/api/report-builder/saved', { name, spec }), 201);
  ctx.salesReport = await save(ctx.sender.client, 'مبيعات', { source: 'sales', measures: ['net'], dimensions: ['item'], period: { from: `${Y}-01-01`, to: `${Y}-12-31` } });
  ctx.costReport = await save(ctx.sender.client, 'هوامش', { source: 'sales', measures: ['net', 'margin'], dimensions: ['item'], period: { from: `${Y}-01-01`, to: `${Y}-12-31` } });
  ctx.salesRun = ok(await ctx.sender.client.post(`/api/report-builder/saved/${ctx.salesReport.id}/runs`, { format: 'csv' }), 201);
  ctx.costRun = ok(await ctx.sender.client.post(`/api/report-builder/saved/${ctx.costReport.id}/runs`, { format: 'csv' }), 201);
});
test.after(() => {
  listener.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
const request = (client, runId, body) => client.post(`/api/report-builder/runs/${runId}/sends`, body);

test('a request is only a request: nothing is delivered, the approvers are notified; send_reports required', async () => {
  assert.equal((await request(ctx.plain.client, ctx.salesRun.id, { channel: 'whatsapp', recipients: [{ phone: '+963944111222' }] })).status, 403);
  const r = ok(await request(ctx.sender.client, ctx.salesRun.id, { channel: 'whatsapp', recipients: [{ phone: '+963944111222' }, { userId: ctx.plain.userId }], message: 'تقرير المبيعات' }), 201);
  assert.equal(r.status, 'pending');
  assert.deepEqual(r.recipients.map((x) => x.address), ['+963944111222', '+963944000004']);
  assert.equal(delivered.length, 0, 'nothing sent before approval');
  assert.equal(audits('report.send.request', r.id).length, 1);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE type = 'report_send_pending' AND entity_id = ?").get(r.id));
  ctx.pending = r.id;
});

test('recipient list: company users with channel and permission flags, no contact details; send_reports only', async () => {
  const list = ok(await ctx.sender.client.get('/api/report-builder/recipients'));
  const cost = list.find((u) => u.id === ctx.costReader.userId);
  assert.deepEqual([cost.phone, cost.email, cost.costs, cost.payroll], [true, false, true, false]);
  assert.equal(list.find((u) => u.id === ctx.mailUser.userId).email, true);
  assert.ok(list.every((u) => !('contact' in u)), 'no phone numbers or e-mails in the list');
  assert.equal((await ctx.plain.client.get('/api/report-builder/recipients')).status, 403);
});

test('explicit recipients only; addresses must fit the channel', async () => {
  const bad = [
    [{ channel: 'whatsapp', recipients: [] }, 'invalid_recipients'],
    [{ channel: 'whatsapp', recipients: '*' }, 'invalid_recipients'],
    [{ channel: 'whatsapp', recipients: [{ all: true }] }, 'invalid_recipients'],
    [{ channel: 'whatsapp', recipients: [{ phone: '+963944111222', email: 'a@b.co' }] }, 'invalid_recipients'],
    [{ channel: 'whatsapp', recipients: [{ email: 'a@b.co' }] }, 'invalid_recipients'],
    [{ channel: 'email', recipients: [{ phone: '+963944111222' }] }, 'invalid_recipients'],
    [{ channel: 'whatsapp', recipients: [{ phone: '12' }] }, 'invalid_recipients'],
    [{ channel: 'whatsapp', recipients: Array.from({ length: 21 }, (_, i) => ({ phone: `+9639440010${String(i).padStart(2, '0')}` })) }, 'invalid_recipients'],
    [{ channel: 'whatsapp', recipients: [{ phone: '+963944111222' }, { phone: '+963944111222' }] }, 'invalid_recipients'],
    [{ channel: 'email', recipients: [{ userId: ctx.plain.userId }] }, 'recipient_no_address'],
    [{ channel: 'fax', recipients: [{ phone: '+963944111222' }] }, 'invalid_channel'],
  ];
  for (const [body, code] of bad) {
    const r = await request(ctx.sender.client, ctx.salesRun.id, body);
    assert.ok(r.status >= 400, JSON.stringify(body));
    assert.equal(r.body.error, code, JSON.stringify(body));
  }
});

test('cost data: only company users holding view_costs — refused at request time', async () => {
  const run = ctx.costRun.id;
  assert.deepEqual(ctx.costRun.needs, ['costs']);
  assert.equal((await request(ctx.sender.client, run, { channel: 'whatsapp', recipients: [{ phone: '+963944111222' }] })).body.error, 'recipient_lacks_permission', 'no outside number');
  assert.equal((await request(ctx.sender.client, run, { channel: 'email', recipients: [{ email: 'boss@example.com' }] })).body.error, 'recipient_lacks_permission', 'no outside e-mail');
  assert.equal((await request(ctx.sender.client, run, { channel: 'whatsapp', recipients: [{ userId: ctx.plain.userId }] })).body.error, 'recipient_lacks_permission', 'a user without view_costs');
  const r = ok(await request(ctx.sender.client, run, { channel: 'whatsapp', recipients: [{ userId: ctx.costReader.userId }] }), 201);
  ctx.costPending = r.id;
  // A sender who cannot see the cost run cannot even ask to send it.
  const noCost = await createRep(base, ctx.m, { name: 'مرسل بلا تكاليف', permissions: ['view_app', 'view_financial_reports', 'send_reports'] });
  assert.equal((await request(noCost.client, run, { channel: 'whatsapp', recipients: [{ userId: ctx.costReader.userId }] })).status, 404);
});

test('separation of duties: the requester cannot approve while another holder exists; another holder can', async () => {
  const self = await ctx.sender.client.post(`/api/report-builder/sends/${ctx.pending}/approve`, {});
  assert.equal(self.status, 403);
  assert.equal(self.body.error, 'sod_report_send_requester');
  assert.equal(delivered.length, 0);
  // The approver reviews the file first (the report itself is private to the requester).
  const review = await ctx.approver.client.get(`/api/report-builder/sends/${ctx.pending}/file`);
  assert.equal(review.status, 200);
  assert.equal((await ctx.approver.client.get(`/api/report-builder/saved/${ctx.salesReport.id}`)).status, 404, 'the private report stays private');
  const done = ok(await ctx.approver.client.post(`/api/report-builder/sends/${ctx.pending}/approve`, {}));
  assert.equal(done.status, 'sent');
  assert.deepEqual(delivered.map((d) => d.address), ['+963944111222', '+963944000004']);
  assert.ok(delivered.every((d) => fs.existsSync(d.filePath) && d.caption.startsWith('مبيعات (') && d.caption.includes('تقرير المبيعات')));
  assert.deepEqual(done.results.map((x) => x.ok), [true, true]);
  const a = audits('report.send.approve', ctx.pending).at(-1);
  assert.equal(JSON.parse(a.after_json).results.length, 2);
  assert.equal(a.actor_id, ctx.approver.userId);
  const again = await ctx.approver.client.post(`/api/report-builder/sends/${ctx.pending}/approve`, {});
  assert.equal(again.status, 409, 'a second approval cannot send twice');
  assert.equal(delivered.length, 2);
});

test('an approver without the data\'s permission cannot review or approve it', async () => {
  const blind = await createRep(base, ctx.m, { name: 'معتمد بلا تكاليف', permissions: ['view_app', 'view_financial_reports', 'send_reports'] });
  assert.equal((await blind.client.get(`/api/report-builder/sends/${ctx.costPending}/file`)).status, 403);
  assert.equal((await blind.client.post(`/api/report-builder/sends/${ctx.costPending}/approve`, {})).status, 403);
  assert.equal(db.prepare('SELECT status FROM report_sends WHERE id = ?').get(ctx.costPending).status, 'pending');
});

test('recipients are re-checked at approval: a permission removed in between blocks the send', async () => {
  ok(await ctx.m.put(`/api/permissions/users/${ctx.costReader.userId}/permissions`, { permissions: ['view_app', 'view_financial_reports'] }));
  const r = await ctx.approver.client.post(`/api/report-builder/sends/${ctx.costPending}/approve`, {});
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'recipient_lacks_permission');
  assert.equal(db.prepare('SELECT status FROM report_sends WHERE id = ?').get(ctx.costPending).status, 'pending', 'still pending, nothing sent');
  assert.equal(delivered.length, 2);
  const rej = ok(await ctx.approver.client.post(`/api/report-builder/sends/${ctx.costPending}/reject`, { reason: 'المستلم لم يعد مخولًا' }));
  assert.equal(rej.status, 'rejected');
  assert.equal(audits('report.send.reject', ctx.costPending).length, 1);
});

test('delivery results: partial failure recorded per recipient; e-mail is not configured yet', async () => {
  const p = ok(await request(ctx.sender.client, ctx.salesRun.id, { channel: 'whatsapp', recipients: [{ phone: '+963944111222' }, { phone: '+963944111299' }] }), 201);
  const s = ok(await ctx.approver.client.post(`/api/report-builder/sends/${p.id}/approve`, {}));
  assert.equal(s.status, 'partially_sent');
  assert.deepEqual(s.results.map((x) => [x.address, x.ok, x.error]), [['+963944111222', true, null], ['+963944111299', false, 'whatsapp_not_connected']]);
  const e = ok(await request(ctx.sender.client, ctx.costRun.id, { channel: 'email', recipients: [{ userId: ctx.mailUser.userId }] }), 201);
  const es = ok(await ctx.approver.client.post(`/api/report-builder/sends/${e.id}/approve`, {}));
  assert.equal(es.status, 'failed');
  assert.equal(es.results[0].error, 'email_not_configured');
});

test('owner break-glass: the owner may approve their own request with a written reason (audited)', async () => {
  // A run of someone else's PRIVATE report cannot be requested, even by the owner.
  assert.equal((await request(ctx.m, ctx.salesRun.id, { channel: 'whatsapp', recipients: [{ phone: '+963944111333' }] })).status, 404);
  const own = ok(await ctx.m.post('/api/report-builder/saved', { name: 'تقرير المالك', spec: { source: 'sales', measures: ['net'], period: { preset: 'this_year' } } }), 201);
  const run = ok(await ctx.m.post(`/api/report-builder/saved/${own.id}/runs`, { format: 'csv' }), 201);
  const p = ok(await request(ctx.m, run.id, { channel: 'whatsapp', recipients: [{ phone: '+963944111333' }] }), 201);
  const noReason = await ctx.m.post(`/api/report-builder/sends/${p.id}/approve`, {});
  assert.equal(noReason.status, 403);
  assert.equal(noReason.body.error, 'sod_report_send_requester');
  assert.equal(noReason.body.break_glass_available, true, 'the owner is told break-glass is available');
  ok(await ctx.m.post(`/api/report-builder/sends/${p.id}/approve`, { breakGlassReason: 'المعتمد في إجازة والتقرير عاجل' }));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'sod.break_glass' AND entity_type = 'report_send' AND entity_id = ?").get(p.id).n, 1);
});

test('tenant isolation: another company cannot list, request, approve or reject', async () => {
  const other = await h.createUsdCompany(base, 'شركة أخرى للإرسال');
  await h.setupLedger(other.manager);
  const p = ok(await request(ctx.sender.client, ctx.salesRun.id, { channel: 'whatsapp', recipients: [{ phone: '+963944111444' }] }), 201);
  assert.equal((await request(other.manager, ctx.salesRun.id, { channel: 'whatsapp', recipients: [{ phone: '+963944111222' }] })).status, 404);
  assert.equal((await other.manager.post(`/api/report-builder/sends/${p.id}/approve`, {})).status, 404);
  assert.equal((await other.manager.post(`/api/report-builder/sends/${p.id}/reject`, { reason: 'لا' })).status, 404);
  assert.deepEqual(ok(await other.manager.get('/api/report-builder/sends')), []);
  const foreignUser = await createRep(base, other.manager, { name: 'غريب', contact: '+963944999888', permissions: ['view_app'] });
  assert.equal((await request(ctx.sender.client, ctx.salesRun.id, { channel: 'whatsapp', recipients: [{ userId: foreignUser.userId }] })).status, 400, 'a foreign user id is refused like a missing one');
});
