/**
 * The shader merge as a migration rule (migrations.ts `mergeShaders`, migrate.ts kind `mergefx`): the mod's copies of
 * the game's effect files, merged with the game's (shaderMerge.ts), as bytes for the patch mod plus the notes that tell
 * what was added, left out and lost. The work is a pure function of the game's files and the mod's; `shaderWork` keeps
 * the last result, so the plan, the state check and the run (each asking) read and merge the files once.
 *
 * `verifiedShaderWork` goes on from there: it checks the merged files the way the engine will build them (shaders/mergeVerify.ts,
 * docs/shaders.md "Verifying a merge") and repairs what fails, in this order (merge a kept copy of the mod that brings the
 * fault in, do not carry a definition the engine would see twice, leave a mod's effect out with the reason) and checks again.
 * It is asynchronous (the Direct3D compiler is a process, the units are many), so the plan and the run `await` it before they
 * ask `shaderWork`, which then answers with the checked result.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tr, trn } from '../../shared/i18n.ts';
import { child, parse, scalar, type PNode } from '../indexer/parser.ts';
import { verifyLayering, type UnitIssue, type VerifyReport } from '../shaders/mergeVerify.ts';
import { fxDefinitions } from './fxBlocks.ts';
import { sha1 } from './fixesManifest.ts';
import { decodeText, encodeText } from './textCodec.ts';
import { fileSlotCount, textureIdsKnownFor } from '../shaders/textureIds.ts';
import { adaptShaderCalls, definedWithOldParams, SHADER_CALL_CHANGES, type AdaptedCall } from './shaderCalls.ts';
import { emptyNotes, fxKey, mergeShaders, type AddedWhy, type DropReason, type FxMergeNotes, type FxMergeResult, type FxUnserved } from './shaderMerge.ts';
import type { EngineStrings } from './engineStrings.ts';

export interface ShaderFile
{
    /** what the patch mod gets: the merged file in the game's line ends and with its byte order mark; the game's file itself when the mod's copy adds nothing */
    data: Buffer;
    /** sha1 of `data` */
    hash: string;
    /** sha1 of the game's file */
    game: string;
    /** the mod's copy adds something to the game's file */
    carries: boolean;
    notes: FxMergeNotes;
    /** calls of game functions the version gave another parameter list, adapted in the mod's copy (shaderCalls.ts) */
    adapted?: AdaptedCall[];
    /**
     * the mod's effects written into the file that this game version does not draw (`markUndrawn`): the engine asks the file only for the
     * effects its program names (`fixed`, the game file's), and nothing loaded asks for these; `version` the game's, major.minor
     */
    undrawn?: { effects: string[]; fixed: string[]; version: string; };
}

/** What the check of the merged files did. */
export interface ShaderCheck
{
    /** top-level effect files and units (effect x stage) checked */
    roots: number;
    units: number;
    /** the Direct3D compiler ran (otherwise the static rules only) */
    compiled: boolean;
    /** units the compiler ran for but gave no verdict (they passed the static rules only) */
    unchecked: number;
    /** kept copies of the mod merged after all (paths), with what was found in them */
    merged: { rel: string; why: string; }[];
    /** definitions not carried because the engine would see them twice (`file: name`) */
    skipped: string[];
    /** units that still fail and cannot be repaired (the game's own effect, a mod's file that stays in the mod) */
    failing: UnitIssue[];
    /** units whose failure goes away with defines only an `.asset` supplies */
    undecided: UnitIssue[];
    /** units built a second time with the flags of the mod's overlay macros toggled, and those of them that fail (not repaired: the game builds the effects as they are) */
    variantUnits: number;
    variantFailing: UnitIssue[];
    /** files whose overlay macros were left out because the game's effects failed with them (paths), with what was found */
    noOverlay: { rel: string; why: string; }[];
    /** definitions whose disabled lines (shaderMerge.ts `disabledLines`) stay live because the game's effects failed with them disabled */
    noDisabled: { rel: string; def: string; why: string; }[];
    /** definitions that got the mod's added lines (shaderMerge.ts `vertexAdditions`) taken out again because the game's effects failed with them */
    noAdditions: { rel: string; def: string; why: string; }[];
    /** units that fail the same way in the game alone */
    inherited: number;
    inheritedUnits: string[];
    /** rounds of repair */
    rounds: number;
    /** the check itself stopped (what went wrong): the merged files stand unchecked */
    failed?: string;
    /** the game's version, when the engine's texture id table (shaders/textureIds.ts) is not known for it: the sampler rules rest on 1.20's numbers */
    textureIdsFor?: string;
}

export interface ShaderWork
{
    /** by the mod's path of the file */
    files: Map<string, ShaderFile>;
    /** sha1 over the mod's effect files (path and hash): the mod's side of the work, includes of its own among them */
    mod: string;
    /** effects of the mod's own files (the mod's path in `file`) that lack what they need */
    unserved: FxUnserved[];
    /** the check of the merged files, once `verifiedShaderWork` made it */
    check?: ShaderCheck;
}

export interface ShaderInput
{
    /** the mod's copies to merge (its paths: `gfx/FX/pdxmesh.shader`) */
    files: string[];
    /**
     * the mod's copies that need no merge (the game's file, or the new version's already: they stay as they are in the mod):
     * read as merged files all the same (what the other files need from them is demanded of them, and the copy has it),
     * but no bytes or notes are made for them
     */
    keep?: string[];
    /** all the mod's effect files */
    modFiles: string[];
    readMod(rel: string): Buffer | undefined;
    /** the game's file of a path as the game layers it */
    readGame(rel: string): Buffer | undefined;
    /** the game's own top-level effect files (`gfx/FX/pdxwater.shader`): the check also builds those that include a merged file */
    gameShaders?: string[];
    /** the game's version (launcher-settings rawVersion): the texture id table is known for 1.20 only, other versions are told in the notes */
    gameVersion?: string;
    /** a folder for the compiler's verdicts (default: below the system's temporary folder) */
    cacheDir?: string;
    /** the check makes the compiler's verdicts for these (tests); default: the Direct3D compiler where there is one */
    compile?: boolean;
    /** the strings of the game's executable (engineStrings.ts), read when first needed; none: no "not drawn" note (`markUndrawn`) */
    engine?: () => EngineStrings | undefined;
    /** which of the names a loaded file names outside the effect files, localization and `.info` documentation (asked once, only for a candidate of `markUndrawn`) */
    dataNames?: (names: string[]) => Promise<Set<string>>;
    /**
     * the job's look at Cancel, at the check's yields between its slices: what it throws goes on to the caller (a stopped check
     * is no failed one, and nothing of it is kept for the next ask)
     */
    stop?(): void;
}

/**
 * The engine's default effect file of a border type: gfx/map/borders/settings.txt says so in its header ("The right hand side is the
 * texture and uses the default PdxBorder in gfx/FX/pdxborder.shader"); a type without `shader = "…"` is drawn with it. An engine fact,
 * the one file name the border rule does not read from the settings.
 */
export const DEFAULT_BORDER_EFFECT_FILE = 'gfx/FX/pdxborder.shader';

/** The border settings: the types with their texture and, optionally, `shader` / `effect`; the vertical ones with their `shader_file`. */
export const BORDER_SETTINGS = 'gfx/map/borders/settings.txt';
export const VERTICAL_BORDER_SETTINGS = 'gfx/map/borders/settings.vertical_borders';

