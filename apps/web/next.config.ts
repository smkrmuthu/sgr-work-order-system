import type { NextConfig } from 'next';

// Static export: this app calls Supabase directly from the browser (RLS decides who can do what,
// exactly like the earlier prototype), so it needs no Node server of its own. That means it can
// deploy anywhere static files can be served — Cloudflare Workers (wrangler.toml at the repo
// root) under the custom domain sgr.oneuptech.co — with no server to operate.
//
// No basePath/assetPrefix: a custom domain serves this site at its own root (sgr.oneuptech.co/),
// unlike the earlier smkrmuthu.github.io/sgr-work-order-system/ GitHub Pages project-pages URL,
// which needed every asset/link prefixed with the repo name. Local dev is also at the root, so
// this now matches everywhere the app runs.
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
};

export default nextConfig;
