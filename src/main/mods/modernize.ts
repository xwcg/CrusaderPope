/**
 * "Update for 1.20" (docs/game-structure.md, "Layouts that changed"; the views mark what the 1.20 game no longer reads
 * in a mod's entries): rewrites a mod's definitions written the old way into the 1.20 layout. Run through
 * createEntries (`what: 'modernize'`): one undo step, the files handed to the index. Plain Node.
 * - `faith`: a faith's settings (`color`, `icon`, `religious_head` …) into `faith_details`, `holy_site = x` into
 *   `holy_sites = { }`, `doctrine = x` into `doctrines = { }`, tenets (tenet types; the mod's tenet-group doctrines)
 *   into `tenets = { }`; a faith written inside its religion's `faiths = { }` moves to the mod's
 *   religion/faith_types file with `religion = <it>` (the block removed when it empties)
 * - `religion-faiths`: every faith written inside the religion, as `faith`; the religion's own settings into
 *   `religion_details` first (as that fix)
 * - `religion-details`: a religion's `family`, `graphical_faith`, `piety_icon_group` … (RELIGION_DETAIL_KEYS) at its top into
 *   `religion_details = { }`, which 1.20 reads them from
 * - `law-group`: a law group with its laws inside (common/laws): the group into the mod's common/law_groups file, each
 *   law in its place with `law_group_type = <group>` and `index = <n>`
 * - `doctrine-group`: a group listing `doctrine_types = { }`: each listed doctrine of the mod gets `doctrine_group_type`,
 *   the list goes (the game's doctrines name their 1.20 groups already)
 * - `tenet-doctrine`: a tenet written as a doctrine of a tenet group (the mod's): its definition moves to the mod's
 *   religion/tenet_types file (without `doctrine_group_type`)
 * - `doctrine-parameters`: a doctrine's or tenet's values 1.20 reads from `special_parameters` (number_of_spouses,
 *   minimum_fervor …) moved there out of `parameters`; the old hostility numbers (`hostility_same_religion = 1`,
 *   `hostility_override_<doctrine> = 3`) as `hostility_levels` / `hostility_level_override` with the level names
 */
import type { PNode } from '../indexer/parser.ts';
import { formatScript } from '../../shared/scriptFormat.ts';

import { tr } from '../../shared/i18n.ts';
import { applyStatementEdits, statementNote } from './scriptRules.ts';
import { wrapDefinition, wrapped } from './wrapKeys.ts';
export interface ModDef
{
    file: string;
    rel: string;
    text: string;
    bom: boolean;
    node: PNode;
}

export interface ModernizeHost
{
    /** the active mod's definition of an entry (its file, text, node) */
    def(type: string, name: string): Promise<ModDef>;
    /** a file of the mod: its text (without BOM), null when missing */
    read(file: string): { text: string; bom: boolean; } | null;
    write(file: string, text: string, bom: boolean): void;
    /** the absolute path of a file of the mod */
    path(rel: string): string;
    /** the mod's file name tag (`<tag>_faith_types.txt`) */
    tag: string;
    /** what the loaded game has: tenet types (their names) */
    tenets: Set<string>;
    /** the mod's tenets written as doctrines of a tenet group */
    tenetDoctrines: Set<string>;
    /**
     * the version's statement rules (migrations.ts `statements`) run on a text about to be written at `rel`: set for a fix
     * outside the migration, whose file rules would do it later (a moved tenet's `has_doctrine = tenet_x` is `has_tenet`)
     */
    convert?(rel: string, text: string): string;
    /** of `prefix:name` references (`category:x`, `loc:KEY` …), the ones the loaded index has no entry for */
    absent?(refs: string[]): Promise<string[]>;
    /** the files written (handed to the index) */
    files: Set<string>;
    notes: string[];
}

/**
 * a religion's settings that 1.20 reads from `religion_details` (religion_types/_religion_types.info; the game's 49 religions
 * write exactly these there and nothing else): at the religion's top the game says "Unexpected token" and the religion has no
 * family
 */
export const RELIGION_DETAIL_KEYS = [
    'family', 'graphical_faith', 'piety_icon_group', 'theocracy_government_type', 'theocracy_lease_contract_type',
    'tenet_background_icon', 'tenet_heretical_background_icon', 'tenet_neutral_background_icon', 'tenet_unknown_background_icon'
];

/** a faith's settings that 1.20 reads from `faith_details` */
export const FAITH_DETAIL_KEYS = new Set(['religion', 'color', 'icon', 'reformed_icon', 'religious_head', 'head_of_rite', 'graphical_faith', 'theocracy_government_type']);

