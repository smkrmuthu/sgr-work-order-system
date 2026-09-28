// Runs every migration against a REAL embedded Postgres (not a mock) and asserts RLS/RBAC/business-rule
// behaviour end to end. Run with `npm run db:test` from the repo root, or `node run.mjs` from here.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const db = new PGlite();
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const fail = (m) => ok(false, m);

// --- Supabase stand-ins: auth schema, roles, auth.uid()/auth.jwt()
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated, public;
`);

// The API roles get their privileges from 005_grants.sql itself — no hand-written grants here, so a
// missing grant in the migrations fails these tests the way it would fail the real app.
const MIGRATIONS = ['001_schema.sql', '002_rls.sql', '003_functions.sql', '004_seed.sql', '005_grants.sql'];
for (const f of MIGRATIONS) {
  const sql = fs.readFileSync(`${ROOT}/${f}`, 'utf8');
  try { await db.exec(sql); ok(true, `${f} applies cleanly`); }
  catch (e) { fail(`${f} FAILED: ${e.message}`); throw e; }
}

// re-run all to prove idempotency
for (const f of MIGRATIONS) {
  await db.exec(fs.readFileSync(`${ROOT}/${f}`, 'utf8'));
}
ok(true, 'all migrations re-run cleanly (idempotent)');

// ---------------------------------------------------------------- test users
const CREATOR = '11111111-1111-4111-8111-111111111111';
const MD = '22222222-2222-4222-8222-222222222222';
const PLANNER = '33333333-3333-4333-8333-333333333333';
const QC = '44444444-4444-4444-8444-444444444444';
const OTHER_CREATOR = '55555555-5555-4555-8555-555555555555';
const FINANCE = '66666666-6666-4666-8666-666666666666';
const ADMIN = '77777777-7777-4777-8777-777777777777';

await db.query(`insert into auth.users (id, email) values ($1,'creator@sgr.test'),($2,'md@sgr.test'),($3,'planner@sgr.test'),($4,'qc@sgr.test'),($5,'other@sgr.test'),($6,'finance@sgr.test'),($7,'admin@sgr.test')`,
  [CREATOR, MD, PLANNER, QC, OTHER_CREATOR, FINANCE, ADMIN]);
await db.query(`update app.users set role='md' where id=$1`, [MD]);
await db.query(`update app.users set role='planner' where id=$1`, [PLANNER]);
await db.query(`update app.users set role='qc' where id=$1`, [QC]);
await db.query(`update app.users set role='finance' where id=$1`, [FINANCE]);
await db.query(`update app.users set role='admin' where id=$1`, [ADMIN]);
ok((await db.query(`select role from app.users where id=$1`, [CREATOR])).rows[0].role === 'creator', 'new login defaults to role=creator');

const as = async (userId, fn) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${userId}',false)`);
  try { return await fn(); } finally { await db.exec('reset role'); }
};
const asAnon = async (fn) => { await db.exec('set role anon'); try { return await fn(); } finally { await db.exec('reset role'); } };

// ---------------------------------------------------------------- master data + RLS on it
// A signed-out visitor is refused outright (no schema/table privileges at all), and even with the
// privileges RLS would return zero rows — either way they read nothing.
let anonRead = null, anonRows = 0;
try { anonRows = (await asAnon(() => db.query(`select * from app.categories`))).rows.length; }
catch (e) { anonRead = e.message; }
ok(anonRows === 0 && /permission denied/.test(anonRead || ''), 'anon reads nothing in app (' + anonRead + ')');

