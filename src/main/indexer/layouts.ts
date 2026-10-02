/**
 * Definitions whose layout changed between game versions (docs/game-structure.md, "Layouts that changed"). Both are
 * read: the files' shape decides, not the version number — a mod written for an older version can load over a newer
 * game.
 * - Faiths: up to 1.19 blocks in their religion (`religion_types`: `faiths = { <faith> = { … } }`; colour, icon,
 *   religious_head, `holy_site = x`, `doctrine = x` at the faith's top). From 1.20 top-level in `religion/faith_types`:
 *   `faith_details = { religion color icon religious_head graphical_faith … }`, `holy_sites` / `eminent_holy_sites`
 *   and `doctrines` / `tenets` lists, a `main_rite`.
 * - Laws: up to 1.19 blocks in their group (common/laws). From 1.20 common/laws holds the laws (`law_group_type`,
 *   `index`), common/law_groups the groups.
 * - Doctrine groups: up to 1.19 a group lists its doctrines (`doctrine_types = { … }`); from 1.20 a doctrine names its
 *   group (`doctrine_group_type`).
 * - History: up to 1.19 characters and provinces name their faith (`religion` / `faith`); from 1.20 mostly their rite
 *   (`rite = x`, it wins over a faith), whose faith depends on the date (history/faiths: RiteHistory).
 */
import { parse, type PNode } from './parser.ts';
import { T_FAITH } from './schema.ts';
import type { Entity, GameIndex } from './gameIndex.ts';

const isBlock = (n: PNode | undefined): n is PNode & { v: PNode[]; } => !!n && Array.isArray(n.v);
const scalar = (body: PNode[], k: string): string | undefined =>
{
    const n = body.find((c) => c.k === k && typeof c.v === 'string');
    return n?.v as string | undefined;
};
/** the bare words of a list block (`holy_sites = { a b }`) */
const words = (n: PNode | undefined): PNode[] => (isBlock(n) ? n.v.filter((c) => c.k === null && typeof c.v === 'string') : []);

/** The statements of an entry's winning definition. */
export function bodyOf(idx: GameIndex, e: Entity | undefined): PNode[]
{
    const n = e && idx.defNode(e)?.node;
    return isBlock(n) ? n.v : [];
}

/** A faith's `faith_details` block (1.20), if it has one. */
export function faithDetails(body: PNode[]): (PNode & { v: PNode[]; }) | undefined
{
    const d = body.find((c) => c.k === 'faith_details');
    return isBlock(d) ? d : undefined;
}

/** A faith setting written at its top (up to 1.19) or in its `faith_details` (1.20): color, icon, religious_head … */
export function faithField(body: PNode[], key: string): PNode | undefined
{
    return body.find((c) => c.k === key) ?? faithDetails(body)?.v.find((c) => c.k === key);
}

/** The religion a faith belongs to: `faith_details = { religion = x }`, else the religion it is written in. */
export function faithReligion(idx: GameIndex, faith: Entity): Entity | undefined
{
    const named = faithField(bodyOf(idx, faith), 'religion');

    if (typeof named?.v === 'string')
        return idx.get('religion/religion_types', named.v);

    const d = idx.winningDef(faith);

    if (!d)
        return undefined;

    for (const name of idx.names('religion/religion_types'))
    {
        const r = idx.get('religion/religion_types', name)!;
        const rd = idx.winningDef(r);

        if (rd && rd.file === d.file && rd.start <= d.start && d.end <= rd.end)
            return r;
    }

    return undefined;
}

/** A religion's faiths: those written in its `faiths = { }` and those naming it in their `faith_details`. */
export function religionFaiths(idx: GameIndex, religion: Entity): Entity[]
{
    const out = new Set<Entity>();

    for (const c of bodyOf(idx, religion))
        if (c.k === 'faiths' && isBlock(c))
        {
            for (const f of c.v)
            {
                const e = f.k && isBlock(f) ? idx.get(T_FAITH, f.k) : undefined;

                if (e)
                    out.add(e);
            }
        }

    for (const name of idx.names(T_FAITH))
    {
        const e = idx.get(T_FAITH, name)!;
        const r = faithField(bodyOf(idx, e), 'religion');

        if (r?.v === religion.name)
            out.add(e);
    }

    return [...out];
}

export interface HolySite
{
    name: string;
    /** the statement (`holy_site = x`) or the list's word */
    node: PNode;
    /** an eminent one (1.20): global bonuses too */
    eminent: boolean;
}

/** `holy_site = x` (up to 1.19), `holy_sites = { … }` and `eminent_holy_sites = { … }` (1.20). */
export function faithHolySites(body: PNode[]): HolySite[]
{
    const out: HolySite[] = [];

    for (const c of body)
    {
        if (c.k === 'holy_site' && typeof c.v === 'string')
            out.push({ name: c.v, node: c, eminent: false });
        else if (c.k === 'holy_sites' || c.k === 'eminent_holy_sites')
            out.push(...words(c).map((w) => ({ name: w.v as string, node: w, eminent: c.k === 'eminent_holy_sites' })));
    }

    return out;
}

