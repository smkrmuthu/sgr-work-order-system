'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Category, Part } from '@sgr/types';

// Master Creator / MD / Admin (see NAV in the layout). The database enforces the same rule: the
// master-data tables are writable only by those roles (db/migrations/002_rls.sql).
// Nothing is hard-deleted: an item or category is deactivated, so old Work Orders keep their history.
// (Work Order lines store a snapshot of the part at selection time — editing an item here never
// rewrites an existing order.)

type PartForm = {
  part_no: string; description: string; uom: string; standard_weight_kg: string;
  category_id: string; price: string; customer_ref: string; remarks: string;
};
const EMPTY_PART: PartForm = {
  part_no: '', description: '', uom: 'NOS', standard_weight_kg: '0', category_id: '', price: '0', customer_ref: '', remarks: '',
};

export default function ItemMasterPage() {
  const [tab, setTab] = useState<'items' | 'categories'>('items');
  const [parts, setParts] = useState<Part[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<PartForm>(EMPTY_PART);
  const [saving, setSaving] = useState(false);

  const [catCode, setCatCode] = useState('');
  const [catName, setCatName] = useState('');
  const [catDesc, setCatDesc] = useState('');

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([
      supabase.from('parts').select('*').order('part_no'),
      supabase.from('categories').select('*').order('code'),
    ]);
    if (p.error) { setError(p.error.message); return; }
    if (c.error) { setError(c.error.message); return; }
    setParts(p.data ?? []);
    setCategories(c.data ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const catName_ = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '—';

  function startNew() { setForm(EMPTY_PART); setEditingId('new'); setError(''); }
  function startEdit(p: Part) {
    setForm({
      part_no: p.part_no, description: p.description, uom: p.uom,
      standard_weight_kg: String(p.standard_weight_kg), category_id: p.category_id ?? '',
      price: String(p.price), customer_ref: p.customer_ref ?? '', remarks: p.remarks ?? '',
    });
    setEditingId(p.id); setError('');
  }

  async function savePart() {
    if (!form.part_no.trim() || !form.description.trim()) { setError('Part number and description are required.'); return; }
    setSaving(true); setError('');
    const row = {
      part_no: form.part_no.trim(), description: form.description.trim(), uom: form.uom.trim() || 'NOS',
      standard_weight_kg: Number(form.standard_weight_kg) || 0, category_id: form.category_id || null,
      price: Number(form.price) || 0, customer_ref: form.customer_ref.trim() || null, remarks: form.remarks.trim() || null,
    };
    const { error } = editingId === 'new'
      ? await supabase.from('parts').insert(row)
      : await supabase.from('parts').update(row).eq('id', editingId!);
    setSaving(false);
    if (error) { setError(/duplicate|unique/i.test(error.message) ? 'That part number already exists.' : error.message); return; }
    setEditingId(null);
    load();
  }

  async function toggleActive(table: 'parts' | 'categories', id: string, is_active: boolean) {
    setError('');
    const { error } = await supabase.from(table).update({ is_active: !is_active }).eq('id', id);
    if (error) { setError(error.message); return; }
    load();
  }

  async function addCategory() {
    if (!catCode.trim() || !catName.trim()) { setError('Category code and name are required.'); return; }
    setError('');
    const { error } = await supabase.from('categories').insert({
      code: catCode.trim(), name: catName.trim(), description: catDesc.trim() || null,
    });
    if (error) { setError(/duplicate|unique/i.test(error.message) ? 'That category code already exists.' : error.message); return; }
    setCatCode(''); setCatName(''); setCatDesc('');
    load();
  }

  const shown = (parts ?? []).filter((p) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return p.part_no.toLowerCase().includes(s) || p.description.toLowerCase().includes(s);
  });
  const set = (k: keyof PartForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-forest-900">Item Master</h1>
          <p className="text-sm text-ink-500">
            Parts and categories offered on Work Orders. Editing an item never changes an existing Work Order —
            each line keeps a snapshot from when it was added.
          </p>
        </div>
        {tab === 'items' && <button onClick={startNew} className="btn-primary">+ Add Item</button>}
      </div>

      <div className="flex gap-1 border-b border-kraft-200">
        {(['items', 'categories'] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); setError(''); }}
            className={`border-b-2 px-3 py-2 text-xs font-bold uppercase tracking-wide ${tab === t ? 'border-forest-600 text-forest-900' : 'border-transparent text-ink-500'}`}>
            {t === 'items' ? `Items (${parts?.length ?? 0})` : `Categories (${categories.length})`}
          </button>
        ))}
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}

      {tab === 'items' && (
        <>
          {editingId && (
            <section className="rounded-lg border border-kraft-200 bg-white p-5">
              <div className="mb-3 text-sm font-bold text-forest-900">{editingId === 'new' ? 'NEW ITEM' : 'EDIT ITEM'}</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Part Number"><input value={form.part_no} onChange={set('part_no')} className="input" /></Field>
                <div className="col-span-2 sm:col-span-3"><Field label="Description"><input value={form.description} onChange={set('description')} className="input" /></Field></div>
                <Field label="Category">
                  <select value={form.category_id} onChange={set('category_id')} className="input">
                    <option value="">— none —</option>
                    {categories.filter((c) => c.is_active || c.id === form.category_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </Field>
                <Field label="UOM"><input value={form.uom} onChange={set('uom')} className="input" /></Field>
                <Field label="Standard Weight (kg)"><input type="number" value={form.standard_weight_kg} onChange={set('standard_weight_kg')} className="input" /></Field>
                <Field label="Standard Price (₹)"><input type="number" value={form.price} onChange={set('price')} className="input" /></Field>
                <Field label="Customer Ref"><input value={form.customer_ref} onChange={set('customer_ref')} className="input" /></Field>
                <div className="col-span-2 sm:col-span-3"><Field label="Remarks"><input value={form.remarks} onChange={set('remarks')} className="input" /></Field></div>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button onClick={() => setEditingId(null)} className="btn-secondary">Cancel</button>
                <button onClick={savePart} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Save Item'}</button>
              </div>
            </section>
          )}

          <input placeholder="Search by part number or description…" value={q} onChange={(e) => setQ(e.target.value)}
            className="w-full max-w-md rounded-md border border-kraft-300 px-3 py-2 text-sm outline-none focus:border-forest-500" />

          <div className="overflow-x-auto rounded-lg border border-kraft-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-kraft-100 text-left text-[11px] font-bold uppercase tracking-wide text-ink-900">
                <tr>
                  <th className="px-3 py-2">Part #</th><th className="px-3 py-2">Description</th><th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">UOM</th><th className="px-3 py-2 text-right">Weight (kg)</th><th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-center">Active</th><th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {parts === null && <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-500">Loading…</td></tr>}
                {parts !== null && shown.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-500">No items found.</td></tr>}
                {shown.map((p) => (
                  <tr key={p.id} className={`border-t border-kraft-100 ${p.is_active ? '' : 'opacity-50'}`}>
                    <td className="px-3 py-2 font-mono font-bold">{p.part_no}</td>
                    <td className="px-3 py-2">{p.description}</td>
                    <td className="px-3 py-2">{catName_(p.category_id)}</td>
                    <td className="px-3 py-2">{p.uom}</td>
                    <td className="px-3 py-2 text-right font-mono">{p.standard_weight_kg}</td>
                    <td className="px-3 py-2 text-right font-mono">₹{Number(p.price).toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2 text-center"><input type="checkbox" checked={p.is_active} onChange={() => toggleActive('parts', p.id, p.is_active)} /></td>
                    <td className="px-3 py-2 text-right"><button onClick={() => startEdit(p)} className="btn-secondary !px-2 !py-1">Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'categories' && (
        <>
          <section className="rounded-lg border border-kraft-200 bg-white p-5">
            <div className="mb-3 text-sm font-bold text-forest-900">NEW CATEGORY</div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Code"><input value={catCode} onChange={(e) => setCatCode(e.target.value)} placeholder="CAT-005" className="input" /></Field>
              <Field label="Name"><input value={catName} onChange={(e) => setCatName(e.target.value)} className="input" /></Field>
              <div className="col-span-2"><Field label="Description"><input value={catDesc} onChange={(e) => setCatDesc(e.target.value)} className="input" /></Field></div>
            </div>
            <div className="mt-3 flex justify-end"><button onClick={addCategory} className="btn-primary">Add Category</button></div>
          </section>

          <div className="overflow-hidden rounded-lg border border-kraft-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-kraft-100 text-left text-[11px] font-bold uppercase tracking-wide text-ink-900">
                <tr><th className="px-3 py-2">Code</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Description</th><th className="px-3 py-2 text-center">Active</th></tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id} className={`border-t border-kraft-100 ${c.is_active ? '' : 'opacity-50'}`}>
                    <td className="px-3 py-2 font-mono font-bold">{c.code}</td>
                    <td className="px-3 py-2">{c.name}</td>
                    <td className="px-3 py-2 text-ink-500">{c.description ?? '—'}</td>
                    <td className="px-3 py-2 text-center"><input type="checkbox" checked={c.is_active} onChange={() => toggleActive('categories', c.id, c.is_active)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-bold text-ink-700">{label}</label>
      {children}
    </div>
  );
}
