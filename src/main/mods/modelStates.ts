/**
 * The animation states and animations a version added to the game's portrait models, for a mod's copies of those models
 * (docs/mods.md, "Migrating a mod to a newer game version", the `modelStates` rule; docs/portraits.md, the `.asset` format).
 *
 * A portrait animation (`gfx/portraits/portrait_animations`) plays states by name: `animation = { head = "divine_gesture_1"
 * torso = "divine_gesture_1" }`. The states are entries of the models' entities, `state = { name = "divine_gesture_1"
 * animation = "head_divine_gesture_1" next_state = "divine_gesture_1" }`, and the animation they play is an entry of a mesh or
 * of an animation set the mesh imports, `animation = { id = "head_divine_gesture_1" type = "male_head_divine_gesture_1.anim" }`
 * (male_head.asset's `common_head`, which female_head.asset's mesh imports). A mod that ships an older copy of such a file
 * hides what the version added to it: the engine logs "Unknown animation state 'x' scripted for portrait animation 'y'" for
 * every portrait type, and the pose does not play.
 *
 * What a copy gets, in its block of the same key and name (the mod's own entries are never touched, a name or id the copy has
 * stays its own):
 * - the game's states the copy's entity lacks that a portrait animation names (the game's files, all of them: the libraries
 *   rule may carry any of their entries; the mod's; the patch mod's), and the states an added state goes on to (`next_state`);
 * - the game's animations the copy's mesh or set lacks that a state of the models plays (the game's model files the mod does
 *   not copy, the copies themselves, the states added), when the clip file (`type`, next to the model file) exists;
 * - no state whose animation no model has after that (it would play nothing).
 * Nothing else: a state only the game's own newer version of a state reaches (1.20's `AI_cynical_asia_1`, the next state of its
 * `AI_cynical_asia`, which the copy keeps as the mod wrote it) is not added.
 *
 * The same rule's second kind of file, the modifier pack files of the portrait animations (`packWork`, below): a copy gets the game's
 * packs a portrait animation names and no loaded pack file defines, at its end. Its third, the props (`propsWork`, below): the portrait
 * modifiers the animations and packs name, the gene templates and accessories those need, into the copies of the game's files.
 */
import { parse, type PNode } from '../indexer/parser.ts';

/** An entry of a model block: an animation (`id`, its clip) or a state (`name`, the animation it plays, the state it goes on to). */
export interface ModelEntry
{
    id: string;
    /** the entry as the file writes it */
    text: string;
    /** a state: the animation it plays */
    plays?: string;
    /** a state: the state it goes on to */
    next?: string;
    /** an animation: its clip file, as written (next to the model file) */
    clip?: string;
    /** an entry of several lines: the indentation of the line it starts on in its file (its other lines move with it) */
    indent?: string;
}

/** A block of a model file (`pdxmesh`, `skeletal_animation_set`, `entity`), by key and name. */
interface ModelBlock
{
    node: PNode;
    animations: ModelEntry[];
    states: ModelEntry[];
}

/** The blocks of a model file with their animations and states, keyed `key|name` (the first block of a key and name). */
export type ModelFile = Map<string, ModelBlock>;

const unquote = (v: string): string => v.replace(/^"|"$/g, '');

/** A child's scalar value. */
function scalar(n: PNode, key: string): string | undefined
{
    const c = Array.isArray(n.v) ? n.v.find((x) => x.k === key && typeof x.v === 'string') : undefined;
    return c ? unquote(c.v as string) : undefined;
}

/** A model file's blocks, their `animation` entries (with an `id`) and `state` entries (with a `name`). */
export function readModel(text: string): ModelFile
{
    const out: ModelFile = new Map();

    for (const n of parse(text))
    {
        const name = n.k && Array.isArray(n.v) ? scalar(n, 'name') : undefined;

        if (!name || out.has(`${n.k}|${name}`))
            continue;

        const block: ModelBlock = { node: n, animations: [], states: [] };

        for (const c of n.v as PNode[])
        {
            const id = c.k === 'animation' || c.k === 'state' ? scalar(c, c.k === 'animation' ? 'id' : 'name') : undefined;

            if (!id)
                continue;

            if (c.k === 'animation')
                block.animations.push({ id, text: text.slice(c.s, c.e), clip: scalar(c, 'type') });
            else
                block.states.push({ id, text: text.slice(c.s, c.e), plays: scalar(c, 'animation'), next: scalar(c, 'next_state') });
        }

        out.set(`${n.k}|${name}`, block);
    }

    return out;
}