/** A faith's or rite's tenets (1.20): `tenets = { … }` and `tenet_selection_pair = { requires_dlc_flag tenet fallback_tenet }`. */
export function tenetsOf(body: PNode[]): { name: string; node: PNode; dlc?: string; fallback?: string; }[]
{
    const out: { name: string; node: PNode; dlc?: string; fallback?: string; }[] = [];

    for (const c of body)
    {
        if (c.k === 'tenets')
            out.push(...words(c).map((w) => ({ name: w.v as string, node: w })));
        else if (c.k === 'tenet_selection_pair' && isBlock(c))
        {
            const t = scalar(c.v, 'tenet');

            if (t)
                out.push({ name: t, node: c, dlc: scalar(c.v, 'requires_dlc_flag'), fallback: scalar(c.v, 'fallback_tenet') });
        }
    }

    return out;
}

/** A law's group: `law_group_type = x` (1.20); undefined for a law written in its group (the caller's enclosing one). */
export function lawGroupType(body: PNode[]): string | undefined
{
    return scalar(body, 'law_group_type');
}

/**
 * A law group's laws in order: the laws naming it (1.20), by their `index`; else its blocks (up to 1.19 — a 1.20 group
 * has blocks of its own that are no laws: `required_government_flag`, `can_have_group` …).
 */
export function groupLaws(idx: GameIndex, group: Entity, body: PNode[], notLaws: Set<string>): { name: string; node?: PNode; }[]
{
    const named: { name: string; index: number; at: number; }[] = [];

    for (const name of idx.names('laws'))
    {
        const e = idx.get('laws', name)!;
        const b = bodyOf(idx, e);

        if (lawGroupType(b) === group.name)
            named.push({ name, index: Number(scalar(b, 'index') ?? 0) || 0, at: idx.winningDef(e)?.start ?? 0 });
    }

    if (named.length)
        return named.sort((x, y) => x.index - y.index || x.at - y.at).map(({ name }) => ({ name }));

    return body.filter((n) => n.k && isBlock(n) && !notLaws.has(n.k)).map((n) => ({ name: n.k!, node: n }));
}

/** Whether the loaded game writes a doctrine's group on the doctrine (1.20: `doctrine_group_type`). */
export function doctrinesNameTheirGroup(idx: GameIndex): boolean
{
    return idx.names('religion/doctrine_types').some((n) => scalar(bodyOf(idx, idx.get('religion/doctrine_types', n)), 'doctrine_group_type') !== undefined);
}

/** `y.m.d` (also `y`, `y.m`) as a number to compare: y·10000 + m·100 + d */
function dayOf(d: string): number
{
    const [y, m, day] = d.split('.').map(Number);
    return y * 10000 + (m || 1) * 100 + (day || 1);
}

const DATE = /^\d+(\.\d*){0,2}\.?$/;

/**
 * Which faith a rite belongs to at a date (1.20). history/faiths/<file>: `<faith> = { <date> = { main_rite = r
 * rites = { r = { … } } rite = { rite = r … } } }` — a rite named there is the faith's from that date until another
 * faith's history takes it ("rites can only be removed from a faith by adding them to another one",
 * _faith_history.info); before any history, the rite type's own `faith = x`.
 */
export class RiteHistory
{
    private idx: GameIndex;
    /** per rite: [date, faith] ascending */
    private moves = new Map<string, [number, string][]>();

    constructor(idx: GameIndex)
    {
        this.idx = idx;

        for (const file of idx.vfs.list('history/faiths', { ext: /\.txt$/i }))
        {
            const text = idx.vfs.readText(file);

            for (const f of text === undefined ? [] : parse(text))
            {
                if (!f.k || !isBlock(f))
                    continue;

                for (const d of f.v)
                {
                    if (!d.k || !DATE.test(d.k) || !isBlock(d))
                        continue;

                    const at = dayOf(d.k);
                    const named = new Set<string>();

                    for (const c of d.v)
                    {
                        if (c.k === 'main_rite' && typeof c.v === 'string')
                            named.add(c.v);
                        else if (c.k === 'rites' && isBlock(c))
                            c.v.forEach((r) => r.k && named.add(r.k));
                        else if (c.k === 'rite' && isBlock(c))
                        {
                            const r = scalar(c.v, 'rite');

                            if (r)
                                named.add(r);
                        }
                    }

                    for (const r of named)
                        (this.moves.get(r) ?? this.moves.set(r, []).get(r)!).push([at, f.k]);
                }
            }
        }

        for (const list of this.moves.values())
            list.sort((a, b) => a[0] - b[0]);
    }

    /** The faith of the rite at the date (a number as dayOf makes) — undefined for an unknown rite. */
    faithOf(rite: string, date: number): string | undefined
    {
        let out: string | undefined;

        for (const [at, faith] of this.moves.get(rite) ?? [])
        {
            if (at > date)
                break;

            out = faith;
        }

        return out ?? scalar(bodyOf(this.idx, this.idx.get('religion/rite_types', rite)), 'faith');
    }
}

const riteHistories = new WeakMap<GameIndex, RiteHistory>();

/** The index's RiteHistory (read once per index: a mod's change to history/faiths shows after a re-index). */
export function riteHistory(idx: GameIndex): RiteHistory
{
    let h = riteHistories.get(idx);

    if (!h)
        riteHistories.set(idx, h = new RiteHistory(idx));

    return h;
}

/**
 * A history statement's faith at the date: `religion = x` / `faith = x` as written, `rite = x` (1.20) its faith then;
 * undefined for any other statement.
 */
export function historyFaith(idx: GameIndex, n: PNode, date: number): string | undefined
{
    if (typeof n.v !== 'string')
        return undefined;

    if (n.k === 'religion' || n.k === 'faith')
        return n.v;

    return n.k === 'rite' ? riteHistory(idx).faithOf(n.v, date) : undefined;
}
