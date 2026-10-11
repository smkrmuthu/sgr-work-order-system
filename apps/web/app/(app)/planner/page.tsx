'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { STATUS_LABEL } from '@/lib/statusLabels';
import type { WorkOrder, WorkOrderLine, Shift, Supervisor, CompletionDateChange, ProductionOutputLine, QcSubmission, QcRejectReason } from '@sgr/types';

interface LogEntry {
  id: string;
  production_date: string;
  created_at: string;
  labour_count: number | null;
  shift?: { name: string } | null;
  supervisor?: { name: string } | null;
  planner?: { full_name: string | null } | null;
  production_output_lines?: { qty: number; actual_weight_kg: number }[];
}
interface DateChange extends CompletionDateChange { by?: { full_name: string | null } | null }

interface LineRow extends WorkOrderLine {
  produced: number;
  sentToQc: number;
  tolMax: number;        // % above the standard one unit may weigh (Item Master)
  tolMin: number | null; // % below it (null = no lower limit)
  prodRejPending: number; // units rejected at production, still waiting for Finance/MD
}

export default function PlannerPage() {
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [lines, setLines] = useState<LineRow[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [supervisors, setSupervisors] = useState<Supervisor[]>([]);
  const [supervisorId, setSupervisorId] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [reasons, setReasons] = useState<QcRejectReason[]>([]);
  const [rejecting, setRejecting] = useState<{ lineId: string; reasonId: string; comment: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [dateChanges, setDateChanges] = useState<DateChange[]>([]);
  const [error, setError] = useState('');

  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [shiftId, setShiftId] = useState('');
  const [labour, setLabour] = useState('6');
  const [entryValues, setEntryValues] = useState<Record<string, { qty: string; unitG: string; note: string }>>({});
  const [submitting, setSubmitting] = useState(false);

  const [newCompletionDate, setNewCompletionDate] = useState('');
  const [editingDate, setEditingDate] = useState(false);
  const [dateReason, setDateReason] = useState('');

  const selected = orders.find((o) => o.id === selectedId) ?? null;

  const loadOrders = useCallback(async () => {
    // pending_finance_approval is excluded too: production can't be recorded until Finance approves.
    const { data } = await supabase.from('work_orders').select('*')
      .not('status', 'in', '("draft","pending_finance_approval","completed","cancelled")').order('created_at');
    setOrders(data ?? []);
    // The Dashboard's "Open in Planner" link arrives with ?id=<work order>.
    const wanted = new URLSearchParams(window.location.search).get('id');
    if (!selectedId && data && data.length) setSelectedId(data.find((o) => o.id === wanted)?.id ?? data[0]!.id);
  }, [selectedId]);

  const loadLines = useCallback(async (woId: string) => {
    const { data: ls } = await supabase.from('work_order_lines').select('*').eq('work_order_id', woId).order('line_no');
    const lineIds = (ls ?? []).map((l) => l.id);
    const partIds = [...new Set((ls ?? []).map((l) => l.part_id).filter((x): x is string => !!x))];
    const [{ data: prod }, { data: sub }, { data: partRows }, { data: rejRows }] = await Promise.all([
      lineIds.length ? supabase.from('production_output_lines').select('*').in('work_order_line_id', lineIds) : Promise.resolve({ data: [] as ProductionOutputLine[] }),
      lineIds.length ? supabase.from('qc_submissions').select('*').in('work_order_line_id', lineIds) : Promise.resolve({ data: [] as QcSubmission[] }),
      partIds.length ? supabase.from('parts').select('id, weight_tol_max_pct, weight_tol_min_pct').in('id', partIds) : Promise.resolve({ data: [] as { id: string; weight_tol_max_pct: number; weight_tol_min_pct: number | null }[] }),
      lineIds.length ? supabase.from('qc_rejections').select('work_order_line_id, qty, decisions:qc_rejection_decisions(qty)').in('work_order_line_id', lineIds).eq('source', 'production').eq('status', 'awaiting_decision') : Promise.resolve({ data: [] as any[] }),
    ]);
    const tol = new Map((partRows ?? []).map((r) => [r.id, r]));
    setLines((ls ?? []).map((l) => ({
      ...l,
      produced: (prod ?? []).filter((p) => p.work_order_line_id === l.id).reduce((n, p) => n + Number(p.qty), 0),
      sentToQc: (sub ?? []).filter((s) => s.work_order_line_id === l.id).reduce((n, s) => n + Number(s.qty), 0),
      prodRejPending: (rejRows ?? []).filter((r: any) => r.work_order_line_id === l.id)
        .reduce((n: number, r: any) => n + Number(r.qty) - (r.decisions ?? []).reduce((m: number, d: any) => m + Number(d.qty), 0), 0),
      tolMax: Number(tol.get(l.part_id ?? '')?.weight_tol_max_pct ?? 15),
      tolMin: tol.get(l.part_id ?? '')?.weight_tol_min_pct != null ? Number(tol.get(l.part_id ?? '')!.weight_tol_min_pct) : null,
    })));
  }, []);

  // Production entries and completion-date changes recorded against the selected order.
  const loadHistory = useCallback(async (woId: string) => {
    const [{ data: entries }, { data: changes }] = await Promise.all([
      supabase.from('production_entries')
        .select('id, production_date, created_at, labour_count, shift:shifts(name), supervisor:supervisors(name), planner:users(full_name), production_output_lines(qty, actual_weight_kg)')
        .eq('work_order_id', woId).order('created_at', { ascending: false }),
      supabase.from('completion_date_changes').select('*, by:users(full_name)').eq('work_order_id', woId).order('changed_at', { ascending: false }),
    ]);
    setLog((entries ?? []) as unknown as LogEntry[]);
    setDateChanges((changes ?? []) as unknown as DateChange[]);
  }, []);

  useEffect(() => { supabase.from('qc_reject_reasons').select('*').eq('is_active', true).order('name').then(({ data }) => setReasons(data ?? [])); }, []);
  useEffect(() => { supabase.from('supervisors').select('*').eq('is_active', true).order('name').then(({ data }) => setSupervisors(data ?? [])); }, []);
  useEffect(() => { loadOrders(); supabase.from('shifts').select('*').order('code').then(({ data }) => { setShifts(data ?? []); if (data?.length) setShiftId(data[0]!.id); }); }, [loadOrders]);
  useEffect(() => { if (selectedId) { loadLines(selectedId); loadHistory(selectedId); } }, [selectedId, loadLines, loadHistory]);

  // Weight of one unit is typed in grams. It is required, and may not be more than 15% above the part's standard
  // weight (the database enforces the same rule). Returns a message, or null when fine.
  const stdG = (l: LineRow) => Number(l.standard_weight_kg_snapshot || 0) * 1000;
  const maxUnitG = (l: LineRow) => stdG(l) * (1 + l.tolMax / 100);
  const minUnitG = (l: LineRow) => (l.tolMin != null ? stdG(l) * (1 - l.tolMin / 100) : 0);
  function unitWeightProblem(l: LineRow, unitG: string): string | null {
    const g = Number(unitG);
    if (!unitG.trim() || !(g > 0)) return 'enter the weight of one unit (in grams).';
    if (stdG(l) > 0 && g > maxUnitG(l)) return `one unit weighs ${g} g, more than ${l.tolMax}% above the standard ${stdG(l).toFixed(0)} g (limit ${maxUnitG(l).toFixed(0)} g). It cannot be recorded.`;
    if (stdG(l) > 0 && l.tolMin != null && g < minUnitG(l)) return `one unit weighs ${g} g, more than ${l.tolMin}% below the standard ${stdG(l).toFixed(0)} g (minimum ${minUnitG(l).toFixed(0)} g). It cannot be recorded.`;
    return null;
  }

  // Units that fail the weight limit cannot go through the daily entry. They are rejected at production instead:
  // they skip QC and wait for Finance/MD to scrap them or have them re-produced.
  async function rejectAtProduction(l: LineRow) {
    if (!rejecting || rejecting.lineId !== l.id) return;
    const v = entryValues[l.id];
    if (!rejecting.reasonId) { setError('Choose the reason for rejecting these units.'); return; }
    setError(''); setNotice('');
    const { error } = await supabase.rpc('record_production_reject', {
      p_work_order_line_id: l.id, p_qty: Number(v?.qty), p_unit_weight_g: Number(v?.unitG),
      p_reason_id: rejecting.reasonId, p_comment: rejecting.comment.trim() || null,
    });
    if (error) { setError(error.message); return; }
    setNotice(`${v?.qty} unit(s) of ${l.part_no_snapshot} rejected at production. Finance and the MD will decide to scrap or re-produce them.`);
    setRejecting(null);
    setEntryValues((s) => { const n = { ...s }; delete n[l.id]; return n; });
    loadLines(l.work_order_id);
  }

  async function submitEntry() {
    if (!selected) return;
    if (!supervisorId) { setError('Choose the Supervisor for this production entry.'); return; }
    const entered = lines.filter((l) => entryValues[l.id]?.qty);
    if (entered.length === 0) { setError('Enter the quantity produced for at least one line.'); return; }
    for (const l of entered) {
      const bad = unitWeightProblem(l, entryValues[l.id]!.unitG);
      if (bad) { setError(`${l.part_no_snapshot}: ${bad}`); return; }
    }
    setSubmitting(true); setError('');
    const payload = {
      work_order_id: selected.id, production_date: entryDate, shift_id: shiftId, supervisor_id: supervisorId, labour_count: Number(labour),
      lines: lines.filter((l) => entryValues[l.id]?.qty).map((l) => ({
        work_order_line_id: l.id, qty: Number(entryValues[l.id]!.qty),
        unit_weight_g: Number(entryValues[l.id]!.unitG), note: entryValues[l.id]!.note,
      })),
    };
    const { error } = await supabase.rpc('record_production', { p: payload });
    setSubmitting(false);
    if (error) { setError(error.message); return; }
    setEntryValues({});
    loadLines(selected.id); loadOrders(); loadHistory(selected.id);
  }

  async function sendToQc(lineId: string) {
    setError('');
    const { error } = await supabase.rpc('send_line_to_qc', { p_work_order_line_id: lineId });
    if (error) { setError(error.message); return; }
    loadLines(selected!.id); loadOrders();
  }

  async function saveCompletionDate() {
    if (!selected) return;
    setError('');
    if (!newCompletionDate) { setError('Choose a date.'); return; }
    if (newCompletionDate === selected.expected_completion_date) { setEditingDate(false); return; }
    // The first date needs no reason; changing a date that is already set always does (the database enforces it too).
    if (selected.expected_completion_date && !dateReason.trim()) { setError('Please give a reason for changing the Planned Completion Date.'); return; }
    const { error } = await supabase.rpc('set_completion_date', { p_work_order_id: selected.id, p_date: newCompletionDate, p_reason: dateReason.trim() || null });
    if (error) { setError(error.message); return; }
    setEditingDate(false); setDateReason('');
    loadOrders(); loadHistory(selected.id);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold text-forest-900">Production Planner</h1>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="input max-w-xs">
          {orders.map((o) => <option key={o.id} value={o.id}>{o.wo_number} — {STATUS_LABEL[o.status]}</option>)}
        </select>
      </div>
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}</div>}
      {!selected && <p className="text-sm text-ink-500">Nothing in the ready-for-production queue.</p>}

      {selected && (
        <>
          <section className="rounded-lg border border-kraft-200 bg-white p-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-bold text-ink-700">Planned Completion Date:</span>
              {!editingDate ? (
                <>
                  <span className="font-bold">{selected.expected_completion_date ?? '—'}</span>
                  <button onClick={() => { setEditingDate(true); setError(''); setDateReason(''); setNewCompletionDate(''); }} className="btn-secondary !px-2 !py-1">
                    {selected.expected_completion_date ? 'Change' : 'Set date'}
                  </button>
                </>
              ) : (
                <div className="flex w-full flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs font-bold text-ink-700">Current:</span>
                    <span className="font-bold">{selected.expected_completion_date ?? 'not set'}</span>
                    <span className="text-ink-300">→</span>
                    <span className="text-xs font-bold text-ink-700">New date:</span>
                    <input type="date" min={new Date().toISOString().slice(0, 10)} value={newCompletionDate} onChange={(e) => setNewCompletionDate(e.target.value)} className="input w-auto" />
                    {selected.expected_completion_date && newCompletionDate && newCompletionDate !== selected.expected_completion_date && (
                      <span className="rounded-md bg-amber-50 px-2 py-1 font-mono text-xs font-bold text-amber-900">
                        {selected.expected_completion_date} → {newCompletionDate}
                      </span>
                    )}
                  </div>
                  {selected.expected_completion_date && (
                    <div className="max-w-xl">
                      <label className="mb-1 block text-[11px] font-bold text-ink-700">Reason for the change *</label>
                      <input value={dateReason} onChange={(e) => setDateReason(e.target.value)} placeholder="Why is the completion date changing?" className="input" />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button onClick={() => setEditingDate(false)} className="btn-secondary !px-2 !py-1">Cancel</button>
                    <button onClick={saveCompletionDate} className="btn-primary !px-2 !py-1">Save</button>
                  </div>
                </div>
              )}
            </div>
            {dateChanges.length > 0 && (
              <div className="mt-4 border-t border-kraft-100 pt-3">
                <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-500">Completion date history</div>
                <ul className="flex flex-col gap-1 text-xs">
                  {dateChanges.map((c) => (
                    <li key={c.id}>
                      <span className="font-mono font-bold">{c.from_date ?? 'not set'} → {c.to_date}</span>
                      {c.reason ? <> · {c.reason}</> : <span className="text-ink-500"> · first date set</span>}
                      <span className="text-ink-500"> · {c.by?.full_name ?? 'Unknown'}, {new Date(c.changed_at).toLocaleString('en-IN')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-kraft-200 bg-white">
            <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">ITEM PROGRESS</div>
            <div className="overflow-x-auto p-5">
              <table className="w-full text-xs">
                <thead className="bg-kraft-100 text-left font-bold uppercase text-ink-900">
                  <tr><th className="px-2 py-2">Part #</th><th className="px-2 py-2">Ordered</th><th className="px-2 py-2">Produced</th><th className="px-2 py-2">Sent to QC</th><th /></tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const unsent = l.produced - l.sentToQc;
                    return (
                      <tr key={l.id} className="border-t border-kraft-100">
                        <td className="px-2 py-2 font-mono font-bold">
                          {l.part_no_snapshot}
                          {l.replaces_line_id && <span className="ml-2 rounded-full bg-blue-100 px-1.5 py-px font-sans text-[10px] text-blue-800">Re-produce</span>}
                          {l.short_closed_qty > 0 && <span className="ml-2 rounded-full bg-rose-100 px-1.5 py-px font-sans text-[10px] text-rose-800">{l.short_closed_qty} written off</span>}
                          {l.prodRejPending > 0 && <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-px font-sans text-[10px] text-amber-800">{l.prodRejPending} rejected, awaiting decision</span>}
                        </td>
                        <td className="px-2 py-2 font-mono">{l.qty}</td>
                        <td className="px-2 py-2 font-mono">{l.produced}</td>
                        <td className="px-2 py-2 font-mono">{l.sentToQc}</td>
                        <td className="px-2 py-2">
                          {unsent > 0
                            ? <button onClick={() => sendToQc(l.id)} className="btn-secondary !px-2 !py-1">Send {unsent} to QC</button>
                            : <span className="text-ink-300">Nothing to send</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-kraft-200 bg-white">
            <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">RECORD TODAY&rsquo;S PRODUCTION</div>
            <div className="p-5">
              <div className="mb-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
                <Field label="Production Date"><input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className="input" /></Field>
                <Field label="Shift">
                  <select value={shiftId} onChange={(e) => setShiftId(e.target.value)} className="input">
                    {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Supervisor *">
                  <select value={supervisorId} onChange={(e) => setSupervisorId(e.target.value)} className="input">
                    <option value="">{supervisors.length ? 'Select supervisor…' : 'No supervisors yet'}</option>
                    {supervisors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {supervisors.length === 0 && <div className="mt-1 text-[10px] text-ink-500">Ask the MD to add supervisors in Item Master → Supervisors.</div>}
                </Field>
                <Field label="Labour Count"><input type="number" value={labour} onChange={(e) => setLabour(e.target.value)} className="input" /></Field>
              </div>
              {lines.map((l) => {
                const remaining = l.qty - l.short_closed_qty - l.prodRejPending - l.produced;
                const v = entryValues[l.id] ?? { qty: '', unitG: '', note: '' };
                const stdWeight = Number(l.standard_weight_kg_snapshot || 0);
                const qtyN = Number(v.qty);
                const unitN = Number(v.unitG);
                const actualTotal = qtyN > 0 && unitN > 0 ? ((qtyN * unitN) / 1000).toFixed(2) : '';
                const stdTotal = qtyN > 0 ? (qtyN * stdWeight).toFixed(2) : '';
                const problem = v.qty && v.unitG ? unitWeightProblem(l, v.unitG) : null;
                const maxG = maxUnitG(l);
                return (
                  <div key={l.id} className="flex flex-wrap items-start gap-3 border-b border-kraft-100 py-3 last:border-none">
                    <div className="min-w-[200px] flex-1 pt-5 text-xs">
                      <div className="font-bold">{l.part_no_snapshot} — {l.description_snapshot}</div>
                      <div className="text-ink-500">{remaining} remaining of {l.qty} {stdWeight > 0 ? `· Std wt: ${stdWeight} kg/unit (${(stdWeight * 1000).toFixed(0)} g)` : ''}</div>
                    </div>
                    {remaining > 0 ? (
                      <>
                        <Field label="Qty Produced"><input type="number" value={v.qty} onChange={(e) => setEntryValues((s) => ({ ...s, [l.id]: { ...v, qty: e.target.value } }))} className="input w-28" /></Field>
                        <Field label="Weight of 1 unit (g) *">
                          <input type="number" step="0.01" min={0} value={v.unitG} onChange={(e) => setEntryValues((s) => ({ ...s, [l.id]: { ...v, unitG: e.target.value } }))}
                            className={`input w-36 ${problem ? '!border-rose-400 !bg-rose-50' : ''}`} />
                          {maxG > 0 && <div className="mt-1 text-[10px] text-ink-500">{l.tolMin != null ? `${minUnitG(l).toFixed(0)} – ` : 'Max '}{maxG.toFixed(0)} g (std {l.tolMin != null ? `−${l.tolMin}% / ` : ''}+{l.tolMax}%)</div>}
                        </Field>
                        <Field label="Actual Total Weight (kg)">
                          <input type="text" readOnly disabled value={actualTotal} placeholder="0.00" className="input w-36 font-mono disabled:bg-kraft-100 disabled:text-ink-700 disabled:cursor-not-allowed" />
                          <div className="mt-1 text-[10px] text-ink-500">Qty × weight of 1 unit</div>
                        </Field>
                        <Field label="Standard Weight (kg)">
                          <input type="text" readOnly disabled value={stdTotal} placeholder="0.00" className="input w-32 font-mono disabled:bg-kraft-100 disabled:text-ink-500 disabled:cursor-not-allowed" />
                        </Field>
                        <Field label="Note"><input value={v.note} onChange={(e) => setEntryValues((s) => ({ ...s, [l.id]: { ...v, note: e.target.value } }))} className="input" /></Field>
                        {problem && (
                          <div className="basis-full rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                            <div className="font-bold">{problem}</div>
                            {rejecting?.lineId === l.id ? (
                              <div className="mt-2 flex flex-wrap items-end gap-2">
                                <div>
                                  <label className="mb-1 block text-[11px] font-bold">Reason *</label>
                                  <select value={rejecting.reasonId} onChange={(e) => setRejecting({ ...rejecting, reasonId: e.target.value })} className="input w-52">
                                    <option value="">Select reason…</option>
                                    {reasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                                  </select>
                                </div>
                                <div className="min-w-[180px] flex-1">
                                  <label className="mb-1 block text-[11px] font-bold">Comment</label>
                                  <input value={rejecting.comment} onChange={(e) => setRejecting({ ...rejecting, comment: e.target.value })} className="input" />
                                </div>
                                <button onClick={() => rejectAtProduction(l)} className="btn-primary !bg-rose-700 hover:!bg-rose-800">Reject {v.qty} unit(s)</button>
                                <button onClick={() => setRejecting(null)} className="btn-secondary">Cancel</button>
                              </div>
                            ) : (
                              <button
                                onClick={() => { setRejecting({ lineId: l.id, reasonId: reasons.find((r) => /weight/i.test(r.name) && (unitN > stdG(l) ? /over/i : /under/i).test(r.name))?.id ?? '', comment: '' }); }}
                                className="mt-2 rounded-md border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-bold text-rose-800 hover:bg-rose-100">
                                Reject these {v.qty} unit(s) instead
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    ) : <span className="pt-5 text-xs font-bold text-emerald-600">✓ Fully produced</span>}
                  </div>
                );
              })}
              <div className="mt-4 flex justify-end">
                <button onClick={submitEntry} disabled={submitting} className="btn-primary">{submitting ? 'Saving…' : 'Save Daily Entry'}</button>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-kraft-200 bg-white">
            <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">PRODUCTION LOG</div>
            <div className="overflow-x-auto p-5">
              <table className="w-full text-xs">
                <thead className="bg-kraft-100 text-left font-bold uppercase text-ink-900">
                  <tr><th className="px-2 py-2">Date</th><th className="px-2 py-2">Shift</th><th className="px-2 py-2">Supervisor</th><th className="px-2 py-2">Labour</th><th className="px-2 py-2">Qty Produced</th><th className="px-2 py-2">Actual Weight (kg)</th><th className="px-2 py-2">Recorded by</th></tr>
                </thead>
                <tbody>
                  {log.length === 0 && <tr><td colSpan={7} className="px-2 py-6 text-center text-ink-500">Nothing recorded yet.</td></tr>}
                  {log.map((e) => (
                    <tr key={e.id} className="border-t border-kraft-100">
                      <td className="px-2 py-2 font-mono">{e.production_date}</td>
                      <td className="px-2 py-2">{e.shift?.name ?? '—'}</td>
                      <td className="px-2 py-2">{e.supervisor?.name ?? <span className="text-ink-300">—</span>}</td>
                      <td className="px-2 py-2 font-mono">{e.labour_count ?? '—'}</td>
                      <td className="px-2 py-2 font-mono">{(e.production_output_lines ?? []).reduce((n, o) => n + Number(o.qty), 0)}</td>
                      <td className="px-2 py-2 font-mono">{(e.production_output_lines ?? []).reduce((n, o) => n + Number(o.actual_weight_kg || 0), 0).toFixed(2)}</td>
                      <td className="px-2 py-2">{e.planner?.full_name ?? '—'} <span className="text-ink-500">· {new Date(e.created_at).toLocaleString('en-IN')}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="mb-1 block text-[11px] font-bold text-ink-700">{label}</label>{children}</div>;
}