/** The state names the values of `head` and `torso` give, anywhere in a portrait animation file. */
export function namedStates(text: string, out = new Set<string>()): Set<string>
{
    const walk = (nodes: PNode[]): void =>
    {
        for (const n of nodes)
        {
            if ((n.k === 'head' || n.k === 'torso') && typeof n.v === 'string')
                out.add(unquote(n.v));
            else if (Array.isArray(n.v))
                walk(n.v);
        }
    };

    walk(parse(text));
    return out;
}

/** A copy of a game model file: its path, the game's text, the copy's text as it loads now. */
export interface ModelCopy
{
    rel: string;
    game: string;
    copy: string;
}

/**
 * What a copy gets, per block (`key|name`): the game's entries to add, in the game's order; a pack file's or an accessory file's copy:
 * the game's top-level entries, at its end; a portrait modifier file's or a gene file's copy: the game's entries of a block found by its
 * keys (`animations_props`, `special_genes/accessory_genes/props_left`).
 */
export interface ModelAdds
{
    animations: Map<string, ModelEntry[]>;
    states: Map<string, ModelEntry[]>;
    /** top-level entries (a modifier pack file's packs, an accessory file's accessories) */
    top?: ModelEntry[];
    /** entries of a nested block, by the keys that lead to it joined with `/` */
    nested?: Map<string, ModelEntry[]>;
    /** what the entries are (the notes): the models' states and animations when not given */
    kind?: 'packs' | 'modifiers' | 'templates' | 'accessories';
}

/** What the props entry could not bring in, and the indices it changed: told. */
export interface PropsTold
{
    /** portrait modifiers (`group name`) the copy has no group for */
    noGroup: string[];
    /** portrait modifiers (`group name`) of a group that is applied without being named (not `usage = none`) */
    byItself: string[];
    /** gene templates (`gene template`) of a gene the copy lacks */
    noGene: string[];
    /** gene templates (`gene template`) of a gene a loaded file other than the copy defines as well (which one wins is unclear) */
    ownGene: string[];
    /** accessories no loaded file defines and no copy of a game file can take */
    accessories: string[];
    /** entities (`entity (accessory)`) no loaded model file defines */
    entities: string[];
    /** gene templates written with another index than the game's (`gene template: from → to`) */
    indices: string[];
}

export interface ModelWork
{
    /** per copy with something to add */
    adds: Map<string, ModelAdds>;
    /** states left out (`file: state (animation)`): no model has the animation they play */
    unplayable: string[];
    /** animations left out (`file: id (clip)`): the clip is no file */
    noClip: string[];
    /** the props entry: what it leaves out, and why */
    told?: PropsTold;
}

/** The folder of a model file's path, with a trailing slash (`gfx/models/portraits/male_head/`). */
const folderOf = (rel: string): string => rel.slice(0, rel.lastIndexOf('/') + 1);

/**
 * What the copies get (see the file's comment).
 * @param copies the mod's copies of game model files (each with the game's text of its path)
 * @param others the texts of the game's model files the mod does not copy (their states play animations the copies may hold)
 * @param named the states the portrait animations name
 * @param clipExists whether a clip file exists in the loaded world (its path from the root: the model file's folder and `type`)
 */
