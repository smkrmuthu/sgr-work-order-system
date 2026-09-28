'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { AppUser } from '@sgr/types';
import { supabase } from './supabase';

interface AuthState {
  loading: boolean;
  session: Session | null;
  profile: AppUser | null; // this login's row in app.users — role drives every permission check in the UI
}

const AuthContext = createContext<AuthState>({ loading: true, session: null, profile: null });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ loading: true, session: null, profile: null });

  useEffect(() => {
    let cancelled = false;

    async function loadProfile(session: Session | null) {
      if (!session) {
        if (!cancelled) setState({ loading: false, session: null, profile: null });
        return;
      }
      const { data } = await supabase.from('users').select('*').eq('id', session.user.id).maybeSingle();
      if (!cancelled) setState({ loading: false, session, profile: (data as AppUser) ?? null });
    }

    supabase.auth.getSession().then(({ data }) => loadProfile(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState((s) => ({ ...s, loading: true }));
      loadProfile(session);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
