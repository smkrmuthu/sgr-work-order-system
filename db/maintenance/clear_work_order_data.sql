-- DANGER — permanent. Deletes every Work Order and everything that hangs off one:
-- lines, notes, revisions, status history, Finance approvals, production, QC submissions and inspections,
-- attachment records, invoices (and their lines), notifications and the audit log. It also RESTARTS the
-- numbering, so the next Work Order is 1/<year> and the next invoice INV/<year>/0001.
--
-- It does NOT touch: users/logins, parts (Item Master), categories, vendors and their addresses/locations,
-- shifts. Run it in the Supabase SQL Editor. All-or-nothing: if any line fails, nothing is deleted.
--
-- Uploaded QC files are not removed by SQL: delete them in Dashboard -> Storage -> qc-attachments.

begin;

delete from app.invoices;            -- also removes invoice_lines
delete from app.work_orders;         -- also removes lines, notes, revisions, status_history, finance_approvals,
                                     -- completion_date_changes, production_*, qc_*, attachments, notifications
delete from app.notifications;
delete from app.audit_events;
delete from app.wo_number_counters;  -- Work Order and invoice numbers start again from 1

commit;

-- Check: the first eight should all be 0, the last four should still hold your master data and logins.
select 'work_orders' as what, count(*) from app.work_orders
union all select 'work_order_lines', count(*) from app.work_order_lines
union all select 'work_order_notes', count(*) from app.work_order_notes
union all select 'invoices', count(*) from app.invoices
union all select 'qc_inspections', count(*) from app.qc_inspections
union all select 'production_entries', count(*) from app.production_entries
union all select 'attachments', count(*) from app.attachments
union all select 'status_history', count(*) from app.status_history
union all select '-- kept: parts', count(*) from app.parts
union all select '-- kept: vendors', count(*) from app.business_partners
union all select '-- kept: users', count(*) from app.users
union all select '-- kept: categories', count(*) from app.categories;
