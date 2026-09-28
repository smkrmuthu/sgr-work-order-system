'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { manageUsers } from '@/lib/manageUsers';
import type { UserRole } from '@sgr/types';

interface Row {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  is_active: boolean;
  last_sign_in_at: string | null;
}

const ROLE_OPTIONS: UserRole[] = ['creator', 'planner', 'qc', 'finance', 'md', 'admin'];
const ROLE_LABEL: Record<UserRole, string> = {
  creator: 'Master Creator', planner: 'Production Planner', qc: 'Quality Control',
  finance: 'Finance', md: 'Managing Director', admin: 'Admin',
};

// MD/Admin only (see app/(app)/layout.tsx's NAV). Every action here goes through the
// manage-app-users Edge Function, never a direct table write — that's the only place the
// "can't remove the last MD/Admin" and "can't self-delete" safety rails are enforced, and
// creating a login needs the service_role key a browser can never hold. See its own file for why.
export default function UsersPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [notice, setNotice] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('creator');
  const [newPassword, setNewPassword] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const result = await manageUsers<{ users: Row[] }>({ action: 'list' });
    if ('error' in result) { setError(result.error); return; }
    setRows(result.data.users);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function changeRole(id: string, role: UserRole) {
    setBusyId(id); setError('');
    const result = await manageUsers({ action: 'update', id, role });
    setBusyId(null);
    if ('error' in result) { setError(result.error); return; }
    load();
  }

  async function toggleActive(row: Row) {
    setBusyId(row.id); setError('');
    const result = await manageUsers({ action: 'update', id: row.id, is_active: !row.is_active });
    setBusyId(null);
    if ('error' in result) { setError(result.error); return; }
    load();
  }

  async function setPassword(row: Row) {
    if (resetPassword.length < 8) { setError('The new password must be at least 8 characters.'); return; }
    setBusyId(row.id); setError(''); setNotice('');
    const result = await manageUsers({ action: 'update', id: row.id, password: resetPassword });
    setBusyId(null);
    if ('error' in result) { setError(result.error); return; }
    setResetId(null); setResetPassword('');
    setNotice(`Password changed for ${row.email}. Give them the new password — they can sign in with it straight away.`);
  }

  async function remove(row: Row) {
    if (!confirm(`Delete ${row.email}? This removes their login entirely. (If they have already created or approved anything, deleting isn't possible — untick Active instead.)`)) return;
    setBusyId(row.id); setError('');
    const result = await manageUsers({ action: 'delete', id: row.id });
    setBusyId(null);
    if ('error' in result) { setError(result.error); return; }
    load();
  }

  async function addUser() {
    setAdding(true); setError('');
    const result = await manageUsers({
      action: 'create', email: newEmail, full_name: newName, role: newRole, password: newPassword,
    });
    setAdding(false);
    if ('error' in result) { setError(result.error); return; }
    setShowAdd(false); setNewEmail(''); setNewName(''); setNewRole('creator'); setNewPassword('');
    load();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-forest-900">Users</h1>
          <p className="text-sm text-ink-500">MD and Admin can add logins, change roles, deactivate or delete a user.</p>
        </div>
        <button onClick={() => setShowAdd((s) => !s)} className="btn-primary">+ Add User</button>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}</div>}

      {showAdd && (
        <section className="rounded-lg border border-kraft-200 bg-white p-5">
          <div className="mb-3 text-sm font-bold text-forest-900">NEW USER</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Email"><input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="input" /></Field>
            <Field label="Full Name"><input value={newName} onChange={(e) => setNewName(e.target.value)} className="input" /></Field>
            <Field label="Role">
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)} className="input">
                {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </Field>
            <Field label="Temporary Password"><input type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="min. 8 characters" className="input" /></Field>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} className="btn-secondary">Cancel</button>
            <button onClick={addUser} disabled={adding} className="btn-primary">{adding ? 'Creating…' : 'Create User'}</button>
          </div>
        </section>
      )}

      <div className="overflow-hidden rounded-lg border border-kraft-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-kraft-100 text-left text-[11px] font-bold uppercase tracking-wide text-ink-900">
            <tr>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Last Sign-in</th>
              <th className="px-3 py-2 text-center">Active</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && <tr><td colSpan={6} className="px-3 py-8 text-center text-ink-500">Loading…</td></tr>}
            {rows?.map((r) => (
              <Fragment key={r.id}>
                <tr className="border-t border-kraft-100">
                  <td className="px-3 py-2 font-mono">{r.email}{r.id === profile?.id && <span className="ml-1 text-ink-300">(you)</span>}</td>
                  <td className="px-3 py-2">{r.full_name || '—'}</td>
                  <td className="px-3 py-2">
                    <select
                      value={r.role}
                      disabled={busyId === r.id}
                      onChange={(e) => changeRole(r.id, e.target.value as UserRole)}
                      className="input !py-1"
                    >
                      {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-500">{r.last_sign_in_at ? new Date(r.last_sign_in_at).toLocaleString('en-GB') : 'Never'}</td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={r.is_active} disabled={busyId === r.id} onChange={() => toggleActive(r)} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => { setResetId(resetId === r.id ? null : r.id); setResetPassword(''); setError(''); setNotice(''); }}
                        disabled={busyId === r.id}
                        className="btn-secondary !px-2 !py-1"
                      >
                        Change password
                      </button>
                      <button onClick={() => remove(r)} disabled={busyId === r.id || r.id === profile?.id} className="btn-secondary !px-2 !py-1 text-rose-700">
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
                {resetId === r.id && (
                  <tr className="border-t border-kraft-100 bg-kraft-50">
                    <td colSpan={6} className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          type="text"
                          value={resetPassword}
                          onChange={(e) => setResetPassword(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') setPassword(r); }}
                          placeholder={`New password for ${r.email} (min. 8 characters)`}
                          className="input flex-1"
                        />
                        <button onClick={() => setPassword(r)} disabled={busyId === r.id} className="btn-primary !px-3 !py-1.5">
                          {busyId === r.id ? 'Saving…' : 'Set password'}
                        </button>
                        <button onClick={() => setResetId(null)} className="btn-secondary !px-3 !py-1.5">Cancel</button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
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