export function modelWork(copies: ModelCopy[], others: string[], named: Set<string>, clipExists: (rel: string) => boolean): ModelWork
{
    const read = copies.map((c) => ({ rel: c.rel, game: readModel(c.game), copy: readModel(c.copy) }));
    const otherModels = others.map(readModel);
    const has = (b: ModelBlock | undefined, kind: 'animations' | 'states', id: string): boolean => !!b?.[kind].some((e) => e.id === id);

    // (the states a copy lacks that something reaches: named by an animation, or the next state of one added; `playable` decides after the animations)
    const statesOf = (r: (typeof read)[number], playable?: (anim: string | undefined) => boolean): Map<string, ModelEntry[]> =>
    {
        const out = new Map<string, ModelEntry[]>();

        for (const [key, g] of r.game)
        {
            const mine = r.copy.get(key);

            if (!mine || !g.states.length)
                continue;

            const lacking = g.states.filter((s) => !has(mine, 'states', s.id) && (!playable || playable(s.plays)));
            const want = new Set(lacking.filter((s) => named.has(s.id)).map((s) => s.id));

            for (let grew = true; grew;)
            {
                grew = false;

                for (const s of lacking)
                    if (want.has(s.id) && s.next && !want.has(s.next) && lacking.some((x) => x.id === s.next))
                    {
                        want.add(s.next);
                        grew = true;
                    }
            }

            const add = lacking.filter((s) => want.has(s.id));

            if (add.length)
                out.set(key, add);
        }

        return out;
    };

    // 1. the states, and what the models' states play then
    const states = new Map(read.map((r) => [r.rel, statesOf(r)]));
    const played = new Set<string>();
    const plays = (list: Iterable<ModelEntry>): void =>
    {
        for (const s of list)
            if (s.plays)
                played.add(s.plays);
    };

    for (const m of otherModels)
        for (const b of m.values())
            plays(b.states);

    for (const r of read)
    {
        for (const b of r.copy.values())
            plays(b.states);

        for (const list of states.get(r.rel)!.values())
            plays(list);
    }

    // 2. the animations they play that a copy's block lacks (the clip must be there)
    const noClip: string[] = [];
    const animations = new Map<string, Map<string, ModelEntry[]>>();

    for (const r of read)
    {
        const out = new Map<string, ModelEntry[]>();

        for (const [key, g] of r.game)
        {
            const mine = r.copy.get(key);
            const add = mine ? g.animations.filter((a) => played.has(a.id) && !has(mine, 'animations', a.id)) : [];
            const ok = add.filter((a) => !!a.clip && clipExists(folderOf(r.rel) + a.clip.replace(/\\/g, '/')));

            noClip.push(...add.filter((a) => !ok.includes(a)).map((a) => `${r.rel}: ${a.id} (${a.clip ?? '?'})`));

            if (ok.length)
                out.set(key, ok);
        }

        animations.set(r.rel, out);
    }

    // 3. no state whose animation no model has: the states again, with only those that play something
    const available = new Set<string>();

    for (const m of [...otherModels, ...read.map((r) => r.copy)])
        for (const b of m.values())
            b.animations.forEach((a) => available.add(a.id));

    for (const per of animations.values())
        for (const list of per.values())
            list.forEach((a) => available.add(a.id));

    const unplayable: string[] = [];
    const adds = new Map<string, ModelAdds>();

    for (const r of read)
    {
        const st = statesOf(r, (anim) => !anim || available.has(anim));

        for (const [key, list] of states.get(r.rel)!)
            for (const s of list.filter((x) => !st.get(key)?.includes(x)))
                unplayable.push(`${r.rel}: ${s.id} (${s.plays ?? '?'})`);

        const an = animations.get(r.rel)!;

        if (st.size || an.size)
            adds.set(r.rel, { animations: an, states: st });
    }

    return { adds, unplayable: [...new Set(unplayable)], noClip: [...new Set(noClip)] };
}

/** The end of the line an offset is on (before its line break). */
function lineEnd(text: string, p: number): number
{
    const i = text.indexOf('\n', p);
    return i < 0 ? text.length : i > 0 && text[i - 1] === '\r' ? i - 1 : i;
}

/** The indentation of the line an offset is on (the blanks the line starts with, when only blanks stand before the offset). */
function indentAt(text: string, p: number): string
{
    const ls = text.lastIndexOf('\n', p - 1) + 1;
    const before = text.slice(ls, p);
    return /^[ \t]*$/.test(before) ? before : /^[ \t]*/.exec(before)![0];
}

/** An entry's text at another indentation: the lines after its first that start with its old indentation start with the new one; line ends `eol`. */
function moveLines(text: string, from: string, to: string, eol: string): string
{
    return text.split(/\r?\n/).map((l, i) => (i && l.trim() && l.startsWith(from) ? to + l.slice(from.length) : l)).join(eol);
}

/** The first block the keys lead to (each key a block inside the one before; every block of a key is looked into). */
function findBlock(nodes: PNode[], keys: string[]): PNode | undefined
{
    for (const n of nodes)
    {
        if (n.k !== keys[0] || !Array.isArray(n.v))
            continue;

        const found = keys.length === 1 ? n : findBlock(n.v, keys.slice(1));

        if (found)
            return found;
    }

    return undefined;
}

