-- 028: Delivery Challan replaces the Invoice in the app.
--
-- Finished Goods now creates a DELIVERY CHALLAN: a numbered dispatch document with quantities only (no prices, no
-- GST). It does exactly what the invoice did for the workflow: it takes the QC-accepted units that are not yet on a
-- document (so a unit can never be sent twice), it moves them to Ready for Dispatch, and once everything still
-- required is on a challan and dispatched the order completes (mark_invoice_dispatched, unchanged).
--
--  * Challans live in the same tables as invoices (app.invoices / app.invoice_lines) so counting, dispatch and
--    completion keep working; `kind` tells them apart. Existing invoices keep kind 'invoice' and stay viewable.
--  * The value of the goods (qty x order price, no tax) is still recorded on the challan for the MD's dashboard, but
--    the challan itself never shows a price; Production and QC logins see no price anywhere in the app.
--  * Challan numbers are DC/<fiscal year>/<0001...>, a separate sequence from the old INV/... numbers.
--  * Creating a tax invoice from the app is switched off: generate_invoice can no longer be called by signed-in users.
alter table app.invoices add column if not exists kind text not null default 'invoice';
alter table app.invoices drop constraint if exists invoices_kind_check;
alter table app.invoices add constraint invoices_kind_check check (kind in ('invoice', 'challan'));

create or replace function app.generate_challan(p_work_order_id uuid) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid;
  v_number text;
  v_value numeric := 0;
  v_line record;
  v_seq int;
  v_status app.wo_status;
  v_deliverable_lines int;
begin
  if not app.current_role_in('md', 'admin') then raise exception 'Only MD or Admin may create a delivery challan.'; end if;

  select status into v_status from app.work_orders where id = p_work_order_id for update;   -- serialises two people at once
  if v_status is null then raise exception 'Work order % not found', p_work_order_id; end if;
  if v_status in ('draft', 'pending_finance_approval', 'cancelled') then
    raise exception 'Cannot create a delivery challan before this Work Order is created and approved by Finance.';
  end if;

  -- What is ready to go, per line: QC-approved minus what is already on a challan/invoice. Counted first, so a
  -- refused request never takes a number.
  select count(*) into v_deliverable_lines
  from app.work_order_lines l
  where coalesce((select sum(i.accepted_qty) from app.qc_inspections i where i.work_order_line_id = l.id), 0)
      - coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = l.id), 0) > 0
    and l.work_order_id = p_work_order_id;
  if v_deliverable_lines = 0 then
    raise exception 'Nothing is ready to deliver: every QC-approved unit on this order is already on a delivery challan (or none has been approved yet).';
  end if;

  insert into app.wo_number_counters (fiscal_year_start, next_number) values (-2, 2)
  on conflict (fiscal_year_start) do update set next_number = app.wo_number_counters.next_number + 1
  returning next_number - 1 into v_seq;
  v_number := 'DC/' || app.fiscal_year_label(current_date) || '/' || lpad(v_seq::text, 4, '0');

  insert into app.invoices (work_order_id, invoice_number, kind, gst_rate, supply_type, subtotal, grand_total)
  values (p_work_order_id, v_number, 'challan', 0, 'intra', 0, 0) returning id into v_id;

  for v_line in
    select l.id as work_order_line_id, l.description_snapshot as description, l.final_price as price,
           coalesce((select sum(i.accepted_qty) from app.qc_inspections i where i.work_order_line_id = l.id), 0)
             - coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = l.id), 0) as qty
    from app.work_order_lines l where l.work_order_id = p_work_order_id order by l.line_no
  loop
    continue when v_line.qty <= 0;
    v_value := v_value + v_line.qty * v_line.price;
    insert into app.invoice_lines (invoice_id, work_order_line_id, description, qty, price, amount)
    values (v_id, v_line.work_order_line_id, v_line.description, v_line.qty, v_line.price, v_line.qty * v_line.price);
  end loop;

  -- no tax on a challan: the recorded value is just the goods at the order price
  update app.invoices set subtotal = v_value, grand_total = v_value, generated_by = auth.uid() where id = v_id;
  return v_id;
end $$;

revoke execute on function app.generate_challan(uuid) from public, anon;
grant execute on function app.generate_challan(uuid) to authenticated;
grant execute on function app.generate_challan(uuid) to service_role;

-- The app no longer raises tax invoices. (Kept for the service role, e.g. for reference or a later billing module.)
revoke execute on function app.generate_invoice(uuid, numeric, app.supply_type) from authenticated;

notify pgrst, 'reload schema';
