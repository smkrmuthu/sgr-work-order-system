-- 021: Sales Order file(s) on a Work Order (PDF or JPG), and Delivery Date compulsory in the database.
--
-- Sales order files
--   * Bytes live in a PRIVATE Storage bucket, `sales-order-files` (PDF and JPEG only, 10 MB each); one
--     app.attachments row per file records the Work Order, original name and storage path, with kind = 'sales_order'.
--   * A sales order carries the customer's prices, so only Creator, MD, Admin and Finance can see these rows or open
--     the files (Planner and QC cannot — the same rule as Customer Price, 018). Enforced by RLS, not just the screen.
--   * Added by the order's Creator while it is still a draft / waiting for Finance, or by MD/Admin. The same people
--     may remove one (a wrong upload); once Finance has approved, only MD/Admin can.
-- Delivery Date
--   * create_work_order already refused a draft without one (003/012); this adds a table-level rule so no other path
--     (e.g. the MD edit) can clear it from a created order either.
alter table app.attachments add column if not exists kind text not null default 'qc';
alter table app.attachments drop constraint if exists attachments_kind_check;
alter table app.attachments add constraint attachments_kind_check check (kind in ('qc', 'sales_order'));
alter table app.attachments drop constraint if exists attachments_sales_order_shape;
alter table app.attachments add constraint attachments_sales_order_shape
  check (kind <> 'sales_order' or (qc_inspection_id is null and work_order_id is not null));

-- who may see / add / remove attachment rows
drop policy if exists attachments_select on app.attachments;
create policy attachments_select on app.attachments for select to authenticated
  using (kind = 'qc' or app.current_role_in('creator', 'md', 'admin', 'finance'));

drop policy if exists attachments_write on app.attachments;
create policy attachments_write on app.attachments for insert to authenticated
  with check (
    (kind = 'qc' and (
        app.current_role_in('qc', 'md', 'admin')
        or (qc_inspection_id is null and app.current_role_in('creator', 'planner'))))
    or (kind = 'sales_order' and qc_inspection_id is null and work_order_id is not null and (
        app.current_role_in('md', 'admin')
        or (app.current_role_in('creator') and exists (
              select 1 from app.work_orders w
              where w.id = attachments.work_order_id and w.created_by = auth.uid()
                and w.status in ('draft', 'pending_finance_approval')))))
  );

drop policy if exists attachments_delete on app.attachments;
create policy attachments_delete on app.attachments for delete to authenticated
  using (
    kind = 'sales_order' and (
      app.current_role_in('md', 'admin')
      or (app.current_role_in('creator') and exists (
            select 1 from app.work_orders w
            where w.id = attachments.work_order_id and w.created_by = auth.uid()
              and w.status in ('draft', 'pending_finance_approval'))))
  );

-- the storage bucket + its rules (skipped where Supabase Storage doesn't exist, as in 009)
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present — skipping the sales-order-files bucket';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('sales-order-files', 'sales-order-files', false, 10485760, array['application/pdf', 'image/jpeg'])
  on conflict (id) do update
    set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists sales_files_read on storage.objects';
  execute $p$create policy sales_files_read on storage.objects for select to authenticated
             using (bucket_id = 'sales-order-files' and app.current_role_in('creator', 'md', 'admin', 'finance'))$p$;

  -- the first folder of the path is the Work Order id
  execute 'drop policy if exists sales_files_upload on storage.objects';
  execute $p$create policy sales_files_upload on storage.objects for insert to authenticated
             with check (bucket_id = 'sales-order-files' and (
               app.current_role_in('md', 'admin')
               or (app.current_role_in('creator') and exists (
                     select 1 from app.work_orders w
                     where w.id::text = split_part(storage.objects.name, '/', 1) and w.created_by = auth.uid()
                       and w.status in ('draft', 'pending_finance_approval')))))$p$;

  execute 'drop policy if exists sales_files_delete on storage.objects';
  execute $p$create policy sales_files_delete on storage.objects for delete to authenticated
             using (bucket_id = 'sales-order-files' and (
               app.current_role_in('md', 'admin')
               or (app.current_role_in('creator') and exists (
                     select 1 from app.work_orders w
                     where w.id::text = split_part(storage.objects.name, '/', 1) and w.created_by = auth.uid()
                       and w.status in ('draft', 'pending_finance_approval')))))$p$;
end $$;

-- Delivery Date: required on every order that has left draft
alter table app.work_orders drop constraint if exists work_orders_delivery_date_required;
alter table app.work_orders add constraint work_orders_delivery_date_required
  check (status = 'draft' or delivery_date is not null);

notify pgrst, 'reload schema';