/** values of `parameters` that 1.20 reads from `special_parameters` (doctrine_types/_doctrine_types.info) */
export const SPECIAL_PARAMETER_KEYS = new Set([
    'number_of_spouses', 'number_of_consorts', 'divine_marriage_opinion', 'minimum_fervor', 'fervor_per_holy_site', 'bonus_fervor_gain',
    'bonus_heresy_protection', 'divergence_protection', 'heresy_threshold', 'hostility_towards_us_mult', 'piety_from_long_peace',
    'increased_dynasty_prestige_birth_mult', 'increased_dynasty_prestige_marriage_mult', 'increased_dynasty_prestige_long_reign_mult'
]);
/** the old hostility numbers (`hostility_same_religion = 1` …) and their 1.20 `hostility_levels` keys */
export const OLD_HOSTILITY_KEYS: Record<string, string> = { hostility_same_religion: 'same_religion', hostility_same_family: 'same_family', hostility_others: 'unrelated' };
const HOSTILITY_LEVELS = ['righteous', 'astray', 'hostile', 'evil'];

/**
 * 1.19 wrote these as `x = yes` in `parameters`; 1.20 has the flag `x` there and `x = yes` in `special_parameters` too
 * (tenet_warmonger, unreformed_faith_doctrine)
 */
const FLAG_AND_SPECIAL_KEYS = new Set(['warmonger', 'unreformed']);
/**
 * 1.19's opinion between faiths: `<a>_opinion_active = yes` and `opinion_of_<b>_opinion_active = 10` in `parameters`; 1.20:
 * the flag `<a>` there, `parameter_opinion_override = { <b> = 10 }` in `special_parameters` (tenet_pacifism, the
 * syncretism tenets and doctrines)
 */
const opinionFlag = (k: string): string | undefined => /^(?!opinion_of_)(.+)_opinion_active$/.exec(k)?.[1];
const opinionOf = (k: string): string | undefined => /^opinion_of_(.+)_opinion_active$/.exec(k)?.[1];
/**
 * 1.19's allowed holdings: `allowed_holding_type_<holding> = yes` in `parameters` (doctrine_theocracy_temporal:
 * church_holding); 1.20: `allowed_holding_types = { <holding> }` in `special_parameters`
 */
const holdingOf = (k: string): string | undefined => /^allowed_holding_type_(.+)$/.exec(k)?.[1];

/** The name a `parameters` entry has: its key, or the word itself when it is written bare (`hostility_override_x`). */
export const parameterName = (c: PNode): string | undefined => c.k ?? (typeof c.v === 'string' ? c.v : undefined);

/**
 * Whether a `parameters` entry is one 1.20 reads elsewhere. A bare name counts too (it is never the flag 1.20 writes there:
 * `warmonger` and `unreformed` are fine, the names that take a value or become `x = yes` elsewhere are not).
 */
export const oldParameter = (c: PNode): boolean =>
{
    const k = parameterName(c);

    if (!k || typeof c.v !== 'string')
        return false;

    if (SPECIAL_PARAMETER_KEYS.has(k) || k in OLD_HOSTILITY_KEYS || k.startsWith('hostility_override_') || k === 'same_hof_hostility_override')
        return true;

    // (a bare name stands for `x = yes`; the opinion with its number has none)
    if (c.k === null)
        return !!opinionFlag(k) || !!holdingOf(k) || !!opinionOf(k);

    return (c.v === 'yes' && (FLAG_AND_SPECIAL_KEYS.has(k) || !!opinionFlag(k) || !!holdingOf(k))) || (!!opinionOf(k) && /^\d+$/.test(c.v));
};

/** Whether the fix can convert an old parameter: a bare name that needs a value (`number_of_spouses`) has none to move. */
export const convertibleParameter = (c: PNode): boolean => c.k !== null || (!!opinionFlag(c.v as string) || !!holdingOf(c.v as string));

const isBlock = (n: PNode | undefined): n is PNode & { v: PNode[]; } => !!n && Array.isArray(n.v);

/**
 * The opinion flags the parameter fix converts in the doctrines or tenets of a parsed file (`pacifist_opinion_active = yes`, or
 * the bare word, in a `parameters` block): old name → the flag it becomes (`pacifist`). What tests the parameter
 * (`has_doctrine_parameter`, `rite_has_parameter`) has to name the flag now; the pairs come from the definitions that are converted.
 */
export function opinionFlagsOf(nodes: PNode[], into: Map<string, string> = new Map()): Map<string, string>
{
    for (const d of nodes)
        for (const params of isBlock(d) ? d.v.filter((c) => c.k === 'parameters' && isBlock(c)) : [])
            for (const c of isBlock(params) ? params.v : [])
            {
                const name = parameterName(c);
                const flag = name ? opinionFlag(name) : undefined;

                if (name && flag && (c.k === null || c.v === 'yes') && typeof c.v === 'string')
                    into.set(name, flag);
            }

    return into;
}

const words = (n: PNode): string[] => (isBlock(n) ? n.v.filter((c) => c.k === null && typeof c.v === 'string').map((c) => c.v as string) : []);
const listText = (key: string, items: string[], head?: string): string => `${key} = {${head ? ' ' + head : ''}\n${items.map((i) => `\t${i}`).join('\n')}\n}`;

/** A statement with its comments (statementNote): the comment lines right above it, the one after it on its line. */
function noted(text: string, c: PNode, kids: PNode[], open: number, as?: string): string
{
    const n = statementNote(text, c, kids, open);
    return [...n.lead, (as ?? slice(text, c)) + (n.trail ? ' ' + n.trail : '')].join('\n');
}

