/**
 * What the loaded world has, for the inert rewrite (inert.ts): built from the index, which knows every definition of the game and
 * the mods, the hidden ones too. An entry is missing when the index holds it only in files that are hidden (a mod removed it:
 * `GameIndex.isRemoved`): the game's own error log named only such entries for the index kinds (religions, faiths, rites, cultures,
 * doctrines, traits, laws, pillars, innovations, families, men-at-arms, artifact templates, struggles, game rule options, titles,
 * events: 100% of the 2,200 distinct sites of an AGOT run). A name that no entity of its type has at all is missing only for the
 * kinds the index does not hold or holds incompletely, or whose removed entries are carried over: static modifiers (`rejected_from_marriage_bed_modifier`, which no 1.20 file
 * defines), regions (`map_data/geographical_regions`, not indexed), the parameters of doctrines and tenets, and of the cultural
 * entries (read from the loaded files). A typo in a mod stays what it is.
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { onGameDisk, topKeysOf } from './gameFacts.ts';
import type { GameFiles } from './gamefiles.ts';
import { SAVES_SCOPE, SETS_VARIABLE, type InertKind, type InertWorld } from './inert.ts';

/** The entity types (folders) a kind's names are defined in. */
const TYPES: Partial<Record<InertKind, string[]>> = {
    religion: ['religion/religion_types'],
    faith: ['faith'],
    rite: ['religion/rite_types'],
    culture: ['culture/cultures'],
    doctrine: ['religion/doctrine_types'],
    title: ['landed_titles'],
    trait: ['traits'],
    law: ['laws'],
    pillar: ['culture/pillars'],
    innovation: ['culture/innovations'],
    family: ['religion/religion_family_types'],
    maa: ['men_at_arms_types'],
    artifact: ['artifacts/templates'],
    struggle: ['struggle/struggles'],
    rule: ['game_rule_options'],
    event: ['events'],
    modifier: ['modifiers'],
    perk: ['lifestyle_perks'],
    accolade: ['accolade_types'],
    tradition: ['culture/traditions'],
    poi: ['travel/point_of_interest_types'],
    inspiration: ['inspirations'],
    cb: ['casus_belli_types'],
    holy_site: ['religion/holy_site_types'],
    scripted_trigger: ['scripted_triggers'],
    scripted_effect: ['scripted_effects'],
    script_value: ['script_values']
};

/**
 * The kinds of entries a mod can take out of a file it replaces and the libraries rule (libraries.ts) brings back when a loaded file
 * names them: the folder they are carried from. A name is missing only when the rule declined it (the mod's files have it commented out:
 * the author took it out); one it carries is defined again in the patch mod, and rewriting the callers would undo that.
 */
const CARRIED: Partial<Record<InertKind, string>> = {
    scripted_trigger: 'common/scripted_triggers',
    scripted_effect: 'common/scripted_effects',
    script_value: 'common/script_values'
};

/**
 * The kinds that are missing only when no entity of the type has the name at all: a static modifier a mod removed is carried by the
 * libraries rule when a loaded file names it (common/modifiers is one of its folders), so it is not gone.
 */
const NEVER = new Set<InertKind>(['modifier']);

/** The keys at the top of a folder's files, or the words in the `parameters` blocks of the entries. */
function topKeys(vfs: GameFiles, dir: string): Set<string>
{
    const out = new Set<string>();

    // (a game file's keys kept for the session: gameFacts.ts)
    for (const f of vfs.list(dir, { ext: /\.txt$/i }))
        for (const k of (onGameDisk(f) ? topKeysOf(f.abs!) : undefined) ?? parse(vfs.readText(f) ?? '').map((n) => n.k))
            if (k && !k.startsWith('@'))
                out.add(k);

    return out;
}

/** The words of the `parameters` blocks below a node (`x = yes` entries and bare words). */
function parameterWords(nodes: PNode[], out: Set<string>, depth = 0): void
{
    for (const n of nodes)
    {
        if (n.k === 'parameters' && Array.isArray(n.v))
        {
            for (const w of n.v)
            {
                const word = w.k ?? (typeof w.v === 'string' ? w.v : undefined);

                if (word)
                    out.add(word);
            }
        }
        else if (Array.isArray(n.v) && depth < 6)
            parameterWords(n.v, out, depth + 1);
    }
}

/** Whether a node or one below it is one of the keys. */
function holds(n: PNode, keys: Set<string>): boolean
{
    return (!!n.k && keys.has(n.k)) || (Array.isArray(n.v) && n.v.some((c) => holds(c, keys)));
}

/** The parameters the entries of the folders declare. */
function parametersOf(vfs: GameFiles, dirs: string[]): Set<string>
{
    const out = new Set<string>();

    for (const dir of dirs)
        for (const f of vfs.list(dir, { ext: /\.txt$/i }))
            parameterWords(parse(vfs.readText(f) ?? ''), out);

    return out;
}

/** What a world is built with: words that a library rule is going to give to the mod's entries count as existing. */
export interface WorldOptions
{
    /** a doctrine parameter the libraries rule adds to the mod's doctrine (the game's doctrine carries it, the mod's lacks it) */
    gainable?: (kind: 'doctrine_param', word: string) => boolean;
    /** the libraries rule declined to carry the entry back (the mod's files have it commented out, and no script file of the mod names it): the author took it out */
    declined?: (folder: string, name: string) => boolean;
    /** entries the world has under another name (renameRule.ts): `from`, of the index type `type`, is the world's `to` */
    renamed?: { type: string; from: string; to: string; }[];
}

