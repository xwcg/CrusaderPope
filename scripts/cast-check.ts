// Prints an event's "Who's who" (EventStory.cast) as text: root notes, given, named (with where each is in reach,
// as line:col ranges of its file: docs/picker.md "Scopes in reach"), unknown, portraits. An argument `<type>:<name>`
// (`scripted_effects:<name>`, `traits:brave` …) prints that entry's picker targets instead (its own and, for a
// scripted effect / trigger, its callers' "given by k of n callers" with the references read and whether the time
// budget cut them), whether they are known, and the time the card took (each card on a new StoryBuilder, so no other
// card's memo helps it). Other arguments:
// - `budget=<ms>` (or `budget=none`): the callers' time budget for the cards after it (StoryBuilder.callerBudget);
// - `per-caller`: the scripted cards after it also print each caller's own list at its calls (targetsAtCalls: an
//   on_action's documented scopes and saves, known or not);
// - `known-empty`: the entry types StoryBuilder.knownEmptyType marks known with no scope, and the time the scan took;
// - `over-budget`: every scripted effect / trigger's callers read on a new StoryBuilder each (a cold card): how many
//   the budget cut, the slowest ones, and the time spread (the budget's clock leaves out the builder's one-time scans,
//   StoryBuilder.setupMs).
// Usage: node --experimental-strip-types scripts/cast-check.ts <event | type:name | budget=… | per-caller | known-empty | over-budget> [… more]
// The index: scripts/fast-index.ts (parse threads, cached in %TEMP%/ckp-index-cache; FRESH=1 builds it anew).
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { readTextBody } from '../src/main/mods/textCodec.ts';
import type { Line, Rich, ScopeReach } from '../src/shared/api.ts';
import { defaultInstall } from './ck3-install.ts';
import { fastIndex } from './fast-index.ts';

const idx = await fastIndex(resolveGameDir(defaultInstall())!, { cache: true });
const sb = new StoryBuilder(idx);
const r = (x: Rich): string => x.map((s) => (typeof s === 'string' ? s : s.text)).join('');
const conds = (ls: Line[] | undefined): string => (ls?.length ? ` [who fits: ${ls.map((l) => r(l.text)).join('; ')}]` : '');
const texts = new Map<string, string>();
/** A file offset as line:col (1-based), read from the file itself without its BOM (the index's offsets are measured so). */
const lc = (file: string, off: number): string =>
{
    let t = texts.get(file);

    if (t === undefined)
        texts.set(file, t = readTextBody(file));

    const before = t.slice(0, off);
    const line = before.split('\n').length;
    return `${line}:${off - before.lastIndexOf('\n')}`;
};
const reachText = (x: ScopeReach | undefined): string =>
{
    if (!x)
        return '  reach: everywhere';

    // (each range with the text right before its start: after a save it must end with the save itself)
    const before = (s: number): string =>
        texts.get(x.file)!
            .slice(Math.max(0, s - 24), s)
            .replace(/\s+/g, ' ');
    const ranges = (l: [number, number][] | undefined): string => (l ?? []).map(([s, e]) => `${lc(x.file, s)}-${lc(x.file, e)} «${before(s)}»`).join(', ');
    return `  reach: ${ranges(x.ranges)}${x.later?.length ? `; saved later at: ${ranges(x.later)}` : ''}${x.keys?.length ? `; new ${x.keys.join(', ')}` : ''}`;
};

let budget: number | undefined;
let perCaller = false;
const fresh = (): StoryBuilder =>
{
    const b = new StoryBuilder(idx);

    if (budget !== undefined)
        b.callerBudget = budget;

    return b;
};

