// Builds db/all_migrations_combined.sql: every file in db/migrations, in order, as ONE script that can be pasted
// into the Supabase SQL Editor to set up a fresh database in a single run.
//   node scripts/build-combined-sql.mjs        writes the file
//   npm run db:combine                          same
// db/tests/run.mjs checks that the committed file equals what this produces, so it cannot silently go stale:
// when a new migration is added, run `npm run db:combine` and commit the result.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMBINED_PATH = path.join(root, 'db', 'all_migrations_combined.sql');

export function buildCombined() {
  const dir = path.join(root, 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  const header = [
    '-- SGR Work Order Management System: ALL migrations in one script (generated; do not edit by hand).',
    `-- Contains ${files.length} files, ${files[0]} to ${files[files.length - 1]}. Paste into the Supabase SQL Editor and run once`,
    '-- to build a fresh database. On an existing database run only the newest migration files instead.',
    '-- Regenerate with: npm run db:combine',
    '',
  ];
  const parts = files.map((f) => `-- ===== ${f} =====\n${fs.readFileSync(path.join(dir, f), 'utf8').replace(/\s+$/, '')}\n`);
  return header.join('\n') + '\n' + parts.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(COMBINED_PATH, buildCombined());
  console.log(`wrote ${path.relative(root, COMBINED_PATH)}`);
}
