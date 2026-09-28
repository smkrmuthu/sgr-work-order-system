import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fails loudly at build/boot rather than silently talking to nothing — see .env.example.
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set (see apps/web/.env.example).'
  );
}

// Same authorization model as the sgrApp prototype: the publishable/anon key alone can do nothing —
// every table and function is protected by Row-Level Security (db/migrations/002_rls.sql), so a
// signed-out visitor reads and writes precisely nothing. This client always targets the `app` schema,
// never the prototype's `public` schema on the same project.
export const supabase = createClient(url, anonKey, {
  db: { schema: 'app' },
});
