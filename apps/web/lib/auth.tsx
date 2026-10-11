'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
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
  // The signed-in user's id as last seen, so a repeat event for the same person can be told apart from a real change.
  const currentUserId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadProfile(session: Session | null) {
      if (!session) {
        currentUserId.current = null;
        if (!cancelled) setState({ loading: false, session: null, profile: null });
        return;
      }
      const { data } = await supabase.from('users').select('*').eq('id', session.user.id).maybeSingle();
      currentUserId.current = session.user.id;
      if (!cancelled) setState({ loading: false, session, profile: (data as AppUser) ?? null });
    }

    supabase.auth.getSession().then(({ data }) => loadProfile(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      // Supabase re-announces the SAME signed-in user whenever the tab regains focus or the token refreshes. Treating
      // that as a fresh sign-in set loading=true, which unmounted the whole page and threw away whatever the person
      // was in the middle of (an open inspection, a half-filled form). For the same user, just keep the new session
      // (it carries the fresh token) and leave the profile object — and everything depending on it — untouched.
      if (session && session.user.id === currentUserId.current) {
        setState((s) => (s.loading ? s : { ...s, session }));
        // pick up a changed role/name quietly, replacing the profile only if something actually differs
        supabase.from('users').select('*').eq('id', session.user.id).maybeSingle().then(({ data }) => {
          if (cancelled || !data) return;
          setState((s) => (s.profile && JSON.stringify(s.profile) === JSON.stringify(data) ? s : { ...s, profile: data as AppUser }));
        });
        return;
      }
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
