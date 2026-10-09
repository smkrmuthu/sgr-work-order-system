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
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated;
  grant select, insert on storage.objects to authenticated;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated, public;
`);

// The API roles get their privileges from 005_grants.sql itself — no hand-written grants here, so a
// missing grant in the migrations fails these tests the way it would fail the real app.
const MIGRATIONS = ['001_schema.sql', '002_rls.sql', '003_functions.sql', '004_seed.sql', '005_grants.sql', '006_notes_and_customer_ref.sql', '007_creator_edit_before_approval.sql', '008_service_role_grants.sql', '009_qc_files.sql', '010_billing_and_dispatch.sql', '011_md_approve_and_revisions.sql', '012_review_fixes.sql', '013_backup_export_rpc.sql', '014_sales_persons.sql', '015_work_order_sales_person.sql', '016_update_work_order_sales_person.sql', '017_line_customer_price.sql', '018_customer_price_restricted.sql', '019_gsm_requirement.sql'];
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
await as(MD, () => db.query(`select app.update_work_order($1, $2)`, [draftId, JSON.stringify({
  delivery_date: '2026-10-20', lines: [{ id: lineIds[0].id, final_price: 99.99 }] })]));
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
ok(invLines.length === 1, 'the invoice bills only the line with QC-approved goods (line 2 has none yet): ' + invLines.length);
const line1Inv = invLines.find(l => Number(l.qty) === 600);
ok(line1Inv && Number(line1Inv.price) === 99.99 && Number(line1Inv.amount) === 59994,
   'invoice line 1 uses QC-approved qty (600) once it exists, at the MD-revised price: ' + JSON.stringify(line1Inv));
ok(!invLines.some((l) => Number(l.qty) === 200), 'goods that have not passed QC are never billed (no fall-back to the ordered qty)');
const expectedSubtotal = 600 * 99.99;
ok(Math.abs(Number(inv.subtotal) - expectedSubtotal) < 0.01, `subtotal matches hand calc: got ${inv.subtotal} expected ${expectedSubtotal}`);
ok(Math.abs(Number(inv.cgst) - Number(inv.sgst)) < 0.001 && Number(inv.cgst) > 0 && Number(inv.igst) === 0, 'intra-state: CGST=SGST, no IGST: ' + JSON.stringify({cgst:inv.cgst,sgst:inv.sgst,igst:inv.igst}));
ok(/^INV\/\d{4}-\d{2}\/\d{4}$/.test(inv.invoice_number), 'invoice number format: ' + inv.invoice_number);

// created2 (500 x p1): produce, send, and QC-approve it all so there is something to bill.
const c2Line = (await as(CREATOR, () => db.query(`select id from app.work_order_lines where work_order_id=$1`, [created2.id]))).rows[0].id;
let billBeforeQc = null;
try { await as(MD, () => db.query(`select app.generate_invoice($1, 18, 'inter')`, [created2.id])); } catch (e) { billBeforeQc = e.message; }
ok(/Nothing is ready to bill/.test(billBeforeQc || ''), 'an order with no QC-approved goods cannot be billed: ' + billBeforeQc);
await as(PLANNER, () => db.query(`select app.record_production($1)`, [JSON.stringify({
  work_order_id: created2.id, shift_id: shiftMorningId, labour_count: 4, lines: [{ work_order_line_id: c2Line, qty: 500, actual_weight_kg: 10 }] })]));
await as(PLANNER, () => db.query(`select app.send_line_to_qc($1)`, [c2Line]));
await as(QC, () => db.query(`select app.record_qc_inspection($1, 500, 'all good')`, [c2Line]));
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

// ---------------------------------------------------------------- customer reference + notes as points (006)
await as(MD, () => db.query(`update app.parts set customer_ref='MASTER-REF-1' where id=$1`, [p1.id]));
const noteDraftId = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2026-12-01',
  lines: [
    { part_id: p1.id, qty: 10 },                                   // falls back to the Item Master's reference
    { part_id: p2.id, qty: 5, customer_ref: '  CUST-77  ' },       // explicit, trimmed
  ],
  notes: ['Wrap in kraft paper', { text: 'Label both ends', icon: 'label' }, '   ', { icon: 'x' }],
})]))).rows[0].id;

const noteLines = (await as(CREATOR, () => db.query(`select customer_ref from app.work_order_lines where work_order_id=$1 order by line_no`, [noteDraftId]))).rows;
ok(noteLines[0].customer_ref === 'MASTER-REF-1' && noteLines[1].customer_ref === 'CUST-77',
   'line customer_ref: falls back to the Item Master, or takes the (trimmed) value given: ' + JSON.stringify(noteLines));

const savedNotes = (await as(CREATOR, () => db.query(`select position, note, icon from app.work_order_notes where work_order_id=$1 order by position`, [noteDraftId]))).rows;
ok(savedNotes.length === 2 && savedNotes[0].note === 'Wrap in kraft paper' && savedNotes[0].position === 1
   && savedNotes[1].note === 'Label both ends' && savedNotes[1].icon === 'label',
   'notes are stored as separate ordered points (blank / text-less entries dropped, icon kept): ' + JSON.stringify(savedNotes));

await as(CREATOR, () => db.query(`select app.save_draft($1, $2)`, [noteDraftId, JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2026-12-01',
  lines: [{ part_id: p1.id, qty: 10 }], notes: ['Only this one'],
})]));
const replacedNotes = (await as(CREATOR, () => db.query(`select note from app.work_order_notes where work_order_id=$1`, [noteDraftId]))).rows;
ok(replacedNotes.length === 1 && replacedNotes[0].note === 'Only this one', 're-saving a draft replaces its notes rather than piling them up');

let foreignNoteErr = null;
try { await as(OTHER_CREATOR, () => db.query(`insert into app.work_order_notes (work_order_id, note) values ($1, 'sneaky')`, [noteDraftId])); }
catch (e) { foreignNoteErr = e.message; }
ok(!!foreignNoteErr, "another Creator cannot add a note to someone else's draft (" + foreignNoteErr + ')');

let lockedNoteErr = null;
try { await as(CREATOR, () => db.query(`insert into app.work_order_notes (work_order_id, note) values ($1, 'too late')`, [draftId])); }
catch (e) { lockedNoteErr = e.message; }
ok(!!lockedNoteErr, 'a Creator cannot add notes once the Work Order is created (' + lockedNoteErr + ')');

const mdNote = await as(MD, () => db.query(`insert into app.work_order_notes (work_order_id, note) values ($1, 'MD addition')`, [draftId]));
ok(mdNote.affectedRows === 1, 'MD can still add a note after creation');

let anonNotes = null;
try { await asAnon(() => db.query(`select * from app.work_order_notes`)); } catch (e) { anonNotes = e.message; }
ok(/permission denied/.test(anonNotes || ''), 'anon cannot read notes: ' + anonNotes);

// The Edge Function reads app.users as service_role: it must be able to (this was the bug behind
// "Only MD or Admin can manage users" being shown to the MD), and it must still bypass RLS.
await db.exec('set role service_role');
const svcRows = (await db.query(`select role from app.users where id = $1`, [MD])).rows;
await db.exec('reset role');
ok(svcRows.length === 1 && svcRows[0].role === 'md', 'service_role can look up a user in app.users (Edge Function): ' + JSON.stringify(svcRows));

// Guard against the mistake 007 fixed: every table in `app` must have RLS switched on.
const noRls = (await db.query(`select relname from pg_class where relnamespace='app'::regnamespace and relkind='r' and not relrowsecurity order by 1`)).rows.map((r) => r.relname);
ok(noRls.length === 0, 'every table in app has row-level security enabled' + (noRls.length ? ' — MISSING: ' + noRls.join(', ') : ''));

// ---------------------------------------------------------------- Creator edits until Finance approves (007)
const partner2 = (await as(CREATOR, () => db.query(`select id from app.business_partners where code='XYX01'`))).rows[0];
const loc2 = (await as(CREATOR, () => db.query(`select id from app.delivery_locations where partner_id=$1 limit 1`, [partner2.id]))).rows[0];
const editId = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-01-10', doc_ref: 'EDIT-1',
  lines: [{ part_id: p1.id, qty: 10 }], notes: ['first note'],
})]))).rows[0].id;
const editCreated = (await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [editId]))).rows[0];
ok(editCreated.status === 'pending_finance_approval', 'setup: order is waiting for Finance');

// 1. The Creator edits EVERYTHING on their own waiting order: vendor, location, lines (part #, qty), notes.
await as(CREATOR, () => db.query(`select app.save_draft($1, $2)`, [editId, JSON.stringify({
  partner_id: partner2.id, delivery_location_id: loc2.id, delivery_date: '2027-02-02', doc_ref: 'EDIT-2',
  lines: [{ part_id: p2.id, qty: 77, customer_ref: 'NEW-REF' }, { part_id: p1.id, qty: 3 }],
  notes: ['changed note', 'second note'],
})]));
const afterEdit = (await as(CREATOR, () => db.query(`select status, wo_number, revision, partner_id, doc_ref from app.work_orders where id=$1`, [editId]))).rows[0];
ok(afterEdit.status === 'pending_finance_approval' && afterEdit.wo_number === editCreated.wo_number && afterEdit.revision === 0
   && afterEdit.partner_id === partner2.id && afterEdit.doc_ref === 'EDIT-2',
   'Creator edited the vendor and header of a waiting order; status, number and revision unchanged: ' + JSON.stringify(afterEdit));
const editLines = (await as(CREATOR, () => db.query(`select part_no_snapshot, qty, customer_ref from app.work_order_lines where work_order_id=$1 order by line_no`, [editId]))).rows;
ok(editLines.length === 2 && editLines[0].part_no_snapshot === 'CB1200450' && Number(editLines[0].qty) === 77 && editLines[0].customer_ref === 'NEW-REF',
   'Creator changed the part #s, quantities and customer ref: ' + JSON.stringify(editLines));
const editNotes = (await as(CREATOR, () => db.query(`select note from app.work_order_notes where work_order_id=$1 order by position`, [editId]))).rows.map((r) => r.note);
ok(JSON.stringify(editNotes) === JSON.stringify(['changed note', 'second note']), 'Creator changed the notes: ' + JSON.stringify(editNotes));
const editRevs = (await as(CREATOR, () => db.query(`select count(*) c from app.work_order_revisions where work_order_id=$1`, [editId]))).rows[0].c;
ok(Number(editRevs) === 0, 'edits before approval do not open a revision');

// 2. Not anyone else's order
let otherEdit = null;
try { await as(OTHER_CREATOR, () => db.query(`select app.save_draft($1, $2)`, [editId, JSON.stringify({ partner_id: partnerRow.id, lines: [{ part_id: p1.id, qty: 1 }] })])); }
catch (e) { otherEdit = e.message; }
const unchangedByOther = (await as(CREATOR, () => db.query(`select doc_ref from app.work_orders where id=$1`, [editId]))).rows[0].doc_ref;
ok(!!otherEdit && unchangedByOther === 'EDIT-2', "another Creator cannot edit someone else's waiting order (" + otherEdit + ')');

// 3. The loophole: a Creator (or anyone) setting status / number / revision directly
let skipFinance = null;
try { await as(CREATOR, () => db.query(`update app.work_orders set status='created' where id=$1`, [editId])); } catch (e) { skipFinance = e.message; }
ok(/only through the app/.test(skipFinance || ''), 'a Creator cannot skip Finance by setting the status directly: ' + skipFinance);
let renumber = null;
try { await as(CREATOR, () => db.query(`update app.work_orders set wo_number='999/2026-27' where id=$1`, [editId])); } catch (e) { renumber = e.message; }
ok(/only through the app/.test(renumber || ''), 'a Creator cannot change the Work Order number: ' + renumber);
let mdSkip = null;
try { await as(MD, () => db.query(`update app.work_orders set status='created' where id=$1`, [editId])); } catch (e) { mdSkip = e.message; }
ok(/only through the app/.test(mdSkip || ''), 'not even the MD can bypass Finance by editing the status: ' + mdSkip);
let plannerDate = null;
try { await as(CREATOR, () => db.query(`update app.work_orders set expected_completion_date='2027-03-01' where id=$1`, [editId])); } catch (e) { plannerDate = e.message; }
ok(/Production Planner/.test(plannerDate || ''), 'a Creator cannot set the Expected Completion Date: ' + plannerDate);

// 4. Once Finance approves, the Creator is locked out again — loudly, with nothing changed
await as(FINANCE, () => db.query(`select app.approve_work_order($1)`, [editId]));
let lockedEdit = null;
try { await as(CREATOR, () => db.query(`select app.save_draft($1, $2)`, [editId, JSON.stringify({ partner_id: partnerRow.id, lines: [{ part_id: p1.id, qty: 1 }], notes: ['after approval'] })])); }
catch (e) { lockedEdit = e.message; }
const lockedState = (await as(CREATOR, () => db.query(`select (select doc_ref from app.work_orders where id=$1) d, (select count(*) from app.work_order_lines where work_order_id=$1) n`, [editId]))).rows[0];
ok(!!lockedEdit && lockedState.d === 'EDIT-2' && Number(lockedState.n) === 2, 'after Finance approval the Creator can no longer edit (' + lockedEdit + '), nothing changed');
let lockedHeader = null;
try { await as(CREATOR, () => db.query(`update app.work_orders set doc_ref='LATE' where id=$1`, [editId])); } catch (e) { lockedHeader = e.message; }
const lateHeader = (await as(CREATOR, () => db.query(`select doc_ref from app.work_orders where id=$1`, [editId]))).rows[0].doc_ref;
ok(lateHeader === 'EDIT-2', 'a direct header edit after approval changes nothing');
await as(MD, () => db.query(`update app.work_orders set doc_ref='MD-EDIT' where id=$1`, [editId]));
const mdRev = (await as(MD, () => db.query(`select revision from app.work_orders where id=$1`, [editId]))).rows[0].revision;
ok(mdRev === 1, 'after approval an MD edit still opens a revision: R' + mdRev);

// 5. Rejected by Finance -> back to draft -> the Creator can fix it and resubmit
const rejId = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-01-10', lines: [{ part_id: p1.id, qty: 5 }],
})]))).rows[0].id;
await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [rejId]));
await as(FINANCE, () => db.query(`select app.reject_work_order($1, 'wrong quantity')`, [rejId]));
await as(CREATOR, () => db.query(`select app.save_draft($1, $2)`, [rejId, JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-01-10', lines: [{ part_id: p1.id, qty: 6 }],
})]));
const fixedQty = (await as(CREATOR, () => db.query(`select qty from app.work_order_lines where work_order_id=$1`, [rejId]))).rows[0].qty;
ok(Number(fixedQty) === 6, 'a Creator can fix a rejected order and resubmit it');

// ---------------------------------------------------------------- billing net of what is already billed, and dispatch (010)
let doubleBill = null;
try { await as(MD, () => db.query(`select app.generate_invoice($1, 18, 'intra')`, [created2.id])); } catch (e) { doubleBill = e.message; }
ok(/Nothing is ready to bill/.test(doubleBill || ''), 'the same goods cannot be billed twice: ' + doubleBill);

// draftId line 1: 600 approved and billed above; produce + approve 400 more -> only those 400 are billable
await as(PLANNER, () => db.query(`select app.record_production($1)`, [JSON.stringify({
  work_order_id: draftId, shift_id: shiftMorningId, labour_count: 4, lines: [{ work_order_line_id: lineIds[0].id, qty: 400, actual_weight_kg: 1 }] })]));
await as(PLANNER, () => db.query(`select app.send_line_to_qc($1)`, [lineIds[0].id]));
await as(QC, () => db.query(`select app.record_qc_inspection($1, 400, 'second batch')`, [lineIds[0].id]));
const inv3Id = (await as(MD, () => db.query(`select app.generate_invoice($1, 18, 'intra') as id`, [draftId]))).rows[0].id;
const inv3Lines = (await as(CREATOR, () => db.query(`select qty from app.invoice_lines where invoice_id=$1`, [inv3Id]))).rows;
ok(inv3Lines.length === 1 && Number(inv3Lines[0].qty) === 400, 'a later invoice bills only the newly approved 400, not the 600 already billed: ' + JSON.stringify(inv3Lines));

let financeBill = null;
try { await as(FINANCE, () => db.query(`select app.generate_invoice($1, 18, 'intra')`, [draftId])); } catch (e) { financeBill = e.message; }
ok(/Only MD/.test(financeBill || ''), 'only MD/Admin create invoices: ' + financeBill);

let plannerDispatch = null;
try { await as(PLANNER, () => db.query(`select app.mark_invoice_dispatched($1)`, [inv2Id])); } catch (e) { plannerDispatch = e.message; }
ok(/Only MD/.test(plannerDispatch || ''), 'only MD/Admin mark an invoice dispatched: ' + plannerDispatch);

await as(MD, () => db.query(`select app.mark_invoice_dispatched($1)`, [inv2Id]));
const dispatched = (await as(CREATOR, () => db.query(`select dispatched_at, dispatched_by from app.invoices where id=$1`, [inv2Id]))).rows[0];
ok(dispatched.dispatched_at !== null && dispatched.dispatched_by === MD, 'dispatch is recorded with who and when');
const c2Status = (await as(CREATOR, () => db.query(`select status from app.work_orders where id=$1`, [created2.id]))).rows[0].status;
ok(c2Status === 'completed', 'an order that is fully billed and fully dispatched is completed: ' + c2Status);
let twice = null;
try { await as(MD, () => db.query(`select app.mark_invoice_dispatched($1)`, [inv2Id])); } catch (e) { twice = e.message; }
ok(/already been dispatched/.test(twice || ''), 'an invoice cannot be dispatched twice: ' + twice);

await as(MD, () => db.query(`select app.mark_invoice_dispatched($1)`, [invId]));
const partialStatus = (await as(CREATOR, () => db.query(`select status from app.work_orders where id=$1`, [draftId]))).rows[0].status;
ok(partialStatus !== 'completed', 'a partly billed order (line 2 never produced) stays open after a dispatch: ' + partialStatus);

let editInvoice = null;
const editRes = await as(MD, () => db.query(`update app.invoices set grand_total = 1 where id=$1`, [inv3Id]));
ok(editRes.affectedRows === 0, 'an invoice cannot be edited directly, even by the MD');

// ---------------------------------------------------------------- MD approves too; one MD edit = one revision (011)
const mdPendingId = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-03-01', lines: [{ part_id: p1.id, qty: 20 }] })]))).rows[0].id;
await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [mdPendingId]));
const mdApproved = (await as(MD, () => db.query(`select * from app.approve_work_order($1)`, [mdPendingId]))).rows[0];
ok(mdApproved.status === 'created', 'the MD can approve a Work Order too');
const mdLog = (await as(CREATOR, () => db.query(`select actor from app.finance_approvals where work_order_id=$1`, [mdPendingId]))).rows[0];
ok(mdLog.actor === MD, 'the approval is recorded against the MD');
let plannerApprove = null;
const plannerPending = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-03-01', lines: [{ part_id: p1.id, qty: 2 }] })]))).rows[0].id;
await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [plannerPending]));
try { await as(PLANNER, () => db.query(`select app.approve_work_order($1)`, [plannerPending])); } catch (e) { plannerApprove = e.message; }
ok(/Only Finance or the MD/.test(plannerApprove || ''), 'Planner/QC/Creator still cannot approve: ' + plannerApprove);

// A quantity-only edit used to open no revision at all.
const mdLine = (await as(CREATOR, () => db.query(`select id from app.work_order_lines where work_order_id=$1`, [mdPendingId]))).rows[0].id;
const revBefore = (await as(MD, () => db.query(`select revision from app.work_orders where id=$1`, [mdPendingId]))).rows[0].revision;
const revAfter = (await as(MD, () => db.query(`select app.update_work_order($1, $2) as r`, [mdPendingId, JSON.stringify({ lines: [{ id: mdLine, qty: 700 }] })]))).rows[0].r;
ok(revBefore === 0 && revAfter === 1, 'a quantity-only edit by the MD opens revision R1: R' + revBefore + ' -> R' + revAfter);
const revRow = (await as(CREATOR, () => db.query(`select revision, change_summary, snapshot from app.work_order_revisions where work_order_id=$1`, [mdPendingId]))).rows[0];
ok(revRow.revision === 0 && /qty 20\.00 -> 700/.test(revRow.change_summary) && Number(revRow.snapshot.lines[0].qty) === 20,
   'the revision keeps the order as it was (qty 20) and says what changed: ' + revRow.change_summary);

// Header + several lines in one save = exactly one revision.
const multi = (await as(MD, () => db.query(`select app.update_work_order($1, $2) as r`, [mdPendingId, JSON.stringify({
  delivery_date: '2027-04-01', doc_ref: 'MD-DOC', lines: [{ id: mdLine, qty: 650, final_price: 55 }] })]))).rows[0].r;
ok(multi === 2, 'header + line changes in one save open exactly one new revision: R' + multi);
const noop = (await as(MD, () => db.query(`select app.update_work_order($1, $2) as r`, [mdPendingId, JSON.stringify({ lines: [{ id: mdLine, qty: 650 }] })]))).rows[0].r;
ok(noop === 2, 'saving with nothing changed opens no revision');

// Never below what is produced.
await as(PLANNER, () => db.query(`select app.record_production($1)`, [JSON.stringify({
  work_order_id: mdPendingId, shift_id: shiftMorningId, labour_count: 3, lines: [{ work_order_line_id: mdLine, qty: 100, actual_weight_kg: 1 }] })]));
let belowMade = null;
try { await as(MD, () => db.query(`select app.update_work_order($1, $2)`, [mdPendingId, JSON.stringify({ lines: [{ id: mdLine, qty: 50 }] })])); } catch (e) { belowMade = e.message; }
ok(/already produced or billed/.test(belowMade || ''), 'quantity cannot be cut below what is already produced: ' + belowMade);

// Only the MD/Admin, and no side door around the revision.
let creatorEditsReleased = null;
try { await as(CREATOR, () => db.query(`select app.update_work_order($1, $2)`, [mdPendingId, JSON.stringify({ doc_ref: 'x' })])); } catch (e) { creatorEditsReleased = e.message; }
ok(/Only the MD/.test(creatorEditsReleased || ''), 'only the MD can edit a released order: ' + creatorEditsReleased);
const sideDoor = await as(MD, () => db.query(`update app.work_order_lines set qty = 1 where id = $1`, [mdLine]));
ok(sideDoor.affectedRows === 0, 'the MD cannot change a released order\'s line directly, bypassing the revision');

// ---------------------------------------------------------------- QC file uploads (009)
const bucket = (await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id='qc-attachments'`)).rows[0];
ok(bucket && bucket.public === false && Number(bucket.file_size_limit) === 10485760 && bucket.allowed_mime_types.includes('application/pdf'),
   'the QC files bucket is private, 10 MB, with a file-type allow-list');