/** A text without its byte order mark (U+FEFF). */
const withoutBom = (s: string): string => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

/**
 * The effect files the game's border renderer draws with (keys, shaderMerge.ts `fxKey`), from the border settings as the game layers
 * them: the default file (`DEFAULT_BORDER_EFFECT_FILE`) when a type has no `shader = "…"`, every `shader = "…"`, and the vertical
 * borders' `shader_file = "…"`. An `effect = "…"` (`effectname` for the vertical ones) that the type's file does not define is looked
 * for in the other effect files (`findEffect`), and its file counts too. No settings file: the default.
 */
export function borderEffectKeys(settings: string | undefined, vertical: string | undefined, defines: (key: string, effect: string) => boolean, findEffect: (effect: string) => string | undefined): string[]
{
    const out = new Set<string>();
    const add = (file: string, effect: string | undefined): void =>
    {
        const key = fxKey(file);
        out.add(effect && !defines(key, effect) ? findEffect(effect) ?? key : key);
    };
    const blocks = (src: string | undefined): PNode[] => (src === undefined ? [] : parse(withoutBom(src)).filter((n) => Array.isArray(n.v)));

    if (settings === undefined)
        out.add(fxKey(DEFAULT_BORDER_EFFECT_FILE));

    for (const n of settings === undefined ? [] : parse(withoutBom(settings)))
    {
        // (a type written as its texture alone, `my_realm = "border_my_realm.dds"`, is drawn with the default; a vertical type comes from
        // the vertical settings)
        if (!n.k || n.k.startsWith('@') || n.op !== '=' || (Array.isArray(n.v) && scalar(child(n, 'vertical')) === 'yes'))
            continue;

        add(scalar(child(n, 'shader')) || DEFAULT_BORDER_EFFECT_FILE, Array.isArray(n.v) ? scalar(child(n, 'effect')) : undefined);
    }

    for (const n of blocks(vertical))
    {
        const file = scalar(child(n, 'shader_file'));

        if (file)
            add(file, scalar(child(n, 'effectname')));
    }

    return [...out].sort();
}

/** The text as bytes in the style of a model file: its byte order mark, its line ends (a text without line ends takes the model's). */
function styled(text: string, model: Buffer): Buffer
{
    const modelText = textOf(model);
    const eol = modelText.includes('\r\n') ? '\r\n' : modelText.includes('\n') ? '\n' : text.includes('\r\n') ? '\r\n' : '\n';
    const body = text.replace(/\r\n/g, '\n').replace(/\n/g, eol);
    return Buffer.concat([hasBom(model) ? BOM : Buffer.alloc(0), encodeText(body)]);
}

/** Effect files of the mod the merge reads (`.bak` copies and the like are no shaders). */
export const isFxFile = (rel: string): boolean => /^gfx\/fx\/.+\.(shader|fxh)$/i.test(rel);

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const hasBom = (b: Buffer): boolean => b.length >= 3 && b.subarray(0, 3).equals(BOM);
const textOf = (b: Buffer): string => decodeText(hasBom(b) ? b.subarray(3) : b);

/** What the check asked of the merge so far. */
interface Repairs
{
    /** keys of kept copies merged after all */
    merge: Set<string>;
    skip: Set<string>;
    leave: Map<string, DropReason>;
    why: Map<string, string>;
    /** keys of merged files written without their overlay macros, with what was found */
    noOverlay: Map<string, string>;
    /** `file|definition key`: definitions written without their disabled lines carried, with what was found */
    noDisabled: Map<string, string>;
    /** `file|definition key`: definitions written without the mod's added lines (a border file's vertex lines), with what was found */
    noAdditions: Map<string, string>;
}

const noRepairs = (): Repairs => ({ merge: new Set(), skip: new Set(), leave: new Map(), why: new Map(), noOverlay: new Map(), noDisabled: new Map(), noAdditions: new Map() });

interface Made
{
    work: ShaderWork;
    result: FxMergeResult;
    /** the keys written, kept ones not among them */
    written: Map<string, string>;
    /** the keys that stay as the mod has them */
    kept: Set<string>;
}

/** The mod's side and the game's, read once for all rounds. */
interface Prepared
{
    input: ShaderInput;
    mod: string;
    /** the mod's files; the copies of game files with the adapted calls in them */
    modBytes: Map<string, Buffer>;
    /** the calls adapted, by the mod's path */
    adapted: Map<string, AdaptedCall[]>;
    byKey: Map<string, Buffer>;
    relOf: Map<string, string>;
    game(rel: string): Buffer | undefined;
    /** the keys of the effect files the game's border renderer draws with (`borderEffectKeys`): they keep the game's text */
    borders: Set<string>;
    key: string;
}

function prepare(input: ShaderInput): Prepared
{
    const modBytes = new Map<string, Buffer>();
    const gameBytes = new Map<string, Buffer | undefined>();
    const game = (rel: string): Buffer | undefined =>
    {
        if (!gameBytes.has(rel))
            gameBytes.set(rel, input.readGame(rel));

        return gameBytes.get(rel);
    };

    for (const rel of input.modFiles)
    {
        const b = input.readMod(rel);

        if (b)
            modBytes.set(rel, b);
    }

    // the calls of game functions the version gave another parameter list (shaderCalls.ts) are adapted in the files the rule writes or
    // keeps (the mod's copies of the game's files), so the merge carries the adapted code and the check sees what the engine will see.
    // A function a file of the mod's own (no game counterpart) defines with the old list is the mod's: its calls stay.
    const own = new Set<string>();

    for (const [rel, b] of modBytes)
        if (!game(rel))
            for (const name of definedWithOldParams(textOf(b)))
                own.add(name);

    const adapted = new Map<string, AdaptedCall[]>();

    for (const rel of [...input.files, ...(input.keep ?? [])])
    {
        const b = modBytes.get(rel);

        if (!b || !game(rel))
            continue;

        const r = adaptShaderCalls(textOf(b), own);

        if (r.calls.length)
        {
            modBytes.set(rel, Buffer.concat([hasBom(b) ? BOM : Buffer.alloc(0), encodeText(r.text)]));
            adapted.set(rel, r.calls);
        }
    }

    // (by effect file key: the mod's own files, and the game's; the merge reads includes of both)
    const byKey = new Map<string, Buffer>();
    const relOf = new Map<string, string>();

    for (const [rel, b] of modBytes)
    {
        byKey.set(fxKey(rel), b);
        relOf.set(fxKey(rel), rel);
    }

    // the effect files the game's border renderer draws with, from the border settings as the game layers them (the mod's over the
    // game's): those keep the game's text (shaderMerge.ts `FxMergeOptions.borders`)
    const settingsText = (rel: string): string | undefined =>
    {
        const b = input.readMod(rel) ?? input.readGame(rel);
        return b ? textOf(b) : undefined;
    };
    const fxText = (key: string): string | undefined =>
    {
        const b = byKey.get(key) ?? game('gfx/FX/' + key);
        return b ? textOf(b) : undefined;
    };
    const effectsOf = new Map<string, Set<string>>();
    const defines = (key: string, effect: string): boolean =>
    {
        if (!effectsOf.has(key))
        {
            const t = fxText(key);
            effectsOf.set(key, new Set(t === undefined ? [] : [...fxDefinitions(t).defs.keys()].filter((k) => k.startsWith('effect:'))));
        }

        return effectsOf.get(key)!.has('effect:' + effect);
    };
    const findEffect = (effect: string): string | undefined =>
        [...new Set([...input.modFiles, ...(input.gameShaders ?? [])].map(fxKey).filter((k) => /\.shader$/.test(k)))].sort().find((k) => defines(k, effect));
    const borders = new Set(borderEffectKeys(settingsText(BORDER_SETTINGS), settingsText(VERTICAL_BORDER_SETTINGS), defines, findEffect));

    const mod = sha1(Buffer.from([...modBytes].map(([rel, b]) => `${rel.toLowerCase()} ${sha1(b)}`).sort().join('\n')));
    const all = [...input.files, ...(input.keep ?? [])];
    const key = sha1(Buffer.from([mod, [...adapted.keys()].sort().join(), 'borders ' + [...borders].join(), ...all.map((rel) => `${rel} ${input.files.includes(rel) ? '' : '(kept) '}${sha1(game(rel) ?? Buffer.alloc(0))}`)].join('\n')));

    return { input, mod, modBytes, adapted, byKey, relOf, game, borders, key };
}

