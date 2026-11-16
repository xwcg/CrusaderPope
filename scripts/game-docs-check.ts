// The app's own tables of the game's script checked against the game's documentation of itself: the console commands
// `script_docs` (logs/effects.log, triggers.log, event_targets.log, event_scopes.log, modifiers.log, on_actions.log)
// writes what each effect, trigger and link is, the scopes it runs in and the targets it takes. Compared here, by
// key: the picker's links (scriptCatalog.ts LINKS), database prefixes (PREFIX_SCOPES), lists (ITERATORS), statements
// (STATEMENTS: their keys, scopes and a scope parameter's type) and the describer's other link names. Also writes
// review files that pair each statement with the game's text of its keys, for a reading of their meaning.
//
// Usage: node --experimental-strip-types --no-warnings scripts/game-docs-check.ts <folder with the .log files> [review out folder]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ITERATORS, LINKS, PREFIX_SCOPES, STATEMENTS, type ParamDef, type ScopeType, type StatementDef } from '../src/shared/scriptCatalog.ts';
import { defaultInstall } from './ck3-install.ts';
import { applyRepoScriptFacts } from './script-facts.ts';

// (--facts: the tables after the script database's facts are applied, as the app runs them)
const factsMode = process.argv.includes('--facts');
const positional = process.argv.slice(2).filter((x) => x !== '--facts');
const dir = positional[0];
const reviewDir = positional[1];

if (factsMode && !applyRepoScriptFacts())
    process.exit(2);

if (!dir)
{
    console.error('usage: game-docs-check.ts <logs folder with effects.log …> [review out folder]');
    process.exit(2);
}

interface DocEntry { name: string; text: string; scopes: string[]; targets: string[]; }
interface LinkEntry { name: string; text: string; input: string[]; output: string[]; global: boolean; data: boolean; wild: boolean; }

const list = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter((x) => x && x !== 'none');

function entries(file: string): string[]
{
    return readFileSync(join(dir, file), 'utf8').replace(/\r/g, '').split(/\n-{20}\n/).map((x) => x.trim()).filter((x) => x && !/^\w[\w ]* Documentation:$/.test(x));
}

function docs(file: string): Map<string, DocEntry>
{
    const out = new Map<string, DocEntry>();

    for (const e of entries(file))
    {
        const name = /^([\w:.$]+)(?: - |\s*$|\n)/.exec(e)?.[1];

        if (!name)
            continue;

        const scopes = list(/^Supported Scopes: (.*)$/m.exec(e)?.[1]);
        const targets = list(/^Supported Targets: (.*)$/m.exec(e)?.[1]);
        const text = e.split('\n').filter((l) => !/^Supported (Scopes|Targets): /.test(l)).join('\n');
        out.set(name, { name, text, scopes, targets });
    }

    return out;
}

/** event_targets.log by name; a name can be there twice: a link (`faith` of a character) and a database prefix (`faith:x`) */
function links(): Map<string, LinkEntry[]>
{
    const out = new Map<string, LinkEntry[]>();

    for (const e of entries('event_targets.log'))
    {
        const name = /^([\w:.$]+)(?: - |\s*$|\n)/.exec(e)?.[1];

        if (!name)
            continue;

        const all = out.get(name) ?? [];
        all.push({
            name,
            text: e,
            input: list(/^Input Scopes: (.*)$/m.exec(e)?.[1]),
            output: list(/^Output Scopes: (.*)$/m.exec(e)?.[1]),
            global: /^Global Link: yes$/m.test(e),
            data: /^Requires Data: yes$/m.test(e),
            wild: /^Wild Card: yes$/m.test(e)
        });
        out.set(name, all);
    }

    return out;
}

