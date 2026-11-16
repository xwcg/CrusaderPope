// The files of a script database update (docs/script-database.md, step 6): each built database gzipped and a
// manifest, into dist/script-db/, for the owner to upload as the assets of the GitHub release tagged `script-db`
// (replacing the old ones). The app reads the manifest at
// https://github.com/xwcg/CrusaderPope/releases/download/script-db/manifest.json.
// Usage: node scripts/electron-node.mjs scripts/script-db-release.ts   (after npm run script-db)
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'data', 'script-db');
const out = join(root, 'dist', 'script-db');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const databases = [];

for (const f of readdirSync(src).filter((x) => /^ck3-[\d.]+\.sqlite$/.test(x)).sort())
{
    const db = new DatabaseSync(join(src, f), { readOnly: true });
    const meta = Object.fromEntries((db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string; }[]).map((r) => [r.key, r.value]));
    db.close();

    const gz = gzipSync(readFileSync(join(src, f)), { level: 9 });
    const file = `${f}.gz`;
    writeFileSync(join(out, file), gz);
    databases.push({
        game: meta.game_version,
        schema: Number(meta.schema),
        built: meta.built,
        explained: Number(meta.explained ?? 0),
        file,
        size: gz.length,
        sha256: createHash('sha256').update(gz).digest('hex')
    });
}

const manifest = { format: 1, published: new Date().toISOString(), databases };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`${out}:\n${databases.map((d) => `  ${d.file} (game ${d.game}, schema ${d.schema}, built ${d.built}, ${d.explained} explained, ${d.size} bytes)`).join('\n')}\n  manifest.json`);