// Internal functions must not be callable by a signed-in user directly (would let anyone burn WO numbers).
let burnNumber = null;
try { await as(CREATOR, () => db.query(`select app.next_wo_number()`)); } catch (e) { burnNumber = e.message; }
ok(/permission denied/.test(burnNumber || ''), 'next_wo_number is not callable by a signed-in user: ' + burnNumber);
let directCounter = null;
try { await as(CREATOR, () => db.query(`update app.wo_number_counters set next_number = 999`)); } catch (e) { directCounter = e.message; }
const counterUntouched = (await db.query(`select count(*) c from app.wo_number_counters where next_number = 999`)).rows[0].c;
ok(Number(counterUntouched) === 0, 'a signed-in user cannot move the WO number counter directly' + (directCounter ? ' (' + directCounter + ')' : ' (0 rows via RLS)'));
const creatorCategories = await as(CREATOR, () => db.query(`select code from app.categories order by code`));
ok(creatorCategories.rows.length === 4 && creatorCategories.rows[0].code === 'CAT-001', 'signed-in user reads seeded categories (4)');
const parts = await as(CREATOR, () => db.query(`select part_no from app.parts order by part_no`));
ok(parts.rows.length === 7, 'seeded parts: 7 (5 screenshot + 2 from SGR Master.xlsx)');
const shifts = await as(CREATOR, () => db.query(`select name from app.shifts order by code`));
ok(JSON.stringify(shifts.rows.map(r=>r.name)) === JSON.stringify(['Morning','Evening','Night','General']), 'seeded shifts in order: ' + JSON.stringify(shifts.rows.map(r=>r.name)));

let plannerMasterWrite = null;
try { await as(PLANNER, () => db.query(`insert into app.categories (code, name) values ('CAT-999','x')`)); }
catch (e) { plannerMasterWrite = e.message; }
ok(!!plannerMasterWrite, 'Planner cannot write master data (' + plannerMasterWrite + ')');
await as(CREATOR, () => db.query(`insert into app.categories (code, name) values ('CAT-999','Test')`));
ok((await as(MD, () => db.query(`select 1 from app.categories where code='CAT-999'`))).rows.length === 1, 'Creator CAN write master data, MD can read it back');
await as(CREATOR, () => db.query(`delete from app.categories where code='CAT-999'`));

// ---------------------------------------------------------------- draft -> create (§3.4)
const partnerRow = (await as(CREATOR, () => db.query(`select id from app.business_partners where code='ABC01'`))).rows[0];
const locRow = (await as(CREATOR, () => db.query(`select id from app.delivery_locations where partner_id=$1 limit 1`, [partnerRow.id]))).rows[0];
const p1 = (await as(CREATOR, () => db.query(`select id from app.parts where part_no='EB080600002'`))).rows[0];
const p2 = (await as(CREATOR, () => db.query(`select id from app.parts where part_no='CB1200450'`))).rows[0];

const draftId = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2026-10-10',
  doc_ref: 'TEST-001', test_cert_required: true,
  lines: [{ part_id: p1.id, qty: 1000 }, { part_id: p2.id, qty: 200 }]
})]))).rows[0].id;
ok(!!draftId, 'save_draft returns an id');
const draftRow = (await as(CREATOR, () => db.query(`select status, wo_number from app.work_orders where id=$1`, [draftId]))).rows[0];
ok(draftRow.status === 'draft' && draftRow.wo_number === null, 'draft has no wo_number yet');

let missingPartnerErr = null;
const bareDraft = (await as(CREATOR, () => db.query(`select app.save_draft(null, '{}'::jsonb) as id`))).rows[0].id;
try { await as(CREATOR, () => db.query(`select app.create_work_order($1)`, [bareDraft])); } catch (e) { missingPartnerErr = e.message; }
ok(/Business Partner/.test(missingPartnerErr || ''), 'create_work_order blocks a draft missing required fields: ' + missingPartnerErr);

let otherCreatorCannotCreate = null;
try { await as(OTHER_CREATOR, () => db.query(`select * from app.create_work_order($1)`, [draftId])); } catch (e) { otherCreatorCannotCreate = e.message; }
ok(!!otherCreatorCannotCreate, 'a different Creator cannot promote someone else\'s draft (' + otherCreatorCannotCreate + ')');