/** The scope links of a name (the entries without data), their input and output scopes merged */
function linkOf(name: string): LinkEntry | undefined
{
    const all = (TARGETS.get(name) ?? []).filter((x) => !x.data);

    if (!all.length)
        return undefined;

    return { ...all[0], text: all.map((x) => x.text).join('\n'), input: [...new Set(all.flatMap((x) => x.input))], output: [...new Set(all.flatMap((x) => x.output))] };
}

/** The names the game's own script defines at the top level of a common/ folder (its scripted effects, triggers, lists) */
function scripted(folder: string): Set<string>
{
    const out = new Set<string>();
    const base = join(defaultInstall(), 'game', 'common', folder);

    for (const f of readdirSync(base).filter((x) => x.endsWith('.txt')))
        for (const m of readFileSync(join(base, f), 'utf8').matchAll(/^(\w+)\s*=/gm))
            out.add(m[1]);

    return out;
}

const EFFECTS = docs('effects.log');
const TRIGGERS = docs('triggers.log');
const TARGETS = links();
const SCRIPTED_EFFECTS = scripted('scripted_effects');
const SCRIPTED_TRIGGERS = scripted('scripted_triggers');
const SCRIPTED_LISTS = scripted('scripted_lists');
const GAME_SCOPES = new Set([...readFileSync(join(dir, 'event_scopes.log'), 'utf8').matchAll(/^(\w+):\r?$/gm)].map((m) => m[1]));

/** The app's scope type names as the game names them (event_scopes.log) */
const GAME_NAME: Partial<Record<ScopeType, string>> = {
    sub_region: 'situation_sub_region',
    participant_group: 'situation_participant_group',
    great_holy_war: 'ghw',
    contribution: 'project_contribution',
    memory: 'character_memory',
    region: 'geographical_region',
    tradition: 'culture_tradition',
    innovation: 'culture_innovation',
    mercenary: 'mercenary_company'
};
const game = (t: string): string => GAME_NAME[t as ScopeType] ?? t;

const problems: string[] = [];
const notes: string[] = [];
const say = (to: string[], area: string, msg: string): void => void to.push(`[${area}] ${msg}`);

// ---------------------------------------------------------------------------------------------------------------------
// scope type names
// ---------------------------------------------------------------------------------------------------------------------

const appTypes = new Set<string>([...LINKS.flatMap((l) => [...l.from, l.to]), ...ITERATORS.flatMap((i) => [...i.from, i.to]), ...STATEMENTS.flatMap((s) => (s.scopes === 'any' ? [] : s.scopes))]);

for (const t of appTypes)
    if (!GAME_SCOPES.has(game(t)))
        say(problems, 'types', `the app's scope type ${t} (game name ${game(t)}) is not a scope type of event_scopes.log`);

// ---------------------------------------------------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------------------------------------------------

const seenLinks = new Set<string>();

for (const l of LINKS)
{
    if (l.key === 'root')
        continue;

    seenLinks.add(l.key);
    const d = linkOf(l.key);

    if (!d)
    {
        say(problems, 'links', `${l.key} (${l.from.join('/')} → ${l.to}): not in event_targets.log`);
        continue;
    }

    const badFrom = l.from.filter((f) => d.input.length && !d.input.includes(game(f)));

    if (badFrom.length)
        say(problems, 'links', `${l.key}: the app takes it from ${badFrom.join(', ')}; the game's input scopes: ${d.input.join(', ') || '(any)'}`);

    if (d.output.length && !d.output.includes(game(l.to)))
        say(problems, 'links', `${l.key}: the app says it leads to ${l.to}; the game's output: ${d.output.join(', ')}`);
}

for (const [p, t] of Object.entries(PREFIX_SCOPES))
{
    const d = (TARGETS.get(p) ?? []).find((x) => x.data);

    if (!d)
        say(problems, 'prefixes', `${p}: (${t}) no link of that name that takes data (\`${p}:x\`) in event_targets.log`);
    else if (d.output.length && !d.output.includes(game(t)))
        say(problems, 'prefixes', `${p}: the app says ${t}; the game's output: ${d.output.join(', ')}`);
}

