import type { NextConfig } from 'next';

// Static export: this app calls Supabase directly from the browser (RLS decides who can do what,
// exactly like the earlier prototype), so it needs no Node server of its own. That means it can
// deploy anywhere static files can be served — the same GitHub Pages / Vercel / any-CDN choice the
// prototype used — with no server to operate.
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
};

export default nextConfig;
