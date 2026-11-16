// Starts scripts/script-db-build.ts under Electron's own Node (its SQLite has FTS5; the dev Node 22's has not).
// Usage: node scripts/script-db-build.mjs [game version]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [join(here, 'electron-node.mjs'), join(here, 'script-db-build.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