// NOTE: `select * from fn(...)` (table-function call), not `select fn(...) as x` — the latter hands
// back an opaque composite-row STRING over the raw pg wire protocol used here, not named fields.
// supabase-js's .rpc() does not have this quirk (PostgREST returns real JSON) — this is a test-harness
// detail, not something the real app needs to work around.
const created = (await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [draftId]))).rows[0];
ok(/^\d+\/2026-27$/.test(created.wo_number), 'wo_number assigned, format NNN/2026-27: ' + created.wo_number);
ok(created.status === 'pending_finance_approval', 'status is pending_finance_approval, not straight to the floor: ' + created.status);

const created2Id = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2026-10-11', lines: [{ part_id: p1.id, qty: 500 }]
})]))).rows[0].id;
const created2 = (await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [created2Id]))).rows[0];
ok(parseInt(created2.wo_number) === parseInt(created.wo_number) + 1, 'sequential numbering under the same fiscal year: ' + created.wo_number + ' -> ' + created2.wo_number);

const history1 = await as(CREATOR, () => db.query(`select from_status, to_status from app.status_history where work_order_id=$1`, [draftId]));
ok(history1.rows.length === 1 && history1.rows[0].from_status === 'draft' && history1.rows[0].to_status === 'pending_finance_approval', 'status_history logged draft -> pending_finance_approval');
const bcast = await as(CREATOR, () => db.query(`select 1 from app.notifications where work_order_id=$1 and user_id is null`, [draftId]));
ok(bcast.rows.length >= 1, 'a broadcast notification was created');

// ---------------------------------------------------------------- Finance approval gate (added 28 Sep 2026)
const shiftMorningIdEarly = (await db.query(`select id from app.shifts where code='1'`)).rows[0].id;
const preApprovalLine = (await as(CREATOR, () => db.query(`select id from app.work_order_lines where work_order_id=$1 order by line_no limit 1`, [draftId]))).rows[0];
let blockedBeforeApproval = null;
try {
  await as(PLANNER, () => db.query(`select app.record_production($1)`, [JSON.stringify({
    work_order_id: draftId, shift_id: shiftMorningIdEarly, labour_count: 5,
    lines: [{ work_order_line_id: preApprovalLine.id, qty: 10 }]
  })]));
} catch (e) { blockedBeforeApproval = e.message; }
ok(/awaiting Finance approval/.test(blockedBeforeApproval || ''), 'production is blocked until Finance approves: ' + blockedBeforeApproval);

let nonFinanceApprove = null;
try { await as(CREATOR, () => db.query(`select app.approve_work_order($1)`, [draftId])); } catch (e) { nonFinanceApprove = e.message; }
ok(/Only Finance/.test(nonFinanceApprove || ''), 'only Finance (or MD/admin) may approve: ' + nonFinanceApprove);

let rejectNoReason = null;
try { await as(FINANCE, () => db.query(`select app.reject_work_order($1, '')`, [draftId])); } catch (e) { rejectNoReason = e.message; }
ok(/reason is required/.test(rejectNoReason || ''), 'rejecting without a reason is refused: ' + rejectNoReason);

const approved = (await as(FINANCE, () => db.query(`select * from app.approve_work_order($1)`, [draftId]))).rows[0];
ok(approved.status === 'created', 'Finance approval releases the Work Order to the floor: ' + approved.status);
const faLog = await as(CREATOR, () => db.query(`select action, comments, actor from app.finance_approvals where work_order_id=$1`, [draftId]));
ok(faLog.rows.length === 1 && faLog.rows[0].action === 'approved' && faLog.rows[0].actor === FINANCE, 'finance_approvals logged the approval: ' + JSON.stringify(faLog.rows));

const history1b = await as(CREATOR, () => db.query(`select from_status, to_status from app.status_history where work_order_id=$1 order by changed_at`, [draftId]));
ok(history1b.rows.length === 2 && history1b.rows[1].from_status === 'pending_finance_approval' && history1b.rows[1].to_status === 'created',
  'status_history also logged pending_finance_approval -> created');

