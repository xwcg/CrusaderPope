/**
 * The coats of arms of common/coat_of_arms (docs/map.md, "Coats of arms"), read through the index's layering: the
 * entries of coat_of_arms/ (later files win), their templates, the template lists with their special selections, the
 * dynamic definitions, and a design resolved from an entry — patterns, colours, emblems with their instances,
 * sub-arms, `parent`, `list "…"` picks, @constants.
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { colorOf } from '../map/color.ts';
import type { CoaDesign, CoaEmblem, CoaSub } from '../../shared/api.ts';

/** common/defines/graphic/00_coa.txt: NCoatOfArms FALLBACK_COLOR = { 204 202 200 } — under the pattern, and for colours not given */
export const FALLBACK = '#cccac8';
const DIR = 'gfx/coat_of_arms/';
/** chains of `98 = c_perigord` and `parent` / `sub` nesting are cut here */
const MAX_DEPTH = 8;

/** An entry's place in a file (re-parsed on use), or the entry it names (`98 = c_perigord`, `house_x = 370`). */
type Slot = { file: number; s: number; e: number; } | { alias: string; };
interface Pick
{
    w: number;
    v: string;
}
/** A template list: its picks, and more while a `special_selection`'s trigger holds (added to the same draw). */
interface List
{
    picks: Pick[];
    special: { trigger: PNode[]; picks: Pick[]; }[];
}
/** Whether a special selection's trigger holds (none: only the unconditional picks). */
export type CoaTest = (trigger: PNode[]) => boolean;
/** A title's dynamic definition item: the first whose trigger holds names the arms. */
export interface DynamicItem
{
    trigger: PNode[];
    coa: string;
}

const picksOf = (list: PNode[]): Pick[] => list.flatMap((c): Pick[] => (c.k && /^\d+$/.test(c.k) && typeof c.v === 'string' ? [{ w: Number(c.k), v: c.v }] : []));

/** FNV-1a: random picks keyed by the entry and the slot — the same arms every time. */
function hash(s: string): number
{
    let h = 0x811c9dc5;

    for (let i = 0; i < s.length; i++)
        h = Math.imul(h ^ s.charCodeAt(i), 16777619);

    return h >>> 0;
}

const kids = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);
const bare = (n: PNode | undefined): string[] => kids(n).flatMap((c) => (c.k === null && typeof c.v === 'string' ? [c.v] : []));

/** `a + b * (c - 1)` with constants (inline math `@[ … ]`). */
function evalMath(expr: string, get: (name: string) => number): number
{
    const toks = expr.match(/\d*\.?\d+|[A-Za-z_]\w*|[-+*/()]/g) ?? [];
    let i = 0;
    const atom = (): number =>
    {
        const t = toks[i++];

        if (t === '(')
        {
            const v = sum();
            i++;
            return v;
        }

        if (t === '-')
            return -atom();

        return /^[\d.]/.test(t ?? '') ? Number(t) : get(t ?? '');
    };
    const product = (): number =>
    {
        let v = atom();

        while (toks[i] === '*' || toks[i] === '/')
            v = toks[i++] === '*' ? v * atom() : v / atom();

        return v;
    };
    const sum = (): number =>
    {
        let v = product();

        while (toks[i] === '+' || toks[i] === '-')
            v = toks[i++] === '+' ? v + product() : v - product();

        return v;
    };
    return sum();
}

export class CoaBook
{
    private idx: GameIndex;
    private texts: string[] = [];
    /** per file: `@name = value` anywhere in it (the value as written) */
    private consts: Map<string, string>[] = [];
    private entries = new Map<string, Slot>();
    private templates = new Map<string, Slot>();
    /** `<group>:<list>` (color_lists:normal_colors, colored_emblem_texture_lists:charge …) → weighted picks */
    private lists = new Map<string, List>();
    private dynamic: Map<string, DynamicItem[]> | undefined;
    private named = new Map<string, string | undefined>();