const inspRow = (await as(CREATOR, () => db.query(`select id, work_order_line_id from app.qc_inspections limit 1`))).rows[0];
const inspWo = (await as(CREATOR, () => db.query(`select work_order_id from app.work_order_lines where id=$1`, [inspRow.work_order_line_id]))).rows[0].work_order_id;

const uploadOk = await as(QC, () => db.query(`insert into storage.objects (bucket_id, name) values ('qc-attachments', $1)`, [`${inspWo}/${inspRow.id}/report.pdf`]));
ok(uploadOk.affectedRows === 1, 'QC can upload a file to the QC bucket');
let plannerUpload = null;
try { await as(PLANNER, () => db.query(`insert into storage.objects (bucket_id, name) values ('qc-attachments', 'x/y.pdf')`)); } catch (e) { plannerUpload = e.message; }
ok(!!plannerUpload, 'a Planner cannot upload to the QC bucket (' + plannerUpload + ')');
const readByCreator = await as(CREATOR, () => db.query(`select 1 from storage.objects where bucket_id='qc-attachments'`));
ok(readByCreator.rows.length === 1, 'any signed-in user can read the QC files list');
let anonFiles = null; let anonFileRows = 0;
try { anonFileRows = (await asAnon(() => db.query(`select 1 from storage.objects`))).rows.length; } catch (e) { anonFiles = e.message; }
ok(anonFileRows === 0, 'a signed-out visitor sees no QC files' + (anonFiles ? ' (' + anonFiles + ')' : ''));

