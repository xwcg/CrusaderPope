/**
 * Entries and names a game version renamed that a mod's older copies of the game's files still use (migrations.ts `renamed`,
 * docs/mods.md, "Entries and names the game renamed"). The pure part: renameRule.ts reads the files and asks the loaded world.
 *
 * - **Renamed entries** (`renamedPairs`): the mod's copy of a game file (same path) defines a key the game defines nowhere, and the
 *   game's file of that path defines a key no mod defines, in the same gap between the keys both have: the same definition under
 *   another name (1.20: the trait `scholar` is `erudite`) or the old name with one `_word` more or less
 *   (`action_reactive_advice_religion` is `action_reactive_advice_religion_rites`), and no file of the mod names the new key (a mod
 *   written before the rename cannot know it; a mod that renamed a game entry for itself still names the game's key somewhere).
 * - **Renamed spellings** (`alignedValues`, `nearSpelling`, `partRename`): a line of the copy that says what the game's line at the same
 *   place says but for one value, where the two values are near spellings of each other (`artefact_icons_x.dds` /
 *   `artifact_icons_x.dds`, `map_ambient_3D_desert` / `map_ambient_3d_desert`, a name and the name with a `_word` more).
 * - **The texts of an old name** (`twinKey`, `twinText`, `derivedKeys`, `linkTypes`): the game's localization keys built from an
 *   entry's name (`trait_<name>`, `trait_<name>_desc`), written for the old name with the game's text, its data function arguments and
 *   tooltip links of the new name naming the old.
 */
import { parse, type PNode } from '../indexer/parser.ts';

/** A token of a script line and where it stands in the text. */
export interface Tok
{
    t: string;
    s: number;
    e: number;
}

/** Quoted strings, braces, operators, words; a `#` outside quotes ends the line's tokens. */
const TOKEN = /"(?:[^"\\\n]|\\.)*"?|[{}]|[<>!=?]+|#|[^\s{}"<>!=?#]+/g;

/** The tokens of a line (`base`: the line's offset in its text), comments left out. */
export function lineTokens(line: string, base = 0): Tok[]
{
    const out: Tok[] = [];

    for (const m of line.matchAll(TOKEN))
    {
        if (m[0] === '#')
            break;

        out.push({ t: m[0], s: base + m.index, e: base + m.index + m[0].length });
    }

    return out;
}

/** The lines of a text with their offsets. */
function linesOf(text: string): { text: string; at: number; }[]
{
    const out: { text: string; at: number; }[] = [];
    let at = 0;

    for (const line of text.split('\n'))
    {
        out.push({ text: line, at });
        at += line.length + 1;
    }

    return out;
}

/** The tokens of a script text, comments left out. */
export function scriptTokens(text: string): string[]
{
    return linesOf(text).flatMap((l) => lineTokens(l.text).map((x) => x.t));
}

/** A value without its quotes. */
export const unquoted = (v: string): string => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

/** How alike two token lists are as multisets, from 0 to 1: never less than `similarity`, and quick. */
export function bagSimilarity(a: string[], b: string[]): number
{
    if (!a.length && !b.length)
        return 1;

    const count = new Map<string, number>();
    a.forEach((t) => count.set(t, (count.get(t) ?? 0) + 1));
    let same = 0;

    for (const t of b)
    {
        const c = count.get(t) ?? 0;

        if (c > 0)
        {
            same++;
            count.set(t, c - 1);
        }
    }

    return (2 * same) / (a.length + b.length);
}

/**
 * How alike two token lists are, from 0 to 1: twice the longest common subsequence over both lengths. Lists too long for that
 * (more than a million cells) are compared as multisets (`bagSimilarity`).
 */