/**
 * The comments of a block that belong to none of its statements: the one after its opening brace on the brace's line
 * (`head`), the comment lines after its last statement (`tail`).
 */
function strays(text: string, n: PNode & { v: PNode[]; }): { head?: string; tail: string[]; }
{
    const nl = text.indexOf('\n', n.vs);
    const first = text.slice(n.vs + 1, nl < 0 || nl > n.e ? n.e : nl).replace(/\r$/, '').trim();
    const head = first.startsWith('#') ? first : undefined;
    const last = n.v[n.v.length - 1];
    const from = last ? text.indexOf('\n', last.e) : nl;
    const close = n.e - 1;
    const tail = from >= 0 && from < close ? text.slice(from, close).split('\n').map((l) => l.replace(/\r$/, '').trim()).filter((l) => l.startsWith('#')) : [];
    return { head, tail };
}

/** text of [s, e) with the file's own line breaks normalised */
const slice = (text: string, n: PNode): string => text.slice(n.s, n.e).replace(/\r\n/g, '\n');

/**
 * A faith's 1.19 `doctrine_selection_pair = { requires_dlc_flag = f doctrine = x fallback_doctrine = y }` whose doctrines are
 * tenets: 1.20's `tenet_selection_pair = { requires_dlc_flag = f tenet = x fallback_tenet = y }` (faith_types/_faith_types.info;
 * the game's faiths write it 8 times, `doctrine_selection_pair` nowhere). The pair's other statements and comments stay as they
 * are, line ends normalised like the rest. Undefined for a pair of plain doctrines: 1.20 has no DLC-conditional doctrine.
 */
export function tenetPairText(text: string, pair: PNode, tenets: Set<string>): string | undefined
{
    if (pair.k !== 'doctrine_selection_pair' || !isBlock(pair))
        return undefined;

    const named = pair.v.filter((c) => (c.k === 'doctrine' || c.k === 'fallback_doctrine') && typeof c.v === 'string');

    if (!named.length || !named.every((c) => tenets.has(c.v as string)))
        return undefined;

    const edits = [{ s: 0, e: pair.kl, text: 'tenet_selection_pair' }, ...named.map((c) => ({ s: c.s - pair.s, e: c.s - pair.s + c.kl, text: c.k === 'doctrine' ? 'tenet' : 'fallback_tenet' }))];
    return applyStatementEdits(text.slice(pair.s, pair.e), edits).replace(/\r\n/g, '\n');
}

/** A faith block in the 1.20 layout, from its old-layout block (`religion`: the one it was written in). */
export function faithText(text: string, node: PNode, religion: string | undefined, tenets: Set<string>): string
{
    const body = isBlock(node) ? node.v : [];
    const details: string[] = [];
    const holy: string[] = [];
    const eminent: string[] = [];
    const doctrines: string[] = [];
    const tenetList: string[] = [];
    const pairs: string[] = [];
    const rest: string[] = [];
    const existingDetails = body.find((c) => c.k === 'faith_details' && isBlock(c));

    if (existingDetails && isBlock(existingDetails))
        details.push(...existingDetails.v.map((c) => slice(text, c)));

    if (religion && !body.some((c) => c.k === 'religion') && !(existingDetails && isBlock(existingDetails) && existingDetails.v.some((c) => c.k === 'religion')))
        details.unshift(`religion = ${religion}`);

    for (const c of body)
    {
        if (c === existingDetails)
            continue;

        if (c.k && FAITH_DETAIL_KEYS.has(c.k))
            details.push(slice(text, c));
        else if (c.k === 'holy_site' && typeof c.v === 'string')
            holy.push(c.v);
        else if (c.k === 'holy_sites')
            holy.push(...words(c));
        else if (c.k === 'eminent_holy_sites')
            eminent.push(...words(c));
        else if (c.k === 'doctrine' && typeof c.v === 'string')
            (tenets.has(c.v) ? tenetList : doctrines).push(c.v);
        else if (c.k === 'doctrines')
        {
            for (const w of words(c))
                (tenets.has(w) ? tenetList : doctrines).push(w);
        }
        else if (c.k === 'tenets')
            tenetList.push(...words(c));
        else if (c.k === 'doctrine_selection_pair' && tenetPairText(text, c, tenets))
            pairs.push(tenetPairText(text, c, tenets)!);
        else
            rest.push(slice(text, c));
    }

    const parts = [
        details.length ? `faith_details = {\n${details.join('\n')}\n}` : '',
        ...rest,
        eminent.length ? listText('eminent_holy_sites', [...new Set(eminent)]) : '',
        holy.length ? listText('holy_sites', [...new Set(holy)].filter((h) => !eminent.includes(h))) : '',
        tenetList.length ? listText('tenets', [...new Set(tenetList)]) : '',
        ...pairs,
        doctrines.length ? listText('doctrines', [...new Set(doctrines)]) : ''
    ].filter(Boolean);
    return formatScript(`${node.k} = {\n${parts.join('\n')}\n}`).trimEnd();
}

