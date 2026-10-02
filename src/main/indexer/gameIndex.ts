/**
 * Builds and queries the cross-reference index of the CK3 game files.
 *
 * Build: every script file is parsed once. Definitions are registered (pass 1) and every scalar/key token
 * inside a definition is stored as a *candidate* reference. After all files (and localization) are known,
 * candidates are resolved against the symbol table (pass 2). See docs/indexer.md.
 */
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GameFiles, type GameFile, type HiddenFile } from '../mods/gamefiles.ts';
import { parse, type PNode } from './parser.ts';
import { parseLocalization, extractLocRefs, locTextAt, type LocEntry } from './localization.ts';
import { bloomAdd, bloomHas, makeBloom, nameHash, newBloom } from './bloom.ts';
import { humanizeBrackets, scanBrackets } from '../describe/text.ts';
import { IMAGE_EXT, MODEL_EXT } from '../images/files.ts';
import { parseDds, formatLabel } from '../images/dds.ts';
import { constantsUsed, constantValues, eolOf, namesPattern, overrideText, pathTo, stmtCheck, textHash, titleText, topLevelAt, TITLE_KEY, type OverrideSource } from './override.ts';
import { sameScript } from '../../shared/scriptFormat.ts';
import {
    CALLABLE_TYPES,
    CONTEXT_ONLY_TYPES,
    CONTEXT_RULES,
    CORE_TYPES,
    NUMERIC_TYPES,
    PREFIX_TYPES,
    STOP_WORDS,
    T_CHARACTER,
    T_EVENT,
    T_FLAG,
    T_IMAGE,
    T_MODEL,
    T_LOC,
    T_ON_ACTION,
    T_SCRIPTED_EFFECT,
    T_SCRIPTED_TRIGGER,
    T_TITLE,
    T_VARIABLE,
    VARIABLE_PREFIXES,
    commonTypeFor,
    descriptionCandidates,
    displayNameCandidates,
    refPrefixOf,
    extractDefs,
    isFlagKey,
    isVariableKey,
    typeGroup,
    typeLabel,
    type DefEmit
} from './schema.ts';
import { doctrinesNameTheirGroup } from './layouts.ts';
import type { EventBackgroundInfo, PortraitOptions, DefOrigin, DefSiteView, BracketLink, EntityDetail, EntityKey, EntityListItem, EventPreview, GalleryFile, GalleryFolder, GraphData, IndexStats, LineSource, LinkSpan, ModTouch, RefGroup, RefItem, SearchResult, TypeSummary } from '../../shared/api.ts';

export interface FileInfo
{
    rel: string;
    /** disk path, or `archive.zip › entry` for a file inside a packed mod (display only — read through vfs) */
    abs: string;
    area: 'common' | 'events' | 'history/characters' | 'localization';
    type?: string;
    /** 0 = the game, 1.. = mods in load order (GameFiles.sources) */
    source: number;
    gf: GameFile;
    /**
     * A later mod hid this file (its file of the same path, or its replace_path): the game doesn't load it. Parsed for
     * its definitions only, so the index knows what the mod replaced or removed (docs/mods.md).
     */
    hidden?: { by: number; how: HiddenFile['how']; };
    /** size and modification time when it was read (cache fingerprints; unchanged files — ctime too — are skipped by an update) */
    stamp?: { size: number; mtime: number; ctime?: number; };
    /** removed by an incremental update: the slot stays (file indices are stable), nothing refers to it any more */
    gone?: true;
}

export interface Def
{
    file: number;
    line: number;
    start: number;
    end: number;
    local?: boolean;
    doc?: string;
    meta?: Record<string, string>;
}

export interface Entity
{
    id: number;
    type: string;
    name: string;
    lname: string;
    defs: Def[];
    display?: string | null;
    /** removed by an incremental update (its last definition went): out of every lookup; the id is not reused */
    dead?: true;
}

/** A definition's place in its file (GameIndex.defAnchor): what the describer's line anchors are made from. */
export interface DefAnchor
{
    /** absolute path (or `archive.zip › entry`) and game-relative path */
    file: string;
    rel: string;
    /** ModInfo id; absent = the game */
    mod?: string;
    /** textHash of the file's text */
    hash: string;
    /** offset and 1-based line where the definition's text starts (defNode's node offsets are relative to it), its end */
    start: number;
    line: number;
    end: number;
    /**
     * a mod's file (or asked for — defAnchor `withText`): its whole text — the anchors' statement checks
     * (LineSource.stmt) read around the statements
     */
    text?: string;
    /**
     * defNode's text had `$PARAM$`s filled in (an inlined scripted effect / trigger): its offsets → the definition's own
     * (Describer.anchor)
     */
    map?: (o: number) => number;
}

export interface BuildProgress
{
    phase: string;
    done: number;
    total: number;
}

/**
 * Everything a build produces that can't be derived cheaply, as flat columns (see cache.ts): entities (type index,
 * name, definitions), localization texts, the reference table and its context strings. Lookup maps, the per-entity
 * ref lists and the gfx paths are rebuilt on import.
 */
export interface IndexState
{
    types: string[];
    eType: Uint16Array;
    eName: string[];
    /** definitions of entity i: defOff[i] .. defOff[i + 1] */
    defOff: Uint32Array;
    dFile: Int32Array;
    dLine: Int32Array;
    dStart: Int32Array;
    dEnd: Int32Array;
    dLocal: Uint8Array;
    /** sparse: definition index → leading comment / meta */
    docAt: Int32Array;
    docs: string[];
    metaAt: Int32Array;
    metas: Record<string, string>[];
    locKeys: string[];
    locTexts: string[];
    refs: { from: Int32Array; to: Int32Array; file: Int32Array; line: Int32Array; off: Int32Array; len: Int32Array; ctx: Int32Array; };
    ctx: string[];
    /** name filters of the files (bloom.ts): file i's words are bloom[bloomOff[i] .. bloomOff[i + 1]] */
    bloomOff: Uint32Array;
    bloom: Uint32Array;
}

/** What an incremental update did (GameIndex.refreshFiles). */
export interface RefreshResult
{
    /** the index changed: views reload */
    changed: boolean;
    /** a full re-index is needed instead — why (nothing was taken in) */
    fallback?: string;
    /** game-relative paths of the mod files taken in */
    files: string[];
    /** of those, the ones below gfx/ (images, models, portrait data) — shader files aside */
    gfx: string[];
    /** shader files (gfx/FX) that changed: not the index's — the compiled shaders are */
    shaders?: string[];
    /** display names computed again (those computed before that read what changed) */
    names?: number;
    /** display names dropped instead (too many to compute again: computed on use) */
    namesDropped?: number;
    /**
     * More files changed than one update takes (REFRESH_CHUNK): the rest (absolute paths), for the next update — each
     * update leaves the index as a build of the files taken in so far would
     */
    rest?: string[];
    /** script and localization files parsed again (changed, added, uncovered), and files only resolved again */
    parsed: number;
    resolved: number;
    ms: number;
}

/** Generated names of keys (resolveToken): lists and relations. */
const LIST_KEY = /^(?:any|every|random|ordered)_(\w+)$/;
const RELATION_KEY = /^(?:has|set|remove)_relation_(\w+)$/;
/** Top folders of a mod the app reads: changes anywhere else don't concern the index or what is derived from it. */
const INDEXED_TOPS = ['common', 'events', 'history', 'localization', 'gfx'];
const INDEXED_PATH = /^(common|events|history|localization|gfx)\//i;
/** Files one update takes in at most (the rest follow in further updates: the worker stays responsive in between). */
const REFRESH_CHUNK = 500;
/** More changed files than this share of the index's files: a full build is faster than updates. */
const REFRESH_FULL_SHARE = 0.5;
const SHADER_PATH = /^gfx\/fx\//i;
/** Entities that exist without definitions: flags and variables (by their uses), images and models (by their files). */
const IMPLICIT_TYPES = new Set([T_FLAG, T_VARIABLE, T_IMAGE, T_MODEL]);
/** Display names an update computes again at most; more are dropped and computed on use (refreshDisplays). */
const DISPLAY_EAGER = 20000;
/** Types whose display name comes from their definition (displayName: an event's title, a character's name …). */
const META_DISPLAY = new Set([T_EVENT, T_CHARACTER, 'dynasties', 'dynasty_houses']);

const NUMERIC = /^-?\d+(\.\d+)?$/;
const DATE_KEY = /^\d+\.\d+\.\d+$/;
/**
 * Types whose definitions in several files all count (on_actions append; flags and variables are only uses).
 * Localization keys are not among them: a later definition replaces the text — a `replace/` file's wins over all.
 */
const MERGING_TYPES = new Set([T_ON_ACTION, T_FLAG, T_VARIABLE]);

/** Mod entries of a type: all of them, per kind of change, and the conflicts (touched by two or more mods). */
interface ModCounts
{
    total: number;
    states: NonNullable<TypeSummary['modStates']>;
}
const MOD_STATE_ORDER: (keyof ModCounts['states'])[] = ['added', 'overridden', 'same', 'removed', 'merged', 'conflicts', 'duplicates'];
/** Two or more mods change the entry, one over the other (or add to it, merging) — not when they all leave it as the
 *  game has it, nor for flags and variables (mods using one name). */
const conflicting = (t: ModTouch): boolean => t.mods.length > 1 && t.state !== 'same' && !t.uses;
/** Name order of lists (numbers by value). One collator: `localeCompare` with options builds one per call — seconds for 200k characters. */
const nameOrder = new Intl.Collator(undefined, { numeric: true }).compare;

/**
 * Localization data functions taking a database key → the entity types that key names
 * (`[GetTrait('brave').GetName]`). Getters not listed fall back to any entity of that name.
 */
const GETTER_TYPES: Record<string, string[]> = {
    GetTrait: ['traits'],
    GetCourtPositionType: ['court_positions/types'],
    GetTitleByKey: ['landed_titles'],
    GetModifier: ['modifiers'],
    GetStaticModifier: ['modifiers'],
    GetActivityType: ['activities/activity_types'],
    GetAgentSlotType: ['schemes/agent_types'],
    GetBuilding: ['buildings'],
    GetScheme: ['schemes/scheme_types'],
    GetSchemeType: ['schemes/scheme_types'],
    GetLaw: ['laws'],
    GetLawGroup: ['law_groups'],
    GetFaithDoctrine: ['religion/doctrine_types'],
    GetDoctrine: ['religion/doctrine_types'],
    GetGovernment: ['governments'],
    GetVassalStance: ['vassal_stances'],
    GetDomicileBuilding: ['domiciles/buildings'],
    GetSituation: ['situation/situations'],
    GetSituationType: ['situation/situations'],
    GetSubjectContractType: ['subject_contracts/contracts'],
    GetCultureTradition: ['culture/traditions'],
    GetCulturePillar: ['culture/pillars'],
    GetCultureByKey: ['culture/cultures'],
    GetInnovation: ['culture/innovations'],
    GetMaA: ['men_at_arms_types'],
    GetMenAtArmsType: ['men_at_arms_types'],
    GetPerk: ['lifestyle_perks'],
    GetLifestyle: ['lifestyles'],
    GetFocus: ['focuses'],
    GetTerrain: ['terrain_types'],
    GetFaithByKey: ['faith'],
    GetReligionByKey: ['religion/religion_types'],
    GetReligionFamily: ['religion/religion_family_types'],
    GetDecisionWithKey: ['decisions'],
    GetDynastyPerk: ['dynasty_perks'],
    GetDynastyLegacy: ['dynasty_legacies'],
    GetCouncillorPosition: ['council_positions'],
    GetScriptedCharacterByHistoryID: ['characters'],
    GetAccoladeType: ['accolade_types'],
    GetTaskContractType: ['task_contracts'],
    GetGreatProjectType: ['great_projects/types'],
    GetCasusBelliType: ['casus_belli_types'],
    GetEpidemicType: ['epidemics'],
    GetLegendType: ['legends/legend_types'],
    GetLocalizedText: ['localization'],
    GetGameConcept: ['game_concepts']
};
/** Keys whose scalar value is usually a localization key. */
const LOC_CONTEXT = /(^|_)(title|desc|description|name|text|tooltip|tt|flavor|label|message|key|reason|localization|loc|custom)$/;
/** Tokens that look like loc keys on their own (event loc `ns.1234.a`, `*_tt`, `*_desc`). */
const LOC_LIKE_TOKEN = /\.|_(tt|desc|title|tooltip|name|text)$/;

export { resolveGameDir } from '../gameDir.ts';

/** Detaches a substring from its (huge) parent file string so the file text can be collected. */
function detach(s: string): string
{
    return s.length > 12 ? (' ' + s).slice(1) : s;
}

class Interner
{
    list: string[] = [];
    map = new Map<string, number>();
    id(s: string): number
    {
        let i = this.map.get(s);

        if (i === undefined)
        {
            i = this.list.length;
            this.list.push(detach(s));
            this.map.set(this.list[i], i);
        }

        return i;
    }
}

/** Where an entry of a type written inside other definitions sits (newEntryInfo): its holder, file and line. */
export interface NestedExample
{
    name: string;
    holder: string;
    holderType?: string;
    holderLabel?: string;
    /** the keys of the blocks between the holder and it (a faith: `faiths`) */
    within: string[];
    rel: string;
    line: number;
}

export class GameIndex
{
    readonly gameDir: string;
    readonly language: string;
    files: FileInfo[] = [];
    entities: Entity[] = [];
    private byType = new Map<string, Map<string, Entity>>();
    private byName = new Map<string, Entity[]>();
    private locText = new Map<string, string>();
    private typeDocs = new Map<string, GameFile[]>();

    // references (struct of arrays)
    private rFrom: number[] = [];
    private rTo: number[] = [];
    private rFile: number[] = [];
    private rLine: number[] = [];
    private rOff: number[] = [];
    private rLen: number[] = [];
    private rCtx: number[] = [];
    private ctx = new Interner();
    private outgoing = new Map<number, number[]>();
    private incoming = new Map<number, number[]>();
    private refsByFile = new Map<number, number[]>();
    /** per file: the names its references look up (bloom.ts) — which files an update must resolve again */
    private blooms: (Uint32Array | undefined)[] = [];

    // incremental updates (refreshFiles)
    /** references (rFrom = -1) and entities an update removed */
    private deadRefs = 0;
    private deadEntities = 0;
    /** processing order of each file slot in a full build of the current files (hidden and loc files first) */
    private rank: Int32Array = new Int32Array(0);
    /** during an update: entities whose definitions change, with what they were before */
    private touchLog: Map<Entity, { removed: boolean; }> | null = null;
    /** an update changed the index since it was built or loaded (the cache needs a snapshot with remapped files) */
    refreshed = false;

    private fileCache = new Map<number, string>();

    // images (gfx/ of game, DLCs and jomini)
    private imgByLc = new Map<string, Entity>();
    private imgByBase = new Map<string, Entity[]>();
    private imgFile = new Map<number, GameFile>();
    // 3D model files (.asset / .mesh), same roots
    private modelByLc = new Map<string, Entity>();
    private modelFile = new Map<number, GameFile>();
    private imageCache = new Map<number, { icon?: Entity; illu?: Entity; }>();
    private iconUsers: Map<number, Entity[]> | null = null;
    private typeTokenCache = new Map<string, string[]>();
    /** gfx listing of the scan: a build registers its files as entities, a cache import links them back */
    private gfx: { images: GameFile[]; models: GameFile[]; } = { images: [], models: [] };
    /** the files as the game sees them: the game folder and the loaded mods in load order (docs/mods.md) */
    readonly vfs: GameFiles;
    private t0 = 0;
    stats: IndexStats = { files: 0, entities: 0, refs: 0, ms: 0, locKeys: 0 };

    /** @param files the game folder (no mods), or its layering with mods */
    constructor(files: string | GameFiles, language: string)
    {
        this.vfs = typeof files === 'string' ? new GameFiles(files) : files;
        this.gameDir = this.vfs.gameDir;
        this.language = language;
    }

    // -------------------------------------------------------------------------
    // Build
    // -------------------------------------------------------------------------

    build(onProgress?: (p: BuildProgress) => void): void
    {
        this.scan(onProgress);
        this.parseAll(onProgress);
    }

    /** Lists what a build reads (script, localization, type docs, gfx) — cheap; a cached index is matched against it. */
    scan(onProgress?: (p: BuildProgress) => void): void
    {
        this.t0 = Date.now();
        onProgress?.({ phase: 'Scanning files', done: 0, total: 1 });
        this.scanFiles();
    }

    /** The full build after scan(): parses every file and resolves the references. */
    parseAll(onProgress?: (p: BuildProgress) => void): void
    {
        const report = (phase: string, done: number, total: number): void => onProgress?.({ phase, done, total });
        this.linkGfx(true);
        // files a mod hid go first: an entity's hidden definitions then precede its loaded ones, and the winning
        // definition stays the last one whenever the game still has any (winningIdx)
        const inOrder = (loc: boolean): (readonly [FileInfo, number])[] =>
        {
            const all = this.files.map((f, i) => [f, i] as const).filter(([f]) => (f.area === 'localization') === loc);
            return [...all.filter(([f]) => f.hidden), ...all.filter(([f]) => !f.hidden)];
        };

        // Localization first so that display names and loc references are available.
        const locFiles = inOrder(true);
        locFiles.forEach(([f, idx], n) =>
        {
            if (n % 50 === 0)
                report('Reading localization', n, locFiles.length);

            this.indexLocFile(f, idx);
        });

        // Script files: parse once, register definitions, collect candidate tokens.
        const cands = new CandidateTable();
        const scriptFiles = inOrder(false);
        scriptFiles.forEach(([f, idx], n) =>
        {
            if (n % 25 === 0)
                report('Parsing scripts', n, scriptFiles.length);

            this.indexScriptFile(f, idx, cands);
        });

        report('Resolving references', 0, cands.size);
        this.resolveCandidates(cands, (d) => report('Resolving references', d, cands.size));
        report('Resolving localization references', 0, 1);
        this.resolveLocRefs();
        this.buildRefIndexes();
        this.finish(false);
        report('Done', 1, 1);
    }

    private finish(cached: boolean): void
    {
        this.stats = {
            files: this.files.filter((f) => !f.hidden && !f.gone).length,
            entities: this.entities.length - this.deadEntities,
            refs: this.rFrom.length - this.deadRefs,
            ms: Date.now() - this.t0,
            locKeys: this.locText.size,
            cached
        };
        const mods = this.vfs.sources.filter((s) => s.kind === 'mod').map((s) => ({ id: s.modId!, name: s.name }));

        if (mods.length)
            this.stats.mods = mods;
    }

    /**
     * Loaded mods renamed in their descriptors (the layering unchanged — docs/indexer.md, "Not the index's files"):
     * origins and the stats' mod list name them anew. Returns whether a name changed.
     */
    renameMods(names: { id: string; name: string; }[]): boolean
    {
        const byId = new Map(names.map((m) => [m.id.toLowerCase(), m.name]));
        let changed = false;

        for (const s of this.vfs.sources)
        {
            const name = s.modId ? byId.get(s.modId.toLowerCase()) : undefined;

            if (name !== undefined && name !== s.name)
            {
                s.name = name;
                changed = true;
            }
        }

        if (changed && this.stats.mods)
            this.stats = { ...this.stats, mods: this.vfs.sources.filter((s) => s.kind === 'mod').map((s) => ({ id: s.modId!, name: s.name })) };

        return changed;
    }

    /**
     * Identity of everything a build reads, after scan(): each indexed file's path, size and modification time (files
     * a mod hid included, with who hid them), the type docs, the gfx listing (image/model entities), language and
     * `code` (the indexer's own version). A cached index is valid only for the same fingerprint.
     */
    fingerprint(code: string, stampOf?: (f: FileInfo) => FileInfo['stamp']): string
    {
        const h = createHash('sha1');
        h.update(`${code}\n${this.gameDir}\n${this.language}\n${this.vfs.identity()}\n`);

        for (const f of this.files)
        {
            if (f.gone)
                continue;

            // (the stamps say which version of each file the index holds: an update compares them)
            const st = stampOf?.(f) ?? this.vfs.stat(f.gf);

            if (!stampOf && st.size >= 0)
                f.stamp = st;

            const { size, mtime } = st;
            h.update(`${f.rel}|${f.source}|${f.area}|${f.type ?? ''}|${size}|${mtime}|${f.hidden ? f.hidden.by + f.hidden.how : ''}\n`);
        }

        for (const [t, list] of this.typeDocs)
            h.update(`doc ${t}|${list.map((f) => f.source + ':' + f.rel).join('|')}\n`);

        for (const m of this.gfx.models)
            h.update(`m ${m.source} ${m.rel}\n`);

        for (const i of this.gfx.images)
            h.update(`i ${i.source} ${i.rel}\n`);

        return h.digest('hex');
    }