const att = { wo: inspWo, insp: inspRow.id };
await as(QC, () => db.query(`insert into app.attachments (work_order_id, qc_inspection_id, file_name, storage_key, content_type, uploaded_by)
                            values ($1,$2,'report.pdf',$3,'application/pdf',$4)`, [att.wo, att.insp, `${att.wo}/${att.insp}/report.pdf`, QC]));
ok((await as(CREATOR, () => db.query(`select file_name from app.attachments where qc_inspection_id=$1`, [att.insp]))).rows[0].file_name === 'report.pdf',
   'QC attached the file to the inspection, visible to others');
let plannerAttach = null;
try { await as(PLANNER, () => db.query(`insert into app.attachments (work_order_id, qc_inspection_id, file_name, storage_key) values ($1,$2,'x.pdf','k')`, [att.wo, att.insp])); }
catch (e) { plannerAttach = e.message; }
ok(!!plannerAttach, 'a Planner cannot attach files to a QC inspection (' + plannerAttach + ')');
const delAtt = await as(MD, () => db.query(`delete from app.attachments where qc_inspection_id=$1`, [att.insp]));
const updAtt = await as(MD, () => db.query(`update app.attachments set file_name='renamed' where qc_inspection_id=$1`, [att.insp]));
ok(delAtt.affectedRows === 0 && updAtt.affectedRows === 0, 'an inspection file cannot be deleted or renamed, even by the MD');