export function similarity(a: string[], b: string[]): number
{
    if (!a.length && !b.length)
        return 1;

    if (a.length * b.length > 1e6)
        return bagSimilarity(a, b);

    const row = new Array<number>(b.length + 1).fill(0);

    for (let i = 1; i <= a.length; i++)
    {
        let diag = 0;

        for (let j = 1; j <= b.length; j++)
        {
            const up = row[j];
            row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
            diag = up;
        }
    }

    return (2 * row[b.length]) / (a.length + b.length);
}

/** Whether one name is the other with one `_word` more, at the end or at the start (`x` / `x_rites`, `active_x` / `x`). */
export function oneWordMore(a: string, b: string): boolean
{
    const more = (short: string, long: string): boolean =>
        (long.startsWith(short + '_') && !long.slice(short.length + 1).includes('_') && long.length > short.length + 1) ||
        (long.endsWith('_' + short) && !long.slice(0, long.length - short.length - 1).includes('_') && long.length > short.length + 1);

    return a !== b && (more(a, b) || more(b, a));
}

/** The number of single-letter edits from one string to the other, up to `max` (more: `max + 1`). */
function editDistance(a: string, b: string, max: number): number
{
    if (Math.abs(a.length - b.length) > max)
        return max + 1;

    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);

    for (let i = 1; i <= a.length; i++)
    {
        const cur = [i];
        let low = i;

        for (let j = 1; j <= b.length; j++)
        {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            low = Math.min(low, cur[j]);
        }

        if (low > max)
            return max + 1;

        prev = cur;
    }

    return prev[b.length];
}

/** A file name or path's parts: the folder, the stem, the extension (`.dds`). */
function fileParts(v: string): { dir: string; stem: string; ext: string; }
{
    const slash = v.lastIndexOf('/') + 1;
    const dot = v.lastIndexOf('.');
    const ext = dot > slash && /^\.[A-Za-z0-9]{1,9}$/.test(v.slice(dot)) ? v.slice(dot) : '';
    return { dir: v.slice(0, slash), stem: v.slice(slash, v.length - ext.length), ext };
}

/** Letter case and `-` / `_` aside. */
export const looseSpelling = (v: string): string => v.toLowerCase().replace(/-/g, '_');

/**
 * Whether two values are near spellings of one name: the same but for letter case and `-` / `_` (`map_ambient_3D_x` /
 * `map_ambient_3d_x`), one `_word` more or less in the name (a file's stem), or at most two letters apart in a long name
 * (`artefact_icons_x.dds` / `artifact_icons_x.dds`).
 */
export function nearSpelling(a: string, b: string): boolean
{
    const x = unquoted(a);
    const y = unquoted(b);

    if (x === y || !x || !y)
        return false;

    if (looseSpelling(x) === looseSpelling(y))
        return true;

    const fx = fileParts(x);
    const fy = fileParts(y);

    if (fx.dir === fy.dir && fx.ext.toLowerCase() === fy.ext.toLowerCase() && oneWordMore(fx.stem, fy.stem))
        return true;

    return Math.min(x.length, y.length) >= 8 && editDistance(x, y, 2) <= 2;
}

/**
 * The one `_`-separated part of a file name (or a name) that one spelling has where the other has another: `artefact` / `artifact` of
 * `artefact_icons_unique_x.dds` / `artifact_icons_unique_x.dds`. Undefined when the folders, extensions or the number of parts differ,
 * or more than one part does.
 */
export function partRename(a: string, b: string): { from: string; to: string; } | undefined
{
    const fa = fileParts(unquoted(a));
    const fb = fileParts(unquoted(b));

    if (fa.dir !== fb.dir || fa.ext !== fb.ext)
        return undefined;

    const pa = fa.stem.split('_');
    const pb = fb.stem.split('_');

    if (pa.length !== pb.length)
        return undefined;

    const diff = pa.map((p, i) => (p !== pb[i] ? i : -1)).filter((i) => i >= 0);
    return diff.length === 1 && pa[diff[0]] && pb[diff[0]] ? { from: pa[diff[0]], to: pb[diff[0]] } : undefined;
}

