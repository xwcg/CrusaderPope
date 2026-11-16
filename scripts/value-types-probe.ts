// The value types' probe (docs/indexer.md "Value types"): a mod that writes every effect and trigger the game documents
// once with a made-up value, `<statement> = zzvt_<n>`, and every field vanilla writes in a statement's block once,
// `<statement> = { <field> = zzvt_<n> }`, each in a scripted effect or trigger of its own (parsed when the game loads, never
// run). The game's error log then says what each one expected (a database's key, a scope, a number …); the value names the
// probe even where a message has no line. Writes the mod into <folder> (its descriptor, the scripts, probe-map.json: each
// value's statement, field, kind, file and line). Reading the log afterwards: scripts/value-types-probe-read.ts.
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=8000 scripts/value-types-probe.ts <folder>
// GAME=<install dir> (default: the development install).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { ScriptKeyScanner } from '../src/main/describe/scriptKeys.ts';
import { defaultInstall } from './ck3-install.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const folder = process.argv[2];

if (!folder)
    throw new Error('usage: value-types-probe.ts <folder>');

const gameDir = resolveGameDir(process.env.GAME ?? defaultInstall());

if (!gameDir)
    throw new Error('no game install');

const docs = join(root, 'data', 'game-docs');
const docsVersion = readdirSync(docs).filter((d) => statSync(join(docs, d)).isDirectory()).sort().at(-1)!;
const names = (file: string): string[] => [...readFileSync(join(docs, docsVersion, 'script_docs', file), 'latin1').matchAll(/^([a-z_][a-z_0-9]*) - /gm)].map((m) => m[1]);

// (not probed: control flow and logic (their value is a block of statements), the iterators (a block too), the
// statements whose value is a block of statements by nature)
// (has_title_law_flag: an unknown flag crashes 1.20.1.2 after loading, the first run (2026-11-15): "Unknown law flag" was
// the log's last line, the probe the minidump named most; what it takes is known from that message, a law flag)
const SKIP = /^(if|else|else_if|while|switch|random|random_list|hidden_effect|show_as_tooltip|custom_tooltip|custom_description|custom_label|trigger_if|trigger_else|trigger_else_if|AND|OR|NOT|NOR|NAND|calc_true_if|any_\w+|every_\w+|random_\w+|ordered_\w+|debug_\w+|assert_\w+|has_title_law_flag)$/;
const keys = new ScriptKeyScanner().scan(new GameFiles(gameDir));
const fieldsOf = new Map<string, string[]>();

for (const k of [...keys.effect, ...keys.trigger])
    if (k.fields?.length && !k.scripted)
        fieldsOf.set(k.key, k.fields.map(([f]) => f).filter((f) => /^[a-z_][a-z_0-9]*$/.test(f)));

type Probe = { value: string; kind: 'effect' | 'trigger'; statement: string; field?: string; file: string; line: number; };
const probes: Probe[] = [];
const out = (kind: 'effect' | 'trigger', file: string, list: string[]): string =>
{
    const lines = ['# Value types probe (CrusaderPope scripts/value-types-probe.ts): never called, read when the game loads'];

    for (const st of list)
    {
        if (SKIP.test(st))
            continue;

        const one = (field?: string): void =>
        {
            const value = `zzvt_${probes.length + 1}`;
            const body = field ? `${st} = { ${field} = ${value} }` : `${st} = ${value}`;
            lines.push(`zzvt_${kind[0]}_${probes.length + 1} = { ${body} }`);
            probes.push({ value, kind, statement: st, field, file, line: lines.length });
        };

        one();

        for (const f of fieldsOf.get(st) ?? [])
            one(f);
    }

    return lines.join('\n') + '\n';
};

const mod = join(folder, 'ckp_value_types_probe');
rmSync(mod, { recursive: true, force: true });
mkdirSync(join(mod, 'common', 'scripted_effects'), { recursive: true });
mkdirSync(join(mod, 'common', 'scripted_triggers'), { recursive: true });
const effects = 'common/scripted_effects/zzvt_probe_effects.txt';
const triggers = 'common/scripted_triggers/zzvt_probe_triggers.txt';
writeFileSync(join(mod, effects), out('effect', effects, names('effects.log')));
writeFileSync(join(mod, triggers), out('trigger', triggers, names('triggers.log')));
const descriptor = `version="1"\nname="CrusaderPope value types probe"\nsupported_version="${docsVersion.split('.').slice(0, 2).join('.')}.*"\n`;
writeFileSync(join(mod, 'descriptor.mod'), descriptor);
writeFileSync(join(folder, 'ckp_value_types_probe.mod'), descriptor + `path="${mod.replace(/\\/g, '/')}"\n`);
writeFileSync(join(folder, 'probe-map.json'), JSON.stringify({ game: docsVersion, probes }, null, 1));
console.log(`${probes.length} probes (${probes.filter((p) => p.kind === 'effect').length} in effects, ${probes.filter((p) => p.field).length} of them a block's field) in ${mod}`);
