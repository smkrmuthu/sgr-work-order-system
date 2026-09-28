import type { NextConfig } from 'next';

// Static export: this app calls Supabase directly from the browser (RLS decides who can do what,
// exactly like the earlier prototype), so it needs no Node server of its own. That means it can
// deploy anywhere static files can be served — the same GitHub Pages / Vercel / any-CDN choice the
// prototype used — with no server to operate.
//
// GITHUB_PAGES=true is set only by .github/workflows/deploy.yml: GitHub Pages serves this repo at
// /sgr-work-order-system/ (not the domain root), so every asset/link needs that prefix baked in at
// build time. Local dev and `npm run build` without that env var stay at the root, unaffected.
const REPO_NAME = 'sgr-work-order-system';
const isGhPages = process.env.GITHUB_PAGES === 'true';

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  basePath: isGhPages ? `/${REPO_NAME}` : undefined,
  assetPrefix: isGhPages ? `/${REPO_NAME}/` : undefined,
};

export default nextConfig;
