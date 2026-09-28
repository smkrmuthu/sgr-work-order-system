'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { STATUS_LABEL, STATUS_BADGE_CLASS } from '@/lib/statusLabels';
import type { BusinessPartner, WorkOrder, WorkOrderLine } from '@sgr/types';

// Finished Goods = QC-approved goods that have not been billed yet. The MD/Admin creates the invoice here;
// the goods then move to "Ready for Dispatch". What is billable per line is worked out by the database
// (generate_invoice): QC-approved minus already invoiced — this page shows the same sum so the two agree.

type Order = WorkOrder & { partner?: BusinessPartner | null };
interface BillLine extends WorkOrderLine { approved: number; billed: number; toBill: number }
interface Group { order: Order; lines: BillLine[]; amount: number }

const OPEN_STATUSES = ['in_production', 'qc_pending', 'partially_qc_approved', 'ready_for_dispatch'];
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function FinishedGoodsPage() {
  const { profile } = useAuth();
  const canBill = profile?.role === 'md' || profile?.role === 'admin';
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; invoiceId: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [gst, setGst] = useState<Record<string, string>>({});
  const [supply, setSupply] = useState<Record<string, 'intra' | 'inter'>>({});

  const load = useCallback(async () => {
    const { data: orders, error: e1 } = await supabase
      .from('work_orders').select('*, partner:business_partners(*)').in('status', OPEN_STATUSES).order('created_at');
    if (e1) { setError(e1.message); return; }
    const ids = (orders ?? []).map((o) => o.id);
    if (!ids.length) { setGroups([]); return; }

    const { data: lines } = await supabase.from('work_order_lines').select('*').in('work_order_id', ids).order('line_no');
    const lineIds = (lines ?? []).map((l) => l.id);
    const [{ data: insp }, { data: billed }] = await Promise.all([
      supabase.from('qc_inspections').select('work_order_line_id, accepted_qty').in('work_order_line_id', lineIds),
      supabase.from('invoice_lines').select('work_order_line_id, qty').in('work_order_line_id', lineIds),
    ]);
    const sum = (rows: { work_order_line_id: string | null; [k: string]: unknown }[] | null, key: string, id: string) =>
      (rows ?? []).filter((r) => r.work_order_line_id === id).reduce((n, r) => n + Number(r[key]), 0);

    const out: Group[] = [];
    for (const order of (orders ?? []) as Order[]) {
      const bl: BillLine[] = (lines ?? [])
        .filter((l) => l.work_order_id === order.id)
        .map((l) => {
          const approved = sum(insp, 'accepted_qty', l.id), b = sum(billed, 'qty', l.id);
          return { ...l, approved, billed: b, toBill: approved - b };
        })
        .filter((l) => l.toBill > 0);
      if (bl.length) out.push({ order, lines: bl, amount: bl.reduce((n, l) => n + l.toBill * Number(l.final_price), 0) });
    }
    setGroups(out);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createInvoice(g: Group) {
    const rate = Number(gst[g.order.id] ?? '18'), type = supply[g.order.id] ?? 'intra';
    if (!confirm(`Create an invoice for ${g.order.wo_number}?\n\n${g.lines.length} line(s) · ${inr(g.amount)} before GST @ ${rate}% (${type === 'intra' ? 'CGST + SGST' : 'IGST'}).\n\nThe goods then move to Ready for Dispatch.`)) return;
    setBusyId(g.order.id); setError(''); setNotice(null);
    const { data, error } = await supabase.rpc('generate_invoice', { p_work_order_id: g.order.id, p_gst_rate: rate, p_supply_type: type });
    setBusyId(null);
    if (error) { setError(error.message); return; }
    const { data: inv } = await supabase.from('invoices').select('invoice_number').eq('id', data as string).maybeSingle();
    setNotice({ text: `Invoice ${inv?.invoice_number ?? ''} created for ${g.order.wo_number}. It is now under Ready for Dispatch.`, invoiceId: data as string });
    load();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold text-forest-900">Finished Goods</h1>
        <p className="text-sm text-ink-500">
          QC-approved goods that have not been billed yet. {canBill ? 'Create the invoice against the order.' : 'MD or Admin creates the invoice.'}
        </p>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice.text} <Link href={`/invoice?id=${notice.invoiceId}`} className="font-bold underline">View invoice</Link> · <Link href="/dispatch" className="font-bold underline">Ready for Dispatch →</Link></div>}

      {groups === null && <p className="text-sm text-ink-500">Loading…</p>}
      {groups?.length === 0 && (
        <div className="rounded-lg border border-kraft-200 bg-white px-5 py-10 text-center text-sm text-ink-500">
          Nothing waiting to be billed. Goods appear here once QC approves them.
        </div>
      )}

      {groups?.map((g) => (
        <section key={g.order.id} className="rounded-lg border border-kraft-200 bg-white">
          <div className="flex items-center justify-between border-b border-kraft-100 px-5 py-3">
            <div>
              <Link href={`/work-orders/detail?id=${g.order.id}`} className="font-mono text-sm font-bold text-forest-800 hover:underline">{g.order.wo_number}</Link>
              <div className="text-xs text-ink-500">{g.order.partner ? `${g.order.partner.code} — ${g.order.partner.name}` : '—'} · delivery {g.order.delivery_date ?? '—'}</div>
            </div>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_BADGE_CLASS[g.order.status]}`}>{STATUS_LABEL[g.order.status]}</span>
          </div>
          <div className="overflow-x-auto p-5">
            <table className="w-full text-xs">
              <thead className="bg-kraft-100 text-left font-bold uppercase text-ink-900">
                <tr>
                  <th className="px-2 py-2">Part #</th><th className="px-2 py-2">Description</th><th className="px-2 py-2">Customer Ref</th>
                  <th className="px-2 py-2 text-right">Ordered</th><th className="px-2 py-2 text-right">QC approved</th>
                  <th className="px-2 py-2 text-right">Already billed</th><th className="px-2 py-2 text-right">To bill</th>
                  <th className="px-2 py-2 text-right">Price</th><th className="px-2 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {g.lines.map((l) => (
                  <tr key={l.id} className="border-t border-kraft-100">
                    <td className="px-2 py-2 font-mono font-bold">{l.part_no_snapshot}</td>
                    <td className="px-2 py-2">{l.description_snapshot}</td>
                    <td className="px-2 py-2 font-mono">{l.customer_ref || '—'}</td>
                    <td className="px-2 py-2 text-right font-mono">{l.qty}</td>
                    <td className="px-2 py-2 text-right font-mono">{l.approved}</td>
                    <td className="px-2 py-2 text-right font-mono">{l.billed}</td>
                    <td className="px-2 py-2 text-right font-mono font-bold">{l.toBill}</td>
                    <td className="px-2 py-2 text-right font-mono">{inr(Number(l.final_price))}</td>
                    <td className="px-2 py-2 text-right font-mono font-bold">{inr(l.toBill * Number(l.final_price))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-kraft-300 bg-kraft-50 font-mono text-[11px] font-bold">
                  <td className="px-2 py-2" colSpan={8}>TOTAL BEFORE GST</td>
                  <td className="px-2 py-2 text-right">{inr(g.amount)}</td>
                </tr>
              </tfoot>
            </table>

            {canBill && (
              <div className="mt-4 flex flex-wrap items-end justify-end gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-bold text-ink-700">GST rate</label>
                  <select value={gst[g.order.id] ?? '18'} onChange={(e) => setGst((m) => ({ ...m, [g.order.id]: e.target.value }))} className="input">
                    <option value="18">18%</option><option value="12">12%</option><option value="5">5%</option><option value="0">0%</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-bold text-ink-700">Supply type</label>
                  <select value={supply[g.order.id] ?? 'intra'} onChange={(e) => setSupply((m) => ({ ...m, [g.order.id]: e.target.value as 'intra' | 'inter' }))} className="input">
                    <option value="intra">Intra-State (CGST + SGST)</option><option value="inter">Inter-State (IGST)</option>
                  </select>
                </div>
                <button onClick={() => createInvoice(g)} disabled={busyId === g.order.id} className="btn-primary">
                  {busyId === g.order.id ? 'Creating…' : 'Create Invoice / Bill'}
                </button>
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
