'use client';

import { useEffect, useRef } from 'react';
import { supabase } from './supabase';

// Calls `refresh` whenever another user changes one of `tables`, so screens update without a manual reload.
//  1. Supabase Realtime (db/migrations/027_realtime.sql adds the tables to the publication). Row-Level
//     Security applies to these events too, so a role only hears about rows it may read.
//  2. A fallback that re-fetches every 30 s and when the tab becomes visible again — keeps screens fresh
//     even if Realtime is down or the migration hasn't been run yet. It only runs while the tab is visible.
// Bursts of changes (one save touches several tables) are merged into a single refresh.
// `refresh` may be a fresh closure on every render; the latest one is always used.
export function useLiveRefresh(tables: string[], refresh: () => void | Promise<unknown>, enabled = true) {
  const latest = useRef(refresh);
  latest.current = refresh;
  const key = tables.join(',');

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void latest.current(); }, 400);
    };

    const channel = supabase.channel(`live-${key}-${Math.random().toString(36).slice(2, 8)}`);
    for (const table of key.split(',')) {
      channel.on('postgres_changes', { event: '*', schema: 'app', table }, fire);
    }
    channel.subscribe();

    const onVisible = () => { if (document.visibilityState === 'visible') fire(); };
    document.addEventListener('visibilitychange', onVisible);
    const poll = setInterval(() => { if (document.visibilityState === 'visible') fire(); }, 30000);

    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      void supabase.removeChannel(channel);
    };
  }, [key, enabled]);
}