export interface IndexWorld extends InertWorld
{
    /** set after the world is made: see `WorldOptions.gainable` */
    gainable?: WorldOptions['gainable'];
    /** set after the world is made: see `WorldOptions.declined`; without it no scripted entry is missing */
    declined?: WorldOptions['declined'];
    /**
     * set after the world is made: the content the loaded files lack (definitions of the libraries rule's engine content folders that a
     * mod hides and no loaded file defines, libraries.ts `goneContent`). A modifier type whose key starts with one of them and `_`
     * (`lifestyle_scholar_xp_gain_mult`) is one the engine does not make; without it no modifier type is missing
     */
    gone?: Set<string>;
    /**
     * set after the world is made: whether a flag word of a flag folder (`common/laws`) is one no loaded entry defines and none will (the
     * libraries rule cannot give it to an entry of the mod); without it no flag word is missing
     */
    flagMissing?: (folder: string, word: string) => boolean;
}

/** The folders of the flag kinds (migrations.ts `libraries.flags`): where the entries that carry the words are. */
const FLAG_FOLDERS: Partial<Record<InertKind, string>> = {
    government_flag: 'common/governments',
    law_flag: 'common/laws',
    legitimacy_flag: 'common/legitimacy',
    trait_flag: 'common/traits',
    building_flag: 'common/buildings',
    contract_flag: 'common/subject_contracts/contracts'
};

/** Whether a key starts with one of the names and `_` (a name of 3 letters or more, as `goneContent` keeps them). */
function startsWithGone(key: string, gone: Set<string>): boolean
{
    for (let i = key.indexOf('_', 3); i > 0; i = key.indexOf('_', i + 1))
        if (gone.has(key.slice(0, i)))
            return true;

    return false;
}

/**
 * The world of an index. `lazy` parts (regions, parameters) are read from the files on first use: a run with no such statement
 * never reads them.
 */
export function inertWorld(idx: GameIndex, opts: WorldOptions = {}): IndexWorld
{
    const vfs = idx.vfs;
    let regions: Set<string> | undefined;
    let doctrineParams: Set<string> | undefined;
    let cultureParams: Set<string> | undefined;
    const memo = new Map<string, boolean>();
    const keeps = new Map<string, 'scope' | 'variable' | undefined>();

    const world: IndexWorld = {
        gainable: opts.gainable,
        declined: opts.declined,
        // (only for the kinds the index decides: a scripted entry the libraries rule carries back is there under its own name)
        renamed: opts.renamed?.length ? (kind, name) => (TYPES[kind] && !CARRIED[kind] ? opts.renamed!.find((r) => r.from === name && TYPES[kind]!.includes(r.type))?.to : undefined) : undefined,
        effectKeeps(name)
        {
            if (keeps.has(name))
                return keeps.get(name);

            // (the removed definition: its last one, in a file a mod hid)
            const e = idx.named(name).find((x) => !x.dead && x.type === 'scripted_effects');
            const d = e?.defs[e.defs.length - 1];
            const text = d ? vfs.readText(idx.files[d.file].gf) : undefined;
            const body = d && text ? parse(text.slice(d.start, d.end)) : [];
            const r = body.some((n) => holds(n, SAVES_SCOPE)) ? 'scope' : body.some((n) => holds(n, SETS_VARIABLE)) ? 'variable' : undefined;
            keeps.set(name, r);
            return r;
        },
        missing(kind, name)
        {
            const key = `${kind}:${name}`;
            const hit = memo.get(key);

            if (hit !== undefined)
                return hit;

            const r = ((): boolean =>
            {
                if (kind === 'region')
                    return !(regions ??= topKeys(vfs, 'map_data/geographical_regions')).has(name);

                if (kind === 'doctrine_param')
                    return !(doctrineParams ??= parametersOf(vfs, ['common/religion/doctrine_types', 'common/religion/tenet_types', 'common/religion/holy_site_types', 'common/religion/faith_types'])).has(name) && !world.gainable?.('doctrine_param', name);

                if (kind === 'culture_param')
                    return !(cultureParams ??= parametersOf(vfs, ['common/culture'])).has(name);

                if (kind === 'modifier_type')
                    return !!world.gone && startsWithGone(name, world.gone);

                if (FLAG_FOLDERS[kind])
                    return !!world.flagMissing?.(FLAG_FOLDERS[kind]!, name);

                const types = TYPES[kind]!;
                const es = idx.named(name).filter((e) => !e.dead && types.includes(e.type));

                if (NEVER.has(kind))
                    return es.length === 0;

                // (a scripted entry local to an events file is no entry of the folder)
                if (CARRIED[kind] && es.some((e) => e.defs.some((d) => d.local)))
                    return false;

                if (!(es.length > 0 && !es.some((e) => !idx.isRemoved(e))))
                    return false;

                return CARRIED[kind] ? !!world.declined?.(CARRIED[kind]!, name) : true;
            })();

            // (what the libraries rule declines, and the content it finds gone, is not known before it has looked: no answer is kept until the rule has said)
            if (CARRIED[kind] ? !!world.declined : kind === 'modifier_type' ? !!world.gone : FLAG_FOLDERS[kind] ? !!world.flagMissing : true)
                memo.set(key, r);
            return r;
        }
    };

    return world;
}
