'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { STATUS_LABEL, STATUS_BADGE_CLASS, STATUS_ORDER } from '@/lib/statusLabels';
import type { WorkOrder, WorkOrderLine, Invoice, BusinessPartner, WoStatus } from '@sgr/types';

interface ExtendedWo extends WorkOrder {
  partner?: { code: string; name: string } | null;
  lines?: WorkOrderLine[];
  orderTotal?: number;
  totalOrderedQty?: number;
  totalProducedQty?: number;
  totalAcceptedQty?: number;
  totalHeldQty?: number;
  totalBilledQty?: number;
  unbilledAcceptedQty?: number;
  unbilledValue?: number;
}

interface RecentActivity {
  id: string;
  type: 'status' | 'revision' | 'invoice' | 'approval' | 'dispatch';
  title: string;
  subtitle: string;
  time: string;
  badge?: string;
  badgeColor?: string;
}

const formatRupees = (n: number) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const formatCompact = (n: number) => {
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(2) + ' Cr';
  if (n >= 100000) return '₹' + (n / 100000).toFixed(2) + ' L';
  if (n >= 1000) return '₹' + (n / 1000).toFixed(1) + ' k';
  return formatRupees(n);
};

export default function MdDashboardPage() {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [workOrders, setWorkOrders] = useState<ExtendedWo[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [partners, setPartners] = useState<BusinessPartner[]>([]);
  const [activities, setActivities] = useState<RecentActivity[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [monthFilter, setMonthFilter] = useState<string>('all'); // 'all', 'this_month', 'last_month', or 'YYYY-MM'

  const loadData = useCallback(async () => {
    setError('');
    try {
      const [woRes, linesRes, invRes, prodRes, qcRes, partnerRes, statusRes, revRes] = await Promise.all([
        supabase.from('work_orders').select('*, partner:business_partners(code, name)').order('created_at', { ascending: false }),
        supabase.from('work_order_lines').select('*'),
        supabase.from('invoices').select('*, invoice_lines(*)').order('generated_at', { ascending: false }),
        supabase.from('production_output_lines').select('work_order_line_id, qty'),
        supabase.from('qc_inspections').select('work_order_line_id, accepted_qty, held_qty'),
        supabase.from('business_partners').select('*'),
        supabase.from('status_history').select('*').order('changed_at', { ascending: false }).limit(20),
        supabase.from('work_order_revisions').select('*').order('changed_at', { ascending: false }).limit(10),
      ]);

      if (woRes.error) throw woRes.error;

      const linesByWo = new Map<string, WorkOrderLine[]>();
      for (const line of linesRes.data ?? []) {
        const arr = linesByWo.get(line.work_order_id) ?? [];
        arr.push(line);
        linesByWo.set(line.work_order_id, arr);
      }

      const prodByLine = new Map<string, number>();
      for (const p of prodRes.data ?? []) {
        prodByLine.set(p.work_order_line_id, (prodByLine.get(p.work_order_line_id) ?? 0) + Number(p.qty));
      }

      const qcAccByLine = new Map<string, number>();
      const qcHeldByLine = new Map<string, number>();
      for (const q of qcRes.data ?? []) {
        qcAccByLine.set(q.work_order_line_id, (qcAccByLine.get(q.work_order_line_id) ?? 0) + Number(q.accepted_qty));
        qcHeldByLine.set(q.work_order_line_id, (qcHeldByLine.get(q.work_order_line_id) ?? 0) + Number(q.held_qty));
      }

      const billedByLine = new Map<string, number>();
      for (const inv of invRes.data ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const il of (inv as any).invoice_lines ?? []) {
          if (il.work_order_line_id) {
            billedByLine.set(il.work_order_line_id, (billedByLine.get(il.work_order_line_id) ?? 0) + Number(il.qty));
          }
        }
      }

      const extendedWos: ExtendedWo[] = (woRes.data ?? []).map((wo) => {
        const woLines = linesByWo.get(wo.id) ?? [];
        let orderTotal = 0;
        let totalOrderedQty = 0;
        let totalProducedQty = 0;
        let totalAcceptedQty = 0;
        let totalHeldQty = 0;
        let totalBilledQty = 0;
        let unbilledAcceptedQty = 0;
        let unbilledValue = 0;

        for (const l of woLines) {
          const qty = Number(l.qty) || 0;
          const price = Number(l.final_price) || 0;
          orderTotal += qty * price;
          totalOrderedQty += qty;

          const prod = prodByLine.get(l.id) ?? 0;
          totalProducedQty += prod;

          const acc = qcAccByLine.get(l.id) ?? 0;
          totalAcceptedQty += acc;

          const held = qcHeldByLine.get(l.id) ?? 0;
          totalHeldQty += held;

          const billed = billedByLine.get(l.id) ?? 0;
          totalBilledQty += billed;

          const unbilled = Math.max(0, acc - billed);
          unbilledAcceptedQty += unbilled;
          unbilledValue += unbilled * price;
        }

        return {
          ...wo,
          lines: woLines,
          orderTotal,
          totalOrderedQty,
          totalProducedQty,
          totalAcceptedQty,
          totalHeldQty,
          totalBilledQty,
          unbilledAcceptedQty,
          unbilledValue,
        };
      });

      setWorkOrders(extendedWos);
      setInvoices(invRes.data ?? []);
      setPartners(partnerRes.data ?? []);

      // Build activity feed
      const feed: RecentActivity[] = [];
      for (const sh of statusRes.data ?? []) {
        feed.push({
          id: `sh-${sh.id}`,
          type: 'status',
          title: `Status updated to ${STATUS_LABEL[sh.to_status as WoStatus] || sh.to_status}`,
          subtitle: `Work Order status changed from ${sh.from_status ? STATUS_LABEL[sh.from_status as WoStatus] : 'New'}`,
          time: sh.changed_at,
          badge: sh.to_status,
          badgeColor: STATUS_BADGE_CLASS[sh.to_status as WoStatus] || 'bg-kraft-100',
        });
      }

      for (const rev of revRes.data ?? []) {
        feed.push({
          id: `rev-${rev.id}`,
          type: 'revision',
          title: `Revision R${rev.revision} created`,
          subtitle: rev.change_summary || 'Executive order modification',
          time: rev.changed_at,
          badge: `Rev ${rev.revision}`,
          badgeColor: 'bg-amber-100 text-amber-900 border-amber-300',
        });
      }

      feed.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      setActivities(feed.slice(0, 12));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load dashboard data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Helper to extract YYYY-MM
  const currentYearMonth = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  const lastYearMonth = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  // Distinct available months from work orders and invoices
  const availableMonths = useMemo(() => {
    const set = new Set<string>();
    set.add(currentYearMonth);
    set.add(lastYearMonth);
    for (const wo of workOrders) {
      if (wo.wo_date) set.add(wo.wo_date.slice(0, 7));
    }
    for (const inv of invoices) {
      if (inv.invoice_date) set.add(inv.invoice_date.slice(0, 7));
    }
    return Array.from(set).sort().reverse();
  }, [workOrders, invoices, currentYearMonth, lastYearMonth]);

  const formatMonthName = useCallback((ym: string) => {
    const [y, m] = ym.split('-');
    if (!y || !m) return ym;
    const date = new Date(Number(y), Number(m) - 1, 1);
    return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }, []);

  // Scoped data by selected month
  const targetYm = useMemo(() => {
    if (monthFilter === 'this_month') return currentYearMonth;
    if (monthFilter === 'last_month') return lastYearMonth;
    if (monthFilter === 'all') return null;
    return monthFilter;
  }, [monthFilter, currentYearMonth, lastYearMonth]);

  const scopedWorkOrders = useMemo(() => {
    if (!targetYm) return workOrders;
    return workOrders.filter(
      (w) => (w.wo_date && w.wo_date.startsWith(targetYm)) || (w.created_at && w.created_at.startsWith(targetYm))
    );
  }, [workOrders, targetYm]);

  const scopedInvoices = useMemo(() => {
    if (!targetYm) return invoices;
    return invoices.filter(
      (inv) =>
        (inv.invoice_date && inv.invoice_date.startsWith(targetYm)) ||
        (inv.generated_at && inv.generated_at.startsWith(targetYm))
    );
  }, [invoices, targetYm]);

  const stats = useMemo(() => {
    const totalOrders = scopedWorkOrders.length;
    const activeOrders = scopedWorkOrders.filter((w) => !['draft', 'completed', 'cancelled'].includes(w.status));
    const pendingApproval = scopedWorkOrders.filter((w) => w.status === 'pending_finance_approval');
    const inProduction = scopedWorkOrders.filter((w) => ['created', 'in_production'].includes(w.status));
    const inQc = scopedWorkOrders.filter((w) => ['qc_pending', 'partially_qc_approved'].includes(w.status));
    const finishedGoodsReady = scopedWorkOrders.filter((w) => (w.unbilledAcceptedQty ?? 0) > 0);
    const readyForDispatch = scopedWorkOrders.filter((w) => w.status === 'ready_for_dispatch');
    const completedOrders = scopedWorkOrders.filter((w) => w.status === 'completed');

    // Revenue metrics
    const totalBilledRevenue = scopedInvoices.reduce((sum, inv) => sum + Number(inv.grand_total || 0), 0);
    const subtotalRevenue = scopedInvoices.reduce((sum, inv) => sum + Number(inv.subtotal || 0), 0);
    const totalTaxCollected = scopedInvoices.reduce(
      (sum, inv) => sum + Number(inv.cgst || 0) + Number(inv.sgst || 0) + Number(inv.igst || 0),
      0
    );

    // Unbilled Finished Goods Value
    const totalUnbilledValue = scopedWorkOrders.reduce((sum, w) => sum + (w.unbilledValue ?? 0), 0);
    const totalUnbilledQty = scopedWorkOrders.reduce((sum, w) => sum + (w.unbilledAcceptedQty ?? 0), 0);

    // Pending Gate Dispatch
    const pendingDispatchInvoices = scopedInvoices.filter((inv) => !inv.dispatched_at);
    const pendingDispatchValue = pendingDispatchInvoices.reduce((sum, inv) => sum + Number(inv.grand_total || 0), 0);

    // QC & Production stats
    const totalOrderedQty = scopedWorkOrders.reduce((sum, w) => sum + (w.totalOrderedQty ?? 0), 0);
    const totalProducedQty = scopedWorkOrders.reduce((sum, w) => sum + (w.totalProducedQty ?? 0), 0);
    const totalAcceptedQty = scopedWorkOrders.reduce((sum, w) => sum + (w.totalAcceptedQty ?? 0), 0);
    const totalHeldQty = scopedWorkOrders.reduce((sum, w) => sum + (w.totalHeldQty ?? 0), 0);

    const qcPassRate =
      totalAcceptedQty + totalHeldQty > 0
        ? Math.round((totalAcceptedQty / (totalAcceptedQty + totalHeldQty)) * 100)
        : 100;

    return {
      totalOrders,
      activeOrders: activeOrders.length,
      pendingApproval,
      inProduction: inProduction.length,
      inQc: inQc.length,
      finishedGoodsReady,
      readyForDispatch: readyForDispatch.length,
      completedOrders: completedOrders.length,
      totalBilledRevenue,
      subtotalRevenue,
      totalTaxCollected,
      totalUnbilledValue,
      totalUnbilledQty,
      pendingDispatchInvoices,
      pendingDispatchValue,
      totalOrderedQty,
      totalProducedQty,
      totalAcceptedQty,
      totalHeldQty,
      qcPassRate,
    };
  }, [scopedWorkOrders, scopedInvoices]);

  // Filtered orders table
  const filteredOrders = useMemo(() => {
    if (statusFilter === 'all') return scopedWorkOrders;
    if (statusFilter === 'active')
      return scopedWorkOrders.filter((w) => !['draft', 'completed', 'cancelled'].includes(w.status));
    if (statusFilter === 'unbilled')
      return scopedWorkOrders.filter((w) => (w.unbilledAcceptedQty ?? 0) > 0);
    return scopedWorkOrders.filter((w) => w.status === statusFilter);
  }, [scopedWorkOrders, statusFilter]);

  // Customer sales performance
  const partnerSales = useMemo(() => {
    const map = new Map<string, { partner: BusinessPartner; orderCount: number; totalValue: number }>();
    for (const p of partners) {
      map.set(p.id, { partner: p, orderCount: 0, totalValue: 0 });
    }
    for (const wo of scopedWorkOrders) {
      if (wo.partner_id && map.has(wo.partner_id)) {
        const item = map.get(wo.partner_id)!;
        item.orderCount += 1;
        item.totalValue += wo.orderTotal ?? 0;
      }
    }
    return Array.from(map.values())
      .filter((i) => i.orderCount > 0)
      .sort((a, b) => b.totalValue - a.totalValue)
      .slice(0, 5);
  }, [partners, scopedWorkOrders]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex items-center gap-3 text-sm font-semibold text-forest-800">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-forest-600 border-t-transparent" />
          Loading Executive MD Dashboard…
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pb-12">
      {/* Header & Quick Action Bar */}
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black tracking-tight text-forest-950">Executive MD Dashboard</h1>
            <span className="rounded-full bg-forest-100 px-2.5 py-0.5 text-xs font-bold text-forest-800 border border-forest-200">
              FY {new Date().getMonth() < 3 ? `${new Date().getFullYear() - 1}-${String(new Date().getFullYear()).slice(-2)}` : `${new Date().getFullYear()}-${String(new Date().getFullYear() + 1).slice(-2)}`}
            </span>
          </div>
          <p className="text-xs text-ink-500 mt-0.5">
            Welcome back, <span className="font-bold text-ink-900">{profile?.full_name || 'Managing Director'}</span>. Real-time factory overview & operational health.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => { setRefreshing(true); loadData(); }}
            disabled={refreshing}
            className="btn-secondary flex items-center gap-1.5 text-xs shadow-xs"
          >
            <span className={refreshing ? 'animate-spin' : ''}>🔄</span>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <Link href="/work-orders/new" className="btn-primary flex items-center gap-1.5 text-xs shadow-xs">
            <span>+</span> Create Work Order
          </Link>
        </div>
      </div>

      {/* Monthly / Period Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-kraft-200 bg-white px-4 py-3 shadow-xs">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-ink-800 uppercase tracking-wide flex items-center gap-1">
            <span>📅</span> Period Filter:
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setMonthFilter('all')}
              className={`rounded-md px-3 py-1 text-xs font-bold transition-all ${
                monthFilter === 'all'
                  ? 'bg-forest-800 text-white shadow-xs'
                  : 'bg-kraft-100 text-ink-700 hover:bg-kraft-200'
              }`}
            >
              All Time / Full FY
            </button>
            <button
              onClick={() => setMonthFilter('this_month')}
              className={`rounded-md px-3 py-1 text-xs font-bold transition-all ${
                monthFilter === 'this_month'
                  ? 'bg-forest-800 text-white shadow-xs'
                  : 'bg-kraft-100 text-ink-700 hover:bg-kraft-200'
              }`}
            >
              This Month ({formatMonthName(currentYearMonth)})
            </button>
            <button
              onClick={() => setMonthFilter('last_month')}
              className={`rounded-md px-3 py-1 text-xs font-bold transition-all ${
                monthFilter === 'last_month'
                  ? 'bg-forest-800 text-white shadow-xs'
                  : 'bg-kraft-100 text-ink-700 hover:bg-kraft-200'
              }`}
            >
              Last Month ({formatMonthName(lastYearMonth)})
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-ink-500">Specific Month:</span>
          <select
            value={['all', 'this_month', 'last_month'].includes(monthFilter) ? '' : monthFilter}
            onChange={(e) => {
              if (e.target.value) setMonthFilter(e.target.value);
            }}
            className="input !py-1 !px-2.5 text-xs max-w-[180px]"
          >
            <option value="">Select Month…</option>
            {availableMonths.map((ym) => (
              <option key={ym} value={ym}>
                {formatMonthName(ym)}
              </option>
            ))}
          </select>

          {monthFilter !== 'all' && (
            <button
              onClick={() => setMonthFilter('all')}
              className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-700 hover:bg-rose-100"
              title="Clear monthly filter"
            >
              ✕ Clear Filter
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-xs font-semibold text-rose-700">
          {error}
        </div>
      )}

      {/* Primary KPI Cards (2 cols on mobile, 3 on tablet, 6 on desktop) */}
      <section className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {/* Card 1: Billed Revenue */}
        <div className="flex flex-col justify-between rounded-xl border border-kraft-200 bg-white p-4 shadow-xs hover:border-forest-300 transition-colors">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-500">Invoiced Revenue</div>
            <div className="mt-1.5 text-xl font-black text-forest-900">{formatCompact(stats.totalBilledRevenue)}</div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-kraft-100 pt-2 text-[11px] text-ink-500">
            <span>{invoices.length} Invoices</span>
            <span className="font-semibold text-forest-700">GST: {formatCompact(stats.totalTaxCollected)}</span>
          </div>
        </div>

        {/* Card 2: Unbilled Finished Goods */}
        <div className="flex flex-col justify-between rounded-xl border border-kraft-200 bg-white p-4 shadow-xs hover:border-forest-300 transition-colors">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-amber-700">Unbilled FG Stock</div>
            <div className="mt-1.5 text-xl font-black text-amber-900">{formatCompact(stats.totalUnbilledValue)}</div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-kraft-100 pt-2 text-[11px] text-ink-500">
            <span>{stats.totalUnbilledQty} units approved</span>
            <Link href="/finished-goods" className="font-bold text-amber-800 hover:underline">
              Bill Now →
            </Link>
          </div>
        </div>

        {/* Card 3: Pending Gate Dispatch */}
        <div className="flex flex-col justify-between rounded-xl border border-kraft-200 bg-white p-4 shadow-xs hover:border-forest-300 transition-colors">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-blue-700">Pending Dispatch</div>
            <div className="mt-1.5 text-xl font-black text-blue-900">{formatCompact(stats.pendingDispatchValue)}</div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-kraft-100 pt-2 text-[11px] text-ink-500">
            <span>{stats.pendingDispatchInvoices.length} waiting at gate</span>
            <Link href="/dispatch" className="font-bold text-blue-800 hover:underline">
              Dispatch →
            </Link>
          </div>
        </div>

        {/* Card 4: Active Work Orders */}
        <div className="flex flex-col justify-between rounded-xl border border-kraft-200 bg-white p-4 shadow-xs hover:border-forest-300 transition-colors">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-500">Active Orders</div>
            <div className="mt-1.5 text-xl font-black text-ink-900">{stats.activeOrders} <span className="text-xs font-normal text-ink-400">/ {stats.totalOrders} total</span></div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-kraft-100 pt-2 text-[11px] text-ink-500">
            <span>{stats.inProduction} in production</span>
            <span className="font-semibold text-emerald-700">{stats.completedOrders} completed</span>
          </div>
        </div>

        {/* Card 5: Approvals Gate */}
        <div className="flex flex-col justify-between rounded-xl border border-violet-200 bg-violet-50/50 p-4 shadow-xs hover:border-violet-300 transition-colors">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-violet-800">Needs Approval</div>
            <div className="mt-1.5 text-xl font-black text-violet-950">{stats.pendingApproval.length}</div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-violet-100 pt-2 text-[11px] text-violet-700">
            <span>Awaiting Finance/MD</span>
            <Link href="/finance" className="font-bold text-violet-900 hover:underline">
              Review →
            </Link>
          </div>
        </div>

        {/* Card 6: Quality Pass Rate */}
        <div className="flex flex-col justify-between rounded-xl border border-kraft-200 bg-white p-4 shadow-xs hover:border-forest-300 transition-colors">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-500">QC Pass Rate</div>
            <div className="mt-1.5 text-xl font-black text-emerald-700">{stats.qcPassRate}%</div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-kraft-100 pt-2 text-[11px] text-ink-500">
            <span>{stats.totalAcceptedQty} accepted</span>
            <span className={stats.totalHeldQty > 0 ? 'font-bold text-rose-600' : 'text-ink-400'}>
              {stats.totalHeldQty} held
            </span>
          </div>
        </div>
      </section>

      {/* Urgent Action Attention Queue */}
      <section className="rounded-xl border border-kraft-200 bg-white p-5 shadow-xs">
        <div className="flex items-center justify-between border-b border-kraft-100 pb-3">
          <div>
            <h2 className="text-sm font-bold text-forest-900 uppercase tracking-wide">
              ⚡ Action Items Requiring Executive Attention
            </h2>
            <p className="text-[11px] text-ink-500">Immediate tasks to keep production flowing and revenue cleared.</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Action 1: Pending Approvals */}
          <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-violet-900">1. Work Orders Awaiting Approval</span>
              <span className="rounded-full bg-violet-200 px-2 py-0.5 text-[10px] font-bold text-violet-800">
                {stats.pendingApproval.length}
              </span>
            </div>
            <div className="mt-2.5 flex flex-col gap-2">
              {stats.pendingApproval.length === 0 ? (
                <div className="py-3 text-center text-xs text-ink-400 italic">No orders waiting for approval.</div>
              ) : (
                stats.pendingApproval.slice(0, 3).map((wo) => (
                  <div key={wo.id} className="flex items-center justify-between rounded bg-white p-2 text-xs border border-violet-100 shadow-2xs">
                    <div>
                      <div className="font-mono font-bold text-ink-900">{wo.wo_number}</div>
                      <div className="text-[10px] text-ink-500">{wo.partner?.name || 'Customer'} · {formatRupees(wo.orderTotal ?? 0)}</div>
                    </div>
                    <Link href="/finance" className="rounded bg-violet-700 px-2 py-1 text-[10px] font-bold text-white hover:bg-violet-800">
                      Approve
                    </Link>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Action 2: Finished Goods to Bill */}
          <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-amber-900">2. QC Approved Ready to Bill</span>
              <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                {stats.finishedGoodsReady.length}
              </span>
            </div>
            <div className="mt-2.5 flex flex-col gap-2">
              {stats.finishedGoodsReady.length === 0 ? (
                <div className="py-3 text-center text-xs text-ink-400 italic">No unbilled finished goods.</div>
              ) : (
                stats.finishedGoodsReady.slice(0, 3).map((wo) => (
                  <div key={wo.id} className="flex items-center justify-between rounded bg-white p-2 text-xs border border-amber-100 shadow-2xs">
                    <div>
                      <div className="font-mono font-bold text-ink-900">{wo.wo_number}</div>
                      <div className="text-[10px] text-amber-800 font-medium">
                        {wo.unbilledAcceptedQty} pcs ready ({formatRupees(wo.unbilledValue ?? 0)})
                      </div>
                    </div>
                    <Link href="/finished-goods" className="rounded bg-amber-700 px-2 py-1 text-[10px] font-bold text-white hover:bg-amber-800">
                      Generate Inv
                    </Link>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Action 3: Ready for Gate Dispatch */}
          <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-blue-900">3. Invoices Awaiting Gate Dispatch</span>
              <span className="rounded-full bg-blue-200 px-2 py-0.5 text-[10px] font-bold text-blue-800">
                {stats.pendingDispatchInvoices.length}
              </span>
            </div>
            <div className="mt-2.5 flex flex-col gap-2">
              {stats.pendingDispatchInvoices.length === 0 ? (
                <div className="py-3 text-center text-xs text-ink-400 italic">All billed goods dispatched.</div>
              ) : (
                stats.pendingDispatchInvoices.slice(0, 3).map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between rounded bg-white p-2 text-xs border border-blue-100 shadow-2xs">
                    <div>
                      <div className="font-mono font-bold text-ink-900">{inv.invoice_number}</div>
                      <div className="text-[10px] text-ink-500">{formatRupees(Number(inv.grand_total))}</div>
                    </div>
                    <Link href="/dispatch" className="rounded bg-blue-700 px-2 py-1 text-[10px] font-bold text-white hover:bg-blue-800">
                      Dispatch
                    </Link>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Production Pipeline & Funnel Breakdown */}
      <section className="rounded-xl border border-kraft-200 bg-white p-5 shadow-xs">
        <div className="flex items-center justify-between border-b border-kraft-100 pb-3">
          <div>
            <h2 className="text-sm font-bold text-forest-900 uppercase tracking-wide">
              🏭 Work Order Pipeline & Status Funnel
            </h2>
            <p className="text-[11px] text-ink-500">Live breakdown of all orders across production and delivery stages.</p>
          </div>
          <div className="text-xs font-semibold text-ink-500">
            Total Pipeline Volume: <span className="font-bold text-ink-900">{stats.totalOrders} Orders</span>
          </div>
        </div>

        {/* Funnel Stage Badges */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {STATUS_ORDER.map((st) => {
            const count = workOrders.filter((w) => w.status === st).length;
            const active = statusFilter === st;
            return (
              <button
                key={st}
                onClick={() => setStatusFilter(active ? 'all' : st)}
                className={`flex flex-col items-center justify-between rounded-lg border p-3 text-center transition-all ${
                  active
                    ? 'border-forest-600 bg-forest-50 ring-2 ring-forest-500/20'
                    : 'border-kraft-200 bg-kraft-50/50 hover:bg-white'
                }`}
              >
                <div className="text-[10px] font-bold uppercase tracking-tight text-ink-500">
                  {STATUS_LABEL[st]}
                </div>
                <div className="my-1 text-lg font-black text-ink-900">{count}</div>
                <div className="text-[10px] text-ink-400">
                  {stats.totalOrders > 0 ? Math.round((count / stats.totalOrders) * 100) : 0}%
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Two Column Layout: Customer Insights + Activity Feed */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Top Business Partners */}
        <section className="rounded-xl border border-kraft-200 bg-white p-5 shadow-xs lg:col-span-1">
          <h2 className="text-sm font-bold text-forest-900 uppercase tracking-wide border-b border-kraft-100 pb-2.5">
            👥 Top Customer Accounts
          </h2>
          <div className="mt-4 flex flex-col gap-3">
            {partnerSales.length === 0 ? (
              <p className="text-xs text-ink-400">No partner sales data yet.</p>
            ) : (
              partnerSales.map((item, idx) => {
                const maxVal = partnerSales[0]?.totalValue || 1;
                const pct = Math.round((item.totalValue / maxVal) * 100);
                return (
                  <div key={item.partner.id} className="text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-ink-800">
                        {idx + 1}. {item.partner.name}
                      </span>
                      <span className="font-mono font-bold text-forest-900">
                        {formatRupees(item.totalValue)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-ink-500">
                      <span>Vendor Code: {item.partner.code}</span>
                      <span>{item.orderCount} Orders</span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-kraft-100">
                      <div className="h-full rounded-full bg-forest-600" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Recent Operational Activity Log */}
        <section className="rounded-xl border border-kraft-200 bg-white p-5 shadow-xs lg:col-span-2">
          <div className="flex items-center justify-between border-b border-kraft-100 pb-2.5">
            <h2 className="text-sm font-bold text-forest-900 uppercase tracking-wide">
              📋 Live Activity & Audit Stream
            </h2>
            <span className="text-[11px] text-ink-400">Latest transitions & updates</span>
          </div>

          <div className="mt-4 flex flex-col divide-y divide-kraft-100">
            {activities.length === 0 ? (
              <p className="text-xs text-ink-400 py-3">No activity recorded yet.</p>
            ) : (
              activities.map((act) => (
                <div key={act.id} className="flex items-start justify-between py-2.5 text-xs first:pt-0 last:pb-0">
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 text-sm">
                      {act.type === 'revision' ? '📝' : act.type === 'approval' ? '✅' : '🔄'}
                    </span>
                    <div>
                      <div className="font-bold text-ink-900">{act.title}</div>
                      <div className="text-[11px] text-ink-500">{act.subtitle}</div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {act.badge && (
                      <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold ${act.badgeColor}`}>
                        {act.badge}
                      </span>
                    )}
                    <span className="text-[10px] text-ink-400">
                      {new Date(act.time).toLocaleDateString('en-GB')} {new Date(act.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Filterable Work Orders Quick Table */}
      <section className="rounded-xl border border-kraft-200 bg-white p-5 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-kraft-100 pb-3">
          <div>
            <h2 className="text-sm font-bold text-forest-900 uppercase tracking-wide">
              📦 Work Orders Master Roster
            </h2>
            <p className="text-[11px] text-ink-500">
              Showing {filteredOrders.length} of {workOrders.length} orders
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-[11px] font-bold text-ink-500 mr-1">Filter:</span>
            {[
              { id: 'all', label: 'All' },
              { id: 'active', label: 'Active Only' },
              { id: 'pending_finance_approval', label: 'Pending Approval' },
              { id: 'in_production', label: 'In Production' },
              { id: 'ready_for_dispatch', label: 'Finished Goods' },
              { id: 'completed', label: 'Completed' },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setStatusFilter(f.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-bold transition-colors ${
                  statusFilter === f.id
                    ? 'bg-forest-800 text-white shadow-xs'
                    : 'bg-kraft-100 text-ink-700 hover:bg-kraft-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-kraft-100 text-left font-bold uppercase text-ink-900">
              <tr>
                <th className="px-3 py-2.5">WO Number</th>
                <th className="px-3 py-2.5">Customer / Partner</th>
                <th className="px-3 py-2.5">Date</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5 text-right">Ordered Qty</th>
                <th className="px-3 py-2.5 text-right">Produced</th>
                <th className="px-3 py-2.5 text-right">QC Approved</th>
                <th className="px-3 py-2.5 text-right">Order Value</th>
                <th className="px-3 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-kraft-100">
              {filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-ink-400">
                    No work orders match the current filter.
                  </td>
                </tr>
              ) : (
                filteredOrders.slice(0, 15).map((wo) => (
                  <tr key={wo.id} className="hover:bg-kraft-50/60 transition-colors">
                    <td className="px-3 py-2.5 font-mono font-bold text-forest-900">
                      <Link href={`/work-orders/detail?id=${wo.id}`} className="hover:underline">
                        {wo.wo_number || '(Draft)'}
                      </Link>
                      {wo.revision > 0 && (
                        <span className="ml-1 text-[10px] text-amber-700 font-bold">R{wo.revision}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-ink-900">
                      {wo.partner?.name || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-ink-600">
                      {new Date(wo.wo_date).toLocaleDateString('en-GB')}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_BADGE_CLASS[wo.status]}`}>
                        {STATUS_LABEL[wo.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono font-semibold">{wo.totalOrderedQty}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{wo.totalProducedQty}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-emerald-700 font-bold">{wo.totalAcceptedQty}</td>
                    <td className="px-3 py-2.5 text-right font-mono font-bold text-ink-900">{formatRupees(wo.orderTotal ?? 0)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <Link
                        href={`/work-orders/detail?id=${wo.id}`}
                        className="rounded bg-kraft-200 px-2 py-1 text-[10px] font-bold text-ink-900 hover:bg-kraft-300"
                      >
                        View →
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
