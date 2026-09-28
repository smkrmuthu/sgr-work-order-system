'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
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

  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-forest-900 text-white">
        <div className="mx-auto flex h-[60px] max-w-6xl items-center justify-between gap-5 px-7">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-forest-500 bg-forest-700 font-mono text-xs font-bold">
              SGR
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
                <a
                  key={n.href}
                  href={n.href}
                  className={`border-b-2 px-3 py-2.5 text-xs font-bold tracking-wide ${
                    active ? 'border-forest-300 text-white' : 'border-transparent text-forest-300 hover:text-white'
                  }`}
                >
                  {n.label.toUpperCase()}
                </a>
              );
            })}
          </div>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-7 py-6">{children}</main>
    </div>
  );
}
