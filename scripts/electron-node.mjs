// Runs a script under Electron's own Node (Node 24: node:sqlite with FTS5, the SQLite the app uses; TypeScript types
// stripped natively). Usage: node scripts/electron-node.mjs <script> [args …]
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');
const r = spawnSync(electron, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' } });
process.exit(r.status ?? 1);
