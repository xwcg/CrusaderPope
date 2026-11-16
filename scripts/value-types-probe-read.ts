// Reads the game's error.log after a value types probe run (scripts/value-types-probe.ts). An error is a record (its
// first line starts with the time, the others continue it: "Script system error!", "Error: …", "Script location: …");
// a record names its probe by the scripted effect or trigger (`zzvt_t_<n>`) or the made-up value (`zzvt_<n>`). Each
// message is sorted into what the statement expected:
//   value      "Cannot read [X] as a script value" (a number or script value)
//   scope      "Failed to find a valid event target link" (read as a scope: a bare name links nothing)
//   db:<what>  a database or a kind of key the game looked in ("Cannot find 'X' in law database", "Unknown law flag",
//              "is not a valid scripted relation", "Cannot find trait group", a modifier of a type, a field's database)
//   loc        a localization key; date; block (it wants a block, not a value); other (the message as written)
// A probe no error names took the made-up name as it is (free text, a name it makes), or is checked later than the log
// reached. Then each probe against the value table and the hand rules: the keys whose table or rule says otherwise.
// Prints the summary; writes <out.json> (statement → kinds, messages) when given.
// Usage: node --experimental-strip-types --no-warnings scripts/value-types-probe-read.ts <probe folder> <error.log> [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VALUE_TYPES } from '../src/main/indexer/valueTypes.ts';
import { CONTEXT_RULES } from '../src/main/indexer/schema.ts';

const [folder, log, outFile] = process.argv.slice(2);

if (!folder || !log)
    throw new Error('usage: value-types-probe-read.ts <probe folder> <error.log> [out.json]');

type Probe = { value: string; kind: 'effect' | 'trigger'; statement: string; field?: string; file: string; line: number; };
const map = JSON.parse(readFileSync(join(folder, 'probe-map.json'), 'utf8')) as { game: string; probes: Probe[]; };
const byValue = new Map(map.probes.map((p) => [p.value, p]));

// (the records: a line with the time starts one)
const records: string[] = [];

for (const line of readFileSync(log, 'utf8').split(/\r?\n/))
{
    if (/^\[\d\d:\d\d:\d\d\]/.test(line) || !records.length)
        records.push(line);
    else if (line.trim())
        records[records.length - 1] += '\n' + line;
}