/**
 * A copy's text with the entries added (`adds`, from `modelWork`): each block's on lines of their own after its last entry of the
 * same kind (after its last child when it has none), with that line's indentation and the file's line end. An entry whose id the
 * block has by now is left out (a second pass adds nothing).
 */
export function addModelEntries(text: string, adds: ModelAdds | undefined): string
{
    if (!adds)
        return text;

    const model = readModel(text);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const edits: { at: number; to: number; text: string; }[] = [];

    // (a pack file's or an accessory file's copy: the entries it lacks by now after its last entry, a blank line before each, in the
    // file's line ends)
    if (adds.top?.length)
    {
        const top = parse(text);
        const have = new Set(top.map((n) => n.k));
        const add = adds.top.filter((p) => !have.has(p.id));
        const last = top[top.length - 1];
        const at = last ? lineEnd(text, last.e) : text.length;

        if (add.length)
            edits.push({ at, to: at, text: (last ? eol + eol : '') + add.map((p) => p.text.replace(/\r?\n/g, eol)).join(eol + eol) + (last && at < text.length ? '' : eol) });
    }

    // (a block found by its keys: the entries it lacks by now after its last block entry, with that entry's indentation, the lines below
    // an entry's first moved with it; a blank line before each when the block has one before that entry)
    for (const [path, list] of adds.nested ?? [])
    {
        const b = findBlock(parse(text), path.split('/'));

        if (!b)
            continue;

        const kids = b.v as PNode[];
        const have = new Set(kids.map((c) => c.k));
        const add = list.filter((e) => !have.has(e.id));
        const entries = kids.filter((c) => c.k && Array.isArray(c.v));
        const last = entries[entries.length - 1] ?? kids[kids.length - 1];

        if (!add.length)
            continue;

        // (an empty block: the entries before its brace, one level in from the block's line, the brace on a line of its own)
        if (!last)
        {
            const outer = indentAt(text, b.s);
            edits.push({ at: b.e - 1, to: b.e - 1, text: add.map((e) => eol + outer + '\t' + moveLines(e.text, e.indent ?? '', outer + '\t', eol)).join('') + eol + outer });
            continue;
        }

        const le = lineEnd(text, last.e);
        const indent = indentAt(text, last.s) || '\t';
        const prev = kids[kids.indexOf(last) - 1];
        const sep = prev && /\n[ \t]*\r?\n/.test(text.slice(prev.e, last.s)) ? eol + eol : eol;
        const lines = add.map((e) => sep + indent + moveLines(e.text, e.indent ?? '', indent, eol)).join('');

        // (a block that closes on the line of its last entry: the entries after it, and the brace on a line of its own)
        if (b.e - 1 < le)
            edits.push({ at: last.e, to: b.e - 1, text: lines + eol + indentAt(text, b.s) });
        else
            edits.push({ at: le, to: le, text: lines });
    }

    for (const kind of ['animations', 'states'] as const)
    {
        for (const [key, list] of adds[kind])
        {
            const b = model.get(key);

            if (!b)
                continue;

            const add = list.filter((e) => !b[kind].some((x) => x.id === e.id));
            const kids = b.node.v as PNode[];
            const same = kids.filter((c) => c.k === (kind === 'animations' ? 'animation' : 'state'));
            const last = same[same.length - 1] ?? kids[kids.length - 1];

            if (!add.length || !last)
                continue;

            const le = lineEnd(text, last.e);
            const ls = text.lastIndexOf('\n', last.s - 1) + 1;
            const indent = /^[ \t]*/.exec(text.slice(ls))![0] || '\t';
            const lines = add.map((e) => eol + indent + e.text).join('');

            // (a block that closes on the line of its last entry: the entries after it, each on a line of its own, and the brace on the next)
            if (b.node.e - 1 < le)
                edits.push({ at: last.e, to: b.node.e - 1, text: lines + eol });
            else
                edits.push({ at: le, to: le, text: lines });
        }
    }

    let out = text;

    for (const e of edits.sort((a, b) => b.at - a.at))
        out = out.slice(0, e.at) + e.text + out.slice(e.to);

    return out;
}

