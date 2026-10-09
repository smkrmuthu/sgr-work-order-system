'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { STATUS_LABEL, STATUS_BADGE_CLASS } from '@/lib/statusLabels';
import type { WorkOrder, WoStatus } from '@sgr/types';

// What the Production (Planner) user sees on the Dashboard: the orders that still need work on the floor.
// No prices, invoices or revenue here — that is the MD's dashboard.
const SHOWN: WoStatus[] = ['created', 'in_production', 'partially_qc_approved'];

interface Row extends WorkOrder {
  partner?: { code: string; name: string } | null;
  ordered: number;
  produced: number;
  qcApproved: number;
}

export default function ProductionDashboard() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'all' | WoStatus>('all');
  const today = new Date().toISOString().slice(0, 10);

  const load = useCallback(async () => {
    setError('');
    const { data, error } = await supabase
      .from('work_orders')
      .select('*, partner:business_partners(code,name), work_order_lines(qty, production_output_lines(qty), qc_inspections(accepted_qty))')
      .in('status', SHOWN)
      .order('delivery_date', { ascending: true, nullsFirst: false });
    setRefreshing(false);
    if (error) { setError(error.message); setRows([]); return; }
    setRows((data ?? []).map((w: any) => {
      const ls: any[] = w.work_order_lines ?? [];
      const sum = (f: (l: any) => number) => ls.reduce((n, l) => n + f(l), 0);
      return {
        ...w,
        ordered: sum((l) => Number(l.qty)),
        produced: sum((l) => (l.production_output_lines ?? []).reduce((n: number, o: any) => n + Number(o.qty), 0)),
        qcApproved: sum((l) => (l.qc_inspections ?? []).reduce((n: number, q: any) => n + Number(q.accepted_qty), 0)),
      } as Row;
    }));
  }, []);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => Object.fromEntries(SHOWN.map((s) => [s, (rows ?? []).filter((r) => r.status === s).length])) as Record<string, number>, [rows]);
  const visible = (rows ?? []).filter((r) => filter === 'all' || r.status === filter);
  const pct = (n: number, d: number) => (d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-bold text-forest-900">Dashboard</h1>
          <p className="text-sm text-ink-500">
            Welcome back, <span className="font-bold text-ink-900">{profile?.full_name || 'Production Planner'}</span> — the Work Orders waiting on production.
          </p>
        </div>
        <button onClick={() => { setRefreshing(true); load(); }} disabled={refreshing} className="btn-secondary self-start sm:self-auto">
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([['all', 'All Open Orders', (rows ?? []).length], ...SHOWN.map((s) => [s, STATUS_LABEL[s], counts[s] ?? 0])] as [string, string, number][]).map(([key, label, n]) => (
          <button
            key={key}
            onClick={() => setFilter(key as 'all' | WoStatus)}
            className={`rounded-lg border px-4 py-3 text-left ${filter === key ? 'border-forest-600 bg-forest-50' : 'border-kraft-200 bg-white hover:bg-kraft-50'}`}
          >
            <div className="text-[11px] font-bold uppercase tracking-wide text-ink-500">{label}</div>
            <div className="font-mono text-2xl font-bold text-forest-900">{rows === null ? '…' : n}</div>
          </button>
        ))}
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}

      <div className="overflow-x-auto rounded-lg border border-kraft-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-kraft-100 text-left text-[11px] font-bold uppercase tracking-wide text-ink-900">
            <tr>
              <th className="px-3 py-2">WO #</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">Delivery Date</th>
              <th className="px-3 py-2 text-right">Ordered</th>
              <th className="px-3 py-2 text-right">Produced</th>
              <th className="px-3 py-2 text-right">QC Approved</th>
              <th className="px-3 py-2">Progress</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows === null && <tr><td colSpan={9} className="px-3 py-8 text-center text-ink-500">Loading…</td></tr>}
            {rows !== null && visible.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-ink-500">No Work Orders in this stage.</td></tr>}
            {visible.map((r) => {
              const late = !!r.delivery_date && r.delivery_date < today;
              return (
                <tr key={r.id} className="border-t border-kraft-100 hover:bg-kraft-50">
                  <td className="px-3 py-2">
                    <Link href={`/work-orders/detail?id=${r.id}`} className="font-mono font-bold text-forest-800 hover:underline">{r.wo_number ?? 'Draft'}</Link>
                  </td>
                  <td className="px-3 py-2">{r.partner ? `${r.partner.code} — ${r.partner.name}` : '—'}</td>
                  <td className={`px-3 py-2 ${late ? 'font-bold text-rose-700' : ''}`}>
                    {r.delivery_date ?? '—'}{late && <span className="ml-1.5 rounded-full bg-rose-100 px-1.5 text-[10px]">overdue</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{r.ordered.toLocaleString('en-IN')}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.produced.toLocaleString('en-IN')}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.qcApproved.toLocaleString('en-IN')}</td>
                  <td className="px-3 py-2">
                    <div className="h-2 w-28 overflow-hidden rounded-full bg-kraft-100" title={`${pct(r.produced, r.ordered)}% produced · ${pct(r.qcApproved, r.ordered)}% QC approved`}>
                      <div className="relative h-full">
                        <div className="absolute inset-y-0 left-0 bg-forest-300" style={{ width: `${pct(r.produced, r.ordered)}%` }} />
                        <div className="absolute inset-y-0 left-0 bg-forest-700" style={{ width: `${pct(r.qcApproved, r.ordered)}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_BADGE_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link href={`/planner?id=${r.id}`} className="rounded-md border border-kraft-300 bg-white px-2.5 py-1 text-[11px] font-bold text-forest-800 hover:bg-kraft-50">
                      Open in Planner
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-ink-500">Progress bar: light = produced, dark = QC approved, out of the ordered quantity.</p>
    </div>
  );
}