for (const arg of process.argv.slice(2))
{
    const bud = /^budget=(none|\d+)$/.exec(arg);

    if (bud)
    {
        budget = bud[1] === 'none' ? Infinity : Number(bud[1]);
        console.log(`== callers' time budget: ${bud[1] === 'none' ? 'none' : `${budget} ms`}`);
        continue;
    }

    if (arg === 'per-caller')
    {
        perCaller = true;
        continue;
    }

    if (arg === 'known-empty')
    {
        const b = fresh();
        const t0 = performance.now();
        const list = b.knownEmptyTypes();
        console.log(`== known-empty: ${list.length} types (${Math.round(performance.now() - t0)} ms for every type's scan)`);

        for (const t of list)
            console.log(`  ${t}`);

        // (the other types whose .info names no scope: the rule keeps them unknown, a called type or a vanilla
        // definition with a scope:x it does not save)
        const kept = idx.types().map((t) => t.id).filter((t) => !list.includes(t) && idx.typeDoc(t).length && !idx.typeDoc(t).some((d) => /\bscope:\w/.test(d.text))).sort();
        console.log(`== kept unknown though their .info names no scope: ${kept.length} types`);

        for (const t of kept)
            console.log(`  ${t}`);

        continue;
    }

    if (arg === 'over-budget')
    {
        const rows: { name: string; ms: number; clock: number; refs: number; read: number; looked: number; cut: boolean; known: boolean; }[] = [];

        for (const type of ['scripted_effects', 'scripted_triggers'])
            for (const name of idx.names(type))
            {
                const e = idx.get(type, name)!;
                const b = fresh();
                const t0 = performance.now();
                const k0 = b.callerClock();
                const c = b.callerTargets(e);
                rows.push({ name: `${type}:${name}`, ms: performance.now() - t0, clock: b.callerClock() - k0, refs: c?.refs ?? 0, read: c?.read ?? 0, looked: c?.looked ?? 0, cut: !!c?.cut, known: !!c?.known });
            }

        const cut = rows.filter((x) => x.cut);
        const by = (t: string): number => rows.filter((x) => x.name.startsWith(t)).length;
        const cutBy = (t: string): number => cut.filter((x) => x.name.startsWith(t)).length;
        const spread = (l: number[]): string =>
        {
            const v = l.slice().sort((a, b) => a - b);
            const q = (p: number): string => v[Math.min(v.length - 1, Math.floor(p * v.length))].toFixed(1);
            return `median ${q(0.5)} ms, 90% ${q(0.9)} ms, 99% ${q(0.99)} ms, max ${v[v.length - 1].toFixed(1)} ms; total ${(v.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s`;
        };
        const many = rows.filter((x) => x.refs > 12);
        const over100 = rows.filter((x) => x.refs > 100);
        console.log(`== over-budget (budget ${budget ?? 'default'}): ${rows.length} entries (${by('scripted_effects')} effects, ${by('scripted_triggers')} triggers); cut by the budget: ${cut.length} (${cutBy('scripted_effects')} effects, ${cutBy('scripted_triggers')} triggers); known: ${rows.filter((x) => x.known).length}`);
        console.log(`  callers' time per cold card, on the budget's clock: ${spread(rows.map((x) => x.clock))}`);
        console.log(`  the same with the one-time scans (wall): ${spread(rows.map((x) => x.ms))}`);
        console.log(`  with more than 12 references: ${many.length}, of them every reference looked at: ${many.filter((x) => !x.cut).length}, known: ${many.filter((x) => x.known).length}`);
        console.log(`  with more than 100 references: ${over100.length}, of them every reference looked at: ${over100.filter((x) => !x.cut).length}, known: ${over100.filter((x) => x.known).length}`);

        for (const x of rows.sort((a, b) => b.clock - a.clock).slice(0, 25))
            console.log(`  ${x.name}: ${x.clock.toFixed(1)} ms (wall ${x.ms.toFixed(1)}), ${x.refs} references, ${x.looked} looked at, ${x.read} callers read${x.cut ? ', cut' : ''}${x.known ? ', known' : ''}`);

        for (const x of cut)
            console.log(`  cut: ${x.name} (${x.refs} references, ${x.looked} looked at)`);

        continue;
    }

    const typed = /^([a-z_/]+):(.+)$/.exec(arg);

    if (typed)
    {
        const e = idx.get(typed[1], typed[2]);

        if (!e)
        {
            console.log(arg + ': not found');
            continue;
        }

        const b = fresh();
        const t0 = performance.now();
        const card = b.card(e);
        const ms = Math.round(performance.now() - t0);
        // (the card's own callers' list: a memo hit, no second read)
        const c = typed[1] === 'scripted_effects' || typed[1] === 'scripted_triggers' ? b.callerTargets(e) : undefined;
        const callers = c ? `; callers: ${c.refs} references, ${c.looked} looked at, ${c.read} callers read${c.cut ? ', cut by the time budget' : ''}` : '';
        console.log(`== ${arg}: ${card.targets?.length ?? 0} targets, known: ${!!card.targetsKnown}${card.targets ? '' : ' (no targets list)'} (${ms} ms, of them ${Math.round(b.setupMs)} ms one-time scans)${callers}`);

        for (const t of card.targets ?? [])
            console.log(`  ${t.key}${t.type ? ` (${t.type})` : ''}: ${t.about ?? ''}${t.reach ? reachText(t.reach) : ''}`);

        if (perCaller && c)
            for (const s of idx.incomingSources(e))
            {
                const got = b.targetsAtCalls(s.entity, e.name, 0, Infinity);

                if (got)
                    console.log(`  caller ${s.entity.type}:${s.entity.name}: known ${got.known}; ${got.targets.map((t) => `${t.key}${t.type ? ` (${t.type})` : ''}${got.usedOnly.has(t.key) ? ' used only' : ''}${/saved here/.test(t.about ?? '') ? ' saved' : ''}`).join(', ') || 'no targets'}`);
            }

        continue;
    }

    const e = idx.get('events', arg);
    const s = e && sb.eventStory(e);

    if (!s?.cast)
    {
        console.log(arg + ': no story');
        continue;
    }

    const c = s.cast;
    console.log(`== ${arg}`);
    console.log('  You (root): the character who gets the event');

    for (const n of c.rootNotes)
        console.log(`    ${n.from}: ${n.who}${n.of ? `; “they”: ${n.of}` : ''}${conds(n.conditions)}`);

    for (const m of c.given)
        console.log(`  given  scope:${m.name}: ${r(m.who)} (${m.from})${conds(m.conditions)}`);

    for (const m of c.named)
        console.log(`  named  scope:${m.name}: ${r(m.who)}${m.temporary ? ' (temporary)' : ''}${conds(m.conditions)}${reachText(m.reach)}`);

    if (c.unknown.length)
        console.log(`  unknown: ${c.unknown.join(', ')}`);

    for (const p of c.portraits)
        console.log(`  portrait ${p.pos}: ${p.scope}${p.animation ? ` (${p.animation})` : ''}`);
}