/** How many entries a copy gets, and their ids (for the notes): the models' states and animations, else the entries of its kind. */
export function addsSummary(adds: ModelAdds): { animations: string[]; states: string[]; entries: string[]; }
{
    const ids = (m: Map<string, ModelEntry[]>): string[] => [...new Set([...m.values()].flat().map((e) => e.id))];
    return { animations: ids(adds.animations), states: ids(adds.states), entries: [...(adds.top ?? []).map((p) => p.id), ...ids(adds.nested ?? new Map())] };
}

/**
 * The modifier packs (`gfx/portraits/portrait_animations/*.modifierpack`): a portrait animation adds the portrait modifiers of a pack
 * by its name, `portrait_modifier_pack = crozier` (the animations file's own documentation: "Add all of modifiers from the pack with
 * name <key>"); a pack is a top-level block of a pack file, `crozier = { portrait_modifier = { trigger = { … } animations_props = x } }`.
 * A mod's older copy of the game's pack file hides the packs the version added to it, and the libraries rule leaves out the game's
 * portrait animations that name one (libraryChecks.ts `portraitAnimationCheck`): AGOT's 1.20 religious poses.
 */

/** The pack names `portrait_modifier_pack = x` gives, anywhere in a portrait animation file (its text, or entries of it). */
export function namedPacks(text: string | PNode[], out = new Set<string>()): Set<string>
{
    const walk = (nodes: PNode[]): void =>
    {
        for (const n of nodes)
        {
            if (n.k === 'portrait_modifier_pack' && typeof n.v === 'string')
                out.add(unquote(n.v));
            else if (Array.isArray(n.v))
                walk(n.v);
        }
    };

    walk(typeof text === 'string' ? parse(text) : text);
    return out;
}

/** A pack file's packs: its top-level blocks by key (the first of a key), as the file writes them. */
function readPacks(text: string): Map<string, ModelEntry>
{
    const out = new Map<string, ModelEntry>();

    for (const n of parse(text))
        if (n.k && Array.isArray(n.v) && !out.has(n.k))
            out.set(n.k, { id: n.k, text: text.slice(n.s, n.e) });

    return out;
}

/**
 * What the copies of the game's pack files get: the packs of the game's file of the copy's path that a portrait animation names
 * (`named`: the game's animation files, all of them, the libraries rule may carry any; the mod's; the patch mod's) and that no
 * loaded pack file defines (the copy, `others`: the mod's and the patch mod's other pack files, the game's the mod does not copy),
 * in the game's order. The copy's own packs, of the game's names too, stay its own.
 */
export function packWork(copies: ModelCopy[], others: string[], named: Set<string>): Map<string, ModelEntry[]>
{
    const defined = new Set<string>();

    for (const t of [...others, ...copies.map((c) => c.copy)])
        readPacks(t).forEach((_, k) => defined.add(k));

    const out = new Map<string, ModelEntry[]>();

    for (const c of copies)
    {
        const add = [...readPacks(c.game).values()].filter((p) => named.has(p.id) && !defined.has(p.id));

        add.forEach((p) => defined.add(p.id));

        if (add.length)
            out.set(c.rel, add);
    }

    return out;
}

/**
 * The props, the same rule's third kind (`propsWork`, below): the portrait modifiers the portrait animations and the packs name
 * (`animations_props = pam_crozier_catholic_basic`: the key a modifier group of `gfx/portraits/portrait_modifiers`, the value its
 * modifier, `animations_props = { usage = none pam_crozier_catholic_basic = { dna_modifiers = { accessory = { gene = props_left
 * template = pam_crozier_catholic_basic_01 } } } }`), the gene templates those name (`common/genes`: `special_genes = {
 * accessory_genes = { props_left = { pam_crozier_catholic_basic_01 = { index = 104 male = { 1 = pam_crozier_catholic_basic_01_portrait
 * } } } } }`), the accessories the templates name (`gfx/portraits/accessories`: `pam_crozier_catholic_basic_01_portrait = { entity = {
 * entity = "pam_crozier_catholic_basic_01_portrait_entity" } }`) and the entities those name (any `.asset` file of `gfx/models`). A
 * mod's older copies of the game's modifier and gene files hide what the version added to them: the pose plays without its prop.
 */