    constructor(idx: GameIndex)
    {
        this.idx = idx;
        const vfs = idx.vfs;

        for (const f of vfs.list('common/coat_of_arms/coat_of_arms', { ext: /\.txt$/i }))
        {
            const text = vfs.readText(f) ?? '';
            const file = this.texts.length;
            const consts = new Map<string, string>();
            const walk = (list: PNode[]): void =>
            {
                for (const n of list)
                {
                    if (n.k?.startsWith('@') && typeof n.v === 'string')
                        consts.set(n.k.slice(1), n.v);
                    else if (Array.isArray(n.v))
                        walk(n.v);
                }
            };
            const ast = parse(text);
            walk(ast);
            this.texts.push(text);
            this.consts.push(consts);

            for (const n of ast)
            {
                if (!n.k || n.k.startsWith('@'))
                    continue;

                // `template = { name = { … } }`: arms the template lists pick from
                if (n.k === 'template' && Array.isArray(n.v))
                {
                    for (const t of n.v)
                        if (t.k && Array.isArray(t.v))
                            this.templates.set(t.k, { file, s: t.s, e: t.e });
                }

                if (n.k !== 'template')
                    this.entries.set(n.k, Array.isArray(n.v) ? { file, s: n.s, e: n.e } : { alias: n.v });
            }
        }

        // template_lists: `<group> = { <list> = { 30 = "red" … special_selection = { trigger = { … } 20 = "red" } } }` —
        // the triggers ask about the character the arms are rolled for (root, scope:culture, scope:faith, scope:title)
        for (const f of vfs.list('common/coat_of_arms/template_lists', { ext: /\.txt$/i }))
        {
            for (const g of parse(vfs.readText(f) ?? ''))
            {
                for (const l of kids(g))
                {
                    if (!l.k || !Array.isArray(l.v))
                        continue;

                    const special = l.v.filter((c) => c.k === 'special_selection').map((c) => ({ trigger: kids(kids(c).find((x) => x.k === 'trigger')), picks: picksOf(kids(c)) }));
                    this.lists.set(`${g.k}:${l.k}`, { picks: picksOf(l.v), special });
                }
            }
        }
    }

    /**
     * A title's dynamic definition (common/coat_of_arms/dynamic_definitions: `k_england = { item = { trigger = { … }
     * coat_of_arms = k_england_norman } }`; root in the triggers is the title). A later file's definition replaces.
     */
    dynamicItems(title: string): DynamicItem[] | undefined
    {
        if (!this.dynamic)
        {
            this.dynamic = new Map();
            const vfs = this.idx.vfs;

            for (const f of vfs.list('common/coat_of_arms/dynamic_definitions', { ext: /\.txt$/i }))
            {
                for (const t of parse(vfs.readText(f) ?? ''))
                {
                    if (!t.k || !Array.isArray(t.v))
                        continue;

                    const items = t.v.filter((c) => c.k === 'item').flatMap((c): DynamicItem[] =>
                    {
                        const coa = kids(c).find((x) => x.k === 'coat_of_arms')?.v;
                        return typeof coa === 'string' ? [{ trigger: kids(kids(c).find((x) => x.k === 'trigger')), coa }] : [];
                    });
                    this.dynamic.set(t.k, items);
                }
            }
        }

        return this.dynamic.get(title);
    }

    has(key: string): boolean
    {
        return this.entries.has(key);
    }

    /** An entry's definition, following `98 = c_perigord`; `to` is the entry it ends at. */
    entry(key: string): { list: PNode[]; file: number; to: string; } | undefined
    {
        let slot = this.entries.get(key);

        for (let n = 0; slot && 'alias' in slot && n < MAX_DEPTH; n++)
            slot = this.entries.get(key = slot.alias);

        return slot && !('alias' in slot) ? { list: this.block(slot), file: slot.file, to: key } : undefined;
    }

    template(name: string): { list: PNode[]; file: number; } | undefined
    {
        const slot = this.templates.get(name);
        return slot && !('alias' in slot) ? { list: this.block(slot), file: slot.file } : undefined;
    }

    private block(slot: { file: number; s: number; e: number; }): PNode[]
    {
        return kids(parse(this.texts[slot.file].slice(slot.s, slot.e))[0]);
    }