/** A value with a part renamed (`partRename`) wherever the part stands in its name; undefined when it has no such part. */
export function withPart(v: string, part: { from: string; to: string; }): string | undefined
{
    const f = fileParts(unquoted(v));
    const parts = f.stem.split('_');

    if (!parts.includes(part.from))
        return undefined;

    return f.dir + parts.map((p) => (p === part.from ? part.to : p)).join('_') + f.ext;
}

/** The top-level definitions of a script text (`key = { … }`), constants and bare values aside. */
export function topEntries(text: string): PNode[]
{
    return parse(text).filter((n) => !!n.k && !n.k.startsWith('@') && Array.isArray(n.v));
}

/** What the pairing needs to know of the loaded world for one file. */
export interface PairWorld
{
    /** a file of the game in the copy's folder defines the key (then the copy's key is no old name: the game still has it) */
    gameDefines(key: string): boolean;
    /** a file of the mods in the copy's folder defines the key (then the mod has the game's key already) */
    modDefines(key: string): boolean;
    /** a file of the mod names the word anywhere (its script, interface and model files, its localization keys) */
    modNames(word: string): boolean;
}

/** An entry the game renamed that the mod's copy still defines under the old name. */
export interface RenamedPair
{
    /** the key the mod's copy defines (the older version's) */
    from: string;
    /** the key the game's file defines in its place */
    to: string;
    /**
     * `body`: the same definition, the old key read as the new (at least 0.9 alike, a body of some size that no other entry of the game's
     * file has); `name`: the new key is the old one with a `_word` more or less (at least 0.8 alike)
     */
    how: 'body' | 'name';
    score: number;
    /** the definition's line in the copy */
    line: number;
}

/** How alike two definitions must be: the same definition under another name, or the old name with a `_word` more or less. */
export const BODY_MIN = 0.9;
export const NAME_MIN = 0.8;
/** The tokens a body must have to tell its entry by itself (`body` pairs): the braces and at least three statements. */
export const MIN_BODY = 11;

/**
 * The entries the game renamed (see the top of the file): per gap between the keys both files define, the copy's keys the game
 * defines nowhere and the game's keys no mod defines, paired when each is the other's best match (no tie), alike enough, and the mod
 * names the new key nowhere. A gap at the start and the end of both files at once (no key in common) pairs nothing.
 */
