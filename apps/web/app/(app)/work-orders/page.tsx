'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { STATUS_LABEL, STATUS_BADGE_CLASS } from '@/lib/statusLabels';
import type { WorkOrder, BusinessPartner } from '@sgr/types';

type Row = WorkOrder & { partner?: BusinessPartner | null; line_count: number; total_qty: number };

export default function WorkOrdersPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('work_orders')
        .select('*, partner:business_partners(*), work_order_lines(qty)')
        .neq('status', 'draft')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (error) { setError(error.message); return; }
      const mapped: Row[] = (data ?? []).map((w: any) => ({
        ...w,
        line_count: w.work_order_lines?.length ?? 0,
        total_qty: (w.work_order_lines ?? []).reduce((n: number, l: any) => n + Number(l.qty), 0),
      }));
      setRows(mapped);
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = (rows ?? []).filter((r) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return r.wo_number?.toLowerCase().includes(s) || r.partner?.name?.toLowerCase().includes(s) || r.partner?.code?.toLowerCase().includes(s);
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-forest-900">Work Orders</h1>
          <p className="text-sm text-ink-500">Every Work Order that has been created — a Draft only appears here after it is created (v1.3 §3.4).</p>
        </div>
        {(profile?.role === 'creator' || profile?.role === 'md' || profile?.role === 'admin') && (
          <a href="/work-orders/new" className="rounded-md bg-forest-700 px-4 py-2 text-sm font-bold text-white hover:bg-forest-800">
            + New Work Order
          </a>
        )}
      </div>

      <input
        placeholder="Search by Work Order #, vendor code or name…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="w-full max-w-md rounded-md border border-kraft-300 px-3 py-2 text-sm outline-none focus:border-forest-500"
      />

      {error && <p className="text-sm text-rose-600">{error}</p>}

      <div className="overflow-hidden rounded-lg border border-kraft-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-kraft-100 text-left text-[11px] font-bold uppercase tracking-wide text-ink-900">
            <tr>
              <th className="px-3 py-2">WO #</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">Delivery Date</th>
              <th className="px-3 py-2 text-center">Lines</th>
              <th className="px-3 py-2 text-right">Total Qty</th>
              <th className="px-3 py-2 text-center">Revision</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-ink-500">Loading…</td></tr>
            )}
            {rows !== null && filtered.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-ink-500">No Work Orders found.</td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id} className="border-t border-kraft-100 hover:bg-kraft-50">
                <td className="px-3 py-2">
                  <a href={`/work-orders/detail?id=${r.id}`} className="font-mono font-bold text-forest-800 hover:underline">
                    {r.wo_number}
                  </a>
                </td>
                <td className="px-3 py-2">{r.partner ? `${r.partner.code} — ${r.partner.name}` : '—'}</td>
                <td className="px-3 py-2">{r.delivery_date ?? '—'}</td>
                <td className="px-3 py-2 text-center font-mono">{r.line_count}</td>
                <td className="px-3 py-2 text-right font-mono">{r.total_qty.toLocaleString('en-IN')}</td>
                <td className="px-3 py-2 text-center font-mono">R{r.revision}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_BADGE_CLASS[r.status]}`}>
                    {STATUS_LABEL[r.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