/** The merge with the repairs made so far. */
function make(p: Prepared, repairs: Repairs): Made
{
    const { input } = p;
    const files = [...input.files, ...(input.keep ?? []).filter((rel) => repairs.merge.has(fxKey(rel)))];
    const keep = (input.keep ?? []).filter((rel) => !repairs.merge.has(fxKey(rel)));
    // (all the mod's effect files go as the own ones: the merge leaves out those the game has)
    const result = mergeShaders(
        {
            game: (k) =>
            {
                const b = p.game('gfx/FX/' + k);
                return b ? textOf(b) : undefined;
            },
            mod: (k) =>
            {
                const b = p.byKey.get(k);
                return b ? textOf(b) : undefined;
            }
        },
        [...files, ...keep].map(fxKey),
        [...p.byKey.keys()],
        { keep: keep.map(fxKey), skip: repairs.skip, leave: repairs.leave, noOverlay: new Set(repairs.noOverlay.keys()), noDisabled: new Set(repairs.noDisabled.keys()), noAdditions: new Set(repairs.noAdditions.keys()), borders: p.borders }
    );
    const merged = result.files;
    const out = new Map<string, ShaderFile>();
    const written = new Map<string, string>();

    const noNotes = emptyNotes;

    for (const rel of files)
    {
        const g = p.game(rel)!;
        const m = merged.get(fxKey(rel));
        const carries = !!m && m.text !== m.game;
        // (a file with the mod's code in it is the mod's copy replaced: it keeps that copy's byte order mark and line ends; the game's
        // file itself, when there is nothing of the mod's in it, keeps the game's; so does a border file with the mod's vertex lines in
        // the game's text: the engine caches a stage by its source text, line ends included, and its pixel stages stay the game's entries)
        const data = carries ? styled(m.text, m.notes.border ? g : p.modBytes.get(rel) ?? g) : g;
        // (an adapted call counts for the notes when the code it is in is carried: a definition the mod changed stays the game's)
        const text = m ? m.text.replace(/\r\n/g, '\n') : '';
        const base = m ? m.game.replace(/\r\n/g, '\n') : '';
        const there = (p.adapted.get(rel) ?? []).filter((c) => text.split(c.site).length > base.split(c.site).length);
        out.set(rel, { data, hash: sha1(data), game: sha1(g), carries, notes: m?.notes ?? noNotes(), ...(there.length ? { adapted: there } : {}) });
        written.set(fxKey(rel), m?.text ?? textOf(g));
    }

    // a copy that stays in the mod calls a function the version changed: the patch mod gets the copy with the calls adapted, nothing else
    // changed (the file is the engine's file, `keep`; the others are merged against its text)
    for (const rel of keep)
    {
        const calls = p.adapted.get(rel);
        const data = p.modBytes.get(rel);

        if (calls && data)
            out.set(rel, { data, hash: sha1(data), game: sha1(p.game(rel)!), carries: true, notes: noNotes(), adapted: calls });
    }

    const work: ShaderWork = { files: out, mod: p.mod, unserved: result.unserved.map((u) => ({ ...u, file: p.relOf.get(u.file) ?? u.file })) };
    return { work, result, written, kept: new Set(keep.map(fxKey)) };
}

let last: { key: string; work: ShaderWork; } | undefined;

export function shaderWork(input: ShaderInput): ShaderWork
{
    const p = prepare(input);

    if (last?.key === p.key)
        return last.work;

    const made = make(p, noRepairs());
    last = { key: p.key, work: made.work };
    return made.work;
}

/** At most this many rounds of repair (each round merges and checks again). */
const MAX_ROUNDS = 6;

/** The text of a file as the engine loads it with the merged files written. */
function layered(p: Prepared, made: Made): (key: string) => string | undefined
{
    return (key) =>
    {
        const w = made.written.get(key);

        if (w !== undefined)
            return w;

        const m = p.byKey.get(key);

        if (m)
            return textOf(m);

        const g = p.game('gfx/FX/' + key);
        return g ? textOf(g) : undefined;
    };
}

const gameOnly = (p: Prepared) => (key: string): string | undefined =>
{
    const g = p.game('gfx/FX/' + key);
    return g ? textOf(g) : undefined;
};

/** Names the identifiers a finding is about on both sides, as `file|name` (what the merge's `skip` takes). */
const sidesOf = (f: { file: string; partner?: string; }): string[] => [f.file, f.partner ?? ''].filter(Boolean).map(fxKey);

/** Findings that mean a definition is there twice. */
const isDuplicate = (f: { kind: string; message: string; }): boolean => f.kind === 'cbuffer-member' || f.kind === 'duplicate-declaration' || f.kind === 'duplicate-definition' || (f.kind === 'compile' && /redefinition/.test(f.message));

/** The first line of a finding for the notes. */
const firstLine = (issue: UnitIssue): string => issue.findings[0]?.message.split('\n')[0] ?? '';

/**
 * What to change after a check, or nothing. Per failing unit, in this order: a kept copy of the mod among the files the findings
 * name is merged; a definition the findings say is there twice is not carried (from the files named); a mod's effect the unit
 * belongs to is left out. A unit none of these helps is `failing`.
 */