// ---------------------------------------------------------------- 012 review fixes
// #1 lock: a single (non-concurrent) call still behaves exactly as before — PGlite is one connection,
// so the interleaved-transaction race itself can't be reproduced here; this is a regression check that
// adding `for update` didn't change the normal, single-caller behaviour of any of the three functions.
const lockCheckDraft = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-05-01', lines: [{ part_id: p1.id, qty: 40 }] })]))).rows[0].id;
await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [lockCheckDraft]));
await as(FINANCE, () => db.query(`select app.approve_work_order($1)`, [lockCheckDraft]));
const lockCheckLine = (await as(CREATOR, () => db.query(`select id from app.work_order_lines where work_order_id=$1`, [lockCheckDraft]))).rows[0].id;
await as(PLANNER, () => db.query(`select app.record_production($1)`, [JSON.stringify({
  work_order_id: lockCheckDraft, shift_id: shiftMorningId, labour_count: 2, lines: [{ work_order_line_id: lockCheckLine, qty: 40 }] })]));
const sentAfterLock = (await as(PLANNER, () => db.query(`select app.send_line_to_qc($1) as q`, [lockCheckLine]))).rows[0].q;
await as(QC, () => db.query(`select app.record_qc_inspection($1, 40, 'ok')`, [lockCheckLine]));
ok(Number(sentAfterLock) === 40, 'record_production + send_line_to_qc + record_qc_inspection still work normally with the new locks: sent ' + sentAfterLock);