/** Replaces the node's text in the file, or (`text` empty) removes it with its line. */
function spliceText(src: string, n: PNode, text: string): string
{
    if (text)
        return src.slice(0, n.s) + text + src.slice(n.e);

    // (the whole line when only whitespace is left on it)
    const ls = src.lastIndexOf('\n', n.s - 1) + 1;
    const le = src.indexOf('\n', n.e);
    const before = src.slice(ls, n.s);
    const after = src.slice(n.e, le < 0 ? src.length : le);

    if (!before.trim() && !after.trim())
        return src.slice(0, ls) + src.slice(le < 0 ? src.length : le + 1);

    return src.slice(0, n.s) + src.slice(n.e);
}

/** Appends a block to a file of the mod (made with a header when missing). */
function append(h: ModernizeHost, rel: string, block: string, header: string): string
{
    const file = h.path(rel);
    const cur = h.read(file);
    const eol = cur && cur.text.includes('\r\n') ? '\r\n' : '\n';
    const body = cur ? cur.text.replace(/\s*$/, '') + eol + eol : `# ${header}${eol}${eol}`;
    h.write(file, body + block.replace(/\n/g, eol) + eol, cur ? cur.bom : true);
    return file;
}

/**
 * A definition read again from its file (offsets of the index are stale once a fix wrote into the file): the
 * top-level block named so.
 */
function fresh(h: ModernizeHost, file: string, name: string): ModDef
{
    const cur = h.read(file);
    const node = cur && parseFn!(cur.text).find((n) => n.k === name && isBlock(n));

    if (!cur || !node)
        throw new Error(tr('{name} was not found in {file}.', { name, file }));

    return { file, rel: file, text: cur.text, bom: cur.bom, node };
}

/**
 * The religion's settings 1.20 reads from `religion_details` (family, graphical_faith …) moved into that block, the way
 * the game's religions write them; the rest of the religion stays as it is, comments with their statements.
 */
async function religionDetails(h: ModernizeHost, name: string): Promise<void>
{
    detailsIn(h, (await h.def('religion/religion_types', name)).file, name);
}

/** The same in the religion's file (read again: the index's offsets are stale once a fix wrote into it). */
function detailsIn(h: ModernizeHost, file: string, name: string): void
{
    const d = fresh(h, file, name);
    const moved = wrapped(d.node, RELIGION_DETAIL_KEYS);

    if (!moved.length)
        return;

    // (the edits write the file's own line ends)
    h.write(d.file, applyStatementEdits(d.text, wrapDefinition(d.text, d.node, RELIGION_DETAIL_KEYS, 'religion_details')), d.bom);
    h.files.add(d.file);
    h.notes.push(tr('{name}: {list} into religion_details', { name, list: moved.map((c) => c.k).join(', ') }));
}

/**
 * Every faith written inside the religion: moved out together (one write of its file). The religion's own settings go into
 * `religion_details` first (a religion with faiths written inside it has them at its top too).
 */
async function religionFaiths(h: ModernizeHost, name: string): Promise<void>
{
    const d0 = await h.def('religion/religion_types', name);
    detailsIn(h, d0.file, name);
    const d = fresh(h, d0.file, name);
    const blocks = isBlock(d.node) ? d.node.v.filter((c) => c.k === 'faiths' && isBlock(c)) : [];
    const faiths = blocks.flatMap((b) => (isBlock(b) ? b.v.filter((f) => f.k && isBlock(f)) : []));

    if (!faiths.length)
        return;

    const texts = faiths.map((f) => faithText(d.text, f, name, h.tenets));
    let text = d.text;

    // (from the end: earlier offsets stay right)
    for (const b of [...blocks].sort((x, y) => y.s - x.s))
        text = spliceText(text, b, '');

    h.write(d.file, text, d.bom);
    h.files.add(d.file);
    h.files.add(append(h, `common/religion/faith_types/${h.tag}_faith_types.txt`, texts.join('\n\n'), tr('faiths of the mod (moved out of their religions for 1.20 by CrusaderPope)')));
    h.notes.push(tr('{join}: moved out of {name} into common/religion/faith_types', { join: faiths.map((f) => f.k).join(', '), name }));
}

/** A faith into the 1.20 layout: in place, or (written inside its religion) moved to the mod's faith_types file. */
async function faith(h: ModernizeHost, name: string): Promise<void>
{
    const d = await h.def('faith', name);
    // (inside a religion: the block holding it is `faiths = { }`, its holder the religion)
    const holder = findHolder(parseOf(d), d.node);

    if (!holder)
    {
        const out = faithText(d.text, d.node, undefined, h.tenets);
        h.write(d.file, spliceText(d.text, d.node, out.replace(/\n/g, d.text.includes('\r\n') ? '\r\n' : '\n')), d.bom);
        h.files.add(d.file);
        h.notes.push(tr('{name}: written the 1.20 way', { name }));
        return;
    }

    const out = faithText(d.text, d.node, holder.religion.k ?? undefined, h.tenets);
    // (out of the religion, the `faiths` block too when it held only this one)
    const only = isBlock(holder.faiths) && holder.faiths.v.filter((c) => c.k).length === 1;
    h.write(d.file, spliceText(d.text, only ? holder.faiths : d.node, ''), d.bom);
    h.files.add(d.file);
    h.files.add(append(h, `common/religion/faith_types/${h.tag}_faith_types.txt`, out, tr('faiths of the mod (moved out of their religions for 1.20 by CrusaderPope)')));
    h.notes.push(tr('{name}: moved out of {k} into common/religion/faith_types', { name, k: holder.religion.k }));
}