let reapprove = null;
try { await as(FINANCE, () => db.query(`select app.approve_work_order($1)`, [draftId])); } catch (e) { reapprove = e.message; }
ok(/not awaiting Finance approval/.test(reapprove || ''), 'approving an already-created Work Order is refused: ' + reapprove);

// Reject flow, on its own draft so it doesn't disturb the numbering/production assertions below.
const rejectDraftId = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2026-11-01', lines: [{ part_id: p1.id, qty: 50 }]
})]))).rows[0].id;
const rejectCreated = (await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [rejectDraftId]))).rows[0];
const rejected = (await as(FINANCE, () => db.query(`select * from app.reject_work_order($1, 'Price looks wrong')`, [rejectDraftId]))).rows[0];
ok(rejected.status === 'draft', 'Finance rejection sends the Work Order back to draft: ' + rejected.status);
ok(rejected.wo_number === rejectCreated.wo_number, 'the rejected draft keeps its original wo_number: ' + rejected.wo_number);
const resubmitted = (await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [rejectDraftId]))).rows[0];
ok(resubmitted.wo_number === rejectCreated.wo_number, 'resubmitting after rejection reuses the same wo_number, not a new one: ' + resubmitted.wo_number);
await as(FINANCE, () => db.query(`select app.approve_work_order($1)`, [rejectDraftId]));

// created2 also needs Finance approval before it can be produced against / invoiced (below).
await as(FINANCE, () => db.query(`select app.approve_work_order($1)`, [created2.id]));

// ---------------------------------------------------------------- RBAC on an existing (non-draft) WO
// RLS's USING clause simply excludes a row the caller may not touch — an UPDATE that matches nothing
// affects 0 rows, it does not throw. So the check here is "the value didn't change", not "it threw".
const creatorEditResult = await as(CREATOR, () => db.query(`update app.work_orders set doc_ref='HACK' where id=$1`, [draftId]));
const stillTest001 = (await as(CREATOR, () => db.query(`select doc_ref from app.work_orders where id=$1`, [draftId]))).rows[0].doc_ref;
ok(creatorEditResult.affectedRows === 0 && stillTest001 === 'TEST-001',
   'Creator can no longer edit it once created (0 rows affected by RLS, doc_ref still TEST-001)');

const lineIds = (await as(CREATOR, () => db.query(`select id, qty, final_price from app.work_order_lines where work_order_id=$1 order by line_no`, [draftId]))).rows;
let plannerPriceEdit = null;
try { await as(PLANNER, () => db.query(`update app.work_orders set doc_ref='HACK2' where id=$1`, [draftId])); } catch (e) { plannerPriceEdit = e.message; }
ok(/Expected Completion Date/.test(plannerPriceEdit || ''), 'Planner touching any other field is rejected loudly, not silently discarded: ' + plannerPriceEdit);

await as(PLANNER, () => db.query(`update app.work_orders set expected_completion_date='2026-10-15' where id=$1`, [draftId]));
const afterPlannerEdit = (await as(CREATOR, () => db.query(`select doc_ref, expected_completion_date from app.work_orders where id=$1`, [draftId]))).rows[0];
ok(afterPlannerEdit.doc_ref === 'TEST-001' && afterPlannerEdit.expected_completion_date.toISOString().startsWith('2026-10-15'),
   'Planner CAN change Expected Completion Date, and only that column: ' + JSON.stringify(afterPlannerEdit));
const cdc = await as(CREATOR, () => db.query(`select from_date, to_date from app.completion_date_changes where work_order_id=$1`, [draftId]));
ok(cdc.rows.length === 1, 'completion_date_changes logged prior + new date');

