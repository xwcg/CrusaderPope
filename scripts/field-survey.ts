// Which settings a type's definitions write — the guide for the statement picker's field catalog (shared/fieldCatalog.ts,
// docs/picker.md "Modifiers and settings"): per type, its top-level keys with a scalar value, how many definitions write
// each, the value kinds seen (yes/no, number, an entry of a type, text), the most common values and the type's .info
// comment on the key; keys the catalog has a field for are marked ✓. Types without a card builder of their own (their
// statements show as "Settings") first; blocks and condition / effect blocks are left out.
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=6000 scripts/field-survey.ts [type …] [--min=0.05]
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { TYPE_CARDS } from '../src/main/describe/cards/index.ts';
import { CONTEXT_RULES } from '../src/main/indexer/schema.ts';
import { FIELDS } from '../src/shared/fieldCatalog.ts';
import { defaultInstall } from './ck3-install.ts';

const args = process.argv.slice(2);
const min = Number(args.find((a) => a.startsWith('--min='))?.slice(6) ?? 0.05);
const only = args.filter((a) => !a.startsWith('--'));
const gameDir = resolveGameDir(defaultInstall());

if (!gameDir)
    throw new Error('No CK3 game folder');

const idx = new GameIndex(new GameFiles(gameDir), 'english');
idx.build();
const sb = new StoryBuilder(idx);
const SKIP = new Set(['events', 'on_action', 'scripted_effects', 'scripted_triggers', 'script_values', 'localization', 'flag', 'variable', 'images', 'models', 'modifiers', 'opinion_modifiers']);
const types = (only.length ? only : idx.types().map((t) => t.id)).filter((t) => !SKIP.has(t));
const rows: { type: string; n: number; generic: boolean; keys: string[]; }[] = [];

for (const type of types)
{
    const names = idx.names(type);

    if (!names.length)
        continue;

    const keys = new Map<string, { n: number; kinds: Map<string, number>; values: Map<string, number>; }>();

    for (const name of names)
    {
        const e = idx.get(type, name);
        const d = e && idx.defNode(e);
        const seen = new Set<string>();

        for (const c of d && Array.isArray(d.node.v) ? d.node.v : [])
        {
            if (!c.k || typeof c.v !== 'string' || seen.has(c.k) || sb.d.isModifierKey(c.k))
                continue;

            seen.add(c.k);
            const k = keys.get(c.k) ?? keys.set(c.k, { n: 0, kinds: new Map(), values: new Map() }).get(c.k)!;
            k.n++;
            const v = c.v;
            const ref = CONTEXT_RULES[`${type}.${c.k}`]?.[0] ?? CONTEXT_RULES[c.k]?.[0];
            const kind = v === 'yes' || v === 'no' ? 'bool' : /^-?\d+(\.\d+)?$/.test(v) ? 'number' : ref ? `ref ${ref}` : idx.plainLoc(v) !== undefined ? 'loc' : v.startsWith('@') ? 'constant' : 'text';
            k.kinds.set(kind, (k.kinds.get(kind) ?? 0) + 1);
            k.values.set(v, (k.values.get(v) ?? 0) + 1);
        }
    }

    const docs = sb.keyDocs(type);
    const known = new Set((FIELDS[type] ?? []).map((f) => f.key));
    const lines = [...keys]
        .filter(([, k]) => k.n / names.length >= min || known.has(k.n.toString()))
        .sort((a, b) => b[1].n - a[1].n)
        .map(([key, k]) =>
        {
            const kinds = [...k.kinds]
                .sort((a, b) => b[1] - a[1])
                .map(([x, c]) => `${x}:${c}`)
                .join(' ');
            const values = [...k.values]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([x, c]) => `${x}:${c}`)
                .join(' ');
            const doc = docs.get(key);
            return `  ${known.has(key) ? '✓' : ' '} ${key} ${k.n}/${names.length} [${kinds}] ${values}${doc ? `\n        # ${doc.slice(0, 140)}` : ''}`;
        });

    if (lines.length)
        rows.push({ type, n: names.length, generic: !TYPE_CARDS[type] && type !== 'traits' && type !== 'characters', keys: lines });
}

rows.sort((a, b) => Number(b.generic) - Number(a.generic) || b.n - a.n);

for (const r of rows)
    console.log(`${r.type} (${r.n}${r.generic ? ', generic Settings' : ''}${FIELDS[r.type] ? ', field set' : ''}):\n${r.keys.join('\n')}`);