/** the parsed file of a definition (its node's siblings and holders) */
const parsed = new WeakMap<ModDef, PNode[]>();
let parseFn: ((text: string) => PNode[]) | undefined;

export function useParser(p: (text: string) => PNode[]): void
{
    parseFn = p;
}

function parseOf(d: ModDef): PNode[]
{
    let p = parsed.get(d);

    if (!p)
        parsed.set(d, p = parseFn!(d.text));

    return p;
}

/** The religion and its `faiths` block a faith node is written in. */
function findHolder(top: PNode[], node: PNode): { religion: PNode; faiths: PNode; } | undefined
{
    for (const r of top)
    {
        if (!isBlock(r) || r.s > node.s || r.e < node.e)
            continue;

        const faiths = r.v.find((c) => c.k === 'faiths' && isBlock(c) && c.s <= node.s && node.e <= c.e);
        return faiths ? { religion: r, faiths } : undefined;
    }

    return undefined;
}

/** A law group with its laws inside: the group to law_groups, the laws in place naming it. */
async function lawGroup(h: ModernizeHost, name: string): Promise<void>
{
    const d = await h.def('law_groups', name);
    const body = isBlock(d.node) ? d.node.v : [];
    const laws = body.filter((c) => c.k && isBlock(c) && c.k !== 'can_change_law_group' && c.k !== 'can_have_group' && c.k !== 'required_government_flag');
    const own = body.filter((c) => !laws.includes(c));
    const groupRel = `common/law_groups/${h.tag}_law_groups.txt`;
    // (written with what 1.20 added to the game's group of that name: outside the migration its file rules do not run)
    const groupText = (h.convert ?? ((_r: string, t: string) => t))(groupRel, formatScript(`${name} = {\n${own.map((c) => slice(d.text, c)).join('\n')}\n}`).trimEnd());
    const lawTexts = laws.map((l, i) =>
    {
        const inner = isBlock(l) ? l.v.filter((c) => c.k !== 'law_group_type' && c.k !== 'index').map((c) => slice(d.text, c)) : [];
        return formatScript(`${l.k} = {\n\tlaw_group_type = ${name}\n\tindex = ${i}\n${inner.join('\n')}\n}`).trimEnd();
    });
    const eol = d.text.includes('\r\n') ? '\r\n' : '\n';
    h.write(d.file, spliceText(d.text, d.node, lawTexts.join('\n\n').replace(/\n/g, eol)), d.bom);
    h.files.add(d.file);
    h.files.add(append(h, groupRel, groupText, tr('law groups of the mod (split from their laws for 1.20 by CrusaderPope)')));
    h.notes.push(tr('{name}: the group in common/law_groups, its {length} laws naming it', { name, length: laws.length }));
}

