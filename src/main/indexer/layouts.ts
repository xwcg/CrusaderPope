/**
 * Definitions whose layout changed between game versions (docs/game-structure.md, "Layouts that changed"). Both are
 * read: the files' shape decides, not the version number: a mod written for an older version can load over a newer
 * game.
 * - Faiths: up to 1.19 blocks in their religion (`religion_types`: `faiths = { <faith> = { … } }`; colour, icon,
 *   religious_head, `holy_site = x`, `doctrine = x` at the faith's top). From 1.20 top-level in `religion/faith_types`:
 *   `faith_details = { religion color icon religious_head graphical_faith … }`, `holy_sites` / `eminent_holy_sites`
 *   and `doctrines` / `tenets` lists, a `main_rite`.
 * - Religion settings (family, banners …): at the religion's top up to 1.19, in `religion_details` from 1.20.
 *   faithTable() reads faiths and religions of both layouts into one table for the consumers outside the indexer.
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

/** A religion setting written at its top (up to 1.19) or in its `religion_details` (1.20): family, banners, temple models … */
export function religionField(body: PNode[], key: string): PNode | undefined
{
    const d = body.find((c) => c.k === 'religion_details');
    return body.find((c) => c.k === key) ?? (isBlock(d) ? d.v.find((c) => c.k === key) : undefined);
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

/** What the consumers outside the indexer ask of a faith: its religion, its doctrines, its icon and main rite. */
export interface FaithRecord
{
    religion: string;
    /** the religion's, the main rite's (1.20) and the faith's own `doctrine = x` / `doctrines = { }` */
    doctrines: Set<string>;
    /** the same without the main rite (faithHasDoctrine adds the rite of the date) */
    own: Set<string>;
    icon?: string;
    /** 1.20: the faith type's `main_rite`, else the one rite type naming the faith (see faithTable) */
    mainRite?: string;
}

export interface FaithTable
{
    faiths: Map<string, FaithRecord>;
    /** per religion: its `family` (rf_abrahamic …) */
    families: Map<string, string | undefined>;
    /** the titles the faiths name as `religious_head` */
    heads: Set<string>;
    /** the titles the faiths list in `clerical_elector_titles` (1.20.1: a cardinal's seat) */
    electors: Set<string>;
}

/** `doctrine = x` and the words of `doctrines = { }` at the top of a body (religion, faith or rite) */
export function doctrinesOf(body: PNode[]): string[]
{
    return body.flatMap((c) => (c.k === 'doctrine' && typeof c.v === 'string' ? [c.v] : c.k === 'doctrines' ? words(c).map((w) => w.v as string) : []));
}

/** (an index is updated in place: every build and update replaces its `stats`, so a cache entry is good for one of them) */
const faithTables = new WeakMap<GameIndex, { stats: unknown; table: FaithTable; }>();

/**
 * Every faith with its religion, doctrines and icon, in either layout: nested in its religion (up to 1.19) or top-level
 * in religion/faith_types (1.20: `faith_details = { religion … }`, the doctrines of its main rite). Read once per index
 * state (a build or an incremental update reads it anew). A faith both layouts define counts as the nested one, as the
 * indexer wins it.
 *
 * A 1.20 faith type that states no `main_rite` (iconoclast, cathar, … in the game: the type says "Scripted main Rite: x
 * (all start dates)" in a comment, and the rite type points back with `faith = x`) has the one rite type that names it as
 * its main rite; with several or none it has no static main rite (a dated `main_rite` of history/faiths still counts:
 * RiteHistory.mainRiteOf).
 */
export function faithTable(idx: GameIndex): FaithTable
{
    const known = faithTables.get(idx);

    if (known && known.stats === idx.stats)
        return known.table;

    const table: FaithTable = { faiths: new Map(), families: new Map(), heads: new Set(), electors: new Set() };
    faithTables.set(idx, { stats: idx.stats, table });
    const religionDoctrines = new Map<string, string[]>();
    let riteNames: Map<string, string[]> | undefined;
    const soleRite = (faith: string): string | undefined =>
    {
        if (!riteNames)
        {
            riteNames = new Map();

            for (const r of idx.names('religion/rite_types'))
            {
                const f = scalar(bodyOf(idx, idx.get('religion/rite_types', r)), 'faith');

                if (f)
                    (riteNames.get(f) ?? riteNames.set(f, []).get(f)!).push(r);
            }
        }

        const named = riteNames.get(faith);
        return named?.length === 1 ? named[0] : undefined;
    };
    const text = (n: PNode | undefined): string | undefined => (typeof n?.v === 'string' ? n.v.replace(/^"(.*)"$/, '$1') : undefined);
    const head = (n: PNode | undefined): void =>
    {
        const v = text(n);

        if (v)
            table.heads.add(v.replace(/^title:/, ''));
    };
    const electors = (n: PNode | undefined): void => words(n).forEach((w) => table.electors.add((w.v as string).replace(/^title:/, '')));

    for (const religion of idx.names('religion/religion_types'))
    {
        const body = bodyOf(idx, idx.get('religion/religion_types', religion));

        if (!body.length)
            continue;

        table.families.set(religion, text(religionField(body, 'family')));
        const doctrines = doctrinesOf(body);
        religionDoctrines.set(religion, doctrines);
        const nested = body.find((c) => c.k === 'faiths');

        for (const f of isBlock(nested) ? nested.v : [])
        {
            if (!f.k || !isBlock(f))
                continue;

            const find = (k: string): PNode | undefined => f.v.find((c) => c.k === k);
            const own = new Set([...doctrines, ...doctrinesOf(f.v)]);
            const mainRite = text(find('main_rite')) ?? soleRite(f.k);
            const rite = mainRite ? bodyOf(idx, idx.get('religion/rite_types', mainRite)) : [];
            table.faiths.set(f.k, { religion, doctrines: new Set([...own, ...doctrinesOf(rite)]), own, icon: text(find('icon')), mainRite });
            head(find('religious_head'));
            electors(find('clerical_elector_titles'));
        }
    }

    for (const name of idx.names(T_FAITH))
    {
        const body = bodyOf(idx, idx.get(T_FAITH, name));
        const religion = text(faithField(body, 'religion'));

        if (table.faiths.has(name) || !religion)
            continue;

        const mainRite = text(body.find((c) => c.k === 'main_rite')) ?? soleRite(name);
        const rite = mainRite ? bodyOf(idx, idx.get('religion/rite_types', mainRite)) : [];
        const own = new Set([...(religionDoctrines.get(religion) ?? []), ...doctrinesOf(body)]);
        table.faiths.set(name, { religion, doctrines: new Set([...own, ...doctrinesOf(rite)]), own, icon: text(faithField(body, 'icon')), mainRite });
        head(faithField(body, 'religious_head'));
        electors(faithField(body, 'clerical_elector_titles'));
    }

    return table;
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
 * A law group's laws in order: the laws naming it (1.20), by their `index`; else its blocks (up to 1.19; a 1.20 group
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

/** Whether the loaded game has tenets of their own type (1.20): then a mod's older layouts are obsolete. */
export function tenetsOwnType(idx: GameIndex): boolean
{
    return idx.names('religion/tenet_types').some((n) => idx.get('religion/tenet_types', n)?.defs.some((d) => idx.files[d.file]?.source === 0));
}

/** Doctrines of a tenet group (category core_tenets): up to 1.19 tenets were those; a mod may still have them. */
export function tenetGroupDoctrines(idx: GameIndex): string[]
{
    const groups = new Set(idx.names('religion/doctrine_group_types').filter((g) => scalar(bodyOf(idx, idx.get('religion/doctrine_group_types', g)), 'category') === 'core_tenets'));
    const out = new Set<string>();

    for (const g of groups)
    {
        const list = bodyOf(idx, idx.get('religion/doctrine_group_types', g)).find((c) => c.k === 'doctrine_types');
        words(list).forEach((w) => out.add(w.v as string));
    }

    for (const n of idx.names('religion/doctrine_types'))
        if (groups.has(scalar(bodyOf(idx, idx.get('religion/doctrine_types', n)), 'doctrine_group_type') ?? ''))
            out.add(n);

    return [...out];
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
 * rites = { r = { … } } rite = { rite = r … } } }`: a rite named there is the faith's from that date until another
 * faith's history takes it ("rites can only be removed from a faith by adding them to another one",
 * _faith_history.info); before any history, the rite type's own `faith = x`.
 */
export class RiteHistory
{
    private idx: GameIndex;
    /** per rite: [date, faith] ascending */
    private moves = new Map<string, [number, string][]>();
    /** per faith: its `main_rite = r` statements, [date, rite] ascending */
    private mains = new Map<string, [number, string][]>();

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
                        {
                            named.add(c.v);
                            (this.mains.get(f.k) ?? this.mains.set(f.k, []).get(f.k)!).push([at, c.v]);
                        }
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

        for (const list of [...this.moves.values(), ...this.mains.values()])
            list.sort((a, b) => a[0] - b[0]);
    }

    /** A faith's main rite at the date (as dayOf makes it): the last `main_rite` its history states, else the faith type's own. */
    mainRiteOf(faith: string, date: number): string | undefined
    {
        let out: string | undefined;

        for (const [at, rite] of this.mains.get(faith) ?? [])
        {
            if (at > date)
                break;

            out = rite;
        }

        return out ?? faithTable(this.idx).faiths.get(faith)?.mainRite;
    }

    /** The faith of the rite at the date (a number as dayOf makes); undefined for an unknown rite. */
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

const riteHistories = new WeakMap<GameIndex, { stats: unknown; history: RiteHistory; }>();

/** The index's RiteHistory (read once per index state: a build or an incremental update replaces `idx.stats`, and with it this). */
export function riteHistory(idx: GameIndex): RiteHistory
{
    let h = riteHistories.get(idx);

    if (!h || h.stats !== idx.stats)
        riteHistories.set(idx, h = { stats: idx.stats, history: new RiteHistory(idx) });

    return h.history;
}

/**
 * Whether a faith has a doctrine at a date (as dayOf makes it): its religion's and its own, and those of its main rite
 * then: a faith whose main rite changes (confucian_faith: jingxue, from 1066.9.15 daoxue) has the rite's doctrines of the
 * date, which the table's undated doctrines cannot say. Without a date: the table's.
 */
export function faithHasDoctrine(idx: GameIndex, faith: string, doctrine: string, date?: number): boolean
{
    const f = faithTable(idx).faiths.get(faith);

    if (!f)
        return false;

    const rite = date === undefined ? undefined : riteHistory(idx).mainRiteOf(faith, date);

    if (date === undefined || !rite || rite === f.mainRite)
        return f.doctrines.has(doctrine);

    return f.own.has(doctrine) || doctrinesOf(bodyOf(idx, idx.get('religion/rite_types', rite))).includes(doctrine);
}

/**
 * A history statement's faith at the date: `religion = x` / `faith = x` as written, `rite = x` (1.20) its faith then;
 * undefined for any other statement.
 */
export function historyFaith(idx: GameIndex, n: PNode, date: number): string | undefined
{
    if (typeof n.v !== 'string')
        return undefined;

    // (1.20 writes rites under `religion =` too, the Sunni schools: a rite's faith then)
    if (n.k === 'religion' || n.k === 'faith')
        return riteHistory(idx).faithOf(n.v, date) ?? n.v;

    return n.k === 'rite' ? riteHistory(idx).faithOf(n.v, date) : undefined;
}
