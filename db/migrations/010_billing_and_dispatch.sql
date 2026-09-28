-- 010: billing against finished goods, and dispatch. Safe to re-run.
--
--   Finished Goods       QC-approved quantity that has not been billed yet  -> MD/Admin creates the invoice
--   Ready for Dispatch   an invoice that exists but has not left the gate    -> MD/Admin marks it dispatched
--
-- (1) generate_invoice now bills only what is QC-approved AND not already billed, per line. Before this it
--     billed the whole QC-approved quantity every time it ran, so a second click billed the same goods again,
--     and it fell back to the ORDERED quantity when nothing was approved, i.e. it could bill goods that had not
--     passed QC. Finished goods means QC-approved goods, so that fallback is gone.
-- (2) Each invoice records when it was dispatched, and when every ordered unit has been billed and every
--     invoice dispatched, the Work Order is completed.

alter table app.invoices add column if not exists dispatched_at timestamptz;
alter table app.invoices add column if not exists dispatched_by uuid references app.users(id);
create index if not exists invoices_undispatched_idx on app.invoices (work_order_id) where dispatched_at is null;

-- ---------------------------------------------------------------- create an invoice for what is ready to bill
create or replace function app.generate_invoice(p_work_order_id uuid, p_gst_rate numeric, p_supply_type app.supply_type)
returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_invoice_id uuid;
  v_number text;
  v_subtotal numeric := 0;
  v_line record;
  v_amount numeric;
  v_cgst numeric := 0; v_sgst numeric := 0; v_igst numeric := 0; v_total numeric;
  v_seq int;
  v_status app.wo_status;
  v_billable_lines int;
begin
  if not app.current_role_in('md', 'admin') then raise exception 'Only MD may generate an invoice.'; end if;

  select status into v_status from app.work_orders where id = p_work_order_id for update;   -- serialises two people billing at once
  if v_status is null then raise exception 'Work order % not found', p_work_order_id; end if;
  if v_status in ('draft', 'pending_finance_approval', 'cancelled') then
    raise exception 'Cannot generate an invoice before this Work Order is created and approved by Finance.';
  end if;

  -- What is ready to bill, per line: QC-approved minus already invoiced (only lines with something left).
  -- Counted first, so a refused request never takes an invoice number.
  select count(*) into v_billable_lines
  from app.work_order_lines l
  where coalesce((select sum(i.accepted_qty) from app.qc_inspections i where i.work_order_line_id = l.id), 0)
      - coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = l.id), 0) > 0
    and l.work_order_id = p_work_order_id;
  if v_billable_lines = 0 then
    raise exception 'Nothing is ready to bill: every QC-approved unit on this order has already been invoiced (or none has been approved yet).';
  end if;

  -- (the invoice number is taken only after the checks, so a refused request never burns a number)
  insert into app.wo_number_counters (fiscal_year_start, next_number) values (-1, 2)
  on conflict (fiscal_year_start) do update set next_number = app.wo_number_counters.next_number + 1
  returning next_number - 1 into v_seq;
  v_number := 'INV/' || app.fiscal_year_label(current_date) || '/' || lpad(v_seq::text, 4, '0');

  insert into app.invoices (work_order_id, invoice_number, gst_rate, supply_type, subtotal, grand_total)
  values (p_work_order_id, v_number, p_gst_rate, p_supply_type, 0, 0) returning id into v_invoice_id;

  for v_line in
    select l.id as work_order_line_id, l.description_snapshot as description, l.final_price as price,
           coalesce((select sum(i.accepted_qty) from app.qc_inspections i where i.work_order_line_id = l.id), 0)
             - coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = l.id), 0) as qty
    from app.work_order_lines l where l.work_order_id = p_work_order_id order by l.line_no
  loop
    continue when v_line.qty <= 0;
    v_amount := v_line.qty * v_line.price;
    v_subtotal := v_subtotal + v_amount;
    insert into app.invoice_lines (invoice_id, work_order_line_id, description, qty, price, amount)
    values (v_invoice_id, v_line.work_order_line_id, v_line.description, v_line.qty, v_line.price, v_amount);
  end loop;

  if p_supply_type = 'intra' then
    v_cgst := round(v_subtotal * p_gst_rate / 200, 2); v_sgst := v_cgst;
  else
    v_igst := round(v_subtotal * p_gst_rate / 100, 2);
  end if;
  v_total := v_subtotal + v_cgst + v_sgst + v_igst;

  update app.invoices set subtotal = v_subtotal, cgst = v_cgst, sgst = v_sgst, igst = v_igst,
                          grand_total = v_total, generated_by = auth.uid()
  where id = v_invoice_id;

  return v_invoice_id;
end $$;

-- ---------------------------------------------------------------- the goods have left
create or replace function app.mark_invoice_dispatched(p_invoice_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_wo uuid;
  v_dispatched timestamptz;
  v_all_billed boolean;
  v_open int;
begin
  if not app.current_role_in('md', 'admin') then raise exception 'Only MD may mark an invoice as dispatched.'; end if;

  select work_order_id, dispatched_at into v_wo, v_dispatched from app.invoices where id = p_invoice_id for update;
  if v_wo is null then raise exception 'Invoice not found.'; end if;
  if v_dispatched is not null then raise exception 'This invoice has already been dispatched.'; end if;

  update app.invoices set dispatched_at = now(), dispatched_by = auth.uid() where id = p_invoice_id;

  -- Fully billed (every ordered unit invoiced) and nothing left waiting at the gate -> the order is done.
  select coalesce(bool_and(coalesce(b.q, 0) >= l.qty), false) into v_all_billed
  from app.work_order_lines l
  left join (select work_order_line_id, sum(qty) q from app.invoice_lines group by work_order_line_id) b
         on b.work_order_line_id = l.id
  where l.work_order_id = v_wo;
  select count(*) into v_open from app.invoices where work_order_id = v_wo and dispatched_at is null;

  if v_all_billed and v_open = 0 then
    perform set_config('app.bypass_edit_check', 'true', true);
    update app.work_orders set status = 'completed', updated_by = auth.uid(), updated_at = now()
     where id = v_wo and status <> 'completed';
  end if;
end $$;

revoke execute on function app.generate_invoice(uuid, numeric, app.supply_type) from public, anon;
grant execute on function app.generate_invoice(uuid, numeric, app.supply_type) to authenticated;
revoke execute on function app.mark_invoice_dispatched(uuid) from public, anon;
grant execute on function app.mark_invoice_dispatched(uuid) to authenticated;
grant execute on function app.generate_invoice(uuid, numeric, app.supply_type) to service_role;
grant execute on function app.mark_invoice_dispatched(uuid) to service_role;
