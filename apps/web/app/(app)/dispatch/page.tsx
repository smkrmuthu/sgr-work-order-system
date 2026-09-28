'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';

// Ready for Dispatch = an invoice exists and the goods have not left yet. Marking it dispatched takes it off
// this list; when every ordered unit is billed and every invoice dispatched, the Work Order completes
// (app.mark_invoice_dispatched, db/migrations/010_billing_and_dispatch.sql).

interface InvoiceRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  grand_total: number;
  dispatched_at: string | null;
  work_order: { id: string; wo_number: string | null; delivery_date: string | null; partner: { code: string; name: string } | null } | null;
  invoice_lines: { description: string; qty: number }[];
}

const SELECT = '*, work_order:work_orders(id, wo_number, delivery_date, partner:business_partners(code, name)), invoice_lines(description, qty)';
const inr = (n: number) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function DispatchPage() {
  const { profile } = useAuth();
  const canDispatch = profile?.role === 'md' || profile?.role === 'admin';
  const [waiting, setWaiting] = useState<InvoiceRow[] | null>(null);
  const [done, setDone] = useState<InvoiceRow[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [w, d] = await Promise.all([
      supabase.from('invoices').select(SELECT).is('dispatched_at', null).order('generated_at'),
      supabase.from('invoices').select(SELECT).not('dispatched_at', 'is', null).order('dispatched_at', { ascending: false }).limit(20),
    ]);
    if (w.error) { setError(w.error.message); return; }
    setWaiting((w.data ?? []) as unknown as InvoiceRow[]);
    setDone((d.data ?? []) as unknown as InvoiceRow[]);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function dispatch(r: InvoiceRow) {
    if (!confirm(`Mark invoice ${r.invoice_number} as dispatched?\n\nThis records that the goods have left. It can't be undone.`)) return;
    setBusyId(r.id); setError('');
    const { error } = await supabase.rpc('mark_invoice_dispatched', { p_invoice_id: r.id });
    setBusyId(null);
    if (error) { setError(error.message); return; }
    load();
  }

  const Row = ({ r, showAction }: { r: InvoiceRow; showAction: boolean }) => (
    <tr className="border-t border-kraft-100">
      <td className="px-3 py-2 font-mono font-bold">{r.invoice_number}</td>
      <td className="px-3 py-2">
        {r.work_order && <Link href={`/work-orders/detail?id=${r.work_order.id}`} className="font-mono font-bold text-forest-800 hover:underline">{r.work_order.wo_number}</Link>}
      </td>
      <td className="px-3 py-2">{r.work_order?.partner ? `${r.work_order.partner.code} — ${r.work_order.partner.name}` : '—'}</td>
      <td className="px-3 py-2 text-xs">{r.invoice_lines.map((l) => `${l.description} × ${Number(l.qty)}`).join(', ')}</td>
      <td className="px-3 py-2 text-right font-mono font-bold">{inr(r.grand_total)}</td>
      <td className="px-3 py-2 text-xs text-ink-500">{showAction ? r.invoice_date : r.dispatched_at ? new Date(r.dispatched_at).toLocaleString('en-GB') : ''}</td>
      {showAction && (
        <td className="px-3 py-2 text-right">
          {canDispatch && <button onClick={() => dispatch(r)} disabled={busyId === r.id} className="btn-primary !px-3 !py-1.5">{busyId === r.id ? 'Saving…' : 'Mark Dispatched'}</button>}
        </td>
      )}
    </tr>
  );

  const head = (last: string, action: boolean) => (
    <thead className="bg-kraft-100 text-left text-[11px] font-bold uppercase tracking-wide text-ink-900">
      <tr>
        <th className="px-3 py-2">Invoice</th><th className="px-3 py-2">WO #</th><th className="px-3 py-2">Vendor</th>
        <th className="px-3 py-2">Items</th><th className="px-3 py-2 text-right">Total (incl. GST)</th><th className="px-3 py-2">{last}</th>
        {action && <th className="px-3 py-2" />}
      </tr>
    </thead>
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold text-forest-900">Ready for Dispatch</h1>
        <p className="text-sm text-ink-500">Billed goods waiting to leave. {canDispatch ? 'Mark an invoice dispatched once the goods have left.' : 'MD or Admin marks them dispatched.'}</p>
      </div>
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}

      <div className="overflow-x-auto rounded-lg border border-kraft-200 bg-white">
        <table className="w-full text-sm">
          {head('Invoice date', true)}
          <tbody>
            {waiting === null && <tr><td colSpan={7} className="px-3 py-8 text-center text-ink-500">Loading…</td></tr>}
            {waiting?.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-ink-500">Nothing waiting to be dispatched. Invoices created under Finished Goods appear here.</td></tr>}
            {waiting?.map((r) => <Row key={r.id} r={r} showAction />)}
          </tbody>
        </table>
      </div>

      {done.length > 0 && (
        <>
          <h2 className="mt-2 text-sm font-bold text-forest-900">RECENTLY DISPATCHED</h2>
          <div className="overflow-x-auto rounded-lg border border-kraft-200 bg-white opacity-90">
            <table className="w-full text-sm">
              {head('Dispatched', false)}
              <tbody>{done.map((r) => <Row key={r.id} r={r} showAction={false} />)}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