function repair(p: Prepared, made: Made, report: VerifyReport, repairs: Repairs, tried: Set<string>): { changed: boolean; failing: UnitIssue[]; }
{
    let changed = false;
    // (what each kept copy brings into the include tree that the game's own copy does not: a file a finding names can arrive through it)
    const read = layered(p, made);
    const game = gameOnly(p);
    const closure = (reader: (key: string) => string | undefined, key: string, seen = new Set<string>()): Set<string> =>
    {
        const text = seen.has(key) ? undefined : reader(key);

        if (text !== undefined)
        {
            seen.add(key);

            for (const i of fxDefinitions(text).includes)
                closure(reader, fxKey(i), seen);
        }

        return seen;
    };
    const brings = new Map<string, Set<string>>();

    for (const k of made.kept)
    {
        const theirs = closure(game, k);
        brings.set(k, new Set([...closure(read, k)].filter((x) => !theirs.has(x))));
    }

    const failing: UnitIssue[] = [];
    // (the merged files and the effects each carries)
    const carriers = new Map<string, Set<string>>();

    for (const [key, m] of made.result.files)
        if (!made.kept.has(key))
            carriers.set(key, new Set(m.notes.effects));

    // (one kind of repair per round, the first that applies to any unit: merging a kept copy may fix what a skipped definition or a left-out
    // effect would have been for, and a skipped definition what a left-out effect would have been for)
    const merges: { kept: string; why: string; }[] = [];
    const skips: string[] = [];

    for (const issue of report.issues)
    {
        for (const f of issue.findings)
        {
            for (const side of sidesOf(f))
                for (const [kept, extra] of brings)
                    if ((kept === side || extra.has(side)) && !merges.some((m) => m.kept === kept))
                        merges.push({ kept, why: f.message.split('\n')[0] });

            if (isDuplicate(f))
            {
                const name = f.name || /'(\w+)'/.exec(f.message)?.[1] || '';

                for (const side of sidesOf(f))
                {
                    const k = `${side}|${name}`;

                    if (name && carriers.has(side) && !tried.has(k) && !skips.includes(k))
                        skips.push(k);
                }
            }
        }
    }

    if (merges.length)
    {
        for (const m of merges)
        {
            repairs.merge.add(m.kept);
            repairs.why.set(m.kept, m.why);
        }

        return { changed: true, failing };
    }

    if (skips.length)
    {
        for (const k of skips)
        {
            tried.add(k);
            repairs.skip.add(k);
        }

        return { changed: true, failing };
    }

    // 2a. the lines the merge carried into a definition of the game's go when a unit fails that runs it (the main of the failing stage, or
    // a function in the unit's include tree): first the mod's added lines (a border file's vertex lines: shaderMerge `vertexAdditions`),
    // then, if it still fails, the disabled-line carry (`disabledLines`: its lines stay live, as the
    // game has them)
    const runs = (pick: (n: FxMergeNotes) => { key: string; def: string; }[], done: Map<string, string>): Map<string, string> =>
    {
        const undo = new Map<string, string>();

        for (const issue of report.issues)
        {
            const effectDef = fxDefinitions(read(issue.file) ?? '').defs.get('effect:' + issue.effect)?.[0];
            const main = new RegExp(`${issue.stage === 'vs' ? 'VertexShader' : 'PixelShader'}\\s*=\\s*"?(\\w+)"?`).exec(effectDef?.text ?? '')?.[1];

            for (const k of closure(read, issue.file))
                for (const d of made.kept.has(k) || !made.result.files.has(k) ? [] : pick(made.result.files.get(k)!.notes))
                {
                    const id = `${k}|${d.key}`;

                    if (!done.has(id) && !undo.has(id) && (d.key.startsWith('fn:') || (d.key.startsWith('main:') && d.def === main)))
                        undo.set(id, `${issue.effect} (${stageName(issue.stage)}): ${firstLine(issue)}`);
                }
        }

        return undo;
    };

    for (const [pick, done] of [[(n: FxMergeNotes) => n.vertexLines, repairs.noAdditions], [(n: FxMergeNotes) => n.disabled, repairs.noDisabled]] as const)
    {
        const undo = runs(pick, done);

        if (undo.size)
        {
            for (const [id, why] of undo)
                done.set(id, why);

            return { changed: true, failing };
        }
    }

    // 2b. the overlay macros of a merged file (shaderMerge `overlayMacros`) go when a unit fails with them: one built with their flag that
    // passes without it (its variant), or a unit nothing else repairs (below); the file is written without them, as before they were
    // carried, rather than an effect left out for them
    const overlaid = new Map<string, string[]>();

    for (const [key, m] of made.result.files)
        if (!made.kept.has(key) && m.notes.macros.length && !repairs.noOverlay.has(key))
            overlaid.set(key, m.notes.flags);

    const overlayIn = (issue: UnitIssue): string[] => (overlaid.size ? [...closure(read, issue.file)].filter((k) => overlaid.has(k)) : []);
    const noOverlay = new Map<string, string>();

    for (const issue of report.issues)
    {
        const set = new Set((issue.defines ?? []).map((d) => d.split(/\s+/)[0]));
        const without = !report.variantIssues.some((v) => v.file === issue.file && v.effect === issue.effect && v.stage === issue.stage);

        for (const k of overlayIn(issue))
            if (without && overlaid.get(k)!.some((fl) => set.has(fl)) && !noOverlay.has(k))
                noOverlay.set(k, `${issue.effect} (${stageName(issue.stage)}): ${firstLine(issue)}`);
    }

    if (noOverlay.size)
    {
        for (const [k, why] of noOverlay)
            repairs.noOverlay.set(k, why);

        return { changed: true, failing };
    }

    // 3. the mod's effect that fails goes (the game's stays)
    for (const issue of report.issues)
    {
        const key = `${issue.file}|${issue.effect}`;
        let left = false;

        // (the effect itself if the mod's, and the mod's effects that need a definition the findings name: a game effect of another
        // file fails because of what one of those carries)
        const names = issue.findings.flatMap((f) => [f.name, f.partnerName, /'(\w+)'/.exec(f.message)?.[1]]).filter((n): n is string => !!n);

        for (const [file, effects] of carriers)
        {
            const out = new Set<string>();

            if (effects.has(issue.effect))
                out.add(issue.effect);

            for (const n of names)
                for (const e of made.result.files.get(file)?.notes.needs[n] ?? [])
                    out.add(e);

            for (const e of out)
            {
                left = true;

                if (!repairs.leave.has(`${file}|${e}`))
                {
                    repairs.leave.set(`${file}|${e}`, { kind: 'verify', def: e, name: issue.stage, detail: firstLine(issue) });
                    changed = true;
                }
            }
        }

        // (a unit nothing above repairs, in the include tree of a file with overlay macros: the file goes without them)
        const over = left ? [] : overlayIn(issue).filter((k) => !repairs.noOverlay.has(k));

        for (const k of over)
        {
            repairs.noOverlay.set(k, `${issue.effect} (${stageName(issue.stage)}): ${firstLine(issue)}`);
            changed = true;
        }

        if (!left && !over.length && !failing.some((x) => `${x.file}|${x.effect}` === key && x.stage === issue.stage))
            failing.push(issue);
    }

    return { changed, failing };
}

/**
 * The merge, checked and repaired. The check builds every Effect of the top-level files the merge touched (the written ones, the
 * mod's own, and the game's that include any of them) for both stages the way the engine does and runs the static rules and, where
 * this machine has it, the Direct3D compiler on them.
 */
