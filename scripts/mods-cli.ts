// Mods in plain Node: launcher playsets, discovered mods, the game's list, and the file layering of a list.
// Usage: node --experimental-strip-types --experimental-sqlite scripts/mods-cli.ts [playset name | 'game'] [folder …]
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { defaultUserDir, discoverMods, gameVersion } from '../src/main/mods/discover.ts';
import { readLauncher } from '../src/main/mods/launcher.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { packFolder, unpackZip, ZipArchive } from '../src/main/mods/zip.ts';
import { defaultInstall } from './ck3-install.ts';

const gameDir = resolveGameDir(defaultInstall())!;
const userDir = process.env.CK3_USER_DIR ?? defaultUserDir(join(homedir(), 'Documents'));
const launcher = await readLauncher(join(userDir, 'launcher-v2.sqlite'));
const mods = discoverMods(userDir, gameDir, launcher);
console.log(`game ${gameVersion(gameDir)} · user folder ${userDir} · launcher ${launcher ? 'yes' : 'no'} · ${mods.length} mods`);

for (const m of mods)
    console.log(`  ${m.status === 'ok' ? '  ' : '✗ '}${m.name} [${m.id}] ${m.source}${m.archive ? ' zip' : ''}${m.editable ? ' editable' : ''} ${m.root ?? m.archive ?? ''}`);

const byLauncher = new Map(mods.filter((m) => m.launcherId).map((m) => [m.launcherId!, m]));
const byId = new Map(mods.map((m) => [m.id.toLowerCase(), m]));
const lists: { name: string; mods: typeof mods; }[] = [];

for (const p of launcher?.playsets ?? [])
    lists.push({
        name: p.name + (p.active ? ' (active)' : ''),
        mods: p.mods.filter((e) => e.enabled)
            .map((e) => byLauncher.get(e.modId)!)
            .filter(Boolean)
    });

try
{
    const dl = JSON.parse(readFileSync(join(userDir, 'dlc_load.json'), 'utf8')) as { enabled_mods: string[]; };
    lists.push({ name: 'game', mods: dl.enabled_mods.map((id) => byId.get(id.toLowerCase())!).filter(Boolean) });
}
catch
{
    /* no dlc_load.json */
}

for (const l of lists)
    console.log(`list "${l.name}": ${l.mods.map((m) => m.name).join(', ') || '—'}`);

const want = process.argv[2] ?? lists.find((l) => l.name.endsWith('(active)'))?.name ?? 'game';
const list = lists.find((l) => l.name === want || l.name.startsWith(want));

if (list)
{
    const t0 = Date.now();
    const files = new GameFiles(gameDir, list.mods);
    console.log(`\nlayering "${list.name}": ${files.sources.map((s) => s.name).join(' → ')}`);

    for (const dir of process.argv.slice(3).length ? process.argv.slice(3) : ['common', 'events', 'history/characters', 'localization/english', 'gfx'])
    {
        const f = files.list(dir, { engine: dir === 'gfx' });
        const hidden = files.hidden(dir, { engine: dir === 'gfx' });
        const fromMods = f.filter((x) => x.source > 0).length;
        console.log(`  ${dir}: ${f.length} files (${fromMods} from mods), hidden ${hidden.length} (${hidden.filter((h) => h.how === 'replace_path').length} by replace_path)`);

        for (const h of hidden.slice(0, 3))
            console.log(`      hidden ${h.file.rel} by ${files.sources[h.by].name} (${h.how})`);
    }

    console.log(`  ${Date.now() - t0} ms`);
    files.close();
}

// zip round trip
const tmp = mkdtempSync(join(tmpdir(), 'ckp-zip-'));
mkdirSync(join(tmp, 'src', 'common', 'traits'), { recursive: true });
writeFileSync(join(tmp, 'src', 'descriptor.mod'), 'name="Test"\n');
writeFileSync(join(tmp, 'src', 'common', 'traits', 'zz_test.txt'), 'brave = { }\n'.repeat(200));
const packed = await packFolder(join(tmp, 'src'), join(tmp, 'test.zip'));
const zip = new ZipArchive(join(tmp, 'test.zip'));
const back = zip.readEntry('common/traits/zz_test.txt')?.toString();
zip.close();
await unpackZip(join(tmp, 'test.zip'), join(tmp, 'out'));
const ok = back === 'brave = { }\n'.repeat(200) && existsSync(join(tmp, 'out', 'descriptor.mod'));
console.log(`\nzip round trip: ${packed.files} files, ${ok ? 'ok' : 'FAILED'}`);
rmSync(tmp, { recursive: true, force: true });