export function renamedPairs(copy: string, game: string, w: PairWorld): RenamedPair[]
{
    const cn = topEntries(copy);
    const gn = topEntries(game);
    const ck = new Set(cn.map((n) => n.k!));
    const gk = new Set(gn.map((n) => n.k!));
    const shared = new Set([...ck].filter((k) => gk.has(k)));

    if (!shared.size)
        return [];

    // (the gap a key stands in: the nearest shared keys before and after it)
    const gaps = (nodes: PNode[]): Map<string, string> =>
    {
        const out = new Map<string, string>();
        let prev = '^';
        let pending: string[] = [];

        for (const n of nodes)
        {
            if (shared.has(n.k!))
            {
                pending.forEach((k) => out.set(k, prev + '|' + n.k));
                pending = [];
                prev = n.k!;
            }
            else
                pending.push(n.k!);
        }

        pending.forEach((k) => out.set(k, prev + '|$'));
        return out;
    };
    const cg = gaps(cn);
    const gg = gaps(gn);
    // (the last definition of a key in a file wins)
    const last = (nodes: PNode[]): Map<string, PNode> => new Map(nodes.map((n) => [n.k!, n]));
    const cl = last(cn);
    const gl = last(gn);
    const olds = [...cl.keys()].filter((k) => !gk.has(k) && !w.gameDefines(k));
    const news = [...gl.keys()].filter((k) => !ck.has(k) && !w.modDefines(k));
    const out: RenamedPair[] = [];
    // (a body says which entry it is only when it is of some size and no other entry of the game's file has it: a short format block
    // `{ decimals = 0 color = good }` is the body of many)
    let bodies: Map<string, number> | undefined;
    const bodyOf = (n: PNode): string[] => scriptTokens(game.slice(n.vs, n.e));
    const distinctive = (key: string): boolean =>
    {
        if (!bodies)
        {
            bodies = new Map();

            for (const n of gn)
            {
                const b = bodyOf(n).join(' ');
                bodies.set(b, (bodies.get(b) ?? 0) + 1);
            }
        }

        const own = bodyOf(gl.get(key)!);
        return own.length >= MIN_BODY && bodies.get(own.join(' ')) === 1;
    };

    for (const gap of new Set(olds.map((k) => cg.get(k)!)))
    {
        const a = olds.filter((k) => cg.get(k) === gap);
        const b = news.filter((k) => gg.get(k) === gap);

        if (!b.length)
            continue;

        const score = new Map<string, number>();
        const tokens = new Map(b.map((k) => [k, scriptTokens(game.slice(gl.get(k)!.s, gl.get(k)!.e))]));

        for (const from of a)
        {
            const own = scriptTokens(copy.slice(cl.get(from)!.s, cl.get(from)!.e));

            for (const to of b)
            {
                // (the bounds first: the lengths, then the multisets; a pair below the lower threshold even so is no candidate)
                const theirs = tokens.get(to)!;
                const short = Math.min(own.length, theirs.length);

                if ((2 * short) / (own.length + theirs.length) < NAME_MIN)
                {
                    score.set(`${from}|${to}`, 0);
                    continue;
                }

                const mine = own.map((t) => (t === from ? to : t));
                const bound = bagSimilarity(mine, theirs);
                score.set(`${from}|${to}`, bound < NAME_MIN ? bound : similarity(mine, theirs));
            }
        }

        // (each the other's best match, without a tie)
        const best = (others: string[], id: (o: string) => string): string | undefined =>
        {
            const ranked = others.map((o) => ({ o, s: score.get(id(o))! })).sort((x, y) => y.s - x.s);
            return ranked.length && (ranked.length < 2 || ranked[0].s > ranked[1].s) ? ranked[0].o : undefined;
        };

        for (const from of a)
        {
            const to = best(b, (o) => `${from}|${o}`);

            if (!to || best(a, (o) => `${o}|${to}`) !== from)
                continue;

            const s = score.get(`${from}|${to}`)!;
            const how = oneWordMore(from, to) ? 'name' : 'body';

            if (s < (how === 'name' ? NAME_MIN : BODY_MIN) || (how === 'body' && !distinctive(to)) || w.modNames(to))
                continue;

            out.push({ from, to, how, score: s, line: cl.get(from)!.line });
        }
    }

    return out.sort((x, y) => x.line - y.line);
}

/**
 * The edits that rename an entry in a text: the key of each top-level definition of it, and the name itself where it stands as a
 * token inside them (`important_action_type = <name>`), quoted or not. Comments stay.
 */
export function renameEntryEdits(text: string, from: string, to: string): { s: number; e: number; text: string; }[]
{
    const out: { s: number; e: number; text: string; }[] = [];

    for (const n of topEntries(text).filter((x) => x.k === from))
    {
        out.push({ s: n.s, e: n.s + n.kl, text: text.slice(n.s, n.s + n.kl).replace(from, to) });
        const body = text.slice(n.vs, n.e);

        for (const l of linesOf(body))
            for (const x of lineTokens(l.text, n.vs + l.at))
                if (unquoted(x.t) === from)
                    out.push(x.t.startsWith('"') ? { s: x.s + 1, e: x.e - 1, text: to } : { s: x.s, e: x.e, text: to });
    }

    return out;
}

/** Edits applied (they must not overlap; any order). */
export function applyEdits(text: string, edits: { s: number; e: number; text: string; }[]): string
{
    let out = text;

    for (const x of [...edits].sort((a, b) => b.s - a.s))
        out = out.slice(0, x.s) + x.text + out.slice(x.e);

    return out;
}

