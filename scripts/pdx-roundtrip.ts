/**
 * PDX binary writer check: parse → write must give every .mesh (and .anim) file of the game back byte for byte.
 * Usage: node --experimental-strip-types --no-warnings scripts/pdx-roundtrip.ts [install dir] [--anim]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parsePdx, writePdx } from '../src/main/portraits/pdx.ts';
import { defaultInstall } from './ck3-install.ts';

const install = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? defaultInstall();
const ext = process.argv.includes('--anim') ? /\.(mesh|anim)$/i : /\.mesh$/i;
const files: string[] = [];
const walk = (d: string): void =>
{
    let list;

    try
    {
        list = readdirSync(d, { withFileTypes: true });
    }
    catch
    {
        return;
    }

    for (const e of list)
    {
        const p = join(d, e.name);

        if (e.isDirectory())
            walk(p);
        else if (ext.test(e.name))
            files.push(p);
    }
};

for (const r of ['game', 'jomini', 'clausewitz'])
    walk(join(install, r));

const t0 = Date.now();
let same = 0;
let bytes = 0;
const failed: string[] = [];

for (const f of files)
{
    const buf = readFileSync(f);
    bytes += buf.length;

    try
    {
        const out = writePdx(parsePdx(buf));

        if (out.length === buf.length && Buffer.compare(Buffer.from(out.buffer, out.byteOffset, out.length), buf) === 0)
            same++;
        else
        {
            let at = 0;

            while (at < Math.min(out.length, buf.length) && out[at] === buf[at])
                at++;

            failed.push(`${f}: differs at byte ${at} (${buf.length} → ${out.length} bytes)`);
        }
    }
    catch (e)
    {
        failed.push(`${f}: ${(e as Error).message}`);
    }
}

console.log(`${same} of ${files.length} files byte-identical (${(bytes / 1048576).toFixed(0)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

for (const f of failed.slice(0, 20))
    console.log('  ' + f);

if (failed.length > 20)
    console.log(`  … ${failed.length - 20} more`);

process.exitCode = failed.length ? 1 : 0;
