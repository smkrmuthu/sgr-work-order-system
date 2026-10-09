'use client';

import { Suspense, useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { openQcFile } from '@/lib/qcFiles';
import { STATUS_LABEL, STATUS_ORDER, STATUS_BADGE_CLASS } from '@/lib/statusLabels';
import type {
  WorkOrder, WorkOrderLine, BusinessPartner, DeliveryLocation, WorkOrderRevision,
  ProductionOutputLine, QcInspection, Invoice, InvoiceLine, AppUser, FinanceApproval, WorkOrderNote, Attachment, StatusHistoryEntry, SalesPerson,
} from '@sgr/types';

interface LineWithProgress extends WorkOrderLine {
  produced: number;
  qcApproved: number;
  qcHeld: number;
}

// A query-param route (?id=...), not a dynamic segment: Work Order ids only exist once someone
// creates one at runtime, so a statically-exported app (next.config.ts: output "export") can't
// pre-know them at build time the way a /work-orders/[id] path would require.
export default function WorkOrderDetailPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-500">Loading…</p>}>
      <WorkOrderDetail />
    </Suspense>
  );
}

function WorkOrderDetail() {
  const params = useSearchParams();
  const id = params.get('id') ?? '';
  const wantsEdit = params.get('edit') === '1';
  const autoEdited = useRef(false);
  const { profile } = useAuth();
  const isMd = profile?.role === 'md' || profile?.role === 'admin';
  const isFinance = profile?.role === 'finance' || profile?.role === 'md' || profile?.role === 'admin';

  const [wo, setWo] = useState<WorkOrder | null>(null);
  const [partner, setPartner] = useState<BusinessPartner | null>(null);
  const [location, setLocation] = useState<DeliveryLocation | null>(null);
  const [salesPerson, setSalesPerson] = useState<SalesPerson | null>(null);
  const [lines, setLines] = useState<LineWithProgress[]>([]);
  const [revisions, setRevisions] = useState<WorkOrderRevision[]>([]);
  const [financeApprovals, setFinanceApprovals] = useState<FinanceApproval[]>([]);
  const [notes, setNotes] = useState<WorkOrderNote[]>([]);
  const [qcFiles, setQcFiles] = useState<Attachment[]>([]);
  const [history, setHistory] = useState<StatusHistoryEntry[]>([]);
  const [fileError, setFileError] = useState('');
  const [invoices, setInvoices] = useState<(Invoice & { lines: InvoiceLine[] })[]>([]);
  const [users, setUsers] = useState<Record<string, AppUser>>({});
  const [error, setError] = useState('');

  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [financeBusy, setFinanceBusy] = useState(false);

  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);

  const [editing, setEditing] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState('');
  const [docRef, setDocRef] = useState('');
  const [lineEdits, setLineEdits] = useState<Record<string, { qty: string; final_price: string }>>({});
  const [saving, setSaving] = useState(false);

  const [gstRate, setGstRate] = useState('18');
  const [supplyType, setSupplyType] = useState<'intra' | 'inter'>('intra');
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    const { data: w, error: e1 } = await supabase.from('work_orders').select('*').eq('id', id).maybeSingle();
    if (e1) { setError(e1.message); return; }
    if (!w) { setError('Work order not found.'); return; }
    setWo(w);

    const [{ data: p }, { data: loc }, { data: ls }, { data: revs }, { data: fApprovals }, { data: noteRows }, { data: fileRows }, { data: historyRows }, { data: allUsers }, { data: sp }] = await Promise.all([
      w.partner_id ? supabase.from('business_partners').select('*').eq('id', w.partner_id).maybeSingle() : Promise.resolve({ data: null }),
      w.delivery_location_id ? supabase.from('delivery_locations').select('*').eq('id', w.delivery_location_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from('work_order_lines').select('*').eq('work_order_id', id).order('line_no'),
      supabase.from('work_order_revisions').select('*').eq('work_order_id', id).order('revision'),
      supabase.from('finance_approvals').select('*').eq('work_order_id', id).order('created_at'),
      supabase.from('work_order_notes').select('*').eq('work_order_id', id).order('position'),
      supabase.from('attachments').select('*').eq('work_order_id', id).not('qc_inspection_id', 'is', null).order('uploaded_at'),
      supabase.from('status_history').select('*').eq('work_order_id', id).order('changed_at'),
      supabase.from('users').select('*'),
      w.sales_person_id ? supabase.from('sales_persons').select('*').eq('id', w.sales_person_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    setSalesPerson(sp ?? null);
    setPartner(p ?? null);
    setLocation(loc ?? null);
    setRevisions(revs ?? []);
    setFinanceApprovals(fApprovals ?? []);
    setNotes(noteRows ?? []);
    setQcFiles(fileRows ?? []);
    setHistory(historyRows ?? []);
    setUsers(Object.fromEntries((allUsers ?? []).map((u) => [u.id, u])));

    const lineIds = (ls ?? []).map((l) => l.id);
    const [{ data: produced }, { data: inspections }] = await Promise.all([
      lineIds.length ? supabase.from('production_output_lines').select('*').in('work_order_line_id', lineIds) : Promise.resolve({ data: [] as ProductionOutputLine[] }),
      lineIds.length ? supabase.from('qc_inspections').select('*').in('work_order_line_id', lineIds) : Promise.resolve({ data: [] as QcInspection[] }),
    ]);
    const withProgress: LineWithProgress[] = (ls ?? []).map((l) => ({
      ...l,
      produced: (produced ?? []).filter((o) => o.work_order_line_id === l.id).reduce((n, o) => n + Number(o.qty), 0),
      qcApproved: (inspections ?? []).filter((q) => q.work_order_line_id === l.id).reduce((n, q) => n + Number(q.accepted_qty), 0),
      qcHeld: (inspections ?? []).filter((q) => q.work_order_line_id === l.id).reduce((n, q) => n + Number(q.held_qty), 0),
    }));
    setLines(withProgress);
    setLineEdits(Object.fromEntries(withProgress.map((l) => [l.id, { qty: String(l.qty), final_price: String(l.final_price) }])));

    const { data: invs } = await supabase.from('invoices').select('*').eq('work_order_id', id).order('generated_at');
    const withLines = await Promise.all((invs ?? []).map(async (inv) => {
      const { data: il } = await supabase.from('invoice_lines').select('*').eq('invoice_id', inv.id);
      return { ...inv, lines: il ?? [] };
    }));
    setInvoices(withLines);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Arriving from the list's "Edit" link (?edit=1): open the MD's edit mode straight away, once.
  useEffect(() => {
    if (!wantsEdit || !wo || !isMd || autoEdited.current) return;
    const ownerForm = wo.created_by === profile?.id && (wo.status === 'draft' || wo.status === 'pending_finance_approval');
    if (ownerForm) return; // the Creator's full form is offered instead
    autoEdited.current = true;
    startEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsEdit, wo, isMd, profile]);

  function startEdit() {
    if (!wo) return;
    setDeliveryDate(wo.delivery_date ?? '');
    setDocRef(wo.doc_ref ?? '');
    setEditing(true);
  }

  async function saveEdit() {
    if (!wo) return;
    setSaving(true); setError('');
    // Only the lines that actually changed. One call does header + lines together, so a save is exactly one
    // revision (and none if nothing changed) — see app.update_work_order in db/migrations/011.
    const changedLines: { id: string; qty: number; final_price: number }[] = [];
    for (const l of lines) {
      const e = lineEdits[l.id];
      if (!e) continue;
      const qty = Number(e.qty), final_price = Number(e.final_price);
      // A non-numeric qty/price used to turn into JSON null, which the server read as "no change" and
      // silently kept the old value — while the save still reported success. Refuse it here instead.
      if (!Number.isFinite(qty) || !Number.isFinite(final_price)) {
        setSaving(false); setError(`${l.part_no_snapshot}: enter a valid quantity and price.`); return;
      }
      if (qty !== l.qty || final_price !== l.final_price) changedLines.push({ id: l.id, qty, final_price });
    }
    const { error: e1 } = await supabase.rpc('update_work_order', {
      p_work_order_id: wo.id,
      p: { delivery_date: deliveryDate || null, doc_ref: docRef || null, lines: changedLines },
    });
    setSaving(false);
    if (e1) { setError(e1.message); return; }
    setEditing(false);
    load();
  }

  async function generateInvoice() {
    if (!wo) return;
    setGenerating(true); setError('');
    const { error } = await supabase.rpc('generate_invoice', { p_work_order_id: wo.id, p_gst_rate: Number(gstRate), p_supply_type: supplyType });
    setGenerating(false);
    if (error) { setError(error.message); return; }
    load();
  }

  async function approveWo() {
    if (!wo) return;
    setFinanceBusy(true); setError('');
    const { error } = await supabase.rpc('approve_work_order', { p_work_order_id: wo.id, p_comments: null });
    setFinanceBusy(false);
    if (error) { setError(error.message); return; }
    load();
  }

  async function rejectWo() {
    if (!wo || !rejectReason.trim()) { setError('Enter a reason before rejecting.'); return; }
    setFinanceBusy(true); setError('');
    const { error } = await supabase.rpc('reject_work_order', { p_work_order_id: wo.id, p_reason: rejectReason.trim() });
    setFinanceBusy(false);
    if (error) { setError(error.message); return; }
    setRejecting(false); setRejectReason('');
    load();
  }

  async function cancelWo() {
    if (!wo) return;
    setCancelBusy(true); setError('');
    const { error } = await supabase.rpc('cancel_work_order', { p_work_order_id: wo.id, p_reason: cancelReason.trim() || null });
    setCancelBusy(false);
    if (error) { setError(error.message); return; }
    setCancelling(false); setCancelReason('');
    load();
  }

  if (error) return <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  if (!wo) return <p className="text-sm text-ink-500">Loading…</p>;

  // The Creator edits their own order (every field, incl. vendor, parts and notes) on the full form
  // until Finance approves it. That form covers everything the MD's quick inline edit does.
  const ownerCanEditForm = wo.created_by === profile?.id && (wo.status === 'draft' || wo.status === 'pending_finance_approval');

  // QC-approved but not yet invoiced, in units — the same sum the database uses when it creates an invoice.
  const billedByLine = new Map<string, number>();
  for (const inv of invoices) for (const il of inv.lines) if (il.work_order_line_id) billedByLine.set(il.work_order_line_id, (billedByLine.get(il.work_order_line_id) ?? 0) + Number(il.qty));
  const unbilledUnits = lines.reduce((n, l) => n + Math.max(0, l.qcApproved - (billedByLine.get(l.id) ?? 0)), 0);

  const statusIdx = STATUS_ORDER.indexOf(wo.status as any);
  const orderedTotal = lines.reduce((n, l) => n + l.qty, 0);
  const producedTotal = lines.reduce((n, l) => n + l.produced, 0);
  const qcTotal = lines.reduce((n, l) => n + l.qcApproved, 0);
  const finalValue = lines.reduce((n, l) => n + l.qty * l.final_price, 0);

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-kraft-200 bg-white">
        <div className="flex items-center justify-between border-b border-kraft-100 px-5 py-3">
          <div>
            <div className="text-sm font-bold text-forest-900">WORK ORDER <span className="font-mono">{wo.wo_number ?? "(draft)"}</span></div>
            <div className="text-xs text-ink-500">{partner ? `${partner.code} — ${partner.name}` : '—'} · {location?.label ?? '—'}</div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_BADGE_CLASS[wo.status]}`}>{STATUS_LABEL[wo.status]}</span>
            <span className="rounded-full border border-forest-100 bg-forest-50 px-2 py-0.5 font-mono text-[11px] font-bold text-forest-800">REVISION R{wo.revision}</span>
          </div>
        </div>
        <div className="p-5">
          <div className="mb-4 flex flex-wrap items-center gap-0 overflow-x-auto">
            {STATUS_ORDER.map((s, i) => (
              <div key={s} className="flex items-center gap-1">
                <div className={`flex items-center gap-1.5 text-[10px] font-bold ${i <= statusIdx ? 'text-forest-800' : 'text-ink-300'}`}>
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full ${i <= statusIdx ? 'bg-forest-600 text-white' : 'bg-ink-100 text-ink-500'}`}>{i + 1}</span>
                  {STATUS_LABEL[s]}
                </div>
                {i < STATUS_ORDER.length - 1 && <div className={`h-0.5 w-6 ${i < statusIdx ? 'bg-forest-500' : 'bg-ink-100'}`} />}
              </div>
            ))}
          </div>

          {!editing ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Info label="WO Date" value={wo.wo_date} />
              <Info label="Delivery Date" value={wo.delivery_date ?? '—'} />
              <Info label="Expected Completion" value={wo.expected_completion_date ?? '—'} hint="Planner sets this" />
              <Info label="Document Ref" value={wo.doc_ref ?? '—'} />
              <Info label="Sales Person" value={salesPerson ? `${salesPerson.name}${salesPerson.phone ? ` · ${salesPerson.phone}` : ''}` : '—'} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Delivery Date"><input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} className="input" /></Field>
              <Field label="Document Reference"><input value={docRef} onChange={(e) => setDocRef(e.target.value)} className="input" /></Field>
              <Info label="Expected Completion" value={wo.expected_completion_date ?? '—'} hint="Planner sets this" />
              <Info label="Vendor / Location" value={`${partner?.code ?? ''} · ${location?.label ?? ''}`} hint="Fixed after creation" />
            </div>
          )}

          {isFinance && wo.status === 'pending_finance_approval' && (
            <div className="mt-4 rounded-md border border-violet-200 bg-violet-50 p-4">
              <div className="mb-2 text-sm font-bold text-violet-900">Awaiting Finance Approval</div>
              <p className="mb-3 text-xs text-violet-800">
                Production cannot start until this Work Order is approved. Rejecting sends it back to
                the Creator as an editable draft with your reason attached.
              </p>
              {!rejecting ? (
                <div className="flex gap-2">
                  <button onClick={approveWo} disabled={financeBusy} className="btn-primary">{financeBusy ? 'Working…' : 'Approve'}</button>
                  <button onClick={() => setRejecting(true)} className="btn-secondary">Reject</button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Reason for rejection…"
                    className="input flex-1"
                  />
                  <button onClick={rejectWo} disabled={financeBusy} className="btn-primary">{financeBusy ? 'Working…' : 'Confirm Reject'}</button>
                  <button onClick={() => { setRejecting(false); setRejectReason(''); }} className="btn-secondary">Cancel</button>
                </div>
              )}
            </div>
          )}

          {ownerCanEditForm && (
            <div className="mt-4 flex justify-end">
              <Link href={`/work-orders/new?id=${wo.id}`} className="btn-primary">
                {wo.status === 'draft' ? 'Edit & Resubmit' : 'Edit Work Order'}
              </Link>
            </div>
          )}

          {isMd && !ownerCanEditForm && (
            <div className="mt-4 flex justify-end gap-2">
              {!editing ? (
                <button onClick={startEdit} className="btn-secondary">Edit Work Order</button>
              ) : (
                <>
                  <button onClick={() => setEditing(false)} className="btn-secondary">Cancel</button>
                  <button onClick={saveEdit} disabled={saving} className="btn-primary">{saving ? 'Saving…' : `Save Changes — creates R${wo.revision + 1}`}</button>
                </>
              )}
            </div>
          )}

          {/* Restored by db/migrations/012_review_fixes.sql (app.cancel_work_order) — matches that
              function's own guard: not once completed, and not twice. */}
          {isMd && wo.status !== 'completed' && wo.status !== 'cancelled' && (
            <div className="mt-3 flex justify-end">
              {!cancelling ? (
                <button onClick={() => setCancelling(true)} className="text-xs font-bold text-rose-700 hover:underline">
                  Cancel Work Order
                </button>
              ) : (
                <div className="w-full rounded-md border border-rose-200 bg-rose-50 p-3">
                  <p className="mb-2 text-xs text-rose-800">
                    This stops the order permanently — it can&apos;t be un-cancelled. Say why, for the record.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      placeholder="Reason for cancelling…"
                      className="input flex-1"
                    />
                    <button
                      onClick={() => { if (confirm(`Cancel Work Order ${wo.wo_number ?? ''}? This can't be undone.`)) cancelWo(); }}
                      disabled={cancelBusy}
                      className="whitespace-nowrap rounded-md bg-rose-700 px-4 py-2 text-xs font-bold text-white hover:bg-rose-800 disabled:opacity-50"
                    >
                      {cancelBusy ? 'Cancelling…' : 'Confirm Cancel'}
                    </button>
                    <button onClick={() => { setCancelling(false); setCancelReason(''); }} className="btn-secondary">Back</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-kraft-200 bg-white">
        <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">LINE ITEMS &amp; PRODUCTION PROGRESS</div>
        <div className="overflow-x-auto p-5">
          <table className="w-full text-xs">
            <thead className="bg-kraft-100 text-left font-bold uppercase text-ink-900">
              <tr>
                <th className="px-2 py-2">Part #</th><th className="px-2 py-2">Description</th><th className="px-2 py-2">Customer Ref</th>
                <th className="px-2 py-2">Ordered</th><th className="px-2 py-2">Produced</th>
                <th className="px-2 py-2">QC Approved</th><th className="px-2 py-2">Std Price</th>
                <th className="px-2 py-2">Final Price</th><th className="px-2 py-2">Line Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t border-kraft-100">
                  <td className="px-2 py-2 font-mono font-bold">{l.part_no_snapshot}</td>
                  <td className="px-2 py-2">{l.description_snapshot}</td>
                  <td className="px-2 py-2 font-mono">{l.customer_ref || '—'}</td>
                  <td className="px-2 py-2 font-mono">
                    {editing && isMd ? (
                      <input value={lineEdits[l.id]?.qty ?? ''} onChange={(e) => setLineEdits((s) => ({ ...s, [l.id]: { ...s[l.id]!, qty: e.target.value } }))} className="input w-20 !py-1" />
                    ) : l.qty}
                  </td>
                  <td className="px-2 py-2 font-mono">{l.produced} / {l.qty}</td>
                  <td className="px-2 py-2 font-mono">{l.qcApproved} / {l.qty}{l.qcHeld > 0 && <span className="ml-1 rounded-full bg-amber-100 px-1.5 text-amber-800">{l.qcHeld} held</span>}</td>
                  <td className="px-2 py-2 font-mono">₹{l.standard_price_snapshot.toFixed(2)}</td>
                  <td className="px-2 py-2 font-mono">
                    {editing && isMd ? (
                      <input value={lineEdits[l.id]?.final_price ?? ''} onChange={(e) => setLineEdits((s) => ({ ...s, [l.id]: { ...s[l.id]!, final_price: e.target.value } }))} className="input w-24 !py-1" />
                    ) : `₹${l.final_price.toFixed(2)}`}
                  </td>
                  <td className="px-2 py-2 font-mono font-bold">₹{(l.qty * l.final_price).toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-kraft-300 bg-kraft-50 font-mono text-[11px] font-bold">
                <td className="px-2 py-2" colSpan={3}>TOTALS</td>
                <td className="px-2 py-2">{orderedTotal}</td>
                <td className="px-2 py-2">{producedTotal}</td>
                <td className="px-2 py-2">{qcTotal}</td>
                <td colSpan={2} />
                <td className="px-2 py-2">₹{finalValue.toLocaleString('en-IN')}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {qcFiles.length > 0 && (
        <section className="rounded-lg border border-kraft-200 bg-white">
          <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">QC INSPECTION FILES</div>
          <div className="p-5">
            {fileError && <p className="mb-2 text-xs text-rose-700">{fileError}</p>}
            <ul className="flex flex-col gap-1.5">
              {qcFiles.map((f) => (
                <li key={f.id} className="flex items-center justify-between rounded-md border border-kraft-200 bg-kraft-50 px-3 py-1.5 text-[13px]">
                  <span className="min-w-0 truncate">
                    {f.file_name}
                    <span className="ml-2 text-[11px] text-ink-500">
                      {users[f.uploaded_by ?? '']?.email ?? '—'} · {new Date(f.uploaded_at).toLocaleString('en-GB')}
                    </span>
                  </span>
                  <button
                    onClick={async () => setFileError((await openQcFile(f.storage_key)) ?? '')}
                    className="ml-3 shrink-0 rounded-md border border-kraft-300 bg-white px-2.5 py-1 text-[11px] font-bold text-forest-800 hover:bg-kraft-50"
                  >
                    Open
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {notes.length > 0 && (
        <section className="rounded-lg border border-kraft-200 bg-white">
          <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">NOTES</div>
          <ol className="flex flex-col gap-1.5 p-5">
            {notes.map((n, i) => (
              <li key={n.id} className="flex items-start gap-2 text-[13px]">
                <span className="mt-px font-mono text-[11px] font-bold text-ink-500">{i + 1}.</span>
                <span className="break-words">{n.note}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {financeApprovals.length > 0 && (
        <section className="rounded-lg border border-kraft-200 bg-white">
          <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">FINANCE APPROVAL HISTORY</div>
          <div className="p-5">
            {financeApprovals.map((f) => (
              <div key={f.id} className="border-b border-kraft-100 py-2 text-xs last:border-none">
                <div className="font-bold">
                  {f.action === 'approved' ? 'Approved' : 'Rejected'}
                  {f.comments && <span className="font-normal text-ink-700"> — {f.comments}</span>}
                </div>
                <div className="text-ink-500">{users[f.actor ?? '']?.email ?? f.actor} · {new Date(f.created_at).toLocaleString('en-GB')}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="rounded-lg border border-kraft-200 bg-white">
          <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">STATUS HISTORY</div>
          <ol className="p-5">
            {history.map((h) => (
              <li key={h.id} className="border-b border-kraft-100 py-2 text-xs last:border-none">
                <div className="font-bold">
                  {h.from_status ? STATUS_LABEL[h.from_status] : 'New'} → {STATUS_LABEL[h.to_status]}
                </div>
                <div className="text-ink-500">
                  {users[h.changed_by ?? '']?.email ?? 'system'} · {new Date(h.changed_at).toLocaleString('en-GB')}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="rounded-lg border border-kraft-200 bg-white">
        <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">REVISION &amp; AUDIT HISTORY</div>
        <div className="p-5">
          {revisions.length === 0 && <p className="text-xs text-ink-500">No edits yet — still at R0.</p>}
          {revisions.map((r) => (
            <div key={r.id} className="border-b border-kraft-100 py-2 text-xs last:border-none">
              <div className="font-bold">R{r.revision} snapshot preserved before an MD edit</div>
              <div className="text-ink-500">{users[r.changed_by ?? '']?.email ?? r.changed_by} · {new Date(r.changed_at).toLocaleString('en-GB')}</div>
            </div>
          ))}
        </div>
      </section>

      {(invoices.length > 0 || isMd) && (
        <section className="rounded-lg border border-kraft-200 bg-white">
          <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">INVOICES</div>

          {invoices.length > 0 && (
            <ul className="flex flex-col gap-1.5 p-5">
              {invoices.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between rounded-md border border-kraft-200 bg-kraft-50 px-3 py-2 text-[13px]">
                  <span>
                    <span className="font-mono font-bold">{inv.invoice_number}</span>
                    <span className="ml-3 text-ink-500">{new Date(inv.invoice_date).toLocaleDateString('en-GB')}</span>
                    <span className="ml-3 font-mono font-bold">₹{Number(inv.grand_total).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    <span className={`ml-3 rounded-full border px-2 py-0.5 text-[10px] font-bold ${inv.dispatched_at ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-blue-200 bg-blue-50 text-blue-800'}`}>
                      {inv.dispatched_at ? 'Dispatched' : 'Ready for dispatch'}
                    </span>
                  </span>
                  <Link href={`/invoice?id=${inv.id}`} className="rounded-md border border-kraft-300 bg-white px-2.5 py-1 text-[11px] font-bold text-forest-800 hover:bg-kraft-50">View / Print</Link>
                </li>
              ))}
            </ul>
          )}

          {/* Creating another invoice: only when QC-approved goods are still unbilled (same rule as Finished Goods). */}
          {isMd && (
            <div className={`p-5 ${invoices.length > 0 ? 'border-t border-kraft-100' : ''}`}>
              {unbilledUnits > 0 ? (
                <>
                  <p className="mb-3 text-xs text-ink-700">
                    <b>{unbilledUnits}</b> QC-approved unit(s) have not been billed yet. This creates one invoice for them.
                  </p>
                  <div className="flex flex-wrap items-end gap-3">
                    <Field label="GST Rate">
                      <select value={gstRate} onChange={(e) => setGstRate(e.target.value)} className="input">
                        <option value="18">18%</option><option value="12">12%</option><option value="5">5%</option><option value="0">0%</option>
                      </select>
                    </Field>
                    <Field label="Supply Type">
                      <select value={supplyType} onChange={(e) => setSupplyType(e.target.value as any)} className="input">
                        <option value="intra">Intra-State (CGST+SGST)</option><option value="inter">Inter-State (IGST)</option>
                      </select>
                    </Field>
                    <button onClick={generateInvoice} disabled={generating} className="btn-primary">{generating ? 'Generating…' : 'Create Invoice'}</button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-ink-500">
                  {invoices.length > 0 ? 'Everything QC has approved so far has been invoiced.' : 'Nothing to bill yet — invoices can be created once QC approves goods.'}
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Info({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-ink-500">{label}</div>
      <div className="text-sm font-bold">{value}</div>
      {hint && <div className="text-[10px] text-ink-300">{hint}</div>}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-bold text-ink-700">{label}</label>
      {children}
    </div>
  );
}