/** A value of a line that the game's line at the same place writes otherwise. */
export interface AlignedValue
{
    /** the value's span in the copy, quotes aside */
    s: number;
    e: number;
    /** the copy's value and the game's, quotes aside */
    from: string;
    to: string;
    line: number;
}

/** Segments longer than this are not compared line by line (a file the mod rewrote: nothing stands at the same place). */
const MAX_SEGMENT = 2000;

/**
 * A line without its comment and the blanks around it: the lines of both files are compared so (two lines that differ in their inner
 * blanks only are different lines here; their tokens are compared after, so such a pair is no pair of values).
 */
function normLine(line: string): string
{
    const hash = line.indexOf('#');

    if (hash < 0)
        return line.trim();

    let quoted = false;

    for (let i = 0; i < line.length; i++)
    {
        if (line[i] === '"')
            quoted = !quoted;
        else if (!quoted && line[i] === '#')
            return line.slice(0, i).trim();
    }

    return line.trim();
}

/**
 * The values of the mod's copy that the game's file of the same path writes otherwise at the same place: the files are cut into
 * segments at the lines that each holds once (in the order both have them), and in a segment a line of the copy that the game's
 * lacks is paired with the one line of the game's segment that has the same tokens but for one value after a `=` (`icon = "x.dds"`
 * against `icon = "y.dds"`). Where the copy's line matches several, only a near spelling counts, and only when it is one.
 * `changed`: called with each line of the copy the game's segment lacks (compared or not), its text and offset.
 */
export function alignedValues(copy: string, game: string, changed?: (text: string, at: number) => void): AlignedValue[]
{
    if (copy === game)
        return [];

    type Line = { text: string; at: number; norm: string; line: number; toks?: Tok[]; };
    const read = (text: string): Line[] => linesOf(text).map((l, i) => ({ text: l.text, at: l.at, norm: normLine(l.text), line: i + 1 })).filter((l) => l.norm);
    const toks = (l: Line): Tok[] => (l.toks ??= lineTokens(l.text, l.at));
    const cl = read(copy);
    const gl = read(game);
    const count = (ls: Line[]): Map<string, number> =>
    {
        const m = new Map<string, number>();
        ls.forEach((l) => m.set(l.norm, (m.get(l.norm) ?? 0) + 1));
        return m;
    };
    const cc = count(cl);
    const gc = count(gl);
    const gAt = new Map<string, number>();
    gl.forEach((l, i) => void (gc.get(l.norm) === 1 && gAt.set(l.norm, i)));
    // (the lines each file holds once, in the copy's order; the longest run that is in order in the game's file too)
    const pairs = cl.map((l, i) => (cc.get(l.norm) === 1 && gAt.has(l.norm) ? [i, gAt.get(l.norm)!] : undefined)).filter((p): p is number[] => !!p);
    const anchors = increasing(pairs);
    const out: AlignedValue[] = [];
    let pc = -1;
    let pg = -1;

    for (const [ci, gi] of [...anchors, [cl.length, gl.length]])
    {
        const cs = cl.slice(pc + 1, ci);
        const gs = gl.slice(pg + 1, gi);
        pc = ci;
        pg = gi;

        const gNorms = new Set(gs.map((l) => l.norm));
        const lacking = cs.filter((l) => !gNorms.has(l.norm));
        lacking.forEach((l) => changed?.(l.text, l.at));

        if (!lacking.length || !gs.length || cs.length > MAX_SEGMENT || gs.length > MAX_SEGMENT)
            continue;

        // (the game's lines the copy's segment lacks, by their first token: a pair has the same key)
        const cNorms = new Set(cs.map((l) => l.norm));
        const free = new Map<string, Line[]>();

        for (const g of gs.filter((l) => !cNorms.has(l.norm)))
        {
            const first = toks(g)[0]?.t ?? '';
            free.set(first, [...(free.get(first) ?? []), g]);
        }

        const used = new Set<Line>();

        for (const c of lacking)
        {
            const ct = toks(c);
            const fits: { g: Line; i: number; }[] = [];

            for (const g of free.get(ct[0]?.t ?? '') ?? [])
            {
                const gt = toks(g);

                if (used.has(g) || gt.length !== ct.length)
                    continue;

                const diff = ct.map((x, i) => (x.t !== gt[i].t ? i : -1)).filter((i) => i >= 0);
                const i = diff[0];

                if (diff.length === 1 && i >= 2 && ct[i - 1].t === '=' && !/^[{}]$/.test(ct[i].t) && !/^[{}]$/.test(gt[i].t))
                    fits.push({ g, i });
            }

            const near = fits.length > 1 ? fits.filter((f) => nearSpelling(ct[f.i].t, toks(f.g)[f.i].t)) : fits;

            if (near.length !== 1)
                continue;

            const { g, i } = near[0];
            const x = ct[i];
            const quoted = x.t.length >= 2 && x.t.startsWith('"') && x.t.endsWith('"');
            used.add(g);
            out.push({ s: quoted ? x.s + 1 : x.s, e: quoted ? x.e - 1 : x.e, from: unquoted(x.t), to: unquoted(toks(g)[i].t), line: c.line });
        }
    }

    return out;
}