export async function verifiedShaderWork(input: ShaderInput): Promise<ShaderWork>
{
    const p = prepare(input);
    const cached = last?.key === p.key ? last.work : undefined;

    if (cached?.check)
        return cached;

    const repairs = noRepairs();
    const tried = new Set<string>();
    const d3d = { cacheDir: input.cacheDir ?? join(tmpdir(), 'crusaderpope', 'shader-verdicts') };
    const roots = [...new Set([...input.files, ...(input.keep ?? []), ...input.modFiles, ...(input.gameShaders ?? [])].map(fxKey).filter((k) => /\.shader$/.test(k)))];
    let made = make(p, repairs);
    let report: VerifyReport = { roots: 0, units: 0, issues: [], undecided: [], inherited: 0, inheritedUnits: [], compiled: false, unchecked: 0, variantUnits: 0, variantIssues: [] };
    let failing: UnitIssue[] = [];
    let rounds = 0;
    let failed: string | undefined;

    for (; rounds < MAX_ROUNDS; rounds++)
    {
        // (the keys whose text is not the game's)
        const read = layered(p, made);
        const game = gameOnly(p);
        const changed = new Set<string>();

        for (const [key, text] of made.written)
            if (text !== game(key))
                changed.add(key);

        for (const key of p.byKey.keys())
            if (!made.written.has(key) && (game(key) === undefined || read(key) !== game(key)))
                changed.add(key);

        // (the flags the overlay macros of a written file are under: its effects are built with and without them)
        const variants: Record<string, string[]> = {};

        for (const [key, m] of made.result.files)
            if (made.written.has(key) && m.notes.flags.length)
                variants[key] = m.notes.flags;

        // (the job's Cancel, looked at where the check yields: thrown on, not taken for a failed check)
        let stopped = false;
        const tick = input.stop ? async (): Promise<void> =>
        {
            try
            {
                input.stop!();
            }
            catch (e)
            {
                stopped = true;
                throw e;
            }

            await new Promise((r) => setImmediate(r));
        } : undefined;

        try
        {
            report = await verifyLayering({ read, baseline: game, roots, changed, compile: input.compile, d3d, variants, ...(tick ? { tick } : {}) });
        }
        catch (e)
        {
            if (stopped)
                throw e;

            // (the merge stands, and says it is unchecked)
            failed = e instanceof Error ? e.message : String(e);
            break;
        }

        const r = repair(p, made, report, repairs, tried);
        failing = r.failing;

        if (!r.changed)
            break;

        made = make(p, repairs);
    }

    const check: ShaderCheck = {
        roots: report.roots,
        units: report.units,
        compiled: report.compiled,
        unchecked: report.unchecked,
        merged: [...repairs.merge].map((key) => ({ rel: p.relOf.get(key) ?? 'gfx/FX/' + key, why: repairs.why.get(key) ?? '' })),
        skipped: [...repairs.skip].map((s) => s.replace('|', ': ')),
        failing,
        ...(failed ? { failed } : {}),
        ...(input.gameVersion && !textureIdsKnownFor(input.gameVersion) ? { textureIdsFor: input.gameVersion } : {}),
        undecided: report.undecided,
        variantUnits: report.variantUnits,
        variantFailing: report.variantIssues,
        noOverlay: [...repairs.noOverlay].map(([key, why]) => ({ rel: p.relOf.get(key) ?? 'gfx/FX/' + key, why })),
        noDisabled: [...repairs.noDisabled].map(([id, why]) => repairedDef(p, id, why)),
        noAdditions: [...repairs.noAdditions].map(([id, why]) => repairedDef(p, id, why)),
        inherited: report.inherited,
        inheritedUnits: report.inheritedUnits,
        rounds
    };
    made.work.check = check;

    try
    {
        await markUndrawn(p, made);
    }
    catch
    {
        // (no signal: the notes stay as they are)
    }

    // (the next ask for this input is this result)
    last = { key: p.key, work: made.work };
    return made.work;
}

/**
 * EFFECTS THE GAME DOES NOT DRAW (docs/shaders.md). An effect the merge adds to the patch mod's copy of a game effect file is one this
 * game version never asks for when (1) the executable names the file's path (the engine opens the file itself), (2) every effect of
 * the game's own file and of its include tree is a string of the executable, and no loaded data file names any of them (the engine
 * asks the file for its fixed names only (a file whose names it composes, `…Skirt`, or one data selects from, a border's `effect = …`,
 * is no such file)), (3) the added effect is no string of the executable, and (4) no loaded file other than effect files,
 * localization and `.info` documentation names it. AGOT and Elder Kings 2: `surroundmap_shadow` (1.20 composites the cloud shadow in
 * `PS_surroundmap` and no longer makes that draw). The effect stays in the file (the written file is the same as without this signal);
 * only the notes say so (`ShaderFile.undrawn`). Nothing without the executable, the game's version or a reader of the loaded files; the
 * loaded files are read only when a file has such a candidate.
 */
async function markUndrawn(p: Prepared, made: Made): Promise<void>
{
    const { input } = p;
    const version = /^(\d+\.\d+)/.exec(input.gameVersion ?? '')?.[1];

    if (!version || !input.engine || !input.dataNames)
        return;

    // (the effects of the game's own file and of its include tree, as the game layers them)
    const gameEffects = (rel: string): string[] =>
    {
        const out: string[] = [];
        const seen = new Set<string>();
        const visit = (key: string): void =>
        {
            const b = seen.has(key) ? undefined : p.game('gfx/FX/' + key);
            seen.add(key);

            if (!b)
                return;

            const file = fxDefinitions(textOf(b));

            for (const inc of file.includes)
                visit(fxKey(inc));

            for (const k of file.defs.keys())
                if (k.startsWith('effect:') && !out.includes(k.slice(7)))
                    out.push(k.slice(7));
        };
        visit(fxKey(rel));
        return out;
    };
    const candidates: { file: ShaderFile; fixed: string[]; added: string[]; }[] = [];
    let engine: EngineStrings | undefined;
    let read = false;

    for (const [rel, f] of made.work.files)
    {
        const added = made.result.files.get(fxKey(rel))?.notes.effects ?? [];

        if (!added.length)
            continue;

        if (!read)
        {
            engine = input.engine();
            read = true;
        }

        if (!engine)
            return;

        if (!engine.paths.has(rel.toLowerCase()))
            continue;

        const fixed = gameEffects(rel);
        const unnamed = added.filter((e) => !engine!.names.has(e));

        if (fixed.length && unnamed.length && fixed.every((e) => engine!.names.has(e)))
            candidates.push({ file: f, fixed, added: unnamed });
    }

    if (!candidates.length)
        return;

    const named = await input.dataNames([...new Set(candidates.flatMap((c) => [...c.fixed, ...c.added]))]);

    for (const c of candidates)
    {
        const effects = c.added.filter((e) => !named.has(e));

        if (effects.length && !c.fixed.some((e) => named.has(e)))
            c.file.undrawn = { effects, fixed: c.fixed, version };
    }
}

/** A repair of a definition (`file|definition key`) for the check: the mod's path, the definition's name, what was found. */
function repairedDef(p: Prepared, id: string, why: string): { rel: string; def: string; why: string; }
{
    const key = id.slice(0, id.indexOf('|'));
    const def = id.slice(id.indexOf('|') + 1);
    return { rel: p.relOf.get(key) ?? 'gfx/FX/' + key, def: /^(?:main:\w+:|fn:)(\w+)/.exec(def)?.[1] ?? def, why };
}

/** The mod's paths a verified work merges that the rule listed as kept. */
export function mergedAfterAll(work: ShaderWork, input: Pick<ShaderInput, 'files'>): string[]
{
    return [...work.files.keys()].filter((rel) => !input.files.includes(rel));
}

