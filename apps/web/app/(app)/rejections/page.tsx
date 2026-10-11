'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import type { QcRejection, QcRejectionDecision } from '@sgr/types';

// Units QC (or the Planner, at production) rejected. Finance and the MD decide, per quantity:
//   Scrap       the units are written off and can never be billed; the order needs that many fewer.
//   Re-produce  the units are written off AND a replacement line for the same quantity is added to the order,
//               at its own price and, optionally, with a new delivery date for the order.
// Every decision is permanent and opens a numbered revision of the order. (db/migrations/025_qc_rejections.sql)

interface Row extends QcRejection {
  reason: { name: string } | null;
  recorder: { full_name: string | null; email: string } | null;
  decisions: (QcRejectionDecision & { decider: { full_name: string | null; email: string } | null; replacement: { line_no: number } | null })[];
  line: {
    part_no_snapshot: string; description_snapshot: string; final_price: number; line_no: number;
    work_order: { id: string; wo_number: string | null; delivery_date: string | null; partner: { name: string } | null } | null;
  } | null;
}

const fmtDate = (s: string) => new Date(s).toLocaleString('en-IN');

export default function RejectionsPage() {
  const { profile } = useAuth();
  const canDecide = profile?.role === 'finance' || profile?.role === 'md' || profile?.role === 'admin';
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('qc_rejections')
      .select(`*, reason:qc_reject_reasons(name), recorder:users!recorded_by(full_name, email),
        decisions:qc_rejection_decisions(*, decider:users!decided_by(full_name, email), replacement:work_order_lines!replacement_line_id(line_no)),
        line:work_order_lines(part_no_snapshot, description_snapshot, final_price, line_no,
          work_order:work_orders(id, wo_number, delivery_date, partner:business_partners(name)))`)
      .neq('status', 'withdrawn')
      .order('recorded_at', { ascending: false });
    if (error) { setError(error.message); setRows([]); return; }
    setRows((data ?? []) as unknown as Row[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  const open = useMemo(() => (rows ?? []).filter((r) => r.status === 'awaiting_decision'), [rows]);
  const done = useMemo(() => (rows ?? []).filter((r) => r.status === 'decided' || r.decisions.length > 0), [rows]);
  const shown = tab === 'open' ? open : done;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold text-forest-900">Rejections</h1>
        <p className="text-sm text-ink-500">
          Units QC or the Planner rejected. {canDecide ? 'Decide for each: scrap them, or re-produce them as a replacement.' : 'Finance and the MD decide what happens to them.'}
        </p>
      </div>

      <div className="flex gap-1 border-b border-kraft-200">
        {([['open', `Awaiting decision (${open.length})`], ['done', `Decided (${done.length})`]] as const).map(([t, label]) => (
          <button key={t} onClick={() => { setTab(t); setError(''); setMessage(''); }}
            className={`border-b-2 px-3 py-2 text-xs font-bold uppercase tracking-wide ${tab === t ? 'border-forest-600 text-forest-900' : 'border-transparent text-ink-500'}`}>{label}</button>
        ))}
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}
      {message && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{message}</div>}
      {rows === null && <p className="text-sm text-ink-500">Loading…</p>}
      {rows !== null && shown.length === 0 && <p className="text-sm text-ink-500">{tab === 'open' ? 'Nothing is waiting for a decision.' : 'No decisions yet.'}</p>}

      {shown.map((r) => (
        <RejectionCard key={r.id} r={r} canDecide={canDecide && tab === 'open'} onError={setError}
          onDone={(m) => { setMessage(m); setError(''); load(); }} />
      ))}
    </div>
  );
}