    /**
     * A weighted pick from a template list, the same for the same seed and pool (none: the list is missing or empty);
     * the picks of the special selections `test` passes join the unconditional ones.
     */
    pick(group: string, list: string, seed: string, test?: CoaTest): string | undefined
    {
        const l = this.lists.get(`${group}:${list}`);
        const picks = [...(l?.picks ?? []), ...(test ? (l?.special ?? []).filter((s) => test(s.trigger)).flatMap((s) => s.picks) : [])].filter((p) => p.w > 0);
        const total = picks.reduce((s, p) => s + p.w, 0);
        let r = total ? hash(seed) % total : 0;

        for (const p of picks)
            if ((r -= p.w) < 0)
                return p.v;

        return undefined;
    }

    /** A named colour of common/named_colors (`red = hsv { … }`; a name may point to another). */
    namedColor(name: string, depth = 0): string | undefined
    {
        if (this.named.has(name))
            return this.named.get(name);

        const e = this.idx.get('named_colors', name);
        const n = e && this.idx.defNode(e)?.node;
        const c = n && typeof n.v === 'string' ? (depth < MAX_DEPTH ? this.namedColor(n.v, depth + 1) : undefined) : colorOf(n);
        this.named.set(name, c);
        return c;
    }

    /** A number as written: `0.5`, `@name`, `@[ expr ]` (with the file's constants). */
    private num(v: string | undefined, file: number, def: number, depth = 0): number
    {
        if (v === undefined)
            return def;

        let x: number;

        if (v.startsWith('@['))
            x = evalMath(v.slice(2, -1), (name) => this.num('@' + name, file, NaN, depth + 1));
        else if (v.startsWith('@'))
            x = depth < MAX_DEPTH ? this.num(this.consts[file].get(v.slice(1)), file, NaN, depth + 1) : NaN;
        else
            x = Number(v);

        return Number.isFinite(x) ? x : def;
    }

    /** A value that may be `list "name"` (the next bare value names the list): the value, or the pick. */
    private valueAt(list: PNode[], i: number, group: string, seed: string, test: CoaTest | undefined): string | undefined
    {
        const c = list[i];

        if (typeof c.v !== 'string')
            return undefined;

        const next = list[i + 1];

        if (c.v === 'list' && next?.k === null && typeof next.v === 'string')
            return this.pick(group, next.v, seed, test);

        return c.v;
    }

    /** A colour: named, `rgb { }` / `hsv { }`, `list "…"`, or another slot (`color2`: that one of `slots`). */
    private colorAt(list: PNode[], i: number, slots: string[] | undefined, seed: string, test: CoaTest | undefined): string | undefined
    {
        const c = list[i];

        if (Array.isArray(c.v))
            return colorOf(c);

        const v = this.valueAt(list, i, 'color_lists', seed, test);
        const slot = /^color([1-5])$/.exec(v ?? '');

        if (slot)
            return slots?.[Number(slot[1]) - 1];

        return v ? this.namedColor(v) : undefined;
    }

    /** `color1` … `color<n>` of a block; slots naming other slots (`color2 = color1`) are taken from `slots`, else from these. */
    private colors(list: PNode[], n: number, slots: string[] | undefined, seed: string, test: CoaTest | undefined, base?: string[]): string[]
    {
        const own: (string | undefined)[] = [];
        const refs: [number, number][] = [];
        list.forEach((c, i) =>
        {
            const m = c.k && /^color([1-5])$/.exec(c.k);

            if (!m)
                return;

            const k = Number(m[1]) - 1;

            if (k >= n)
                return;

            const ref = typeof c.v === 'string' && !slots ? /^color([1-5])$/.exec(c.v) : null;

            if (ref)
                refs.push([k, Number(ref[1]) - 1]);
            else
                own[k] = this.colorAt(list, i, slots, `${seed}|${c.k}`, test);
        });

        for (const [k, r] of refs)
            own[k] = own[r] ?? base?.[r];

        return Array.from({ length: n }, (_, k) => own[k] ?? base?.[k] ?? FALLBACK);
    }

