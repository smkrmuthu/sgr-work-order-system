'use client';

import { useEffect } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import logo from '@/assets/sgr-logo.png';
import type { UserRole } from '@sgr/types';

const ROLE_LABEL: Record<UserRole, string> = {
  creator: 'Work Order Master Creator',
  md: 'Managing Director',
  planner: 'Production Planner',
  qc: 'Quality Control',
  finance: 'Finance',
  admin: 'System Administrator',
};

// Which roles see each nav tab. Hiding it is a convenience only — every table and RPC behind these
// screens is independently enforced by RLS (db/migrations/002_rls.sql), never by this list alone.
const NAV: { href: string; label: string; roles: UserRole[] }[] = [
  { href: '/work-orders', label: 'Work Orders', roles: ['creator', 'md', 'planner', 'qc', 'finance', 'admin'] },
  { href: '/finance', label: 'Finance Approval', roles: ['finance', 'md', 'admin'] },
  { href: '/planner', label: 'Production Planner', roles: ['planner', 'md', 'admin'] },
  { href: '/qc', label: 'QC', roles: ['qc', 'md', 'admin'] },
  { href: '/finished-goods', label: 'Finished Goods', roles: ['md', 'admin', 'finance', 'planner', 'qc'] },
  { href: '/dispatch', label: 'Ready for Dispatch', roles: ['md', 'admin', 'finance', 'planner', 'qc'] },
  { href: '/users', label: 'Users', roles: ['md', 'admin'] },
  { href: '/item-master', label: 'Item Master', roles: ['creator', 'md', 'admin'] },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { loading, session, profile } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !session) router.replace('/login');
  }, [loading, session, router]);

  if (loading || !session) return null;

  const role = profile?.role ?? 'creator';
  const initials = (profile?.full_name ?? profile?.email ?? '??').slice(0, 2).toUpperCase();

  // The login itself still works (Supabase Auth doesn't know about app.users), but every RLS policy
  // and RBAC check treats a deactivated user as having no role (db/migrations/002_rls.sql), so there
  // is nothing useful for them to do here — say so plainly instead of showing a UI that fails silently.
  if (profile && !profile.is_active) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-kraft-50 px-6">
        <div className="max-w-sm rounded-lg border border-rose-200 bg-white p-6 text-center">
          <div className="mb-2 text-sm font-bold text-rose-800">Your account has been deactivated</div>
          <p className="mb-4 text-xs text-ink-500">Contact an MD or Admin if this is unexpected.</p>
          <button onClick={() => supabase.auth.signOut()} className="btn-secondary">Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="no-print bg-forest-900 text-white">
        <div className="mx-auto flex h-[60px] max-w-6xl items-center justify-between gap-5 px-7">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white">
              <Image src={logo} alt="SGR" width={57} height={60} className="h-7 w-auto" priority />
            </div>
            <div>
              <div className="text-sm font-bold">
                SGR Moulds India <span className="font-semibold text-forest-300">PVT LTD</span>
              </div>
              <div className="text-[10px] tracking-wide text-forest-300">Work Order Management System</div>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-forest-600 bg-forest-800 py-1 pl-3 pr-1">
            <span className="text-[10px] font-bold tracking-wide text-forest-100">{ROLE_LABEL[role]}</span>
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-kraft-300 text-[11px] font-bold text-kraft-900">
              {initials}
            </span>
            <button
              onClick={() => supabase.auth.signOut()}
              className="ml-1 rounded-full px-2 py-1 text-[10px] font-bold text-forest-300 hover:text-white"
            >
              Sign out
            </button>
          </div>
        </div>
        <nav className="border-t border-forest-700 bg-forest-800">
          <div className="mx-auto flex max-w-6xl gap-1 px-7">
            {NAV.filter((n) => n.roles.includes(role)).map((n) => {
              const active = pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`border-b-2 px-3 py-2.5 text-xs font-bold tracking-wide ${
                    active ? 'border-forest-300 text-white' : 'border-transparent text-forest-300 hover:text-white'
                  }`}
                >
                  {n.label.toUpperCase()}
                </Link>
              );
            })}
          </div>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-7 py-6">{children}</main>
    </div>
  );
}