// #8 create_work_order now rejects a zero/negative-quantity line.
const badQtyDraft = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-05-01', lines: [{ part_id: p1.id, qty: 0 }] })]))).rows[0].id;
let badQtyErr = null;
try { await as(CREATOR, () => db.query(`select app.create_work_order($1)`, [badQtyDraft])); } catch (e) { badQtyErr = e.message; }
ok(/quantity greater than zero/.test(badQtyErr || ''), 'create_work_order rejects a zero-quantity line: ' + badQtyErr);

// #9 generate_invoice now bounds the GST rate.
let badGstErr = null;
try { await as(MD, () => db.query(`select app.generate_invoice($1, -18, 'intra')`, [lockCheckDraft])); } catch (e) { badGstErr = e.message; }
ok(/GST rate must be between/.test(badGstErr || ''), 'generate_invoice rejects a negative GST rate: ' + badGstErr);
let badGstErr2 = null;
try { await as(MD, () => db.query(`select app.generate_invoice($1, 9999, 'intra')`, [lockCheckDraft])); } catch (e) { badGstErr2 = e.message; }
ok(/GST rate must be between/.test(badGstErr2 || ''), 'generate_invoice rejects a GST rate above 100: ' + badGstErr2);

// #7 save_draft's header write now also works for MD/Admin on someone else's draft (lines/notes already did).
const otherHeaderDraft = (await as(OTHER_CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-05-01', doc_ref: 'BEFORE', lines: [{ part_id: p1.id, qty: 1 }] })]))).rows[0].id;
await as(MD, () => db.query(`select app.save_draft($1, $2)`, [otherHeaderDraft, JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-05-01', doc_ref: 'MD-FIXED', lines: [{ part_id: p1.id, qty: 1 }] })]));
const otherHeaderAfter = (await as(CREATOR, () => db.query(`select doc_ref from app.work_orders where id=$1`, [otherHeaderDraft]))).rows[0].doc_ref;
ok(otherHeaderAfter === 'MD-FIXED', "MD's save_draft now updates another Creator's draft header too: " + otherHeaderAfter);
let plannerHeaderEdit = null;
try { await as(PLANNER, () => db.query(`select app.save_draft($1, $2)`, [otherHeaderDraft, JSON.stringify({ doc_ref: 'SNEAKY', lines: [{ part_id: p1.id, qty: 1 }] })])); }
catch (e) { plannerHeaderEdit = e.message; }
const stillMdFixed = (await as(CREATOR, () => db.query(`select doc_ref from app.work_orders where id=$1`, [otherHeaderDraft]))).rows[0].doc_ref;
ok(stillMdFixed === 'MD-FIXED', "a Planner still cannot edit someone else's draft header" + (plannerHeaderEdit ? ' (' + plannerHeaderEdit + ')' : ' (0 rows via RLS)'));

// #2 cancel_work_order: was completely unreachable before 012 (no function ever set status='cancelled').
const cancelDraft = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-05-01', lines: [{ part_id: p1.id, qty: 3 }] })]))).rows[0].id;
await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [cancelDraft]));
await as(FINANCE, () => db.query(`select app.approve_work_order($1)`, [cancelDraft]));
let plannerCancel = null;
try { await as(PLANNER, () => db.query(`select app.cancel_work_order($1, 'x')`, [cancelDraft])); } catch (e) { plannerCancel = e.message; }
ok(/Only MD/.test(plannerCancel || ''), 'only MD/Admin may cancel a Work Order: ' + plannerCancel);
const cancelled = (await as(MD, () => db.query(`select * from app.cancel_work_order($1, 'wrong vendor')`, [cancelDraft]))).rows[0];
ok(cancelled.status === 'cancelled', 'MD can now cancel a Work Order (was unreachable before 012): ' + cancelled.status);
const cancelLog = (await as(CREATOR, () => db.query(`select action, comments from app.finance_approvals where work_order_id=$1 order by created_at desc limit 1`, [cancelDraft]))).rows[0];
ok(/Cancelled: wrong vendor/.test(cancelLog.comments), 'the cancellation reason is recorded: ' + cancelLog.comments);
let doubleCancel = null;
try { await as(MD, () => db.query(`select app.cancel_work_order($1)`, [cancelDraft])); } catch (e) { doubleCancel = e.message; }
ok(/cannot be cancelled/.test(doubleCancel || ''), 'an already-cancelled Work Order cannot be cancelled again: ' + doubleCancel);
let directCancelStillBlocked = null;
try { await as(MD, () => db.query(`update app.work_orders set status='created' where id=$1`, [cancelDraft])); } catch (e) { directCancelStillBlocked = e.message; }
ok(/only through the app/.test(directCancelStillBlocked || ''), "007's direct-status-edit block is still in force (cancel_work_order is the only door): " + directCancelStillBlocked);

// ---------------------------------------------------------------- 013: Backup page's real access control
// The bug: the Backup page had no role check anywhere, only a hidden nav link, while a plain
// `.from('business_partners').select('*')` succeeds for ANY signed-in role (RLS deliberately keeps most
// tables broadly readable). So the actual boundary has to be this RPC, not the page.
let plannerExport = null;
try { await as(PLANNER, () => db.query(`select app.export_table('business_partners')`)); } catch (e) { plannerExport = e.message; }
ok(/Only MD or Admin may export/.test(plannerExport || ''), 'a Planner cannot call export_table at all, not even for a broadly-readable table: ' + plannerExport);
let financeExport = null;
try { await as(FINANCE, () => db.query(`select app.export_table('invoices')`)); } catch (e) { financeExport = e.message; }
ok(/Only MD or Admin may export/.test(financeExport || ''), 'neither can Finance, QC or Creator (spot-checked with Finance): ' + financeExport);

const exportedPartners = (await as(MD, () => db.query(`select app.export_table('business_partners') as rows`))).rows[0].rows;
ok(Array.isArray(exportedPartners) && exportedPartners.length === 3 && exportedPartners[0].code,
   'MD can export a real table and gets actual rows back: ' + exportedPartners.length + ' partner(s)');
const adminExport = (await as(ADMIN, () => db.query(`select app.export_table('parts') as rows`))).rows[0].rows;
ok(Array.isArray(adminExport) && adminExport.length > 0, 'Admin (not just MD) can export too: ' + adminExport.length + ' part(s)');

// coalesce(..., '[]'::jsonb) inside export_table means a table with zero matching rows comes back as an
// actual empty array over the wire, never a bare SQL null the frontend would otherwise have to special-case.
// Nothing later in this suite reads app.notifications, so clearing it here is safe.
await db.query(`delete from app.notifications`);
const emptyExport = (await as(MD, () => db.query(`select app.export_table('notifications') as rows`))).rows[0].rows;
ok(Array.isArray(emptyExport) && emptyExport.length === 0, 'a genuinely empty table comes back as [] via coalesce, not null: ' + JSON.stringify(emptyExport));

let badTableName = null;
try { await as(MD, () => db.query(`select app.export_table('auth.users')`)); } catch (e) { badTableName = e.message; }
ok(/Unknown table/.test(badTableName || ''), "export_table refuses anything outside its allow-list (tried 'auth.users'): " + badTableName);


// ---------------------------------------------------------------- Customer Price is restricted in the database (018)
const cpDraft = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-05-01',
  lines: [{ part_id: p1.id, qty: 10, customer_price: 12.5 }, { part_id: p2.id, qty: 4 }] })]))).rows[0].id;