// the describer's own link names (describer.ts SCOPE_LINKS): the scope keywords and `councillor` (the bare names the
// game does not document as links were dropped, 2026-11-14)
const describer = readFileSync(new URL('../src/main/describe/describer.ts', import.meta.url), 'utf8');
const scopeLinks = /const SCOPE_LINKS = new Set\(\[([^\]]*)\]\)/.exec(describer)?.[1].match(/'(\w+)'/g)?.map((x) => x.slice(1, -1)) ?? [];

for (const k of scopeLinks)
{
    if (['root', 'prev', 'this', 'from'].includes(k))
        continue;

    const d = linkOf(k);
    say(d ? notes : problems, 'describer links', d ? `${k}: a link of the game (${d.input.join(', ') || 'any'} → ${d.output.join(', ')}); the describer reads it as a character link` : `${k}: not a link of event_targets.log (the describer reads it as a character link)`);
}

// ---------------------------------------------------------------------------------------------------------------------
// lists
// ---------------------------------------------------------------------------------------------------------------------

for (const i of ITERATORS)
{
    const forms: [string, Map<string, DocEntry>, boolean][] = [
        [`every_${i.list}`, EFFECTS, i.effect],
        [`random_${i.list}`, EFFECTS, i.effect],
        [`ordered_${i.list}`, EFFECTS, !!i.orders && i.effect],
        [`any_${i.list}`, TRIGGERS, i.trigger]
    ];

    for (const [key, map, used] of forms)
    {
        const d = map.get(key);

        if (!used)
        {
            if (d && key.startsWith('any_') === !i.trigger && !key.startsWith('ordered_'))
                say(notes, 'lists', `${key} exists in the game, the app does not offer it (${i.list}: effect ${i.effect}, trigger ${i.trigger})`);
            continue;
        }

        if (!d)
        {
            if (SCRIPTED_LISTS.has(i.list))
                say(notes, 'lists', `${key}: a scripted list of vanilla (common/scripted_lists), not in the game's docs`);
            else
                say(problems, 'lists', `${key}: not in ${map === EFFECTS ? 'effects' : 'triggers'}.log, and no scripted list of vanilla (the app offers ${i.list} from ${i.from.join('/')})`);

            continue;
        }

        const badFrom = i.global ? [] : i.from.filter((f) => d.scopes.length && !d.scopes.includes(game(f)));

        if (badFrom.length)
            say(problems, 'lists', `${key}: the app offers it from ${badFrom.join(', ')}; the game's scopes: ${d.scopes.join(', ')}`);

        if (i.global && d.scopes.length)
            say(notes, 'lists', `${key}: the app calls it a list of the whole game; the game's scopes: ${d.scopes.join(', ')}`);

        if (d.targets.length && !d.targets.includes(game(i.to)))
            say(problems, 'lists', `${key}: the app says its items are ${i.to}; the game's targets: ${d.targets.join(', ')}`);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------------------------------------------------

/** The keys written at the template's top level, with a `$choice$` in a key expanded by that choice's values */
function topKeys(s: StatementDef): string[]
{
    const t = s.script.replace(/[[\]]/g, ' ');
    const keys: string[] = [];
    let depth = 0;

    for (const m of t.matchAll(/[{}]|([\w$:.]+)\s*(?:=|>=|<=|>|<)/g))
    {
        if (m[0] === '{')
            depth++;
        else if (m[0] === '}')
            depth--;
        else if (depth === 0 && m[1] && !/^\$\w+\$$/.test(m[1]) && !m[1].includes(':') && !m[1].includes('.'))
            keys.push(m[1]);
    }

    const out: string[] = [];

    for (const k of keys)
    {
        const p = /\$(\w+)\$/.exec(k);
        const param = p && [...s.params, ...(s.extra ?? [])].find((x) => x.name === p[1]);

        if (param && param.kind === 'choice')
            out.push(...param.options.map((o) => k.replace(p[0], o.value)));
        else if (!p)
            out.push(k);
    }

    return [...new Set(out)];
}

const KEYWORDS = new Set(['this', 'root', 'prev', 'from', 'if', 'else', 'else_if', 'limit', 'AND', 'OR', 'NOT', 'NOR', 'NAND', 'trigger_if', 'trigger_else']);
const review: unknown[] = [];

for (const s of STATEMENTS)
{
    const map = s.kind === 'effect' ? EFFECTS : TRIGGERS;
    const keys = topKeys(s);
    const found: DocEntry[] = [];

    for (const k of keys)
    {
        if (KEYWORDS.has(k))
            continue;

        const d = map.get(k) ?? map.get(k.toLowerCase());

        if (!d)
        {
            const own = (s.kind === 'effect' ? SCRIPTED_EFFECTS : SCRIPTED_TRIGGERS).has(k);
            const link = linkOf(k);

            if (own)
                say(notes, 'statements', `${s.id}: ${k} is a scripted ${s.kind} of vanilla, not in the game's docs`);
            else if (s.kind === 'trigger' && link)
                say(notes, 'statements', `${s.id}: ${k} is a link compared to a value (\`${k} = <scope>\`; ${link.input.join(', ') || 'any'} → ${link.output.join(', ')})${s.scopes !== 'any' && s.scopes.some((t) => link.input.length && !link.input.includes(game(t))) ? `; offered in ${(s.scopes as string[]).join(', ')}, outside the link's inputs` : ''}`);
            else
            {
                const other = (s.kind === 'effect' ? TRIGGERS : EFFECTS).get(k);
                say(problems, 'statements', `${s.id} (${s.kind}): ${k} is not in ${s.kind === 'effect' ? 'effects' : 'triggers'}.log${other ? ` (it is a ${s.kind === 'effect' ? 'trigger' : 'effect'})` : link ? ' (it is a link)' : ''}`);
            }

            continue;
        }

        found.push(d);

        if (s.scopes !== 'any' && d.scopes.length)
        {
            const bad = (s.scopes.length ? s.scopes : []).filter((t) => !d.scopes.includes(game(t)));

            if (bad.length)
                say(problems, 'statements', `${s.id}: ${k} offered in ${bad.join(', ')}; the game's scopes: ${d.scopes.join(', ')}`);

            if (!s.scopes.length)
                say(notes, 'statements', `${s.id}: ${k} offered as global (Game & world); the game's scopes: ${d.scopes.join(', ')}`);
        }

        // a scope parameter that is the key's whole value: its type against the game's targets
        const whole = new RegExp(`(^|\\s)${k}\\s*=\\s*\\$(\\w+)\\$`).exec(s.script.replace(/[[\]]/g, ' '));
        const p = whole && s.params.find((x) => x.name === whole[2]);

        if (p && p.kind === 'scope' && d.targets.length && !d.targets.includes(game(p.to)))
            say(problems, 'statements', `${s.id}: ${k} = <${p.name}> asks for a ${p.to}; the game's targets: ${d.targets.join(', ')}`);
    }

    const param = (x: ParamDef): Record<string, unknown> => ({
        name: x.name,
        kind: x.kind,
        label: x.label,
        ...('to' in x ? { to: x.to } : {}),
        ...('type' in x ? { type: x.type } : {}),
        ...('options' in x ? { options: x.options.map((o) => `${o.value}: ${o.label}`) } : {}),
        ...('optional' in x && x.optional ? { optional: x.optional } : {})
    });

    review.push({
        id: s.id,
        kind: s.kind,
        label: s.label,
        group: s.group,
        ...(s.help ? { help: s.help } : {}),
        scopes: s.scopes,
        script: s.script,
        params: s.params.map(param),
        ...(s.extra?.length ? { extra: s.extra.map(param) } : {}),
        game: found.map((d) => ({ key: d.name, text: d.text, scopes: d.scopes, targets: d.targets }))
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// gaps: what the game documents and the app's tables lack
// ---------------------------------------------------------------------------------------------------------------------

const gaps: string[] = [];
const appTypeNames = new Set([...appTypes].map(game));
const known = new Set(ITERATORS.map((i) => i.list));
const lists = new Map<string, { forms: string[]; scopes: Set<string>; targets: Set<string>; text: string; }>();

for (const [map, forms] of [[EFFECTS, ['every', 'random', 'ordered']], [TRIGGERS, ['any']]] as const)
{
    for (const [k, d] of map)
    {
        const m = /^(every|random|ordered|any)_(\w+)$/.exec(k);

        if (!m || !(forms as readonly string[]).includes(m[1]) || known.has(m[2]))
            continue;

        const l = lists.get(m[2]) ?? { forms: [], scopes: new Set<string>(), targets: new Set<string>(), text: '' };
        l.forms.push(m[1]);
        d.scopes.forEach((s) => l.scopes.add(s));
        d.targets.forEach((t) => l.targets.add(t));
        l.text ||= d.text.split('\n')[0].replace(/^\w+ - /, '');
        lists.set(m[2], l);
    }
}

for (const [name, l] of [...lists].sort())
    gaps.push(`[list] ${name} (${l.forms.join('/')}): ${[...l.scopes].join(', ') || 'global'} → ${[...l.targets].join(', ') || '?'} — ${l.text}`);

for (const [name, all] of [...TARGETS].sort())
{
    for (const d of all)
    {
        if (d.data ? Object.prototype.hasOwnProperty.call(PREFIX_SCOPES, name) || ['scope', 'var', 'local_var', 'global_var', 'flag'].includes(name) : seenLinks.has(name))
            continue;

        gaps.push(`[link${d.data ? ', takes data' : ''}${d.global ? ', global' : ''}] ${name}: ${d.input.join(', ') || 'any'} → ${d.output.join(', ') || '?'} — ${d.text.split('\n')[0].replace(/^\S+ - /, '')}`);
    }
}

for (const t of [...GAME_SCOPES].sort())
    if (!appTypeNames.has(t) && !['none', 'value', 'boolean', 'flag'].includes(t))
        gaps.push(`[scope type] ${t}`);

const covered = new Set(STATEMENTS.flatMap((s) => topKeys(s)));
gaps.push(`[statements] effects documented ${EFFECTS.size}, with a picker statement ${[...EFFECTS.keys()].filter((k) => covered.has(k)).length}; triggers documented ${TRIGGERS.size}, with one ${[...TRIGGERS.keys()].filter((k) => covered.has(k)).length} (the rest: "Other…", from the key scan of the loaded script)`);

console.log(`game docs: ${EFFECTS.size} effects, ${TRIGGERS.size} triggers, ${TARGETS.size} links, ${GAME_SCOPES.size} scope types`);
console.log(`app: ${LINKS.length} links, ${Object.keys(PREFIX_SCOPES).length} prefixes, ${ITERATORS.length} lists, ${STATEMENTS.length} statements`);
console.log(`\n== problems (${problems.length})\n` + problems.join('\n'));
console.log(`\n== notes (${notes.length})\n` + notes.join('\n'));
console.log(`\n== gaps (${gaps.length})\n` + gaps.join('\n'));

if (reviewDir)
{
    mkdirSync(reviewDir, { recursive: true });
    const size = Math.ceil(review.length / 2);

    for (let i = 0; i * size < review.length; i++)
        writeFileSync(join(reviewDir, `statements-${i + 1}.json`), JSON.stringify(review.slice(i * size, (i + 1) * size), null, 1));

    console.log(`\nreview files: ${Math.ceil(review.length / size)} in ${reviewDir}`);
}