/** What a message says the statement expected. */
function kindOf(m: string): string
{
    let x: RegExpExecArray | null;

    if (/as a script value|Badly read script value/.test(m))
        return 'value';

    if (/valid event target link/.test(m))
        return 'scope';

    if (/Invalid date/.test(m))
        return 'date';

    if ((x = /Cannot find '?[^']*'? in ([\w ]+?) database/i.exec(m)))
        return 'db:' + x[1].toLowerCase();

    if ((x = /Cannot find (trait group|[\w ]+?) [^ ]* in [\w ]+ database/i.exec(m)))
        return 'db:' + x[1].toLowerCase();

    if (/is not a valid scripted relation/.test(m))
        return 'db:scripted relation';

    if ((x = /Modifier '[^']*' doesn't match expected type '(\w+)'/.exec(m)))
        return `db:modifier (${x[1]})`;

    if (/is not a valid event ID/.test(m))
        return 'db:event';

    if ((x = /Couldn't find (trait group|[\w ]+?) zzvt/i.exec(m)))
        return 'db:' + x[1].toLowerCase();

    if ((x = /Invalid ([a-z][\w ]*?) '?zzvt/i.exec(m)) || (x = /Invalid (view) token/i.exec(m)))
        return 'db:' + x[1].toLowerCase();

    if (/'zzvt_\d+' is not a valid entry/.test(m))
        return 'db:entry';

    if ((x = /in field '([^']+)' at\/near .* could not be found in the database/.exec(m)))
        return `db:field ${x[1]}`;

    if ((x = /Unknown ([a-z][\w ]*?) '?zzvt/i.exec(m)) || (x = /Unknown ([a-z][\w ]*?) type zzvt/i.exec(m)))
        return 'db:' + x[1].toLowerCase();

    if (/loc key|missing localization/i.test(m))
        return 'loc';

    if (/Invalid date/.test(m))
        return 'date';

    if (/followed by something else than \{|Malformed token|expected a block|Unexpected token/i.test(m))
        return 'block';

    return 'other';
}

const said = new Map<Probe, { kinds: Set<string>; messages: Set<string>; }>();
let about = 0;

for (const r of records)
{
    const name = /\bzzvt_[te]_(\d+)\b/.exec(r);
    const value = /\bzzvt_(\d+)\b/.exec(r);
    const probe = byValue.get(`zzvt_${(name ?? value)?.[1]}`);

    if (!probe)
        continue;

    about++;
    // (the message: the "Error:" part, else the record's first line, without the time, the source and the location)
    const err = /Error:\s*(.*)/.exec(r)?.[1] ?? r.split('\n')[0];
    const text = err.replace(/^\[[^\]]*\]\[[^\]]*\](\[[^\]]*\])?:?\s*/, '').replace(/\bzzvt_\w+\b/g, 'X').replace(/\s*(Script location|at\/near|at file|atfile|near: file).*$/s, '').replace(/\s+/g, ' ').trim();
    const s = said.get(probe) ?? said.set(probe, { kinds: new Set(), messages: new Set() }).get(probe)!;
    // (only a message that names the probe's own value says what the value should be: one about a field the probe
    // leaves out ("Modifier '' doesn't match", "Field 'type' not set") is kept as a message, not as a kind)
    s.kinds.add(new RegExp(`\\b${probe.value}\\b`).test(r) ? kindOf(r) : 'about another field');
    s.messages.add(text);
}

const silent = map.probes.filter((p) => !said.has(p));
console.log(`${records.length} log records, ${about} about a probe; ${said.size} of ${map.probes.length} probes named, ${silent.length} silent`);
const tally = new Map<string, number>();

for (const s of said.values())
    for (const k of s.kinds)
        tally.set(k.startsWith('db:') ? k : k, (tally.get(k) ?? 0) + 1);

console.log('kinds:', [...tally].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));

// (each probe against what the index would link: the table, else a hand rule; a statement's own value by its key, a
// field by statement.field then the field)
const linked = (p: Probe): { types: readonly string[] | undefined; by: string; } =>
{
    const keys = p.field ? [`${p.statement}.${p.field}`, p.field] : [p.statement];

    for (const k of keys)
    {
        const t = VALUE_TYPES.get(k);

        if (t)
            return { types: t, by: `table ${k}` };

        if (Object.hasOwn(CONTEXT_RULES, k))
            return { types: CONTEXT_RULES[k], by: `rule ${k}` };
    }

    return { types: undefined, by: 'none' };
};
const conflicts: string[] = [];

for (const [p, s] of said)
{
    const l = linked(p);
    const kinds = [...s.kinds];
    const name = p.field ? `${p.statement} { ${p.field} }` : p.statement;

    // (read as a scope or a value by the game, but linked to entries by name by the index)
    if ((kinds.includes('scope') || kinds.includes('value')) && !kinds.some((k) => k.startsWith('db:')) && l.types?.length && !l.types.includes('script_values'))
        conflicts.push(`${name}: the game reads a ${kinds.includes('scope') ? 'scope' : 'value'}; the index links ${l.types.join(', ')} (${l.by})`);
}

console.log(`\n${conflicts.length} keys the game reads as a scope or value where the index links entries by name:`);
console.log(conflicts.slice(0, 40).map((c) => '  ' + c).join('\n'));
const dbs = [...said].filter(([, s]) => [...s.kinds].some((k) => k.startsWith('db:')));
console.log(`\n${dbs.length} probes the game looked up in a database or as a kind of key:`);
console.log(dbs.slice(0, 40).map(([p, s]) => `  ${p.field ? `${p.statement} { ${p.field} }` : p.statement}: ${[...s.kinds].filter((k) => k.startsWith('db:')).join(', ')}  (index: ${linked(p).types?.join(', ') ?? '-'}, ${linked(p).by})`).join('\n'));

if (outFile)
    writeFileSync(outFile, JSON.stringify({
        game: map.game,
        said: [...said].map(([p, s]) => ({ statement: p.statement, field: p.field, kind: p.kind, kinds: [...s.kinds], messages: [...s.messages], index: linked(p) })),
        silent: silent.map((p) => ({ statement: p.statement, field: p.field, kind: p.kind, index: linked(p) }))
    }, null, 1));
