import { supabase } from './supabase';

// Calls the manage-app-users Edge Function (MD/Admin only; see supabase/functions/manage-app-users).
// The project's public key goes in Authorization (the platform accepts it) and the person's login in
// x-user-token, which the function verifies itself — see the note at the top of that function for why.
// Resolves to { data } or { error: "readable message" }, never throws.
export async function manageUsers<T = unknown>(
  body: { action: 'list' | 'create' | 'update' | 'delete'; [key: string]: unknown }
): Promise<{ data: T } | { error: string }> {
  const { data: current } = await supabase.auth.getSession(); // fresh token (refreshed if needed)
  const token = current.session?.access_token ?? '';
  if (!token) return { error: 'Not signed in.' };

  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const { data, error } = await supabase.functions.invoke('manage-app-users', {
    body,
    headers: { Authorization: `Bearer ${anonKey}`, 'x-user-token': token },
  });
  if (!error) return (data && (data as { error?: string }).error) ? { error: (data as { error: string }).error } : { data };

  const response = (error as { context?: { json?: () => Promise<unknown> } }).context;
  if (!response || typeof response.json !== 'function') {
    return { error: "Couldn't reach the user service. Check your internet connection, and open the app from the live site." };
  }
  try {
    const body2 = (await response.json()) as { error?: string };
    return { error: body2.error || error.message };
  } catch {
    return { error: error.message };
  }
}