// MD edits final_price and delivery_date -> new revision
await as(MD, () => db.query(`update app.work_order_lines set final_price=99.99 where id=$1`, [lineIds[0].id]));
await as(MD, () => db.query(`update app.work_orders set delivery_date='2026-10-20' where id=$1`, [draftId]));
const revised = (await as(CREATOR, () => db.query(`select revision from app.work_orders where id=$1`, [draftId]))).rows[0];
ok(revised.revision === 1, 'MD editing a business field bumped revision to 1: got ' + revised.revision);
const revLog = await as(CREATOR, () => db.query(`select revision, changed_by from app.work_order_revisions where work_order_id=$1`, [draftId]));
ok(revLog.rows.length === 1 && revLog.rows[0].revision === 0, 'work_order_revisions kept the PRIOR snapshot (revision 0)');

const qcEditResult = await as(QC, () => db.query(`update app.work_orders set doc_ref='QCHACK' where id=$1`, [draftId]));
const stillNotQcHacked = (await as(CREATOR, () => db.query(`select doc_ref from app.work_orders where id=$1`, [draftId]))).rows[0].doc_ref;
ok(qcEditResult.affectedRows === 0 && stillNotQcHacked !== 'QCHACK', 'QC cannot edit Work Order rows directly (0 rows affected by RLS)');

// ---------------------------------------------------------------- production, over-production guard, QC, invoice
const shiftMorningId = (await db.query(`select id from app.shifts where code='1'`)).rows[0].id;

let overProd = null;
try {
  await as(PLANNER, () => db.query(`select app.record_production($1)`, [JSON.stringify({
    work_order_id: draftId, shift_id: shiftMorningId, labour_count: 5,
    lines: [{ work_order_line_id: lineIds[0].id, qty: 5000, actual_weight_kg: 1 }]
  })]));
} catch (e) { overProd = e.message; }
ok(!!overProd, 'over-production is blocked outright: ' + overProd);

await as(PLANNER, () => db.query(`select app.record_production($1)`, [JSON.stringify({
  work_order_id: draftId, shift_id: shiftMorningId, labour_count: 6,
  lines: [{ work_order_line_id: lineIds[0].id, qty: 600, actual_weight_kg: 150 }, { work_order_line_id: lineIds[1].id, qty: 200, actual_weight_kg: 20 }]
})]));
let statusAfterProd = (await as(CREATOR, () => db.query(`select status from app.work_orders where id=$1`, [draftId]))).rows[0].status;
ok(statusAfterProd === 'in_production', 'status auto-recomputed to in_production: ' + statusAfterProd);

const sentQty = (await as(PLANNER, () => db.query(`select app.send_line_to_qc($1) as q`, [lineIds[0].id]))).rows[0].q;
ok(Number(sentQty) === 600, 'send_line_to_qc sent exactly the unsent-produced amount: ' + sentQty);
statusAfterProd = (await as(CREATOR, () => db.query(`select status from app.work_orders where id=$1`, [draftId]))).rows[0].status;
ok(statusAfterProd === 'qc_pending', 'status auto-recomputed to qc_pending: ' + statusAfterProd);

let overAccept = null;
try { await as(QC, () => db.query(`select app.record_qc_inspection($1, 601, 'x')`, [lineIds[0].id])); } catch (e) { overAccept = e.message; }
ok(!!overAccept, 'cannot accept more than what is awaiting inspection: ' + overAccept);

await as(QC, () => db.query(`select app.record_qc_inspection($1, 500, 'Sample check passed')`, [lineIds[0].id]));
const insp = (await as(CREATOR, () => db.query(`select accepted_qty, held_qty from app.qc_inspections where work_order_line_id=$1`, [lineIds[0].id]))).rows[0];
ok(Number(insp.accepted_qty) === 500 && Number(insp.held_qty) === 100, 'Accept 500 of 600 -> 100 Held (not accepted, not dropped): ' + JSON.stringify(insp));
statusAfterProd = (await as(CREATOR, () => db.query(`select status from app.work_orders where id=$1`, [draftId]))).rows[0].status;
ok(statusAfterProd === 'partially_qc_approved', 'status auto-recomputed to partially_qc_approved: ' + statusAfterProd);