await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [cpDraft]));
const cpLines = (await as(CREATOR, () => db.query(`select id, line_no from app.work_order_lines where work_order_id=$1 order by line_no`, [cpDraft]))).rows;

ok(!(await db.query(`select 1 from information_schema.columns where table_schema='app' and table_name='work_order_lines' and column_name='customer_price'`)).rows.length,
   'work_order_lines no longer has a customer_price column for anyone to read');
const cpSeen = async (who) => (await as(who, () => db.query(`select work_order_line_id, customer_price from app.work_order_line_prices`))).rows;
for (const [name, who] of [['Planner', PLANNER], ['QC', QC]]) {
  ok((await cpSeen(who)).length === 0, name + ' reads zero customer prices straight from the table');
}
for (const [name, who] of [['Creator', CREATOR], ['MD', MD], ['Admin', ADMIN], ['Finance', FINANCE]]) {
  const r = await cpSeen(who);
  ok(r.length >= 1 && r.some((x) => Number(x.customer_price) === 12.5), name + ' can read the customer price: ' + r.length + ' row(s)');
}
ok(cpLines.length === 2 && (await cpSeen(MD)).filter((x) => cpLines.some((l) => l.id === x.work_order_line_id)).length === 1,
   'only the line given a price has a price row (the other has none)');

