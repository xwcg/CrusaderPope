// Readable cards that say much less than their script: a type (or a construct) without a proper parser yet.
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=6000 scripts/coverage-check.ts [type …]
// Per entry: the card's text (facts and section lines, nested ones and hidden ones included, not the description;
// events and on_actions: their story's text, the timeline they are shown as) against its script (keys and values;
// comments and whitespace left out, lists of bare values capped). An entry is short when its script has at least MIN
// chars and the card has less than RATIO of them. Per type: how many sampled entries are short, and the shortest ones
// with the top-level keys of their script. Samples up to SAMPLE entries per type (spread over the list); ALL=1 every
// entry; WORST=n lists n shortest per type (3). MIN=300 RATIO=0.25 SAMPLE=60 by default. Exit code 1 when a type has short entries.
// GAME=<install dir> (default: the development install).
// The index: scripts/fast-index.ts (parse threads, cached in %TEMP%/ckp-index-cache; FRESH=1 builds it anew).
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import type { EntityCard, Line, Rich } from '../src/shared/api.ts';
import type { PNode } from '../src/main/indexer/parser.ts';
import { defaultInstall } from './ck3-install.ts';
import { fastIndex } from './fast-index.ts';

const MIN = Number(process.env.MIN ?? 300);
const RATIO = Number(process.env.RATIO ?? 0.25);
const SAMPLE = process.env.ALL === '1' ? Infinity : Number(process.env.SAMPLE ?? 60);
// (no card of their own, or not script: listed, searched or drawn)
// (portrait genes and DNA, coats of arms: numbers to draw with, shown as pictures, the portrait and the arms)
const SKIP = new Set(['localization', 'flag', 'variable', 'images', 'models', 'characters', 'genes', 'dna_data', 'bookmark_portraits', 'ethnicities', 'coat_of_arms/coat_of_arms']);

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
{
    throw new Error('No CK3 game dir at ' + install);
}

const idx = await fastIndex(gameDir, { cache: true });
const sb = new StoryBuilder(idx);
// (every caller of a scripted effect / trigger read: the cards' text does not depend on the machine's load)
sb.callerBudget = Infinity;

// (a story: the text of every line, title and label in it, not tips, files, references)
const TEXT_KEYS = new Set(['text', 'title', 'label', 'facts', 'conds', 'desc']);
const SKIP_KEYS = new Set(['tip', 'src', 'file', 'ref', 'icon', 'tone', 'image', 'portraits', 'key', 'name', 'type', 'event']);
const storyLen = (v: unknown, text = false): number =>
{
    if (typeof v === 'string')
        return text ? v.length : 0;

    if (Array.isArray(v))
        return v.reduce((n: number, x) => n + storyLen(x, text), 0);

    if (v && typeof v === 'object')
    {
        return Object.entries(v).reduce(
            (n, [k, x]) => n + (SKIP_KEYS.has(k) ? 0 : storyLen(x, text || TEXT_KEYS.has(k) || (k === 'text' && typeof x === 'string'))),
            0
        );
    }

    return 0;
};
const richLen = (r: Rich): number => r.reduce((n, s) => n + (typeof s === 'string' ? s.length : s.text.length), 0);
const linesLen = (ls: Line[] | undefined): number => (ls ?? []).reduce((n, l) => n + richLen(l.text) + linesLen(l.children) + linesLen(l.conditions), 0);
const cardLen = (c: EntityCard): number => c.facts.reduce((n, f) => n + richLen(f), 0) + c.sections.reduce((n, s) => n + (s.title?.length ?? 0) + linesLen(s.lines), 0);
// (the script read: keys and values (comments and whitespace left out); a list of bare values (icons, genes) as at
// most LIST chars: data, not something to describe)
const LIST = 60;
const scriptLen = (nodes: PNode[], own?: (k: string) => boolean): number =>
{
    let bare = 0;
    let n = 0;

    for (const c of nodes)
    {
        // (an entry of its own written inside (a title's de jure titles): its own card)
        if (c.k && own?.(c.k))
            continue;

        if (!c.k)
            bare += typeof c.v === 'string' ? c.v.length + 1 : 0;
        // (pictures picked by terrain or culture (`empty_slot_asset = { … }`): art, summed up on the card)
        else
            n += c.k.length + 3 + (typeof c.v === 'string' ? c.v.length : Array.isArray(c.v) ? (c.k.endsWith('_asset') ? LIST : scriptLen(c.v)) : 0);
    }

    return n + Math.min(bare, LIST);
};

const only = process.argv.slice(2);
const rows: { type: string; short: number; n: number; text: string; }[] = [];
let failed = 0;

for (const t of idx.types())
{
    if (only.length ? !only.includes(t.id) : SKIP.has(t.id))
        continue;

    const names = idx.names(t.id);

    if (!names.length)
        continue;

    const step = Math.max(1, Math.floor(names.length / Math.min(SAMPLE, names.length)));
    const short: { name: string; ratio: number; script: number; text: number; keys: string; }[] = [];
    let n = 0;

    for (let i = 0; i < names.length && n < SAMPLE; i += step)
    {
        const e = idx.get(t.id, names[i])!;
        const d = idx.defNode(e);

        if (!d || !Array.isArray(d.node.v))
            continue;

        const script = scriptLen(d.node.v, t.id === 'landed_titles' ? (k) => /^[hekdcb]_/.test(k) : undefined);

        if (script < MIN)
            continue;

        let text: number;

        try
        {
            text = t.id === 'events' ? storyLen(sb.eventStory(e)) : t.id === 'on_action' ? storyLen(sb.onActionStory(e)) : cardLen(sb.card(e));
        }
        catch (err)
        {
            failed++;
            console.log(`card ${t.id}:${names[i]} failed:`, err instanceof Error ? err.message : err);
            continue;
        }

        n++;

        if (text < script * RATIO)
        {
            const keys = [...new Set(d.node.v.map((c) => c.k).filter(Boolean))].slice(0, 8).join(' ');
            short.push({ name: names[i], ratio: text / script, script, text, keys });
        }
    }

    if (!short.length)
        continue;

    short.sort((a, b) => a.ratio - b.ratio);
    const worst = short
        .slice(0, Number(process.env.WORST ?? 3))
        .map((s) => `      ${s.name}  ${s.text}/${s.script} chars  [${s.keys}]`)
        .join('\n');
    rows.push({
        type: t.id,
        short: short.length,
        n,
        text: `${String(Math.round((100 * short.length) / n)).padStart(3)}% short (${short.length}/${n})  ${t.id}  [${t.label}]\n${worst}`
    });
}

rows.sort((a, b) => b.short / b.n - a.short / a.n);
console.log(rows.map((r) => r.text).join('\n'));
console.log(`\n${rows.length} types with cards shorter than ${Math.round(RATIO * 100)}% of their script (≥ ${MIN} chars)${failed ? ` · ${failed} cards failed` : ''}`);
process.exitCode = rows.length || failed ? 1 : 0;