/** The longest subsequence of `[a, b]` pairs (ordered by `a`) whose `b` increase too (patience sorting). */
function increasing(pairs: number[][]): number[][]
{
    const tails: number[] = [];
    const prev = new Array<number>(pairs.length).fill(-1);

    for (let i = 0; i < pairs.length; i++)
    {
        let lo = 0;
        let hi = tails.length;

        while (lo < hi)
        {
            const mid = (lo + hi) >> 1;

            if (pairs[tails[mid]][1] < pairs[i][1])
                lo = mid + 1;
            else
                hi = mid;
        }

        prev[i] = lo > 0 ? tails[lo - 1] : -1;
        tails[lo] = i;
    }

    const out: number[][] = [];

    for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i])
        out.unshift(pairs[i]);

    return out;
}

/** The values after a `=` in a text, with their spans (quotes aside). */
export function valueTokens(text: string): { s: number; e: number; v: string; }[]
{
    const out: { s: number; e: number; v: string; }[] = [];

    for (const l of linesOf(text))
    {
        const toks = lineTokens(l.text, l.at);

        for (let i = 1; i < toks.length; i++)
        {
            const x = toks[i];

            if (toks[i - 1].t !== '=' || /^[{}]$/.test(x.t))
                continue;

            const quoted = x.t.length >= 2 && x.t.startsWith('"') && x.t.endsWith('"');
            out.push({ s: quoted ? x.s + 1 : x.s, e: quoted ? x.e - 1 : x.e, v: unquoted(x.t) });
        }
    }

    return out;
}

/** A text with the values after a `=` that the map names replaced by its spelling (the whole value, quotes kept). */
export function respelled(text: string, values: Map<string, string>): string
{
    return values.size ? applyEdits(text, valueTokens(text).filter((x) => values.has(x.v)).map((x) => ({ s: x.s, e: x.e, text: values.get(x.v)! }))) : text;
}

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a name stands in a key as one of its `_` / `.` separated parts (letter case aside). */
const partOf = (name: string): RegExp => new RegExp(`(^|[._])(${escaped(name)})(?=[._]|$)`, 'i');

/**
 * A localization key with an entry's new name as a part (`trait_erudite`, `EVENT_WINDOW_OPTION_AVAILABLE_ERUDITE`), written with the
 * old name in the same letter case; undefined when the key has no such part.
 */
export function twinKey(key: string, newName: string, oldName: string): string | undefined
{
    const m = partOf(newName).exec(key);

    if (!m)
        return undefined;

    const at = m.index + m[1].length;
    const upper = m[2] !== m[2].toLowerCase() && m[2] === m[2].toUpperCase();
    return key.slice(0, at) + (upper ? oldName.toUpperCase() : oldName) + key.slice(at + m[2].length);
}