let plannerWrite = null;
try { await as(PLANNER, () => db.query(`insert into app.work_order_line_prices values ($1, 1)`, [cpLines[1].id])); } catch (e) { plannerWrite = e.message; }
ok(/row-level security/.test(plannerWrite || ''), 'a Planner cannot write a customer price either: ' + plannerWrite);
let otherCreatorWrite = null;
try { await as(OTHER_CREATOR, () => db.query(`insert into app.work_order_line_prices values ($1, 1)`, [cpLines[1].id])); } catch (e) { otherCreatorWrite = e.message; }
ok(/row-level security/.test(otherCreatorWrite || ''), "another Creator cannot price someone else's order: " + otherCreatorWrite);

await as(FINANCE, () => db.query(`select app.approve_work_order($1)`, [cpDraft]));   // released orders open a revision on every MD edit
// MD edit: price changes, revision says so but never shows the figures, and the snapshot has no price.
const cpRevBefore = (await as(MD, () => db.query(`select revision from app.work_orders where id=$1`, [cpDraft]))).rows[0].revision;
await as(MD, () => db.query(`select app.update_work_order($1, $2)`, [cpDraft, JSON.stringify({
  lines: [{ id: cpLines[0].id, customer_price: 99 }, { id: cpLines[1].id, customer_price: 7 }] })]));