    /**
     * The index as flat columns for the cache (see IndexState). Only what a build of the current files has: entities
     * an update removed, flags and variables nothing refers to any more (or created on demand by queries) and removed
     * references are left out, the rest renumbered. `fileMap` (after updates): file slot → index in a fresh scan.
     */
    exportState(fileMap?: Int32Array, fileCount = this.files.length): IndexState
    {
        const types: string[] = [];
        const typeIdx = new Map<string, number>();
        const newId = new Int32Array(this.entities.length).fill(-1);
        const kept = this.entitiesInBuildOrder((e) => !e.dead && !((e.type === T_FLAG || e.type === T_VARIABLE) && !this.incoming.get(e.id)?.length));
        const n = kept.length;
        let defCount = 0;
        kept.forEach((e, i) =>
        {
            newId[e.id] = i;
            defCount += e.defs.length;
        });
        const fileOf = (f: number): number => (fileMap ? fileMap[f] : f);
        const order = this.refsInBuildOrder((r) => this.rFrom[r] >= 0 && newId[this.rFrom[r]] >= 0 && newId[this.rTo[r]] >= 0);
        const live = order.length;
        const refs = {
            from: new Int32Array(live),
            to: new Int32Array(live),
            file: new Int32Array(live),
            line: new Int32Array(live),
            off: new Int32Array(live),
            len: new Int32Array(live),
            ctx: new Int32Array(live)
        };

        for (let j = 0; j < live; j++)
        {
            const r = order[j];
            refs.from[j] = newId[this.rFrom[r]];
            refs.to[j] = newId[this.rTo[r]];
            refs.file[j] = fileOf(this.rFile[r]);
            refs.line[j] = this.rLine[r];
            refs.off[j] = this.rOff[r];
            refs.len[j] = this.rLen[r];
            refs.ctx[j] = this.rCtx[r];
        }

        // name filters in file order
        const bloomOff = new Uint32Array(fileCount + 1);
        const bySlot = new Array<Uint32Array | undefined>(fileCount);
        this.blooms.forEach((b, i) =>
        {
            const j = fileOf(i);

            if (b && j >= 0 && j < fileCount)
                bySlot[j] = b;
        });

        for (let j = 0; j < fileCount; j++)
            bloomOff[j + 1] = bloomOff[j] + (bySlot[j]?.length ?? 0);

        const bloom = new Uint32Array(bloomOff[fileCount]);
        bySlot.forEach((b, j) => b && bloom.set(b, bloomOff[j]));
        const s: IndexState = {
            types,
            eType: new Uint16Array(n),
            eName: new Array<string>(n),
            defOff: new Uint32Array(n + 1),
            dFile: new Int32Array(defCount),
            dLine: new Int32Array(defCount),
            dStart: new Int32Array(defCount),
            dEnd: new Int32Array(defCount),
            dLocal: new Uint8Array(defCount),
            docAt: new Int32Array(0),
            docs: [],
            metaAt: new Int32Array(0),
            metas: [],
            locKeys: [...this.locText.keys()],
            locTexts: [...this.locText.values()],
            refs,
            ctx: [...this.ctx.list],
            bloomOff,
            bloom
        };
        const docAt: number[] = [];
        const metaAt: number[] = [];
        let k = 0;

        for (let i = 0; i < n; i++)
        {
            const e = kept[i];
            let t = typeIdx.get(e.type);

            if (t === undefined)
            {
                t = types.length;
                types.push(e.type);
                typeIdx.set(e.type, t);
            }

            s.eType[i] = t;
            s.eName[i] = e.name;
            s.defOff[i] = k;

            for (const d of e.defs)
            {
                s.dFile[k] = fileOf(d.file);
                s.dLine[k] = d.line;
                s.dStart[k] = d.start;
                s.dEnd[k] = d.end;

                if (d.local)
                    s.dLocal[k] = 1;

                if (d.doc)
                {
                    docAt.push(k);
                    s.docs.push(d.doc);
                }

                if (d.meta)
                {
                    metaAt.push(k);
                    s.metas.push(d.meta);
                }

                k++;
            }
        }

        s.defOff[n] = k;
        s.docAt = Int32Array.from(docAt);
        s.metaAt = Int32Array.from(metaAt);
        return s;
    }

    /**
     * The entries that pass `keep` in the order a build creates them (a cache import numbers them in this order, which
     * decides the order of names() and of equally ranked search results). Without updates that is id order; after
     * them: models and images in listing order, localization and script entries by first definition (a counting sort
     * by file, then position), flags and variables by first use.
     */
    private entitiesInBuildOrder(keep: (e: Entity) => boolean): Entity[]
    {
        if (!this.refreshed)
            return this.entities.filter(keep);

        const gfx: Entity[] = [];
        const defined: Entity[] = [];
        const used: Entity[] = [];

        for (const e of this.entities)
        {
            if (!keep(e))
                continue;

            if (e.type === T_MODEL || e.type === T_IMAGE)
                gfx.push(e);
            else if (e.type === T_FLAG || e.type === T_VARIABLE || !e.defs.length)
                used.push(e);
            else
                defined.push(e);
        }

        const g = this.gfxPositions();
        gfx.sort((a, b) => (g.get(a.id) ?? 0) - (g.get(b.id) ?? 0) || a.id - b.id);
        const start = new Int32Array(this.rank.length + 1);

        for (const e of defined)
            start[this.rank[e.defs[0].file] + 1]++;

        for (let b = 1; b < start.length; b++)
            start[b] += start[b - 1];

        const byFile = new Array<Entity>(defined.length);

        for (const e of defined)
            byFile[start[this.rank[e.defs[0].file]]++] = e;

        // (each file's run by position)
        for (let i = 0; i < byFile.length;)
        {
            let j = i + 1;

            while (j < byFile.length && byFile[j].defs[0].file === byFile[i].defs[0].file)
                j++;

            if (j - i > 1)
            {
                const run = byFile.slice(i, j).sort((a, b) => a.defs[0].start - b.defs[0].start || a.id - b.id);

                for (let x = 0; x < run.length; x++)
                    byFile[i + x] = run[x];
            }

            i = j;
        }

        used.sort((a, b) => this.creationOrder(a, b));
        return [...gfx, ...byFile, ...used];
    }

    /**
     * The references that pass `keep`, in the order a build creates them (its lists iterate them that way, and a cache
     * import rebuilds the lists in this order): script references by file in processing order, each file's as found
     * (an update hands out a file's ids in one run); localization references after them, by key. Without updates that
     * is id order; after them, two counting sorts.
     */
    private refsInBuildOrder(keep: (r: number) => boolean): Int32Array
    {
        const n = this.rFrom.length;
        let live = 0;

        for (let r = 0; r < n; r++)
            if (keep(r))
                live++;

        const out = new Int32Array(live);

        if (!this.refreshed)
        {
            for (let r = 0, j = 0; r < n; r++)
                if (keep(r))
                    out[j++] = r;

            return out;
        }

        // script references: bucketed by file rank (a counting sort keeps the id order in each)
        const ranks = this.rank.length;
        const start = new Int32Array(ranks + 1);
        const loc: number[] = [];

        for (let r = 0; r < n; r++)
        {
            if (!keep(r))
                continue;

            if (this.rOff[r] >= 0)
                start[this.rank[this.rFile[r]] + 1]++;
            else
                loc.push(r);
        }

        for (let b = 1; b < start.length; b++)
            start[b] += start[b - 1];

        for (let r = 0; r < n; r++)
            if (this.rOff[r] >= 0 && keep(r))
                out[start[this.rank[this.rFile[r]]]++] = r;

        // localization references after them, by key in creation order
        out.set(loc.sort(this.refOrder), live - loc.length);
        return out;
    }

    /**
     * The cache after incremental updates: the files a fresh scan lists now (same set as the index holds, in scan order)
     * and a fingerprint over the versions the index read (FileInfo.stamp). Null when they don't match (an update is
     * pending) or a file's version is unknown — `fillStamps` takes the file's current one then (the cache was off).
     */
    cacheSnapshot(code: string, fillStamps = false): { fingerprint: string; state: IndexState; } | null
    {
        const fresh = new GameIndex(this.vfs, this.language);
        fresh.scanFiles();
        const slotOf = new Map<string, number>();
        this.files.forEach((f, i) => f.gone || slotOf.set(fileKey(f, true), i));

        if (slotOf.size !== fresh.files.length)
            return null;

        if (fresh.gfx.images.length !== this.gfx.images.length || fresh.gfx.models.length !== this.gfx.models.length)
            return null;

        const fileMap = new Int32Array(this.files.length).fill(-1);
        const stamps = new Map<FileInfo, NonNullable<FileInfo['stamp']>>();

        for (let j = 0; j < fresh.files.length; j++)
        {
            const s = slotOf.get(fileKey(fresh.files[j], true));

            if (s === undefined)
                return null;

            fileMap[s] = j;
            const mine = this.files[s];

            if (!mine.stamp && fillStamps)
            {
                const st = this.vfs.stat(mine.gf);

                if (st.size >= 0)
                    mine.stamp = st;
            }

            if (!mine.stamp)
                return null;

            stamps.set(fresh.files[j], mine.stamp);
        }

        return { fingerprint: fresh.fingerprint(code, (f) => stamps.get(f)), state: this.exportState(fileMap, fresh.files.length) };
    }

    /**
     * Instead of parseAll() after scan(): restores a cached build (same fingerprint) and rebuilds the lookups.
     * `onProgress` reports "Loading the cached index" from 30 % (reading the file comes first) to 100 %.
     */
    importState(s: IndexState, onProgress?: (p: BuildProgress) => void): void
    {
        const report = (pct: number): void => onProgress?.({ phase: 'Loading the cached index', done: Math.round(pct), total: 100 });
        const n = s.eName.length;
        this.entities = new Array<Entity>(n);
        let doc = 0;
        let meta = 0;

        for (let i = 0; i < n; i++)
        {
            if (i % 50000 === 0)
                report(30 + (40 * i) / n);

            const type = s.types[s.eType[i]];
            const name = s.eName[i];
            const defs: Def[] = [];

            for (let k = s.defOff[i]; k < s.defOff[i + 1]; k++)
            {
                const d: Def = { file: s.dFile[k], line: s.dLine[k], start: s.dStart[k], end: s.dEnd[k] };

                if (s.dLocal[k])
                    d.local = true;

                if (doc < s.docAt.length && s.docAt[doc] === k)
                    d.doc = s.docs[doc++];

                if (meta < s.metaAt.length && s.metaAt[meta] === k)
                    d.meta = s.metas[meta++];

                defs.push(d);
            }

            const e: Entity = { id: i, type, name, lname: name.toLowerCase(), defs };
            this.entities[i] = e;
            let m = this.byType.get(type);

            if (!m)
                this.byType.set(type, m = new Map());

            m.set(name, e);
            const list = this.byName.get(name);

            if (list)
                list.push(e);
            else
                this.byName.set(name, [e]);
        }

        report(70);

        for (let i = 0; i < s.locKeys.length; i++)
            this.locText.set(s.locKeys[i], s.locTexts[i]);

        report(75);
        this.rFrom = Array.from(s.refs.from);
        this.rTo = Array.from(s.refs.to);
        this.rFile = Array.from(s.refs.file);
        this.rLine = Array.from(s.refs.line);
        this.rOff = Array.from(s.refs.off);
        this.rLen = Array.from(s.refs.len);
        this.rCtx = Array.from(s.refs.ctx);

        for (const c of s.ctx)
            this.ctx.id(c);

        // (a copy: views would keep the whole cache file's buffer alive)
        const words = s.bloom ? s.bloom.slice() : new Uint32Array(0);
        this.blooms = new Array(this.files.length);

        for (let i = 0; s.bloomOff && i < this.files.length && i + 1 < s.bloomOff.length; i++)
        {
            if (s.bloomOff[i + 1] > s.bloomOff[i])
                this.blooms[i] = words.subarray(s.bloomOff[i], s.bloomOff[i + 1]);
        }

        this.linkGfx(false);
        report(80);
        this.buildRefIndexes();
        this.finish(true);
        report(100);
    }

    /** 3D model files of the scan (.asset / .mesh) — available before any build. */
    modelFiles(): GameFile[]
    {
        return this.gfx.models;
    }

    /** Image and model entities ↔ their files: registered by a build, looked up again after a cache import. */
    private linkGfx(create: boolean): void
    {
        for (const m of this.gfx.models)
        {
            const e = this.entity(T_MODEL, m.rel, create);

            if (!e)
                continue;

            this.modelByLc.set(e.lname, e);
            this.modelFile.set(e.id, m);
        }

        for (const img of this.gfx.images)
        {
            const e = this.entity(T_IMAGE, img.rel, create);

            if (!e)
                continue;

            this.imgByLc.set(e.lname, e);
            const base = e.lname.slice(e.lname.lastIndexOf('/') + 1).replace(IMAGE_EXT, '');
            const list = this.imgByBase.get(base);

            if (list)
                list.push(e);
            else
                this.imgByBase.set(base, [e]);

            this.imgFile.set(e.id, img);
        }
    }

    // -------------------------------------------------------------------------
    // Incremental updates (docs/indexer.md, "Incremental updates")
    // -------------------------------------------------------------------------

