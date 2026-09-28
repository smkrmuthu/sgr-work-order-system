'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';

export default function LoginPage() {
  const { session, loading } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && session) router.replace('/work-orders');
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
    router.replace('/work-orders');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-kraft-50 p-4">
      <div className="w-full max-w-sm rounded-xl border border-kraft-200 bg-white shadow-sm">
        <div className="flex items-center gap-3 border-b border-kraft-100 bg-forest-900 rounded-t-xl px-5 py-4 text-white">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-forest-500 bg-forest-700 font-mono text-xs font-bold">
            SGR
          </div>
          <div>
            <div className="text-sm font-bold">SGR Moulds India</div>
            <div className="text-xs text-forest-300">Work Order System</div>
          </div>
        </div>
        <form onSubmit={onSubmit} className="flex flex-col gap-4 p-5">
          <div>
            <label className="mb-1 block text-xs font-bold text-ink-700">Email</label>
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-kraft-300 px-3 py-2 text-sm outline-none focus:border-forest-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-ink-700">Password</label>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-kraft-300 px-3 py-2 text-sm outline-none focus:border-forest-500"
            />
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-forest-700 px-4 py-2 text-sm font-bold text-white hover:bg-forest-800 disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
