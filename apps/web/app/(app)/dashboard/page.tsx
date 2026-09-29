'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { STATUS_LABEL } from '@/lib/statusLabels';
import type { WoStatus } from '@sgr/types';

// MD/Admin only (see NAV in layout.tsx). Read-only: every number here is one of the same queries the
// individual tabs already run, just totalled — nothing new is computed server-side, so this page can never
// show something the other tabs wouldn't also let the MD reach.

const PIPELINE: { status: WoStatus; href: string }[] = [
  { status: 'pending_finance_approval', href: '/finance' },
  { status: 'created', href: '/planner' },
  { status: 'in_production', href: '/planner' },
  { status: 'qc_pending', href: '/qc' },
  { status: 'partially_qc_approved', href: '/qc' },
  { status: 'ready_for_dispatch', href: '/finished-goods' },
];

interface Attention { id: string; wo_number: string | null; expected_completion_date: string | null; partner: string }
interface Recent { id: string; wo_number: string | null; to_status: WoStatus; changed_at: string }

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const startOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString(); };

export default function DashboardPage() {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [awaitingDispatch, setAwaitingDispatch] = useState<number | null>(null);
  const [monthCreatedValue, setMonthCreatedValue] = useState<number | null>(null);
  const [monthInvoiced, setMonthInvoiced] = useState<number | null>(null);
  const [monthCompleted, setMonthCompleted] = useState<number | null>(null);
  const [overdue, setOverdue] = useState<Attention[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const since = startOfMonth();
    const [
      statusRows, dispatchRows, monthWo, monthInv, monthDone, overdueRows, historyRows,
    ] = await Promise.all([
      supabase.from('work_orders').select('status'),
      supabase.from('invoices').select('id', { count: 'exact', head: true }).is('dispatched_at', null),
      supabase.from('work_orders').select('id, work_order_lines(qty, final_price)').gte('created_at', since).neq('status', 'draft'),
      supabase.from('invoices').select('grand_total').gte('generated_at', since),
      supabase.from('work_orders').select('id', { count: 'exact', head: true }).eq('status', 'completed').gte('updated_at', since),
      supabase.from('work_orders')
        .select('id, wo_number, expected_completion_date, partner:business_partners(name)')
        .not('status', 'in', '("draft","pending_finance_approval","completed","cancelled")')
        .lt('expected_completion_date', new Date().toISOString().slice(0, 10))
        .order('expected_completion_date')
        .limit(8),
      supabase.from('status_history')
        .select('id, changed_at, to_status, work_order:work_orders(wo_number)')
        .order('changed_at', { ascending: false }).limit(8),
    ]);

    const firstError = [statusRows, dispatchRows, monthInv, monthDone, overdueRows, historyRows].find((r) => r.error)?.error;
    if (firstError) { setError(firstError.message); return; }

    const byStatus: Record<string, number> = {};
    for (const r of statusRows.data ?? []) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    setCounts(byStatus);
    setAwaitingDispatch(dispatchRows.count ?? 0);
    setMonthCompleted(monthDone.count ?? 0);
    setMonthInvoiced((monthInv.data ?? []).reduce((n, i) => n + Number(i.grand_total), 0));
    setMonthCreatedValue(
      (monthWo.data ?? []).reduce((n, w: any) => n + (w.work_order_lines ?? []).reduce((m: number, l: any) => m + Number(l.qty) * Number(l.final_price), 0), 0),
    );
    setOverdue((overdueRows.data ?? []).map((r: any) => ({ id: r.id, wo_number: r.wo_number, expected_completion_date: r.expected_completion_date, partner: r.partner?.name ?? '—' })));
    setRecent((historyRows.data ?? []).map((r: any) => ({ id: r.id, wo_number: r.work_order?.wo_number ?? null, to_status: r.to_status, changed_at: r.changed_at })));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold text-forest-900">Dashboard</h1>
        <p className="text-sm text-ink-500">Where every Work Order stands right now, and what needs a look.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {PIPELINE.map((p) => (
          <Link key={p.status} href={p.href} className="rounded-lg border border-kraft-200 bg-white px-4 py-3 hover:border-forest-400 hover:shadow-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-ink-500">{STATUS_LABEL[p.status]}</div>
            <div className="mt-1 font-mono text-2xl font-bold text-forest-900">{counts ? counts[p.status] ?? 0 : '–'}</div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label="Order value this month" value={monthCreatedValue === null ? '–' : inr(monthCreatedValue)} hint="Non-draft Work Orders, ordered qty × price" />
        <Tile label="Invoiced this month" value={monthInvoiced === null ? '–' : inr(monthInvoiced)} hint="Grand total of invoices created" />
        <Tile label="Completed this month" value={monthCompleted === null ? '–' : String(monthCompleted)} hint="Fully billed and dispatched" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-kraft-200 bg-white">
          <div className="flex items-center justify-between border-b border-kraft-100 px-5 py-3">
            <span className="text-sm font-bold text-forest-900">NEEDS ATTENTION</span>
            <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-700">{overdue.length} overdue</span>
          </div>
          <div className="p-5">
            {overdue.length === 0 && <p className="text-sm text-ink-500">Nothing is past its Expected Completion Date.</p>}
            <ul className="flex flex-col gap-2">
              {overdue.map((o) => (
                <li key={o.id}>
                  <Link href={`/work-orders/detail?id=${o.id}`} className="flex items-center justify-between rounded-md border border-kraft-200 bg-kraft-50 px-3 py-2 text-sm hover:border-rose-300">
                    <span><span className="font-mono font-bold text-forest-800">{o.wo_number}</span><span className="ml-2 text-ink-500">{o.partner}</span></span>
                    <span className="font-mono text-xs text-rose-700">due {o.expected_completion_date}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="rounded-lg border border-kraft-200 bg-white">
          <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">
            RECENT ACTIVITY
            <span className="ml-2 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-bold text-blue-800">{awaitingDispatch ?? '–'} invoice(s) awaiting dispatch</span>
          </div>
          <div className="p-5">
            {recent.length === 0 && <p className="text-sm text-ink-500">Nothing has happened yet.</p>}
            <ul className="flex flex-col gap-1.5">
              {recent.map((r) => (
                <li key={r.id}>
                  <Link href={`/work-orders/detail?id=${r.id}`} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-kraft-50">
                    <span><span className="font-mono font-bold text-forest-800">{r.wo_number ?? '(draft)'}</span><span className="ml-2 text-ink-700">→ {STATUS_LABEL[r.to_status]}</span></span>
                    <span className="text-xs text-ink-500">{new Date(r.changed_at).toLocaleString('en-GB')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-kraft-200 bg-white px-4 py-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-ink-500">{label}</div>
      <div className="mt-1 font-mono text-2xl font-bold text-forest-900">{value}</div>
      <div className="mt-0.5 text-[11px] text-ink-300">{hint}</div>
    </div>
  );
}