const reopened = (await as(QC, () => db.query(`select app.reopen_held($1) as q`, [lineIds[0].id]))).rows[0].q;
ok(Number(reopened) === 100, 'reopen_held brought the 100 back: ' + reopened);
const afterReopen = (await as(CREATOR, () => db.query(
  `select coalesce(sum(accepted_qty),0) a, coalesce(sum(held_qty),0) h from app.qc_inspections where work_order_line_id=$1`, [lineIds[0].id]))).rows[0];
ok(Number(afterReopen.h) === 0, 'held total is back to 0 after reopening: ' + JSON.stringify(afterReopen));
await as(QC, () => db.query(`select app.record_qc_inspection($1, 100, 're-inspected, accepted')`, [lineIds[0].id]));

let plannerInspect = null;
try { await as(PLANNER, () => db.query(`select app.record_qc_inspection($1, 1, 'x')`, [lineIds[1].id])); } catch (e) { plannerInspect = e.message; }
ok(!!plannerInspect, 'Planner cannot record a QC inspection (' + plannerInspect + ')');

let creatorInvoice = null;
try { await as(CREATOR, () => db.query(`select app.generate_invoice($1, 18, 'intra')`, [draftId])); } catch (e) { creatorInvoice = e.message; }
ok(!!creatorInvoice, 'Creator cannot generate an invoice (' + creatorInvoice + ')');

const invId = (await as(MD, () => db.query(`select app.generate_invoice($1, 18, 'intra') as id`, [draftId]))).rows[0].id;
const inv = (await as(CREATOR, () => db.query(`select * from app.invoices where id=$1`, [invId]))).rows[0];
const invLines = (await as(CREATOR, () => db.query(`select * from app.invoice_lines where invoice_id=$1 order by description`, [invId]))).rows;
// Line 1 (EB080600002, final_price MD-edited to 99.99): 600 produced, 600 QC-decided (500 accepted +
// 100 held-then-reopened-then-accepted) -> QC qty 600 > 0, so the invoice uses 600 (not the ordered 1000).
// Line 2 (CB1200450, price untouched at its seeded 42.00): no production/QC ever ran on this line in
// this test, so QC qty is 0 and the invoice falls back to its ordered qty (200) per the documented default.
ok(invLines.length === 2, 'invoice has one line per work order line: ' + invLines.length);
const line1Inv = invLines.find(l => Number(l.qty) === 600);
ok(line1Inv && Number(line1Inv.price) === 99.99 && Number(line1Inv.amount) === 59994,
   'invoice line 1 uses QC-approved qty (600) once it exists, at the MD-revised price: ' + JSON.stringify(line1Inv));
const line2Inv = invLines.find(l => Number(l.qty) === 200);
ok(line2Inv && Number(line2Inv.price) === 42 && Number(line2Inv.amount) === 8400,
   'invoice line 2 falls back to ordered qty (200, no QC done on it) at its unrevised price: ' + JSON.stringify(line2Inv));
const expectedSubtotal = 600 * 99.99 + 200 * 42;
ok(Math.abs(Number(inv.subtotal) - expectedSubtotal) < 0.01, `subtotal matches hand calc: got ${inv.subtotal} expected ${expectedSubtotal}`);
ok(Math.abs(Number(inv.cgst) - Number(inv.sgst)) < 0.001 && Number(inv.cgst) > 0 && Number(inv.igst) === 0, 'intra-state: CGST=SGST, no IGST: ' + JSON.stringify({cgst:inv.cgst,sgst:inv.sgst,igst:inv.igst}));
ok(/^INV\/\d{4}-\d{2}\/\d{4}$/.test(inv.invoice_number), 'invoice number format: ' + inv.invoice_number);