function RejectionCard({ r, canDecide, onError, onDone }: { r: Row; canDecide: boolean; onError: (m: string) => void; onDone: (m: string) => void }) {
  const decidedQty = r.decisions.reduce((n, d) => n + Number(d.qty), 0);
  const openQty = Number(r.qty) - decidedQty;
  const wo = r.line?.work_order;
  const [action, setAction] = useState<'scrap' | 'reproduce'>('scrap');
  const [qty, setQty] = useState(String(openQty));
  const [note, setNote] = useState('');
  const [price, setPrice] = useState(String(r.line?.final_price ?? ''));
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  async function submit() {
    onError('');
    const q = Number(qty);
    if (!(q > 0) || q > openQty) { onError(`Quantity must be between 1 and ${openQty}.`); return; }
    if (!note.trim()) { onError('Please add a note explaining the decision.'); return; }
    if (action === 'reproduce' && price.trim() !== '' && !(Number(price) >= 0)) { onError('Price must be a number, 0 or more.'); return; }
    setBusy(true);
    const { error } = await supabase.rpc('decide_rejection', {
      p_rejection_id: r.id, p_action: action, p_qty: q, p_note: note.trim(),
      p_new_price: action === 'reproduce' && price.trim() !== '' ? Number(price) : null,
      p_new_delivery_date: action === 'reproduce' && date ? date : null,
    });
    setBusy(false);
    if (error) { onError(error.message); return; }
    onDone(action === 'scrap'
      ? `${q} unit(s) scrapped. They will not be billed.`
      : `${q} unit(s) will be re-produced: a replacement line was added to ${wo?.wo_number ?? 'the order'}.`);
  }

  return (
    <section className="rounded-lg border border-kraft-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-kraft-100 px-5 py-3">
        <div>
          <span className="font-mono text-sm font-bold">{r.line?.part_no_snapshot}</span>
          <span className="ml-2 text-xs text-ink-500">{r.line?.description_snapshot}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {wo && <Link href={`/work-orders/detail?id=${wo.id}`} className="font-mono font-bold text-forest-800 hover:underline">{wo.wo_number}</Link>}
          <span className="text-ink-500">{wo?.partner?.name}</span>
          <span className={`rounded-full px-2 py-0.5 font-bold ${r.source === 'qc' ? 'bg-amber-100 text-amber-800' : 'bg-violet-100 text-violet-800'}`}>
            {r.source === 'qc' ? 'Rejected by QC' : 'Rejected at production'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
        <Info label="Rejected" value={`${r.qty} unit(s)`} />
        <Info label="Reason" value={r.reason?.name ?? '—'} />
        <Info label="Recorded by" value={`${r.recorder?.full_name ?? r.recorder?.email ?? '—'} · ${fmtDate(r.recorded_at)}`} />
        <Info label={r.unit_weight_g ? 'Weight of one unit' : 'Still to decide'} value={r.unit_weight_g ? `${r.unit_weight_g} g` : `${openQty} unit(s)`} />
      </div>
      {r.comment && <div className="px-5 pb-4 text-[13px]"><span className="text-[11px] font-semibold text-ink-500">Comment: </span>{r.comment}</div>}

      {r.decisions.length > 0 && (
        <ul className="mx-5 mb-4 flex flex-col gap-1.5 rounded-md border border-kraft-200 bg-kraft-50 p-3 text-[13px]">
          {r.decisions.map((d) => (
            <li key={d.id}>
              <b>{d.action === 'scrap' ? `Scrapped ${d.qty}` : `Re-produce ${d.qty}`}</b>
              {d.action === 'reproduce' && <> · replacement line {d.replacement?.line_no ?? '—'}{d.new_price != null ? ` at ₹${Number(d.new_price).toFixed(2)}` : ''}{d.new_delivery_date ? ` · new delivery date ${d.new_delivery_date}` : ''}</>}
              {' '}— {d.note}
              <span className="text-ink-500"> · {d.decider?.full_name ?? d.decider?.email ?? 'Unknown'}, {fmtDate(d.decided_at)}</span>
            </li>
          ))}
        </ul>
      )}

      {canDecide && openQty > 0 && (
        <div className="border-t border-kraft-100 bg-kraft-50 px-5 py-4">
          <div className="mb-3 flex gap-2">
            {(['scrap', 'reproduce'] as const).map((a) => (
              <button key={a} onClick={() => setAction(a)}
                className={`rounded-md border px-3 py-1.5 text-xs font-bold ${action === a ? 'border-forest-600 bg-forest-700 text-white' : 'border-kraft-300 bg-white text-ink-700 hover:bg-kraft-100'}`}>
                {a === 'scrap' ? 'Scrap' : 'Re-produce'}
              </button>
            ))}
          </div>
          <p className="mb-3 text-xs text-ink-500">
            {action === 'scrap'
              ? 'The units are written off and will never be billed. The order then needs that many fewer to complete.'
              : 'The units are written off and a replacement line for the same quantity is added to the order and sent to production. Billing uses the price below for those units only.'}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label={`Quantity (max ${openQty})`}><input type="number" min={1} max={openQty} value={qty} onChange={(e) => setQty(e.target.value)} className="input" /></Field>
            {action === 'reproduce' && (
              <>
                <Field label="Price per unit of the replacement (₹)"><input type="number" min={0} step="any" value={price} onChange={(e) => setPrice(e.target.value)} className="input" /></Field>
                <Field label={`New delivery date (now ${wo?.delivery_date ?? '—'})`}><input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} className="input" /></Field>
              </>
            )}
            <div className={action === 'reproduce' ? 'col-span-2 sm:col-span-4' : 'col-span-2'}>
              <Field label="Note * (why this decision)"><input value={note} onChange={(e) => setNote(e.target.value)} className="input" /></Field>
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <button onClick={submit} disabled={busy} className="btn-primary">{busy ? 'Saving…' : action === 'scrap' ? 'Confirm Scrap' : 'Confirm Re-produce'}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[11px] font-semibold text-ink-500">{label}</div><div className="text-sm font-bold">{value}</div></div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="mb-1 block text-[11px] font-bold text-ink-700">{label}</label>{children}</div>;
}
