// The game's file load order (src/main/mods/gamefiles.ts gamePathOrder): the files directly in a folder first (alphabetical), then each
// subfolder, depth first. Unit cases, the layered listing of a made-up playset, and the winners of a game run's database_conflicts.log:
// scripts/order-check-data.json holds, for every distinct "Overriding entry" shape of the AGOT + patch mod run of 2026-11-03, the files that
// define the key (paths only) and the file the game logged as the winner, the last of them in the game's order.
// Usage: node --experimental-strip-types --no-warnings scripts/order-check.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameFiles, gamePathOrder } from '../src/main/mods/gamefiles.ts';
import type { ModInfo } from '../src/shared/api.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

const sorted = (l: string[]): string[] => [...l].sort(gamePathOrder);

check(gamePathOrder('common/decisions/zz.txt', 'common/decisions/dlc_decisions/pam/x.txt') < 0, 'a file of a folder sorts before its subfolder, whatever the names');
check(gamePathOrder('common/decisions/dlc_decisions/pam/x.txt', 'common/decisions/zz.txt') > 0, 'and the other way round');
check(gamePathOrder('a/B.txt', 'a/b.txt') === 0, 'case does not matter');
check(gamePathOrder('a/b.txt', 'a/c.txt') < 0 && gamePathOrder('a/c.txt', 'a/b.txt') > 0, 'files of one folder: alphabetical');
check(gamePathOrder('a/x/1.txt', 'a/y/0.txt') < 0, 'subfolders: alphabetical');
check(gamePathOrder('a/x/z/1.txt', 'a/x/2.txt') > 0 && gamePathOrder('a/x/2.txt', 'a/x/z/1.txt') < 0, 'depth first: the files of x before x/z');
check(sorted(['c/d/e.txt', 'c/b.txt', 'c/a/z.txt', 'c/a.txt', 'c/a/b/y.txt', 'c/zz.txt']).join() === 'c/a.txt,c/b.txt,c/zz.txt,c/a/z.txt,c/a/b/y.txt,c/d/e.txt', 'a whole listing');
check(gamePathOrder('a/b.txt', 'a/b.txt') === 0, 'the same path is equal');

// the layered listing of a game and a mod: sorted in the game's order, a mod's file of the same path replaces the game's
const root = mkdtempSync(join(tmpdir(), 'ckp-order-'));

try
{
    const put = (base: string, rel: string, text = 'x'): void =>
    {
        const p = join(base, rel);
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, text);
    };
    const game = join(root, 'game');
    const mod = join(root, 'mod');
    put(game, 'common/decisions/10_a.txt');
    put(game, 'common/decisions/dlc_decisions/pam/p.txt');
    put(game, 'common/decisions/dlc_decisions/fp_3/f.txt');
    put(mod, 'common/decisions/zz_patch_inert.txt');
    put(mod, 'common/decisions/dlc_decisions/pam/zz_patch_inert.txt');
    put(mod, 'common/decisions/10_a.txt');
    const info = { id: 'mod/x.mod', name: 'x', root: mod, replacePaths: [], status: 'ok' } as unknown as ModInfo;
    const files = new GameFiles(game, [info]);
    const rels = files.list('common/decisions').map((f) => f.rel);
    check(rels.join() === 'common/decisions/10_a.txt,common/decisions/zz_patch_inert.txt,common/decisions/dlc_decisions/fp_3/f.txt,common/decisions/dlc_decisions/pam/p.txt,common/decisions/dlc_decisions/pam/zz_patch_inert.txt',
        'GameFiles.list: files of the folder, then the subfolders (' + rels.join(' ') + ')');
    check(files.list('common/decisions').find((f) => f.rel === 'common/decisions/10_a.txt')?.source === 1, 'a mod\'s file of the same path wins');
    check(files.isListed(1, 'common/decisions/dlc_decisions/pam/zz_patch_inert.txt') && files.isListed(0, 'common/decisions/dlc_decisions/pam/p.txt'), 'isListed finds files in a subfolder (the same order for the search)');

    // a patched listing (a file written, a file removed) keeps the order
    put(mod, 'common/decisions/dlc_decisions/aaa/zz_patch_inert.txt');
    put(mod, 'common/decisions/00_first.txt');
    files.update(1, ['common/decisions/dlc_decisions/aaa/zz_patch_inert.txt', 'common/decisions/00_first.txt']);
    const fresh = new GameFiles(game, [info]).list('common/decisions').map((f) => f.rel);
    const patched = files.list('common/decisions').map((f) => f.rel);
    check(patched.join() === fresh.join() && patched[0] === 'common/decisions/00_first.txt', 'a patched listing equals a fresh one (the insertion uses the same order)');
}
finally
{
    rmSync(root, { recursive: true, force: true });
}

// the game run's winners
const rows = JSON.parse(readFileSync(new URL('./order-check-data.json', import.meta.url), 'utf8')) as [string, string, string, string[]][];
let bad = 0;

for (const [db, key, winner, defs] of rows)
{
    const last = sorted(defs).pop();

    if (last?.toLowerCase() !== winner.toLowerCase())
    {
        bad++;
        console.log(`   ${db} ${key}: the game logged ${winner}, the order says ${last}`);
    }
}

check(rows.length > 50 && bad === 0, `the game's logged winner is the last definition in the game's order (${rows.length} entry shapes, ${bad} differ)`);
console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