/**
 * The portrait modifiers `portrait_modifier` blocks name, as `group|name` (each child but the `trigger`: `animations_props =
 * pam_whip_01`), anywhere in a portrait animation or pack file (its text, or entries of it).
 */
export function namedModifiers(text: string | PNode[], out = new Set<string>()): Set<string>
{
    const walk = (nodes: PNode[]): void =>
    {
        for (const n of nodes)
        {
            if (n.k === 'portrait_modifier' && Array.isArray(n.v))
            {
                for (const c of n.v)
                    if (c.k && c.k !== 'trigger' && typeof c.v === 'string')
                        out.add(`${c.k}|${unquote(c.v)}`);
            }
            else if (Array.isArray(n.v))
                walk(n.v);
        }
    };

    walk(typeof text === 'string' ? parse(text) : text);
    return out;
}

/** What the props entry reads: the names, and per folder the mod's copies of the game's files (as they load now) and the other loaded files. */
export interface PropsInput
{
    /** the portrait modifiers the portrait animations and packs that load name (`group|name`, `namedModifiers`) */
    named: Set<string>;
    modifiers: { copies: ModelCopy[]; others: string[]; };
    /** the gene files; the others with their path (a gene a file of the mod's own defines too is told by it) */
    genes: { copies: ModelCopy[]; others: { rel: string; text: string; }[]; };
    accessories: { copies: ModelCopy[]; others: string[]; };
    /** whether a loaded model file defines an entity (asked of the accessories that load with what comes in) */
    entity: (name: string) => boolean;
}

/** A block entry of a file: its text, and the indentation it starts with. */
const entryOf = (text: string, n: PNode, id = n.k!): ModelEntry => ({ id, text: text.slice(n.s, n.e), indent: indentAt(text, n.s) });

/** A gene template's `index = n` (its own child). */
const indexNode = (t: PNode): PNode | undefined => (t.v as PNode[]).find((c) => c.k === 'index' && typeof c.v === 'string' && /^\d+$/.test(c.v));

/**
 * The genes of a gene file (`special_genes = { accessory_genes = { props_left = { … } } }`, `morph_genes = { … }`): per gene the keys
 * that lead to it, its blocks (the templates, the first of a name) and the indices of all of them (a mod's gene may have a name twice).
 */
function genesOf(text: string): Map<string, { path: string; templates: Map<string, PNode>; indices: Set<number>; }>
{
    const out = new Map<string, { path: string; templates: Map<string, PNode>; indices: Set<number>; }>();
    const container = (n: PNode, path: string): void =>
    {
        for (const g of n.v as PNode[])
        {
            if (!g.k || !Array.isArray(g.v) || out.has(g.k))
                continue;

            const blocks = g.v.filter((t) => t.k && Array.isArray(t.v));
            const templates = new Map<string, PNode>();
            blocks.forEach((t) => templates.has(t.k!) || templates.set(t.k!, t));
            out.set(g.k, { path: `${path}/${g.k}`, templates, indices: new Set(blocks.map(indexNode).filter((x) => !!x).map((x) => Number(x!.v))) });
        }
    };

    for (const top of parse(text))
    {
        if (!top.k || !Array.isArray(top.v))
            continue;

        if (top.k === 'special_genes')
        {
            for (const c of top.v)
                if (c.k && /_genes$/.test(c.k) && Array.isArray(c.v))
                    container(c, `special_genes/${c.k}`);
        }
        else if (/_genes$/.test(top.k))
            container(top, top.k);
    }

    return out;
}

/**
 * What the props entry brings in (see above), each from the game's file of a copy's path, into the copy as it loads now, the mod's own
 * entries untouched (a name the block has is the mod's):
 * 1. the portrait modifiers named (`input.named`) that no loaded modifier file defines, into the copy's group of the same key, when
 *    that group is applied only where something names one of its modifiers (`usage = none`: a group the game applies by itself would
 *    give the mod's characters the game's looks);
 * 2. the gene templates those name (`accessory` and `morph` blocks: `gene`, `template`) that the loaded gene lacks, into the copy's
 *    gene, when no other loaded file defines that gene as well; the game's `index` when no template of the gene has it, else the
 *    smallest one none has (the engine refuses a second template of an index: "duplicate gene template index"), told;
 * 3. the accessories those templates (`1 = name`, `1 = { a b }`) and the modifiers (`accessory = name`) name that no loaded accessory
 *    file defines, at the copy's end;
 * 4. the entities the accessories name (`entity = { entity = "x" }`; `game_entity_override = weapon` names no entity) that no loaded
 *    model file defines: told.
 */
