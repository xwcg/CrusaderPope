// Merges redo batches (entries explained again with new evidence: data/script-db/work/redo/out/*.json, checked by the
// validator with SCRIPT_DB_REDO=1) into the explanation files: each entry replaces the one of the same kind / key /
// variant in place, the file's other entries byte for byte as they were (checked: every other entry parses equal).
// Usage: node scripts/script-db-explain-merge.mjs [--dry]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const expDir = join(root, 'data', 'script-db', 'explanations');
const redoDir = join(root, 'data', 'script-db', 'work', 'redo', 'out');
const dry = process.argv.includes('--dry');
const id = (x) => `${x.kind}\u0000${x.key}\u0000${x.variant ?? ''}`;

/** [start, end) of each top-level object of a JSON array's text */
function spans(t)
{
    const out = [];
    let depth = 0, inStr = false, start = -1;

    for (let i = 0; i < t.length; i++)
    {
        const c = t[i];

        if (inStr)
        {
            if (c === '\\')
                i++;
            else if (c === '"')
                inStr = false;

            continue;
        }

        if (c === '"')
            inStr = true;
        else if (c === '{' || c === '[')
        {
            if (depth === 1 && c === '{')
                start = i;

            depth++;
        }
        else if (c === '}' || c === ']')
        {
            depth--;

            if (depth === 1 && c === '}')
                out.push([start, i + 1]);
        }
    }

    return out;
}

const redo = new Map();

for (const f of readdirSync(redoDir).filter((f) => f.endsWith('.json')))
    for (const x of JSON.parse(readFileSync(join(redoDir, f), 'utf8')))
        redo.set(id(x), x);

let merged = 0;

for (const f of readdirSync(expDir).filter((f) => f.endsWith('.json')).sort())
{
    const text = readFileSync(join(expDir, f), 'utf8');
    const arr = JSON.parse(text);
    const hits = arr.map((x, i) => [i, redo.get(id(x))]).filter(([, x]) => x);

    if (!hits.length)
        continue;

    // (the file's own style: one line per entry, or indented like `JSON.stringify(…, null, 1)` one level in)
    const oneLine = !/^\s*\{\s*$/m.test(text);
    const s = spans(text);
    let out = text;

    for (const [i, x] of hits.reverse())
    {
        const json = oneLine ? JSON.stringify(x) : JSON.stringify(x, null, 1).replace(/\n/g, '\n ');
        out = out.slice(0, s[i][0]) + json + out.slice(s[i][1]);
        arr[i] = x;
        redo.delete(id(x));
        merged++;
    }

    if (!isDeepStrictEqual(JSON.parse(out), arr))
        throw new Error(`${f}: the merged file does not parse to the expected entries`);

    if (!dry)
        writeFileSync(join(expDir, f), out);

    console.log(`${f}: ${hits.length}`);
}

if (redo.size)
    throw new Error(`${redo.size} redo entries match no explanation entry: ${[...redo.keys()].slice(0, 5).join(', ')}`);

console.log(`${merged} entries merged${dry ? ' (dry)' : ''}`);
