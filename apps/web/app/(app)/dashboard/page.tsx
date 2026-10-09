'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { STATUS_LABEL, STATUS_BADGE_CLASS, STATUS_ORDER } from '@/lib/statusLabels';
import type { WorkOrder, WorkOrderLine, Invoice, BusinessPartner, WoStatus } from '@sgr/types';
import ProductionDashboard from './ProductionDashboard';

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

// Orders that never became a real, confirmed sale — kept out of revenue-style aggregates
// (Top Customer Accounts) below, the same way the rest of the app treats them.
const UNREALIZED_STATUSES = ['draft', 'pending_finance_approval', 'cancelled'];

const formatRupees = (n: number) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const formatCompact = (n: number) => {
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(2) + ' Cr';
  if (n >= 100000) return '₹' + (n / 100000).toFixed(2) + ' L';
  if (n >= 1000) return '₹' + (n / 1000).toFixed(1) + ' k';
  return formatRupees(n);
};

// The Production Planner gets their own, price-free dashboard; everyone else here (MD/Admin) gets the full one.
// A separate component, so the MD's revenue queries never run for a Planner login.
export default function DashboardPage() {
  const { profile } = useAuth();
  if (!profile) return null;
  return profile.role === 'planner' ? <ProductionDashboard /> : <MdDashboardPage />;
}