const inv2Id = (await as(MD, () => db.query(`select app.generate_invoice($1, 18, 'inter') as id`, [created2.id]))).rows[0].id;
const inv2 = (await as(CREATOR, () => db.query(`select * from app.invoices where id=$1`, [inv2Id]))).rows[0];
ok(Number(inv2.igst) > 0 && Number(inv2.cgst) === 0 && Number(inv2.sgst) === 0, 'inter-state: IGST only: ' + JSON.stringify({cgst:inv2.cgst,igst:inv2.igst}));
ok(inv2.invoice_number !== inv.invoice_number, 'a second invoice gets its own sequential number: ' + inv2.invoice_number);

// ---------------------------------------------------------------- delete/read guarantees
let noDelete = null;
try { await as(MD, () => db.query(`delete from app.work_orders where id=$1`, [draftId])); } catch (e) { noDelete = e.message; }
const stillThere = (await as(CREATOR, () => db.query(`select 1 from app.work_orders where id=$1`, [draftId]))).rows.length;
ok(stillThere === 1, 'no delete policy exists on work_orders — MD\'s delete affected 0 rows, record still present' + (noDelete ? ' (' + noDelete + ')' : ''));

// ---------------------------------------------------------------- Users page support (added 28 Sep 2026)
// MD can now manage users directly (RLS), not just Admin — the Edge Function adds the "can't remove
// the last MD/Admin" / "can't self-delete" rails on top; RLS here only governs who may touch the row.
await as(MD, () => db.query(`update app.users set role='finance' where id=$1`, [QC]));
ok((await as(CREATOR, () => db.query(`select role from app.users where id=$1`, [QC]))).rows[0].role === 'finance',
   'MD can change another user\'s role directly (RLS broadened from Admin-only)');
await as(MD, () => db.query(`update app.users set role='qc' where id=$1`, [QC])); // put it back

let creatorCannotChangeRoles = null;
const creatorRoleEdit = await as(CREATOR, () => db.query(`update app.users set role='admin' where id=$1`, [QC]));
ok(creatorRoleEdit.affectedRows === 0, 'Creator (not MD/Admin) cannot change another user\'s role (0 rows affected by RLS)');

// is_active=false is treated as "no role" by app.current_role()/current_role_in() — the single choke
// point every RLS policy and RBAC check in 002_rls.sql/003_functions.sql is built on.
await as(ADMIN, () => db.query(`update app.users set is_active=false where id=$1`, [MD]));
let deactivatedMdBlocked = null;
try { await as(MD, () => db.query(`select app.generate_invoice($1, 18, 'intra')`, [created2.id])); }
catch (e) { deactivatedMdBlocked = e.message; }
ok(!!deactivatedMdBlocked, 'a deactivated MD is treated as roleless — an MD-only action is refused: ' + deactivatedMdBlocked);
const deactivatedStillReads = await as(MD, () => db.query(`select 1 from app.work_orders where id=$1`, [draftId]));
ok(deactivatedStillReads.rows.length === 1, 'a deactivated user can still read (broad SELECT policies are unaffected, only role-gated actions are)');

// A deactivated MD can't reactivate themself. users_update_md_admin's USING fails outright (their own
// current_role_in() is now false); users_update_own_name's USING still matches (id = auth.uid()), but
// its WITH CHECK pins is_active unchanged, so Postgres raises rather than silently affecting 0 rows.
let selfReactivateErr = null;
try { await as(MD, () => db.query(`update app.users set is_active=true where id=$1`, [MD])); }
catch (e) { selfReactivateErr = e.message; }
const stillDeactivated = (await as(CREATOR, () => db.query(`select is_active from app.users where id=$1`, [MD]))).rows[0].is_active;
ok(!!selfReactivateErr && stillDeactivated === false,
   'a deactivated MD cannot reactivate themself (' + selfReactivateErr + ') — needs another active MD/Admin');

await as(ADMIN, () => db.query(`update app.users set is_active=true where id=$1`, [MD]));
const reactivated = (await as(CREATOR, () => db.query(`select is_active from app.users where id=$1`, [MD]))).rows[0].is_active;
ok(reactivated === true, 'Admin reactivates the MD: ' + reactivated);

console.log('\nDone.');