/** A doctrine group listing its doctrines: the mod's doctrines name it, the list goes. */
async function doctrineGroup(h: ModernizeHost, name: string): Promise<void>
{
    const d = await h.def('religion/doctrine_group_types', name);
    const list = isBlock(d.node) ? d.node.v.find((c) => c.k === 'doctrine_types' && isBlock(c)) : undefined;

    if (!list)
    {
        // (a tenet group whose list an older run took out (it listed tenets only, which are tenets since): 1.20 has no such
        // category, with it "'core_tenets' could not be found in the database" and "has no associated DoctrineTypes")
        const category = isBlock(d.node) ? d.node.v.find((c) => c.k === 'category') : undefined;

        if (typeof category?.v === 'string' && category.v.replace(/^"|"$/g, '') === 'core_tenets')
        {
            const cur = fresh(h, d.file, name);
            h.write(cur.file, spliceText(cur.text, cur.node, ''), cur.bom);
            h.files.add(cur.file);
            h.notes.push(tr('{name}: removed — a group of tenets, which 1.20 does not have (tenets are their own type)', { name }));
        }

        return;
    }

    const skipped: string[] = [];
    const tenets: string[] = [];
    // (where each listed doctrine is written, looked up before any write: the index's offsets are stale after one)
    const own: { doc: string; file: string; index: number; }[] = [];

    for (const [index, doc] of words(list).entries())
    {
        try
        {
            own.push({ doc, file: (await h.def('religion/doctrine_types', doc)).file, index });
        }
        catch
        {
            // (a tenet now (1.19's tenets were doctrines of a group) or the game's doctrine, which names its 1.20
            // group itself)
            (h.tenets.has(doc) ? tenets : skipped).push(doc);
        }
    }

    // (a group whose doctrines all became tenets (1.19's core tenets group, category core_tenets, which 1.20 doesn't
    // have) has nothing left to group: it goes, with the rest of its block)
    if (!own.length && !skipped.length && tenets.length)
    {
        const cur = fresh(h, d.file, name);
        h.write(cur.file, spliceText(cur.text, cur.node, ''), cur.bom);
        h.files.add(cur.file);
        h.notes.push(tr('{name}: removed — its {n} doctrines are tenets now (1.20 has no group of tenets)', { name, n: tenets.length }));
        return;
    }

    for (const { doc, file, index } of own)
    {
        // (its text read again: an earlier doctrine of the same file was written)
        const dd = fresh(h, file, doc);
        const inner = isBlock(dd.node) ? dd.node.v : [];
        const has = inner.find((c) => c.k === 'doctrine_group_type');
        // (1.20 orders a group's doctrines by `index`: their place in the list, unless they have one)
        const line = `doctrine_group_type = ${name}` + (inner.some((c) => c.k === 'index') ? '' : `\n\tindex = ${index}`);
        const next = has ? spliceText(dd.text, has, line) : dd.text.slice(0, dd.node.vs + 1) + `\n\t${line}` + dd.text.slice(dd.node.vs + 1);
        h.write(dd.file, next, dd.bom);
        h.files.add(dd.file);
    }

    // (the group read again: a doctrine of the same file moved it)
    const again = fresh(h, d.file, name);
    // (and `number_of_picks`, which 1.19's tenet group had: no key of 1.20's doctrine groups, _doctrine_group_types.info)
    const gone = isBlock(again.node) ? again.node.v.filter((c) => c.k === 'doctrine_types' || c.k === 'number_of_picks') : [];

    if (gone.length)
    {
        let next = again.text;

        // (from the end: earlier offsets stay right)
        for (const n of [...gone].sort((x, y) => y.s - x.s))
            next = spliceText(next, n, '');

        h.write(again.file, next, again.bom);
        h.files.add(again.file);
    }

    h.notes.push(tr('{name}: its doctrines name it{value}', {
        name,
        value: (skipped.length ? tr(' (the game’s {list} left: they name their own groups)', { list: skipped.join(', ') }) : '') +
            (tenets.length ? tr(' ({list} left: tenets now)', { list: tenets.join(', ') }) : '')
    }));
    await groupCategory(h, again);
}

/**
 * The category a group names, when no loaded `doctrine_category_types` file defines it: 1.20 reads a category from the database
 * (`category = "magic"` of a 1.19 mod was a name only: the game logs "could not be found in the database" and the group has no
 * category in the faith and rite windows). It is defined in the mod's category file (`sort_order` 0, the default), with its name
 * in English unless a loaded text has the key. The game's own categories are main_group, marriage, crimes, clergy, special and
 * not_creatable.
 */
async function groupCategory(h: ModernizeHost, group: ModDef): Promise<void>
{
    const c = isBlock(group.node) ? group.node.v.find((x) => x.k === 'category' && typeof x.v === 'string') : undefined;
    const key = (c?.v as string | undefined)?.replace(/^"|"$/g, '');

    // (core_tenets: a group of tenets goes, with the rest of its block; not a category to define)
    if (!key || !/^[A-Za-z_]\w*$/.test(key) || key === 'core_tenets' || !h.absent || !(await h.absent([`category:${key}`])).length)
        return;

    const rel = `common/religion/doctrine_category_types/${h.tag}_doctrine_category_types.txt`;
    const file = h.path(rel);
    const cur = h.read(file);

    // (an earlier group of this run named it: the index does not know the file yet)
    if (!cur || !parseFn!(cur.text).some((n) => n.k === key))
    {
        h.files.add(append(h, rel, `${key} = {\n\tsort_order = 0\n}`, tr('doctrine categories of the mod (1.20 reads them from the database; added by CrusaderPope)')));
        h.notes.push(tr('{name}: the category {key} defined in {rel} (1.20 reads categories from the database)', { name: group.node.k ?? '', key, rel }));
    }

    if ((await h.absent([`loc:doctrine_category_${key}`])).length)
    {
        const locFile = h.path(`localization/english/${h.tag}_doctrine_categories_l_english.yml`);
        const loc = h.read(locFile);
        const eol = loc?.text.includes('\r\n') ? '\r\n' : '\n';
        const line = ` doctrine_category_${key}: "${key.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')}"`;

        if (!loc?.text.includes(` doctrine_category_${key}:`))
        {
            h.write(locFile, loc ? loc.text.replace(/\s*$/, eol) + line + eol : `l_english:${eol}${line}${eol}`, loc?.bom ?? true);
            h.files.add(locFile);
        }
    }
}