function MdDashboardPage() {
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
          subtitle: rev.change_summary || 'Order modification',
          time: rev.changed_at,
          badge: `Rev ${rev.revision}`,
          badgeColor: 'bg-amber-50 text-amber-800 border-amber-200',
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

  const currentYearMonth = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  const lastYearMonth = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  // Distinct available months from work orders and invoices (just for the dropdown's options —
  // not used to decide which record belongs to which month, so OR-ing two sources here is fine).
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

  const targetYm = useMemo(() => {
    if (monthFilter === 'this_month') return currentYearMonth;
    if (monthFilter === 'last_month') return lastYearMonth;
    if (monthFilter === 'all') return null;
    return monthFilter;
  }, [monthFilter, currentYearMonth, lastYearMonth]);

  // One authoritative date column per record (wo_date, invoice_date — both NOT NULL in the schema),
  // not an OR of two columns: that let the same order or invoice match two different months at once.
  const scopedWorkOrders = useMemo(() => {
    if (!targetYm) return workOrders;
    return workOrders.filter((w) => w.wo_date && w.wo_date.startsWith(targetYm));
  }, [workOrders, targetYm]);

  const scopedInvoices = useMemo(() => {
    if (!targetYm) return invoices;
    return invoices.filter((inv) => inv.invoice_date && inv.invoice_date.startsWith(targetYm));
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

    const totalBilledRevenue = scopedInvoices.reduce((sum, inv) => sum + Number(inv.grand_total || 0), 0);
    const totalTaxCollected = scopedInvoices.reduce(
      (sum, inv) => sum + Number(inv.cgst || 0) + Number(inv.sgst || 0) + Number(inv.igst || 0), 0,
    );

    const totalUnbilledValue = scopedWorkOrders.reduce((sum, w) => sum + (w.unbilledValue ?? 0), 0);
    const totalUnbilledQty = scopedWorkOrders.reduce((sum, w) => sum + (w.unbilledAcceptedQty ?? 0), 0);

    const pendingDispatchInvoices = scopedInvoices.filter((inv) => !inv.dispatched_at);
    const pendingDispatchValue = pendingDispatchInvoices.reduce((sum, inv) => sum + Number(inv.grand_total || 0), 0);

    const totalAcceptedQty = scopedWorkOrders.reduce((sum, w) => sum + (w.totalAcceptedQty ?? 0), 0);
    const totalHeldQty = scopedWorkOrders.reduce((sum, w) => sum + (w.totalHeldQty ?? 0), 0);

    const qcPassRate = totalAcceptedQty + totalHeldQty > 0
      ? Math.round((totalAcceptedQty / (totalAcceptedQty + totalHeldQty)) * 100) : 100;

    return {
      totalOrders, activeOrders: activeOrders.length, pendingApproval, inProduction: inProduction.length,
      inQc: inQc.length, finishedGoodsReady, readyForDispatch: readyForDispatch.length,
      completedOrders: completedOrders.length, totalBilledRevenue, totalTaxCollected, totalUnbilledValue,
      totalUnbilledQty, pendingDispatchInvoices, pendingDispatchValue, totalAcceptedQty, totalHeldQty, qcPassRate,
    };
  }, [scopedWorkOrders, scopedInvoices]);

  const filteredOrders = useMemo(() => {
    if (statusFilter === 'all') return scopedWorkOrders;
    if (statusFilter === 'active') return scopedWorkOrders.filter((w) => !['draft', 'completed', 'cancelled'].includes(w.status));
    if (statusFilter === 'unbilled') return scopedWorkOrders.filter((w) => (w.unbilledAcceptedQty ?? 0) > 0);
    return scopedWorkOrders.filter((w) => w.status === statusFilter);
  }, [scopedWorkOrders, statusFilter]);

  // Realized sales per customer — a draft or cancelled order was never a real sale, and (unlike
  // "active orders" above) a completed one still counts here, since it's exactly the sale that closed.
  const partnerSales = useMemo(() => {
    const map = new Map<string, { partner: BusinessPartner; orderCount: number; totalValue: number }>();
    for (const p of partners) map.set(p.id, { partner: p, orderCount: 0, totalValue: 0 });
    for (const wo of scopedWorkOrders) {
      if (UNREALIZED_STATUSES.includes(wo.status)) continue;
      if (wo.partner_id && map.has(wo.partner_id)) {
        const item = map.get(wo.partner_id)!;
        item.orderCount += 1;
        item.totalValue += wo.orderTotal ?? 0;
      }
    }
    return Array.from(map.values()).filter((i) => i.orderCount > 0).sort((a, b) => b.totalValue - a.totalValue).slice(0, 5);
  }, [partners, scopedWorkOrders]);

  // Same scoped set the funnel counts are shown against, so the percentages actually sum to 100%
  // once a month filter is applied — before, the count was scoped but the total it divided by wasn't.
  const funnelCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const st of STATUS_ORDER) m[st] = scopedWorkOrders.filter((w) => w.status === st).length;
    return m;
  }, [scopedWorkOrders]);

  const fyLabel = useMemo(() => {
    const d = new Date();
    return d.getMonth() < 3 ? `FY ${d.getFullYear() - 1}-${String(d.getFullYear()).slice(-2)}` : `FY ${d.getFullYear()}-${String(d.getFullYear() + 1).slice(-2)}`;
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center gap-3 text-sm font-semibold text-forest-800">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-forest-600 border-t-transparent" />
        Loading dashboard…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pb-12">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-forest-900">Dashboard</h1>
            <span className="rounded-full border border-forest-100 bg-forest-50 px-2 py-0.5 font-mono text-[11px] font-bold text-forest-800">{fyLabel}</span>
          </div>
          <p className="text-sm text-ink-500">
            Welcome back, <span className="font-bold text-ink-900">{profile?.full_name || 'Managing Director'}</span> — where every Work Order stands right now.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setRefreshing(true); loadData(); }} disabled={refreshing} className="btn-secondary flex items-center gap-1.5">
            {refreshing && <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-400 border-t-transparent" />}
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {profile?.role === 'md' && (
            // Not shown to Admin: matches work_orders_insert's RLS policy (creator, md only) — see
            // the same fix already applied on the Work Orders list page.
            <Link href="/work-orders/new" className="btn-primary">+ New Work Order</Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-kraft-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-bold uppercase tracking-wide text-ink-500">Period:</span>
          {(['all', 'this_month', 'last_month'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setMonthFilter(f)}
              className={`rounded-md px-3 py-1 text-xs font-bold ${monthFilter === f ? 'bg-forest-700 text-white' : 'bg-kraft-100 text-ink-700 hover:bg-kraft-200'}`}
            >
              {f === 'all' ? 'All Time' : f === 'this_month' ? `This Month (${formatMonthName(currentYearMonth)})` : `Last Month (${formatMonthName(lastYearMonth)})`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={['all', 'this_month', 'last_month'].includes(monthFilter) ? '' : monthFilter}
            onChange={(e) => { if (e.target.value) setMonthFilter(e.target.value); }}
            className="input !w-auto !py-1 text-xs"
          >
            <option value="">Other month…</option>
            {availableMonths.map((ym) => <option key={ym} value={ym}>{formatMonthName(ym)}</option>)}
          </select>
          {monthFilter !== 'all' && (
            <button onClick={() => setMonthFilter('all')} className="btn-secondary !px-2 !py-1 text-xs">Clear</button>
          )}
        </div>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Invoiced Revenue" value={formatCompact(stats.totalBilledRevenue)} hint={`${scopedInvoices.length} invoice(s) · GST ${formatCompact(stats.totalTaxCollected)}`} />
        <Tile label="Unbilled Finished Goods" value={formatCompact(stats.totalUnbilledValue)} hint={`${stats.totalUnbilledQty} unit(s) approved`} href="/finished-goods" />
        <Tile label="Pending Dispatch" value={formatCompact(stats.pendingDispatchValue)} hint={`${stats.pendingDispatchInvoices.length} invoice(s) waiting`} href="/dispatch" />
        <Tile label="Active Orders" value={`${stats.activeOrders} / ${stats.totalOrders}`} hint={`${stats.inProduction} in production · ${stats.completedOrders} completed`} />
        <Tile label="Needs Approval" value={String(stats.pendingApproval.length)} hint="Awaiting Finance / MD" href="/finance" />
        <Tile label="QC Pass Rate" value={`${stats.qcPassRate}%`} hint={`${stats.totalAcceptedQty} accepted · ${stats.totalHeldQty} held`} />
      </div>

      <section className="rounded-lg border border-kraft-200 bg-white">
        <div className="border-b border-kraft-100 px-5 py-3">
          <div className="text-sm font-bold text-forest-900">NEEDS ATTENTION</div>
          <p className="text-xs text-ink-500">Where to look first to keep production and billing moving.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-3">
          <AttentionColumn
            title="Awaiting Finance Approval" count={stats.pendingApproval.length} href="/finance" cta="Approve"
            badgeClass="border-violet-200 bg-violet-50 text-violet-800" empty="Nothing waiting."
            rows={stats.pendingApproval.slice(0, 3).map((wo) => ({ id: wo.id, main: wo.wo_number ?? '(draft)', sub: `${wo.partner?.name ?? 'Customer'} · ${formatRupees(wo.orderTotal ?? 0)}` }))}
          />
          <AttentionColumn
            title="QC Approved, Ready to Bill" count={stats.finishedGoodsReady.length} href="/finished-goods" cta="Bill"
            badgeClass="border-amber-200 bg-amber-50 text-amber-800" empty="Nothing unbilled."
            rows={stats.finishedGoodsReady.slice(0, 3).map((wo) => ({ id: wo.id, main: wo.wo_number ?? '(draft)', sub: `${wo.unbilledAcceptedQty} pc(s) · ${formatRupees(wo.unbilledValue ?? 0)}` }))}
          />
          <AttentionColumn
            title="Invoices Awaiting Dispatch" count={stats.pendingDispatchInvoices.length} href="/dispatch" cta="Dispatch"
            badgeClass="border-blue-200 bg-blue-50 text-blue-800" empty="Everything billed has shipped."
            rows={stats.pendingDispatchInvoices.slice(0, 3).map((inv) => ({ id: inv.id, main: inv.invoice_number, sub: formatRupees(Number(inv.grand_total)) }))}
          />
        </div>
      </section>

      <section className="rounded-lg border border-kraft-200 bg-white">
        <div className="flex items-center justify-between border-b border-kraft-100 px-5 py-3">
          <div>
            <div className="text-sm font-bold text-forest-900">STATUS FUNNEL</div>
            <p className="text-xs text-ink-500">Every order in the period, by stage. Click a stage to filter the table below.</p>
          </div>
          <div className="text-xs font-bold text-ink-700">{stats.totalOrders} order(s)</div>
        </div>
        <div className="grid grid-cols-2 gap-2 p-5 sm:grid-cols-4 lg:grid-cols-7">
          {STATUS_ORDER.map((st) => {
            const count = funnelCounts[st] ?? 0;
            const active = statusFilter === st;
            return (
              <button
                key={st}
                onClick={() => setStatusFilter(active ? 'all' : st)}
                className={`flex flex-col items-center gap-1 rounded-md border p-3 text-center ${active ? 'border-forest-500 bg-forest-50' : 'border-kraft-200 bg-kraft-50 hover:bg-white'}`}
              >
                <div className="text-[10px] font-bold uppercase text-ink-500">{STATUS_LABEL[st]}</div>
                <div className="font-mono text-lg font-bold text-ink-900">{count}</div>
                <div className="text-[10px] text-ink-400">{stats.totalOrders > 0 ? Math.round((count / stats.totalOrders) * 100) : 0}%</div>
              </button>
            );
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="rounded-lg border border-kraft-200 bg-white lg:col-span-1">
          <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">TOP CUSTOMER ACCOUNTS</div>
          <div className="flex flex-col gap-3 p-5">
            {partnerSales.length === 0 ? (
              <p className="text-xs text-ink-500">No confirmed sales yet in this period.</p>
            ) : (
              partnerSales.map((item, idx) => {
                const maxVal = partnerSales[0]?.totalValue || 1;
                const pct = Math.round((item.totalValue / maxVal) * 100);
                return (
                  <div key={item.partner.id} className="text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-ink-800">{idx + 1}. {item.partner.name}</span>
                      <span className="font-mono font-bold text-forest-900">{formatRupees(item.totalValue)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10px] text-ink-500">
                      <span>{item.partner.code}</span>
                      <span>{item.orderCount} order(s)</span>
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

        <section className="rounded-lg border border-kraft-200 bg-white lg:col-span-2">
          <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">RECENT ACTIVITY</div>
          <div className="flex flex-col divide-y divide-kraft-100 px-5">
            {activities.length === 0 ? (
              <p className="py-5 text-xs text-ink-500">Nothing has happened yet.</p>
            ) : (
              activities.map((act) => (
                <div key={act.id} className="flex items-start justify-between py-2.5 text-xs">
                  <div>
                    <div className="font-bold text-ink-900">{act.title}</div>
                    <div className="text-ink-500">{act.subtitle}</div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1 pl-3">
                    {act.badge && <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${act.badgeColor}`}>{act.badge}</span>}
                    <span className="text-[10px] text-ink-400">{new Date(act.time).toLocaleDateString('en-GB')} {new Date(act.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <section className="rounded-lg border border-kraft-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-kraft-100 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-bold text-forest-900">WORK ORDERS</div>
            <p className="text-xs text-ink-500">Showing {filteredOrders.length} of {workOrders.length}.</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { id: 'all', label: 'All' }, { id: 'active', label: 'Active' },
              { id: 'pending_finance_approval', label: 'Pending Approval' }, { id: 'in_production', label: 'In Production' },
              { id: 'ready_for_dispatch', label: 'Finished Goods' }, { id: 'completed', label: 'Completed' },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setStatusFilter(f.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-bold ${statusFilter === f.id ? 'bg-forest-700 text-white' : 'bg-kraft-100 text-ink-700 hover:bg-kraft-200'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto p-5">
          <table className="w-full text-xs">
            <thead className="bg-kraft-100 text-left font-bold uppercase text-ink-900">
              <tr>
                <th className="px-2 py-2">WO #</th><th className="px-2 py-2">Vendor</th><th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Status</th><th className="px-2 py-2 text-right">Ordered</th>
                <th className="px-2 py-2 text-right">Produced</th><th className="px-2 py-2 text-right">QC Approved</th>
                <th className="px-2 py-2 text-right">Value</th><th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {filteredOrders.length === 0 ? (
                <tr><td colSpan={9} className="px-2 py-8 text-center text-ink-500">No Work Orders match this filter.</td></tr>
              ) : (
                filteredOrders.slice(0, 15).map((wo) => (
                  <tr key={wo.id} className="border-t border-kraft-100 hover:bg-kraft-50">
                    <td className="px-2 py-2 font-mono font-bold text-forest-800">
                      <Link href={`/work-orders/detail?id=${wo.id}`} className="hover:underline">{wo.wo_number ?? '(draft)'}</Link>
                      {wo.revision > 0 && <span className="ml-1 text-[10px] font-bold text-amber-700">R{wo.revision}</span>}
                    </td>
                    <td className="px-2 py-2">{wo.partner?.name ?? '—'}</td>
                    <td className="px-2 py-2 text-ink-600">{new Date(wo.wo_date).toLocaleDateString('en-GB')}</td>
                    <td className="px-2 py-2"><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_BADGE_CLASS[wo.status]}`}>{STATUS_LABEL[wo.status]}</span></td>
                    <td className="px-2 py-2 text-right font-mono">{wo.totalOrderedQty}</td>
                    <td className="px-2 py-2 text-right font-mono">{wo.totalProducedQty}</td>
                    <td className="px-2 py-2 text-right font-mono font-bold text-emerald-700">{wo.totalAcceptedQty}</td>
                    <td className="px-2 py-2 text-right font-mono font-bold">{formatRupees(wo.orderTotal ?? 0)}</td>
                    <td className="px-2 py-2 text-right"><Link href={`/work-orders/detail?id=${wo.id}`} className="rounded-md border border-kraft-300 bg-white px-2 py-1 text-[10px] font-bold text-forest-800 hover:bg-kraft-50">View</Link></td>
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

function Tile({ label, value, hint, href }: { label: string; value: string; hint: string; href?: string }) {
  const body = (
    <div className={`flex flex-col justify-between rounded-lg border border-kraft-200 bg-white px-4 py-3 ${href ? 'hover:border-forest-400' : ''}`}>
      <div>
        <div className="text-[11px] font-bold uppercase tracking-wide text-ink-500">{label}</div>
        <div className="mt-1 font-mono text-2xl font-bold text-forest-900">{value}</div>
      </div>
      <div className="mt-2 truncate text-[11px] text-ink-500">{hint}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function AttentionColumn({
  title, count, href, cta, badgeClass, empty, rows,
}: {
  title: string; count: number; href: string; cta: string; badgeClass: string; empty: string;
  rows: { id: string; main: string; sub: string }[];
}) {
  return (
    <div className="rounded-md border border-kraft-200 bg-kraft-50 p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-ink-900">{title}</span>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${badgeClass}`}>{count}</span>
      </div>
      <div className="mt-2.5 flex flex-col gap-2">
        {rows.length === 0 ? (
          <div className="py-3 text-center text-xs text-ink-400">{empty}</div>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between rounded-md border border-kraft-200 bg-white p-2 text-xs">
              <div>
                <div className="font-mono font-bold text-ink-900">{r.main}</div>
                <div className="text-[10px] text-ink-500">{r.sub}</div>
              </div>
              <Link href={href} className="rounded-md border border-kraft-300 bg-white px-2 py-1 text-[10px] font-bold text-forest-800 hover:bg-kraft-50">{cta}</Link>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