/** A stage in words. */
const stageName = (s: string): string => (s === 'vs' ? tr('vertex') : s === 'ps' ? tr('pixel') : s);

/** A reason an effect was left out, in words. */
function reasonText(r: DropReason): string
{
    switch (r.kind)
    {
        case 'stage':
            return tr('{def} is needed in the {stage} shader, which it is not written for', { def: r.def, stage: stageName(r.name) });
        case 'unavailable':
            return tr('{def} uses {name}, which no file the game or the mod provides here has', { def: r.def, name: r.name });
        case 'field':
            return tr('{def} reads the field {name}, which the game’s struct or buffer lacks', { def: r.def, name: r.name });
        case 'define':
        {
            const [mod, game] = (r.detail ?? '|').split(' | ');
            return tr('{def} relies on {name} being {mod} (the game’s is {game})', { def: r.def, name: r.name, mod, game });
        }
        case 'clash':
            return tr('{def} needs {name}, a define of the mod’s that the game’s own code uses too: carried, it would change that code', { def: r.def, name: r.name });
        case 'binding':
        {
            const [index, other] = (r.detail ?? ' | ').split(' | ');
            return tr('{def} needs the sampler {name}, whose Index {index} the engine gives the same texture id as the game’s {other} in the same stage (it refuses two samplers with one id), and the sampler cannot move to another Index', { def: r.def, name: r.name, index, other });
        }
        case 'compute':
            return tr('{def} uses a compute shader, whose code the merge does not read', { def: r.def });
        case 'demand':
            return tr('{def} needs {name} from {file}, which could not be carried there', { def: r.def, name: r.name, file: r.detail ?? '' });
        case 'missing':
            return tr('{def} names {name}, which is defined nowhere', { def: r.def, name: r.name });
        case 'verify':
            return tr('{def} fails the check of the merged files in the {stage} shader — {detail}', { def: r.def, stage: stageName(r.name), detail: r.detail ?? '' });
    }
}

/** Why a line the mod's copy adds to a border file's vertex stage is not carried (shaderMerge.ts `AddedWhy`), in words. */
function vertexWhy(why: AddedWhy, name: string): string
{
    switch (why)
    {
        case 'statement':
            return tr('not one complete statement on its line');
        case 'preprocessor':
            return tr('under a preprocessor condition of the mod’s');
        case 'target':
            return tr('it does not write a local that the game’s main declares');
        case 'field':
            return tr('the field {name}, which the game’s structs lack', { name });
        case 'name':
            return tr('{name}, which the game’s vertex stage does not have there', { name });
        case 'mod':
            return tr('{name}, which the mod’s copy defines its own way', { name });
        case 'place':
            return tr('no line both mains share right before it');
        case 'with':
            return tr('it goes with a line of the mod’s at the same place that is not carried');
    }
}

/** The note of the calls adapted in a file: which functions, where, and what was passed. */
function adaptedNote(rel: string, calls: AdaptedCall[]): string
{
    const names = [...new Set(calls.map((c) => c.name))];
    const list = names.map((name) =>
    {
        const change = SHADER_CALL_CHANGES.find((c) => c.name === name)!;
        const lines = calls.filter((c) => c.name === name).map((c) => c.line).join(', ');
        return tr('{name} (line {lines}) gets {value} for {param}', { name, lines, value: change.append, param: change.param });
    }).join('; ');
    return trn(
        '{file}: {n} call of a game function that {version} gave another parameter list, adapted — {list}; the value keeps what the old call did',
        '{file}: {n} calls of game functions that {version} gave another parameter list, adapted — {list}; the value keeps what the old call did',
        calls.length,
        { file: rel, list, version: SHADER_CALL_CHANGES.find((c) => c.name === names[0])!.since }
    );
}

/** Up to `n` of a list, then "…". */
const shortList = (list: string[], n = 6): string => (list.length > n ? list.slice(0, n).join(', ') + ', …' : list.join(', '));

/** The effects of a list of units, each once, with the stages they fail in. */
function unitList(units: UnitIssue[]): string
{
    const by = new Map<string, Set<string>>();

    for (const u of units)
    {
        // (a variant build: with or without the flags)
        const v = (u.variant ?? []).map((x) => (x.startsWith('+') ? tr('with {name}', { name: x.slice(1) }) : tr('without {name}', { name: x.slice(1) }))).join(', ');
        const k = `${u.file}: ${u.effect}${v ? ` [${v}]` : ''}`;
        (by.get(k) ?? by.set(k, new Set()).get(k)!).add(stageName(u.stage));
    }

    return [...by].map(([k, s]) => `${k} (${[...s].join(', ')})`).join('; ');
}

/**
 * What the merge did, in words (the plan shows them, the result keeps them): per file the mod's effects added with the
 * definitions they need, the effects left out and why, the definitions the mod changed that stay the game's (all of them: they
 * are what the owner decides on, and what a bisect looks at, so no list is cut), the effects of the mod's own files that
 * lack what they need, and what the check of the merged files found.
 */