    /**
     * The design of an entry's block: `parent` (another entry these arms start from), `pattern`, `color1`–`color5`,
     * `sub = { parent instance = { offset scale } }`, `colored_emblem` / `textured_emblem` `{ texture color1–3 mask
     * instance = { position scale rotation depth } }`. `seed` keys the random picks, `test` decides their special selections.
     */
    design(list: PNode[], file: number, seed: string, test?: CoaTest, depth = 0): CoaDesign
    {
        const parentKey = list.find((c) => c.k === 'parent' && typeof c.v === 'string')?.v as string | undefined;
        const parent = parentKey && depth < MAX_DEPTH ? this.entry(parentKey) : undefined;
        const base = parent ? this.design(parent.list, parent.file, `${seed}|${parent.to}`, test, depth + 1) : undefined;
        const pi = list.findIndex((c) => c.k === 'pattern');
        const pattern = pi >= 0 ? this.valueAt(list, pi, 'pattern_texture_lists', `${seed}|pattern`, test) : undefined;
        const colors = this.colors(list, 5, undefined, seed, test, base?.colors);
        const subs: CoaSub[] = [...(base?.subs ?? [])];
        const layers: (CoaEmblem & { depth: number; })[] = (base?.emblems ?? []).map((e) => ({ ...e, depth: 0 }));
        list.forEach((n, i) =>
        {
            if (!Array.isArray(n.v))
                return;

            if (n.k === 'sub')
            {
                const p = n.v.find((c) => c.k === 'parent' && typeof c.v === 'string')?.v as string | undefined;
                const from = p && depth < MAX_DEPTH ? this.entry(p) : undefined;
                const design = from ? this.design(from.list, from.file, `${seed}|sub${i}`, test, depth + 1) : this.design(n.v, file, `${seed}|sub${i}`, test, depth + 1);
                const at = n.v.filter((c) => c.k === 'instance').map((inst): [number, number, number, number] =>
                {
                    const [x, y] = this.pair(inst, 'offset', file, 0);
                    const [w, h] = this.pair(inst, 'scale', file, 1);
                    return [x, y, w, h];
                });
                subs.push({ design, at: at.length ? at : [[0, 0, 1, 1]] });
                return;
            }

            if (n.k !== 'colored_emblem' && n.k !== 'textured_emblem')
                return;

            const colored = n.k === 'colored_emblem';
            const ti = n.v.findIndex((c) => c.k === 'texture');
            const tex = ti >= 0 ? this.valueAt(n.v, ti, colored ? 'colored_emblem_texture_lists' : 'textured_emblem_texture_lists', `${seed}|emblem${i}`, test) : undefined;

            if (!tex)
                return;

            const texture = DIR + (colored ? 'colored_emblems/' : 'textured_emblems/') + tex;
            const ecolors = colored ? this.colors(n.v, 3, colors, `${seed}|emblem${i}`, test) : undefined;
            // `mask = { 1 }`, `{ 0 2 0 }`: the pattern colours it shows on (0 = none)
            const mask = bare(n.v.find((c) => c.k === 'mask'))
                .map(Number)
                .filter((m) => m >= 1 && m <= 3);
            const instances = n.v.filter((c) => c.k === 'instance');

            for (const inst of instances.length ? instances : [undefined])
            {
                const [x, y] = this.pair(inst, 'position', file, 0.5);
                const [sx, sy] = this.pair(inst, 'scale', file, 1);
                const e: CoaEmblem & { depth: number; } = { texture, x, y, sx, sy, rotation: this.num(this.scalar(inst, 'rotation'), file, 0), depth: this.num(this.scalar(inst, 'depth'), file, 0) };

                if (ecolors)
                    e.colors = ecolors;

                if (mask.length)
                    e.mask = mask;

                layers.push(e);
            }
        });
        // `depth` (the designer writes 1.01, 2.01 …): higher is further back; the same depth keeps the written order
        const emblems = layers
            .map((l, i) => ({ l, i }))
            .sort((a, b) => b.l.depth - a.l.depth || a.i - b.i)
            .map(({ l: { depth: _, ...e } }) => e);
        return { pattern: pattern ? DIR + 'patterns/' + pattern : (base?.pattern ?? DIR + 'patterns/pattern_solid.dds'), colors, subs, emblems };
    }

    private scalar(n: PNode | undefined, key: string): string | undefined
    {
        const c = kids(n).find((x) => x.k === key);
        return typeof c?.v === 'string' ? c.v : undefined;
    }

    private pair(n: PNode | undefined, key: string, file: number, def: number): [number, number]
    {
        const [a, b] = bare(kids(n).find((x) => x.k === key));
        return [this.num(a, file, def), this.num(b, file, def)];
    }
}