/**
 * The game's text of a key, for the old name: the new name as a data function's argument (`GetTrait('erudite')`) becomes the old, and
 * so does the new name as the key of a tooltip link of the entry's kind (`links`, `linkTypes`: `#TOOLTIP:GAME_TRAIT,erudite,…`).
 */
export function twinText(text: string, newName: string, oldName: string, links: string[] = []): string
{
    const out = text.split(`'${newName}'`).join(`'${oldName}'`);

    if (!links.length || !out.includes('#TOOLTIP:'))
        return out;

    const link = new RegExp(`(#TOOLTIP:(?:${links.map(escaped).join('|')}),)${escaped(newName)}(?![A-Za-z0-9_\\-])`, 'g');
    return out.replace(link, (_, head: string) => head + oldName);
}

/** A tooltip link of a text: `#TOOLTIP:<type>,<key>` (more arguments may follow the key). */
const TOOLTIP_LINK = /#TOOLTIP:([A-Z_]+),([A-Za-z0-9_-]+)/g;

/** The tooltip links of texts: per link type the keys it names (a key the program fills in, `$DESC_KEY$`, is none). */
export function tooltipLinks(texts: Iterable<string>): Map<string, Set<string>>
{
    const out = new Map<string, Set<string>>();

    for (const t of texts)
        if (t.includes('#TOOLTIP:'))
            for (const m of t.matchAll(TOOLTIP_LINK))
            {
                const keys = out.get(m[1]) ?? new Set<string>();
                out.set(m[1], keys.add(m[2]));
            }

    return out;
}

/**
 * The tooltip link types that name the entries of a folder (`folderKeys`, its keys in the game): more than half of the keys the texts
 * link with the type are keys of the folder, at least two of them besides the entry's own (`name`). The game's Russian texts link 71
 * keys with `GAME_TRAIT`, all of them traits; a type whose keys are mostly another folder's, or that names the entry alone, is none.
 */
export function linkTypes(links: Map<string, Set<string>>, folderKeys: Set<string>, name: string): string[]
{
    const out: string[] = [];

    for (const [type, keys] of links)
    {
        const own = [...keys].filter((k) => folderKeys.has(k));

        if (own.filter((k) => k !== name).length >= 2 && 2 * own.length > keys.size)
            out.push(type);
    }

    return out.sort();
}

/**
 * Of the game's localization keys with an entry's new name as a part, the ones its program builds from an entry's name: the same key
 * with the name of another entry of the folder in its place exists for at least two of them (`trait_<name>`, `trait_<name>_desc`,
 * `SUCCESSION_EVENT_WINDOW_HEIR_TRAIT_<NAME>`). A text that happens to mention the name (`every_attending_poet_erudite`) is not one.
 */
export function derivedKeys(newName: string, entries: Iterable<string>, has: (key: string) => boolean, keys: Iterable<string>): string[]
{
    const re = partOf(newName);
    const others = [...entries].filter((e) => e !== newName);
    const out: string[] = [];

    for (const key of keys)
    {
        const m = re.exec(key);

        if (!m)
            continue;

        const at = m.index + m[1].length;
        const upper = m[2] !== m[2].toLowerCase() && m[2] === m[2].toUpperCase();
        const pre = key.slice(0, at);
        const post = key.slice(at + m[2].length);
        let uses = 0;

        for (const e of others)
            if (has(pre + (upper ? e.toUpperCase() : e) + post) && ++uses >= 2)
                break;

        if (uses >= 2)
            out.push(key);
    }

    return out;
}

/** A localization file of a language with these keys and texts (the texts as they stand between the quotes). */
export function locFile(language: string, lines: [string, string][]): string
{
    return `﻿l_${language}:\n` + lines.map(([k, t]) => ` ${k}: "${t}"\n`).join('');
}