export function shaderNotes(work: ShaderWork): string[]
{
    const out: string[] = [];
    const fields: string[] = [];
    const skipped: string[] = [];
    const refused: string[] = [];

    for (const [rel, f] of work.files)
    {
        const n = f.notes;
        const others = Math.max(0, n.carried.length - n.effects.length);
        fields.push(...n.fields);
        skipped.push(...n.skippedFields);
        refused.push(...n.refused);

        if (n.effects.length)
        {
            const needs = trn('{n} other definition needed', '{n} other definitions needed', others);
            const u = f.undrawn;
            const vars = u ? { file: rel, needs, version: u.version, list: u.effects.join(', '), fixed: u.fixed.join(', ') } : undefined;

            // (the mod's effects this game version does not draw, `markUndrawn`: all of them (the count says so), or some (a line of their own))
            if (u && vars && u.effects.length === n.effects.length)
                out.push(others ?
                    trn('{file}: {n} effect of the mod added that {version} does not draw ({needs}) — {list}: the game draws this file only with the effects its program names ({fixed}), and no loaded file asks for this one, so it is carried but has no effect', '{file}: {n} effects of the mod added that {version} does not draw ({needs}) — {list}: the game draws this file only with the effects its program names ({fixed}), and no loaded file asks for these, so they are carried but have no effect', n.effects.length, vars) :
                    trn('{file}: {n} effect of the mod added that {version} does not draw — {list}: the game draws this file only with the effects its program names ({fixed}), and no loaded file asks for this one, so it is carried but has no effect', '{file}: {n} effects of the mod added that {version} does not draw — {list}: the game draws this file only with the effects its program names ({fixed}), and no loaded file asks for these, so they are carried but have no effect', n.effects.length, vars));
            else
            {
                out.push(others ?
                    trn('{file}: {n} effect of the mod added ({needs})', '{file}: {n} effects of the mod added ({needs})', n.effects.length, { file: rel, needs }) :
                    trn('{file}: {n} effect of the mod added', '{file}: {n} effects of the mod added', n.effects.length, { file: rel }));

                if (u && vars)
                    out.push(trn('{file}: {n} of these effects {version} does not draw — {list}: the game draws this file only with the effects its program names ({fixed}), and no loaded file asks for it', '{file}: {n} of these effects {version} does not draw — {list}: the game draws this file only with the effects its program names ({fixed}), and no loaded file asks for them', u.effects.length, vars));
            }
        }
        else if (n.carried.length && n.macros.length)
            out.push(trn('{file}: {n} definition of the mod added (the functions the mod’s macros name and what they need, or what effects in other files need)', '{file}: {n} definitions of the mod added (the functions the mod’s macros name and what they need, or what effects in other files need)', n.carried.length, { file: rel }));
        else if (n.carried.length)
            out.push(trn('{file}: {n} definition of the mod added (effects in other files need it)', '{file}: {n} definitions of the mod added (effects in other files need them)', n.carried.length, { file: rel }));

        if (n.dropped.length)
            out.push(trn('{file}: {n} effect of the mod left out — {list}', '{file}: {n} effects of the mod left out — {list}', n.dropped.length, { file: rel, list: n.dropped.map((d) => `${d.name}: ${reasonText(d.reason)}`).join('; ') }));

        if (n.moved.length)
            out.push(trn('{file}: {n} sampler of the mod moved to a free Index (the engine gives Index 32 the texture id of the game’s shadow map) — {list}', '{file}: {n} samplers of the mod moved to a free Index (the engine gives Index 32 the texture id of the game’s shadow map) — {list}', n.moved.length, { file: rel, list: n.moved.join(', ') }));

        if (n.movedPast.length)
            out.push(trn('{file}: {n} sampler of the mod moved to a free Index below {slots}: the game has {slots} slots for texture files (Index 0 to {last}), a file on a higher Index does not reach the shader — {list}', '{file}: {n} samplers of the mod moved to a free Index below {slots}: the game has {slots} slots for texture files (Index 0 to {last}), a file on a higher Index does not reach the shader — {list}', n.movedPast.length, { file: rel, slots: fileSlotCount(), last: fileSlotCount() - 1, list: n.movedPast.join(', ') }));

        if (n.values.length)
            out.push(trn('{file}: {n} value of the mod kept in the game’s file (the mod’s value, the game’s in brackets): {list}', '{file}: {n} values of the mod kept in the game’s file (the mod’s value, the game’s in brackets): {list}', n.values.length, { file: rel, list: n.values.map((v) => `${v.name} ${v.mod} (${v.game})`).join('; ') }));

        if (n.macros.length)
        {
            const list = n.macros.map((m) => (m.stages.length === 2 ? m.name : `${m.name} (${m.stages.map(stageName).join(', ')})`)).join(', ');
            out.push(trn('{file}: {n} macro of the mod’s {includes} over a name the game’s code uses written into the file, with the functions it names — {list}', '{file}: {n} macros of the mod’s {includes} over names the game’s code uses written into the file, with the functions they name — {list}', n.macros.length, { file: rel, includes: n.overlays.join(', '), list }));
        }

        if (n.macrosLeft.length)
            out.push(trn('{file}: {n} macro of the mod not written for a shader stage — {list}', '{file}: {n} macros of the mod not written for a shader stage — {list}', n.macrosLeft.length, {
                file: rel,
                list: n.macrosLeft.map((m) => m.why === 'declared' ?
                    tr('{name} ({stage}): {def} declares that name, the macro would turn the declaration into a call', { name: m.name, stage: stageName(m.stage), def: m.def }) :
                    m.why === 'unused' ?
                        (m.detail === 'replaced' ?
                            tr('{name} ({stage}): the mod’s copy no longer calls this hook of the game’s and puts nothing of its own in its place, so the game’s call keeps the game’s function', { name: m.name, stage: stageName(m.stage) }) :
                            tr('{name} ({stage}): no file of the mod calls this hook of the game’s, so the game’s call keeps the game’s function', { name: m.name, stage: stageName(m.stage) })) :
                    m.why === 'unfit' ?
                        tr('{name} ({stage}): the mod’s copy calls {def} in its place, but {detail}, which {def} reaches through another hook, does not fit the game’s call — the game’s call keeps the game’s function', { name: m.name, stage: stageName(m.stage), def: m.def, detail: m.detail ?? '' }) :
                    tr('{name} ({stage}): what it names cannot be carried ({detail})', { name: m.name, stage: stageName(m.stage), detail: m.detail ?? m.def })).join('; ')
            }));

        if (n.remapped.length)
            out.push(trn('{file}: {n} hook of the game’s pointed at the function the mod’s copy reaches in its place (the mod no longer calls the hook itself; what the mod’s own call adds around it is not carried) — {list}', '{file}: {n} hooks of the game’s pointed at the functions the mod’s copy reaches in their place (the mod no longer calls the hooks itself; what the mod’s own calls add around them is not carried) — {list}', n.remapped.length, {
                file: rel,
                list: n.remapped.map((r) => tr('{name} ({stage}) → {target}: the mod’s copy calls {via} there, which reaches {hook}', { name: r.name, stage: stageName(r.stage), target: r.target, via: r.via, hook: r.hook })).join('; ')
            }));

        if (n.renamed.length)
            out.push(trn('{file}: {n} name the game’s code declares renamed, so that the mod’s macro over that name applies (only the name changes) — {list}', '{file}: {n} names the game’s code declares renamed, so that the mod’s macros over those names apply (only the names change) — {list}', n.renamed.length, {
                file: rel,
                list: n.renamed.map((r) => r.kind === 'parameter' ?
                    tr('{def}: parameter {name} renamed {to}', { def: r.def, name: r.name, to: r.to }) :
                    tr('{def}: local {name} renamed {to}', { def: r.def, name: r.name, to: r.to })).join('; ')
            }));

        if (n.flagged.length)
            out.push(trn('{file}: {flags} added to the Defines of {n} game effect, as the mod’s copy has it (the macros are written under it) — {list}', '{file}: {flags} added to the Defines of {n} game effects, as the mod’s copies have it (the macros are written under it) — {list}', n.flagged.length, { file: rel, flags: n.flags.join(', '), list: n.flagged.join(', ') }));

        if (n.border)
        {
            const b = n.border;
            const parts = [
                ...(b.macros.length ? [trn('the macro {list} of the mod’s {includes}', 'the macros {list} of the mod’s {includes}', b.macros.length, { list: b.macros.join(', '), includes: b.overlays.join(', ') })] : []),
                ...(b.effects.length ? [trn('{n} effect of the mod ({list})', '{n} effects of the mod ({list})', b.effects.length, { list: b.effects.join(', ') })] : []),
                ...(b.others ? [trn('{n} other definition of the mod’s copy', '{n} other definitions of the mod’s copy', b.others)] : []),
                ...(n.vertexLeft.length ? [trn('{n} line the mod’s copy adds to the vertex stage — {list}', '{n} lines the mod’s copy adds to the vertex stage — {list}', n.vertexLeft.length, { list: n.vertexLeft.map((x) => `${x.def}: \`${x.line}\` (${vertexWhy(x.why, x.name)})`).join(', ') })] : [])
            ];
            const why = tr('{file}: the game’s border renderer draws with this file, so it keeps the game’s version and the borders show the game’s fog of war, not the mod’s (with the mod’s code and texture samplers in it the game drew the borders as opaque strips)', { file: rel });
            out.push(parts.length ? tr('{why} — not written: {list}', { why, list: parts.join('; ') }) : why);
        }

        if (n.vertexLines.length)
        {
            const count = n.vertexLines.reduce((s, d) => s + d.lines.length, 0);
            const list = n.vertexLines.map((d) => d.def + ': ' + d.lines.map((l) => '`' + l + '`').join(', ')).join('; ');
            out.push(trn('{file}: {n} line the mod’s copy adds to the vertex stage is carried into the game’s file: it places the border’s geometry and uses only names the game’s code has, the declarations and the pixel stage stay the game’s — {list}', '{file}: {n} lines the mod’s copy adds to the vertex stage are carried into the game’s file: they place the border’s geometry and use only names the game’s code has, the declarations and the pixel stage stay the game’s — {list}', count, { file: rel, list }));
        }

        if (n.lost.length)
            out.push(trn('{file}: {n} definition the mod changed stays the game’s: {list}', '{file}: {n} definitions the mod changed stay the game’s: {list}', n.lost.length, { file: rel, list: n.lost.join(', ') }));

        if (n.disabled.length)
        {
            const count = n.disabled.reduce((s, d) => s + d.lines.length, 0);
            const list = n.disabled.map((d) => d.def + ': ' + d.lines.map((l) => '`' + l + '`').join(', ')).join('; ');
            out.push(trn('{file}: {n} line the mod’s copy disabled is disabled in the game’s definition too, the rest of it stays the game’s — {list}', '{file}: {n} lines the mod’s copy disabled are disabled in the game’s definitions too, the rest of them stays the game’s — {list}', count, { file: rel, list }));
        }

        const used = n.disabledLeft.filter((x) => x.why === 'used');

        if (used.length)
            out.push(trn('{file}: {n} line the mod’s copy disabled stays live in the game’s definition: it declares or uses a name that a line the game’s definition keeps still uses — {list}', '{file}: {n} lines the mod’s copy disabled stay live in the game’s definitions: they declare or use a name that a line the game’s definition keeps still uses — {list}', used.length, { file: rel, list: used.map((x) => x.def + ': `' + x.line + '` (' + x.name + ')').join('; ') }));


        if (f.adapted?.length)
            out.push(adaptedNote(rel, f.adapted));
    }

    const own = new Map<string, FxUnserved[]>();

    for (const u of work.unserved)
        (own.get(u.file) ?? own.set(u.file, []).get(u.file)!).push(u);

    for (const [rel, list] of own)
        out.push(trn('{file}: {n} effect of the mod’s own file lacks what it needs from the files the patch mod replaces — {list}', '{file}: {n} effects of the mod’s own file lack what they need from the files the patch mod replaces — {list}', list.length, { file: rel, list: list.map((u) => `${u.effect}: ${reasonText(u.reason)}`).join('; ') }));

    if (fields.length)
        out.push(trn('{n} field of the mod’s vertex structs appended to the game’s: {list}', '{n} fields of the mod’s vertex structs appended to the game’s: {list}', fields.length, { list: shortList(fields) }));

    if (refused.length)
        out.push(trn('{n} field of the mod’s vertex structs not appended: the game’s code passes the struct as out or inout, or no code that is carried writes the field — {list}', '{n} fields of the mod’s vertex structs not appended: the game’s code passes the struct as out or inout, or no code that is carried writes the field — {list}', refused.length, { list: refused.join(', ') }));

    if (skipped.length)
        out.push(trn('{n} field of the mod’s vertex structs sits under an @ifdef and was not appended: {list}', '{n} fields of the mod’s vertex structs sit under an @ifdef and were not appended: {list}', skipped.length, { list: shortList(skipped) }));

    const c = work.check;

    if (c?.failed)
        out.push(tr('The check of the merged files could not be run, they stand unchecked — {error}', { error: c.failed }));
    else if (c)
    {
        out.push(c.compiled ?
            trn('Checked the way the game builds them, with the Direct3D compiler: {n} effect stage in {files} effect files', 'Checked the way the game builds them, with the Direct3D compiler: {n} effect stages in {files} effect files', c.units, { files: c.roots }) :
            trn('Checked the way the game builds them (the rules only, this computer has no Direct3D compiler): {n} effect stage in {files} effect files', 'Checked the way the game builds them (the rules only, this computer has no Direct3D compiler): {n} effect stages in {files} effect files', c.units, { files: c.roots }));

        if (c.textureIdsFor)
            out.push(tr('The engine’s texture ids (which samplers may share a stage) are known for 1.20 only, not for {version}: the sampler checks and moves of this merge rest on 1.20’s numbers', { version: c.textureIdsFor }));

        if (c.unchecked)
            out.push(trn('{n} effect stage got no verdict from the compiler and was checked by the rules only', '{n} effect stages got no verdict from the compiler and were checked by the rules only', c.unchecked));

        if (c.variantUnits)
            out.push(c.variantFailing.length ?
                trn('{n} effect stage was built a second time with the flag of the mod’s macros set or taken out (the game builds it as its Defines say); {failing} of those fail — {list}', '{n} effect stages were built a second time with the flag of the mod’s macros set or taken out (the game builds them as their Defines say); {failing} of those fail — {list}', c.variantUnits, { failing: c.variantFailing.length, list: unitList(c.variantFailing) }) :
                trn('{n} effect stage was built a second time with the flag of the mod’s macros set or taken out, and passes', '{n} effect stages were built a second time with the flag of the mod’s macros set or taken out, and pass', c.variantUnits));

        for (const m of c.noOverlay)
            out.push(tr('{file}: the mod’s macros over the game’s names were left out, because effects failed with them — {why}', { file: m.rel, why: m.why }));

        for (const m of c.noDisabled)
            out.push(tr('{file}: the lines the mod’s copy disabled stay live in the game’s {def}, because effects failed with them disabled — {why}', { file: m.rel, def: m.def, why: m.why }));

        for (const m of c.noAdditions)
            out.push(tr('{file}: the mod’s lines carried into the game’s {def} were taken out again, because effects failed with them — {why}', { file: m.rel, def: m.def, why: m.why }));

        for (const m of c.merged)
            out.push(tr('{file}: the mod’s copy was merged with the game’s after all, because the game’s effects failed with it — {why}', { file: m.rel, why: m.why }));

        if (c.skipped.length)
            out.push(trn('{n} definition of the mod not carried: the game builds it twice otherwise — {list}', '{n} definitions of the mod not carried: the game builds them twice otherwise — {list}', c.skipped.length, { list: shortList(c.skipped, 12) }));

        if (c.failing.length)
            out.push(trn('{n} effect stage still fails the check and could not be repaired — {list}', '{n} effect stages still fail the check and could not be repaired — {list}', c.failing.length, { list: unitList(c.failing) }));

        if (c.undecided.length)
            out.push(trn('{n} effect stage cannot be checked here: it needs defines that only the game’s engine or the mod’s model files give ({defines}), and compiles with them — {list}', '{n} effect stages cannot be checked here: they need defines that only the game’s engine or the mod’s model files give ({defines}), and compile with them — {list}', c.undecided.length, { defines: shortList([...new Set(c.undecided.flatMap((u) => (u.needs ?? []).map((n) => n.replace(/ .*$/, ''))))], 8), list: unitList(c.undecided) }));
    }

    return out;
}
