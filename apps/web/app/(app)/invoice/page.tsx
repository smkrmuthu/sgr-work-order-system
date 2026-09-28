'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { COMPANY } from '@/lib/company';
import { rupeesInWords } from '@/lib/rupees';
import type { Invoice } from '@sgr/types';

// A printable tax invoice (Print -> "Save as PDF" gives a PDF). A query-param route (?id=...), for the same
// reason as the Work Order page: invoice ids only exist at runtime, and this is a static export.

interface Line { id: string; description: string; qty: number; price: number; amount: number;
  work_order_line: { part_no_snapshot: string; uom_snapshot: string; customer_ref: string | null } | null }
type Full = Invoice & {
  invoice_lines: Line[];
  work_order: { id: string; wo_number: string | null; doc_ref: string | null; wo_date: string; delivery_date: string | null;
    partner: { code: string; name: string; gstin: string | null } | null; location: { label: string } | null } | null;
};

const money = (n: number) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function InvoicePage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-500">Loading…</p>}>
      <InvoiceView />
    </Suspense>
  );
}

function InvoiceView() {
  const id = useSearchParams().get('id') ?? '';
  const [inv, setInv] = useState<Full | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('invoices')
        .select(`*, invoice_lines(id, description, qty, price, amount, work_order_line:work_order_lines(part_no_snapshot, uom_snapshot, customer_ref)),
                 work_order:work_orders(id, wo_number, doc_ref, wo_date, delivery_date, partner:business_partners(code, name, gstin), location:delivery_locations(label))`)
        .eq('id', id).maybeSingle();
      if (error) { setError(error.message); return; }
      if (!data) { setError('Invoice not found.'); return; }
      setInv(data as unknown as Full);
    })();
  }, [id]);

  if (error) return <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  if (!inv) return <p className="text-sm text-ink-500">Loading…</p>;

  const wo = inv.work_order;
  const tax = Number(inv.cgst) + Number(inv.sgst) + Number(inv.igst);
  const half = Number(inv.gst_rate) / 2;

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex items-center justify-between">
        {wo ? <Link href={`/work-orders/detail?id=${wo.id}`} className="text-sm font-bold text-forest-800 hover:underline">← Work Order {wo.wo_number}</Link> : <span />}
        <button onClick={() => window.print()} className="btn-primary">Print / Save as PDF</button>
      </div>

      <article className="mx-auto w-full max-w-4xl rounded-lg border border-kraft-200 bg-white p-8 text-[13px] print:border-0 print:p-0">
        <header className="flex items-start justify-between border-b-2 border-forest-900 pb-4">
          <div>
            <div className="text-lg font-bold text-forest-900">{COMPANY.name}</div>
            {COMPANY.address && <div className="max-w-xs text-xs text-ink-700">{COMPANY.address}</div>}
            {COMPANY.gstin && <div className="text-xs">GSTIN: <span className="font-mono">{COMPANY.gstin}</span></div>}
            {(COMPANY.phone || COMPANY.email) && <div className="text-xs text-ink-700">{[COMPANY.phone, COMPANY.email].filter(Boolean).join(' · ')}</div>}
          </div>
          <div className="text-right">
            <div className="text-xl font-bold tracking-wide text-forest-900">TAX INVOICE</div>
            <div className="font-mono text-sm font-bold">{inv.invoice_number}</div>
            <div className="text-xs text-ink-700">Date: {new Date(inv.invoice_date).toLocaleDateString('en-GB')}</div>
          </div>
        </header>

        <section className="mt-4 grid grid-cols-2 gap-6">
          <div>
            <div className="text-[11px] font-bold uppercase text-ink-500">Billed to</div>
            <div className="font-bold">{wo?.partner?.name ?? '—'}</div>
            <div className="text-xs text-ink-700">Vendor code {wo?.partner?.code}</div>
            {wo?.partner?.gstin && <div className="text-xs">GSTIN: <span className="font-mono">{wo.partner.gstin}</span></div>}
            {wo?.location && <div className="mt-1 text-xs text-ink-700">Deliver to: {wo.location.label}</div>}
          </div>
          <div className="text-xs">
            <div className="flex justify-between"><span className="text-ink-500">Work Order</span><span className="font-mono font-bold">{wo?.wo_number}</span></div>
            {wo?.doc_ref && <div className="flex justify-between"><span className="text-ink-500">Document ref</span><span className="font-mono">{wo.doc_ref}</span></div>}
            <div className="flex justify-between"><span className="text-ink-500">Supply</span><span>{inv.supply_type === 'intra' ? 'Intra-State (CGST + SGST)' : 'Inter-State (IGST)'}</span></div>
          </div>
        </section>

        <table className="mt-5 w-full text-xs">
          <thead className="bg-kraft-100 text-left font-bold uppercase">
            <tr>
              <th className="px-2 py-2">#</th><th className="px-2 py-2">Item</th><th className="px-2 py-2">Customer Ref</th>
              <th className="px-2 py-2 text-right">Qty</th><th className="px-2 py-2 text-right">Rate</th><th className="px-2 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.invoice_lines.map((l, i) => (
              <tr key={l.id} className="border-b border-kraft-100">
                <td className="px-2 py-2">{i + 1}</td>
                <td className="px-2 py-2"><div className="font-bold">{l.description}</div><div className="font-mono text-[11px] text-ink-500">{l.work_order_line?.part_no_snapshot}</div></td>
                <td className="px-2 py-2 font-mono">{l.work_order_line?.customer_ref || '—'}</td>
                <td className="px-2 py-2 text-right font-mono">{Number(l.qty)} {l.work_order_line?.uom_snapshot}</td>
                <td className="px-2 py-2 text-right font-mono">{money(l.price)}</td>
                <td className="px-2 py-2 text-right font-mono font-bold">{money(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 ml-auto w-72 text-xs">
          <Row label="Sub-total" value={money(inv.subtotal)} />
          {inv.supply_type === 'intra' ? (
            <>
              <Row label={`CGST @ ${half}%`} value={money(inv.cgst)} />
              <Row label={`SGST @ ${half}%`} value={money(inv.sgst)} />
            </>
          ) : (
            <Row label={`IGST @ ${Number(inv.gst_rate)}%`} value={money(inv.igst)} />
          )}
          {tax === 0 && <Row label="GST @ 0%" value="0.00" />}
          <div className="mt-1 flex justify-between border-t-2 border-forest-900 pt-1 text-sm font-bold">
            <span>Grand total (₹)</span><span className="font-mono">{money(inv.grand_total)}</span>
          </div>
        </div>

        <p className="mt-4 text-xs"><span className="font-bold">Amount in words:</span> {rupeesInWords(Number(inv.grand_total))}</p>

        <footer className="mt-10 flex items-end justify-between text-xs text-ink-500">
          <span>This is a computer-generated invoice.</span>
          <span className="border-t border-ink-300 px-6 pt-1 text-ink-700">Authorised signatory</span>
        </footer>
      </article>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between py-0.5"><span className="text-ink-500">{label}</span><span className="font-mono">{value}</span></div>;
}
