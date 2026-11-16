// Validates explanation files against their input batches (data/script-db/STYLE.md): valid JSON, one object per input
// entry in the same order with kind / key / variant unchanged, the required fields of the right types.
// Usage: node scripts/script-db-explain-validate.mjs [batch name …]   (no names: every file in data/script-db/explanations)
// SCRIPT_DB_REDO=1: the redo batches instead (data/script-db/work/redo/input and …/out: entries explained again with
// new evidence, merged into the explanation files afterwards)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const redo = !!process.env.SCRIPT_DB_REDO;
const inDir = redo ? join(root, 'data', 'script-db', 'work', 'redo', 'input') : join(root, 'data', 'script-db', 'work', 'input');
const outDir = redo ? join(root, 'data', 'script-db', 'work', 'redo', 'out') : join(root, 'data', 'script-db', 'explanations');
const names = process.argv.slice(2).map((n) => n.replace(/\.json$/, ''));
const todo = names.length ? names : readdirSync(outDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
let bad = 0;

for (const name of todo)
{
    const problems = [];
    const outFile = join(outDir, `${name}.json`);

    if (!existsSync(outFile))
        problems.push('no explanation file');
    else
    {
        let input = [];
        let out;

        try
        {
            input = JSON.parse(readFileSync(join(inDir, `${name}.json`), 'utf8'));
        }
        catch (e)
        {
            problems.push(`input: ${e.message}`);
        }

        try
        {
            out = JSON.parse(readFileSync(outFile, 'utf8'));
        }
        catch (e)
        {
            problems.push(`not valid JSON: ${e.message}`);
        }

        if (out && !Array.isArray(out))
            problems.push('not an array');
        else if (out)
        {
            if (out.length !== input.length)
                problems.push(`${out.length} entries, the input has ${input.length}`);

            input.forEach((x, i) =>
            {
                const y = out[i];

                if (!y)
                    return;

                const id = `#${i} ${x.key}`;

                if (y.kind !== x.kind || y.key !== x.key || (y.variant ?? '') !== (x.variant ?? ''))
                    problems.push(`${id}: kind/key/variant ${y.kind}/${y.key}/${y.variant ?? ''} differ from the input`);

                for (const f of ['label', 'summary', 'details'])
                    if (typeof y[f] !== 'string')
                        problems.push(`${id}: ${f} is not a string`);

                if (typeof y.label === 'string' && (!y.label.trim() || y.label.split(/\s+/).length > 6))
                    problems.push(`${id}: label "${y.label}" (1-5 words)`);

                if (typeof y.summary === 'string' && !y.summary.trim())
                    problems.push(`${id}: empty summary`);

                if (!Array.isArray(y.fields) || y.fields.some((f) => typeof f?.name !== 'string' || typeof f?.text !== 'string'))
                    problems.push(`${id}: fields must be an array of { name, text, … }`);

                if (!Array.isArray(y.sources) || !y.sources.length)
                    problems.push(`${id}: sources missing`);

                if (typeof y.uncertain !== 'boolean')
                    problems.push(`${id}: uncertain must be true or false`);
            });
        }
    }

    if (problems.length)
    {
        bad++;
        console.log(`${name}: ${problems.length} problem(s)\n  ${problems.slice(0, 30).join('\n  ')}`);
    }
    else if (names.length)
        console.log(`${name}: ok`);
}

console.log(`${todo.length - bad} of ${todo.length} ok`);
process.exit(bad ? 1 : 0);
