'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import logo from '@/assets/sgr-logo.png'; // imported (not /public) so the GitHub Pages basePath is applied automatically

const STEPS = ['Draft', 'Finance approval', 'Production', 'Quality check', 'Dispatch'];

export default function LoginPage() {
  const { session, loading } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && session) router.replace('/'); // the root page sends each role to its own home
  }, [loading, session, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (error) {
      setError(/invalid|credentials/i.test(error.message) ? 'Incorrect email or password.' : error.message);
      return;
    }
    router.replace('/'); // the root page sends each role to its own home
  }

  return (
    <div className="grid min-h-screen bg-kraft-50 lg:grid-cols-[1.1fr_1fr]">
      {/* ------------------------------------------------ brand panel */}
      <aside className="relative hidden overflow-hidden bg-forest-900 text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="drift-a pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-forest-600/40 blur-3xl" />
        <div className="drift-b pointer-events-none absolute -bottom-32 right-0 h-[28rem] w-[28rem] rounded-full bg-kraft-300/20 blur-3xl" />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'repeating-linear-gradient(115deg, #fff 0 1px, transparent 1px 14px)' }}
        />

        <div className="relative flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-white">
            <Image src={logo} alt="SGR" width={57} height={60} className="h-10 w-auto" priority />
          </span>
          <div>
            <div className="text-base font-bold tracking-tight">SGR Moulds India</div>
            <div className="text-xs text-forest-300">Private Limited</div>
          </div>
        </div>

        <div className="relative">
          <ProductIllustration />
          <h2 className="mt-2 max-w-md text-3xl font-bold leading-tight tracking-tight">
            From work order to dispatch, in one place.
          </h2>
          <p className="mt-3 max-w-md text-sm text-forest-300">
            Edge boards, cartons and paper cores — tracked from the moment an order is raised until it leaves the gate.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {STEPS.map((s, i) => (
              <span
                key={s}
                className="step-chip rounded-full px-3 py-1 text-[11px] font-bold tracking-wide"
                style={{ animationDelay: `${i * 2 - 10}s` }} /* negative: the cycle is already running on load */
              >
                {s}
              </span>
            ))}
          </div>
        </div>

        <div className="relative text-[11px] text-forest-300/80">© {new Date().getFullYear()} SGR Moulds India Pvt Ltd</div>
      </aside>

      {/* ------------------------------------------------ sign-in form */}
      <main className="flex items-center justify-center p-6">
        <div className="fade-up w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-kraft-200">
              <Image src={logo} alt="SGR" width={57} height={60} className="h-10 w-auto" priority />
            </span>
            <div>
              <div className="text-sm font-bold text-forest-900">SGR Moulds India</div>
              <div className="text-xs text-ink-500">Work Order System</div>
            </div>
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-forest-900">Welcome back</h1>
          <p className="mt-1 text-sm text-ink-500">Sign in to the Work Order System.</p>

          <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-5">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs font-bold text-ink-700">Email</label>
              <input
                id="email"
                type="email"
                required
                autoComplete="username"
                placeholder="you@sgr.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-kraft-300 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-forest-500 focus:ring-4 focus:ring-forest-500/15"
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-bold text-ink-700">Password</label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-kraft-300 bg-white py-2.5 pl-3.5 pr-16 text-sm outline-none transition focus:border-forest-500 focus:ring-4 focus:ring-forest-500/15"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[11px] font-bold text-ink-500 hover:text-forest-800"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            {error && (
              <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex items-center justify-center gap-2 rounded-lg bg-forest-700 px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-forest-800 hover:shadow-md active:scale-[0.99] disabled:opacity-60"
            >
              {submitting && <span className="spinner h-4 w-4 rounded-full border-2 border-white/40 border-t-white" />}
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-8 text-xs text-ink-300">
            Trouble signing in? Ask your MD or system administrator to check your account.
          </p>
        </div>
      </main>
    </div>
  );
}

/* Drawn in code (no photo files to load, license or lose): a carton, a stack of edge boards and a
   paper core — the products SGR makes — in the brand's kraft tones, with a slow float. */
function ProductIllustration() {
  return (
    <svg viewBox="0 0 400 330" className="mb-4 w-full max-w-md" role="img" aria-label="Cartons, edge boards and a paper core">
      <defs>
        <linearGradient id="core" x1="0" x2="1">
          <stop offset="0" stopColor="#c9a56b" />
          <stop offset="0.45" stopColor="#ecd9b3" />
          <stop offset="1" stopColor="#b48d55" />
        </linearGradient>
      </defs>
      <ellipse cx="200" cy="312" rx="170" ry="14" fill="#000" opacity="0.22" />

      <g className="float-slow">
        {/* carton */}
        <polygon points="50,150 150,180 150,270 50,240" fill="#d7b47c" />
        <polygon points="150,180 240,150 240,240 150,270" fill="#a87c43" />
        <polygon points="50,150 140,120 240,150 150,180" fill="#ecd9b3" />
        <polygon points="96,134 118,127 218,157 196,164" fill="#fff" opacity="0.35" />
        <polygon points="92,200 128,211 128,224 92,213" fill="#fff" opacity="0.28" />
      </g>

      <g className="float-mid" style={{ animationDelay: '-2s' }}>
        {/* paper core */}
        <path d="M282 165 v92 a38 14 0 0 0 76 0 v-92 z" fill="url(#core)" />
        <ellipse cx="320" cy="165" rx="38" ry="14" fill="#f3e9d8" />
        <ellipse cx="320" cy="165" rx="20" ry="7.5" fill="#6f5029" />
        <path d="M282 200 a38 14 0 0 0 76 0" fill="none" stroke="#8a6a3a" strokeWidth="1.5" opacity="0.5" />
      </g>

      <g className="float-slow" style={{ animationDelay: '-4s' }}>
        {/* edge boards */}
        {[0, 1, 2].map((i) => (
          <g key={i} transform={`translate(0 ${-i * 13})`}>
            <polygon points="150,296 262,268 300,280 188,308" fill={i === 2 ? '#ecd9b3' : '#d7b47c'} />
            <polygon points="188,308 300,280 300,291 188,319" fill="#a87c43" />
            <polygon points="150,296 188,308 188,319 150,307" fill="#8a6a3a" />
          </g>
        ))}
      </g>
    </svg>
  );
}