export function propsWork(input: PropsInput): ModelWork
{
    const told: PropsTold = { noGroup: [], byItself: [], noGene: [], ownGene: [], accessories: [], entities: [], indices: [] };
    const adds = new Map<string, ModelAdds>();
    const put = (rel: string, kind: NonNullable<ModelAdds['kind']>, path: string | undefined, e: ModelEntry): void =>
    {
        const a = adds.get(rel) ?? adds.set(rel, { animations: new Map(), states: new Map(), kind }).get(rel)!;

        if (path === undefined)
            (a.top ??= []).push(e);
        else
        {
            const m = (a.nested ??= new Map());
            (m.get(path) ?? m.set(path, []).get(path)!).push(e);
        }
    };

    // 1. the portrait modifiers
    const defined = new Set<string>();

    for (const t of [...input.modifiers.others, ...input.modifiers.copies.map((c) => c.copy)])
        for (const g of parse(t))
            for (const m of g.k && Array.isArray(g.v) ? g.v : [])
                if (m.k && Array.isArray(m.v))
                    defined.add(`${g.k}|${m.k}`);

    const brought: ModelEntry[] = [];

    for (const c of input.modifiers.copies)
    {
        const mine = parse(c.copy);

        for (const g of parse(c.game))
        {
            const wanted = g.k && Array.isArray(g.v) ? g.v.filter((m) => m.k && Array.isArray(m.v) && input.named.has(`${g.k}|${m.k}`) && !defined.has(`${g.k}|${m.k}`)) : [];
            const group = wanted.length ? mine.find((n) => n.k === g.k && Array.isArray(n.v)) : undefined;
            const onlyNamed = !!group && (group.v as PNode[]).some((x) => x.k === 'usage' && x.v === 'none');

            for (const m of wanted)
            {
                defined.add(`${g.k}|${m.k}`);

                if (!group || !onlyNamed)
                    (group ? told.byItself : told.noGroup).push(`${g.k} ${m.k}`);
                else
                {
                    const e = entryOf(c.game, m);
                    put(c.rel, 'modifiers', g.k!, e);
                    brought.push(e);
                }
            }
        }
    }

    // 2. the gene templates they name, and the accessories they name directly
    const wantTemplates = new Set<string>();
    const wantAccessories = new Set<string>();
    const dna = (nodes: PNode[]): void =>
    {
        for (const n of nodes)
        {
            if ((n.k === 'accessory' || n.k === 'morph') && Array.isArray(n.v))
            {
                const v = (key: string): string | undefined => scalar(n, key);
                const gene = v('gene');
                const template = v('template');

                if (gene && template)
                    wantTemplates.add(`${gene}|${template}`);

                if (n.k === 'accessory' && v('accessory'))
                    wantAccessories.add(v('accessory')!);
            }
            else if (Array.isArray(n.v))
                dna(n.v);
        }
    };

    brought.forEach((e) => dna(parse(e.text)));

    // (the gene files are read only when a template is asked for)
    const geneCopies = wantTemplates.size ? input.genes.copies.map((c) => ({ c, game: genesOf(c.game), copy: genesOf(c.copy) })) : [];
    const geneOthers = wantTemplates.size ? input.genes.others.map((o) => genesOf(o.text)) : [];
    const pending = new Map<string, { rel: string; path: string; gene: string; taken: Set<number>; list: { tpl: string; e: ModelEntry; at: number; index?: number; }[]; }>();

    for (const id of wantTemplates)
    {
        const [gene, tpl] = id.split('|');

        if ([...geneCopies.map((x) => x.copy), ...geneOthers].some((m) => m.get(gene)?.templates.has(tpl)))
            continue;

        const src = geneCopies.find((x) => x.game.get(gene)?.templates.has(tpl));

        // (a template the game's copied files do not have: not the version's to bring)
        if (!src)
            continue;

        const mine = src.copy.get(gene);

        if (!mine)
        {
            told.noGene.push(`${gene} ${tpl}`);
            continue;
        }

        if (geneOthers.some((m) => m.has(gene)) || geneCopies.some((x) => x !== src && x.copy.has(gene)))
        {
            told.ownGene.push(`${gene} ${tpl}`);
            continue;
        }

        const t = src.game.get(gene)!.templates.get(tpl)!;
        const ix = indexNode(t);
        const key = `${src.c.rel}|${gene}`;
        const p = pending.get(key) ?? pending.set(key, { rel: src.c.rel, path: mine.path, gene, taken: new Set(mine.indices), list: [] }).get(key)!;
        p.list.push({ tpl, e: entryOf(src.c.game, t, tpl), at: t.s, ...(ix ? { index: Number(ix.v) } : {}) });
    }

    // (the indices: first the templates whose game index no template of the gene has keep it, then the others get the smallest free one;
    // written in the game's order)
    const templates: ModelEntry[] = [];

    for (const p of pending.values())
    {
        const keeps = new Set<string>();
        p.list.sort((a, b) => a.at - b.at);

        for (const x of p.list)
            if (x.index !== undefined && !p.taken.has(x.index))
            {
                p.taken.add(x.index);
                keeps.add(x.tpl);
            }

        for (const x of p.list)
        {
            if (x.index !== undefined && !keeps.has(x.tpl))
            {
                let k = 0;

                while (p.taken.has(k))
                    k++;

                p.taken.add(k);
                const ix = indexNode(parse(x.e.text)[0])!;
                x.e.text = x.e.text.slice(0, ix.s) + x.e.text.slice(ix.s, ix.e).replace(/\d+$/, String(k)) + x.e.text.slice(ix.e);
                told.indices.push(`${p.gene} ${x.tpl}: ${x.index} → ${k}`);
            }

            put(p.rel, 'templates', p.path, x.e);
            templates.push(x.e);
        }
    }

    // 3. the accessories: the templates' type blocks (`male = { 1 = name 2 = { a b } }`), the modifiers' own
    const accessoryNames = (nodes: PNode[]): void =>
    {
        for (const n of nodes)
        {
            if (n.k && /^\d+$/.test(n.k))
                for (const a of typeof n.v === 'string' ? [n.v] : n.v.filter((x) => x.k === null && typeof x.v === 'string').map((x) => x.v as string))
                    wantAccessories.add(unquote(a));
            else if (Array.isArray(n.v))
                accessoryNames(n.v);
        }
    };

    templates.forEach((e) => accessoryNames(parse(e.text)));
    wantAccessories.delete('empty');

    // (the accessory files are read only when an accessory is asked for; the game's texts of the copies only when one is missing)
    const accessories = new Map<string, string>();
    let gameTops: { rel: string; game: string; tops: Map<string, PNode>; }[] | undefined;

    for (const t of wantAccessories.size ? [...input.accessories.others, ...input.accessories.copies.map((c) => c.copy)] : [])
        for (const n of parse(t))
            if (n.k && Array.isArray(n.v))
                accessories.set(n.k, t.slice(n.s, n.e));

    for (const a of wantAccessories)
    {
        if (accessories.has(a))
            continue;

        gameTops ??= input.accessories.copies.map((c) => ({ rel: c.rel, game: c.game, tops: new Map(parse(c.game).filter((n) => n.k && Array.isArray(n.v)).map((n) => [n.k!, n])) }));
        const src = gameTops.find((x) => x.tops.has(a));

        if (!src)
        {
            told.accessories.push(a);
            continue;
        }

        const e = entryOf(src.game, src.tops.get(a)!);
        put(src.rel, 'accessories', undefined, e);
        accessories.set(a, e.text);
    }

    // 4. the entities those accessories name
    for (const a of wantAccessories)
    {
        const walk = (nodes: PNode[], inEntity: boolean): void =>
        {
            for (const n of nodes)
            {
                if (inEntity && n.k === 'entity' && typeof n.v === 'string' && !input.entity(unquote(n.v)))
                    told.entities.push(`${unquote(n.v)} (${a})`);
                else if (Array.isArray(n.v))
                    walk(n.v, n.k === 'entity');
            }
        };

        walk(parse(accessories.get(a) ?? ''), false);
    }

    told.entities = [...new Set(told.entities)];
    return { adds, unplayable: [], noClip: [], ...(Object.values(told).some((l) => l.length) ? { told } : {}) };
}
