'use client';

import { useEffect, useState } from 'react';
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
  { href: '/dashboard', label: 'Dashboard', roles: ['md', 'admin'] },
  { href: '/work-orders', label: 'Work Orders', roles: ['creator', 'md', 'planner', 'qc', 'finance', 'admin'] },
  { href: '/finance', label: 'Finance Approval', roles: ['finance', 'md', 'admin'] },
  { href: '/planner', label: 'Production Planner', roles: ['planner', 'md', 'admin'] },
  { href: '/qc', label: 'QC', roles: ['qc', 'md', 'admin'] },
  { href: '/finished-goods', label: 'Finished Goods', roles: ['md', 'admin', 'finance', 'planner', 'qc'] },
  { href: '/dispatch', label: 'Ready for Dispatch', roles: ['md', 'admin', 'finance', 'planner', 'qc'] },
  { href: '/users', label: 'Users', roles: ['md', 'admin'] },
  { href: '/backup', label: 'DB Backup', roles: ['md', 'admin'] },
  { href: '/item-master', label: 'Item Master', roles: ['creator', 'md', 'admin'] },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { loading, session, profile } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!loading && !session) router.replace('/login');
  }, [loading, session, router]);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  if (loading || !session) return null;

  const role = profile?.role ?? 'creator';
  const initials = (profile?.full_name ?? profile?.email ?? '??').slice(0, 2).toUpperCase();
  const userNav = NAV.filter((n) => n.roles.includes(role));

  if (profile && !profile.is_active) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-kraft-50 px-4 sm:px-6">
        <div className="max-w-sm rounded-lg border border-rose-200 bg-white p-6 text-center shadow-sm">
          <div className="mb-2 text-sm font-bold text-rose-800">Your account has been deactivated</div>
          <p className="mb-4 text-xs text-ink-500">Contact an MD or Admin if this is unexpected.</p>
          <button onClick={() => supabase.auth.signOut()} className="btn-secondary">Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-kraft-50">
      <header className="no-print bg-forest-900 text-white sticky top-0 z-40 shadow-sm">
        {/* Top bar */}
        <div className="mx-auto flex h-14 sm:h-[60px] max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-7">
          {/* Logo & Brand */}
          <Link href={role === 'md' || role === 'admin' ? '/dashboard' : '/work-orders'} className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-lg bg-white p-0.5 shrink-0">
              <Image src={logo} alt="SGR" width={57} height={60} className="h-6 sm:h-7 w-auto" priority />
            </div>
            <div>
              <div className="text-xs sm:text-sm font-bold leading-tight">
                SGR Moulds India <span className="font-semibold text-forest-300 hidden xs:inline">PVT LTD</span>
              </div>
              <div className="text-[9px] sm:text-[10px] tracking-wide text-forest-300 leading-tight">
                Work Order Management
              </div>
            </div>
          </Link>

          {/* User profile & Mobile Menu Trigger */}
          <div className="flex items-center gap-2">
            {/* User Pill */}
            <div className="flex items-center gap-1.5 sm:gap-2 rounded-full border border-forest-600 bg-forest-800 py-1 pl-2.5 sm:pl-3 pr-1">
              <span className="text-[9px] sm:text-[10px] font-bold tracking-wide text-forest-100 hidden md:inline max-w-[150px] truncate">
                {ROLE_LABEL[role]}
              </span>
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-kraft-300 text-[11px] font-bold text-kraft-900 shrink-0">
                {initials}
              </span>
              <button
                onClick={() => supabase.auth.signOut()}
                className="hidden sm:inline-block rounded-full px-2 py-0.5 text-[10px] font-bold text-forest-300 hover:text-white transition-colors"
              >
                Sign out
              </button>
            </div>

            {/* Mobile Hamburger Button */}
            <button
              onClick={() => setMobileMenuOpen((o) => !o)}
              className="md:hidden flex h-9 w-9 items-center justify-center rounded-lg border border-forest-700 bg-forest-800 text-forest-200 hover:text-white"
              aria-label="Toggle navigation menu"
            >
              {mobileMenuOpen ? '✕' : '☰'}
            </button>
          </div>
        </div>

        {/* Desktop & Tablet Horizontal Swipeable Nav Bar */}
        <nav className="border-t border-forest-700 bg-forest-800 overflow-x-auto no-scrollbar touch-scroll">
          <div className="mx-auto flex max-w-6xl gap-1 px-4 sm:px-6 lg:px-7 whitespace-nowrap min-w-max">
            {userNav.map((n) => {
              const active = pathname === n.href || (n.href !== '/dashboard' && pathname.startsWith(n.href));
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`border-b-2 px-3 py-2 text-xs font-bold tracking-wide transition-colors ${
                    active ? 'border-forest-300 text-white bg-forest-700/50' : 'border-transparent text-forest-300 hover:text-white'
                  }`}
                >
                  {n.label.toUpperCase()}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Mobile Dropdown Drawer */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-forest-700 bg-forest-900 px-4 py-3 shadow-xl">
            <div className="mb-2.5 pb-2 border-b border-forest-800 flex items-center justify-between">
              <span className="text-xs font-bold text-forest-300">Signed in as {ROLE_LABEL[role]}</span>
              <button
                onClick={() => supabase.auth.signOut()}
                className="text-xs font-bold text-rose-300 hover:text-rose-100"
              >
                Sign out
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {userNav.map((n) => {
                const active = pathname === n.href || (n.href !== '/dashboard' && pathname.startsWith(n.href));
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`flex items-center justify-between rounded-md px-3 py-2.5 text-xs font-bold transition-colors ${
                      active ? 'bg-forest-700 text-white' : 'text-forest-200 hover:bg-forest-800 hover:text-white'
                    }`}
                  >
                    <span>{n.label}</span>
                    <span className="text-forest-400">→</span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-3 sm:px-6 lg:px-7 py-4 sm:py-6">{children}</main>
    </div>
  );
}