const cpNow = (await cpSeen(MD)).filter((x) => cpLines.some((l) => l.id === x.work_order_line_id));
ok(cpNow.length === 2 && cpNow.some((x) => Number(x.customer_price) === 99) && cpNow.some((x) => Number(x.customer_price) === 7),
   'MD edit updates one price and adds a missing one');
const cpRevs = (await as(PLANNER, () => db.query(`select change_summary, snapshot from app.work_order_revisions where work_order_id=$1`, [cpDraft]))).rows;
const cpRevText = JSON.stringify(cpRevs);
ok(cpRevs.length >= 1 && /customer price changed/.test(cpRevText) && !/12\.5|\b99\b|customer_price/.test(cpRevText),
   'a Planner reading revisions sees "customer price changed" but no figure and no customer_price key');
await as(MD, () => db.query(`select app.update_work_order($1, $2)`, [cpDraft, JSON.stringify({ lines: [{ id: cpLines[1].id, customer_price: '' }] })]));
ok((await cpSeen(MD)).filter((x) => x.work_order_line_id === cpLines[1].id).length === 0, 'clearing the price removes its row');

// Re-saving a draft carries the price across (lines are rewritten each save).
const cpDraft2 = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
  partner_id: partnerRow.id, lines: [{ part_id: p1.id, qty: 1, customer_price: 3 }] })]))).rows[0].id;
await as(CREATOR, () => db.query(`select app.save_draft($1, $2)`, [cpDraft2, JSON.stringify({
  partner_id: partnerRow.id, lines: [{ part_id: p1.id, qty: 2, customer_price: 4 }] })]));
const cp2 = (await as(CREATOR, () => db.query(`select p.customer_price from app.work_order_line_prices p join app.work_order_lines l on l.id=p.work_order_line_id where l.work_order_id=$1`, [cpDraft2]))).rows;
ok(cp2.length === 1 && Number(cp2[0].customer_price) === 4, 'saving a draft again replaces its price (no stale or duplicate rows): ' + JSON.stringify(cp2));
const cpExport = (await as(MD, () => db.query(`select app.export_table('work_order_line_prices') as rows`))).rows[0].rows;
ok(Array.isArray(cpExport) && cpExport.length >= 2, 'the MD backup export includes the prices table: ' + cpExport.length + ' row(s)');


// ---------------------------------------------------------------- GSM (019)
const gsmErr = async (payload, submit = false) => {
  try {
    const id = (await as(CREATOR, () => db.query(`select app.save_draft(null, $1) as id`, [JSON.stringify({
      partner_id: partnerRow.id, delivery_location_id: locRow.id, delivery_date: '2027-06-01', lines: [{ part_id: p1.id, qty: 1 }], ...payload })]))).rows[0].id;
    if (submit) await as(CREATOR, () => db.query(`select * from app.create_work_order($1)`, [id]));
    return { id, err: null };
  } catch (e) { return { id: null, err: e.message }; }
};
const g1 = await gsmErr({ gsm_required: true, gsm_inner: 120, gsm_outer: 150 }, true);
ok(!g1.err, 'GSM required with Inner and Outer: order is created: ' + g1.err);
const g1row = (await db.query(`select gsm_required, gsm_inner, gsm_outer from app.work_orders where id=$1`, [g1.id])).rows[0];
ok(g1row.gsm_required && Number(g1row.gsm_inner) === 120 && Number(g1row.gsm_outer) === 150, 'GSM figures are stored: ' + JSON.stringify(g1row));
const g2 = await gsmErr({ gsm_required: true, gsm_inner: 120 }, true);
ok(/work_orders_gsm_complete/.test(g2.err || ''), 'GSM required but Outer missing: the order cannot be created: ' + g2.err);
const g3 = await gsmErr({ gsm_required: true, gsm_inner: 120 });
ok(!g3.err, 'an incomplete GSM is fine while it is still a draft');
const g4 = await gsmErr({ gsm_required: false, gsm_inner: 120, gsm_outer: 150 }, true);
const g4row = (await db.query(`select gsm_required, gsm_inner, gsm_outer from app.work_orders where id=$1`, [g4.id])).rows[0];
ok(!g4.err && !g4row.gsm_required && g4row.gsm_inner === null && g4row.gsm_outer === null, 'GSM switched off: any figures are dropped: ' + JSON.stringify(g4row));
const g5 = await gsmErr({ gsm_required: true, gsm_inner: 0, gsm_outer: 150 });
ok(/gsm_inner/.test(g5.err || ''), 'GSM must be above zero: ' + g5.err);

console.log('\nDone.');