    /**
     * Takes in files of loaded mod folders that changed on disk — written, created or deleted (absolute paths; a folder
     * stands for everything below it) — without a full build, with the result of one: changed files are parsed again
     * (their definitions, references and texts replaced), new files added with the layering (a same-path file hides
     * the lower layer's, which comes back when it goes), and every file whose references may resolve differently
     * because an entry appeared, vanished or was removed by a mod is resolved again (found by its name filter and by
     * the references to the entries of that name). A file added to or removed from a `common/` top folder changes the
     * type of every file there (commonTypeFor): those are parsed again as their new type. Shader files (gfx/FX) are not
     * the index's: the listings take them in and `shaders` names them. Many files: taken in `REFRESH_CHUNK` at a time
     * (`rest`: call again with it); a `fallback` reason when a full build is faster (more than half the files).
     * descriptor.mod is not read here: the caller compares the mods (main: the loaded mods' layering).
     */
    refreshFiles(paths: string[], chunk = REFRESH_CHUNK): RefreshResult
    {
        const t0 = performance.now();
        const res: RefreshResult = { changed: false, files: [], gfx: [], parsed: 0, resolved: 0, ms: 0 };
        const done = (fallback?: string): RefreshResult =>
        {
            const out: RefreshResult = { ...res, ms: Math.round(performance.now() - t0) };

            if (fallback)
                out.fallback = fallback;

            return out;
        };

        // 1. the mod files behind the paths; a file with the size and time it had when read is unchanged
        const slotOf = new Map<string, number>();
        this.files.forEach((f, i) => f.gone || slotOf.set(fileKey(f), i));
        const found: { source: number; rel: string; key: string; }[] = [];
        const foundKeys = new Set<string>();
        const shaders = new Map<number, string[]>();

        for (const p of paths)
        {
            const at = this.vfs.locate(p);

            if (!at)
                continue;

            const rels = this.vfs.expand(at.source, at.rel, INDEXED_TOPS);
            // (a folder: the files below it)
            const viaFolder = rels.length !== 1 || rels[0].toLowerCase() !== at.rel.toLowerCase();

            for (const rel of rels)
            {
                if (!INDEXED_PATH.test(rel))
                    continue;

                const key = at.source + '|' + rel.toLowerCase();

                if (foundKeys.has(key))
                    continue;

                foundKeys.add(key);
                const s = slotOf.get(key);

                // a file only a folder event names, whose version the index doesn't know (images, models, shader files —
                // no FileInfo): taken in when it came or went; changed in place, it has an event of its own (Windows
                // reports the folder of every changed file too — every file below it went along)
                if (viaFolder && s === undefined && this.vfs.isListed(at.source, rel) === this.vfs.onDisk(at.source, rel))
                    continue;

                // (no stamps: every one counts — the shader store fingerprints them itself)
                if (SHADER_PATH.test(rel))
                {
                    const list = shaders.get(at.source) ?? [];
                    shaders.set(at.source, list);
                    list.push(rel);
                    continue;
                }

                const stamp = s === undefined ? undefined : this.files[s].stamp;

                if (stamp)
                {
                    // (ctime: a copy over the file keeps the old modification time)
                    const st = this.vfs.stat(this.files[s!].gf);

                    if (st.size === stamp.size && st.mtime === stamp.mtime && st.ctime === stamp.ctime)
                        continue;
                }

                found.push({ source: at.source, rel, key });
            }
        }

        if (shaders.size)
        {
            // the listings (the shader store fingerprints gfx/FX through them)
            for (const [source, rels] of shaders)
            {
                this.vfs.update(source, rels);
                res.files.push(...rels);
            }

            res.shaders = [...shaders.values()].flat();
        }

        if (!found.length)
            return done();

        if (found.length > chunk && found.length > this.files.length * REFRESH_FULL_SHARE)
            return done(`${found.length} files changed`);

        // (the files beyond one update's share: the next update — their stamps still say they changed)
        if (found.length > chunk)
        {
            res.rest = found.slice(chunk).map((x) => this.vfs.diskPath(x.source, x.rel)!);
            found.length = chunk;
        }

        const changes = new Map<number, string[]>();
        const changedKeys = new Set<string>();

        for (const { source, rel, key } of found)
        {
            changedKeys.add(key);
            const list = changes.get(source) ?? [];
            changes.set(source, list);
            list.push(rel);
            res.files.push(rel);

            if (/^gfx\//i.test(rel))
                res.gfx.push(rel);
        }

        // 2. the listings take them in
        for (const [source, rels] of changes)
            this.vfs.update(source, rels);

        const next = this.scanLists();
        res.changed = true;

        // 3. which file slots change: same source and path keep their slot, new files get one at the end
        const oldCount = this.files.length;
        const slotOfNext = new Array<number>(next.files.length);
        const dirtyOld = new Set<number>();
        const dirtyNew = new Set<number>();
        const replaced = new Map<number, FileInfo>();
        const appended: FileInfo[] = [];
        const seen = new Set<number>();

        for (let j = 0; j < next.files.length; j++)
        {
            const nf = next.files[j];
            const k = fileKey(nf);
            const s = slotOf.get(k);

            if (s === undefined)
            {
                slotOfNext[j] = oldCount + appended.length;
                dirtyNew.add(slotOfNext[j]);
                appended.push(nf);
                continue;
            }

            slotOfNext[j] = s;
            seen.add(s);
            const of = this.files[s];

            // changed, hidden / uncovered by the change of another source's file of the same path, or of another type
            // now (a .txt directly in its common/ top folder came or went: every file there is parsed as its new type)
            if (changedKeys.has(k) || fileKey(of, true) !== fileKey(nf, true) || of.type !== nf.type)
            {
                dirtyOld.add(s);
                dirtyNew.add(s);
                replaced.set(s, nf);
            }
        }

        for (const s of slotOf.values())
            if (!seen.has(s))
                dirtyOld.add(s);

        // 4. the order a full build of these files processes them in: hidden before loaded, localization first
        const total = oldCount + appended.length;
        const rank = new Int32Array(total).fill(-1);
        let pos = 0;

        for (const loc of [true, false])
        {
            for (const hidden of [true, false])
            {
                for (let j = 0; j < next.files.length; j++)
                {
                    const f = next.files[j];

                    if ((f.area === 'localization') === loc && !!f.hidden === hidden)
                        rank[slotOfNext[j]] = pos++;
                }
            }
        }

        this.rank = rank;

        // 5. what the old versions contributed goes: definitions (entries remember how they were), references
        this.touchLog = new Map();
        const entitiesBefore = this.entities.length;
        const refsBefore = this.rFrom.length;
        const oldMask = new Uint8Array(total);

        for (const s of dirtyOld)
            oldMask[s] = 1;

        for (const e of this.entities)
        {
            if (e.dead)
                continue;

            let hit = false;

            for (const d of e.defs)
                if (oldMask[d.file])
                    hit = true;

            if (!hit)
                continue;

            this.noteTouch(e);
            e.defs = e.defs.filter((d) => !oldMask[d.file]);
        }

        const killed: number[] = [];
        const refsOf = (s: number): void =>
        {
            for (const r of this.refsByFile.get(s) ?? [])
                killed.push(r);

            this.refsByFile.delete(s);
        };

        for (const s of dirtyOld)
            refsOf(s);

        for (const [s, nf] of replaced)
            this.files[s] = nf;

        for (const nf of appended)
            this.files.push(nf);

        for (const s of dirtyOld)
        {
            if (!replaced.has(s))
                this.files[s] = { ...this.files[s], gone: true };

            this.blooms[s] = undefined;
            this.fileCache.delete(s);
            this.constCache.delete(s);
            this.sameConsts.delete(s);
            this.hashes.delete(s);
        }

        // 6. the new versions: definitions (merged into each entry in processing order) and candidate references
        const cands = new CandidateTable();
        const locEntries = new Map<number, LocEntry[]>();

        for (const s of [...dirtyNew].sort((a, b) => rank[a] - rank[b]))
        {
            const f = this.files[s];
            this.fileCache.delete(s);
            this.constCache.delete(s);
            this.sameConsts.delete(s);
            this.hashes.delete(s);
            const st = this.vfs.stat(f.gf);
            const src = this.vfs.readText(f.gf);

            if (st.size >= 0)
                f.stamp = st;

            if (src === undefined)
                continue;

            this.fileCache.set(s, src);

            if (f.area === 'localization')
                locEntries.set(s, this.indexLocFile(f, s, src));
            else
                this.indexScriptFile(f, s, cands, src);

            res.parsed++;
        }

        for (const e of this.touchLog.keys())
            if (e.defs.length > 1)
                e.defs.sort((a, b) => rank[a.file] - rank[b.file]);

        // 7. entries that appeared (born), lost their last definition (died), or were removed / restored by a mod while
        // their name has several entries (preferLive picks among them): what refers to their names may resolve differently
        const born = new Set<string>();
        // (images are looked up by their base name in lower case)
        const lowerNames = new Set<string>();
        const renamed = new Set<string>();
        const changedEntities: { e: Entity; how: 'born' | 'died' | 'removed' | 'restored'; }[] = [];
        const locTouched = new Set<Entity>();
        const changedEntity = (e: Entity, how: 'born' | 'died' | 'removed' | 'restored', name = e.name): void =>
        {
            // (only a new name can make a token resolve that resolved to nothing: those are found by the name filters)
            if (how === 'born')
                born.add(name);

            if (e.type === T_IMAGE)
                lowerNames.add(name);

            renamed.add(name);
            changedEntities.push({ e, how });
        };

        for (const [e, before] of this.touchLog)
        {
            if (e.type === T_LOC)
                locTouched.add(e);

            if (e.id >= entitiesBefore)
                changedEntity(e, 'born');
            else if (!e.defs.length && !IMPLICIT_TYPES.has(e.type))
            {
                this.killEntity(e);
                changedEntity(e, 'died');
            }
            else if (before.removed !== this.isRemoved(e) && (this.byName.get(e.name)?.length ?? 0) > 1)
                changedEntity(e, before.removed ? 'restored' : 'removed');
        }

        if (res.gfx.length)
        {
            const paths = new Set(res.gfx.map((r) => r.toLowerCase()));
            this.refreshGfx(next.gfx, paths, (e, isNew, name) => changedEntity(e, isNew ? 'born' : 'died', name));
        }

        this.typeDocs = next.typeDocs;
        // names listing several entries list them in the order a build creates them (named()[0], the order of ambiguous
        // links) — a file that came, went or was hidden moves its entries' place in that order
        const reordered: string[] = [];
        const names = new Set(renamed);

        for (const e of this.touchLog.keys())
            names.add(e.name);

        for (const name of names)
        {
            const l = this.byName.get(name);

            if (!l || l.length < 2)
                continue;

            const before = l.slice();
            l.sort((a, b) => this.creationOrder(a, b));

            if (l.some((e, i) => e !== before[i]))
                reordered.push(name);
        }

        // 8. files to resolve again: their name filter may hold a new name, or they refer to an entry of a changed name
        const flagged = new Set<number>();
        const flaggedLoc = new Set<Entity>();
        // (per file: the new names its filter may hold — checked against its text below)
        const maybe = new Map<number, string[]>();

        if (born.size)
        {
            const hashes = [...born].map((n) => ({ n, h: nameHash(n) }));

            for (let s = 0; s < this.files.length; s++)
            {
                const f = this.files[s];

                if (f.gone || f.hidden || dirtyNew.has(s))
                    continue;

                const b = this.blooms[s];
                const hits = b ? hashes.filter((x) => bloomHas(b, x.h)) : [];

                if (hits.length)
                    maybe.set(s, hits.map((x) => x.n));
            }
        }

        // (a reference with several targets at one place; loc arguments resolve by name like those)
        const multi = new Map<number, Set<number>>();
        const ambiguous = (r: number): boolean =>
        {
            let offs = multi.get(this.rFile[r]);

            if (!offs)
            {
                multi.set(this.rFile[r], offs = new Set());
                const l = this.refsByFile.get(this.rFile[r]) ?? [];

                for (let i = 1; i < l.length; i++)
                    if (this.rOff[l[i]] === this.rOff[l[i - 1]])
                        offs.add(this.rOff[l[i]]);
            }

            return offs.has(this.rOff[r]);
        };
        const argCtx = this.ctx.id("('…') in text");
        const usersOf = (e: Entity, onlyAmbiguous: boolean): void =>
        {
            for (const r of this.incoming.get(e.id) ?? [])
            {
                if (this.rFrom[r] < 0)
                    continue;

                if (this.rOff[r] < 0)
                {
                    if (!onlyAmbiguous || this.rCtx[r] === argCtx)
                        flaggedLoc.add(this.entities[this.rFrom[r]]);
                }
                else if (!oldMask[this.rFile[r]] && !dirtyNew.has(this.rFile[r]) && (!onlyAmbiguous || ambiguous(r)))
                    flagged.add(this.rFile[r]);
            }
        };

        // died: its users; removed or restored: where it is one of several targets (preferLive drops a removed entry only
        // beside a loaded one); born or restored: every user of the other entries of its name (it may join or displace them)
        for (const { e, how } of changedEntities)
        {
            usersOf(e, how === 'removed' || how === 'restored');

            if (how !== 'born' && how !== 'restored')
                continue;

            const same = e.type === T_IMAGE ? this.imgByBase.get(imageBase(e.name)) : this.byName.get(e.name);

            for (const x of same ?? [])
                if (x !== e)
                    usersOf(x, false);
        }

        // names listed in another order now: their targets at ambiguous places come in that order
        for (const name of reordered)
            for (const e of this.byName.get(name) ?? [])
                usersOf(e, true);

        // a filter answers "maybe" for ~0.4 % of the names a file doesn't hold: with hundreds of new names (many files
        // at once, a folder's types changing) nearly every file would be resolved again — a file whose text holds none
        // of its hits can't look them up (a name looked up is part of its token; image names in lower case)
        const read = new Map<number, string>();

        for (const [s, hits] of maybe)
        {
            if (flagged.has(s))
                continue;

            const text = this.vfs.readText(this.files[s].gf) ?? '';
            let lower: string | undefined;

            if (hits.some((n) => text.includes(n) || (lowerNames.has(n) && (lower ??= text.toLowerCase()).includes(n))))
            {
                flagged.add(s);
                read.set(s, text);
            }
        }

        const textOf = (s: number): string => read.get(s) ?? this.readFile(s);

        // (localization files: their keys whose text the game uses)
        for (const s of [...flagged])
        {
            if (this.files[s].area !== 'localization')
                continue;

            flagged.delete(s);

            for (const en of parseLocalization(textOf(s)).entries)
            {
                const e = this.get(T_LOC, en.key);

                if (e && this.winningDef(e)?.file === s)
                    flaggedLoc.add(e);
            }
        }

        for (const s of [...flagged].sort((a, b) => rank[a] - rank[b]))
        {
            refsOf(s);
            this.indexScriptFile(this.files[s], s, cands, textOf(s), true);
            res.resolved++;
        }

        // 9. references: the old ones of all those go, the new ones are resolved against the tables as they are now
        const locRedo = [...new Set([...locTouched, ...flaggedLoc])].sort((a, b) => a.id - b.id);

        for (const e of locRedo)
            for (const r of this.outgoing.get(e.id) ?? [])
                killed.push(r);

        const lostRefs = this.killRefs(killed);
        this.resolveCandidates(cands, () =>
        {});
        // localization: the winning definition's text, then what it refers to
        const texts = new Map<number, Map<number, string>>();
        const textAt = (file: number, start: number): string | undefined =>
        {
            let m = texts.get(file);

            if (!m)
            {
                texts.set(file, m = new Map());

                for (const en of locEntries.get(file) ?? parseLocalization(this.readFile(file)).entries)
                    m.set(en.off, en.text);
            }

            return m.get(start);
        };

        // (keys whose text changed, came or went: display names that read them are computed again)
        const locChanged: string[] = [];

        for (const e of locTouched)
        {
            if (e.dead)
            {
                locChanged.push(e.name);
                continue;
            }

            const w = this.winningDef(e);
            const text = w && textAt(w.file, w.start);

            if (text !== this.locText.get(e.name))
                locChanged.push(e.name);

            if (text === undefined)
                this.locText.delete(e.name);
            else
                this.locText.set(e.name, detach(text));
        }

        for (const e of locRedo)
            if (!e.dead)
                this.addLocRefs(e);

        this.indexNewRefs(refsBefore);

        // flags and variables nothing refers to any more are gone (a build creates them from their uses)
        for (const id of lostRefs)
        {
            const e = this.entities[id];

            if ((e.type === T_FLAG || e.type === T_VARIABLE) && !e.dead && !this.incoming.get(id)?.length)
                this.killEntity(e);
        }

        // (safety net: nothing may refer to a removed entry)
        const dangling: number[] = [];

        for (const { e } of changedEntities)
            if (e.dead)
            {
                for (const r of this.incoming.get(e.id) ?? [])
                    dangling.push(r);
            }

        if (dangling.length)
            this.killRefs(dangling);

        // 10. the entries of a type in the order a build creates them (names(): concept aliases, doctrines, assets …) —
        // not localization keys, flags and variables, which nothing iterates by type
        const touched = [...this.touchLog.keys()];
        const types = new Set([...touched, ...changedEntities.map((c) => c.e)].map((e) => e.type));

        for (const t of types)
        {
            const m = this.byType.get(t);

            if (!m || t === T_LOC || t === T_FLAG || t === T_VARIABLE)
                continue;

            let prev: Entity | undefined;
            let sorted = true;

            for (const e of m.values())
            {
                if (prev && this.creationOrder(prev, e) > 0)
                {
                    sorted = false;
                    break;
                }

                prev = e;
            }

            if (!sorted)
                this.byType.set(t, new Map([...m.values()].sort((a, b) => this.creationOrder(a, b)).map((e) => [e.name, e])));
        }

        // 11. derived data
        this.astCache.clear();

        while (this.fileCache.size > 40)
            this.fileCache.delete(this.fileCache.keys().next().value!);

        if (touched.some((e) => e.type === 'game_concepts'))
            this.conceptAliases = null;

        // (a display name comes from localization, its entry's definition — an event's title —, other entries' names —
        // named()[0]: those computed so far that read what changed are computed again. A name another one shows changes
        // with the entry named()[0] finds — born, died, removed, restored, reordered — or, for names from a definition,
        // with a touched entry; names from localization follow their keys, which the outer name read too)
        const lookups = [...changedEntities.map((c) => c.e.name), ...reordered, ...touched.filter((e) => META_DISPLAY.has(e.type)).map((e) => e.name)];
        const displays = this.refreshDisplays(touched, [...locChanged, ...lookups.map((n) => '#' + n)]);
        res.names = displays.again;

        if (displays.dropped)
            res.namesDropped = displays.dropped;

        this.imageCache.clear();
        this.iconUsers = null;
        this.gfxHidden = null;
        this.removedImgs = null;

        // (whether the mods' definitions say what the game's do: again for the entries whose definitions changed — an
        // entry's constants and file-local triggers/effects are in the files of its definitions, so it is among them)
        this.localDefs = null;
        this.localCalls.clear();

        if (this.sameIds)
        {
            const same = this.findSame(touched);

            for (const e of touched)
            {
                if (same.has(e.id))
                    this.sameIds.add(e.id);
                else
                    this.sameIds.delete(e.id);
            }
        }

        for (const e of touched)
        {
            this.touchCache[e.id] = undefined;

            if (!e.dead && this.modCounts)
            {
                const t = this.modTouch(e);

                if (t)
                    this.countTouch(e.type, t, 1);
            }
        }

        // flags and variables: their touch follows their uses, which any update may change — counted afresh (cheap)
        for (const type of [T_FLAG, T_VARIABLE])
        {
            const m = this.byType.get(type);

            for (const e of m?.values() ?? [])
                this.touchCache[e.id] = undefined;

            if (!this.modCounts)
                continue;

            this.modCounts.delete(type);

            for (const e of m?.values() ?? [])
            {
                const t = this.modTouch(e);

                if (t)
                    this.countTouch(type, t, 1);
            }
        }

        this.touchLog = null;
        this.refreshed = true;
        this.compactRefs();
        this.stats = {
            ...this.stats,
            files: this.files.filter((f) => !f.hidden && !f.gone).length,
            entities: this.entities.length - this.deadEntities,
            refs: this.rFrom.length - this.deadRefs,
            locKeys: this.locText.size
        };
        return done();
    }

    /** Remembers how an entry was before an update changes its definitions (and takes it out of the mod counts). */
    private noteTouch(e: Entity): void
    {
        if (!this.touchLog || this.touchLog.has(e))
            return;

        this.touchLog.set(e, { removed: this.isRemoved(e) });

        if (this.modCounts && !e.dead)
        {
            const t = this.modTouch(e);

            if (t)
                this.countTouch(e.type, t, -1);
        }
    }

    /** Out of every lookup (an update removed its last definition or file); the id stays taken. */
    private killEntity(e: Entity): void
    {
        if (e.dead)
            return;

        this.noteTouch(e);
        e.dead = true;
        this.deadEntities++;
        const m = this.byType.get(e.type);

        if (m?.get(e.name) === e)
        {
            m.delete(e.name);

            if (!m.size)
                this.byType.delete(e.type);
        }

        const l = this.byName.get(e.name);
        const i = l ? l.indexOf(e) : -1;

        if (i >= 0)
            l!.splice(i, 1);

        if (l && !l.length)
            this.byName.delete(e.name);

        if (e.type === T_LOC)
            this.locText.delete(e.name);
    }

    /**
     * Images and models of the new gfx listing: new files become entries, gone ones die, others may come from another
     * file now. `paths` (lower case): the changed ones — how the mods touch those is looked at again.
     */
    private refreshGfx(gfx: { images: GameFile[]; models: GameFile[]; }, paths: Set<string>, changed: (e: Entity, isNew: boolean, name?: string) => void): void
    {
        for (const p of paths)
        {
            const e = this.imgByLc.get(p) ?? this.modelByLc.get(p);

            if (e)
                this.noteTouch(e);
        }

        const seen = new Set<Entity>();

        for (const m of gfx.models)
        {
            let e = this.modelByLc.get(m.rel.toLowerCase());

            if (!e)
            {
                e = this.entity(T_MODEL, m.rel, true)!;
                this.noteTouch(e);
                this.modelByLc.set(e.lname, e);
                changed(e, true);
            }
            else if (this.modelFile.get(e.id) !== m)
                this.noteTouch(e);

            this.modelFile.set(e.id, m);
            seen.add(e);
        }

        for (const [lc, e] of this.modelByLc)
        {
            if (seen.has(e))
                continue;

            this.killEntity(e);
            this.modelByLc.delete(lc);
            this.modelFile.delete(e.id);
            changed(e, false);
        }

        for (const img of gfx.images)
        {
            let e = this.imgByLc.get(img.rel.toLowerCase());

            if (!e)
            {
                e = this.entity(T_IMAGE, img.rel, true)!;
                this.noteTouch(e);
                this.imgByLc.set(e.lname, e);
                const base = imageBase(e.name);
                const list = this.imgByBase.get(base);

                if (list)
                    list.push(e);
                else
                    this.imgByBase.set(base, [e]);

                changed(e, true, base);
            }
            else if (this.imgFile.get(e.id) !== img)
                this.noteTouch(e);

            this.imgFile.set(e.id, img);
            seen.add(e);
        }

        for (const [lc, e] of this.imgByLc)
        {
            if (seen.has(e))
                continue;

            this.killEntity(e);
            this.imgByLc.delete(lc);
            this.imgFile.delete(e.id);
            const base = imageBase(e.name);
            const list = this.imgByBase.get(base)?.filter((x) => x !== e);

            if (list?.length)
                this.imgByBase.set(base, list);
            else
                this.imgByBase.delete(base);

            changed(e, false, base);
        }

        this.gfx = gfx;
        this.gfxPos = null;
    }

    /**
     * Removed references (tombstones: rFrom = -1) leave the columns once they are `compactShare` of them: the live ones
     * move down in order, so every list keeps its order with the new ids (the order a build creates them is their id
     * order within a file — refOrder, refsInBuildOrder). ~60 ms for vanilla's 1.2M references.
     */
    compactRefs(share = this.compactShare): boolean
    {
        const n = this.rFrom.length;

        if (!this.deadRefs || this.deadRefs < n * share)
            return false;

        const newId = new Int32Array(n);
        const cols = [this.rFrom, this.rTo, this.rFile, this.rLine, this.rOff, this.rLen, this.rCtx];
        let j = 0;

        for (let r = 0; r < n; r++)
        {
            if (this.rFrom[r] < 0)
            {
                newId[r] = -1;
                continue;
            }

            newId[r] = j;

            if (j !== r)
            {
                for (const c of cols)
                    c[j] = c[r];
            }

            j++;
        }

        for (const c of cols)
            c.length = j;

        // (the lists hold live references only: killRefs prunes them)
        for (const m of [this.outgoing, this.incoming, this.refsByFile])
        {
            for (const l of m.values())
                for (let i = 0; i < l.length; i++)
                    l[i] = newId[l[i]];
        }

        this.deadRefs = 0;
        return true;
    }

    /** share of tombstones in the reference columns that compacts them (compactRefs) */
    compactShare = 0.1;

    /** Takes references out (rFrom = -1) and out of the per-entity and per-file lists; returns their targets. */
    private killRefs(list: number[]): Set<number>
    {
        const from = new Set<number>();
        const to = new Set<number>();
        const files = new Set<number>();

        for (const r of list)
        {
            if (this.rFrom[r] < 0)
                continue;

            from.add(this.rFrom[r]);
            to.add(this.rTo[r]);

            if (this.rOff[r] >= 0)
                files.add(this.rFile[r]);

            this.rFrom[r] = -1;
            this.deadRefs++;
        }

        const prune = (m: Map<number, number[]>, k: number): void =>
        {
            const l = m.get(k)?.filter((r) => this.rFrom[r] >= 0);

            if (l?.length)
                m.set(k, l);
            else
                m.delete(k);
        };

        for (const k of from)
            prune(this.outgoing, k);

        for (const k of to)
            prune(this.incoming, k);

        for (const k of files)
            prune(this.refsByFile, k);

        return to;
    }

    /**
     * The order of a build's reference lists: script references by file (processing order), in each file as they were
     * found (ids are handed out file by file); localization references after them, by key in the order a build creates
     * the keys (their first definition's file and position).
     */
    private refOrder = (a: number, b: number): number =>
    {
        const la = this.rOff[a] < 0;
        const lb = this.rOff[b] < 0;

        if (la !== lb)
            return la ? 1 : -1;

        if (!la)
            return this.rank[this.rFile[a]] - this.rank[this.rFile[b]] || a - b;

        const fa = this.rFrom[a];
        const fb = this.rFrom[b];

        if (fa === fb)
            return a - b;

        const da = this.entities[fa].defs[0];
        const db = this.entities[fb].defs[0];
        return (da && db ? this.rank[da.file] - this.rank[db.file] || da.start - db.start : 0) || fa - fb;
    };

    /** References from `first` on (an update's) into the per-entity lists (merged in build order) and per-file lists. */
    private indexNewRefs(first: number): void
    {
        const group = (m: Map<number, number[]>, k: number, r: number): void =>
        {
            const l = m.get(k);

            if (l)
                l.push(r);
            else
                m.set(k, [r]);
        };
        const out = new Map<number, number[]>();
        const inc = new Map<number, number[]>();
        const byFile = new Map<number, number[]>();

        for (let r = first; r < this.rFrom.length; r++)
        {
            if (this.rFrom[r] < 0)
                continue;

            group(out, this.rFrom[r], r);
            group(inc, this.rTo[r], r);

            if (this.rOff[r] >= 0)
                group(byFile, this.rFile[r], r);
        }

        const merge = (old: number[] | undefined, add: number[]): number[] =>
        {
            add.sort(this.refOrder);

            if (!old?.length)
                return add;

            const res = new Array<number>(old.length + add.length);
            let i = 0;
            let j = 0;
            let k = 0;

            while (i < old.length && j < add.length)
                res[k++] = this.refOrder(old[i], add[j]) <= 0 ? old[i++] : add[j++];

            while (i < old.length)
                res[k++] = old[i++];

            while (j < add.length)
                res[k++] = add[j++];

            return res;
        };

        for (const [k, l] of out)
            this.outgoing.set(k, merge(this.outgoing.get(k), l));

        for (const [k, l] of inc)
            this.incoming.set(k, merge(this.incoming.get(k), l));

        for (const [k, l] of byFile)
            this.refsByFile.set(k, [...(this.refsByFile.get(k) ?? []), ...l].sort((a, b) => this.rOff[a] - this.rOff[b] || a - b));
    }

    /**
     * The order a build creates entries in (its ids; after updates new entries have later ones): models and images in
     * listing order, localization and script entries by their first definition (file processing order, position),
     * flags and variables by their first use. Valid once an update set `rank`.
     */
    private creationOrder(a: Entity, b: Entity): number
    {
        const phase = (e: Entity): number => (e.type === T_MODEL ? 0 : e.type === T_IMAGE ? 1 : e.type === T_FLAG || e.type === T_VARIABLE ? 3 : 2);
        const pa = phase(a);
        const pb = phase(b);

        if (pa !== pb)
            return pa - pb;

        if (pa < 2)
        {
            const g = this.gfxPositions();
            return (g.get(a.id) ?? 0) - (g.get(b.id) ?? 0) || a.id - b.id;
        }

        if (pa === 3)
        {
            const fa = this.incoming.get(a.id)?.[0];
            const fb = this.incoming.get(b.id)?.[0];
            return (fa !== undefined && fb !== undefined ? this.refOrder(fa, fb) : 0) || a.id - b.id;
        }

        const da = a.defs[0];
        const db = b.defs[0];
        return (da && db ? this.rank[da.file] - this.rank[db.file] || da.start - db.start : 0) || a.id - b.id;
    }

    private gfxPos: Map<number, number> | null = null;

    /** Position of image and model entries in the gfx listing (models first, as linkGfx creates them). */
    private gfxPositions(): Map<number, number>
    {
        if (!this.gfxPos)
        {
            const m = new Map<number, number>();
            let i = 0;

            for (const f of this.gfx.models)
            {
                const e = this.modelByLc.get(f.rel.toLowerCase());

                if (e)
                    m.set(e.id, i);

                i++;
            }

            for (const f of this.gfx.images)
            {
                const e = this.imgByLc.get(f.rel.toLowerCase());

                if (e)
                    m.set(e.id, i);

                i++;
            }

            this.gfxPos = m;
        }

        return this.gfxPos;
    }

    /**
     * What a build reads, through the layering of game and mods (a mod file of the same path replaces the game's).
     * Files a mod hid are appended after the loaded ones (so those keep the indices they have without mods).
     */
    private scanFiles(): void
    {
        const s = this.scanLists();
        this.files = s.files;
        this.typeDocs = s.typeDocs;
        this.gfx = s.gfx;
    }

    /** scanFiles' lists, not installed (an incremental update compares them with the index's). */
    private scanLists(): { files: FileInfo[]; typeDocs: Map<string, GameFile[]>; gfx: { images: GameFile[]; models: GameFile[]; }; }
    {
        const out = { files: [] as FileInfo[], typeDocs: new Map<string, GameFile[]>(), gfx: { images: [] as GameFile[], models: [] as GameFile[] } };
        const add = (gf: GameFile, area: FileInfo['area'], type?: string, hidden?: HiddenFile): void =>
        {
            const f: FileInfo = { rel: gf.rel, abs: gf.abs ?? this.vfs.where(gf), area, type, source: gf.source, gf };

            if (hidden)
                f.hidden = { by: hidden.by, how: hidden.how };

            out.files.push(f);
        };
        const hiddenFiles: { h: HiddenFile; area: FileInfo['area']; type?: string; }[] = [];
        const doc = (t: string, gf: GameFile): void =>
        {
            const list = out.typeDocs.get(t) ?? [];
            list.push(gf);
            out.typeDocs.set(t, list);
        };

        // common/<top>/…: one type per top folder, or per subfolder when the top folder has no files of its own
        // (hidden files count too, so a mod hiding a folder's own files doesn't change its types)
        const tops = new Map<string, { files: GameFile[]; hidden: HiddenFile[]; }>();
        const topOf = (rel: string): { files: GameFile[]; hidden: HiddenFile[]; } | undefined =>
        {
            const parts = rel.split('/');

            if (parts.length < 3)
                return undefined;

            const top = parts[1].toLowerCase();
            return tops.get(top) ?? tops.set(top, { files: [], hidden: [] }).get(top)!;
        };

        for (const f of this.vfs.list('common'))
            topOf(f.rel)?.files.push(f);

        for (const h of this.vfs.hidden('common', { ext: /\.txt$/i }))
            topOf(h.file.rel)?.hidden.push(h);

        const direct = (rel: string): boolean => rel.split('/').length === 3 && /\.txt$/i.test(rel);

        for (const { files, hidden } of tops.values())
        {
            const hasDirect = files.some((f) => direct(f.rel)) || hidden.some((h) => direct(h.file.rel));
            const typeOf = (rel: string): string =>
                commonTypeFor(
                    rel.split('/')
                        .slice(1, -1)
                        .join('/'),
                    hasDirect
                );

            for (const f of files)
            {
                if (/\.txt$/i.test(f.rel))
                    add(f, 'common', typeOf(f.rel));
                else if (/\.info$/i.test(f.rel))
                    doc(typeOf(f.rel), f);
            }

            for (const h of hidden)
                hiddenFiles.push({ h, area: 'common', type: typeOf(h.file.rel) });
        }

        for (const f of this.vfs.list('events'))
        {
            if (/\.info$/i.test(f.rel))
                doc(T_EVENT, f);
            else if (/\.txt$/i.test(f.rel))
                add(f, 'events');
        }

        for (const h of this.vfs.hidden('events', { ext: /\.txt$/i }))
            hiddenFiles.push({ h, area: 'events' });

        for (const f of this.vfs.list('history/characters', { ext: /\.txt$/i }))
            add(f, 'history/characters');

        for (const h of this.vfs.hidden('history/characters', { ext: /\.txt$/i }))
            hiddenFiles.push({ h, area: 'history/characters' });

        const charDoc = this.vfs.get('history/_characters.info');

        if (charDoc)
            doc(T_CHARACTER, charDoc);

        // replace/ folders load last so their keys win
        const locOrder = (a: string, b: string): number =>
        {
            const ra = /\/replace\//i.test(a) ? 1 : 0;
            const rb = /\/replace\//i.test(b) ? 1 : 0;
            return ra - rb || (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
        };
        // (the game also reads localization/replace/<language>/ — AGOT keeps its title names there)
        const locDirs = ['localization/' + this.language, 'localization/replace/' + this.language];
        const locFiles = locDirs.flatMap((d) => this.vfs.list(d, { ext: /\.yml$/i }));
        const locHidden = locDirs.flatMap((d) => this.vfs.hidden(d, { ext: /\.yml$/i }));

        for (const f of locFiles.sort((a, b) => locOrder(a.rel, b.rel)))
            add(f, 'localization');

        for (const h of locHidden.sort((a, b) => locOrder(a.file.rel, b.file.rel)))
            hiddenFiles.push({ h, area: 'localization' });

        for (const { h, area, type } of hiddenFiles)
            add(h.file, area, type, h);

        const gfx = this.vfs.list('gfx', { engine: true });
        out.gfx = { images: gfx.filter((f) => IMAGE_EXT.test(f.rel)), models: gfx.filter((f) => MODEL_EXT.test(f.rel)) };
        return out;
    }

    private entity(type: string, name: string, create: boolean): Entity | undefined
    {
        let m = this.byType.get(type);

        if (!m)
        {
            if (!create)
                return undefined;

            m = new Map();
            this.byType.set(type, m);
        }

        let e = m.get(name);

        if (!e && create)
        {
            name = detach(name);
            e = { id: this.entities.length, type, name, lname: name.toLowerCase(), defs: [] };
            this.entities.push(e);
            m.set(name, e);
            const list = this.byName.get(name);

            if (list)
                list.push(e);
            else
                this.byName.set(name, [e]);
        }

        return e;
    }

    /** Registers a localization file's keys (and, while not updating, their texts); returns its entries. */
    private indexLocFile(f: FileInfo, fileIdx: number, src = this.vfs.readText(f.gf)): LocEntry[]
    {
        if (src === undefined)
            return [];

        const { entries } = parseLocalization(src);

        for (const en of entries)
        {
            const e = this.entity(T_LOC, en.key, true)!;

            if (this.touchLog)
                this.noteTouch(e);

            e.defs.push({ file: fileIdx, line: en.line, start: en.off, end: en.off + en.key.length });

            // a hidden file's texts are not the game's; an update sets the winning texts afterwards
            if (!f.hidden && !this.touchLog)
                this.locText.set(e.name, detach(en.text));
        }

        if (!f.hidden)
            this.blooms[fileIdx] = locBloom(entries);

        return entries;
    }

    /**
     * Parses a script file: registers its definitions and collects the candidate references of a loaded file.
     * `refsOnly` (an update resolving an unchanged file again): the definitions are there already — only candidates.
     */
    private indexScriptFile(f: FileInfo, fileIdx: number, cands: CandidateTable, src = this.vfs.readText(f.gf), refsOnly = false): void
    {
        if (src === undefined)
            return;

        const ast = parse(src);
        const consts = new Map<string, string>();

        for (const n of ast)
            if (n.k && n.k.charCodeAt(0) === 64 && typeof n.v === 'string')
                consts.set(n.k.slice(1), n.v);

        const emitted: { e: Entity; d: DefEmit; }[] = [];
        const defNodes = new Set<PNode>();
        const nodeToEntity = new Map<PNode, Entity>();

        extractDefs(f.area, f.type ?? '', ast, (d) =>
        {
            if (d.name.includes('$'))
                return;

            defNodes.add(d.node);
            const e = this.entity(d.type, d.name, !refsOnly);

            if (!e)
                return;

            nodeToEntity.set(d.node, e);
            emitted.push({ e, d });

            if (refsOnly)
                return;

            const startNode = d.startNode ?? d.node;
            const def: Def = {
                file: fileIdx,
                line: startNode.line,
                start: startNode.s,
                end: d.node.e,
                doc: leadingComment(src, startNode.s)
            };

            if (d.local)
                def.local = true;

            const meta = extractMeta(d.type, d.node, consts);

            if (meta)
                def.meta = meta;

            if (this.touchLog)
                this.noteTouch(e);

            e.defs.push(def);
        });

        // a hidden file only records what it defined: the game never reads its references
        if (f.hidden)
            return;

        for (const { e, d } of emitted)
        {
            if (d.parent)
            {
                const parent = nodeToEntity.get(d.parent);

                if (parent)
                    cands.addDirect(e.id, parent.id, fileIdx, d.node.line, d.node.s, d.node.kl, this.ctx.id('(parent)'));
            }

            if (Array.isArray(d.node.v))
                collectCandidates(d.node.v, e.id, fileIdx, [], defNodes, cands, this.ctx, consts);
            else if (typeof d.node.v === 'string' && d.node.v)
            {
                cands.add(d.node.v, d.node.k, null, false, e.id, fileIdx, d.node.line, d.node.vs, d.node.e - d.node.vs, this.ctx.id(d.node.k ?? ''));
            }
        }
    }

    // -------------------------------------------------------------------------
    // Resolution
    // -------------------------------------------------------------------------

    private addRef(from: number, to: number, file: number, line: number, off: number, len: number, ctx: number): void
    {
        if (from === to)
            return;

        this.rFrom.push(from);
        this.rTo.push(to);
        this.rFile.push(file);
        this.rLine.push(line);
        this.rOff.push(off);
        this.rLen.push(len);
        this.rCtx.push(ctx);
    }

    private lookup(name: string, types: string[]): Entity[]
    {
        const out: Entity[] = [];

        for (const t of types)
        {
            const e = this.byType.get(t)?.get(name);

            if (e)
                out.push(e);
        }

        return out;
    }

    private genericLookup(name: string, rule: string[] | undefined): Entity[]
    {
        const all = this.byName.get(name);

        if (!all)
            return [];

        if (rule)
        {
            const pref = all.filter((e) => rule.includes(e.type));

            if (pref.length)
                return pref;
        }

        return all.filter((e) => !CONTEXT_ONLY_TYPES.has(e.type) && e.type !== T_LOC && e.type !== T_FLAG && e.type !== T_VARIABLE);
    }

    private resolvePrefixed(tok: string): Entity[]
    {
        const out: Entity[] = [];

        for (const seg of tok.split('.'))
        {
            const c = seg.indexOf(':');

            if (c <= 0)
                continue;

            const prefix = seg.slice(0, c);
            let name = seg.slice(c + 1);
            const paren = name.indexOf('(');

            if (paren >= 0)
                name = name.slice(0, paren);

            if (!name || name.includes('$'))
                continue;

            if (prefix === 'flag')
                out.push(this.entity(T_FLAG, name, true)!);
            else if (VARIABLE_PREFIXES.has(prefix))
                out.push(this.entity(T_VARIABLE, name, true)!);
            else if (prefix === 'scope')
                continue;
            else if (PREFIX_TYPES[prefix])
                out.push(...this.lookup(name, PREFIX_TYPES[prefix]));
            else
                out.push(...this.genericLookup(name, undefined));
        }

        return out;
    }

    resolveToken(tok: string, k1: string | null, k0: string | null, isKey: boolean, quoted: boolean, fromType = ''): Entity[]
    {
        if (tok.length < 2 || tok.includes('$') || tok.charCodeAt(0) === 64 /* @ */)
            return [];

        if (!isKey && IMAGE_EXT.test(tok))
        {
            const img = this.resolveImagePath(tok, fromType);
            return img ? [img] : [];
        }

        if (isKey)
        {
            if (tok.includes(':'))
                return this.resolvePrefixed(tok);

            const all = this.byName.get(tok);
            const callable = all ? all.filter((e) => CALLABLE_TYPES.has(e.type)) : [];

            if (callable.length)
                return callable;

            let m = /^(?:any|every|random|ordered)_(\w+)$/.exec(tok);

            if (m)
                return this.lookup(m[1], ['scripted_lists']);

            m = /^(?:has|set|remove)_relation_(\w+)$/.exec(tok);

            if (m)
                return this.lookup(m[1], ['scripted_relations']);

            return [];
        }

        if (STOP_WORDS.has(tok))
            return [];

        if (quoted && tok.includes(' '))
            return [];

        const rule = (k0 !== null && k1 !== null ? CONTEXT_RULES[`${k0}.${k1}`] : undefined) ?? (k1 !== null ? CONTEXT_RULES[k1] : undefined);

        if (NUMERIC.test(tok))
        {
            if (!rule)
                return [];

            return this.lookup(tok, rule.filter((t) => NUMERIC_TYPES.has(t)));
        }

        if (isFlagKey(k1) || (k1 === 'flag' && isFlagKey(k0)))
            return [this.entity(T_FLAG, tok, true)!];

        if (isVariableKey(k1) || ((k1 === 'name' || k1 === 'variable') && isVariableKey(k0)) || k1 === 'variable')
        {
            if (!tok.includes(':'))
                return [this.entity(T_VARIABLE, tok, true)!];
        }

        if (tok.includes(':'))
        {
            // "court_position:x.aptitude(y)" style strings can also contain further lookups
            return this.resolvePrefixed(tok);
        }

        const found = this.genericLookup(tok, rule);

        if (found.length)
            return found;

        // Only link to localization where a loc key is plausible, otherwise plain values like
        // `has_dlc_feature = royal_court` would link to the unrelated loc key "royal_court".
        if (!(LOC_CONTEXT.test(k1 ?? '') || LOC_LIKE_TOKEN.test(tok)))
            return [];

        const loc = this.byType.get(T_LOC)?.get(tok);
        return loc ? [loc] : [];
    }

    /**
     * Resolves the candidates into references, and builds each script file's name filter on the way (candidates are
     * contiguous per file; the tokens are still in cache — a separate pass cost ~1.2 s of a vanilla build).
     */
    private resolveCandidates(c: CandidateTable, progress: (done: number) => void): void
    {
        const names: string[] = [];
        // (each distinct token of a file is looked at once — as a key, as a value)
        const keys = new Set<string>();
        const values = new Set<string>();
        let file = -1;
        let words: Uint32Array = new Uint32Array(0);
        let any = false;

        for (let i = 0; i < c.size; i++)
        {
            if (c.file[i] !== file)
            {
                if (file >= 0)
                    this.blooms[file] = any ? words : undefined;

                file = c.file[i];
                let end = i;

                while (end < c.size && c.file[end] === file)
                    end++;

                words = newBloom(end - i);
                any = false;
                keys.clear();
                values.clear();
            }

            if (c.direct[i] >= 0)
            {
                this.addRef(c.from[i], c.direct[i], c.file[i], c.line[i], c.off[i], c.len[i], c.ctx[i]);
                continue;
            }

            const tok = c.tok[i];
            const isKey = c.isKey[i] === 1;
            const targets = this.preferLive(this.resolveToken(tok, c.k1[i], c.k0[i], isKey, c.quoted[i] === 1, this.entities[c.from[i]].type));

            for (const t of targets)
                this.addRef(c.from[i], t.id, c.file[i], c.line[i], c.off[i], c.len[i], c.ctx[i]);

            const seen = isKey ? keys : values;

            if (!seen.has(tok))
            {
                names.length = 0;

                // (numbers depend on their context: looked at each time, and only remembered once they matter)
                if (this.lookupNames(tok, c.k1[i], c.k0[i], isKey, c.quoted[i] === 1, names))
                    seen.add(tok);

                for (const n of names)
                    bloomAdd(words, n);

                if (names.length)
                    any = true;
            }

            if (i % 200000 === 0)
                progress(i);
        }

        if (file >= 0)
            this.blooms[file] = any ? words : undefined;
    }

    private resolveLocRefs(): void
    {
        const locType = this.byType.get(T_LOC);

        if (!locType)
            return;

        for (const c of ['$…$ in text', '[concept] in text', "('…') in text"])
            this.ctx.id(c);

        for (const e of locType.values())
            this.addLocRefs(e);
    }

    /** References in a localization key's text: `$key$` → loc keys, `[concept|E]` → game concepts, `'arg'` → anything. */
    private addLocRefs(e: Entity): void
    {
        const text = this.locText.get(e.name);

        if (!text)
            return;

        const refs = extractLocRefs(text);

        if (!refs.loc.length && !refs.concepts.length && !refs.args.length)
            return;

        // (a text only comes from a loaded file)
        const d = this.winningDef(e)!;
        const locType = this.byType.get(T_LOC);

        for (const k of refs.loc)
        {
            const t = locType?.get(k);

            if (t)
                this.addRef(e.id, t.id, d.file, d.line, -1, 0, this.ctx.id('$…$ in text'));
        }

        for (const k of refs.concepts)
        {
            const t = this.byType.get('game_concepts')?.get(k);

            if (t)
                this.addRef(e.id, t.id, d.file, d.line, -1, 0, this.ctx.id('[concept] in text'));
        }

        for (const k of refs.args)
        {
            const all = this.byName.get(k);

            if (all)
            {
                for (const t of this.preferLive(all))
                    if (t.type !== T_LOC)
                        this.addRef(e.id, t.id, d.file, d.line, -1, 0, this.ctx.id("('…') in text"));
            }
        }
    }

    /**
     * The names resolveToken looks up in the entity tables for a token (the entries whose existence decides what it
     * resolves to) — mirrors its rules. Images: the lower case file name without extension.
     */
    private lookupNames(tok: string, k1: string | null, k0: string | null, isKey: boolean, quoted: boolean, out: string[]): boolean
    {
        // (cheap character tests before any regex; a value in a flag or variable context — created from its uses, nothing
        // looked up — is taken like any other: the filter may hold a few names more, never fewer)
        const n = tok.length;
        const c0 = tok.charCodeAt(0);

        if (n < 2 || c0 === 64 /* @ */ || tok.includes('$'))
            return true;

        if (isKey)
        {
            if (tok.includes(':'))
                prefixedNames(tok, out);
            else
            {
                out.push(tok);
                // any_/every_/random_/ordered_<scripted list>, has_/set_/remove_relation_<scripted relation>
                const m = (c0 === 97 || c0 === 101 || c0 === 114 || c0 === 111 ? LIST_KEY.exec(tok) : null) ?? (tok.includes('_relation_') ? RELATION_KEY.exec(tok) : null);

                if (m)
                    out.push(m[1]);
            }

            return true;
        }

        if (n > 4 && tok.charCodeAt(n - 4) === 46 /* . */ && IMAGE_EXT.test(tok))
        {
            out.push(imageBase(tok));
            return true;
        }

        // (quoted: a token with a space is always quoted)
        if (STOP_WORDS.has(tok) || (quoted && tok.includes(' ')))
            return true;

        if (((c0 >= 48 && c0 <= 57) || c0 === 45) && NUMERIC.test(tok))
        {
            // numbers only name something where a context rule allows numeric types (father = 123): per occurrence
            const rule = (k0 !== null && k1 !== null ? CONTEXT_RULES[`${k0}.${k1}`] : undefined) ?? (k1 !== null ? CONTEXT_RULES[k1] : undefined);

            if (!rule?.some((t) => NUMERIC_TYPES.has(t)))
                return false;

            out.push(tok);
            return true;
        }

        if (tok.includes(':'))
            prefixedNames(tok, out);
        else
            out.push(tok);

        return true;
    }

    private buildRefIndexes(): void
    {
        const push = (m: Map<number, number[]>, k: number, v: number): void =>
        {
            const l = m.get(k);

            if (l)
                l.push(v);
            else
                m.set(k, [v]);
        };

        for (let i = 0; i < this.rFrom.length; i++)
        {
            push(this.outgoing, this.rFrom[i], i);
            push(this.incoming, this.rTo[i], i);

            if (this.rOff[i] >= 0)
                push(this.refsByFile, this.rFile[i], i);
        }

        for (const l of this.refsByFile.values())
            l.sort((a, b) => this.rOff[a] - this.rOff[b]);
    }

    // -------------------------------------------------------------------------
    // Accessors used by the describer (src/main/describe)
    // -------------------------------------------------------------------------

    get(type: string, name: string): Entity | undefined
    {
        return this.byType.get(type)?.get(name);
    }

    /** A definition in a file a mod hid: kept to show what the mod replaced or removed, never live game data. */
    isHiddenDef(d: Def): boolean
    {
        return this.files[d.file].hidden !== undefined;
    }

    /**
     * Index of the definition the game uses: the last one outside hidden files (those are registered first, so this
     * is the last definition unless a mod removed the entry). -1: only hidden definitions — the entry is removed.
     */
    winningIdx(e: Entity): number
    {
        let path = -1;

        for (let i = e.defs.length - 1; i >= 0; i--)
        {
            const d = e.defs[i];

            if (this.files[d.file].hidden)
                continue;

            // (a landed title written only as the way to one inside it changes nothing: the one before it wins —
            // unless it is all there is)
            if (d.meta?.path)
            {
                if (path < 0)
                    path = i;

                continue;
            }

            return i;
        }

        return path;
    }

    winningDef(e: Entity): Def | undefined
    {
        const i = this.winningIdx(e);
        return i < 0 ? undefined : e.defs[i];
    }

    /** The definitions the game loads (without those in files a mod hid). */
    liveDefs(e: Entity): Def[]
    {
        return e.defs.filter((d) => !this.files[d.file].hidden);
    }

    /** A mod removed the entry: it has definitions, all in hidden files. Such entries are listed, but not game data. */
    isRemoved(e: Entity): boolean
    {
        return e.defs.length > 0 && this.winningIdx(e) < 0;
    }

    /** The winning definition, or a removed entry's last one — for names, icons and file labels only. */
    private shownDef(e: Entity): Def | undefined
    {
        return this.winningDef(e) ?? e.defs[e.defs.length - 1];
    }

    /** All entities with this name, excluding localization/flags/variables; entries a mod removed last. */
    named(name: string): Entity[]
    {
        const all = (this.byName.get(name) ?? []).filter((e) => e.type !== T_LOC && e.type !== T_FLAG && e.type !== T_VARIABLE);

        if (all.length < 2)
            return all;

        const live = this.preferLive(all);
        return live === all ? all : [...live, ...all.filter((e) => !live.includes(e))];
    }

    /**
     * Several matches for a name: entries a mod removed only count when nothing loaded matches (they are registered
     * first, from the hidden files, and would otherwise turn plain references ambiguous).
     */
    private preferLive(list: Entity[]): Entity[]
    {
        if (list.length < 2)
            return list;

        const live = list.filter((e) => !this.isRemoved(e));
        return live.length && live.length < list.length ? live : list;
    }

    locRaw(key: string): string | undefined
    {
        return this.locText.get(key);
    }

    private astCache = new Map<string, { node: PNode; src: string; }>();

    /**
     * Parses one definition (the winning one by default — none for an entry a mod removed). `args` substitutes $PARAM$
     * placeholders in the source text first, which is exactly how the game expands scripted effects/triggers.
     */
    defNode(e: Entity, args?: Record<string, string>, defIdx = this.winningIdx(e)): { node: PNode; src: string; } | undefined
    {
        const d = e.defs[defIdx];

        if (!d)
            return undefined;

        const cacheKey = d.file + ':' + d.start + (args ? JSON.stringify(args) : '');
        const hit = this.astCache.get(cacheKey);

        if (hit)
            return hit;

        let src = this.readFile(d.file).slice(d.start, d.end);

        if (args)
            src = src.replace(/\$(\w+)\$/g, (m, k: string) => args[k] ?? m);

        const ast = parse(src);
        let node: PNode | undefined;

        for (let i = ast.length - 1; i >= 0; i--)
        {
            if (ast[i].k !== null)
            {
                node = ast[i];
                break;
            }
        }

        if (!node)
            return undefined;

        const res = { node, src };
        this.astCache.set(cacheKey, res);

        if (this.astCache.size > 400)
            this.astCache.delete(this.astCache.keys().next().value!);

        return res;
    }

    private hashes = new Map<number, string>();

    /**
     * Where a definition is written, for line anchors (Line.src, docs/mods.md "Editing in place"): its file, the mod the
     * file belongs to, the checksum of the text defNode reads, and the definition's start (offset and line) — node
     * offsets of defNode are relative to it.
     */
    defAnchor(e: Entity, defIdx = this.winningIdx(e), withText = false): DefAnchor | undefined
    {
        const d = e.defs[defIdx];

        if (!d)
            return undefined;

        const f = this.files[d.file];
        // (the game's files are never edited in place: no checksum needed)
        let hash = f.source ? this.hashes.get(d.file) : '';

        if (hash === undefined)
            this.hashes.set(d.file, hash = textHash(this.readFile(d.file)));

        const a: DefAnchor = { file: f.abs, rel: f.rel, hash, start: d.start, line: d.line, end: d.end };

        if (f.source)
            a.mod = this.vfs.sources[f.source].modId;

        if (f.source || withText)
            a.text = this.readFile(d.file);

        return a;
    }

    /**
     * A localization key's line as a line anchor (docs/mods.md "Editing in place": the Source tab's editor, the key's
     * card): [s, e) from the key to the line's end (its text and a comment after it), in the file's text as read.
     */
    locAnchor(e: Entity, defIdx = this.winningIdx(e)): LineSource | undefined
    {
        const a = this.defAnchor(e, defIdx, true);

        if (!a?.text)
            return undefined;

        let end = a.text.indexOf('\n', a.start);

        if (end < 0)
            end = a.text.length;

        if (a.text.charCodeAt(end - 1) === 13)
            end--;

        const src: LineSource = { file: a.file, rel: a.rel, line: a.line, s: a.start, e: end, kind: 'other', hash: a.hash };

        if (a.mod)
        {
            src.mod = a.mod;
            src.stmt = stmtCheck(a.text, a.start, end);
        }

        return src;
    }

    /** The background an event shows (its override_background, else its theme's), with that background's environment. */
    eventBackground(e: Entity): { ref?: string; environment?: string; }
    {
        const meta = this.winningDef(e)?.meta;
        const theme = meta?.theme ? this.get('event_themes', meta.theme) : undefined;
        const ref = meta?.bgRef ?? (theme && this.winningDef(theme)?.meta?.bgRef);
        const bg = ref ? this.get('event_backgrounds', ref) : undefined;
        const d = bg && this.defNode(bg);
        const env = d ? /environment\s*=\s*"?([\w.-]+)"?/.exec(d.src)?.[1] : undefined;
        return { ref, environment: env };
    }

    private portraitOpts?: PortraitOptions;

    /**
     * What an event portrait can be set to (the "Who's who" portrait settings): the animations of
     * gfx/portraits/portrait_animations (grouped by their files' section banners — "Emotion Animations" …), the event
     * cameras of gfx/portraits/cameras, the scripted animations, and the outfit tags events use — each with how often
     * the game's events use it (a scan of the event files, once).
     */
    portraitOptions(): PortraitOptions
    {
        if (this.portraitOpts)
            return this.portraitOpts;

        const uses = { animation: new Map<string, number>(), camera: new Map<string, number>(), outfit: new Map<string, number>(), scripted: new Map<string, number>() };
        const inc = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
        this.files.forEach((f, i) =>
        {
            if (f.area !== 'events' || f.hidden || f.gone)
                return;

            const t = this.readFile(i);

            for (const m of t.matchAll(/\banimation\s*=\s*(\w+)/g))
                inc(uses.animation, m[1]);

            for (const m of t.matchAll(/\bcamera\s*=\s*(\w+)/g))
                inc(uses.camera, m[1]);

            for (const m of t.matchAll(/\bscripted_animation\s*=\s*(\w+)/g))
                inc(uses.scripted, m[1]);

            for (const m of t.matchAll(/\boutfit_tags\s*=\s*\{([^}]*)\}/g))
                for (const w of m[1].split(/\s+/))
                    if (/^\w+$/.test(w))
                        inc(uses.outfit, w);
        });
        const animations: PortraitOptions['animations'] = [];

        for (const gf of this.vfs.list('gfx/portraits/portrait_animations', { engine: true }))
        {
            if (!/\.txt$/i.test(gf.rel))
                continue;

            for (const m of (this.vfs.readText(gf, { engine: true }) ?? '').matchAll(/^([a-z_0-9]+)\s*=\s*\{/gm))
                if (!animations.some((a) => a.name === m[1]))
                    animations.push({ name: m[1], group: animationGroup(m[1]), uses: uses.animation.get(m[1]) ?? 0 });
        }

        const cameras: PortraitOptions['cameras'] = [];

        for (const gf of this.vfs.list('gfx/portraits/cameras', { engine: true }))
        {
            if (!/portrait_cameras.*\.txt$/i.test(gf.rel))
                continue;

            for (const m of (this.vfs.readText(gf, { engine: true }) ?? '').matchAll(/^\s*(camera_\w+)\s*=\s*\{/gm))
                if (!cameras.some((c) => c.name === m[1]))
                    cameras.push({ name: m[1], uses: uses.camera.get(m[1]) ?? 0 });
        }

        const byUse = <T extends { uses: number; name: string; }>(l: T[]): T[] => l.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
        const scripted = this.names('scripted_animations').map((name) => ({ name, uses: uses.scripted.get(name) ?? 0 }));
        const outfits = [...uses.outfit].map(([name, n]) => ({ name, uses: n }));
        return (this.portraitOpts = { animations: byUse(animations), cameras: byUse(cameras), scripted: byUse(scripted), outfits: byUse(outfits) });
    }

    /** Every event background with its picture and lighting (the event card's "Change scene…"). */
    eventBackgroundList(): EventBackgroundInfo[]
    {
        const out: EventBackgroundInfo[] = [];

        for (const e of this.byType.get('event_backgrounds')?.values() ?? [])
        {
            if (e.dead || this.isRemoved(e))
                continue;

            const im = this.imagesOf(e);
            const d = this.defNode(e);
            const item: EventBackgroundInfo = {
                name: e.name,
                image: (im.illu ?? im.icon)?.name,
                environment: d ? /environment\s*=\s*"?([\w.-]+)"?/.exec(d.src)?.[1] : undefined,
                refs: this.incoming.get(e.id)?.length ?? 0
            };
            const mod = this.modTouch(e);

            if (mod)
                item.mod = mod;

            out.push(item);
        }

        return out;
    }

    /** A localization key: its text as written, where its winning line is, the mod that has it (editing in place). */
    locEntry(key: string): { key: string; text?: string; rel?: string; abs?: string; line?: number; mod?: string; } | null
    {
        const e = this.get(T_LOC, key);
        const d = e && this.winningDef(e);

        if (!d)
            return { key };

        const f = this.files[d.file];
        return { key, text: this.locRaw(key), rel: f.rel, abs: f.abs, line: d.line, mod: f.source ? this.vfs.sources[f.source].modId : undefined };
    }

    /**
     * Where a new entry of a type goes (docs/mods.md, "New entries"): the folder its definitions are in (most of the
     * game's), whether they are top-level definitions there (nested ones — faiths in religions — need their holder); for
     * events with a namespace, its first free id (`<ns>.0001` …). Null for what is no script definition (images, models,
     * localization, flags, variables).
     */
    newEntryInfo(type: string, ns?: string): { folder?: string; nested: boolean; label: string; count: number; freeId?: string; example?: NestedExample; } | null
    {
        if ([T_LOC, T_FLAG, T_VARIABLE, T_IMAGE, T_MODEL].includes(type))
            return null;

        const names = this.names(type);
        const folders: string[][] = [];
        let nested = 0;
        let top = 0;
        // (a nested one: where it sits — the definition holding it, its type, the file and line)
        let example: NestedExample | undefined;
        // (samples spread over the list: its start is often one sub-folder — events/activities)
        const step = Math.max(1, Math.floor(names.length / 40));

        for (let i = 0; i < names.length && folders.length < 40; i += step)
        {
            const e = this.get(type, names[i]);
            const d = e && this.winningDef(e);

            if (!d)
                continue;

            const f = this.files[d.file];
            folders.push(f.rel.split('/').slice(0, -1));

            if (top + nested < 4)
            {
                const ast = parse(this.readFile(d.file));

                if (ast.some((n) => n.s === d.start))
                    top++;
                else
                {
                    nested++;
                    const holder = ast.find((n) => n.s < d.start && n.e > d.start);

                    if (!example && holder?.k)
                    {
                        const h = (this.byName.get(holder.k) ?? []).find((c) => c.defs.some((x) => x.file === d.file && x.start === holder.s));
                        // (the blocks between the holder and the entry)
                        const within: string[] = [];
                        let at: PNode = holder;

                        for (;;)
                        {
                            const next: PNode | undefined = Array.isArray(at.v) ? at.v.find((n) => n.s <= d.start && n.e > d.start) : undefined;

                            if (!next || next.s === d.start)
                                break;

                            within.push(next.k ?? '');
                            at = next;
                        }

                        example = { name: names[i], holder: holder.k, holderType: h?.type, holderLabel: h ? typeLabel(h.type) : undefined, within, rel: f.rel, line: holder.line };
                    }
                }
            }
        }

        // the folder all its files are below (events/activities and events/court_events → events)
        let common = folders[0] ?? [];

        for (const f of folders)
        {
            let k = 0;

            while (k < common.length && k < f.length && common[k] === f[k])
                k++;

            common = common.slice(0, k);
        }

        const folder = common.length > 1 || (common.length === 1 && common[0] !== 'common') ? common.join('/') : type === T_EVENT ? 'events' : `common/${type}`;
        let freeId: string | undefined;

        if (type === T_EVENT && ns)
        {
            for (let n = 1; n < 10000 && !freeId; n++)
            {
                const id = `${ns}.${String(n).padStart(4, '0')}`;

                if (!this.get(type, id))
                    freeId = id;
            }
        }

        return { folder, nested: nested > 0 && top === 0, label: typeLabel(type), count: names.length, freeId, ...(example ? { example } : {}) };
    }

    /** The entries of `type` written inside the holder's winning definition (a law group's laws, a religion's faiths). */
    /** How the loaded game lays out what changed between versions (layouts.ts) — mods/create.ts writes the same way. */
    layouts(): { doctrinesNameTheirGroup: boolean; }
    {
        return { doctrinesNameTheirGroup: doctrinesNameTheirGroup(this) };
    }

    childrenOf(type: string, holderType: string, holder: string): string[]
    {
        const h = this.get(holderType, holder);
        const hd = h && this.winningDef(h);

        if (!hd)
            return [];

        return this.names(type).filter((n) =>
        {
            const e = this.get(type, n);
            const d = e && this.winningDef(e);
            return !!d && d.file === hd.file && d.start > hd.start && d.start < hd.end;
        });
    }

    /** Entities referencing `e`, with the contexts of those references. */
    incomingSources(e: Entity): { entity: Entity; contexts: string[]; count: number; }[]
    {
        const m = new Map<number, { entity: Entity; contexts: Set<string>; count: number; }>();

        for (const r of this.incoming.get(e.id) ?? [])
        {
            const from = this.rFrom[r];
            let g = m.get(from);

            if (!g)
                m.set(from, g = { entity: this.entities[from], contexts: new Set(), count: 0 });

            g.contexts.add(this.ctx.list[this.rCtx[r]]);
            g.count++;
        }

        return [...m.values()].map((g) => ({ entity: g.entity, contexts: [...g.contexts], count: g.count }));
    }

    /** The mods whose files hold references from `from` to `to` (their ids; the game's files are not listed). */
    refMods(from: Entity, to: Entity): string[]
    {
        const out = new Set<string>();

        for (const r of this.incoming.get(to.id) ?? [])
        {
            if (this.rFrom[r] !== from.id)
                continue;

            const f = this.files[this.rFile[r]];
            const id = f && !f.hidden && f.source ? this.vfs.sources[f.source].modId : undefined;

            if (id)
                out.add(id);
        }

        return [...out];
    }

    fileRel(idx: number): string
    {
        return this.files[idx].rel;
    }

    private constCache = new Map<number, Map<string, string>>();

    /** File-level `@name = value` constants of the file an entity is defined in. */
    fileConstants(e: Entity): Map<string, string>
    {
        const d = this.winningDef(e);

        if (!d)
            return new Map();

        let m = this.constCache.get(d.file);

        if (!m)
        {
            m = new Map();
            const re = /^\s*@(\w+)\s*=\s*"?([^\s"#]+)"?/gm;
            const src = this.readFile(d.file);

            for (let x = re.exec(src); x; x = re.exec(src))
                m.set(x[1], x[2]);

            this.constCache.set(d.file, m);
        }

        return m;
    }

    // -------------------------------------------------------------------------
    // Images
    // -------------------------------------------------------------------------

    /** Words of a type id used to pick the right folder for an icon name (`casus_belli_types` → casus, belli). */
    private typeTokens(type: string): string[]
    {
        let t = this.typeTokenCache.get(type);

        if (!t)
        {
            const set = new Set<string>();

            for (const w of type.split(/[/_]/))
            {
                if (!w || GENERIC_PATH_WORDS.has(w))
                    continue;

                set.add(w);
                set.add(w.replace(/ies$/, 'y'));
                set.add(w.replace(/s$/, ''));
            }

            t = [...set];
            this.typeTokenCache.set(type, t);
        }

        return t;
    }

    private scorePath(lcRel: string, tokens: string[]): number
    {
        const segs = lcRel.slice(0, lcRel.lastIndexOf('/')).split(/[/_]/);
        let score = 0;

        for (const t of tokens)
            if (segs.some((s) => s === t || (s.length >= 4 && (s.startsWith(t) || t.startsWith(s)))))
                score++;

        return score;
    }

    /** Image by path as written in script (full path, or a bare file name resolved by folder heuristics). */
    resolveImagePath(token: string, type: string): Entity | undefined
    {
        const lc = token.replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .toLowerCase();
        const direct = this.imgByLc.get(lc) ?? (lc.startsWith('gfx/') ? undefined : this.imgByLc.get('gfx/' + lc));

        if (direct)
            return direct;

        const base = lc.slice(lc.lastIndexOf('/') + 1).replace(IMAGE_EXT, '');
        return this.resolveImageName(base, type, false);
    }

    /** An image by its exact path (`gfx/interface/icons/faith/catholic.dds`); undefined when no loaded file has it. */
    imageAt(path: string): Entity | undefined
    {
        return this.imgByLc.get(
            path.replace(/\\/g, '/')
                .replace(/^\/+/, '')
                .toLowerCase()
        );
    }

    /** The images right in a folder (`gfx/interface/icons/faith`): their paths as written. */
    imagesIn(folder: string): string[]
    {
        const pre = folder.replace(/\\/g, '/')
            .replace(/\/+$/, '')
            .toLowerCase() + '/';
        const out: string[] = [];

        for (const [lc, e] of this.imgByLc)
            if (lc.startsWith(pre) && !lc.includes('/', pre.length))
                out.push(e.name);

        return out.sort();
    }

    /** Image by base name (`icon = health_negative`). `strict` requires a folder that matches the type. */
    resolveImageName(name: string, type: string, strict: boolean): Entity | undefined
    {
        const cands = this.imgByBase.get(name.toLowerCase());

        if (!cands)
            return undefined;

        const tokens = this.typeTokens(type);
        let best: Entity | undefined;
        let bestScore = -1;

        for (const c of cands)
        {
            let sc = this.scorePath(c.lname, tokens);

            if (c.lname.includes('/icons/'))
                sc += 0.25;

            if (sc > bestScore)
            {
                best = c;
                bestScore = sc;
            }
        }

        if (strict && bestScore < 1)
            return undefined;

        return best;
    }

    /** Icon and illustration of an entity (see docs/images.md for the rules). */
    imagesOf(e: Entity): { icon?: Entity; illu?: Entity; }
    {
        const hit = this.imageCache.get(e.id);

        if (hit)
            return hit;

        const res: { icon?: Entity; illu?: Entity; } = {};
        this.imageCache.set(e.id, res); // guards recursion

        if (e.type === T_IMAGE)
        {
            res.icon = e;
            return res;
        }

        if (e.type === T_LOC || e.type === T_FLAG || e.type === T_VARIABLE || e.type === T_CHARACTER || e.type === T_MODEL)
            return res;

        // an entry a mod removed keeps its old icon (recognizable in lists); what it refers to must still exist
        const meta = this.shownDef(e)?.meta;

        if (meta?.icon)
            res.icon = this.resolveImagePath(meta.icon, e.type);

        if (!res.icon && meta?.iconName)
            res.icon = this.resolveImageName(meta.iconName, e.type, false);

        if (!res.icon)
        {
            const byName = this.resolveImageName(e.name, e.type, true);

            if (byName?.lname.includes('/icons/'))
                res.icon = byName;
        }

        if (meta?.illu)
            res.illu = this.resolveImagePath(meta.illu, e.type);

        if (e.type === T_EVENT || e.type === 'event_themes')
        {
            const theme = meta?.theme ? this.get('event_themes', meta.theme) : undefined;
            const bgRef = meta?.bgRef ?? (theme && this.winningDef(theme)?.meta?.bgRef);

            if (bgRef && !res.illu)
            {
                const bg = this.get('event_backgrounds', bgRef);
                const bm = bg && this.winningDef(bg)?.meta;

                if (bm?.illu)
                    res.illu = this.resolveImagePath(bm.illu, 'event_backgrounds');
            }

            if (theme && !this.isRemoved(theme) && (!res.icon || !res.illu))
            {
                const t = this.imagesOf(theme);
                res.icon ??= t.icon;
                res.illu ??= t.illu;
            }
        }

        if (e.type === 'event_backgrounds' && !res.illu && res.icon)
            res.illu = res.icon;

        return res;
    }

    /** Disk path of an image (undefined inside a packed mod — read those through vfs). */
    imageAbsPath(e: Entity): string | undefined
    {
        return this.imgFile.get(e.id)?.abs;
    }

    /** A gfx file (image or model) by its game path, as the layering provides it. */
    gfxFile(rel: string): GameFile | undefined
    {
        const lc = rel.replace(/\\/g, '/').toLowerCase();
        const img = this.imgByLc.get(lc);

        if (img)
            return this.imgFile.get(img.id);

        const model = this.modelByLc.get(lc);
        return model ? this.modelFile.get(model.id) : undefined;
    }

    /** Disk path of a gfx file by its game path (undefined inside a packed mod — use gfxFile + vfs). */
    gfxAbsPath(rel: string): string | undefined
    {
        return this.gfxFile(rel)?.abs;
    }

    /** Model file entity by game path (any case). */
    modelByPath(rel: string): Entity | undefined
    {
        return this.modelByLc.get(rel.replace(/\\/g, '/').toLowerCase());
    }

    /**
     * Texture referenced by a model: a game path, a path relative to one of `dirs` (the asset's or mesh's folder), or —
     * like the engine, which also finds shared atlases elsewhere — any image with that file name, the one sharing the
     * longest folder prefix with `dirs[0]` preferred.
     */
    findTexture(ref: string, dirs: string[]): Entity | undefined
    {
        const n = ref.replace(/\\/g, '/').replace(/^\/+/, '');
        const lc = n.toLowerCase();

        if (lc.startsWith('gfx/'))
        {
            const e = this.imgByLc.get(lc);

            if (e)
                return e;
        }

        for (const d of dirs)
        {
            const e = this.imgByLc.get((d.endsWith('/') ? d : d + '/').toLowerCase() + lc);

            if (e)
                return e;
        }

        const cands = this.imgByBase.get(lc.slice(lc.lastIndexOf('/') + 1).replace(IMAGE_EXT, ''));

        if (!cands?.length)
            return undefined;

        const near = (dirs[0] ?? '').toLowerCase();
        let best = cands[0];
        let bestLen = -1;

        for (const c of cands)
        {
            let i = 0;

            while (i < near.length && i < c.lname.length && near[i] === c.lname[i])
                i++;

            if (i > bestLen)
            {
                best = c;
                bestLen = i;
            }
        }

        return best;
    }

    /** Entities that use `img` as their icon or illustration (built once, on demand). */
    imageUsers(img: Entity): Entity[]
    {
        if (!this.iconUsers)
        {
            const m = new Map<number, Entity[]>();

            // (in creation order: the users list in the order a build has them)
            for (const e of this.entitiesInBuildOrder((x) => !x.dead))
            {
                if (e.type === T_IMAGE || e.type === T_MODEL || e.type === T_LOC || e.type === T_FLAG || e.type === T_VARIABLE || e.type === T_CHARACTER)
                    continue;

                if (this.isRemoved(e))
                    continue;

                const r = this.imagesOf(e);

                for (const i of [r.icon, r.illu])
                {
                    if (!i)
                        continue;

                    const l = m.get(i.id);

                    if (l)
                    {
                        if (!l.includes(e))
                            l.push(e);
                    }
                    else
                        m.set(i.id, [e]);
                }
            }

            this.iconUsers = m;
        }

        return this.iconUsers.get(img.id) ?? [];
    }

    /** DDS/PNG header facts for the image card. */
    imageHeader(e: Entity): { width?: number; height?: number; format?: string; mips?: number; bytes?: number; }
    {
        const gf = this.imgFile.get(e.id);

        if (!gf)
            return {};

        try
        {
            let bytes: number;
            let head: Buffer = Buffer.alloc(148);

            if (gf.abs)
            {
                bytes = statSync(gf.abs).size;
                const fd = openSync(gf.abs, 'r');

                try
                {
                    readSync(fd, head, 0, 148, 0);
                }
                finally
                {
                    closeSync(fd);
                }
            }
            else
            {
                const all = this.vfs.read(gf);

                if (!all)
                    return {};

                bytes = all.length;
                head = all.subarray(0, 148);
            }

            if (head.toString('latin1', 0, 4) === 'DDS ')
            {
                const i = parseDds(head);
                return { width: i.width, height: i.height, format: formatLabel(i), mips: i.mips, bytes };
            }

            if (head.readUInt32BE(0) === 0x89504e47)
                return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), format: 'PNG', bytes };

            return { bytes, format: 'TGA' };
        }
        catch
        {
            return {};
        }
    }

    private gfxFileOf(type: string, e: Entity): GameFile | undefined
    {
        return (type === T_IMAGE ? this.imgFile : this.modelFile).get(e.id);
    }

    /**
     * Folders of a file-based type (images, models) with their file counts (`modCount`: files from mods; `removed`:
     * pictures a mod's replace_path removed — a folder with only those is listed too).
     */
    fileFolders(type: string): GalleryFolder[]
    {
        const m = new Map<string, GalleryFolder>();

        for (const e of this.byType.get(type)?.values() ?? [])
        {
            const folder = e.name.slice(0, e.name.lastIndexOf('/'));
            let f = m.get(folder);

            if (!f)
                m.set(folder, f = { folder, count: 0 });

            f.count++;
            // (a file from a mod: added, or overridden — it replaced the game's; conflicts: two or more mods had it)
            const t = this.modTouch(e);

            if (!t)
                continue;

            f.modCount = (f.modCount ?? 0) + 1;
            const s = (f.modStates ??= {});
            s[t.state] = (s[t.state] ?? 0) + 1;

            if (t.mods.length > 1)
                s.conflicts = (s.conflicts ?? 0) + 1;
        }

        if (type === T_IMAGE)
        {
            for (const [folder, l] of this.removedImages())
            {
                let f = m.get(folder);

                if (!f)
                    m.set(folder, f = { folder, count: 0 });

                f.removed = l.length;
            }
        }

        return [...m.values()].sort((a, b) => a.folder.localeCompare(b.folder));
    }

    /**
     * Files of a file-based type directly in a folder; `mod` = ModInfo id of the mod providing the file, `touch` how.
     * Images: also those a mod's replace_path removed (`removed` = that mod's id; no entry of their own — the game with
     * the mods has no such file; their picture is the former file's, `ck3://img/…?removed=1`).
     */
    filesIn(type: string, folder: string): GalleryFile[]
    {
        const prefix = folder.replace(/\/+$/, '') + '/';
        const out: GalleryFile[] = [];

        for (const e of this.byType.get(type)?.values() ?? [])
        {
            if (!e.name.startsWith(prefix) || e.name.indexOf('/', prefix.length) >= 0)
                continue;

            const item: GalleryFile = { name: e.name, file: e.name.slice(prefix.length) };
            const mod = this.gfxMod(this.gfxFileOf(type, e));
            const touch = this.modTouch(e);

            if (mod)
                item.mod = mod;

            if (touch)
                item.touch = touch;

            out.push(item);
        }

        if (type === T_IMAGE)
        {
            for (const r of this.removedImages().get(prefix.slice(0, -1)) ?? [])
                out.push({ name: r.name, file: r.name.slice(prefix.length), removed: this.vfs.sources[r.by].modId! });
        }

        return out.sort((a, b) => nameOrder(a.file, b.file));
    }

    /** Pictures a mod's replace_path removed, by folder: hidden gfx images of paths no loaded file has (lazy; updates reset it). */
    private removedImgs: Map<string, { name: string; by: number; }[]> | null = null;

    private removedImages(): Map<string, { name: string; by: number; }[]>
    {
        if (this.removedImgs)
            return this.removedImgs;

        const byPath = new Map<string, { name: string; by: number; }>();

        for (const h of this.vfs.hidden('gfx', { engine: true }))
        {
            const k = h.file.rel.toLowerCase();

            if (!IMAGE_EXT.test(k) || this.imgByLc.has(k))
                continue;

            // (hidden more than once — by a same-path file, then that one by a replace_path: the last hider removed it)
            const had = byPath.get(k);

            if (!had)
                byPath.set(k, { name: h.file.rel, by: h.by });
            else if (h.by > had.by)
                had.by = h.by;
        }

        const out = new Map<string, { name: string; by: number; }[]>();

        for (const r of byPath.values())
        {
            const folder = r.name.slice(0, r.name.lastIndexOf('/'));
            const l = out.get(folder);

            if (l)
                l.push(r);
            else
                out.set(folder, [r]);
        }

        return this.removedImgs = out;
    }

    // -------------------------------------------------------------------------
    // Text helpers
    // -------------------------------------------------------------------------

    readFile(idx: number): string
    {
        let s = this.fileCache.get(idx);

        if (s === undefined)
        {
            s = this.vfs.readText(this.files[idx].gf) ?? '';
            // (a checksum belongs to the text read before)
            this.hashes.delete(idx);
            this.fileCache.set(idx, s);

            if (this.fileCache.size > 40)
                this.fileCache.delete(this.fileCache.keys().next().value!);
        }

        return s;
    }

    /** Localization text with $refs$ inlined and formatting codes removed. */
    /**
     * Localization text with $keys$ resolved and formatting removed. Concept links `[faith|E]` become the concept's
     * name, or stay as brackets with `keepConcepts` (views that turn them into links).
     */
    plainLoc(key: string, depth = 0, keepConcepts = false): string | undefined
    {
        // (a display name being computed reads this key — also when it is missing: it may come)
        if (this.sigDepth)
            this.sigAcc |= sigBits(key);

        const raw = this.locText.get(key);

        if (raw === undefined)
            return undefined;

        let t = raw;

        if (depth < 3 && t.includes('$'))
        {
            t = t.replace(/\$([A-Za-z0-9_.\-]+)(?:\|[^$]*)?\$/g, (m, k: string) => this.plainLoc(k, depth + 1, keepConcepts) ?? m);
        }

        return t
            // (a closing #! takes no space with it: "#P +10#! Prestige" reads "+10 Prestige")
            .replace(/#!/g, '')
            // (formats may take a parameter: #indent_newline:3, #font:TitleFont;size:20)
            .replace(/#[A-Za-z_]+(?::[\w.]+)?(?:;[A-Za-z_]+(?::[\w.]+)?)* /g, '')
            .replace(/\$EFFECT_LIST_BULLET\$/g, '• ') // filled in by the game's code, no loc key
            .replace(/@\w+!/g, '') // inline icons: @gold_icon!
            .replace(/\[\w+_i(?:\|\w*)?\]/g, '') // icon concepts: [gold_i]
            .replace(/\[[^\]]*(?:TextIcon|GetIcon)[^\]]*\]/g, '')
            .replace(/\[([a-z_0-9]+)\|[A-Za-z]*\]/g, (m, k: string) => (keepConcepts && this.concept(k) ? m : (this.plainLoc(`game_concept_${k}`, depth + 1) ?? k)))
            .replace(/\\n/g, '\n');
    }

    private lookupDisplay = (key: string): string | undefined =>
    {
        // (which entry a name finds: named()[0])
        if (this.sigDepth)
            this.sigAcc |= sigBits('#' + key);

        const e = this.named(key)[0];
        return e ? this.displayName(e) : undefined;
    };

    /**
     * Entity a localization [data function] refers to: `GetTrait('pure_blooded').GetName( GetNullCharacter )` → the
     * trait, `GetTitleByKey('k_france')…` → the title, `faith|E` or `Concept('faith', …)` → the game concept.
     */
    bracketRef(inner: string): BracketLink | undefined
    {
        const expr = inner.replace(/\|[A-Za-z0-9=+\-]*$/, '').trim();
        const found = (e: Entity | undefined): BracketLink | undefined => (e ? { type: e.type, name: e.name } : undefined);
        // concept links show the concept's name as written for that key (aliases have their own: children, characters)
        const concept = (key: string, text?: string): BracketLink | undefined =>
        {
            const e = this.concept(key);
            return e ? { type: e.type, name: e.name, text: text ?? this.plainLoc(`game_concept_${key}`) ?? this.plainLoc(`game_concept_${e.name}`) } : undefined;
        };
        const quoted = /\b(Get\w+|Concept)\(\s*'([^']+)'(?:\s*,\s*'([^']*)')?/.exec(expr);

        if (quoted)
        {
            const [, getter, key, label] = quoted;

            if (getter === 'Concept')
                return concept(key, label);

            const types = GETTER_TYPES[getter];

            if (!types)
                return found(this.named(key)[0]);

            for (const t of types)
            {
                const e = this.get(t, key);

                if (e)
                    return found(e);
            }

            return undefined;
        }

        return /^\w+$/.test(expr) ? concept(expr) : undefined;
    }

    private conceptAliases: Map<string, string> | null = null;

    /** Game concept by key or alias (`child = { alias = { children child_possessive } }`). */
    concept(key: string): Entity | undefined
    {
        const e = this.get('game_concepts', key);

        if (e)
            return e;

        if (!this.conceptAliases)
        {
            this.conceptAliases = new Map();

            for (const name of this.names('game_concepts'))
            {
                const d = this.defNode(this.get('game_concepts', name)!);
                const alias = d && Array.isArray(d.node.v) ? d.node.v.find((x) => x.k === 'alias') : undefined;

                if (alias && Array.isArray(alias.v))
                {
                    for (const a of alias.v)
                        if (typeof a.v === 'string' && !this.conceptAliases.has(a.v))
                            this.conceptAliases.set(a.v, name);
                }
            }
        }

        const name = this.conceptAliases.get(key);
        return name ? this.get('game_concepts', name) : undefined;
    }

    /** bracketRef for every [ … ] in the texts, keyed by the bracket content. */
    textRefs(texts: (string | undefined)[]): Record<string, BracketLink> | undefined
    {
        const out: Record<string, BracketLink> = {};

        for (const t of texts)
        {
            if (!t)
                continue;

            for (const b of scanBrackets(t))
            {
                const r = this.bracketRef(b.inner);

                if (r)
                    out[b.inner] = r;
            }
        }

        return Object.keys(out).length ? out : undefined;
    }

    displayName(e: Entity): string | undefined
    {
        if (e.display !== undefined)
        {
            // (another entry's name inside one being computed: what that one read counts too)
            if (this.sigDepth)
                this.sigAcc |= this.dispSig[e.id] ?? 0;

            return e.display ?? undefined;
        }

        const outer = this.sigAcc;
        this.sigAcc = 0;
        this.sigDepth++;
        const d = this.computeDisplay(e);
        this.sigDepth--;

        if (e.id >= this.dispSig.length)
        {
            const grown = new Uint32Array(Math.max(e.id + 1, Math.ceil(this.entities.length * 1.25)));
            grown.set(this.dispSig);
            this.dispSig = grown;
        }

        this.dispSig[e.id] = this.sigAcc;
        this.sigAcc = outer | this.sigAcc;
        return d;
    }

    /** displayName without the cache's bookkeeping. */
    private computeDisplay(e: Entity): string | undefined
    {
        let d: string | undefined;
        const meta = this.shownDef(e)?.meta;

        if (e.type === T_IMAGE)
            d = e.name.slice(e.name.lastIndexOf('/') + 1).replace(IMAGE_EXT, '');
        else if (e.type === T_MODEL)
            d = e.name.slice(e.name.lastIndexOf('/') + 1);
        else if (e.type === T_LOC)
            d = this.plainLoc(e.name);
        else if (e.type === T_EVENT && meta?.title)
            d = this.plainLoc(meta.title);
        // history names are loc keys in names/character_names (E_tienne → Étienne)
        else if (e.type === T_CHARACTER && meta?.name)
            d = this.plainLoc(meta.name) ?? meta.name;
        else if ((e.type === 'dynasties' || e.type === 'dynasty_houses') && meta?.name)
            d = (meta.prefix ? (this.plainLoc(meta.prefix) ?? '') : '') + (this.plainLoc(meta.name) ?? meta.name);

        if (d === undefined && e.type !== T_LOC && e.type !== T_FLAG && e.type !== T_VARIABLE)
        {
            for (const k of displayNameCandidates(e.type, e.name))
            {
                d = this.plainLoc(k);

                if (d !== undefined)
                    break;
            }
        }

        if (d !== undefined)
        {
            e.display = null; // guard against cycles through data functions
            d = humanizeBrackets(d, this.lookupDisplay).replace(/\s+/g, ' ').trim();

            if (d.length > 120)
                d = d.slice(0, 117) + '…';

            if (!d)
                d = undefined;
        }

        e.display = d ?? null;
        return d;
    }

    /**
     * Per entry: what its display name read, as a 32-bit filter (sigBits: two bits per localization key read — also a
     * missing one — and per name looked up, `#name`; with the reads of the entries' names it shows). An update
     * recomputes the names whose filter holds a changed key or name (refreshDisplays).
     */
    private dispSig = new Uint32Array(0);
    /** while a display name is computed: what it read so far, and how deep (nested names) */
    private sigAcc = 0;
    private sigDepth = 0;

    /**
     * After an update: the display names computed so far that may read differently now — of entries whose definitions
     * changed, and those whose filter holds a changed loc key or name (`#name`) — are computed again (the top bar search
     * matches the names computed; the others stay as they are). A few false positives (a 32-bit filter) cost a
     * recomputation each. More than `DISPLAY_EAGER` (a big change: the filters answer "maybe" for most names — ~15 µs
     * each): dropped, computed again on use like after a build. Returns how many were computed again and dropped.
     */
    private refreshDisplays(touched: Iterable<Entity>, reads: Iterable<string>): { again: number; dropped: number; }
    {
        // bit a → the bits b some changed item sets with it: an entry is hit when its filter has both bits of one
        const partners = new Uint32Array(32);
        let any = false;

        for (const s of reads)
        {
            const h = fnv(s);
            const a = h & 31;
            const b = (h >>> 5) & 31;
            partners[a] |= 1 << b;
            partners[b] |= 1 << a;
            any = true;
        }

        const stale = new Set<Entity>();

        for (const e of touched)
            if (!e.dead && e.display !== undefined)
                stale.add(e);

        if (any)
        {
            const n = Math.min(this.entities.length, this.dispSig.length);

            for (let id = 0; id < n; id++)
            {
                const s = this.dispSig[id];

                if (!s)
                    continue;

                const e = this.entities[id];

                if (e.dead || e.display === undefined)
                    continue;

                for (let bits = s; bits;)
                {
                    const i = 31 - Math.clz32(bits);
                    bits &= ~(1 << i);

                    if (partners[i] & s)
                    {
                        stale.add(e);
                        break;
                    }
                }
            }
        }

        // (all dropped first: one may show another's name)
        for (const e of stale)
            e.display = undefined;

        if (stale.size > DISPLAY_EAGER)
            return { again: 0, dropped: stale.size };

        for (const e of stale)
            this.displayName(e);

        return { again: stale.size, dropped: 0 };
    }

    // -------------------------------------------------------------------------
    // Mods: how the loaded mods touch entries (docs/mods.md)
    // -------------------------------------------------------------------------

    private touchCache: (ModTouch | null | undefined)[] = [];
    /** one shared object per distinct touch (state + mods): AGOT touches ~400k entries in a handful of ways */
    private touchKinds = new Map<string, ModTouch>();
    private modCounts: Map<string, ModCounts> | null = null;
    /** gfx files a mod replaced, by lowercase path */
    private gfxHidden: Map<string, HiddenFile[]> | null = null;

    /**
     * How the loaded mods touch an entry; undefined when they don't (or no mods are loaded). removed: only definitions
     * in hidden files are left; added: none comes from the game; merged: game and mods both define a merging type
     * (on_actions); same: every mod definition says what the game's does; overridden: otherwise — a mod definition
     * wins (also a localization key: the later text, a `replace/` file's first of all), or a mod hid a game
     * definition. Flags and variables: the mods whose script uses them (usesTouch).
     */
    modTouch(e: Entity): ModTouch | undefined
    {
        if (this.vfs.sources.length < 2)
            return undefined;

        let t = this.touchCache[e.id];

        if (t === undefined)
        {
            this.touchCache[e.id] = t = e.type === T_IMAGE || e.type === T_MODEL
                ? this.gfxTouch(e)
                : e.type === T_FLAG || e.type === T_VARIABLE
                ? this.usesTouch(e)
                : this.defsTouch(e);
        }

        return t ?? undefined;
    }

    /** Entries whose every mod definition says what the game's does (computed for all on first use, then kept current). */
    private sameIds: Set<number> | null = null;

    private sameAsGame(e: Entity): boolean
    {
        if (!this.sameIds)
            this.sameIds = this.findSame(this.entities);

        return this.sameIds.has(e.id);
    }

    /**
     * Of these entries, those defined by the game and by mods where each mod definition says what the game's last one
     * does (docs/mods.md, "Same as the game"): script by its tokens (sameScript — spacing and comments aside; the same
     * text needs no tokens) and what it uses from its file the same on both sides (sameUses: @constants, file-local
     * scripted triggers/effects), localization by its text. Merging types are left out (a copy of an on_action adds to
     * it). The entries go in the order of the files they need — a mod's copy of a game file pairs its definitions with
     * that file's — so each file is read about once, a few kept at a time.
     */
    private findSame(entities: Iterable<Entity>): Set<number>
    {
        const cands: { e: Entity; game: Def; mods: Def[]; }[] = [];

        for (const e of entities)
        {
            if (e.dead || MERGING_TYPES.has(e.type) || e.defs.length < 2)
                continue;

            let game: Def | undefined;
            const mods: Def[] = [];

            for (const d of e.defs)
            {
                if (this.files[d.file].source === 0)
                    game = d;
                else
                    mods.push(d);
            }

            if (game && mods.length)
                cands.push({ e, game, mods });
        }

        cands.sort((a, b) => a.game.file - b.game.file || a.mods[0].file - b.mods[0].file);
        // (not through readFile: its cache keeps the few files views read again, not thousands)
        const texts = new Map<number, string>();
        const textOf = (file: number): string =>
        {
            let t = texts.get(file);

            if (t === undefined)
            {
                t = this.fileCache.get(file) ?? this.vfs.readText(this.files[file].gf) ?? '';

                if (texts.size >= 8)
                    texts.delete(texts.keys().next().value!);
            }
            else
                texts.delete(file);

            texts.set(file, t);
            return t;
        };
        const said = (d: Def): string =>
        {
            const text = textOf(d.file);
            return this.files[d.file].area === 'localization' ? '"' + (locTextAt(text, d.start) ?? '') : text.slice(d.start, d.end);
        };
        const out = new Set<number>();

        for (const { e, game, mods } of cands)
        {
            const g = said(game);
            const same = mods.every((d) =>
            {
                const m = said(d);

                if (e.type === T_LOC)
                    return m === g;

                return (m === g || sameScript(m, g)) && this.sameUses(d.file, m, game.file, g, textOf);
            });

            if (same)
                out.add(e.id);
        }

        return out;
    }

    /** "Same as the game": a file's @constants (constantValues), read when a definition of it uses one. */
    private sameConsts = new Map<number, Map<string, string>>();
    /** events files' file-local scripted triggers / effects: file → name → definitions (the index's own), then a pattern of their names */
    private localDefs: Map<number, Map<string, Def[]>> | null = null;
    private localCalls = new Map<number, RegExp>();

    /**
     * Whether two definitions whose own texts say the same (a mod's, `m` in file `mf`, and the game's) use the same
     * from their files: the @constants they use — in their text, their inline maths, the values of the constants they
     * reach — with the same values as written, and the file-local scripted triggers/effects they call, directly or
     * through each other, saying the same (sameScript). A name one file has and the other lacks is a difference.
     */
    private sameUses(mf: number, m: string, gf: number, g: string, textOf: (file: number) => string): boolean
    {
        const a = this.fileUses(mf, m, textOf);
        const b = this.fileUses(gf, g, textOf);

        if (!a || !b)
            return !a && !b;

        if (a.size !== b.size)
            return false;

        for (const [k, v] of a)
        {
            const w = b.get(k);

            if (w === undefined || (v !== w && (k.charCodeAt(0) === 64 || !sameScript(v, w))))
                return false;
        }

        return true;
    }

    /**
     * What a definition's text uses from its file besides itself, transitively: `@name` → the constant's value as
     * written, `name` → a file-local scripted trigger/effect's text (events files). Null: nothing.
     */
    private fileUses(file: number, text: string, textOf: (file: number) => string): Map<string, string> | null
    {
        const locals = this.localsIn(file);

        if (!locals && !text.includes('@'))
            return null;

        const src = textOf(file);
        let out: Map<string, string> | null = null;
        const queue = [text];

        while (queue.length)
        {
            const t = queue.pop()!;

            if (t.includes('@'))
            {
                let consts = this.sameConsts.get(file);

                if (!consts)
                    this.sameConsts.set(file, consts = constantValues(src));

                for (const c of constantsUsed(t))
                {
                    const v = consts.get(c);

                    if (v === undefined || out?.has('@' + c))
                        continue;

                    (out ??= new Map()).set('@' + c, v);
                    queue.push(v);
                }
            }

            if (!locals)
                continue;

            let re = this.localCalls.get(file);

            if (!re)
                this.localCalls.set(file, re = namesPattern([...locals.keys()]));

            for (const x of t.matchAll(re))
            {
                if (out?.has(x[0]))
                    continue;

                const lt = locals.get(x[0])!
                    .map((d) => src.slice(d.start, d.end))
                    .join('\n');
                (out ??= new Map()).set(x[0], lt);
                queue.push(lt);
            }
        }

        return out;
    }

    /** The file-local scripted triggers / effects of an events file, by name (from the index's definitions). */
    private localsIn(file: number): Map<string, Def[]> | undefined
    {
        if (!this.localDefs)
        {
            this.localDefs = new Map();

            for (const type of [T_SCRIPTED_TRIGGER, T_SCRIPTED_EFFECT])
            {
                for (const e of this.byType.get(type)?.values() ?? [])
                {
                    for (const d of e.defs)
                    {
                        if (!d.local)
                            continue;

                        let m = this.localDefs.get(d.file);

                        if (!m)
                            this.localDefs.set(d.file, m = new Map());

                        const l = m.get(e.name);

                        if (l)
                            l.push(d);
                        else
                            m.set(e.name, [d]);
                    }
                }
            }
        }

        return this.localDefs.get(file);
    }

    private defsTouch(e: Entity): ModTouch | null
    {
        const involved = new Set<number>();
        let fromGame = false;
        let liveGame = false;
        let liveMod = false;
        let win = -1;
        // the mod that removed the entry: the last to hide one of its definitions
        let remover = 0;
        // (a landed title written only as the way to one inside it changes nothing: its mod doesn't touch it — unless
        // that is all there is of it)
        const real = e.type === T_TITLE && e.defs.some((d) => !d.meta?.path && !this.files[d.file].hidden);

        for (let i = 0; i < e.defs.length; i++)
        {
            if (real && e.defs[i].meta?.path)
                continue;

            const f = this.files[e.defs[i].file];

            if (f.source === 0)
                fromGame = true;
            else
                involved.add(f.source);

            if (f.hidden)
            {
                involved.add(f.hidden.by);
                remover = Math.max(remover, f.hidden.by);
            }
            else
            {
                win = i;

                if (f.source === 0)
                    liveGame = true;
                else
                    liveMod = true;
            }
        }

        if (!involved.size)
            return null;

        if (win < 0)
            return this.touch('removed', involved, remover);

        const winner = this.files[e.defs[win].file].source;

        if (!fromGame)
            return this.touch('added', involved, winner, { duplicate: this.duplicated(e, win) });

        if (MERGING_TYPES.has(e.type) && liveGame && liveMod)
            return this.touch('merged', involved, 0);

        // (a key the game keeps no winner for is a duplicate however alike its definitions are: the game reports it)
        if (this.duplicated(e, win))
            return this.touch('overridden', involved, winner, { duplicate: true });

        if (this.sameAsGame(e))
            return this.touch('same', involved, winner);

        return this.touch('overridden', involved, winner);
    }

    /**
     * Whether the game keeps no single winner for the entry: events, history characters and localization keys outside
     * `replace/` folders defined twice among the loaded files (a file replacing another of its path is no duplicate) —
     * the game reports them as errors ("Duplicated event ID …", "Duplicate character id in history", "Duplicate
     * localization key …") and which definition it uses is not defined (docs/mods.md, "Which definition wins").
     */
    private duplicated(e: Entity, win: number): boolean
    {
        if (e.type !== T_EVENT && e.type !== T_CHARACTER && e.type !== T_LOC)
            return false;

        // (a replace/ file's text is the supported override of a key)
        if (e.type === T_LOC && /(^|\/)replace\//i.test(this.files[e.defs[win].file].rel))
            return false;

        let loaded = 0;

        for (const d of e.defs)
            if (!this.files[d.file].hidden && ++loaded > 1)
                return true;

        return false;
    }

    /**
     * Flags and variables: the mods whose files use them — added (only mods) or merged (the game too); no conflicts
     * (`uses`). The entry list, search, details and references show them; counted like other touches.
     */
    private usesTouch(e: Entity): ModTouch | null
    {
        const involved = new Set<number>();
        let game = false;

        for (const r of this.incoming.get(e.id) ?? [])
        {
            const f = this.files[this.rFile[r]];

            if (!f || f.hidden)
                continue;

            if (f.source === 0)
                game = true;
            else
                involved.add(f.source);
        }

        if (!involved.size)
            return null;

        return this.touch(game ? 'merged' : 'added', involved, Math.max(...involved), { uses: true });
    }

    /** Images and models: a file from a mod is added, or overrides the game's file of the same path. */
    private gfxTouch(e: Entity): ModTouch | null
    {
        const gf = (e.type === T_IMAGE ? this.imgFile : this.modelFile).get(e.id);

        if (!gf || gf.source === 0)
            return null;

        if (!this.gfxHidden)
        {
            this.gfxHidden = new Map();

            for (const h of this.vfs.hidden('gfx', { engine: true }))
            {
                const k = h.file.rel.toLowerCase();
                const l = this.gfxHidden.get(k);

                if (l)
                    l.push(h);
                else
                    this.gfxHidden.set(k, [h]);
            }
        }

        const replaced = this.gfxHidden.get(e.lname) ?? [];
        const involved = new Set([gf.source, ...replaced.map((h) => h.file.source).filter((s) => s > 0)]);
        return this.touch(replaced.some((h) => h.file.source === 0) ? 'overridden' : 'added', involved, gf.source);
    }

    /**
     * The (shared) touch for a state and the sources involved: mod ids in load order, `last` (the winning / removing
     * mod) at the end; `uses` for flags and variables, `duplicate` for keys the game keeps no single winner for.
     */
    private touch(state: ModTouch['state'], sources: Set<number>, last: number, extra: { uses?: boolean; duplicate?: boolean; } = {}): ModTouch
    {
        const order = [...sources].filter((s) => s > 0 && s !== last).sort((a, b) => a - b);

        if (last > 0)
            order.push(last);

        const key = state + (extra.uses ? ':uses' : '') + (extra.duplicate ? ':dup' : '') + ':' + order.join(',');
        let t = this.touchKinds.get(key);

        if (!t)
        {
            t = { state, mods: order.map((s) => this.vfs.sources[s].modId!) };

            if (extra.uses)
                t.uses = true;

            if (extra.duplicate)
                t.duplicate = true;

            this.touchKinds.set(key, t);
        }

        return t;
    }

    /** Where a definition comes from, and which mod hid its file (only while mods are loaded). */
    private defOrigin(d: Def): DefOrigin | undefined
    {
        if (this.vfs.sources.length < 2)
            return undefined;

        const f = this.files[d.file];
        const src = this.vfs.sources[f.source];
        const o: DefOrigin = { name: src.name };

        if (src.modId)
            o.mod = src.modId;

        if (f.hidden)
        {
            const by = this.vfs.sources[f.hidden.by];
            o.hiddenBy = { mod: by.modId!, name: by.name, how: f.hidden.how };
        }

        return o;
    }

    /** ModInfo id of the mod a gfx file comes from (undefined = the game). */
    private gfxMod(gf: GameFile | undefined): string | undefined
    {
        return gf && gf.source > 0 ? this.vfs.sources[gf.source].modId : undefined;
    }

    // -------------------------------------------------------------------------
    // Queries
    // -------------------------------------------------------------------------

    types(): TypeSummary[]
    {
        const out: TypeSummary[] = [];
        const modCounts = this.typeModCounts();

        for (const [type, m] of this.byType)
        {
            const core = CORE_TYPES.indexOf(type);
            const t: TypeSummary = {
                id: type,
                label: typeLabel(type),
                group: typeGroup(type),
                count: m.size,
                order: core >= 0 ? core : 1000,
                hasDoc: this.typeDocs.has(type),
                searchOnly: type === T_LOC
            };
            const prefix = refPrefixOf(type);

            if (prefix)
                t.refPrefix = prefix;

            const c = modCounts?.get(type);

            if (c)
            {
                t.modCount = c.total;
                // (in one order, however the counts came about)
                t.modStates = {};

                for (const k of MOD_STATE_ORDER)
                    if (c.states[k] !== undefined)
                        t.modStates[k] = c.states[k];
            }

            out.push(t);
        }

        return out.sort((a, b) => a.order - b.order || a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
    }

    /**
     * Entries per type that the loaded mods add, change or remove, per kind of change, and the conflicts among them —
     * entries two or more mods touch (counted once, on first use).
     */
    private typeModCounts(): Map<string, ModCounts> | null
    {
        if (this.vfs.sources.length < 2)
            return null;

        if (!this.modCounts)
        {
            this.modCounts = new Map();

            for (const e of this.entities)
            {
                if (e.dead)
                    continue;

                const t = this.modTouch(e);

                if (t)
                    this.countTouch(e.type, t, 1);
            }
        }

        return this.modCounts;
    }

    /** Adds (+1) or takes away (-1) an entry's touch in the per-type mod counts (zero counts are dropped). */
    private countTouch(type: string, t: ModTouch, n: 1 | -1): void
    {
        const m = this.modCounts!;
        const c = m.get(type) ?? { total: 0, states: {} };
        m.set(type, c);
        const add = (k: keyof ModCounts['states']): void =>
        {
            const v = (c.states[k] ?? 0) + n;

            if (v)
                c.states[k] = v;
            else
                delete c.states[k];
        };
        c.total += n;
        add(t.state);

        if (conflicting(t))
            add('conflicts');

        if (t.duplicate)
            add('duplicates');

        if (!c.total)
            m.delete(type);
    }

    typeDoc(type: string): { file: string; text: string; }[]
    {
        return (this.typeDocs.get(type) ?? []).map((gf) => ({ file: gf.rel, text: this.vfs.readText(gf) ?? '' }));
    }

    /** Entity names of a type (cheap, unlike list()). */
    names(type: string): string[]
    {
        return [...(this.byType.get(type)?.keys() ?? [])];
    }

    list(type: string): EntityListItem[]
    {
        const m = this.byType.get(type);

        if (!m || type === T_LOC)
            return [];

        const out: EntityListItem[] = [];

        for (const e of m.values())
        {
            const d = this.shownDef(e);
            const item: EntityListItem = {
                name: e.name,
                display: this.displayName(e),
                file: d ? this.files[d.file].rel : undefined,
                defs: this.liveDefs(e).length,
                refs: this.incoming.get(e.id)?.length ?? 0,
                icon: this.imagesOf(e).icon?.name
            };
            const mod = this.modTouch(e);

            if (mod)
                item.mod = mod;

            out.push(item);
        }

        return out.sort((a, b) => nameOrder(a.name, b.name));
    }

    /** `modOnly`: only entries the loaded mods add, change or remove; `noRemoved`: not those a mod removed. */
    search(q: string, opts: { limit?: number; types?: string[]; text?: boolean; modOnly?: boolean; noRemoved?: boolean; } = {}): SearchResult[]
    {
        const limit = opts.limit ?? 200;
        const query = q.trim().toLowerCase();

        if (!query)
            return [];

        const typeFilter = opts.types?.length ? new Set(opts.types) : null;
        const scored: { e: Entity; s: number; match?: string; }[] = [];

        for (const e of this.entities)
        {
            if (e.dead || (typeFilter && !typeFilter.has(e.type)))
                continue;

            if (opts.modOnly && !this.modTouch(e))
                continue;

            if (opts.noRemoved && this.modTouch(e)?.state === 'removed')
                continue;

            const penalty = e.type === T_LOC ? 10 : e.type === T_IMAGE || e.type === T_MODEL ? 8 : e.type === T_FLAG || e.type === T_VARIABLE ? 5 : 0;
            const i = e.lname.indexOf(query);

            if (i >= 0)
            {
                const s = (e.lname === query ? 0 : i === 0 ? 1 : 2) + penalty;
                scored.push({ e, s });
                continue;
            }

            if (opts.text)
            {
                const text = e.type === T_LOC ? this.locText.get(e.name) : this.displayName(e);

                if (text && text.toLowerCase().includes(query))
                    scored.push({ e, s: 20 + penalty, match: text });
            }
            else if (e.type !== T_LOC && e.display)
            {
                if (e.display.toLowerCase().includes(query))
                    scored.push({ e, s: 3 + penalty });
            }
        }

        // ties: in the order a build creates the entries (ids — after updates new entries have later ones)
        scored.sort((a, b) => a.s - b.s || a.e.name.length - b.e.name.length || (this.refreshed ? this.creationOrder(a.e, b.e) : a.e.id - b.e.id));
        return scored.slice(0, limit).map(({ e, match }) => ({
            type: e.type,
            typeLabel: typeLabel(e.type),
            name: e.name,
            display: this.displayName(e),
            match: match ? snippet(match, query) : undefined,
            icon: this.imagesOf(e).icon?.name,
            mod: this.modTouch(e)
        }));
    }

    private refGroups(refIds: number[] | undefined, side: 'from' | 'to'): RefGroup[]
    {
        if (!refIds)
            return [];

        const byEntity = new Map<number, { contexts: Set<string>; sites: { file: string; line: number; }[]; count: number; }>();

        for (const r of refIds)
        {
            const other = side === 'to' ? this.rTo[r] : this.rFrom[r];
            let g = byEntity.get(other);

            if (!g)
                byEntity.set(other, g = { contexts: new Set(), sites: [], count: 0 });

            g.count++;
            g.contexts.add(this.ctx.list[this.rCtx[r]]);

            if (g.sites.length < 5)
                g.sites.push({ file: this.files[this.rFile[r]].rel, line: this.rLine[r] });
        }

        const groups = new Map<string, RefItem[]>();

        for (const [id, g] of byEntity)
        {
            const e = this.entities[id];
            const items = groups.get(e.type) ?? [];
            items.push({
                type: e.type,
                name: e.name,
                display: this.displayName(e),
                contexts: [...g.contexts].slice(0, 6),
                sites: g.sites,
                count: g.count,
                icon: this.imagesOf(e).icon?.name,
                mod: this.modTouch(e)
            });
            groups.set(e.type, items);
        }

        const out: RefGroup[] = [];

        for (const [type, items] of groups)
        {
            items.sort((a, b) => nameOrder(a.name, b.name));
            out.push({ type, typeLabel: typeLabel(type), items });
        }

        return out.sort((a, b) => (a.type === T_LOC ? 1 : 0) - (b.type === T_LOC ? 1 : 0) || a.typeLabel.localeCompare(b.typeLabel));
    }

    private linksInRange(file: number, start: number, end: number): LinkSpan[]
    {
        const refs = this.refsByFile.get(file);

        if (!refs)
            return [];

        // binary search first ref with off >= start
        let lo = 0;
        let hi = refs.length;

        while (lo < hi)
        {
            const mid = (lo + hi) >> 1;

            if (this.rOff[refs[mid]] < start)
                lo = mid + 1;
            else
                hi = mid;
        }

        const spans: LinkSpan[] = [];

        for (let i = lo; i < refs.length; i++)
        {
            const r = refs[i];
            const off = this.rOff[r];

            if (off >= end)
                break;

            if (this.rLen[r] <= 0)
                continue;

            const t = this.entities[this.rTo[r]];
            const last = spans[spans.length - 1];
            const target: EntityKey = { type: t.type, name: t.name };

            if (last && last.start === off - start)
            {
                if (!last.targets.some((x) => x.type === t.type && x.name === t.name))
                    last.targets.push(target);
            }
            else
            {
                spans.push({ start: off - start, end: off - start + this.rLen[r], targets: [target] });
            }
        }

        return spans;
    }

    private defView(e: Entity, d: Def, overridden: boolean): DefSiteView
    {
        const src = this.readFile(d.file);
        let lineStart = d.start;

        while (lineStart > 0 && src.charCodeAt(lineStart - 1) !== 10)
            lineStart--;

        const isLoc = e.type === T_LOC;
        let end = d.end;

        if (isLoc)
        {
            end = src.indexOf('\n', d.start);

            if (end < 0)
                end = src.length;
        }

        const source = src.slice(lineStart, end);
        let endLine = d.line;

        for (let i = 0; i < source.length; i++)
            if (source.charCodeAt(i) === 10)
                endLine++;

        const view: DefSiteView = {
            file: this.files[d.file].rel,
            absPath: this.files[d.file].abs,
            line: d.line,
            endLine,
            source,
            links: isLoc ? [] : this.linksInRange(d.file, lineStart, end),
            doc: d.doc,
            local: d.local,
            overridden
        };

        if (d.meta?.path)
            view.path = true;

        const origin = this.defOrigin(d);

        if (origin)
            view.origin = origin;

        // script definitions as statements of their file, a localization key's line: the Source tab's editor (docs/mods.md,
        // "Editing in place")
        if (isLoc)
        {
            const a = this.locAnchor(e, e.defs.indexOf(d));

            if (a)
                view.src = a;
        }
        else
        {
            const a = this.defAnchor(e, e.defs.indexOf(d));

            if (a)
            {
                view.src = { file: a.file, rel: a.rel, line: d.line, s: d.start, e: d.end, kind: 'other', hash: a.hash };

                if (a.mod)
                {
                    view.src.mod = a.mod;
                    view.src.stmt = stmtCheck(a.text ?? src, d.start, d.end);
                }

                if (src.charCodeAt(d.end - 1) === 125)
                {
                    const open = src.indexOf('{', d.start);

                    if (open >= 0 && open < d.end)
                        view.src.inner = [open + 1, d.end - 1];
                }
            }
        }

        return view;
    }

    detail(type: string, name: string): EntityDetail | null
    {
        const e = this.entity(type, name, false);

        if (!e)
            return null;

        const merging = MERGING_TYPES.has(type);
        // loaded definitions before the winning one are overridden; hidden ones carry origin.hiddenBy instead
        const win = this.winningIdx(e);
        const defs = e.defs.map((d, i) => this.defView(e, d, !merging && i < win && !this.isHiddenDef(d)));
        let description: string | undefined;

        if (type !== T_LOC)
        {
            for (const k of descriptionCandidates(type, name))
            {
                description = this.plainLoc(k, 0, true);

                if (description !== undefined)
                    break;
            }
        }

        const out: EntityDetail = {
            type,
            typeLabel: typeLabel(type),
            name,
            display: this.displayName(e),
            description,
            defs,
            outgoing: this.refGroups(this.outgoing.get(e.id), 'to'),
            incoming: this.refGroups(this.incoming.get(e.id), 'from')
        };
        const mod = this.modTouch(e);

        if (mod)
            out.mod = mod;

        if (type === T_LOC)
        {
            out.locText = this.locText.get(name);
            out.locPlain = this.plainLoc(name, 0, true);
        }

        if (type === T_EVENT && win >= 0)
            out.event = this.eventPreview(e, e.defs[win]);

        const ev = out.event;
        const views = ev ? [...ev.titles, ...ev.descs, ...ev.options.flatMap((o) => o.names)] : [];
        out.textRefs = this.textRefs([out.description, out.locPlain, ...views.map((v) => v.text)]);
        return out;
    }

    /**
     * The winning definition of an entry as text for the active mod (ModInfo id `activeMod`): exactly as written, with
     * the namespace, constants and file-local definitions it needs — or why it cannot be copied alone. Also where the
     * active mod already defines the entry. The main process picks the file and writes it (src/main/mods/edit.ts,
     * docs/mods.md "Editing the active mod").
     */
    overrideSource(type: string, name: string, activeMod?: string): OverrideSource | null
    {
        const e = this.entity(type, name, false);

        if (!e)
            return null;

        const activeSource = activeMod ? this.vfs.sources.findIndex((s) => s.modId === activeMod) : -1;
        const out: OverrideSource = { type, name, merging: type === T_ON_ACTION, activeSource };

        if (activeSource > 0)
        {
            // (a landed title the mod writes only as the way to one inside it is no definition of its own)
            const mine = [...e.defs].reverse().find((d) => !this.isHiddenDef(d) && !d.meta?.path && this.files[d.file].source === activeSource);

            if (mine)
                out.inMod = { rel: this.files[mine.file].rel, abs: this.files[mine.file].abs, line: mine.line };
        }

        if (!e.defs.length)
        {
            out.none = true;
            return out;
        }

        const win = this.winningDef(e);

        if (!win)
        {
            out.removed = true;
            return out;
        }

        const f = this.files[win.file];
        out.def = {
            rel: f.rel,
            abs: f.abs,
            line: win.line,
            source: f.source,
            from: f.source ? this.vfs.sources[f.source].name : 'the game',
            otherFiles: new Set(this.liveDefs(e).map((d) => d.file)).size - 1
        };
        const src = this.readFile(win.file);

        if (type === T_LOC)
        {
            let end = src.indexOf('\n', win.start);

            if (end < 0)
                end = src.length;

            out.loc = { lang: this.language, key: name, entry: src.slice(win.start, end).replace(/\r$/, ''), eol: eolOf(src), file: f.rel };
            return out;
        }

        // the copy must be byte-exact: the decoded text of a file that is not valid UTF-8 is not
        const raw = this.vfs.read(f.gf);
        const bytes = raw && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;

        if (!bytes || !Buffer.from(src, 'utf8').equals(bytes))
        {
            out.copyProblem = `${f.rel} is not valid UTF-8: a copy of its text would not be byte-exact. Replace the whole file instead.`;
            return out;
        }

        if (win.local)
        {
            out.copyProblem = `File-local: only the events of ${f.rel} can call it. Copy those events (they take it along), or replace the whole file.`;
            return out;
        }

        const ast = parse(src);
        const top = topLevelAt(ast, win.start);
        let def = { start: win.start, end: win.end, line: win.line, key: name };

        // a landed title inside its de jure lieges: its own block inside empty blocks of theirs — the game merges a title
        // written again into the one it has (override.ts titleText)
        const chain = top && top.s !== win.start && type === T_TITLE ? pathTo(top, win.start) : undefined;

        if (chain)
        {
            out.container = { type, name: chain[chain.length - 2].k! };
            out.path = chain.slice(0, -1).map((n) => n.k!);
            out.copy = titleText(src, ast, chain);
            return out;
        }

        if (top && top.s !== win.start)
        {
            // nested (a faith in its religion, a law in its group): the game overrides the top-level key, so the whole
            // holding definition is copied — when it is a definition of its own
            const holder = top.k ? (this.byName.get(top.k) ?? []).find((c) => c.defs.some((d) => d.file === win.file && d.start === top.s)) : undefined;

            if (!holder)
            {
                out.copyProblem = `It is defined inside the block “${top.k ?? '{ }'}”, which is not a definition of its own — a copy of it alone would not be valid. Replace the whole file instead.`;
                return out;
            }

            out.container = { type: holder.type, name: holder.name };
            def = { start: top.s, end: top.e, line: top.line, key: holder.name };
        }

        out.copy = overrideText(src, ast, def, { area: f.area, eventId: type === T_EVENT ? name : undefined });
        return out;
    }

    /** The bytes of the file holding an entry's winning definition, as the game loads it ("Replace the whole file"). */
    overrideFileBytes(type: string, name: string): Uint8Array | null
    {
        const e = this.entity(type, name, false);
        const win = e && this.winningDef(e);
        return win ? (this.vfs.read(this.files[win.file].gf) ?? null) : null;
    }

    private locView(key: string): { key: string; text?: string; }
    {
        return { key, text: this.plainLoc(key, 0, true) };
    }

    private eventPreview(e: Entity, d: Def): EventPreview
    {
        const src = this.readFile(d.file);
        const slice = src.slice(d.start, d.end);
        const root = parse(slice)[0];
        const body = root && Array.isArray(root.v) ? root.v : [];
        const get = (k: string): PNode | undefined => body.find((n) => n.k === k);
        const scalarOf = (k: string): string | undefined =>
        {
            const n = get(k);
            return n && typeof n.v === 'string' ? n.v : undefined;
        };
        const locKeys = (n: PNode | undefined): string[] =>
        {
            if (!n)
                return [];

            if (typeof n.v === 'string')
                return n.v ? [n.v] : [];

            const out: string[] = [];
            const visit = (list: PNode[]): void =>
            {
                for (const c of list)
                {
                    if (c.k === 'trigger' || c.k === 'limit')
                        continue;

                    if (typeof c.v === 'string')
                    {
                        if (c.k === 'desc' || c.k === 'first_valid' || c.k === null)
                        {
                            if (c.v && this.locText.has(c.v))
                                out.push(c.v);
                        }
                    }
                    else
                        visit(c.v);
                }
            };
            visit(n.v);
            return out;
        };
        const options = body
            .filter((n) => n.k === 'option' && Array.isArray(n.v))
            .map((n) =>
            {
                const list = n.v as PNode[];
                const nameNode = list.find((c) => c.k === 'name');
                const keys = locKeys(nameNode);
                const effects = this.linksInRange(d.file, d.start + n.s, d.start + n.e)
                    .flatMap((l) => l.targets)
                    .filter((t) => t.type !== T_LOC);
                const seen = new Set<string>();
                const uniq = effects.filter((t) =>
                {
                    const k = t.type + '\u0000' + t.name;

                    if (seen.has(k))
                        return false;

                    seen.add(k);
                    return true;
                });
                return {
                    names: keys.map((k) => this.locView(k)),
                    conditional: list.some((c) => c.k === 'trigger' || c.k === 'show_as_unavailable'),
                    fallback: list.some((c) => c.k === 'fallback' && c.v === 'yes'),
                    aiChance: list.some((c) => c.k === 'ai_chance'),
                    references: uniq.slice(0, 40)
                };
            });
        const portraits = body
            .filter((n) => n.k !== null && /portrait$/.test(n.k))
            .map((n) =>
            {
                const ch = typeof n.v === 'string' ? n.v : (n.v.find((c) => c.k === 'character')?.v as string | undefined);
                const anim = Array.isArray(n.v) ? (n.v.find((c) => c.k === 'animation')?.v as string | undefined) : undefined;
                return { position: n.k!, character: typeof ch === 'string' ? ch : '?', animation: typeof anim === 'string' ? anim : undefined };
            });
        return {
            eventType: scalarOf('type'),
            theme: scalarOf('theme'),
            hidden: scalarOf('hidden') === 'yes',
            titles: locKeys(get('title')).map((k) => this.locView(k)),
            descs: locKeys(get('desc')).map((k) => this.locView(k)),
            options,
            portraits,
            hasTrigger: !!get('trigger'),
            hasImmediate: !!get('immediate'),
            hasAfter: !!get('after'),
            cooldown: get('cooldown') ? src.slice(d.start + get('cooldown')!.vs, d.start + get('cooldown')!.e).replace(/\s+/g, ' ') : undefined
        };
    }

    graph(type: string, name: string, depth: number, excludeTypes: string[], onlyTypes: string[] | null, maxNodes = 150): GraphData
    {
        const center = this.entity(type, name, false);

        if (!center)
            return { nodes: [], edges: [] };

        const excluded = new Set(excludeTypes);
        const allowed = onlyTypes && onlyTypes.length ? new Set(onlyTypes) : null;
        const ok = (e: Entity): boolean => e === center || (!excluded.has(e.type) && (!allowed || allowed.has(e.type)));
        const dist = new Map<number, number>([[center.id, 0]]);
        const edges = new Map<string, { source: number; target: number; ctx: string; count: number; }>();
        let frontier = [center.id];

        for (let d = 1; d <= depth && dist.size < maxNodes; d++)
        {
            const next: number[] = [];

            for (const id of frontier)
            {
                const visit = (refIds: number[] | undefined, outgoing: boolean): void =>
                {
                    if (!refIds)
                        return;

                    for (const r of refIds)
                    {
                        const other = outgoing ? this.rTo[r] : this.rFrom[r];
                        const oe = this.entities[other];

                        if (!ok(oe))
                            continue;

                        if (!dist.has(other))
                        {
                            if (dist.size >= maxNodes)
                                continue;

                            dist.set(other, d);
                            next.push(other);
                        }

                        const s = outgoing ? id : other;
                        const t = outgoing ? other : id;
                        const key = s + '>' + t;
                        const ex = edges.get(key);

                        if (ex)
                            ex.count++;
                        else
                            edges.set(key, { source: s, target: t, ctx: this.ctx.list[this.rCtx[r]], count: 1 });
                    }
                };
                visit(this.outgoing.get(id), true);
                visit(this.incoming.get(id), false);
            }

            frontier = next;
        }

        // include edges between already-discovered nodes only
        const nodes = [...dist.entries()].map(([id, d]) =>
        {
            const e = this.entities[id];
            return { id: String(id), type: e.type, name: e.name, display: this.displayName(e), distance: d };
        });
        return {
            nodes,
            edges: [...edges.values()]
                .filter((x) => dist.has(x.source) && dist.has(x.target))
                .map((x) => ({ source: String(x.source), target: String(x.target), ctx: x.ctx, count: x.count })),
            truncated: dist.size >= maxNodes
        };
    }
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

class CandidateTable
{
    size = 0;
    tok: string[] = [];
    k1: (string | null)[] = [];
    k0: (string | null)[] = [];
    isKey: number[] = [];
    quoted: number[] = [];
    from: number[] = [];
    file: number[] = [];
    line: number[] = [];
    off: number[] = [];
    len: number[] = [];
    ctx: number[] = [];
    direct: number[] = [];

    add(tok: string, k1: string | null, k0: string | null, isKey: boolean, from: number, file: number, line: number, off: number, len: number, ctx: number, quoted = false): void
    {
        this.tok.push(tok);
        this.k1.push(k1);
        this.k0.push(k0);
        this.isKey.push(isKey ? 1 : 0);
        this.quoted.push(quoted ? 1 : 0);
        this.from.push(from);
        this.file.push(file);
        this.line.push(line);
        this.off.push(off);
        this.len.push(len);
        this.ctx.push(ctx);
        this.direct.push(-1);
        this.size++;
    }

    addDirect(from: number, to: number, file: number, line: number, off: number, len: number, ctx: number): void
    {
        this.add('', null, null, false, from, file, line, off, len, ctx);
        this.direct[this.size - 1] = to;
    }
}

const SKIP_KEYS = new Set([
    'trigger',
    'limit',
    'immediate',
    'option',
    'effect',
    'modifier',
    'if',
    'else',
    'else_if',
    'AND',
    'OR',
    'NOT',
    'NOR',
    'NAND',
    'value',
    'add',
    'multiply',
    'divide',
    'subtract',
    'desc',
    'name',
    'first_valid',
    'triggered_desc',
    'random_valid',
    'weight_multiplier',
    'ai_chance',
    'base',
    'factor',
    'save_scope_as',
    'save_temporary_scope_as',
    'custom_tooltip',
    'custom_description',
    'show_as_tooltip',
    'hidden_effect',
    'random_list',
    'switch',
    'trigger_if',
    'trigger_else',
    'trigger_else_if'
]);

function collectCandidates(
    nodes: PNode[],
    from: number,
    file: number,
    path: string[],
    defNodes: Set<PNode>,
    cands: CandidateTable,
    ctx: Interner,
    consts: Map<string, string>
): void
{
    const k0 = path.length ? path[path.length - 1] : null;

    for (const n of nodes)
    {
        if (defNodes.has(n))
            continue; // nested definition, indexed on its own

        const key = n.k;

        if (key !== null && key !== '' && !SKIP_KEYS.has(key) && !DATE_KEY.test(key) && !NUMERIC.test(key))
        {
            cands.add(key, key, k0, true, from, file, n.line, n.s, n.kl, ctx.id(ctxString(path, key)));
        }

        if (typeof n.v === 'string')
        {
            if (n.v === '' || (key !== null && n.v.length < 2))
                continue;

            const k1 = key ?? k0;
            const kk0 = key === null ? (path.length > 1 ? path[path.length - 2] : null) : k0;
            const tok = n.v.charCodeAt(0) === 64 ? (consts.get(n.v.slice(1)) ?? n.v) : n.v;
            cands.add(tok, k1, kk0, false, from, file, n.line, n.vs, n.q ? n.v.length + 2 : n.v.length, ctx.id(ctxString(path, key)), !!n.q);
        }
        else
        {
            path.push(key ?? '');
            collectCandidates(n.v, from, file, path, defNodes, cands, ctx, consts);
            path.pop();
        }
    }
}

/** An image path as script writes it → the lower case file name without extension (GameIndex.imgByBase keys). */
function imageBase(path: string): string
{
    const lc = path.replace(/\\/g, '/').toLowerCase();
    return lc.slice(lc.lastIndexOf('/') + 1).replace(IMAGE_EXT, '');
}

/** Names a `prefix:name` chain looks up (resolvePrefixed): flags, variables and scopes need none. */
function prefixedNames(tok: string, out: string[]): void
{
    for (const seg of tok.split('.'))
    {
        const c = seg.indexOf(':');

        if (c <= 0)
            continue;

        const prefix = seg.slice(0, c);
        let name = seg.slice(c + 1);
        const paren = name.indexOf('(');

        if (paren >= 0)
            name = name.slice(0, paren);

        if (!name || name.includes('$') || prefix === 'flag' || prefix === 'scope' || VARIABLE_PREFIXES.has(prefix))
            continue;

        out.push(name);
    }
}

/** Name filter of a localization file: what the texts of all its keys refer to (the winning key may move to it). */
function locBloom(entries: LocEntry[]): Uint32Array | undefined
{
    const names: string[] = [];

    for (const en of entries)
    {
        const r = extractLocRefs(en.text);
        names.push(...r.loc, ...r.concepts, ...r.args);
    }

    return makeBloom(names);
}

/** FNV-1a of a string (32 bits). */
function fnv(s: string): number
{
    let h = 0x811c9dc5;

    for (let i = 0; i < s.length; i++)
        h = Math.imul(h ^ s.charCodeAt(i), 16777619);

    return h >>> 0;
}

/** The two bits (of 32) a display name's filter sets for a key or name it read (GameIndex.dispSig). */
function sigBits(s: string): number
{
    const h = fnv(s);
    return (1 << (h & 31)) | (1 << ((h >>> 5) & 31));
}

/** A file's identity across scans: source and path, and with `hidden` who hid it how. */
function fileKey(f: FileInfo, hidden = false): string
{
    const k = f.source + '|' + f.rel.toLowerCase();
    return hidden ? k + '|' + (f.hidden ? f.hidden.by + f.hidden.how : '') : k;
}

function ctxString(path: string[], key: string | null): string
{
    const parts: string[] = [];

    for (let i = path.length - 1; i >= 0 && parts.length < 2; i--)
        if (path[i])
            parts.unshift(path[i]);

    if (key)
        parts.push(key);

    return parts.join(' › ');
}

// ---------------------------------------------------------------------------
// Definition metadata
// ---------------------------------------------------------------------------

function firstLocKey(n: PNode | undefined): string | undefined
{
    if (!n)
        return undefined;

    if (typeof n.v === 'string')
        return n.v || undefined;

    for (const c of n.v)
    {
        if (c.k === 'trigger' || c.k === 'limit')
            continue;

        const r = c.k === 'desc' || c.k === null ? firstLocKey(c) : Array.isArray(c.v) ? firstLocKey(c) : undefined;

        if (r)
            return r;
    }

    return undefined;
}

const ICON_KEY = /^(icon|type_icon|large_icon|small_icon|icon_path|override_icon)$/;
const ILLU_KEY = /^(picture|illustration|background|override_background|texture|image)$/;
/** UI chrome that is referenced like a picture but is not one. */
const BAD_ILLU = /\/(buttons|particles|progressbars|skins|skinned|hud|component_\w+|frames?|colors)\//i;
const GENERIC_PATH_WORDS = new Set(['gfx', 'interface', 'icons', 'icon', 'types', 'type', 'common', 'of', 'the', 'illustrations', 'textures']);

/** Records where a definition's icon / illustration come from (resolved later by GameIndex.imagesOf). */
function imageHints(body: PNode[], consts: Map<string, string>, meta: Record<string, string>): void
{
    const found: { cat: 'icon' | 'illu'; v: string; conditional: boolean; }[] = [];
    const visit = (list: PNode[], cat: 'icon' | 'illu' | null, depth: number, conditional: boolean): void =>
    {
        const cond = conditional || list.some((c) => c.k === 'trigger');

        for (const c of list)
        {
            const k = c.k ?? '';

            if (typeof c.v === 'string')
            {
                const v = c.v.charCodeAt(0) === 64 ? (consts.get(c.v.slice(1)) ?? c.v) : c.v;

                if (IMAGE_EXT.test(v))
                {
                    const kc = ICON_KEY.test(k) ? 'icon' : ILLU_KEY.test(k) ? 'illu' : cat;

                    if (kc)
                        found.push({ cat: kc, v, conditional: cond });
                }
                else if (depth === 0 && k === 'icon' && v && v !== 'yes' && v !== 'no' && v.charCodeAt(0) !== 64)
                    meta.iconName = detach(v);
                else if ((k === 'reference' && (cat === 'illu' || cat === 'icon')) || (depth === 0 && k === 'theme'))
                {
                    if (depth === 0 && k === 'theme')
                        meta.theme = detach(v);
                    else if (cat === 'illu' && !IMAGE_EXT.test(v) && (!meta.bgRef || !cond))
                        meta.bgRef = detach(v);
                }
            }
            else if (depth < 4 && k !== 'trigger' && k !== 'limit')
            {
                visit(c.v, ICON_KEY.test(k) ? 'icon' : ILLU_KEY.test(k) ? 'illu' : cat, depth + 1, cond);
            }
        }
    };
    visit(body, null, 0, false);
    // classify by folder first (a texture in /icons/ is an icon whatever the key says), then by key
    const isIcon = (x: { cat: string; v: string; }): boolean => /\/icons\//i.test(x.v) || (x.cat === 'icon' && !/\/illustrations\//i.test(x.v));
    const isIllu = (x: { cat: string; v: string; }): boolean => !/\/icons\//i.test(x.v) && !BAD_ILLU.test(x.v) && (x.cat === 'illu' || /\/illustrations\//i.test(x.v));
    const pick = (ok: (x: { cat: string; v: string; }) => boolean): string | undefined => (found.find((x) => ok(x) && !x.conditional) ?? found.find((x) => ok(x)))?.v;
    const icon = pick(isIcon);
    const illu = pick(isIllu);

    if (icon)
        meta.icon = detach(icon);

    if (illu)
        meta.illu = detach(illu);
}

function extractMeta(type: string, node: PNode, consts: Map<string, string> = new Map()): Record<string, string> | undefined
{
    if (!Array.isArray(node.v))
        return undefined;

    const body = node.v;
    const s = (k: string): string | undefined =>
    {
        const c = body.find((x) => x.k === k);
        return c && typeof c.v === 'string' ? c.v : undefined;
    };
    const meta: Record<string, string> = {};

    if (type === T_EVENT)
    {
        const title = firstLocKey(body.find((x) => x.k === 'title'));

        if (title)
            meta.title = detach(title);

        const et = s('type');

        if (et)
            meta.eventType = et;

        if (s('hidden') === 'yes')
            meta.hidden = 'yes';
    }
    else if (type === T_CHARACTER)
    {
        const n = s('name');

        if (n)
            meta.name = detach(n);
    }
    else if (type === 'dynasties' || type === 'dynasty_houses')
    {
        // (keyed by id: the name and prefix are loc keys — dynnp_de + dynn_Hauteville)
        const n = s('name');

        if (n)
            meta.name = detach(n);

        const p = s('prefix');

        if (p)
            meta.prefix = detach(p);
    }
    else if (type === 'traits')
    {
        const c = s('category');

        if (c)
            meta.category = c;
    }
    // nothing but its de jure vassals (the way a mod writes to a title inside it — override.ts titleText): no values of
    // its own; the game merges a title written again into the one it has, so it changes nothing (winningIdx)
    else if (type === T_TITLE && body.every((x) => x.k !== null && TITLE_KEY.test(x.k) && Array.isArray(x.v)))
        meta.path = 'yes';

    if (type !== T_CHARACTER && !type.startsWith('coat_of_arms') && type !== 'genes')
        imageHints(body, consts, meta);

    return Object.keys(meta).length ? meta : undefined;
}

/** Comment block directly above a definition (no blank line in between). */
function leadingComment(src: string, start: number): string | undefined
{
    let lineStart = start;

    while (lineStart > 0 && src.charCodeAt(lineStart - 1) !== 10)
        lineStart--;

    const lines: string[] = [];
    let pos = lineStart - 1; // at '\n' of the previous line

    while (pos > 0 && lines.length < 40)
    {
        let ls = pos;

        while (ls > 0 && src.charCodeAt(ls - 1) !== 10)
            ls--;

        const line = src.slice(ls, pos).trim();

        if (!line.startsWith('#'))
            break;

        lines.unshift(line.replace(/^#+\s?/, ''));
        pos = ls - 1;
    }

    const text = lines.join('\n').trim();

    if (!text || /^[#=\-*\s]*$/.test(text))
        return undefined;

    return detach(text);
}

function snippet(text: string, q: string): string
{
    const i = text.toLowerCase().indexOf(q);
    const s = Math.max(0, i - 40);
    return (s > 0 ? '…' : '') + text.slice(s, i + q.length + 60).replace(/\s+/g, ' ') + (i + q.length + 60 < text.length ? '…' : '');
}

export function isDirectory(p: string): boolean
{
    try
    {
        return statSync(p).isDirectory();
    }
    catch
    {
        return false;
    }
}

/** The feelings an event portrait shows most (the game's portrait animations that are moods). */
const MOODS = new Set(
    (
        'happiness worry thinking admiration shock anger stress fear disapproval schadenfreude scheme shame dismissal sadness flirtation flirtation_left rage ecstasy ' +
        'disbelief beg interested interested_left love paranoia boredom pain grief disgust laugh disappointed pondering idle eyeroll stunned crying manic nervous ' +
        'shiver menacing threatening wailing delirium sick sick_stomach dead severelywounded obsequious_bow prostration stayback acknowledging go_to_your_room ' +
        'happy_teacher stressed_teacher eccentric cough newborn'
    ).split(/\s+/)
);

/** A portrait animation's group for the menus: Mood, Personality, Court & roles, Weapons & war, Horse & hunt, Ceremony & feast, Other. */
function animationGroup(name: string): string
{
    if (MOODS.has(name))
        return 'Mood';

    if (name.startsWith('personality_'))
        return 'Personality';

    if (/horse|jockey|chariot|hunting|falcon|shepherd|carcass/.test(name))
        return 'Horse & hunt';

    if (/sword|spear|axe|dagger|weapon|shield|aggressive|celebrate|^war_|wrestling|^bow_|archer|lance|kamae|coup|yield|hero_flex|war_fan/.test(name))
        return 'Weapons & war';

    if (/wedding|reception|toast|drink|dancing|crowning|prayer|chess|betting|instrument|feast|goblet|dancing_plague/.test(name))
        return 'Ceremony & feast';

    if (/^(marshal|chancellor|steward|spymaster|chaplain|physician|storyteller|emperor|council|throne_room|writing|reading|survey|page_flipping|debating|holding|prisonhouse|prisondungeon|assassin|poison|bribing|eavesdrop|lantern|serving_tray)/.test(name))
        return 'Court & roles';

    return 'Other';
}