/** A tenet written as the mod's doctrine of a tenet group: its definition into the mod's tenet_types file. */
async function tenetDoctrine(h: ModernizeHost, name: string): Promise<void>
{
    const d = await h.def('religion/doctrine_types', name);
    const kids = isBlock(d.node) ? d.node.v : [];
    // (every statement goes with its comments: the lines above it, the one after it on its line; the block's own: after its
    // brace, after its last statement)
    const inner = kids.filter((c) => c.k !== 'doctrine_group_type').map((c) => noted(d.text, c, kids, d.node.vs));
    const stray = isBlock(d.node) ? strays(d.text, d.node) : { head: undefined, tail: [] as string[] };
    const rel = `common/religion/tenet_types/${h.tag}_tenet_types.txt`;
    // (written with the statement rules run: a doctrine's code is a faith's, a tenet's is a rite's in part)
    const out = (h.convert ?? ((_r: string, t: string) => t))(rel, formatScript(`${name} = {${stray.head ? ' ' + stray.head : ''}\n${[...inner, ...stray.tail].join('\n')}\n}`).trimEnd());
    h.write(d.file, spliceText(d.text, d.node, ''), d.bom);
    h.files.add(d.file);
    h.files.add(append(h, rel, out, tr('tenets of the mod (moved from doctrines for 1.20 by CrusaderPope)')));
    h.notes.push(tr('{name}: now a tenet (common/religion/tenet_types) — faiths holding it as a doctrine: their “Update for 1.20” moves it into their tenets', { name }));
}

/** A doctrine's (or tenet's) old valued parameters into `special_parameters`. */
async function doctrineParameters(h: ModernizeHost, type: string, name: string): Promise<void>
{
    const d0 = await h.def(type, name);
    const d = fresh(h, d0.file, name);
    const body = isBlock(d.node) ? d.node.v : [];
    const params = body.find((c) => c.k === 'parameters' && isBlock(c));
    const found = params && isBlock(params) ? params.v.filter(oldParameter) : [];
    // (a bare name that needs a value has none to move: it stays as written, and the result says so)
    const old = found.filter(convertibleParameter);
    const valueless = found.filter((c) => !convertibleParameter(c));

    if (!old.length)
    {
        if (valueless.length)
            h.notes.push(tr('{name}: {list} have no value (written bare) — left in parameters, 1.20 reads them from special_parameters with a value', { name, list: valueless.map(parameterName).join(', ') }));

        return;
    }

    const text = d.text;
    const level = (v: string): string => HOSTILITY_LEVELS[Number(v)] ?? v;
    // (every statement keeps its comments: the lines right above it and the one after it on its line; one that is converted
    // hands them to the line it becomes. A bare name stands for `x = yes`)
    const kids = isBlock(params!) ? params!.v : [];
    const ln = (c: PNode, as?: string): string => noted(text, c, kids, params!.vs, as);
    const nm = (c: PNode): string => parameterName(c)!;
    const yes = (c: PNode): boolean => c.k === null || c.v === 'yes';
    // (a flag `x = yes` becomes the bare word, where it stood, as the game's 1.20 files write it; `warmonger` and
    // `unreformed` are also `x = yes` in special_parameters, the opinion flags carry no value there)
    const flagOf = (c: PNode): string | undefined => (yes(c) ? (FLAG_AND_SPECIAL_KEYS.has(nm(c)) ? nm(c) : opinionFlag(nm(c))) : undefined);
    const kept = kids.flatMap((c) => (!old.includes(c) ? [ln(c)] : flagOf(c) ? [ln(c, flagOf(c))] : []));
    const special = body.find((c) => c.k === 'special_parameters' && isBlock(c));
    const had = special && isBlock(special) ? special.v : [];
    const hasKey = (k: string): boolean => had.some((c) => c.k === k);
    const sn = (c: PNode, as?: string): string => noted(text, c, had, special!.vs, as);
    const levels = old.filter((c) => nm(c) in OLD_HOSTILITY_KEYS).map((c) => ln(c, `${OLD_HOSTILITY_KEYS[nm(c)]} = ${level(c.v as string)}`));
    const overrides = old.filter((c) => nm(c).startsWith('hostility_override_')).map((c) => ln(c, `${nm(c).slice('hostility_override_'.length)} = ${level(c.v as string)}`));
    const values = old.filter((c) => SPECIAL_PARAMETER_KEYS.has(nm(c)) || (FLAG_AND_SPECIAL_KEYS.has(nm(c)) && !hasKey(nm(c)))).map((c) => (FLAG_AND_SPECIAL_KEYS.has(nm(c)) ? `${c.k} = ${c.v}` : ln(c, `${c.k} = ${c.v}`)));
    const sameHof = old.filter((c) => c.k === 'same_hof_hostility_override' && !hasKey(c.k)).map((c) => ln(c, `${c.k} = ${level(c.v as string)}`));
    // (the opinions: into the doctrine's own `parameter_opinion_override`, if it has one)
    const opinions = old.filter((c) => opinionOf(nm(c))).map((c) => ({ key: opinionOf(nm(c))!, line: (): string => ln(c, `${opinionOf(nm(c))} = ${c.v}`) }));
    const mapNode = had.find((c) => c.k === 'parameter_opinion_override' && isBlock(c));
    const mapHas = new Set(mapNode && isBlock(mapNode) ? mapNode.v.map((c) => c.k) : []);
    const opinionMap = opinions.filter((o) => !mapHas.has(o.key));
    // (the allowed holdings: one list, with the doctrine's own if it has one)
    const holdingNode = had.find((c) => c.k === 'allowed_holding_types' && isBlock(c));
    const holdingHas = new Set(holdingNode ? words(holdingNode) : []);
    const holdingNew = old.filter((c) => holdingOf(nm(c)) && !holdingHas.has(holdingOf(nm(c))!)).map((c) => ln(c, holdingOf(nm(c))!));
    // (a block that is written again carries its own comments: above it, after it, inside it)
    const again = (n: PNode | undefined, make: (items: string[]) => string, items: string[]): string =>
    {
        if (!n || !isBlock(n))
            return make(items);

        const s = strays(text, n);
        const note = statementNote(text, n, had, special!.vs);
        return [...note.lead, make(items).replace(/^(\S+ = \{)/, (m) => m + (s.head ? ' ' + s.head : ''))].join('\n') + (note.trail ? ' ' + note.trail : '');
    };
    const wordLines = (n: PNode & { v: PNode[]; }): string[] => [...n.v.map((c) => noted(text, c, n.v, n.vs)), ...strays(text, n).tail];
    const inner = had.filter((c) => !(opinionMap.length && c === mapNode) && !(holdingNew.length && c === holdingNode)).map((c) => sn(c));
    const added = [
        ...values, ...sameHof,
        holdingNew.length ? again(holdingNode, (i) => listText('allowed_holding_types', i), [...(holdingNode && isBlock(holdingNode) ? wordLines(holdingNode) : []), ...holdingNew]) : '',
        levels.length ? listText('hostility_levels', levels) : '',
        overrides.length ? listText('hostility_level_override', overrides) : '',
        opinionMap.length ? again(mapNode, (i) => listText('parameter_opinion_override', i), [...(mapNode && isBlock(mapNode) ? wordLines(mapNode) : []), ...opinionMap.map((o) => o.line())]) : ''
    ].filter(Boolean);
    // (what no statement owns: a comment after a block's brace, lines after its last statement. The parameters block's, when it
    // is gone, stand at the top of special_parameters)
    const pStray = strays(text, params as PNode & { v: PNode[]; });
    const sStray = special && isBlock(special) ? strays(text, special) : { tail: [] as string[] };
    const pNote = statementNote(text, params!, body, d.node.vs);
    const sNote = special ? statementNote(text, special, body, d.node.vs) : undefined;
    const orphans = kept.length ? [] : [...pNote.lead, ...(pStray.head ? [pStray.head] : []), ...pStray.tail, ...(pNote.trail ? [pNote.trail] : [])];
    const specialItems = [...orphans, ...inner, ...added, ...sStray.tail];
    const rest = body.filter((c) => c !== params && c !== special).map((c) => noted(text, c, body, d.node.vs));
    const around = (n: { lead: string[]; trail?: string; } | undefined, block: string): string => [...(n?.lead ?? []), block + (n?.trail ? ' ' + n.trail : '')].join('\n');
    const parts = [
        ...rest,
        kept.length ? around(pNote, listText('parameters', [...kept, ...pStray.tail], pStray.head)) : '',
        specialItems.length ? around(sNote, listText('special_parameters', specialItems, special && isBlock(special) ? strays(text, special).head : undefined)) : ''
    ].filter(Boolean);
    const dStray = strays(text, d.node as PNode & { v: PNode[]; });
    const out = formatScript(`${name} = {${dStray.head ? ' ' + dStray.head : ''}\n${[...parts, ...dStray.tail].join('\n')}\n}`).trimEnd();
    h.write(d.file, spliceText(d.text, d.node, out.replace(/\n/g, d.text.includes('\r\n') ? '\r\n' : '\n')), d.bom);
    h.files.add(d.file);
    h.notes.push(tr('{name}: {list} into special_parameters', { name, list: old.map(parameterName).join(', ') }));

    if (valueless.length)
        h.notes.push(tr('{name}: {list} have no value (written bare) — left in parameters, 1.20 reads them from special_parameters with a value', { name, list: valueless.map(parameterName).join(', ') }));
}

export async function modernize(h: ModernizeHost, fix: string, name: string): Promise<void>
{
    switch (fix)
    {
        case 'faith':
            return faith(h, name);
        case 'religion-faiths':
            return religionFaiths(h, name);
        case 'religion-details':
            return religionDetails(h, name);
        case 'law-group':
            return lawGroup(h, name);
        case 'doctrine-group':
            return doctrineGroup(h, name);
        case 'tenet-doctrine':
            return tenetDoctrine(h, name);
        case 'doctrine-parameters':
            return doctrineParameters(h, 'religion/doctrine_types', name);
        case 'tenet-parameters':
            return doctrineParameters(h, 'religion/tenet_types', name);
    }

    throw new Error(tr('Unknown update: {fix}', { fix }));
}
