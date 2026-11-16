/**
 * Migrating a mod to the loaded game's version (docs/mods.md, "Migrating a mod to a newer game version"): the plan
 * (migrations.ts, from the views' marks) carried out in a patch mod (the mod's name and "<version> fixes"), loaded right after the
 * mod, so the mod itself stays as its author wrote it: each file holding an entry to fix is copied into the patch mod
 * (same path: it replaces the mod's), then each entry is fixed there (modernize.ts through createEntries, one undo step
 * each; a fix reaching into another of the mod's files copies that file first). The patch mod hides the version's new
 * folders the mod's `replace_path`s call for. Fixes can bring up further marks (a tenet moved out of the doctrines shows
 * its old parameters as a tenet): planned again until nothing is left. Running it again reuses the patch mod.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MigrationFinding, MigrationPlan, MigrationProgress, MigrationResult, ModInfo, ModsState } from '../../shared/api.ts';
import { tr, trn } from '../../shared/i18n.ts';
import { supportedVersionFor } from '../../shared/modRules.ts';
import { createEntries } from './create.ts';
import { parseDescriptor, writeDescriptor } from './descriptor.ts';
import { MANIFEST_FILE, readManifest, sha1, writeManifest, type FixesManifest } from './fixesManifest.ts';
import { deleteFiles, hashFiles, modChanges, mtimeOf, orphanedRecords, ownedFiles, patchFiles, recordLife, type OrphanedRecords, type PatchChanges } from './patchLife.ts';
import { createMod, modsOfList, modsState, saveList, selectList, setActive, withModsState, writeAtomic, type ModsHost } from './manager.ts';
import { holdingZips, withZip, ZipArchive } from './zip.ts';
import { decodeText, decodeTextBody, encodeText, readTextBody, readTextFile } from './textCodec.ts';
import { byteWords, gameFact, GameMemo, holdsHash, own, wordHash } from './gameFacts.ts';
import { isWordName } from './wordRuns.ts';
import { jobMap, keepingTexts, keptText } from './keptTexts.ts';
import { filesOf } from './merge.ts';
import { gameFile, gameFilesBelow, gameRoots, layerRoots } from './gameLayers.ts';
import { engineStrings } from './engineStrings.ts';
import { definedKeys, defineRefs, definesFile, missingDefines, pathTest, type ListDefines } from './defineDiff.ts';
import { applyCallEdits, dataCallEdits, type ContextChange, type DataCallGroup } from './dataCalls.ts';
import { carriesGame, isDeclarationNeutral, pairedWithReplaced } from './currency.ts';
import { dataCallEnv, dataCallNotes } from './dataCallRule.ts';
import { guiNotes, guiPlan, guiTodo } from './guiRule.ts';
import type { ScriptText } from './lostInterface.ts';
import { foldersWithoutOwnFiles, MIGRATIONS, migrationsBetween, type Migration } from './migrations.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { addKeyEdits, gameKeyStatements, namedRefs, withoutAbsent, type AddRule } from './addKeys.ts';
import { bannerEdits, bannerName, gameBannerValues, type BannerEnv, type BannerRule } from './bannerKeys.ts';
import { gainEdits, gainFolder, gainScope, gameGainsOf, tenetGapNotes, tenetGaps, type GainRule, type GainScope, type GameGains } from './gainKeys.ts';
import { applyStatementEdits, statementEdits, type StatementEnv, type StatementGroup } from './scriptRules.ts';
import { addModelEntries, addsSummary, modelWork, namedModifiers, namedPacks, namedStates, packWork, propsWork, type ModelCopy, type ModelEntry, type ModelWork } from './modelStates.ts';
import { textsDone, textsSummary, textsWork, type TextsInput, type TextsWork } from './hiddenTexts.ts';
import { opinionFlagsOf } from './modernize.ts';
import { macroArgs, macroDefinitions, macroShape, type MacroArgs, type MacroShape, type MacroTarget } from './macroArgs.ts';
import type { LibraryConfig, LibraryWork } from './libraries.ts';
import { existingLibraryFiles, leftLibraryFiles, leftLibraryNote, libraryLabel, libraryNotes, libraryOutputs, libraryTodo, removedLibraryNote, workNotes, type LibraryOutput } from './libraryRule.ts';
import { existingInertFiles, inertChanged, inertCopiesLabel, inertFilesLabel, inertLabel, inertNotes, inertOutputs, inertRecord, modFileHash } from './inertRule.ts';
import { INERT_FILE, staleGameCopies, type InertOptions } from './inertWork.ts';
import { eolOf } from '../indexer/override.ts';
import { applyDds, applyMasks, applyParticles, ddsHits, ddsTodo, maskHits, maskTodo, particleHits, particleTodo, type TextureCtx } from './textureRule.ts';
import { gameVersion } from './discover.ts';
import { callsToAdapt, definedWithOldParams } from './shaderCalls.ts';
import { isFxFile, mergedAfterAll, shaderNotes, shaderWork, verifiedShaderWork, type ShaderFile, type ShaderInput, type ShaderWork } from './shaderRule.ts';
import { renamedFileText, renameNotes, renameWork, type RenameWork } from './renameRule.ts';

const lc = (s: string): string => s.toLowerCase();

/** What the rules read of the loaded world besides the mod's and the game's files (found by the async part of a plan or a run). */
export interface RuleWorld
{
    /** the folders of the other mods of the loaded list */
    others?: string[];
    /** what the game's statements name that the index lacks (`prefix:name`, addKeys.ts `namedRefs`) */
    absent?: Set<string>;
    /** of the localization keys the context rule would touch, the ones a loaded script or interface file names (`namedContextKeys`) */
    namedKeys?: Set<string>;
    /** the entries and values the game renamed that the mod's copies still name, and what the patch mod gets for them (`renamedWorld`) */
    renamed?: RenameWork;
}

/** The folders of the other mods of the loaded list (these ids aside): what else loads next to the mod. */
function otherRoots(state: ModsState, ids: string[]): string[]
{
    return modsOfList(state, state.selected).filter((m) => m.root && !ids.some((i) => lc(i) === lc(m.id))).map((m) => m.root!);
}

/**
 * How a run tells the folder watcher of the files it is about to write or delete (ModsHost.wrote, bound to its host): the
 * app's own writes, not saves of another editor. Main formats such saves in the active mod, which the patch mod is from step
 * 2 on, and the rules compare whole texts: unannounced, every file it formatted read as not done in the next plan.
 */
export type Announce = ((files: string[]) => void) | undefined;

/**
 * The files a run wrote or deleted that the index has not been handed yet (case and slashes aside). The steps hand theirs over
 * as they go; a run that ends early (a Cancel between the steps, an error, a crashed worker: main's MigrationThread keeps one of
 * its own) hands over what is left once, at its end. A write after a file was handed over makes it pending again; a re-index
 * reads every file as it is then, so what was written before it is handed over.
 */
export class RunWrites
{
    private readonly files = new Map<string, string>();

    private static key(file: string): string
    {
        return file.replace(/\\/g, '/').toLowerCase();
    }

    /** files about to be written or deleted (the temporary file a write goes through is no file of the mod) */
    wrote(files: string[]): void
    {
        for (const f of files)
            if (!/\.crusaderpope-tmp$/i.test(f))
                this.files.set(RunWrites.key(f), f);
    }

    /** files handed to the index */
    indexed(files: string[]): void
    {
        for (const f of files)
            this.files.delete(RunWrites.key(f));
    }

    /** a re-index was asked for: it reads everything written so far */
    reindexed(): void
    {
        this.files.clear();
    }

    /** what is left to hand over, besides `also` (the files a step lists already: each file once) */
    pending(also: string[] = []): string[]
    {
        const listed = new Set(also.map(RunWrites.key));
        return [...this.files].filter(([k]) => !listed.has(k)).map(([, f]) => f);
    }
}

/** A host's `wrote` for the run's writes (none: a script's host without a watcher); `writes`: the run's own record of them too. */
export const announcer = (host: ModsHost, writes?: RunWrites): Announce => (host.wrote || writes ?
    (files) =>
    {
        writes?.wrote(files);
        host.wrote?.(files);
    } :
    undefined);

/**
 * A file of the patch mod written through a temporary file: a run that is killed leaves no half file, which would count as
 * done for ever (a file that exists is not copied again). The watcher is told first, before its folder is made (edit.ts
 * `write` does the same).
 */
function put(wrote: Announce, out: string, data: string | Uint8Array): void
{
    wrote?.([out, out + '.crusaderpope-tmp']);
    mkdirSync(dirname(out), { recursive: true });
    writeAtomic(out, data);
}

/** passes of plan → fix at most (a pass's fixes can bring up the next's marks) */
const MAX_PASSES = 4;

/** Whether a rule with work left writes something built from the game's files (a copy, a merge, definitions, library entries, the fields the game added). */
export function carriesGameFiles(rules: { kind: string; todo: string[]; }[]): boolean
{
    return rules.some((r) => ['restore', 'mergefx', 'merge', 'defines', 'libraries', 'inert', 'guiTypes', 'gains', 'renamed', 'modelStates', 'texts'].includes(r.kind) && r.todo.length > 0);
}

/**
 * Whether a run has anything to do (the dialog's button): entries to fix, folders to hide or to free, a rule with files to
 * do, a patch mod the mod's update left stale, files no rule asks for any more.
 */
export function planHasWork(plan: MigrationPlan): boolean
{
    return plan.findings.some((f) => f.fix) ||
        !!plan.patchMod?.placed ||
        (plan.replacePathsTodo?.length ?? 0) > 0 ||
        (plan.replacePathsGone?.length ?? 0) > 0 ||
        (plan.rewrites ?? []).some((r) => r.todo.length > 0) ||
        !!plan.patchMod?.stale ||
        (plan.patchMod?.orphans?.length ?? 0) > 0;
}

/**
 * How a plan is asked for: `libraries` false leaves out the library and interface work (the run's own passes); `cancelled`, the
 * job's Cancel (the dialog closed while it reads, a run cancelled while it plans): a plan writes nothing, so it stops at the
 * next of its steps that looks (`planStop`).
 */
export interface PlanOptions
{
    libraries?: boolean;
    cancelled?(): boolean;
}

/** The plan for a mod: what of it the loaded game's version reads differently. The mod's files are read once for it (keptTexts.ts). */
export function planMigration(host: ModsHost, modId: string, opts: PlanOptions = {}): Promise<MigrationPlan>
{
    return holdingZips(() => keepingTexts(() => planWork(host, modId, opts)));
}

/** What a plan throws when it was cancelled (nothing is written yet). */
export const planCancelled = (): MigrationCancelled => new MigrationCancelled(tr('Cancelled while reading the mod — nothing was written'));

/** A plan's look at Cancel: throws once the job is cancelled. */
function planStop(opts: PlanOptions): () => void
{
    return () =>
    {
        if (opts.cancelled?.())
            throw planCancelled();
    };
}

/**
 * What a plan starts from: the mod, the steps to its game version, the patch mod of a run before, and the index's marks
 * (`migrationPlan`: the findings and steps). The run's passes of plan and fix need only these (`migrateRun`).
 */
async function indexPlan(host: ModsHost, modId: string): Promise<{ state: ModsState; mod: ModInfo; steps: Migration[]; folder?: string; found: { patch?: ModInfo; packed?: ModInfo; }; plan: MigrationPlan; placed?: 'missing' | 'before'; }>
{
    const state = await modsState(host);
    const mod = state.mods.find((m) => lc(m.id) === lc(modId));

    if (!mod)
        throw new Error(tr('No mod {id}', { id: modId }));

    // (its fixes patch mod from a run before: what it holds of the mod's entries is planned too)
    const steps = migrationsBetween(mod.supportedVersion, state.gameVersion);
    const folder = steps.length ? patchFolder(mod, steps[steps.length - 1].to) : undefined;
    const found = folder ? findPatch(state.mods, folder) : {};
    const patch = found.patch;
    const plan = await host.query!<MigrationPlan | null>('migrationPlan', mod.id, mod.supportedVersion, state.gameVersion, patch?.id);

    if (!plan)
        throw new Error(tr('The index is not ready'));

    // (the patch mod is on disk, but the loaded list does not load it, or loads it before the mod: the index shows the mod's entries
    // as the mod wrote them; whatever the patch mod holds of them counts as fixed, and putting it in place is the work)
    const placed = patch && !plan.problem ? patchPlace(state, mod, patch) : undefined;

    if (placed === 'missing' && patch?.root)
        plan.findings = plan.findings.map((f) => (f.fix && existsSync(join(patch.root!, ...f.rel.split('/'))) ? { ...f, fix: undefined } : f));

    return { state, mod, steps, folder, found, plan, placed };
}

async function planWork(host: ModsHost, modId: string, opts: PlanOptions): Promise<MigrationPlan>
{
    // (Cancel is looked at between the steps, and inside the long ones: fileRules, the renamed rule)
    const stop = planStop(opts);
    stop();
    const { state, mod, steps, folder, found, plan, placed } = await indexPlan(host, modId);
    const patch = found.patch;
    stop();

    // (a patch mod packed into a zip cannot be written into: said here, not as the "already exists" of making a new one)
    if (found.packed && !plan.problem)
        plan.problem = packedProblem(found.packed);

    const gameDir = host.gameDir();
    const modFiles = filesOf(mod);
    const script = gameDir && !plan.problem ? await scriptEnv(host, mod, modFiles, gameDir, patch?.root, steps) : undefined;
    stop();
    // (the interface files the owner chose to take whole in a run before stay taken)
    const manifest = readManifest(patch?.root);
    const left: LeftAlone = new Map();
    const world: RuleWorld = plan.problem || !gameDir ? {} : { others: otherRoots(state, [mod.id, patch?.id ?? '']), absent: await absentRefs(host, steps, gameDir) };
    stop();

    // (the keys the context rule would touch that loaded files name, read from the loaded files, as the library scan: the run's
    // own passes plan without, and so without the context rule; the run reads them itself)
    if (gameDir && !plan.problem && opts.libraries !== false)
    {
        world.namedKeys = await namedContextKeys({ mod, modFiles, gameDir, patchRoot: patch?.root, others: world.others }, steps, script, stop);
        stop();
    }

    // (the entries and values the game renamed: read from the copies and the loaded files, as the keys above)
    if (gameDir && !plan.problem && opts.libraries !== false && steps.some((m) => m.renamed))
    {
        const planned = mergeDefinitions(mod, steps, gameDir, modFiles, script, world.others);
        stop();
        world.renamed = await renamedWorld(host, mod, modFiles, gameDir, patch?.root, world.others, folder ?? '', steps, planned, stop);
        stop();
    }

    const rules = plan.problem || !gameDir ? [] : fileRules(mod, steps, gameDir, modFiles, script, patch?.root, manifest?.optional, left, world, stop);
    stop();
    // (each rule against the patch mod of a run before: what it still lacks; a second run lists the rest as done)
    const ctx: RuleContext = { mod, modFiles, gameDir: gameDir ?? '', folder: folder ?? '', patchRoot: patch?.root, ...world, manifest, pendingFixes: plan.findings.some((f) => f.fix), script };
    await prepareShaders(ctx, rules, left, stop);
    stop();
    plan.rewrites = rules.map((r) => ({ kind: r.kind, label: r.label, files: r.files, todo: ruleTodo(r, ctx), ...(r.kind === 'mergefx' ? { notes: shaderNotes(shaderWorkOf(ctx, r)) } : r.notes?.length ? { notes: r.notes } : {}) }));
    stop();
    // (the statements no rule can map: a mod whose only problem is one has no run to offer; it is told here)
    const unmapped = gameDir && !plan.problem ? unmappedStatements(ctx, steps.flatMap((m) => m.statements ?? [])) : [];
    stop();

    if (unmapped.length)
        plan.unmapped = unmapped;

    // (the copies of game files that need the game's file for nothing: it is the game's file, or the new version's)
    if (left.size)
        plan.leftAlone = { same: [...left].filter(([, v]) => v === 'same').map(([k]) => k).sort(), current: [...left].filter(([, v]) => v === 'current').map(([k]) => k).sort() };

    // (a folder the mod has files of its own in is not hidden: they would go with it; a patch mod of a run before may hide it)
    // (unless its religions still hold the content the folder took over: the fixes write it there, and the game's must not load either)
    const inline = foldersWithoutOwnFiles(plan.replacePaths ?? [], modFiles.keys()).kept.length ? inlineFolders(mod, modFiles, steps) : [];
    const own = foldersWithoutOwnFiles(plan.replacePaths ?? [], modFiles.keys(), inline);
    const hides = (list: string[], p: string): boolean => list.some((h) => lc(h.replace(/\\/g, '/').replace(/\/+$/, '')) === lc(p));

    if (own.kept.length)
    {
        plan.replacePaths = own.hide;
        plan.replacePathsOwn = own.kept;
        // (one a run of the app added goes with the next run, as a folder the mod stopped replacing does; one the patch mod got another way stays, told)
        const freed = patch ? hiddenGone(patch, manifest, own.hide) : [];
        plan.replacePathsStale = own.kept.filter((p) => patch && hides(patch.replacePaths, p) && !hides(freed, p));
        plan.replacePathHides = plan.replacePathHides?.filter((h) => own.hide.includes(h.folder));
    }

    if (own.shadowed.length)
        plan.replacePathsShadowed = own.shadowed;

    plan.replacePathsTodo = (plan.replacePaths ?? []).filter((p) => !patch || !hides(patch.replacePaths, p));

    // (the definitions the game version added to files the mod replaces, that loaded files still use, read from the
    // loaded files, which takes a while: the run's own passes plan without; the texts the merge rules would write count)
    if (gameDir && !plan.problem && opts.libraries !== false)
    {
        const extra = rules.filter((r) => r.kind === 'merge').flatMap((r) => [...mergeOutputs(r, ctx)].map(([, o]) => o.text));
        const gained = gainedWords(ctx, rules);
        stop();
        const lib = await libraryPlan(host, mod, steps, folder ?? '', patch, extra, gained, inertOptions(rules, folder ?? '', patch?.root, manifest, undefined, world.renamed?.aliases));
        stop();

        if (lib)
        {
            plan.rewrites.push(...lib.entries);
            plan.notes = lib.notes;
        }

        // (the interface: types the game's windows use that the mod's copies lack, files nothing uses, restores to offer)
        const gui = steps.some((m) => m.dataCalls?.length || m.restore?.length) ? await guiPlan(host, mod, folder ?? '', patch, guiConfig(steps, rules), guiCalls(steps, gameDir!, script), scriptTexts(mod)) : undefined;
        stop();

        if (gui)
        {
            plan.rewrites.push(...gui.entries);
            // (why a copy is offered: the sites a rule told besides the names the game does not know)
            const why = new Map<string, string[]>();

            for (const r of rules.filter((x) => x.kind === 'dataCalls'))
                for (const [rel, lines] of r.leftBy ?? [])
                    why.set(rel.toLowerCase(), [...(why.get(rel.toLowerCase()) ?? []), ...lines]);

            plan.optional = gui.optional.map((o) => ({ ...o, reasons: [...o.reasons, ...(why.get(o.rel.toLowerCase()) ?? [])] }));
            plan.notes = [...(plan.notes ?? []), ...gui.notes];
        }

        // (the texts the game added to localization files the mod replaces: after the libraries rule, whose files name some of them)
        const textRules = steps.flatMap((m) => m.texts ?? []);

        if (textRules.length)
        {
            const w = textsWork(textsInput({ mod, modFiles, gameDir, patchRoot: patch?.root, others: world.others }, folder ?? '', patch, textRules.flatMap((r) => r.files), [...extra, ...(lib?.outputs ?? []).map((o) => o.text)], world.renamed?.aliases));
            stop();
            const entry = textsEntry(w, textRules[0].label, patch?.root);

            if (entry)
                plan.rewrites.push(entry);
        }

        // (defines the mod's files read that nothing defines: no rule can pick the key a define became)
        plan.notes = [...(plan.notes ?? []), ...undefinedDefines(ctx, steps)];
        stop();
    }

    if (patch)
    {
        // (every kind whose output is built from the game's files: its copies, merges, definitions and library entries)
        const carries = carriesGameFiles(plan.rewrites);
        // (outdated: a game file it carries is not the game's now, and the game is another version than the one it was made
        // for; a game update that touched none of its files leaves nothing to run, so nothing to warn of)
        // (or a game file an override was made from is not the one it was made from: the override masks the new text)
        const modHash = modFileHash(mod, modFiles);
        const inertStale = !!gameDir && inertChanged(manifest?.inert, (rel) => gameFile(gameDir, rel), modHash.hash).length > 0;
        modHash.close();
        plan.patchMod = { name: patch.name, builtFor: manifest?.game, outdated: carries && (!manifest?.game || manifest.game !== state.gameVersion || inertStale), ...(placed ? { placed } : {}) };

        // (the mod updated since the patch mod took its copies: they shadow the update; files no rule asks for any more)
        if (gameDir && !plan.problem)
        {
            const life = patchLifeOf(ctx, rules);
            const stale = life.changes.stale;

            if (stale.length)
                plan.patchMod.stale = { files: stale.map((s) => s.rel), reset: life.changes.reset.length, legacy: life.changes.legacy };

            if (life.changes.keptStale.length)
                plan.patchMod.keptStale = life.changes.keptStale;

            if (life.orphans.remove.length)
                plan.patchMod.orphans = life.orphans.remove;

            if (life.orphans.edited.length)
                plan.patchMod.orphansEdited = life.orphans.edited;

            // (the folders the mod stopped replacing: the patch mod hid them for it)
            const gone = hiddenGone(patch, manifest, plan.replacePaths ?? []);

            if (gone.length)
                plan.replacePathsGone = gone;
        }
    }

    return plan;
}

/** The bytes of a zip entry. */
function zipEntry(archive: string, entry: string): Buffer | undefined
{
    return withZip(archive, (z) => z.readEntry(entry));
}

/**
 * Whether the mod's copy of a game file needs the game's file for it (restore, mergefx): `same` (it is the game's file, byte
 * for byte), `current` (it holds what the new version's file has (currency.ts; an interface file that still calls what a rule
 * of the version renames or reports is old all the same; an effect file must declare every definition the game's does and add
 * no include, sampler, constant buffer or vertex struct field to it)),
 * or undefined: an older copy, or one that cannot be told.
 */
function copyState(mod: ModInfo, where: { file?: string; entry?: string; }, rel: string, gameDir: string, groups: DataCallGroup[], script: StatementEnv | undefined): 'same' | 'current' | undefined
{
    const g = gameFile(gameDir, rel);
    let have: Buffer | undefined;

    try
    {
        have = where.file ? readFileSync(where.file) : where.entry && mod.archive ? zipEntry(mod.archive, where.entry) : undefined;
    }
    catch
    {
        // (unreadable: no judgement, the rules go on as before)
    }

    if (!g || !have)
        return undefined;

    const game = readFileSync(g);

    if (have.equals(game))
        return 'same';

    const fx = isFxFile(rel);

    if (!fx && !/\.gui$/i.test(rel))
        return undefined;

    const gameText = decodeText(game);
    const text = decodeText(have);

    if (!carriesGame(gameText, text) || (fx && !isDeclarationNeutral(gameText, text)))
        return undefined;

    if (fx)
        return 'current';

    // (a copy of the new version calls nothing a rule of the version still renames, drops or reports)
    if (!script)
        return undefined;

    const env = dataCallEnv(gameDir, script.sets.tenets);
    const bare = text.replace(/^﻿/, '');
    const old = groups.some((group) =>
    {
        if (!group.files.some((p) => globMatch(p, rel)))
            return false;

        const r = dataCallEdits(bare, rel, group, env);
        return r.edits.length > 0 || r.left.length > 0;
    });
    return old ? undefined : 'current';
}

/** A text file of a mod (from its folder or its zip), without byte order mark. */
function modText(mod: ModInfo, rel: string, where: { file?: string; entry?: string; }): string | undefined
{
    // (read once per plan or run: keptTexts.ts)
    if (where.file)
        return keptText(where.file, undefined, () => readFileSync(where.file!));

    return where.entry && mod.archive ? keptText(mod.archive, where.entry, () => zipEntry(mod.archive!, where.entry!)) : undefined;
}

/**
 * The new folders of the steps whose content the mod's entries of the older folder still hold inside them (migrations.ts
 * `oldForms`: a religion with its `faiths`): the mod is not laid out for the new version there, and a file of its own in such a
 * folder does not make the folder its.
 */
function inlineFolders(mod: ModInfo, files: Map<string, { file?: string; entry?: string; }>, steps: Migration[]): string[]
{
    const out: string[] = [];

    for (const m of steps)
    {
        for (const [old, key] of Object.entries(m.oldForms ?? {}))
        {
            const prefix = lc(old) + '/';
            const held = [...files].some(([rel, where]) => lc(rel).startsWith(prefix) && /\.txt$/i.test(rel) && parse(modText(mod, rel, where) ?? '').some((n) => Array.isArray(n.v) && n.v.some((c) => c.k === key)));

            if (held)
                out.push(...(m.newFolders[old] ?? []));
        }
    }

    return out;
}

/**
 * The keys to rename in a text: `from` as a block anywhere inside a top-level definition (offsets of the key),
 * directly in it or deeper (a trait's track levels carry the same modifier blocks).
 */
function renameSites(text: string, from: string): PNode[]
{
    if (!text.includes(from))
        return [];

    const out: PNode[] = [];
    const walk = (nodes: PNode[]): void =>
    {
        for (const c of nodes)
        {
            if (!Array.isArray(c.v))
                continue;

            if (c.k === from)
                out.push(c);

            walk(c.v);
        }
    };

    for (const top of parse(text))
        if (Array.isArray(top.v))
            walk(top.v);

    return out;
}

/** A block's `parameter = x` (the doctrine parameter a modifier block depends on). */
const blockParameter = (n: PNode): string | undefined =>
    (Array.isArray(n.v) ? n.v.find((c) => c.k === 'parameter' && typeof c.v === 'string')?.v : undefined) as string | undefined;

/**
 * The doctrine parameters something defines: `parameters = { … }` of the doctrines and tenets of the game, the mod and
 * its patch mod (their names: `x = yes` and bare `x`).
 */
function definedParameters(gameDir: string, mod: ModInfo, patchRoot: string): Set<string>
{
    const out = new Set<string>();
    const folders = ['common/religion/doctrine_types', 'common/religion/tenet_types'];
    const take = (text: string | undefined): void =>
    {
        if (!text?.includes('parameters'))
            return;

        for (const top of parse(text))
            for (const c of Array.isArray(top.v) ? top.v : [])
                if (c.k === 'parameters' && Array.isArray(c.v))
                    for (const p of c.v)
                        out.add(p.k ?? (typeof p.v === 'string' ? p.v : ''));
    };
    const walkDir = (dir: string): void =>
    {
        if (!existsSync(dir))
            return;

        for (const e of readdirSync(dir, { withFileTypes: true }))
            if (e.isFile() && /\.txt$/i.test(e.name))
                take(readTextFile(join(dir, e.name)));
    };

    for (const f of folders)
    {
        walkDir(join(gameDir, ...f.split('/')));
        walkDir(join(patchRoot, ...f.split('/')));
    }

    for (const [rel, where] of filesOf(mod))
        if (folders.some((f) => lc(rel).startsWith(f + '/')) && /\.txt$/i.test(rel))
            take(modText(mod, rel, where));

    out.delete('');
    return out;
}

/** Text without a block, with its line when nothing else is on it. */
function cutBlock(text: string, n: PNode): string
{
    const ls = text.lastIndexOf('\n', n.s - 1) + 1;
    const le = text.indexOf('\n', n.e);
    const end = le < 0 ? text.length : le + 1;
    return !text.slice(ls, n.s).trim() && !text.slice(n.e, le < 0 ? text.length : le).trim() ? text.slice(0, ls) + text.slice(end) : text.slice(0, n.s) + text.slice(n.e);
}

type FileRule = {
    kind: 'rename' | 'restore' | 'mergefx' | 'empty' | 'settings' | 'modelStates' | 'rewrite' | 'merge' | 'icons' | 'defines' | 'statements' | 'adds' | 'gains' | 'banners' | 'dataCalls' | 'particles' | 'ddsLegacy' | 'maskMips' | 'renamed';
    label: string;
    /** particles: the folder of compound graph files */
    compounds?: string;
    files: string[];
    from?: string;
    to?: string;
    definedParameter?: boolean;
    /** rename: the blocks go (the version has no such key) */
    drop?: boolean;
    block?: string;
    keys?: string[];
    /** settings: the mod's own meshes' form (`ownStreaming`), not the game's settings */
    own?: boolean;
    /** modelStates: the path patterns of the models (`files` are the copies with something to add) and the folder of the portrait animations (what names the states) */
    models?: string[];
    animations?: string;
    /** modelStates: the models are modifier pack files (migrations.ts `modelStates.packs`) */
    packs?: boolean;
    /** modelStates: the models are the files of the props' chain, these folders (migrations.ts `modelStates.props`) */
    props?: { modifiers: string; genes: string; accessories: string; entities: string; };
    find?: string;
    replace?: string;
    lists?: string[];
    icon?: NonNullable<Migration['icons']>[number];
    folder?: string;
    /** defines: the list defines whose words name entries (the merged list takes the game's words the world has) */
    defineLists?: { key: string; prefix: string; }[];
    group?: StatementGroup;
    add?: AddRule;
    gain?: GainRule;
    banner?: BannerRule;
    /** dataCalls: the group */
    calls?: DataCallGroup;
    /** dataCalls: per file the sites no rewrite maps (the interface ones are priced as optional restores, with these as the reasons) */
    leftBy?: Map<string, string[]>;
    /** empty: files that keep the game's text without these top-level entries (the ones the world lacks) instead of being empty */
    trim?: Map<string, string[]>;
    /** what the plan says under the rule (dataCalls) */
    notes?: string[];
    /** merge: the statement groups that rename top-level entries (the merge sees them under their new names) */
    topGroups?: StatementGroup[];
    /** mergefx: the mod's copies that need no merge (the game's file, or the new version's already), read as merged files, never written */
    keep?: string[];
    /** renamed: the files to edit and the files to write (renameRule.ts) */
    renamed?: RenameWork;
};

/** The mod's copies of game files that no rule touches, by path: the game's file itself, or a copy of the new version already (`copyState`). */
export type LeftAlone = Map<string, 'same' | 'current'>;

/** A block's `name = "…"` (a pdxmesh, an entity …), without quotes. */
function blockName(n: PNode): string | undefined
{
    const c = Array.isArray(n.v) ? n.v.find((x) => x.k === 'name' && typeof x.v === 'string') : undefined;
    return c ? (c.v as string).replace(/^"|"$/g, '') : undefined;
}

/**
 * The settings (`keys`) the game's version of a file gives its named `block`s that the same-named blocks of the mod's
 * copy lack: where to insert them (after the block's `name`) and the text, the game's own statements.
 */
function missingSettings(gameText: string, modText: string, block: string, keys: string[], own = false): { at: number; text: string; }[]
{
    if (own)
        return ownStreaming(gameText, modText, block, keys);

    if (!keys.some((k) => gameText.includes(k)))
        return [];

    const want = new Map<string, PNode[]>();

    for (const n of parse(gameText))
    {
        const name = n.k === block ? blockName(n) : undefined;
        const has = name && Array.isArray(n.v) ? n.v.filter((c) => c.k && keys.includes(c.k)) : [];

        if (name && has.length)
            want.set(name, has);
    }

    const out: { at: number; text: string; }[] = [];

    for (const n of parse(modText))
    {
        const need = n.k === block ? want.get(blockName(n) ?? '') : undefined;

        if (!need || !Array.isArray(n.v))
            continue;

        const have = new Set(n.v.map((c) => c.k));
        const add = need.filter((c) => !have.has(c.k));
        const nameNode = n.v.find((c) => c.k === 'name')!;

        if (add.length)
            out.push({ at: nameNode.e, text: add.map((c) => '\n\t' + gameText.slice(c.s, c.e)).join('') });
    }

    return out;
}

/** The children of a mesh block (`pdxmesh`) that give it a skeleton of its own or animations: they are what has to be there before the mesh is drawn. */
const ANIMATED_MESH = ['animation', 'additive_animation', 'reference_skeleton'];

/**
 * The `own` form of `settings`: the `keys` (`streaming`) for the mod's named `block`s that the game's file of the same path does
 * not define and that import a skeletal animation set or hold animations or a reference skeleton themselves (a creature's mesh).
 * The 1.20 streamer loads such a mesh late and the animations are imported before its skeleton is there, for good. The line is
 * `<key> = Never` after the block's `name`. Found by what the block holds, not by its name.
 */
function ownStreaming(gameText: string, modText: string, block: string, keys: string[]): { at: number; text: string; }[]
{
    const known = new Set<string>();

    for (const n of gameText ? parse(gameText) : [])
    {
        const name = n.k === block ? blockName(n) : undefined;

        if (name)
            known.add(name);
    }

    const out: { at: number; text: string; }[] = [];

    for (const n of parse(modText))
    {
        if (n.k !== block || !Array.isArray(n.v))
            continue;

        const nameNode = n.v.find((c) => c.k === 'name');
        const animated = n.v.some((c) => ANIMATED_MESH.includes(c.k ?? '')
            || (c.k === 'import' && Array.isArray(c.v) && c.v.some((x) => x.k === 'type' && x.v === 'skeletal_animation_set')));

        if (!nameNode || !animated || known.has(blockName(n) ?? '') || n.v.some((c) => keys.includes(c.k ?? '')))
            continue;

        out.push({ at: nameNode.e, text: keys.map((k) => `\n\t${k} = Never`).join('') });
    }

    return out;
}

/** The game's text of the file a `settings` rule reads (empty for the own form where the game has no such file). */
function settingsGame(gameDir: string, rel: string, rule: FileRule): string
{
    const g = gameFile(gameDir, rel);
    return g ? readTextFile(g) : rule.own ? '' : readTextFile(g!);
}

/** The folders path patterns start in: the part before the first segment with a wildcard (a pattern of the portrait models: `gfx/models/portraits`). */
const patternRoots = (patterns: string[]): string[] => [...new Set(patterns.map((p) =>
{
    const w = p.search(/[*?]/);
    return w < 0 ? p.slice(0, p.lastIndexOf('/')) : p.slice(0, p.lastIndexOf('/', w));
}))];

/** The game's model files with animations or states (the rule's patterns), as text: read once per game build (gameFacts.ts `GameMemo`). */
const modelMemo = new GameMemo<{ rel: string; text: string; }[]>();

function gameModels(gameDir: string, patterns: string[]): { rel: string; text: string; }[]
{
    const id = `${gameDir}|${patterns.join(',')}`;
    let list = modelMemo.get(gameDir, id);

    if (!list)
    {
        list = [];

        for (const root of patternRoots(patterns))
            for (const f of gameFilesBelow(gameDir, root, /\.asset$/i))
            {
                if (!patterns.some((p) => globMatch(p, f.rel)))
                    continue;

                const text = readTextBody(f.abs);

                // (`additive_animation`, `default_state` are other keys: no word boundary inside them)
                if (/\b(?:animation|state)\s*=\s*\{/.test(text))
                    list.push({ rel: f.rel, text });
            }

        modelMemo.set(gameDir, id, list);
    }

    return list;
}

/** The states the game's portrait animations name (every file of the folder in the game's layers, hidden or not), read once per game build (gameFacts.ts `GameMemo`). */
const namedMemo = new GameMemo<Set<string>>();

function gameNamedStates(gameDir: string, folder: string): Set<string>
{
    const id = `${gameDir}|${folder}`;
    let named = namedMemo.get(gameDir, id);

    if (!named)
    {
        named = new Set();

        for (const f of gameFilesBelow(gameDir, folder, /\.txt$/i))
            namedStates(readTextBody(f.abs), named);

        namedMemo.set(gameDir, id, named);
    }

    return named;
}

/**
 * The `modelStates` rule's work (modelStates.ts): the mod's copies of the game's model files that have animations or states, read
 * by `read` (the mod's file for the plan, the file as it loads now for the state check and the run), against the game's; the game's
 * other model files (their states play animations a copy may hold); the states the portrait animations name: the game's (all of
 * them, the libraries rule may carry any), the mod's, the patch mod's.
 */
export function modelStatesWork(c: { mod: ModInfo; modFiles: Map<string, { file?: string; entry?: string; }>; gameDir: string; patchRoot?: string; }, rule: FileRule, read: (rel: string) => string | undefined): ModelWork
{
    if (rule.packs)
        return packsWork(c, rule, read);

    if (rule.props)
        return propsRuleWork(c, rule, read);

    const patterns = rule.models ?? [];
    const games = gameModels(c.gameDir, patterns);
    const byRel = new Map(games.map((g) => [lc(g.rel), g]));
    const copies: ModelCopy[] = [];

    for (const rel of c.modFiles.keys())
    {
        const g = byRel.get(lc(rel));
        const text = g && patterns.some((p) => globMatch(p, rel)) ? read(rel) : undefined;

        if (text !== undefined)
            copies.push({ rel, game: g!.text, copy: text });
    }

    if (!copies.length)
        return { adds: new Map(), unplayable: [], noClip: [] };

    const copied = new Set(copies.map((x) => lc(x.rel)));
    const folder = rule.animations ?? '';
    const named = new Set(gameNamedStates(c.gameDir, folder));
    const inFolder = (rel: string): boolean => lc(rel).startsWith(lc(folder) + '/') && /\.txt$/i.test(rel);

    for (const [rel, where] of c.modFiles)
        if (inFolder(rel))
            namedStates(modText(c.mod, rel, where) ?? '', named);

    for (const rel of patchFilesFor(c.patchRoot, [`${folder}/**/*.txt`]))
        namedStates(currentText(c, rel) ?? '', named);

    const modRels = new Set([...c.modFiles.keys()].map(lc));
    const clipExists = (rel: string): boolean => !!gameFile(c.gameDir, rel) || modRels.has(lc(rel)) || (!!c.patchRoot && existsSync(join(c.patchRoot, ...rel.split('/'))));
    return modelWork(copies, games.filter((g) => !copied.has(lc(g.rel))).map((g) => g.text), named, clipExists);
}

/** The game's files of a folder with an extension (every layer, hidden or not), as text: read once per game build (gameFacts.ts `GameMemo`). */
const folderMemo = new GameMemo<{ rel: string; text: string; }[]>();

function gameTexts(gameDir: string, folder: string, ext: RegExp): { rel: string; text: string; }[]
{
    const id = `${gameDir}|${folder}|${ext.source}`;
    let list = folderMemo.get(gameDir, id);

    if (!list)
    {
        list = gameFilesBelow(gameDir, folder, ext).map((f) => ({ rel: f.rel, text: readTextBody(f.abs) }));
        folderMemo.set(gameDir, id, list);
    }

    return list;
}

type ModelCtx = { mod: ModInfo; modFiles: Map<string, { file?: string; entry?: string; }>; gameDir: string; patchRoot?: string; };

/** The mod's copies of the game's files of a folder (a game file of the same path that the patterns take), read by `read`, with the game's text. */
function copiesIn(c: ModelCtx, games: { rel: string; text: string; }[], patterns: string[], read: (rel: string) => string | undefined): ModelCopy[]
{
    const byRel = new Map(games.filter((g) => patterns.some((p) => globMatch(p, g.rel))).map((g) => [lc(g.rel), g]));
    const copies: ModelCopy[] = [];

    for (const rel of c.modFiles.keys())
    {
        const g = byRel.get(lc(rel));
        const text = g ? read(rel) : undefined;

        if (text !== undefined)
            copies.push({ rel, game: g!.text, copy: text });
    }

    return copies;
}

/**
 * The other loaded files of a folder next to the copies: the game's that the mod and the patch mod do not hide by path, the mod's own
 * (as they load now), the patch mod's own; with their paths.
 */
function othersIn(c: ModelCtx, games: { rel: string; text: string; }[], copies: ModelCopy[], folder: string, ext: RegExp): { rel: string; text: string; }[]
{
    const copied = new Set(copies.map((x) => lc(x.rel)));
    const modRels = new Set([...c.modFiles.keys()].map(lc));
    const patch = patchFilesFor(c.patchRoot, [`${folder}/**/*`], ext).filter((r) => !modRels.has(lc(r)));
    const hidden = new Set([...modRels, ...patch.map(lc)]);
    const inFolder = (rel: string): boolean => lc(rel).startsWith(lc(folder) + '/') && ext.test(rel);
    return [
        ...games.filter((g) => !hidden.has(lc(g.rel))),
        ...[...c.modFiles.keys()].filter((rel) => inFolder(rel) && !copied.has(lc(rel))).map((rel) => ({ rel, text: currentText(c, rel) ?? '' })),
        ...patch.map((rel) => ({ rel, text: currentText(c, rel) ?? '' }))
    ];
}

/**
 * What the modifier pack entry reads (`rule.packs`, and the props entry for the packs that load): the mod's copies of the game's pack
 * files, read by `read` as for the models; the other loaded pack files of the folder (the game's the mod does not copy, the mod's own,
 * the patch mod's own); the packs the portrait animations name (the game's, all of them; the mod's; the patch mod's).
 */
function packsInput(c: ModelCtx, folder: string, patterns: string[], read: (rel: string) => string | undefined): { copies: ModelCopy[]; others: string[]; named: Set<string>; }
{
    const PACK = /\.modifierpack$/i;
    const games = gameTexts(c.gameDir, folder, PACK);
    const copies = copiesIn(c, games, patterns, read);
    const others = othersIn(c, games, copies, folder, PACK).map((o) => o.text);
    const named = new Set<string>();
    const modRels = new Set([...c.modFiles.keys()].map(lc));

    for (const g of gameTexts(c.gameDir, folder, /\.txt$/i))
        namedPacks(g.text, named);

    for (const [rel, where] of c.modFiles)
        if (lc(rel).startsWith(lc(folder) + '/') && /\.txt$/i.test(rel))
            namedPacks(modText(c.mod, rel, where) ?? '', named);

    for (const rel of patchFilesFor(c.patchRoot, [`${folder}/**/*.txt`]).filter((r) => !modRels.has(lc(r))))
        namedPacks(currentText(c, rel) ?? '', named);

    return { copies, others, named };
}

/**
 * The `modelStates` rule's work on the modifier pack files (`rule.packs`; modelStates.ts `packWork`): the game's packs a copy lacks that
 * a portrait animation names and no loaded pack file defines. The props they name are the props entry's (`propsRuleWork`).
 */
function packsWork(c: ModelCtx, rule: FileRule, read: (rel: string) => string | undefined): ModelWork
{
    const p = packsInput(c, rule.animations ?? '', rule.models ?? [], read);
    const packs = p.copies.length ? packWork(p.copies, p.others, p.named) : new Map<string, ModelEntry[]>();
    return { adds: new Map([...packs].map(([rel, list]) => [rel, { animations: new Map(), states: new Map(), top: list, kind: 'packs' as const }])), unplayable: [], noClip: [] };
}

/** The names of the entities the loaded model files define, per game file (every layer, hidden or not): read once per game build (gameFacts.ts `GameMemo`). */
const entityMemo = new GameMemo<Map<string, string[]>>();

// (an entity block and its name, comments taken out first: the game's falcon has `entity = { # Falcon is being attached …` above its name)
const ENTITY_NAME = /\bentity\s*=\s*\{\s*name\s*=\s*"?([^"\s}]+)"?/g;
const entityNames = (text: string): string[] => [...text.replace(/#[^\n]*/g, '').matchAll(ENTITY_NAME)].map((m) => m[1]);

function gameEntities(gameDir: string, folder: string): Map<string, string[]>
{
    const id = `${gameDir}|${folder}`;
    let out = entityMemo.get(gameDir, id);

    if (!out)
    {
        out = new Map();

        for (const f of gameFilesBelow(gameDir, folder, /\.asset$/i))
            out.set(lc(f.rel), entityNames(readTextFile(f.abs)));

        entityMemo.set(gameDir, id, out);
    }

    return out;
}

/**
 * The `modelStates` rule's work on the props (`rule.props`; modelStates.ts `propsWork`): the mod's copies of the game's portrait modifier,
 * gene and accessory files (`rule.models`, read by `read` as for the models) and the other loaded files of those folders; what names the
 * portrait modifiers: the portrait animations that may load (the game's entries the mod's and the patch mod's animation files do not
 * define themselves, theirs: the libraries rule may carry any of the game's), the packs that load which those name (the loaded pack
 * files and the game's packs the pack entry brings in); the entities of the loaded model files (`props.entities`), read when asked.
 */
function propsRuleWork(c: ModelCtx, rule: FileRule, read: (rel: string) => string | undefined): ModelWork
{
    const none: ModelWork = { adds: new Map(), unplayable: [], noClip: [] };
    const f = rule.props!;
    const patterns = rule.models ?? [];
    const TXT = /\.txt$/i;
    const read3 = (folder: string): { games: { rel: string; text: string; }[]; copies: ModelCopy[]; } =>
    {
        const games = gameTexts(c.gameDir, folder, TXT);
        return { games, copies: copiesIn(c, games, patterns, read) };
    };
    const modifiers = read3(f.modifiers);

    // (no copy of a game portrait modifier file: nothing hides a prop)
    if (!modifiers.copies.length)
        return none;

    // (what names the portrait modifiers: the animations that may load, and the packs those name)
    const folder = rule.animations ?? '';
    const modRels = new Set([...c.modFiles.keys()].map(lc));
    const own: string[] = [
        ...[...c.modFiles].filter(([rel]) => lc(rel).startsWith(lc(folder) + '/') && TXT.test(rel)).map(([rel, where]) => modText(c.mod, rel, where) ?? ''),
        ...patchFilesFor(c.patchRoot, [`${folder}/**/*.txt`]).filter((r) => !modRels.has(lc(r))).map((rel) => currentText(c, rel) ?? '')
    ];
    const ownNodes = own.map((t) => parse(t));
    const ownKeys = new Set(ownNodes.flat().map((n) => n.k ?? ''));
    const named = new Set<string>();
    const namedPackSet = new Set<string>();

    for (const nodes of [...ownNodes, ...gameTexts(c.gameDir, folder, TXT).map((g) => parse(g.text).filter((n) => !ownKeys.has(n.k ?? '')))])
    {
        namedModifiers(nodes, named);
        namedPacks(nodes, namedPackSet);
    }

    // (the packs as they load: the copies as they are now, the other pack files, what the pack entry brings into the copies)
    const packs = packsInput(c, folder, [`${folder}/**/*.modifierpack`], read);
    const brought = packs.copies.length ? [...packWork(packs.copies, packs.others, packs.named).values()].flat().map((e) => e.text) : [];

    for (const t of [...packs.copies.map((x) => x.copy), ...packs.others, ...brought])
        namedModifiers(parse(t).filter((n) => namedPackSet.has(n.k ?? '')), named);

    const genes = read3(f.genes);
    const accessories = read3(f.accessories);
    let entities: Set<string> | undefined;
    const entity = (name: string): boolean =>
    {
        if (!entities)
        {
            entities = new Set();
            const patch = patchFilesFor(c.patchRoot, [`${f.entities}/**/*.asset`], /\.asset$/i).filter((r) => !modRels.has(lc(r)));
            const hidden = new Set([...modRels, ...patch.map(lc)]);

            for (const [rel, names] of gameEntities(c.gameDir, f.entities))
                if (!hidden.has(rel))
                    names.forEach((n) => entities!.add(n));

            for (const rel of [...[...c.modFiles.keys()].filter((r) => lc(r).startsWith(lc(f.entities) + '/') && /\.asset$/i.test(r)), ...patch])
                entityNames(currentText(c, rel) ?? '').forEach((n) => entities!.add(n));
        }

        return entities.has(name);
    };

    return propsWork({
        named,
        modifiers: { copies: modifiers.copies, others: othersIn(c, modifiers.games, modifiers.copies, f.modifiers, TXT).map((o) => o.text) },
        genes: { copies: genes.copies, others: othersIn(c, genes.games, genes.copies, f.genes, TXT) },
        accessories: { copies: accessories.copies, others: othersIn(c, accessories.games, accessories.copies, f.accessories, TXT).map((o) => o.text) },
        entity
    });
}

/** What the plan and the result tell of the model rule's work: the states and animations left out, and why; what the props entry leaves out. */
function modelStateNotes(w: ModelWork): string[]
{
    const t = w.told;
    return [
        ...(t?.noGroup.length ? [trn('{n} portrait modifier the portrait animations name is not brought in: the mod’s copy of its file has no group of its kind ({list})', '{n} portrait modifiers the portrait animations name are not brought in: the mod’s copies of their files have no group of their kind ({list})', t.noGroup.length, { list: shortList(t.noGroup) })] : []),
        ...(t?.byItself.length ? [trn('{n} portrait modifier the portrait animations name is not brought in: its group in the mod’s copy is applied without being named, it would give the mod’s characters the game’s looks ({list})', '{n} portrait modifiers the portrait animations name are not brought in: their groups in the mod’s copies are applied without being named, they would give the mod’s characters the game’s looks ({list})', t.byItself.length, { list: shortList(t.byItself) })] : []),
        ...(t?.noGene.length ? [trn('{n} gene template the props brought in name is not brought in: the mod’s copy of its file lacks the gene ({list})', '{n} gene templates the props brought in name are not brought in: the mod’s copies of their files lack the gene ({list})', t.noGene.length, { list: shortList(t.noGene) })] : []),
        ...(t?.ownGene.length ? [trn('{n} gene template the props brought in name is not brought in: a file of the mod’s own defines its gene too, which of them loads is unclear ({list})', '{n} gene templates the props brought in name are not brought in: files of the mod’s own define their genes too, which of them loads is unclear ({list})', t.ownGene.length, { list: shortList(t.ownGene) })] : []),
        ...(t?.indices.length ? [trn('{n} gene template brought in has another index than the game’s: the mod’s copy gives the game’s to a template of its own ({list})', '{n} gene templates brought in have other indices than the game’s: the mod’s copies give the game’s to templates of their own ({list})', t.indices.length, { list: shortList(t.indices) })] : []),
        ...(t?.accessories.length ? [trn('{n} accessory the gene templates name is in no loaded file and no copy of the game’s file of it to bring it into ({list})', '{n} accessories the gene templates name are in no loaded file and no copy of the game’s files of them to bring them into ({list})', t.accessories.length, { list: shortList(t.accessories) })] : []),
        ...(t?.entities.length ? [trn('{n} entity the accessories name is in no loaded model file: the prop shows nothing ({list})', '{n} entities the accessories name are in no loaded model file: the props show nothing ({list})', t.entities.length, { list: shortList(t.entities) })] : []),
        ...(w.unplayable.length ? [trn('{n} animation state of the game’s models is left out: no model has the animation it plays ({list})', '{n} animation states of the game’s models are left out: no model has the animations they play ({list})', w.unplayable.length, { list: shortList(w.unplayable) })] : []),
        ...(w.noClip.length ? [trn('{n} animation of the game’s models is left out: its clip is no file of the game or the mods ({list})', '{n} animations of the game’s models are left out: their clips are no files of the game or the mods ({list})', w.noClip.length, { list: shortList(w.noClip) })] : [])
    ];
}

/** The bare words of a list block (`alias = { a b }`). */
const listWords = (n: PNode | undefined): string[] => (n && Array.isArray(n.v) ? n.v.filter((c) => c.k === null && typeof c.v === 'string').map((c) => c.v as string) : []);

/**
 * A database file's merge (migrations.ts `merge`): the game's entries no file of the mod defines (`defined`), as the
 * game writes them; the mod's entries whose `lists` lack words the game's have, as the mod writes them with the words
 * added. Blocks of text, in the game's order. `taken`: the entry keys and list words the mod's files define already
 * (`takenWords`): a word of a list that is one of them is left out of what is written, and the entries written take
 * theirs in turn; a game entry whose key is one is left out (the game refuses a word that collides with a concept or alias: "collides with an existing concept or
 * alias"; the game's `tenet` lists `core_tenet`, which the mod defines as a concept of its own).
 */
function mergeEntries(gameText: string, modText: string, lists: string[], defined: Set<string>, taken: Set<string> = new Set()): string[]
{
    const used = new Set(taken);
    const mod = new Map<string, PNode>();

    for (const n of parse(modText))
        if (n.k && Array.isArray(n.v))
            mod.set(n.k, n);

    const out: string[] = [];

    for (const g of parse(gameText))
    {
        if (!g.k || !Array.isArray(g.v))
            continue;

        const m = mod.get(g.k);

        if (!m)
        {
            // (its key a word of the mod's (an alias of one of its concepts) collides the same way: the entry stays out)
            if (defined.has(g.k) || used.has(g.k))
                continue;

            // (the words of its lists that are taken: cut out; the rest are taken from here on)
            let text = gameText.slice(g.s, g.e);

            for (const key of lists)
            {
                const cur = parse(text)[0];
                const node = Array.isArray(cur?.v) ? cur.v.find((c) => c.k === key) : undefined;
                const words = listWords(node);
                const keep = words.filter((w) => w !== g.k && !used.has(w));

                if (node && keep.length < words.length)
                    text = keep.length ? text.slice(0, node.s) + `${key} = { ${keep.join(' ')} }` + text.slice(node.e) : cutBlock(text, node);

                keep.forEach((w) => used.add(w));
            }

            used.add(g.k);
            out.push(text);
            continue;
        }

        let text = modText.slice(m.s, m.e);
        let changed = false;

        // (the block read again for each list: the offsets move with each change)
        for (const key of lists)
        {
            const gl = (g.v as PNode[]).find((c) => c.k === key);
            const ml = (m.v as PNode[]).find((c) => c.k === key);
            const have = new Set(listWords(ml));
            const add = listWords(gl).filter((w) => !have.has(w) && !used.has(w));

            if (!add.length)
                continue;

            add.forEach((w) => used.add(w));
            const list = `${key} = { ${[...listWords(ml), ...add].join(' ')} }`;
            const cur = parse(text)[0];
            const node = Array.isArray(cur?.v) ? cur.v.find((c) => c.k === key) : undefined;
            text = node ? text.slice(0, node.s) + list + text.slice(node.e) : text.replace('{', `{\n\t${list}`);
            changed = true;
        }

        if (changed)
            out.push(text);
    }

    return out;
}

/** A file's text with the top-level renames of statement groups made (a merge must see an entry the patch mod renames as the mod's). */
function renamedText(text: string, rel: string, groups: StatementGroup[], env: StatementEnv | undefined): string
{
    let out = text;

    for (const g of env ? groups.filter((x) => x.files.some((p) => globMatch(p, rel))) : [])
        out = applyStatementEdits(out, statementEdits(out, rel, g, env!).edits);

    return out;
}

/**
 * The statement rules of every step from 1.19 on, as a function of a path and a definition's text: what an "Update for 1.20"
 * fix outside the migration runs on the text it writes (a tenet moved out of the doctrines gets `has_tenet`, `rite_…` in its
 * rite blocks), so its result is the migration's. `tenets`: the names the index knows as tenets.
 */
export async function statementConverter(host: ModsHost, mod: ModInfo, gameDir: string, gameVersion: string | undefined, tenets: string[]): Promise<(rel: string, text: string) => string>
{
    const steps = migrationsBetween('1.19', gameVersion);
    const env = statementEnv(mod, filesOf(mod), gameDir, undefined, steps, tenets);
    const groups = steps.flatMap((m) => m.statements ?? []);
    // (and what the version added to the game's definitions of the same name: `gains`, without the statements that name what the
    // loaded world lacks, as the migration does)
    const gains = steps.flatMap((m) => m.gains ?? []);
    const absent = host.query && gains.some((g) => g.dropAbsent) ? await absentRefs(host, steps, gameDir) : undefined;
    const cache: GainCache = { mod, modFiles: filesOf(mod), gameDir, absent };
    return (rel, text) =>
    {
        let out = renamedText(text, rel, groups, env);

        for (const g of gains.filter((x) => x.files.some((p) => globMatch(p, rel))))
        {
            const w = gainWorkOf(cache, g);
            out = applyStatementEdits(out, gainEdits(out, g, w.scope, w.game, g.dropAbsent ? absent : undefined).edits);
        }

        return out;
    };
}

/** The entry keys and list words (`lists`: `alias`) the mod's files of a file's folder define (the file itself too) and the other mods' (`others`). */
function takenWords(mod: ModInfo, files: Map<string, { file?: string; entry?: string; }>, rel: string, lists: string[], others?: string[]): Set<string>
{
    const dir = lc(rel.slice(0, rel.lastIndexOf('/') + 1));
    const out = otherKeys(others, rel.slice(0, rel.lastIndexOf('/')), lists);

    for (const [other, where] of files)
    {
        if (!lc(other).startsWith(dir) || other.slice(dir.length).includes('/') || !/\.txt$/i.test(other))
            continue;

        for (const n of parse(modText(mod, other, where) ?? ''))
        {
            if (n.k)
                out.add(n.k);

            for (const c of Array.isArray(n.v) ? n.v : [])
                if (c.k && lists.includes(c.k))
                    listWords(c).forEach((w) => out.add(w));
        }
    }

    return out;
}

/**
 * The steps' file rules that concern the mod (migrations.ts `renames`, `restore`): the files holding a key to rename;
 * the game's files the mod overrides that the version changed so that the mod's copy breaks.
 */
export function fileRules(mod: ModInfo, steps: Migration[], gameDir: string, files = filesOf(mod), script?: StatementEnv, patchRoot?: string, extraRestore: string[] = [], leftAlone?: LeftAlone, world: RuleWorld = {}, stop: () => void = () => undefined): FileRule[]
{
    // (`stop`: the job's look at Cancel, between the rule kinds; it throws, and nothing the call made is kept)
    const out: FileRule[] = [];
    // (a copy that is the game's file or carries what it has needs neither rule: `copyState`)
    const groups = steps.flatMap((m) => m.dataCalls ?? []);
    const states = new Map<string, 'same' | 'current' | undefined>();
    const stateAlone = (rel: string): 'same' | 'current' | undefined =>
    {
        if (!states.has(rel))
            states.set(rel, copyState(mod, files.get(rel)!, rel, gameDir, groups, script));

        return states.get(rel);
    };
    // (a current effect file that includes a file of the mod's own addition that is merged is merged too: the pair agrees (`pairedWithReplaced`))
    let paired: Set<string> | undefined;
    const pairedOf = (): Set<string> =>
    {
        if (!paired)
        {
            const given = steps.flatMap((m) => [...(m.mergeShaders ?? []), ...(m.restore ?? [])]);
            const named = [...files.keys()].filter((rel) => isFxFile(rel) && !!gameFile(gameDir, rel) && given.some((r) => r.files.some((p) => globMatch(p, rel))));
            const current = new Map(named.filter((rel) => stateAlone(rel) === 'current').map((rel) => [rel, { mod: modText(mod, rel, files.get(rel)!) ?? '', game: readTextFile(gameFile(gameDir, rel)!) }]));
            paired = pairedWithReplaced(current, named.filter((rel) => !stateAlone(rel)));
        }

        return paired;
    };
    const stateOf = (rel: string): 'same' | 'current' | undefined => (stateAlone(rel) === 'current' && isFxFile(rel) && pairedOf().has(rel) ? undefined : stateAlone(rel));
    // (effect files merged with the mod's effects, by any step; the first rule that names a file has it: no step restores it
    // whole, the two rules would fight over the file; `keep`: the ones that need no merge, still read as restored files)
    const merging = new Set<string>();
    const mergeHits = steps.map((m) => (m.mergeShaders ?? []).map((r) =>
    {
        const hits = [...files.keys()].filter((rel) => isFxFile(rel) && r.files.some((p) => globMatch(p, rel)) && !merging.has(rel) && !!gameFile(gameDir, rel));

        for (const rel of hits)
            merging.add(rel);

        const keep = hits.filter((rel) => stateOf(rel));

        for (const rel of keep)
            leftAlone?.set(rel, stateOf(rel)!);

        return { files: hits.filter((rel) => !keep.includes(rel)), keep };
    }));

    for (const [stepIndex, m] of steps.entries())
    {
        stop();

        for (const r of m.renames ?? [])
        {
            const hits = [...files].filter(([rel]) => r.folders.some((f) => lc(rel).startsWith(lc(f) + '/')) && /\.txt$/i.test(rel))
                .filter(([rel, where]) => renameSites(modText(mod, rel, where) ?? '', r.from).length)
                .map(([rel]) => rel);

            if (hits.length)
                out.push({ kind: 'rename', label: r.label, files: hits, from: r.from, to: r.to, definedParameter: r.definedParameter, drop: r.drop });
        }

        stop();
        // (effect files the mod overrides: merged with the game's, so its own effects stay, not restored whole)
        const mergeRules: FileRule[] = [];

        for (const [i, r] of (m.mergeShaders ?? []).entries())
        {
            const hits = mergeHits[stepIndex][i];

            // (a copy that stays calls a game function the version gave another parameter list: the rule writes it with the calls adapted, shaderCalls.ts)
            const own = hits.keep.length && !hits.files.length ? new Set([...files].filter(([rel]) => isFxFile(rel) && !gameFile(gameDir, rel)).flatMap(([rel, where]) => [...definedWithOldParams(modText(mod, rel, where) ?? '')])) : undefined;
            const adapting = !!own && hits.keep.some((rel) => callsToAdapt(modText(mod, rel, files.get(rel)!) ?? '', own));

            if (hits.files.length || adapting)
                mergeRules.push({ kind: 'mergefx', label: r.label, files: hits.files, keep: hits.keep });
        }

        for (const r of m.restore ?? [])
        {
            const found = [...files.keys()].filter((rel) => r.files.some((p) => globMatch(p, rel)) && !merging.has(rel) && !!gameFile(gameDir, rel));
            const hits = found.filter((rel) => !stateOf(rel));

            for (const rel of found.filter((x) => !hits.includes(x)))
                leftAlone?.set(rel, stateOf(rel)!);

            if (hits.length)
                out.push({ kind: 'restore', label: r.label, files: hits });
        }

        out.push(...mergeRules);

        // (interface files the owner chose to take whole from the game, in the dialog: restored like the rest)
        if (stepIndex === steps.length - 1)
        {
            const chosen = [...files.keys()].filter((rel) => extraRestore.some((x) => lc(x) === lc(rel)) && !!gameFile(gameDir, rel) && !out.some((r) => r.kind === 'restore' && r.files.includes(rel)));

            // (whatever they hold: chosen ones are not left alone)
            for (const rel of chosen)
                leftAlone?.delete(rel);

            if (chosen.length)
                out.push({ kind: 'restore', label: tr('Interface files taken whole from the game, as chosen'), files: chosen });
        }

        // (a game file the version removed: the mod's copy still registers what the new files define)
        for (const r of m.removed ?? [])
        {
            const hits = [...files.keys()].filter((rel) => r.files.some((p) => globMatch(p, rel)) && !gameFile(gameDir, rel));

            if (hits.length)
                out.push({ kind: 'empty', label: r.label, files: hits });
        }

        // (a game file in a subfolder of a folder the mod replaces still loads: its titles are the game's)
        for (const r of m.survivors ?? [])
        {
            const found = survivingFiles(mod, gameDir, files, r, world.absent);

            if (found.size)
                out.push({
                    kind: 'empty', label: r.label, files: [...found.keys()],
                    // (a world that has some of the file's entries keeps the game's text of those: only the absent ones are cut out)
                    trim: new Map([...found].filter(([, f]) => !f.all).map(([rel, f]) => [rel, f.names])),
                    notes: [...found].map(([rel, { names, all }]) => all
                        ? tr('{file}: replace_path of {folder} does not reach files in a subfolder, so the game’s file still loads, and {n} of its entries are not in the loaded files ({list}) — an empty file of the same path in the patch mod', { file: rel, folder: r.folder, n: names.length, list: shortList(names, 4) })
                        : tr('{file}: replace_path of {folder} does not reach files in a subfolder, so the game’s file still loads, and {n} of its entries are not in the loaded files ({list}) — the game’s file in the patch mod without them', { file: rel, folder: r.folder, n: names.length, list: shortList(names, 4) }))
                });
        }

        stop();

        // (settings the game's version of a named block has and the mod's copy lacks)
        for (const r of m.settings ?? [])
        {
            const hits = [...files].filter(([rel, where]) =>
            {
                const matches = r.files.some((p) => globMatch(p, rel));
                const g = matches ? gameFile(gameDir, rel) : undefined;
                return matches && (!!g || !!r.own) && missingSettings(g ? readTextFile(g) : '', modText(mod, rel, where) ?? '', r.block, r.keys, r.own).length > 0;
            }).map(([rel]) => rel);

            if (hits.length)
                out.push({ kind: 'settings', label: r.label, files: hits, block: r.block, keys: r.keys, ...(r.own ? { own: true } : {}) });
        }

        stop();

        // (the animation states and animations the version added to the game's portrait models, for the mod's copies of them)
        for (const r of m.modelStates ?? [])
        {
            const rule: FileRule = { kind: 'modelStates', label: r.label, files: [], models: r.files, animations: r.animations, ...(r.packs ? { packs: r.packs } : {}), ...(r.props ? { props: r.props } : {}) };
            const w = modelStatesWork({ mod, modFiles: files, gameDir, patchRoot }, rule, (rel) => modText(mod, rel, files.get(rel)!));
            const notes = modelStateNotes(w);

            if (w.adds.size)
                out.push({ ...rule, files: [...w.adds.keys()], ...(notes.length ? { notes } : {}) });
        }

        stop();

        for (const r of m.rewrites ?? [])
        {
            const re = new RegExp(r.find);
            const hits = [...files].filter(([rel, where]) => r.files.some((p) => globMatch(p, rel)) && re.test(modText(mod, rel, where) ?? '')).map(([rel]) => rel);

            if (hits.length)
                out.push({ kind: 'rewrite', label: r.label, files: hits, find: r.find, replace: r.replace });
        }

        stop();

        // (defines the game's version has and the mod's copy lacks)
        // (and the paths the copy points where nothing is any more, the game's values instead: `defineDiff.ts`)
        for (const r of m.defines ?? [])
        {
            const paths = pathTest({ gameDir, modFiles: files.keys(), patchRoot, others: world.others });
            const stale: string[] = [];
            const lists = defineLists(r.lists, world.absent);
            const hits = [...files].filter(([rel, where]) =>
            {
                const g = lc(rel).startsWith(lc(r.folder) + '/') && /\.txt$/i.test(rel) ? gameFile(gameDir, rel) : undefined;
                return !!g && missingDefines(readTextBody(g), modText(mod, rel, where) ?? '', paths, stale, definesElsewhere(mod, files, rel, world.others), lists).size > 0;
            }).map(([rel]) => rel);
            const notes = [
                ...(stale.length ? [tr('Paths the mod’s copy points where nothing is any more, the game’s values instead: {keys}', { keys: stale.join(', ') })] : []),
                ...[...new Set(lists?.listed)].map((l) => tr('A list the mod’s copy has, with the words 1.20 added that the loaded files define an entry for ({list})', { list: l }))
            ];

            if (hits.length)
                out.push({ kind: 'defines', label: r.label, files: hits, folder: r.folder, ...(r.lists ? { defineLists: r.lists } : {}), ...(notes.length ? { notes } : {}) });
        }

        stop();

        // (icons the version moved and renamed: planned on the mod's files; carried out after the fixes, which move
        // entries into the patch mod)
        for (const r of m.icons ?? [])
        {
            const w = iconWork(mod, files, gameDir, r, undefined, script?.sets.tenets);
            const hits = [...w.renames.keys(), ...w.copies.keys()];

            if (hits.length)
                out.push({ kind: 'icons', label: r.label, files: hits, icon: r });
        }

        stop();

        // (script statements the version changed: found in the parsed script, in the mod's files and the patch mod's own)
        if (script && m.statements?.length)
            out.push(...statementRules(mod, files, m.statements, script, patchRoot, stop));

        stop();

        // (statements the version requires that the mod's definitions lack)
        for (const r of m.adds ?? [])
        {
            const cache: AddCache = { gameDir, absent: world.absent };
            const hits = [...files].filter(([rel, where]) => r.files.some((p) => globMatch(p, rel)) && /\.txt$/i.test(rel) && addKeyEdits(modText(mod, rel, where) ?? '', r, gameAddsOf(cache, r)).length > 0).map(([rel]) => rel);

            if (hits.length)
                out.push({ kind: 'adds', label: r.label, files: hits, add: r });
        }

        stop();

        // (what the version added to the definitions the mod's older files still hold: planned on the mod's files (where the
        // fixes move tenets and law groups from) and the patch mod's own)
        for (const r of m.gains ?? [])
        {
            const w = gainWorkOf({ mod, modFiles: files, gameDir, absent: world.absent }, r);
            const patterns = [...r.files, ...(r.pending ?? [])];
            const edits = (text: string | undefined): boolean => !!text && gainEdits(text, r, w.scope, w.game, r.dropAbsent ? world.absent : undefined).edits.length > 0;
            const hits = [...files].filter(([rel, where]) => /\.txt$/i.test(rel) && patterns.some((p) => globMatch(p, rel)) && edits(modText(mod, rel, where))).map(([rel]) => rel);
            const own = patchFilesFor(patchRoot, r.files).filter((rel) => !files.has(rel) && edits(currentText({ mod, modFiles: files, patchRoot }, rel)));
            // (the mod's own tenets the game gives no personal tenet settings: told, never invented; only for a mod that shows no sign of knowing the settings)
            const gaps = (hits.length || own.length) && r.gaps === 'tenets' && w.scope.keys.length
                ? tenetGapNotes(tenetGaps([...files].filter(([rel]) => /\.txt$/i.test(rel) && patterns.some((p) => globMatch(p, rel))).map(([rel, where]) => modText(mod, rel, where) ?? ''), ['personal_tenet_modifier', 'personal_tenet_parameters'], w.game, gameNamedTenets(gameDir)))
                : [];

            if (hits.length || own.length)
                out.push({ kind: 'gains', label: r.label, files: [...hits, ...own], gain: r, ...(gaps.length ? { notes: gaps } : {}) });
        }

        stop();
        // (tenet banners: the mod's families and the religions that overrode one, and the patch mod's own copies)
        out.push(...bannerRules(mod, files, gameDir, m.banners ?? [], patchRoot));
        stop();

        // (calls in interface and localization text the version renamed or moved: the mod's files that a restore or an emptying
        // does not take whole)
        if (script)
            out.push(...callRules(mod, files, m.dataCalls ?? [], dataCallEnv(gameDir, script.sets.tenets, world.namedKeys), new Set(out.filter((r) => r.kind === 'restore' || r.kind === 'mergefx' || r.kind === 'empty').flatMap((r) => r.files.map(lc)))));

        stop();

        // (particle graphs, textures: the mod's files read by the rules in textureRule.ts)
        if (gameDir)
            out.push(...textureRules(m, { mod, modFiles: files, gameDir, patchRoot }));

        stop();

        // (database files the mod overrides with an older copy: what the game's version adds; the entries the statement
        // rules rename at the top (a scripted rule) count under their new names)
        const topGroups = (m.statements ?? []).filter((g) => g.rules.some((x) => x.top));

        for (const r of m.merge ?? [])
        {
            const hits = [...files.keys()].filter((rel) => mergeBlocks(mod, files, rel, gameDir, r, topGroups, script, world.others).length > 0);

            if (hits.length)
                out.push({ kind: 'merge', label: r.label, files: hits, lists: r.lists, topGroups });
        }

        // (the entries and values the game renamed that the copies still name: last, it edits the copies as the rules before leave
        // them; a rule with nothing to write still tells its entries, and its aliases reach the inert step)
        const w = world.renamed;

        if (m.renamed && w && (w.entries.length || w.values.length))
            out.push({ kind: 'renamed', label: m.renamed.label, files: [...w.files.keys(), ...w.outputs.keys()], renamed: w, notes: renameNotes(w) });
    }

    return out;
}

/** The particle and texture rules of a step that concern the mod (migrations.ts `particles`, `ddsLegacy`, `maskMips`). */
function textureRules(m: Migration, c: TextureCtx): FileRule[]
{
    const out: FileRule[] = [];

    for (const r of m.particles ?? [])
    {
        const h = particleHits(c, r.folder, r.compounds);

        if (h.files.length)
            out.push({
                kind: 'particles', label: r.label, files: h.files, folder: r.folder, compounds: r.compounds,
                notes: h.left.length ? [trn('{n} compound graph name matches one of the game’s but its pins do not fit — left as written: {list}', '{n} compound graph names match one of the game’s but their pins do not fit — left as written: {list}', h.left.length, { list: shortList(h.left) })] : undefined
            });
    }

    for (const r of m.ddsLegacy ?? [])
    {
        const h = ddsHits(c, r.folder);

        if (h.files.length)
            out.push({
                kind: 'ddsLegacy', label: r.label, files: h.files, folder: r.folder,
                notes: h.srgb.length ? [trn('{n} of them is a sRGB format; the plain header cannot say so (the game’s own are plain: {list})', '{n} of them are sRGB formats; the plain header cannot say so (the game’s own are plain: {list})', h.srgb.length, { list: shortList(h.srgb) })] : undefined
            });
    }

    for (const r of m.maskMips ?? [])
    {
        const h = maskHits(c, r.folder);

        if (h.files.length)
            out.push({
                kind: 'maskMips', label: r.label, files: h.files, folder: r.folder,
                notes: h.shape ? [tr('The game’s colormask textures are {width}×{height} {format} with {mips} mip levels; {n} of the mod’s have more', { width: h.shape.width, height: h.shape.height, format: h.shape.format, mips: h.shape.mips, n: h.files.length })] : undefined
            });
    }

    return out;
}

/**
 * What the interface rules work with (guiWork.ts): the interface files other rules take whole or empty, the files with a call no
 * rewrite maps, and the names the data call rules map (the game version removed them, but they are handled).
 */
function guiConfig(steps: Migration[], rules: FileRule[]): { restore: string[]; empty: string[]; candidates: string[]; covered: string[]; }
{
    const gui = (rel: string): boolean => /^gui\/.*\.gui$/i.test(rel);
    const covered = new Set<string>();

    for (const g of steps.flatMap((m) => m.dataCalls ?? []))
        // (a dropped property's call is not covered: where it stays (part of a larger expression) it is an unknown name)
        for (const r of g.rules.filter((x) => !x.report && !x.dropProperty))
            for (const name of r.name.split('.'))
                covered.add(name);

    return {
        restore: rules.filter((r) => r.kind === 'restore').flatMap((r) => r.files).filter(gui).map(lc),
        empty: rules.filter((r) => r.kind === 'empty').flatMap((r) => r.files).filter(gui).map(lc),
        candidates: rules.filter((r) => r.kind === 'dataCalls').flatMap((r) => [...(r.leftBy?.keys() ?? [])]).filter(gui),
        covered: [...covered]
    };
}

/** The data call rules the carried interface types go through (guiRule.ts): the groups of the steps and what they read. */
/** The mod's important actions and scripted GUIs (the script that opens or runs interface), read as the mod wrote them. */
function scriptTexts(mod: ModInfo): { actions: ScriptText[]; guis: ScriptText[]; }
{
    const of = (folder: string): ScriptText[] => [...filesOf(mod)]
        .filter(([rel]) => lc(rel).startsWith(folder + '/') && /\.txt$/i.test(rel))
        .map(([rel, where]) => ({ rel, text: modText(mod, rel, where) ?? '' }));

    return { actions: of('common/important_actions'), guis: of('common/scripted_guis') };
}

function guiCalls(steps: Migration[], gameDir: string, script: { sets: Record<string, Set<string>>; } | undefined): { groups: DataCallGroup[]; env: ReturnType<typeof dataCallEnv>; }
{
    return { groups: steps.flatMap((m) => m.dataCalls ?? []), env: dataCallEnv(gameDir, script?.sets.tenets ?? new Set<string>()) };
}

/**
 * The data call groups that concern the mod (migrations.ts `dataCalls`): per group the mod's files with a call to rewrite (or one
 * no rewrite maps), read as the mod wrote them. `taken`: files another rule takes whole (a restored game file, an emptied one).
 */
function callRules(mod: ModInfo, files: Map<string, { file?: string; entry?: string; }>, groups: DataCallGroup[], env: ReturnType<typeof dataCallEnv>, taken: Set<string>): FileRule[]
{
    const out: FileRule[] = [];

    for (const [gi, g] of groups.entries())
    {
        const hits: string[] = [];
        const left: string[] = [];
        const dropped: string[] = [];
        const contexts: ContextChange[] = [];
        const leftBy = new Map<string, string[]>();

        for (const [rel, where] of files)
        {
            if (!/\.(gui|yml)$/i.test(rel) || taken.has(lc(rel)) || !g.files.some((p) => globMatch(p, rel)))
                continue;

            const own = modText(mod, rel, where);
            // (the context rule reads a text as the run leaves it to it: after the groups before it)
            const text = own && g.contexts ? textAfterGroups(own, rel, groups.slice(0, gi), env) : own;
            const r = text ? dataCallEdits(text, rel, g, env) : undefined;

            if (r && (r.edits.length || r.left.length || r.contexts?.length))
            {
                hits.push(rel);
                left.push(...r.left.map((l) => `${rel}: ${l}`));
                dropped.push(...r.dropped);
                contexts.push(...(r.contexts ?? []));

                if (r.left.length)
                    leftBy.set(rel, r.left);
            }
        }

        if (hits.length)
            out.push({ kind: 'dataCalls', label: g.label, files: hits, calls: g, notes: dataCallNotes(left, dropped, contexts), leftBy });
    }

    return out;
}

/** A file's text after the data call groups (those that are no context rule and concern the file), one after the other, as a run writes it. */
function textAfterGroups(text: string, rel: string, groups: DataCallGroup[], env: ReturnType<typeof dataCallEnv>): string
{
    let cur = text;

    for (const g of groups.filter((x) => !x.contexts && x.files.some((p) => globMatch(p, rel))))
        cur = applyCallEdits(cur, dataCallEdits(cur, rel, g, env).edits);

    return cur;
}

/**
 * The `renamed` rule's work (renameRule.ts) on the mod's files as the patch mod holds them now: the index answers which names the
 * loaded world has, and `planned` (`mergeDefinitions`) the entries the run writes before the rule's files. The keys the steps'
 * statement rules rename are theirs (`handled`).
 */
function renamedWorld(host: ModsHost, mod: ModInfo, modFiles: Map<string, { file?: string; entry?: string; }>, gameDir: string, patchRoot: string | undefined, others: string[] | undefined, folder: string, steps: Migration[], planned: Set<string>, stop?: () => void): Promise<RenameWork>
{
    const handled = new Set(steps.flatMap((m) => m.statements ?? []).flatMap((g) => g.rules).flatMap((r) => [r.key, r.rename]).filter((k): k is string => !!k));
    const carried = steps.flatMap((m) => m.libraries?.folders.map((f) => f.folder) ?? []);
    const stat = (file: string): string =>
    {
        try
        {
            const s = statSync(file);
            return `${file}:${s.size}:${s.mtimeMs}`;
        }
        catch
        {
            return `${file}:-`;
        }
    };
    return renameWork(
        {
            gameDir, modFiles: [...modFiles.keys()], patchRoot, others, patchFolder: folder, handled, carried, planned, stop,
            modText: (rel) => (modFiles.has(rel) ? modText(mod, rel, modFiles.get(rel)!) : undefined),
            currentText: (rel) => currentText({ mod, modFiles, patchRoot }, rel),
            // (the mod's file, or its zip and entry, and the patch mod's copy)
            stamp: (rel) =>
            {
                const where = modFiles.get(rel);
                const own = where?.file ? stat(where.file) : where?.entry && mod.archive ? `${stat(mod.archive)}|${where.entry}` : undefined;
                return own && `${own}|${patchRoot ? stat(join(patchRoot, ...rel.split('/'))) : '-'}`;
            }
        },
        async (names) => (names.length && host.query ? (await host.query<Record<string, 'defined' | 'known'> | null>('migrationKnown', names)) ?? {} : {})
    );
}

/**
 * The localization keys a context rule (`DataCallGroup.contexts`) would rename or replace in the mod's texts that a loaded file names
 * (`loadedNames`: the game's layers, the mod, its patch mod as it stands, the other mods of the list; any file but localization,
 * effect files and documentation, comments too): such a key gets its data context from what names it (AGOT's EDUCATE_… keys are
 * a custom_description of its own script, which passes a faith), not from the game's program, and is left alone. Asked once per plan
 * or run, for the keys the rule would touch only (none: nothing is read).
 */
export async function namedContextKeys(c: { mod: ModInfo; modFiles: Map<string, { file?: string; entry?: string; }>; gameDir: string; patchRoot?: string; others?: string[]; }, steps: Migration[], script: StatementEnv | undefined, stop?: () => void): Promise<Set<string>>
{
    const groups = steps.flatMap((m) => m.dataCalls ?? []);
    const keys = new Set<string>();

    if (!groups.some((g) => g.contexts))
        return keys;

    // (every string of the executable counts as filled by the program here: the loaded files decide below)
    const env = dataCallEnv(c.gameDir, script?.sets.tenets ?? new Set<string>(), new Set());

    for (const [gi, g] of groups.entries())
    {
        if (!g.contexts)
            continue;

        for (const [rel, where] of c.modFiles)
        {
            if (!/\.yml$/i.test(rel) || !g.files.some((p) => globMatch(p, rel)))
                continue;

            stop?.();
            const own = modText(c.mod, rel, where);

            // (a key the mod's file keeps the game's text of as a comment is left anyway: not asked)
            for (const x of own ? dataCallEdits(textAfterGroups(own, rel, groups.slice(0, gi), env), rel, g, env).contexts ?? [] : [])
                if (!x.kept)
                    keys.add(x.key);
        }
    }

    if (!keys.size)
        return keys;

    return loadedNames(
        [...layerRoots(c.gameDir), ...(c.patchRoot ? [c.patchRoot] : []), ...(c.others ?? [])],
        [...c.modFiles].map(([rel, where]) => ({ rel, read: () => (where.file ? readFileSync(where.file) : where.entry && c.mod.archive ? zipEntry(c.mod.archive, where.entry) : undefined) })),
        [...keys],
        stop,
        new Set(layerRoots(c.gameDir)));
}

type IconRule = NonNullable<Migration['icons']>[number];

/** The definitions of a text naming an icon (`icon = x`, or by their key): the key, the node to rewrite, the name. */
function iconRefs(text: string): { key: string; node: PNode | undefined; name: string; }[]
{
    const out: { key: string; node: PNode | undefined; name: string; }[] = [];

    for (const n of parse(text))
    {
        if (!n.k || !Array.isArray(n.v))
            continue;

        const icon = n.v.find((c) => c.k === 'icon' && typeof c.v === 'string');
        out.push({ key: n.k, node: icon, name: icon ? (icon.v as string).replace(/^"|"$/g, '') : n.k });
    }

    return out;
}

/**
 * An icon rule's work (migrations.ts `icons`): per file the definitions whose icon to rename (the game has it under the
 * new name), and the icons to copy into the new folder (the mod's, or the game's, in the old one). `patchRoot`: the
 * patch mod's files count too (and override the mod's of the same path); without it the plan reads the mod's files,
 * `alsoPlan` folders included, but only the definitions of those that are tenets (`tenets`: 1.19 wrote them as doctrines, the
 * fixes move them; a doctrine keeps its icon in faith_doctrines and has nothing to copy).
 */
function iconWork(mod: ModInfo, modFiles: Map<string, { file?: string; entry?: string; }>, gameDir: string, r: IconRule, patchRoot?: string, tenets?: Set<string>): { renames: Map<string, { s: number; e: number; name: string; }[]>; copies: Map<string, { file?: string; entry?: string; game?: string; }>; }
{
    const also = (patchRoot || !tenets ? [] : (r.alsoPlan ?? [])).map(lc);
    const folders = [...r.folders.map(lc), ...also];
    const inFolders = (rel: string): boolean => folders.some((f) => lc(rel).startsWith(f + '/')) && /\.txt$/i.test(rel);
    const texts = new Map<string, string>();

    for (const [rel, where] of modFiles)
        if (inFolders(rel))
            texts.set(rel, modText(mod, rel, where) ?? '');

    if (patchRoot)
    {
        for (const f of r.folders)
        {
            const dir = join(patchRoot, ...f.split('/'));

            if (existsSync(dir))
                for (const name of readdirSync(dir))
                    if (/\.txt$/i.test(name))
                        texts.set(`${f}/${name}`, readTextBody(join(dir, name)));
        }
    }

    const has = (rel: string): boolean => modFiles.has(rel) || !!gameFile(gameDir, rel) || (!!patchRoot && existsSync(join(patchRoot, ...rel.split('/'))));
    const renames = new Map<string, { s: number; e: number; name: string; }[]>();
    const copies = new Map<string, { file?: string; entry?: string; game?: string; }>();

    for (const [rel, text] of texts)
    {
        const doctrines = also.some((f) => lc(rel).startsWith(f + '/'));

        for (const ref of iconRefs(text))
        {
            if ((doctrines && !tenets!.has(ref.key)) || has(`${r.to}/${ref.name}.dds`))
                continue;

            const renamed = r.prefix && ref.name.startsWith(r.prefix[0]) ? r.prefix[1] + ref.name.slice(r.prefix[0].length) : undefined;

            if (renamed && ref.node && has(`${r.to}/${renamed}.dds`))
            {
                renames.set(rel, [...(renames.get(rel) ?? []), { s: ref.node.s, e: ref.node.e, name: renamed }]);
                continue;
            }

            const old = `${r.from}/${ref.name}.dds`;
            const src = modFiles.get(old) ?? (gameFile(gameDir, old) ? { game: gameFile(gameDir, old) } : undefined);

            if (src)
                copies.set(`${r.to}/${ref.name}.dds`, src);
        }
    }

    return { renames, copies };
}

/** What a file read once gave (`otherKeys`), by its path, size and time: a plan reads the same few files for every rule. */
const keysCache = new Map<string, { sig: string; keys: string[]; }>();

/**
 * What the other mods of the loaded list (`roots`) define in the .txt files directly in a folder: their top-level keys and the
 * words of the `lists` blocks (`defines`: `namespace|key` in lower case). A file the patch mod writes (`zz_…`) loads after
 * every ordinary file of that folder, whichever mod comes first in the list, so it must not set what another mod sets.
 * The files another patch mod generates (its manifest's `generated`: the game's own entries, copied) are not counted: each patch
 * mod carries the game's content its mod lacks, so a second one writes it too: the same values, and each stands on its own.
 */
function otherKeys(roots: string[] | undefined, dir: string, lists: string[] | 'defines'): Set<string>
{
    const out = new Set<string>();

    for (const root of roots ?? [])
    {
        const folder = join(root, ...dir.split('/'));
        const generated = new Set((readManifest(root)?.generated ?? []).map(lc));
        let names: string[];

        try
        {
            names = readdirSync(folder).filter((n) => /\.txt$/i.test(n) && !generated.has(lc(`${dir}/${n}`)));
        }
        catch
        {
            continue;
        }

        for (const name of names)
        {
            const file = join(folder, name);
            const key = file + '|' + (lists === 'defines' ? '' : lists.join(','));

            try
            {
                const st = statSync(file);
                const sig = `${st.size}|${st.mtimeMs}`;
                let hit = keysCache.get(key);

                if (!hit || hit.sig !== sig)
                {
                    const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
                    const keys: string[] = [];

                    if (lists === 'defines')
                        keys.push(...definedKeys(text));
                    else
                        for (const n of parse(text))
                        {
                            if (n.k)
                                keys.push(n.k);

                            for (const c of Array.isArray(n.v) ? n.v : [])
                                if (c.k && lists.includes(c.k))
                                    keys.push(...listWords(c));
                        }

                    hit = { sig, keys };
                    keysCache.set(key, hit);
                }

                hit.keys.forEach((k) => out.add(k));
            }
            catch
            {
                // (unreadable: not counted)
            }
        }
    }

    return out;
}

/** The defines the mod's other files in a defines folder and the other mods' set (`namespace|key`, lower case): the patch mod's file leaves them. */
function definesElsewhere(mod: ModInfo, files: Map<string, { file?: string; entry?: string; }>, rel: string, others?: string[]): Set<string>
{
    const dir = lc(rel.slice(0, rel.lastIndexOf('/') + 1));
    const out = otherKeys(others, rel.slice(0, rel.lastIndexOf('/')), 'defines');

    for (const [other, where] of files)
        if (other !== rel && lc(other).startsWith(dir) && !other.slice(dir.length).includes('/') && /\.txt$/i.test(other))
            definedKeys(modText(mod, other, where) ?? '', out);

    return out;
}

/** The top-level keys the mod's other files of a file's folder define (a merge adds no entry the mod has anywhere). */
function definedIn(mod: ModInfo, files: Map<string, { file?: string; entry?: string; }>, rel: string, others?: string[], lists: string[] = []): Set<string>
{
    const dir = lc(rel.slice(0, rel.lastIndexOf('/') + 1));
    const out = otherKeys(others, rel.slice(0, rel.lastIndexOf('/')), lists);

    for (const [other, where] of files)
        if (other !== rel && lc(other).startsWith(dir) && !other.slice(dir.length).includes('/') && /\.txt$/i.test(other))
            for (const n of parse(modText(mod, other, where) ?? ''))
                if (n.k)
                    out.add(n.k);

    return out;
}

/** The file a merge writes for a folder of the mod's files, in the patch mod. */
const mergeFile = (dir: string, patchFolderName: string): string => `${dir}/zz_${patchFolderName}_${dir.split('/').pop()}.txt`;

/** A merge rule's blocks for a file of the mod (`mergeEntries`, against the game's file of its path): none when the rule does not cover the file or the game has no such file. */
function mergeBlocks(mod: ModInfo, files: Map<string, { file?: string; entry?: string; }>, rel: string, gameDir: string, r: { files: string[]; lists: string[]; }, topGroups: StatementGroup[], script: StatementEnv | undefined, others: string[] | undefined): string[]
{
    const g = r.files.some((p) => globMatch(p, rel)) ? gameFile(gameDir, rel) : undefined;
    return g ? mergeEntries(readTextFile(g), renamedText(modText(mod, rel, files.get(rel)!) ?? '', rel, topGroups, script), r.lists, definedIn(mod, files, rel, others, r.lists), takenWords(mod, files, rel, r.lists, others)) : [];
}

/**
 * The keys of the entries the merge rules write into the patch mod (`mergeBlocks`: the game's entries the mod's older copies lack, the
 * mod's own with the game's list words added): defined once the run has written them. The renamed rule counts them as defined
 * (`RenameInput.planned`): it decides at the run's start, from the index, and without them a value the game spells as such an entry (a
 * game concept the mod's copy of the concept file lacks) would wait for a second run; the plan counts them the same way.
 */
export function mergeDefinitions(mod: ModInfo, steps: Migration[], gameDir: string, files: Map<string, { file?: string; entry?: string; }>, script?: StatementEnv, others?: string[]): Set<string>
{
    const out = new Set<string>();

    for (const m of steps)
    {
        const topGroups = (m.statements ?? []).filter((g) => g.rules.some((x) => x.top));

        for (const r of m.merge ?? [])
            for (const rel of files.keys())
                for (const block of mergeBlocks(mod, files, rel, gameDir, r, topGroups, script, others))
                    for (const n of parse(block))
                        if (n.k && Array.isArray(n.v))
                            out.add(n.k);
    }

    return out;
}

/** A merge rule's files in the patch mod: per folder the `zz_` file (its path, its text) and the mod's files it covers. */
function mergeOutputs(rule: FileRule, c: RuleContext): Map<string, { text: string; files: string[]; }>
{
    const byDir = new Map<string, { blocks: string[]; files: string[]; eol: string; }>();

    for (const rel of rule.files)
    {
        const dir = rel.slice(0, rel.lastIndexOf('/'));
        const own = modText(c.mod, rel, c.modFiles.get(rel)!) ?? '';
        const blocks = mergeEntries(readTextFile(gameFile(c.gameDir, rel)!), renamedText(own, rel, rule.topGroups ?? [], c.script), rule.lists!, definedIn(c.mod, c.modFiles, rel, c.others, rule.lists), takenWords(c.mod, c.modFiles, rel, rule.lists!, c.others));
        const cur = byDir.get(dir) ?? { blocks: [], files: [], eol: eolOf(own) };
        byDir.set(dir, { blocks: [...cur.blocks, `# from ${rel}`, ...blocks], files: [...cur.files, rel], eol: cur.eol });
    }

    const out = new Map<string, { text: string; files: string[]; }>();

    // (the entries come from files with either line end: the merged file has one, the first mod file's. The header keeps the
    // em dash earlier runs wrote: `mergeDone` compares the whole text)
    for (const [dir, { blocks, files, eol }] of byDir)
        out.set(mergeFile(dir, c.folder), { text: lineEnds('﻿' + `# ${dir} — merged by CrusaderPope\n\n` + blocks.join('\n\n') + '\n', eol), files });

    return out;
}

/** A text with the line end `eol` throughout. */
const lineEnds = (text: string, eol: string): string => text.replace(/\r?\n/g, eol);

/**
 * What the texts rule reads (hiddenTexts.ts): the mod's files as they load now (the patch mod's copy, else the mod's), the patch mod
 * on disk, the other mods of the list, the replace paths of the mod and its patch mod; `extra`: texts about to be written (the plan:
 * the merge and libraries rules' files, which the run writes before it); `renamed`: the renamed rule's aliases (`RenameWork.aliases`),
 * the names the texts that come back are to name.
 */
export function textsInput(c: { mod: ModInfo; modFiles: Map<string, { file?: string; entry?: string; }>; gameDir: string; patchRoot?: string; others?: string[]; }, folder: string, patch: ModInfo | undefined, patterns: string[], extra: string[], renamed?: RenameWork['aliases']): TextsInput
{
    return {
        gameDir: c.gameDir,
        modFiles: c.modFiles,
        readMod: (rel) => currentText(c, rel),
        modBytes: (rel) =>
        {
            const where = c.modFiles.get(rel);
            return where?.file ? readFileSync(where.file) : where?.entry && c.mod.archive ? zipEntry(c.mod.archive, where.entry) : undefined;
        },
        patchRoot: c.patchRoot,
        folder,
        others: c.others,
        replacePaths: [...(c.mod.replacePaths ?? []), ...(patch?.replacePaths ?? [])],
        patterns,
        extra,
        globMatch,
        ...(renamed?.length ? { renamed: renamed.map((r) => ({ from: r.from, to: r.to, ...(r.links?.length ? { links: r.links } : {}) })) } : {})
    };
}

/** What the plan and the result tell of the texts rule: per copy the keys that come back, and the ones it lacks that nothing loaded uses. */
function textsNotes(w: TextsWork): string[]
{
    return textsSummary(w).flatMap((x) => [
        ...(x.keys.length ? [trn('{file}: {n} key of the game’s file that the copy lacks and loaded files use comes back ({list})', '{file}: {n} keys of the game’s file that the copy lacks and loaded files use come back ({list})', x.keys.length, { file: x.rel, list: shortList(x.keys) })] : []),
        ...(!x.unused.length ? [] : x.keys.length
            ? [trn('{file}: {n} more key the copy lacks is used by nothing loaded and stays out ({list})', '{file}: {n} more keys the copy lacks are used by nothing loaded and stay out ({list})', x.unused.length, { file: x.rel, list: shortList(x.unused) })]
            : [trn('{file}: {n} key of the game’s file that the copy lacks is used by nothing loaded and stays out ({list})', '{file}: {n} keys of the game’s file that the copy lacks are used by nothing loaded and stay out ({list})', x.unused.length, { file: x.rel, list: shortList(x.unused) })])
    ]);
}

/** The texts rule's plan entry: the copies with keys that come back (to do: their language's file is not what the patch mod holds), an older run's file nothing needs. */
export function textsEntry(w: TextsWork, label: string, patchRoot: string | undefined): NonNullable<MigrationPlan['rewrites']>[number] | undefined
{
    const files = [...w.copies.keys(), ...w.stale];

    if (!files.length)
        return undefined;

    const todo = [...[...w.copies].filter(([, x]) => !textsDone(patchRoot, w.outputs.get(x.language)!)).map(([rel]) => rel), ...w.stale];
    const notes = textsNotes(w);
    return { kind: 'texts', label, files, todo, ...(notes.length ? { notes } : {}) };
}

/**
 * The libraries rule's work (libraries.ts, run in the index worker against the files as loaded now) and the files of
 * the patch mod it comes to (libraryRule.ts), with the plan entries (one per folder) and the notes of the plan.
 * `extra`: texts the run will write into the patch mod (they count as loaded). `gained`: the list words the gains rules write
 * before this one runs, per entry (`gainedWords`); a flag entry whose words they all bring is theirs, not a library entry
 * (the run plans this rule again after them, against the files as they are then; the plan before it has to say the same).
 */
async function libraryPlan(host: ModsHost, mod: ModInfo, steps: Migration[], patchFolderName: string, patch: ModInfo | undefined, extra: string[], gained?: Map<string, Set<string>>, inertArgs?: InertOptions):
Promise<{ entries: NonNullable<MigrationPlan['rewrites']>; notes: string[]; work: LibraryWork; outputs: LibraryOutput[]; left: string[]; } | undefined>
{
    const config: LibraryConfig = {
        folders: [...new Map(steps.flatMap((m) => m.libraries?.folders ?? []).map((f) => [f.folder, f])).values()],
        flags: [...new Map(steps.flatMap((m) => m.libraries?.flags ?? []).map((f) => [f.folder, f])).values()]
    };

    if (!config.folders.length && !config.flags.length)
        return undefined;

    const work = await host.query!<LibraryWork | null>('migrationLibraries', mod.id, patch?.id, config, extra, inertArgs);

    if (!work)
        return undefined;

    if (gained?.size)
        for (const f of work.folders.filter((x) => x.flags))
            f.entries = f.entries.filter((e) => !e.words?.length || !e.words.every((w) => gained.get(e.name)?.has(w)));

    const existingLib = existingLibraryFiles(patch?.root, [...config.folders, ...config.flags].map((f) => f.folder));
    const outputs = libraryOutputs(work.folders, patchFolderName, existingLib, patch?.root);

    // (the inert references: the game's definitions that name entries the playset lacks, written again; the patch mod's own files rewritten)
    if (work.inert)
    {
        const have = new Set(outputs.map((o) => o.rel.toLowerCase()));
        outputs.push(...inertOutputs(work.inert, patchFolderName, existingInertFiles(patch?.root), patch?.root).filter((o) => !have.has(o.rel.toLowerCase())));
    }

    const todo = new Set(libraryTodo(outputs, patch?.root).map((o) => o.rel));
    const entries: NonNullable<MigrationPlan['rewrites']> = [];

    for (const f of work.folders.filter((x) => x.entries.length || x.copies?.length))
    {
        const files = outputs.filter((o) => !o.inert && o.folder === f.folder && (o.entries.length || o.copy)).map((o) => o.rel);
        entries.push({
            kind: 'libraries',
            label: libraryLabel(f),
            files,
            todo: files.filter((rel) => todo.has(rel)),
            notes: libraryNotes(f)
        });
    }

    for (const f of work.inert?.folders ?? [])
    {
        const files = outputs.filter((o) => o.inert && o.folder === f.folder && INERT_FILE.test(o.rel)).map((o) => o.rel);
        entries.push({ kind: 'inert', label: inertLabel(f), files, todo: files.filter((rel) => todo.has(rel)) });
    }

    if (work.inert?.files.length)
    {
        const files = work.inert.files.map((f) => f.rel);
        entries.push({ kind: 'inert', label: inertFilesLabel(files.length), files, todo: files.filter((rel) => todo.has(rel)) });
    }

    if (work.inert?.copies.length)
    {
        const files = work.inert.copies.map((c) => c.rel);
        entries.push({ kind: 'inert', label: inertCopiesLabel(files.length), files, todo: files.filter((rel) => todo.has(rel)) });
    }

    // (an inert file of an older run that holds nothing now is emptied)
    const staleInert = work.inert ? outputs.filter((o) => o.inert && INERT_FILE.test(o.rel) && !work.inert!.folders.some((f) => f.folder === o.folder) && todo.has(o.rel)).map((o) => o.rel) : [];

    if (staleInert.length)
        entries.push({ kind: 'inert', label: tr('Inert files an older run wrote that are not needed any more'), files: staleInert, todo: staleInert });

    // (a file of an older run that holds nothing now is deleted: that is work too)
    const stale = outputs.filter((o) => !o.entries.length && !o.copy && !o.inert && todo.has(o.rel)).map((o) => o.rel);

    if (stale.length)
        entries.push({ kind: 'libraries', label: tr('Definitions an older run carried over that are not needed any more'), files: stale, todo: stale });

    const left = leftLibraryFiles(existingLib, outputs, patch?.root);

    return { entries, notes: [...workNotes(work), ...(work.inert ? inertNotes(work.inert) : []), ...(left.length ? [leftLibraryNote(left)] : [])], work, outputs, left };
}

/**
 * What the inert references step needs besides the index (inertWork.ts): the patch mod's files it may rewrite in place (the run's own, not
 * the owner's) and the ones a rule regenerates by text, which it leaves alone (restored, merged, defines), and the names the last run treated
 * as missing.
 */
function inertOptions(rules: FileRule[], folder: string, patchRoot: string | undefined, manifest: FixesManifest | undefined, before?: Map<string, string>, renamed?: RenameWork['aliases']): InertOptions
{
    const skip = new Set([...Object.keys(manifest?.restored ?? {}), ...Object.keys(manifest?.merged ?? {})].map(lc));
    // (the paths rules write or edit in the patch mod: the inert step rewrites that file in place and makes no copy of the game's or the mod's beside it;
    // a merge's file is the step's too (`mergeDone` knows its rewrite), and the merge's own files are the mod's, which stay)
    const ruleFiles = new Set<string>();

    for (const r of rules)
    {
        if (r.kind === 'defines')
            skip.add(lc(definesFile(r.folder!, folder)));
        else if (r.kind === 'restore' || r.kind === 'mergefx')
            r.files.forEach((rel) => skip.add(lc(rel)));
        else if (r.kind !== 'merge')
            r.files.forEach((rel) => ruleFiles.add(lc(rel)));
    }

    return {
        owned: patchRoot ? ownedFiles(patchRoot, manifest, before) : undefined, skip: [...skip], recorded: manifest?.inert?.names ?? [],
        ruleFiles: [...ruleFiles], copies: manifest?.inert?.copies, sources: manifest?.inert?.sources, ...(renamed?.length ? { renamed } : {})
    };
}

/**
 * The words in the lists of the definitions the gains rules are about to change, per definition, as the rules leave them. A
 * doctrine of a mod written for 1.19 gets the parameters the game's doctrine has from the gains rule, and those are the words
 * the libraries rule would add (the ones loaded files test) among others.
 */
function gainedWords(c: RuleContext, rules: FileRule[]): Map<string, Set<string>>
{
    const out = new Map<string, Set<string>>();

    for (const rule of rules.filter((r) => r.kind === 'gains' && r.gain?.lists?.length))
    {
        const g = rule.gain!;
        const w = gainWorkOf(c, g);

        for (const rel of new Set([...rule.files, ...patchFilesFor(c.patchRoot, g.files).filter((x) => !c.modFiles.has(x))]))
        {
            const text = currentText(c, rel);
            const r = text ? gainEdits(text, g, w.scope, w.game, g.dropAbsent ? c.absent : undefined) : undefined;

            if (!text || !r?.edits.length)
                continue;

            for (const n of parse(applyStatementEdits(text, r.edits)))
                if (n.k && r.entries.includes(n.k) && Array.isArray(n.v))
                    for (const l of n.v.filter((x) => x.k && g.lists!.includes(x.k) && Array.isArray(x.v)))
                        for (const word of l.v as PNode[])
                        {
                            const name = word.k ?? (typeof word.v === 'string' ? word.v : undefined);

                            if (name)
                                out.set(n.k, (out.get(n.k) ?? new Set<string>()).add(name));
                        }
        }
    }

    return out;
}

/** A defines rule's list defines with what the loaded world lacks (none: the world is not known, a list stays as the mod has it). */
function defineLists(lists: { key: string; prefix: string; }[] | undefined, absent: Set<string> | undefined): ListDefines | undefined
{
    return lists?.length && absent ? { prefix: new Map(lists.map((l) => [l.key.toLowerCase(), l.prefix])), absent, listed: [] } : undefined;
}

/** A defines rule's file in the patch mod: its path and text (per namespace the keys the game's files add). */
function definesOutput(rule: FileRule, c: RuleContext): { rel: string; text: string; }
{
    const all = new Map<string, string[]>();
    const paths = pathTest({ gameDir: c.gameDir, modFiles: c.modFiles.keys(), patchRoot: c.patchRoot, others: c.others });
    const lists = defineLists(rule.defineLists, c.absent);

    for (const rel of rule.files)
        for (const [ns, add] of missingDefines(readTextBody(gameFile(c.gameDir, rel)!), modText(c.mod, rel, c.modFiles.get(rel)!) ?? '', paths, undefined, definesElsewhere(c.mod, c.modFiles, rel, c.others), lists))
            all.set(ns, [...(all.get(ns) ?? []), `# ${rel}`, ...add]);

    // (the header keeps the em dash earlier runs wrote: `ruleTodo` compares the whole text)
    return {
        rel: definesFile(rule.folder!, c.folder),
        text: '﻿' + `# ${rule.folder} defines — merged by CrusaderPope\n\n` +
            [...all].map(([ns, lines]) => `${ns} = {\n${lines.map((l) => '\t' + l.replace(/\n/g, '\n\t')).join('\n')}\n}`).join('\n\n') + '\n'
    };
}

/** The statement rules' environment with what the loaded index knows of tenets (a 1.19 mod's are doctrines of a tenet group). */
async function scriptEnv(host: ModsHost, mod: ModInfo, files: Map<string, { file?: string; entry?: string; }>, gameDir: string, patchRoot: string | undefined, steps: Migration[]): Promise<StatementEnv>
{
    const lay = await host.query!<{ tenets: string[]; tenetDoctrines: string[]; } | null>('layouts');
    return statementEnv(mod, files, gameDir, patchRoot, steps, [...(lay?.tenets ?? []), ...(lay?.tenetDoctrines ?? [])]);
}

/** The folders whose files define the scripted triggers and effects (events define some in their own files). */
const MACRO_FOLDERS = ['common/scripted_triggers', 'common/scripted_effects', 'events'];
const MACRO_FILE = /^(?:common\/scripted_(?:triggers|effects)|events)\/.+\.txt$/i;

/** A script file's scripted triggers and effects that take parameters (`$P$`), as macroArgs reads them (`macroShape`), in the file's order. */
function macrosOf(text: string, rel: string): MacroShape[]
{
    if (!text.includes('$'))
        return [];

    const scripted = /^common\/scripted_(?:triggers|effects)\//i.test(rel);
    return scripted || /\bscripted_(?:trigger|effect)\s/.test(text) ? macroDefinitions(parse(text), scripted).map(macroShape) : [];
}

/** A shape whose strings are its own (kept for the session: not views into the file's text, gameFacts.ts `own`). */
const ownShape = (d: MacroShape): MacroShape => ({ name: own(d.name), all: new Map([...d.all].map(([p, n]) => [own(p), n])), sites: d.sites.map((s) => ({ param: own(s.param), key: own(s.key), parent: own(s.parent) })) });

/** A script file's macro definitions into `byName` (a later one replaces one of its name). */
function takeMacros(byName: Map<string, MacroShape>, text: string, rel: string): void
{
    for (const d of macrosOf(text, rel))
        byName.set(d.name, d);
}

/**
 * The game's part of the macro definitions per game folder, for the length of a job (keptTexts.ts `jobMap`: the game's files do
 * not change while it runs; a run builds its statement environments twice). Each file's definitions are kept for the session as
 * their shapes, not their parse trees (gameFacts.ts; the parse trees of the 395 files with definitions held some 75 to 110 MB).
 */
const gameMacroMemo = jobMap<string, Map<string, MacroShape>>();

/** The macro definitions of the game's files (`MACRO_FOLDERS`), in the order the game layers them. */
function gameMacros(gameDir: string): Map<string, MacroShape>
{
    const have = gameMacroMemo.get(gameDir);

    if (have)
        return have;

    const byName = new Map<string, MacroShape>();

    for (const folder of MACRO_FOLDERS)
        for (const f of gameFilesBelow(gameDir, folder, /\.txt$/i))
        {
            // (whether the file is one of the scripted folders' decides what it holds: the fact's kind says which)
            const scripted = /^common\/scripted_(?:triggers|effects)\//i.test(f.rel);
            const defs = gameFact(scripted ? 'macros|scripted' : 'macros|other', f.abs, (data) => macrosOf(decodeTextBody(data), f.rel).map(ownShape)) ?? macrosOf(readTextBody(f.abs), f.rel);

            for (const d of defs)
                byName.set(d.name, d);
        }

    gameMacroMemo.set(gameDir, byName);
    return byName;
}

/** The folder whose files' top-level keys are the tenets (the set `tenets` the statement rules refer to). */
const TENET_FOLDER = 'common/religion/tenet_types';

/**
 * What the statement rules read besides a file (scriptRules.ts): the tenet names (of the game and its DLCs, the mod, the
 * patch mod, and `extra` (the index's: a 1.19 mod's tenets are doctrines of a tenet group until the fixes move them)),
 * whether the mod defines a name in a folder (a scripted effect it keeps), and the definitions' roots.
 */
function statementEnv(mod: ModInfo, files: Map<string, { file?: string; entry?: string; }>, gameDir: string, patchRoot: string | undefined, steps: Migration[], extra: string[] = []): StatementEnv
{
    const tenets = new Set(extra);
    const take = (text: string): void =>
    {
        for (const n of text ? parse(text) : [])
            if (n.k)
                tenets.add(n.k);
    };
    const takeDir = (dir: string): void =>
    {
        if (!existsSync(dir))
            return;

        for (const e of readdirSync(dir, { withFileTypes: true }))
            if (e.isFile() && /\.txt$/i.test(e.name))
                take(readTextFile(join(dir, e.name)));
    };

    for (const root of gameRoots(gameDir))
        takeDir(join(root, ...TENET_FOLDER.split('/')));

    if (patchRoot)
        takeDir(join(patchRoot, ...TENET_FOLDER.split('/')));

    for (const [rel, where] of files)
        if (lc(rel).startsWith(TENET_FOLDER + '/') && /\.txt$/i.test(rel))
            take(modText(mod, rel, where) ?? '');

    // (the mod's own files only: the patch mod's copy of one is the same file, changed; a definition is a top-level entry; an
    // indented use of the name inside another definition defines nothing)
    const memo = new Map<string, boolean>();
    const tops = new Map<string, Set<string>>();
    const defined = (folder: string, key: string): boolean =>
    {
        const id = `${folder}|${key}`;
        let has = memo.get(id);

        if (has === undefined)
        {
            has = [...files].some(([rel, where]) =>
            {
                if (!lc(rel).startsWith(lc(folder) + '/') || !/\.txt$/i.test(rel))
                    return false;

                const text = modText(mod, rel, where) ?? '';

                if (!text.includes(key))
                    return false;

                let keys = tops.get(rel);

                if (!keys)
                {
                    keys = new Set(parse(text).flatMap((n) => (n.k ? [n.k] : [])));
                    tops.set(rel, keys);
                }

                return keys.has(key);
            });
            memo.set(id, has);
        }

        return has;
    };

    // (the opinion flags the doctrine fix converts, from the mod's own doctrines and tenets: `pacifist_opinion_active` → `pacifist`)
    let opinion: Map<string, string> | undefined;
    const opinionFlags = (): Map<string, string> =>
    {
        if (!opinion)
        {
            opinion = new Map();

            for (const [rel, where] of files)
                if (/^common\/religion\/(?:doctrine|tenet)_types\/[^/]+\.txt$/i.test(rel))
                {
                    const text = modText(mod, rel, where) ?? '';

                    if (text.includes('_opinion_active'))
                        opinionFlagsOf(parse(text), opinion);
                }
        }

        return opinion;
    };

    // (the scripted triggers and effects (and the ones events define in their own files) of the game, the mod and the patch mod,
    // the later ones replacing the earlier by name: what the macro rules read, built when first asked)
    let macros: MacroShape[] | undefined;
    const macroDefs = (): MacroShape[] =>
    {
        if (macros)
            return macros;

        // (the game's, kept for the job; then the mod's and the patch mod's over a copy of them)
        const byName = new Map(gameMacros(gameDir));
        const take = (text: string, rel: string): void => takeMacros(byName, text, rel);

        for (const [rel, where] of files)
            if (MACRO_FILE.test(rel))
                take(modText(mod, rel, where) ?? '', rel);

        for (const rel of patchFilesFor(patchRoot, MACRO_FOLDERS.map((f) => f + '/**/*.txt')))
            take(readTextBody(join(patchRoot!, ...rel.split('/'))), rel);

        macros = [...byName.values()];
        return macros;
    };
    const macroSets = new Map<string, MacroArgs>();
    // (by the list itself first: a group's own, a fixed object of MIGRATIONS, asked for every node a rule looks at)
    const macroByList = new Map<MacroTarget[], MacroArgs>();
    const macroOf = (targets: MacroTarget[]): MacroArgs =>
    {
        let m = macroByList.get(targets);

        if (m)
            return m;

        const id = JSON.stringify(targets);
        m = macroSets.get(id);

        if (!m)
        {
            m = macroArgs(macroDefs(), targets);
            macroSets.set(id, m);
        }

        macroByList.set(targets, m);
        return m;
    };

    return { sets: { tenets }, maps: { ...nameMaps(mod, files, gameDir, patchRoot, steps), opinion_flags: opinionFlags }, macroArgs: macroOf, defined, roots: steps.flatMap((m) => m.roots ?? []) };
}

/**
 * The maps of renamed names (migrations.ts `nameMaps`), built when a rule first asks: the keys defined in the folder's
 * files of the game and its DLCs, the mod and the patch mod; each one plus the suffix maps to it unless that is a key too.
 */
function nameMaps(mod: ModInfo, files: Map<string, { file?: string; entry?: string; }>, gameDir: string, patchRoot: string | undefined, steps: Migration[]): Record<string, () => Map<string, string>>
{
    const out: Record<string, () => Map<string, string>> = {};

    for (const m of steps.flatMap((s) => s.nameMaps ?? []))
    {
        let map: Map<string, string> | undefined;
        out[m.name] = () =>
        {
            if (map)
                return map;

            const keys = new Set<string>();
            const take = (text: string): void =>
            {
                for (const n of parse(text))
                    if (n.k)
                        keys.add(n.k);
            };
            const takeDir = (dir: string): void =>
            {
                if (existsSync(dir))
                    for (const e of readdirSync(dir, { withFileTypes: true }))
                        if (e.isFile() && /\.txt$/i.test(e.name))
                            take(readTextFile(join(dir, e.name)));
            };

            for (const root of [...gameRoots(gameDir), ...(patchRoot ? [patchRoot] : [])])
                takeDir(join(root, ...m.folder.split('/')));

            for (const [rel, where] of files)
                if (lc(rel).startsWith(lc(m.folder) + '/') && /\.txt$/i.test(rel))
                    take(modText(mod, rel, where) ?? '');

            map = new Map([...keys].filter((k) => !keys.has(k + m.suffix)).map((k) => [k + m.suffix, k]));
            return map;
        };
    }

    return out;
}

/** The files of the patch mod that a statement group's path patterns match (it has files of its own: the fixes write them); `.txt` files unless `ext` says otherwise. */
function patchFilesFor(patchRoot: string | undefined, patterns: string[], ext = /\.txt$/i): string[]
{
    const out: string[] = [];

    if (!patchRoot)
        return out;

    const walkDir = (rel: string): void =>
    {
        const dir = join(patchRoot, ...rel.split('/'));

        if (!existsSync(dir))
            return;

        for (const e of readdirSync(dir, { withFileTypes: true }))
        {
            const sub = `${rel}/${e.name}`;

            if (e.isDirectory())
                walkDir(sub);
            else if (e.isFile() && ext.test(e.name) && patterns.some((p) => globMatch(p, sub)))
                out.push(sub);
        }
    };

    for (const top of new Set(patterns.map((p) => p.split('/')[0])))
        walkDir(top);

    return out;
}

/** A file as the rules see it now: the patch mod's copy when it has one, else the mod's (byte order mark cut). */
function currentText(c: { mod: ModInfo; modFiles: Map<string, { file?: string; entry?: string; }>; patchRoot?: string; }, rel: string): string | undefined
{
    const file = c.patchRoot ? join(c.patchRoot, ...rel.split('/')) : undefined;

    if (file && existsSync(file))
        return readTextBody(file);

    const where = c.modFiles.get(rel);
    return where ? modText(c.mod, rel, where) : undefined;
}

/**
 * The statement groups that concern the mod (migrations.ts `statements`): per group the files with a statement to change,
 * the mod's files as the mod wrote them, and the patch mod's own (no counterpart in the mod: a tenet file the fixes wrote).
 * One pass over the files for all the groups.
 */
function statementRules(mod: ModInfo, files: Map<string, { file?: string; entry?: string; }>, groups: StatementGroup[], env: StatementEnv, patchRoot?: string, stop?: () => void): FileRule[]
{
    const hits = new Map<StatementGroup, string[]>(groups.map((g) => [g, []]));
    const patchOnly = patchFilesFor(patchRoot, groups.flatMap((g) => g.files)).filter((rel) => !files.has(rel));

    for (const rel of [...files.keys(), ...patchOnly])
    {
        const gs = groups.filter((g) => /\.txt$/i.test(rel) && g.files.some((p) => globMatch(p, rel)));

        if (!gs.length)
            continue;

        stop?.();
        const text = files.has(rel) ? modText(mod, rel, files.get(rel)!) : currentText({ mod, modFiles: files, patchRoot }, rel);
        const memo = {};

        for (const g of gs)
            if (text && statementEdits(text, rel, g, env, memo).edits.length)
                hits.get(g)!.push(rel);
    }

    return groups.filter((g) => hits.get(g)!.length).map((g) => ({ kind: 'statements' as const, label: g.label, files: hits.get(g)!, group: g }));
}

/**
 * A statement group carried out (migrateMod): each file's current text (the patch mod's copy, else the mod's) with the
 * edits made, written as the patch mod's copy. Returns the files written.
 */
function applyStatements(rule: FileRule, rels: string[], c: RuleContext): string[]
{
    return applyEdited(rels, c, (text, rel) => applyStatementEdits(text, statementEdits(text, rel, rule.group!, c.script!).edits));
}

/**
 * Files edited in the patch mod: each one's current text (the patch mod's copy, else the mod's file, byte order mark kept
 * as it was) through `edit`, written as the patch mod's copy when it changed. Returns the files written.
 */
function applyEdited(rels: string[], c: RuleContext, edit: (text: string, rel: string) => string): string[]
{
    const written: string[] = [];

    for (const rel of rels)
    {
        const out = join(c.patchRoot!, ...rel.split('/'));
        const where = c.modFiles.get(rel);
        const raw = existsSync(out) ? readTextFile(out) : where?.file ? readTextFile(where.file) : where?.entry && c.mod.archive ? decodeText(zipEntry(c.mod.archive, where.entry) ?? Buffer.alloc(0)) : undefined;

        if (raw === undefined)
            continue;

        const bom = raw.startsWith('﻿');
        const text = bom ? raw.slice(1) : raw;
        const next = edit(text, rel);

        if (next === text)
            continue;

        put(c.wrote, out, (bom ? '﻿' : '') + next);
        written.push(rel);
    }

    return written;
}

/**
 * The statements the groups' rules name but cannot map (`note`), in the files as they are after the run (the patch mod's
 * copy, else the mod's): all of the mod's files, not only the ones a rule changed (a file with nothing but such a statement
 * has no edit, so no rule lists it). They stay as written.
 */
function unmappedStatements(c: RuleContext, groups: StatementGroup[]): string[]
{
    const noting = groups.filter((g) => g.rules.some((r) => r.note));
    const out = new Set<string>();

    if (!noting.length || !c.script)
        return [];

    const patchOnly = patchFilesFor(c.patchRoot, noting.flatMap((g) => g.files)).filter((rel) => !c.modFiles.has(rel));

    for (const rel of [...c.modFiles.keys(), ...patchOnly])
    {
        const gs = noting.filter((g) => /\.txt$/i.test(rel) && g.files.some((p) => globMatch(p, rel)));
        const text = gs.length ? currentText(c, rel) : undefined;

        if (!text)
            continue;

        const memo = {};

        for (const g of gs)
            for (const u of statementEdits(text, rel, g, c.script, memo).unmapped)
                out.add(u);
    }

    return [...out];
}

/** The folder of an add rule's files (`common/activities/activity_types/*.txt` → the folder). */
const addFolder = (rule: AddRule): string => rule.files[0].slice(0, rule.files[0].lastIndexOf('/'));

/**
 * The `define:Namespace|KEY` and `GetDefine('Namespace', 'KEY')` references in the mod's script and interface files (the patch
 * mod's copy where it has one) that the game's own defines files do not define. The engine's define groups are fixed (a mod's
 * copy of a defines file overrides values, a key of its own is never read (AGOT's `NFaith|FAITH_CREATION_FERVOR_DISCOUNT_MAX`
 * stays in its 00_defines.txt, the game has it in `NRite`)), so a key the game's files lack is "Invalid define, could not find
 * define for :KEY" wherever it is read. No rule can pick the key a define became (the ones 1.20 renamed are `rewrites`); the
 * plan tells what is left.
 */
function undefinedDefines(c: RuleContext, steps: Migration[]): string[]
{
    // (the files as the run's `rewrites` leave them: a key one of them renames is not left over; in the plan the files are not rewritten yet)
    const rewrites = steps.flatMap((m) => m.rewrites ?? []).map((r) => ({ files: r.files, re: new RegExp(r.find, 'g'), replace: r.replace }));

    const defined = new Set<string>();

    for (const f of gameFilesBelow(c.gameDir, 'common/defines', /\.txt$/i))
        definedKeys(readTextFile(f.abs), defined);

    const missing = new Map<string, string[]>();

    for (const rel of c.modFiles.keys())
    {
        if (!/^(?:common|events|history|gfx)\/.*\.txt$|^gui\/.*\.gui$/i.test(rel) || /^common\/defines\//i.test(rel))
            continue;

        const read = currentText(c, rel);

        if (!read || !/define:|GetDefine\(/.test(read))
            continue;

        const text = rewrites.filter((r) => r.files.some((p) => globMatch(p, rel))).reduce((t, r) => t.replace(r.re, r.replace), read);

        // (a reference in a comment reads nothing)
        for (const ref of defineRefs(text.replace(/#[^\r\n]*/g, '')))
            if (!defined.has(ref.toLowerCase()))
                missing.set(ref, [...(missing.get(ref) ?? []), rel]);
    }

    return [...missing].sort(([a], [b]) => a.localeCompare(b)).map(([ref, files]) => tr('{ref} is read in {files}, but the game’s defines files do not have it (the engine ignores a define of a mod’s own)', { ref: ref.replace('|', '.'), files: shortList(files, 2) }));
}

/** The game files below a survivors rule's folder, in subfolders only, with their top-level keys. */
function survivorCandidates(gameDir: string, folder: string): { rel: string; keys: string[]; }[]
{
    return gameFilesBelow(gameDir, folder, /\.txt$/i)
        .filter((f) => f.rel.slice(folder.length + 1).includes('/'))
        .map((f) => ({ rel: f.rel, keys: parse(readTextBody(f.abs)).flatMap((n) => (n.k && !n.k.startsWith('@') ? [n.k] : [])) }));
}

/**
 * The game files in a subfolder of a folder the mod replaces that still load (`replace_path` is not recursive) and name entries
 * the loaded files lack (`absent`, `prefix:name`): per file the names. A file the mod has itself is the mod's.
 */
function survivingFiles(mod: ModInfo, gameDir: string, files: Map<string, unknown>, rule: NonNullable<Migration['survivors']>[number], absent: Set<string> | undefined): Map<string, { names: string[]; all: boolean; }>
{
    const out = new Map<string, { names: string[]; all: boolean; }>();
    const norm = (p: string): string => lc(p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));

    if (!absent || !mod.replacePaths.some((p) => norm(p) === lc(rule.folder)))
        return out;

    const own = new Set([...files.keys()].map(lc));

    for (const c of survivorCandidates(gameDir, rule.folder))
    {
        const names = c.keys.filter((k) => absent.has(`${rule.prefix}:${k}`));

        if (names.length && !own.has(lc(c.rel)))
            out.set(c.rel, { names, all: names.length === c.keys.length });
    }

    return out;
}

/** The game's file text without the top-level entries of these names (the history of the entries the world has stays). */
export function withoutEntries(source: string, names: string[]): string
{
    const text = source.replace(/^﻿/, '');
    const gone = new Set(names);
    let out = '';
    let at = 0;

    for (const n of parse(text))
        if (n.k && gone.has(n.k))
        {
            out += text.slice(at, n.s).replace(/[ \t]+$/, '');
            at = n.e;
        }

    return out + text.slice(at);
}

/**
 * What the game's statements of the add rules with `dropAbsent` name that the loaded index lacks (`prefix:name`): asked of the
 * index once per plan or run, with the names all of them mention.
 */
async function absentRefs(host: ModsHost, steps: Migration[], gameDir: string): Promise<Set<string>>
{
    const refs = new Set<string>();

    for (const r of steps.flatMap((m) => m.adds ?? []).filter((x) => x.dropAbsent))
    {
        for (const text of gameFolderTexts(gameDir, addFolder(r)))
        {
            const found = new Map<string, string[]>();
            gameKeyStatements(text, r.key, found);

            for (const s of found.values())
                s.forEach((x) => namedRefs(x).forEach((n) => refs.add(n)));
        }
    }

    // (the words of the list defines a defines rule merges: the governments of GOVERNMENT_TYPES, one reference per word)
    for (const r of steps.flatMap((m) => m.defines ?? []).filter((x) => x.lists?.length))
    {
        const prefixes = new Map(r.lists!.map((l) => [l.key.toLowerCase(), l.prefix]));

        for (const f of gameFilesBelow(gameDir, r.folder, /\.txt$/i))
            for (const ns of parse(readTextBody(f.abs)))
                for (const c of Array.isArray(ns.v) ? ns.v : [])
                    if (c.k && prefixes.has(c.k.toLowerCase()))
                        listWords(c).forEach((w) => refs.add(prefixes.get(c.k!.toLowerCase()) + ':' + w));
    }

    // (the gain rules' keys likewise, but not the scripted triggers they call: a trigger the mod lacks is carried over by the
    // library rule, because the statement names it)
    for (const r of steps.flatMap((m) => m.gains ?? []).filter((x) => x.dropAbsent))
    {
        const found: GameGains = new Map();

        for (const text of gameFolderTexts(gameDir, gainFolder(r)))
            gameGainsOf(text, r, found);

        for (const g of found.values())
            for (const s of g.keys.values())
                s.forEach((x) => namedRefs(x).filter((n) => !n.startsWith('trigger:')).forEach((n) => refs.add(n)));
    }

    // (the entries of the game files that survive a replace_path in a subfolder: the titles of history/titles/ce3)
    for (const r of steps.flatMap((m) => m.survivors ?? []))
        for (const c of survivorCandidates(gameDir, r.folder))
            c.keys.forEach((k) => refs.add(`${r.prefix}:${k}`));

    return refs.size ? new Set(await host.query!<string[] | null>('migrationNames', [...refs]) ?? []) : new Set();
}

/** The game's statements of an add rule's key per definition name (its files in the folder, its DLCs' too). */
function addGame(gameDir: string, rule: AddRule, absent?: Set<string>): (name: string) => string[] | undefined
{
    const found = new Map<string, string[]>();

    for (const root of gameRoots(gameDir))
    {
        const dir = join(root, ...addFolder(rule).split('/'));

        if (existsSync(dir))
            for (const e of readdirSync(dir, { withFileTypes: true }))
                if (e.isFile() && /\.txt$/i.test(e.name))
                    gameKeyStatements(readTextBody(join(dir, e.name)), rule.key, found);
    }

    return (name) => (absent && found.has(name) ? withoutAbsent(found.get(name)!, absent) : found.get(name));
}

type Source = { file?: string; entry?: string; game?: string; };

/**
 * The tenet keys the game's localization still names (`tenet_x_name:` in its religion texts): a tenet the mod holds under such a key that
 * the game's tenet files no longer define is one 1.20 removed. Read once per game build (gameFacts.ts `GameMemo`).
 */
const namedTenets = new GameMemo<Set<string>>();

function gameNamedTenets(gameDir: string): Set<string>
{
    let out = namedTenets.get(gameDir, '');

    if (!out)
    {
        out = new Set();

        for (const root of gameRoots(gameDir))
        {
            const dir = join(root, 'localization', 'english', 'religion');

            if (existsSync(dir))
                for (const name of readdirSync(dir))
                    if (/\.yml$/i.test(name))
                        for (const m of readTextFile(join(dir, name)).matchAll(/^\s*(tenet_\w+?)_name:/gm))
                            out.add(m[1]);
        }

        namedTenets.set(gameDir, '', out);
    }

    return out;
}

/** The texts of the definitions the game and its DLCs have in a folder (without byte order mark). */
function gameFolderTexts(gameDir: string, folder: string): string[]
{
    const out: string[] = [];

    for (const root of gameRoots(gameDir))
    {
        const dir = join(root, ...folder.split('/'));

        if (existsSync(dir))
            for (const e of readdirSync(dir, { withFileTypes: true }))
                if (e.isFile() && /\.txt$/i.test(e.name))
                    out.push(readTextBody(join(dir, e.name)));
    }

    return out;
}

/**
 * The folder 1.19 read a mod's tenet banners from: the define `FAITH_DOCTRINE_BACKGROUND_PATH` of the mod's own defines (the
 * last file in path order that sets it), else the rule's default (the game's own value).
 */
function bannerFolderOf(mod: ModInfo, modFiles: Map<string, { file?: string; entry?: string; }>, fallback: string): string
{
    let path: string | undefined;

    for (const rel of [...modFiles.keys()].filter((r) => /^common\/defines\/.+\.txt$/i.test(r)).sort())
    {
        const text = modText(mod, rel, modFiles.get(rel)!);
        const m = text ? /FAITH_DOCTRINE_BACKGROUND_PATH\s*=\s*"([^"]+)"/.exec(text) : null;

        if (m)
            path = m[1].replace(/\/+$/, '');
    }

    return path ?? fallback;
}

/**
 * What a banner rule works with (bannerKeys.ts): the game's value of each key and the mod's banners to carry. `carry` is
 * asked per old value: a banner whose textures (`x.dds` and `x_small.dds`) are in the new folder already (the mod's, the
 * patch mod's or the game's) is used as it is, one the mod ships in the old folder is copied there (`copies`: target →
 * source), else it is lost (`lost`).
 */
function bannerWork(mod: ModInfo, modFiles: Map<string, { file?: string; entry?: string; }>, gameDir: string, rule: BannerRule, patchRoot?: string): { env: BannerEnv; copies: Map<string, Source>; lost: Set<string>; from: string; }
{
    const copies = new Map<string, Source>();
    const lost = new Set<string>();
    const from = bannerFolderOf(mod, modFiles, rule.from);
    const there = (rel: string): boolean => modFiles.has(rel) || !!gameFile(gameDir, rel) || (!!patchRoot && existsSync(join(patchRoot, ...rel.split('/'))));
    const source = (rel: string): Source | undefined => modFiles.get(rel) ?? (gameFile(gameDir, rel) ? { game: gameFile(gameDir, rel) } : undefined);
    const env: BannerEnv = {
        values: gameBannerValues(gameFolderTexts(gameDir, rule.valuesIn), rule.keys),
        carry: (value) =>
        {
            const name = bannerName(value);

            if (there(`${rule.to}/${name}.dds`) && there(`${rule.to}/${name}_small.dds`))
                return name;

            const big = source(`${from}/${name}.dds`);
            const small = source(`${from}/${name}_small.dds`);

            if (big && small)
            {
                copies.set(`${rule.to}/${name}.dds`, big);
                copies.set(`${rule.to}/${name}_small.dds`, small);
                return name;
            }

            lost.add(name);
            return undefined;
        }
    };
    return { env, copies, lost, from };
}

/**
 * The banner rules that concern the mod (migrations.ts `banners`): the files with a definition to change, the mod's as the
 * mod wrote them, and the patch mod's own (the fixes wrote them: religions).
 */
function bannerRules(mod: ModInfo, files: Map<string, { file?: string; entry?: string; }>, gameDir: string, rules: BannerRule[], patchRoot?: string): FileRule[]
{
    const out: FileRule[] = [];

    for (const r of rules)
    {
        const w = bannerWork(mod, files, gameDir, r, patchRoot);
        const patchOnly = patchFilesFor(patchRoot, r.files).filter((rel) => !files.has(rel));
        const hits = [...files.keys(), ...patchOnly].filter((rel) =>
        {
            if (!/\.txt$/i.test(rel) || !r.files.some((p) => globMatch(p, rel)))
                return false;

            const text = files.has(rel) ? modText(mod, rel, files.get(rel)!) : currentText({ mod, modFiles: files, patchRoot }, rel);
            return !!text && bannerEdits(text, r, w.env).length > 0;
        });

        if (hits.length)
            out.push({ kind: 'banners', label: r.label, files: hits, banner: r });
    }

    return out;
}

/**
 * What a run works with: the mod, the game, the patch mod (absent: not made yet) with the manifest of its last run.
 * The state checks below (`ruleTodo`) read it against the patch mod; the apply code in `migrateMod` goes with them.
 */
interface RuleContext
{
    mod: ModInfo;
    modFiles: Map<string, { file?: string; entry?: string; }>;
    gameDir: string;
    /** the patch mod's folder name (the `zz_` files carry it) */
    folder: string;
    patchRoot?: string;
    /** the folders of the other mods of the loaded list (a path in a defines file that only one of them has is theirs) */
    others?: string[];
    /** what the game's statements name that the loaded world lacks (add rules with `dropAbsent`) */
    absent?: Set<string>;
    /** of the localization keys the context rule would touch, the ones a loaded script or interface file names (`namedContextKeys`) */
    namedKeys?: Set<string>;
    manifest?: FixesManifest;
    /** a run's: the folder watcher told of each file before it is written (`put`; textureRule.ts's writes too) */
    wrote?: Announce;
    /** entry fixes are still to run: they move entries into the patch mod, which changes what some rules see */
    pendingFixes?: boolean;
    /** what the statement rules read (the tenet names …) */
    script?: StatementEnv;
    /** the game's statements per add rule (read when first needed) */
    gameAdds?: Map<AddRule, (name: string) => string[] | undefined>;
    /** the merged shader files per merge rule (made when first needed) */
    shaders?: Map<FileRule, ShaderWork>;
    /** the gain rules' reading of the game and of the mod's older files (made when first needed) */
    gainWork?: Map<GainRule, GainWork>;
}

/** What the add rules read of the game (made when first needed), and what of the world they leave out. */
interface AddCache
{
    gameDir: string;
    gameAdds?: Map<AddRule, (name: string) => string[] | undefined>;
    absent?: Set<string>;
}

/** The game's statements for an add rule, read once per run. */
function gameAddsOf(c: AddCache, rule: AddRule): (name: string) => string[] | undefined
{
    c.gameAdds ??= new Map();
    let g = c.gameAdds.get(rule);

    if (!g)
    {
        g = addGame(c.gameDir, rule, rule.dropAbsent ? c.absent : undefined);
        c.gameAdds.set(rule, g);
    }

    return g;
}

/** What a gain rule reads (made when first needed): the game's definitions, and what the mod's older files know. */
interface GainWork
{
    game: GameGains;
    scope: GainScope;
}

interface GainCache
{
    mod: ModInfo;
    modFiles: Map<string, { file?: string; entry?: string; }>;
    gameDir: string;
    absent?: Set<string>;
    gainWork?: Map<GainRule, GainWork>;
}

/**
 * The game's keys and list words of a gain rule's folder (its DLCs' too), and which of the rule's keys and words the mod's older
 * files (the mod's own, not the patch mod's) show no sign of knowing (gainKeys.ts), read once per run.
 */
function gainWorkOf(c: GainCache, rule: GainRule): GainWork
{
    c.gainWork ??= new Map();
    let w = c.gainWork.get(rule);

    if (!w)
    {
        const game: GameGains = new Map();

        for (const text of gameFolderTexts(c.gameDir, gainFolder(rule)))
            gameGainsOf(text, rule, game);

        const patterns = rule.known ?? [...rule.files, ...(rule.pending ?? [])];
        const texts = [...c.modFiles].filter(([rel]) => /\.txt$/i.test(rel) && patterns.some((p) => globMatch(p, rel))).map(([rel, where]) => modText(c.mod, rel, where) ?? '');
        w = { game, scope: gainScope(rule, texts) };
        c.gainWork.set(rule, w);
    }

    return w;
}

/** A file of the patch mod (without byte order mark); undefined when the patch mod has none. */
function patchText(c: RuleContext, rel: string): string | undefined
{
    const file = c.patchRoot ? join(c.patchRoot, ...rel.split('/')) : undefined;
    return file && existsSync(file) ? readTextBody(file) : undefined;
}

/** What a run does with a restored game file: copy it, copy it again (the game's changed), keep the patch mod's, nothing. */
type RestoreAction = 'copy' | 'refresh' | 'kept' | 'same';

/**
 * A restore rule's file against the patch mod (`hash`: of the game's file). The manifest knows the hash of the copy as
 * it was written: a copy that still has it is the old game's file and is refreshed; one that differs was changed by hand and is
 * kept. A copy without a record (a patch mod from before the manifest) that differs from the game's is refreshed.
 */
function restoreAction(c: RuleContext, rel: string): { action: RestoreAction; hash: string; }
{
    const hash = sha1(readFileSync(gameFile(c.gameDir, rel)!));
    const out = c.patchRoot ? join(c.patchRoot, ...rel.split('/')) : undefined;

    if (!out || !existsSync(out))
        return { action: 'copy', hash };

    const have = sha1(readFileSync(out));

    if (have === hash)
        return { action: 'same', hash };

    const written = c.manifest?.restored[rel];
    return { action: written && have !== written ? 'kept' : 'refresh', hash };
}

/** What a merge rule hands the shader merge (shaderRule.ts). */
function shaderInputOf(c: RuleContext, rule: FileRule): ShaderInput
{
    return {
        files: rule.files,
        keep: rule.keep,
        modFiles: [...c.modFiles.keys()].filter(isFxFile),
        readMod: (rel) =>
        {
            const where = c.modFiles.get(rel);
            return where?.file ? readFileSync(where.file) : where?.entry && c.mod.archive ? zipEntry(c.mod.archive, where.entry) : undefined;
        },
        readGame: (rel) =>
        {
            const g = gameFile(c.gameDir, rel);
            return g ? readFileSync(g) : undefined;
        },
        gameShaders: c.gameDir ? gameFilesBelow(c.gameDir, 'gfx/FX', /\.shader$/i).map((f) => f.rel) : [],
        gameVersion: c.gameDir ? gameVersion(c.gameDir) : undefined,
        // (for the effects of the mod the game does not draw, shaderRule.ts `markUndrawn`: the executable's strings, and the names the loaded
        // world's files give (the game's layers, the mod, its patch mod as it stands, the other mods of the list))
        engine: () => (c.gameDir ? engineStrings(c.gameDir) : undefined),
        dataNames: (names) => loadedNames(
            [...(c.gameDir ? layerRoots(c.gameDir) : []), ...(c.patchRoot ? [c.patchRoot] : []), ...(c.others ?? [])],
            [...c.modFiles].map(([rel, where]) => ({ rel, read: () => (where.file ? readFileSync(where.file) : where.entry && c.mod.archive ? zipEntry(c.mod.archive, where.entry) : undefined) })),
            names,
            undefined,
            new Set(c.gameDir ? layerRoots(c.gameDir) : []))
    };
}

/** Files no name for the engine is read from: binary formats, effect files themselves, localization, `.info` documentation, descriptors. */
const NOT_DATA = /\.(dds|png|tga|jpg|jpeg|webp|bmp|anim|bank|bk2|ttf|otf|cur|dll|dylib|exe|pdf|yml|fnt|wav|ogg|mp3|bin|mesh|shader|fxh|dlc|zip|psd|info|ico|mod)$/i;

/** Whether a file (path below its root) may name something for the engine: not an effect file, no localization, no binary format (`NOT_DATA`). */
const isDataFile = (rel: string): boolean =>
{
    const r = rel.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    return !r.startsWith('gfx/fx/') && !/(^|\/)localization\//.test(r) && !NOT_DATA.test(r) && !r.split('/').pop()!.startsWith('.');
};

/**
 * Which of the names the loaded files name, outside the effect files, localization and `.info` documentation (shaderRule.ts
 * `ShaderInput.dataNames`): the files below the roots and the mod's own (`files`), as whole words, comments too, and with no layering:
 * a name in a file another hides counts as well, which errs towards "named" (no note). A word scan of the raw bytes; it yields between
 * files. `gameLayers`: the roots that are the game's layers: a file there that has none of the names still wanted as a word (its
 * words kept for the session, gameFacts.ts) is not read, when every name is one word of [A-Za-z0-9_] (found only as such a word).
 */
export async function loadedNames(roots: string[], files: { rel: string; read(): Buffer | undefined; }[], names: string[], stop?: () => void, gameLayers: ReadonlySet<string> = new Set()): Promise<Set<string>>
{
    const out = new Set<string>();
    const wanted = [...new Set(names)].map((n) => ({ n, b: Buffer.from(n, 'latin1'), h: wordHash(n) >>> 0 }));
    const id = (c: number | undefined): boolean => c !== undefined && ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122));
    const words = wanted.every((w) => isWordName(w.n));
    const mayName = (file: string): boolean =>
    {
        const have = byteWords(file);
        return !have || wanted.some((w) => !out.has(w.n) && holdsHash(have, w.h));
    };
    let n = 0;
    // (`stop`: the job's look at Cancel, before each file)
    const scan = async (data: Buffer | undefined): Promise<void> =>
    {
        stop?.();

        for (const w of data ? wanted : [])
            for (let i = out.has(w.n) ? -1 : data!.indexOf(w.b); i >= 0; i = data!.indexOf(w.b, i + 1))
                if (!id(data![i - 1]) && !id(data![i + w.b.length]))
                {
                    out.add(w.n);
                    break;
                }

        if (++n % 200 === 0)
            await new Promise((r) => setImmediate(r));
    };
    const walk = async (root: string, dir: string, rel: string, game: boolean): Promise<void> =>
    {
        let entries;

        try
        {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch
        {
            return;
        }

        for (const e of entries)
        {
            const r = rel ? rel + '/' + e.name : e.name;

            if (out.size === wanted.length)
                return;

            if (e.isDirectory())
            {
                // (a game folder's DLC folders are roots of their own)
                if (!(dir === root && /^dlc$/i.test(e.name) && roots.some((x) => x.startsWith(join(root, e.name)))) && !/^gfx\/fx$/i.test(r) && !/^localization$/i.test(e.name))
                    await walk(root, join(dir, e.name), r, game);
            }
            else if (isDataFile(r))
            {
                // (a game file without any of the names: not read, the look at Cancel and the pause as for a file read)
                if (game && words && !mayName(join(dir, e.name)))
                {
                    await scan(undefined);
                    continue;
                }

                let data: Buffer | undefined;

                try
                {
                    data = readFileSync(join(dir, e.name));
                }
                catch
                {
                    // (not a file to read: a link, a locked file)
                }

                await scan(data);
            }
        }
    };

    for (const root of roots)
        await walk(root, root, '', gameLayers.has(root));

    for (const f of files)
        if (out.size < wanted.length && isDataFile(f.rel))
            await scan(f.read());

    return out;
}

/** The merged effect files of a merge rule: the game's files with the mod's effects added (shaderRule.ts), made once per context. */
function shaderWorkOf(c: RuleContext, rule: FileRule): ShaderWork
{
    c.shaders ??= new Map();
    let w = c.shaders.get(rule);

    if (!w)
    {
        w = shaderWork(shaderInputOf(c, rule));
        c.shaders.set(rule, w);
    }

    return w;
}

/**
 * The merge rules' work, checked the way the game builds the files and repaired (shaderRule.ts `verifiedShaderWork`; docs/shaders.md
 * "Verifying a merge"), before the plan, the state check or the run ask for it. A copy of the mod that stayed as it was and is merged
 * after all joins the rule's files (and is no longer left alone). A check that cannot run leaves the plain merge.
 */
async function prepareShaders(c: RuleContext, rules: FileRule[], left?: LeftAlone, stop?: () => void): Promise<void>
{
    c.shaders ??= new Map();

    for (const rule of rules)
    {
        if (rule.kind !== 'mergefx' || c.shaders.has(rule))
            continue;

        try
        {
            // (`stop`: the job's look at Cancel, at the check's yields)
            const input = { ...shaderInputOf(c, rule), stop };
            const w = await verifiedShaderWork(input);

            for (const rel of mergedAfterAll(w, input))
            {
                rule.files.push(rel);
                rule.keep = rule.keep?.filter((x) => x !== rel);
                left?.delete(rel);
            }

            c.shaders.set(rule, w);
        }
        catch
        {
            // (the merge stands without the check; a cancel goes on)
            stop?.();
        }
    }
}

/**
 * A merged shader file against the patch mod: write it, write it again (the game's file or the mod's changed since, or the
 * copy is the plain game file an older run left), keep the patch mod's, nothing. The manifest knows the hash of the copy as
 * it was written (as a merged file or as a plain restore): one that still has it is stale, one that differs was changed by
 * hand. A copy without a record that differs is written again.
 */
function shaderAction(c: RuleContext, rel: string, f: ShaderFile): RestoreAction
{
    const out = c.patchRoot ? join(c.patchRoot, ...rel.split('/')) : undefined;

    if (!out || !existsSync(out))
        return 'copy';

    const have = sha1(readFileSync(out));

    if (have === f.hash)
        return 'same';

    const written = c.manifest?.merged[rel]?.out ?? c.manifest?.restored[rel];
    return written && have !== written ? 'kept' : 'refresh';
}

/**
 * The files of a rule the existing patch mod still lacks the rule's work on; empty: the rule is done (a second run
 * lists it as done and writes nothing). One small check per kind; a new rule kind adds its own here, next to its apply
 * code in `migrateMod`, and must leave a second run idempotent.
 */
function ruleTodo(rule: FileRule, c: RuleContext): string[]
{
    const todo = (test: (rel: string, text: string | undefined) => boolean): string[] => rule.files.filter((rel) => test(rel, patchText(c, rel)));

    switch (rule.kind)
    {
        // (the copy is the game's file, or was changed by hand)
        case 'restore':
            return rule.files.filter((rel) => ['copy', 'refresh'].includes(restoreAction(c, rel).action));
        // (the merged file is in the patch mod, or was changed by hand)
        case 'mergefx':
        {
            const w = shaderWorkOf(c, rule);
            return rule.files.filter((rel) => ['copy', 'refresh'].includes(shaderAction(c, rel, w.files.get(rel)!)));
        }
        // (the empty copy exists)
        case 'empty':
            return todo((rel, text) => text === undefined || (rule.trim?.has(rel) ? text !== withoutEntries(readTextFile(gameFile(c.gameDir, rel)!), rule.trim.get(rel)!) : false));
        // (no site of the key left in the patch mod's copy)
        case 'rename':
            return todo((_, text) => text === undefined || renameSites(text, rule.from!).length > 0);
        // (nothing missing in the patch mod's copy)
        case 'settings':
            return todo((rel, text) => text === undefined || missingSettings(settingsGame(c.gameDir, rel, rule), text, rule.block!, rule.keys!, rule.own).length > 0);
        // (nothing left to add to the copy as it loads now: the patch mod's, else the mod's)
        case 'modelStates':
        {
            const w = modelStatesWork(c, rule, (rel) => currentText(c, rel));
            return rule.files.filter((rel) => w.adds.has(rel));
        }
        // (no match left in the patch mod's copy)
        case 'rewrite':
            return todo((_, text) => text === undefined || new RegExp(rule.find!).test(text));
        // (the zz_ file holds what would be written)
        case 'merge':
            return [...mergeOutputs(rule, c)].filter(([rel, o]) => !mergeDone(c, rel, o.text)).flatMap(([, o]) => o.files);
        case 'defines':
        {
            const o = definesOutput(rule, c);
            return readIfExists(c, o.rel) === o.text ? [] : rule.files;
        }
        // (no statement left to change in the patch mod's copy (the mod's file where it has none), nor in a file of its own)
        case 'statements':
            return [...new Set([...rule.files, ...patchFilesFor(c.patchRoot, rule.group!.files).filter((rel) => !c.modFiles.has(rel))])]
                .filter((rel) =>
                {
                    const text = currentText(c, rel);
                    return !!text && statementEdits(text, rel, rule.group!, c.script!).edits.length > 0;
                });
        // (every definition of the patch mod's copy (the mod's file where it has none) has the key)
        case 'adds':
            return todo((rel) =>
            {
                const text = currentText(c, rel);
                return !!text && addKeyEdits(text, rule.add!, gameAddsOf(c, rule.add!)).length > 0;
            });
        // (every definition of the patch mod's copy (the mod's file where it has none, a file of its own) has what the game's
        // has and the older files do not know; the files the fixes still move definitions out of count while they hold them)
        case 'gains':
        {
            const w = gainWorkOf(c, rule.gain!);
            return [...new Set([...rule.files, ...patchFilesFor(c.patchRoot, rule.gain!.files).filter((rel) => !c.modFiles.has(rel))])]
                .filter((rel) =>
                {
                    const text = currentText(c, rel);
                    return !!text && gainEdits(text, rule.gain!, w.scope, w.game, rule.gain!.dropAbsent ? c.absent : undefined).edits.length > 0;
                });
        }
        // (no definition left to change in the patch mod's copy (the mod's file where it has none), nor in a file of its own;
        // no banner texture left to bring)
        case 'banners':
        {
            const w = bannerWork(c.mod, c.modFiles, c.gameDir, rule.banner!, c.patchRoot);
            const rels = [...new Set([...rule.files, ...patchFilesFor(c.patchRoot, rule.banner!.files).filter((rel) => !c.modFiles.has(rel))])];
            const files = rels.filter((rel) =>
            {
                const text = currentText(c, rel);
                return !!text && bannerEdits(text, rule.banner!, w.env).length > 0;
            });
            return [...files, ...[...w.copies.keys()].filter((rel) => !c.patchRoot || !existsSync(join(c.patchRoot, ...rel.split('/'))))];
        }
        // (no call left to rewrite in the patch mod's copy, the mod's file where it has none)
        case 'dataCalls':
            return todo((rel) =>
            {
                const text = currentText(c, rel);
                return !!text && c.script !== undefined && dataCallEdits(text, rel, rule.calls!, dataCallEnv(c.gameDir, c.script.sets.tenets, c.namedKeys)).edits.length > 0;
            });
        // (no display name of a compound left in the patch mod's copy; no DX10 header left; no longer mip chain left)
        case 'particles':
            return particleTodo(c, rule.files, rule.compounds!);
        case 'ddsLegacy':
            return ddsTodo(c, rule.files, rule.folder!);
        case 'maskMips':
            return maskTodo(c, rule.folder!, rule.files);
        // (no entry left to rename and no value to spell otherwise in the patch mod's copy (the mod's file where it has none); the
        // localization file as it would be written; the copied files there)
        case 'renamed':
        {
            const w = rule.renamed!;
            return rule.files.filter((rel) =>
            {
                const f = w.files.get(rel);

                if (f)
                {
                    const text = currentText(c, rel);
                    return !!text && renamedFileText(text, f) !== text;
                }

                const o = w.outputs.get(rel)!;
                return o.text !== undefined ? readIfExists(c, rel) !== o.text : !c.patchRoot || !existsSync(join(c.patchRoot, ...rel.split('/')));
            });
        }
        // (nothing left to rename or copy with the patch mod's files counted; with fixes to come, what they move is unknown)
        case 'icons':
        {
            if (!c.patchRoot || c.pendingFixes)
                return rule.files;

            const w = iconWork(c.mod, c.modFiles, c.gameDir, rule.icon!, c.patchRoot);
            return [...w.renames.keys(), ...w.copies.keys()];
        }
    }
}

/** A file of the patch mod as it is (byte order mark and all); undefined when missing. */
function readIfExists(c: RuleContext, rel: string): string | undefined
{
    const file = c.patchRoot ? join(c.patchRoot, ...rel.split('/')) : undefined;
    return file && existsSync(file) ? readTextFile(file) : undefined;
}

/**
 * Whether the patch mod's file of a merge is what the merge would write, or what the inert references step made of it (the step rewrites
 * the statements of the merged file that name entries the playset lacks; its record has the hash the file had before, and the manifest
 * the hash it was left with, so a file nobody changed since reads as done).
 */
function mergeDone(c: RuleContext, rel: string, text: string): boolean
{
    const have = readIfExists(c, rel);

    if (have === text)
        return true;

    const raw = c.manifest?.inert?.raw?.[rel];
    return have !== undefined && !!raw && raw === sha1(encodeText(text)) && c.manifest?.files?.[rel] === sha1(encodeText(have));
}

/**
 * The patch mod against the mod and the rules (patchLife.ts): what the mod changed since the patch mod took its copies, and
 * the records of files no rule names any more (a restored game file the mod stopped overriding, a merge or defines file whose
 * rule has no hits). `rules`: the file rules as the mod is now.
 */
function patchLifeOf(c: RuleContext, rules: FileRule[]): { changes: PatchChanges; orphans: OrphanedRecords; }
{
    const manifest = c.manifest;
    // (the game's files the patch mod holds have records of their own: restore, merge)
    const outside = new Set([...Object.keys(manifest?.restored ?? {}), ...Object.keys(manifest?.merged ?? {})].map(lc));
    return { changes: modChanges(c.mod, c.modFiles, c.patchRoot, manifest, outside), orphans: orphansOf(c, rules) };
}

/**
 * The records of files that no rule asks for any more (what a run deletes): see `patchLifeOf`. The inert step's whole-file copies of
 * the game's database files an older run made count too (`staleGameCopies`): deleted before the libraries step, which then writes
 * overrides of their entries from the game's file again.
 */
function orphansOf(c: RuleContext, rules: FileRule[]): OrphanedRecords
{
    const claimed = new Set(rules.filter((r) => r.kind === 'restore' || r.kind === 'mergefx').flatMap((r) => r.files.map(lc)));
    const named = new Set<string>();

    for (const r of rules)
    {
        if (r.kind === 'merge')
            r.files.forEach((rel) => named.add(lc(mergeFile(rel.slice(0, rel.lastIndexOf('/')), c.folder))));
        else if (r.kind === 'defines')
            named.add(lc(definesFile(r.folder!, c.folder)));
        else if (r.kind === 'renamed')
            r.renamed!.outputs.forEach((_, rel) => named.add(lc(rel)));
    }

    return c.manifest && c.patchRoot ? orphanedRecords(c.manifest, c.patchRoot, claimed, named, staleGameCopies(c.manifest.inert?.copies)) : { remove: [], edited: [], forget: [] };
}

/** The folders a patch mod hides that its mod does not call for any more (listed in its descriptor, and made by a run: the manifest, else the version's new folders). */
function hiddenGone(patch: ModInfo, manifest: FixesManifest | undefined, wanted: string[]): string[]
{
    const norm = (p: string): string => lc(p.replace(/\\/g, '/').replace(/\/+$/, ''));
    const ours = new Set((manifest?.hidden ?? MIGRATIONS.flatMap((m) => Object.values(m.newFolders).flat())).map(norm));
    const want = new Set(wanted.map(norm));
    return patch.replacePaths.filter((p) => ours.has(norm(p)) && !want.has(norm(p)));
}

/** Up to `n` of a list, then "…". */
const shortList = (list: string[], n = 6): string => (list.length > n ? list.slice(0, n).join(', ') + ', …' : list.join(', '));

/** The expressions of the path patterns asked so far (the rules' patterns: a fixed set; each filters every file of the mod). */
const globs = new Map<string, RegExp>();

/** A path pattern: `**` any folders, `*` any name part, else the path itself (case aside). */
function globMatch(pattern: string, rel: string): boolean
{
    let re = globs.get(pattern);

    if (!re)
    {
        const body = pattern
            .split(/(\*\*\/?|\*)/)
            .map((part) => (part.startsWith('**') ? '(?:.*/)?' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
            .join('');
        re = new RegExp(`^${body}${pattern.endsWith('/**') ? '.*' : ''}$`, 'i');
        globs.set(pattern, re);
    }

    return re.test(rel);
}

/** A patch mod's folder name for a mod and version: `<folder of the mod>_<1_20>_fixes`. */
function patchFolder(mod: ModInfo, to: string): string
{
    // (a mod packed into a zip: the archive is named by a UUID or by `mod.zip`; its .mod file names the mod: pdx_11746)
    const packed = !mod.root && mod.archive ? (mod.descriptorFile ?? mod.id).split(/[\\/]/).pop()!.replace(/\.mod$/i, '') : undefined;
    const base = (mod.root ?? packed ?? mod.archive ?? mod.name).split(/[\\/]/).pop()!.replace(/\.zip$/i, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'mod';
    return `${base}_${to.replace(/\./g, '_')}_fixes`;
}

/** The patch mod of that folder name among the mods found: its unpacked folder, or (`packed`) the zip it was packed into. */
function findPatch(mods: ModInfo[], folder: string): { patch?: ModInfo; packed?: ModInfo; }
{
    const patch = mods.find((m) => m.root && lc(m.root.split(/[\\/]/).pop()!) === lc(folder));
    const packed = patch ? undefined : mods.find((m) => !m.root && m.archive && lc(m.archive.split(/[\\/]/).pop()!.replace(/\.zip$/i, '')) === lc(folder));
    return { patch, packed };
}

/** Where the patch mod stands in the loaded list: not in it (or disabled), or before the mod it patches; else undefined. */
function patchPlace(state: ModsState, mod: ModInfo, patch: ModInfo): 'missing' | 'before' | undefined
{
    const loaded = modsOfList(state, state.selected).map((m) => lc(m.id));
    const at = loaded.indexOf(lc(patch.id));
    return at < 0 ? 'missing' : at < loaded.indexOf(lc(mod.id)) ? 'before' : undefined;
}

/**
 * The patch mods of earlier runs that a list lacks: per enabled mod of the entries that has an unpacked patch mod (its folder
 * name, as `patchFolder` makes it) the patch's id, and the mod it follows. `except`: a patch mod the caller places itself.
 */
function patchesMissing(state: ModsState, entries: { id: string; enabled: boolean; }[], except: string): { patch: string; after: string; }[]
{
    const out: { patch: string; after: string; }[] = [];
    const byId = new Map(state.mods.map((m) => [lc(m.id), m]));
    const has = new Set(entries.map((e) => lc(e.id)));

    for (const e of entries.filter((x) => x.enabled))
    {
        const mod = byId.get(lc(e.id));
        const steps = mod ? migrationsBetween(mod.supportedVersion, state.gameVersion) : [];
        const patch = mod && steps.length ? findPatch(state.mods, patchFolder(mod, steps[steps.length - 1].to)).patch : undefined;

        if (patch && lc(patch.id) !== lc(except) && !has.has(lc(patch.id)))
        {
            has.add(lc(patch.id));
            out.push({ patch: patch.id, after: e.id });
        }
    }

    return out;
}

const packedProblem = (patch: ModInfo): string => tr('The patch mod {name} is packed into a zip: unpack it first (its row in the mod list, “Unpack”) — a run writes into its folder', { name: patch.name });

/** Adds `replace_path`s to a mod's descriptors (the outer one and the folder's); `wrote`: the watcher told of each first. */
export function addReplacePaths(mod: ModInfo, paths: string[], wrote?: Announce): string[]
{
    const added: string[] = [];

    for (const [file, location] of [[mod.descriptorFile, true], [mod.root && join(mod.root, 'descriptor.mod'), false]] as [string | undefined, boolean][])
    {
        if (!file || !existsSync(file))
            continue;

        const d = parseDescriptor(readFileSync(file, 'utf8'));
        const has = new Set(d.replacePaths.map(lc));
        const add = paths.filter((p) => !has.has(lc(p)));

        if (!add.length)
            continue;

        d.replacePaths.push(...add);
        wrote?.([file, file + '.crusaderpope-tmp']);
        writeAtomic(file, writeDescriptor(d, location));
        added.push(...add.filter((p) => !added.includes(p)));
    }

    return added;
}

/** Takes `replace_path`s out of a mod's descriptors (the outer one and the folder's); the ones that were there. */
export function removeReplacePaths(mod: ModInfo, paths: string[], wrote?: Announce): string[]
{
    const removed: string[] = [];
    const norm = (p: string): string => lc(p.replace(/\\/g, '/').replace(/\/+$/, ''));
    const drop = new Set(paths.map(norm));

    if (!drop.size)
        return removed;

    for (const [file, location] of [[mod.descriptorFile, true], [mod.root && join(mod.root, 'descriptor.mod'), false]] as [string | undefined, boolean][])
    {
        if (!file || !existsSync(file))
            continue;

        const d = parseDescriptor(readFileSync(file, 'utf8'));
        const gone = d.replacePaths.filter((p) => drop.has(norm(p)));

        if (!gone.length)
            continue;

        d.replacePaths = d.replacePaths.filter((p) => !drop.has(norm(p)));
        wrote?.([file, file + '.crusaderpope-tmp']);
        writeAtomic(file, writeDescriptor(d, location));
        removed.push(...gone.filter((p) => !removed.includes(p)));
    }

    return removed;
}

/**
 * Names a mod as a dependency in a patch mod's descriptors (the outer one and the folder's): the launcher then warns when the
 * patch mod is on and its mod is not, and puts it behind the mod. Nothing is written when it is named already.
 */
export function addDependency(patch: ModInfo, name: string, wrote?: Announce): boolean
{
    let added = false;

    for (const [file, location] of [[patch.descriptorFile, true], [patch.root && join(patch.root, 'descriptor.mod'), false]] as [string | undefined, boolean][])
    {
        if (!file || !existsSync(file))
            continue;

        const d = parseDescriptor(readFileSync(file, 'utf8'));

        if (d.dependencies.some((x) => lc(x) === lc(name)))
            continue;

        d.dependencies.push(name);
        wrote?.([file, file + '.crusaderpope-tmp']);
        writeAtomic(file, writeDescriptor(d, location));
        added = true;
    }

    return added;
}

/** Thrown when the user cancelled; what was done stays (each fix is its own undo step). */
export class MigrationCancelled extends Error {}

export interface MigrationRun
{
    progress?(p: MigrationProgress): void;
    cancelled?(): boolean;
    /** interface files the owner chose to take whole from the game (the plan's `optional`) */
    restore?: string[];
}

/** What a run leaves to its end, whether it finished, failed or was cancelled: the manifest and the files to take into the index. */
interface RunEnd
{
    mod?: ModInfo;
    modFiles?: Map<string, { file?: string; entry?: string; }>;
    patch?: ModInfo;
    manifest?: FixesManifest;
    /** the files of the patch mod at the start of the work (after the stale ones went): what the run wrote is what differs at its end */
    before?: Map<string, string>;
    /** the copies made at another path than their source (a banner texture from the old folder): target → the mod's file it was taken from */
    carried: Map<string, { file?: string; entry?: string; }>;
    /** a patch mod from before the records: the time of its manifest (what was touched after is not the run's) */
    since?: number;
    /** the files written or deleted, taken into the index at the end */
    touched: string[];
    /** every file the run wrote or deleted that no step handed to the index (a run that ended early): taken in at the end too */
    writes: RunWrites;
    /** the game version, once every rule ran (a run that stopped did not bring the patch mod up to it) */
    game?: string;
}

/** Runs the migration. A zipped mod is opened once for the whole run, not for every file (zip.ts `holdingZips`); its files are read once (keptTexts.ts). */
export function migrateMod(host: ModsHost, modId: string, run: MigrationRun = {}): Promise<MigrationResult>
{
    return holdingZips(() => keepingTexts(() => migrateWork(host, modId, run)));
}

async function migrateWork(host: ModsHost, modId: string, run: MigrationRun): Promise<MigrationResult>
{
    const end: RunEnd = { touched: [], carried: new Map(), writes: new RunWrites() };
    let result: MigrationResult;

    try
    {
        result = await migrateRun(host, modId, run, end);
    }
    catch (e)
    {
        // (the run's own failure is the one to report; the records are still written)
        await finishRun(host, end);
        throw e;
    }

    // (a manifest that could not be written is a failure of the run: the next one would read this one's work as changes)
    result.failed.push(...await finishRun(host, end));
    return result;
}

/**
 * The end of a run, also after a failure or a Cancel: what was done is recorded (the hashes of the game files copied, the files
 * left, the mod's files they were made from) and taken into the index; a patch mod whose manifest stayed behind would read
 * its own earlier work as changes by hand or as an old game file. Each step has its own try, so one that fails does not keep
 * the others from running; what failed is returned.
 */
async function finishRun(host: ModsHost, end: RunEnd): Promise<{ name: string; why: string; }[]>
{
    const failed: { name: string; why: string; }[] = [];

    if (!end.patch?.root || !end.manifest)
        return failed;

    const step = async (name: string, work: () => void | Promise<void>): Promise<void> =>
    {
        try
        {
            await work();
        }
        catch (e)
        {
            failed.push({ name, why: e instanceof Error ? e.message : String(e) });
        }
    };

    const root = end.patch.root;
    const manifest = end.manifest;
    await step(tr('Records of the patch mod’s files'), () =>
    {
        if (end.before && end.mod && end.modFiles)
            recordLife({ manifest, mod: end.mod, modFiles: end.modFiles, patchRoot: root, before: end.before, carried: end.carried, since: end.since });
    });
    manifest.game = end.game ?? manifest.game;
    await step(tr('Manifest of the patch mod'), () => void writeManifest(root, manifest, announcer(host)));
    await step(tr('Index of the patch mod’s files'), async () =>
    {
        // (and what the steps did not hand over themselves: after a full run nothing, after a Cancel between the steps or an error
        // the files the rules wrote and deleted (restore, empty, defines, the textures …), the stale copies deleted before the re-index)
        const files = [...end.touched, ...end.writes.pending(end.touched)];

        if (files.length)
            await host.refreshFiles?.(files);
    });
    return failed;
}

async function migrateRun(host: ModsHost, modId: string, run: MigrationRun, end: RunEnd): Promise<MigrationResult>
{
    let state = await modsState(host);
    const mod = state.mods.find((m) => lc(m.id) === lc(modId));

    if (!mod)
        throw new Error(tr('No mod {id}', { id: modId }));

    const report = (p: MigrationProgress): void => run.progress?.(p);
    report({ stage: tr('Reading the mod…'), done: 0, total: 0 });
    // (a cancel while it plans: nothing is written yet)
    let plan = await planMigration(host, modId, { libraries: false, cancelled: run.cancelled });

    if (plan.problem)
        throw new Error(plan.problem);

    if (!plan.steps.length)
        throw new Error(tr('{name} is written for {supported}: nothing to migrate to {game}', { name: mod.name, supported: mod.supportedVersion ?? '?', game: state.gameVersion ?? '?' }));

    const to = plan.steps[plan.steps.length - 1].to;
    const notes: string[] = [];
    // (every file the run writes or deletes is announced first: the watcher must not take them for another editor's saves; and
    // recorded, so a run that ends early hands the index what no step took in)
    const announce = announcer(host, end.writes);
    // (the steps' updates of the index: what they hand over is no longer the end's)
    const refresh = async (files: string[]): Promise<void> =>
    {
        end.writes.indexed(files);
        await host.refreshFiles?.(files);
    };

    // 1. the patch mod: made once (a local mod in the user's mod folder), then reused
    report({ stage: tr('Making the patch mod…'), done: 0, total: 0 });
    const folder = patchFolder(mod, to);
    let patch = findPatch(state.mods, folder).patch;

    // (nothing to fix and no patch mod yet: none is made; the dialog's button is off then, and a direct call must not leave an
    // empty patch mod, its descriptor and a list entry behind; the first plan leaves out the library and interface work)
    if (!patch && !planHasWork(plan) && !run.restore?.length)
    {
        plan = await planMigration(host, modId, { cancelled: run.cancelled });

        if (!planHasWork(plan))
            throw new Error(tr('{name} needs nothing for {game}: no entry to fix and no file to write', { name: mod.name, game: state.gameVersion ?? '?' }));
    }

    if (!patch)
    {
        state = await createMod(host, {
            name: tr('{name} — {version} fixes', { name: mod.name, version: to }),
            folder,
            version: '1',
            supportedVersion: supportedVersionFor(state.gameVersion) || `${to}.*`,
            tags: ['Fixes']
        });
        patch = state.mods.find((m) => m.root && lc(m.root.split(/[\\/]/).pop()!) === lc(folder));

        if (!patch)
            throw new Error(tr('The patch mod could not be made'));

        notes.push(tr('Made the patch mod {name} ({folder})', { name: patch.name, folder }));
    }

    // (the mod updated since the patch mod took its copies, or dropped files: the copies would shadow the update, and every rule
    // would read as done. What the last run left is deleted (a file changed by hand stays) and the steps below build it again
    // from the mod as it is now; two runs from nothing make the same patch mod. The index is read again below.)
    const modFiles = filesOf(mod);
    const existing = readManifest(patch.root);
    const manifest: FixesManifest = existing ?? { restored: {}, merged: {}, lost: {} };
    const changes = modChanges(mod, modFiles, patch.root, existing, new Set([...Object.keys(manifest.restored), ...Object.keys(manifest.merged)].map(lc)));

    if (changes.stale.length)
    {
        report({ stage: tr('The mod changed since the patch mod took its files: building them again…'), done: 0, total: 0 });
        deleteFiles(patch.root!, changes.reset, announce);
        notes.push(trn('{name} changed {n} file the patch mod held a copy of (or dropped it) since: the patch mod’s {all} files are made again from the mod as it is now ({list})', '{name} changed {n} files the patch mod held copies of (or dropped them) since: the patch mod’s {all} files are made again from the mod as it is now ({list})', changes.stale.length, { name: mod.name, all: changes.reset.length, list: shortList(changes.stale.map((s) => s.rel)) }));

        if (changes.legacy)
            notes.push(tr('The patch mod was made before it recorded the mod’s files: a file of the mod newer than the patch mod’s copy counts as changed, and every file of the patch mod but the game’s own was made again — except those changed after its last run, which stay'));

        if (changes.edited.length)
            notes.push(trn('{n} file of the patch mod was changed after its last run and was kept ({list})', '{n} files of the patch mod were changed after its last run and were kept ({list})', changes.edited.length, { list: shortList(changes.edited) }));
    }

    if (changes.keptStale.length)
        notes.push(trn('{name} changed {n} file you also changed in the patch mod: the patch mod’s copy was kept, the update does not reach it ({list})', '{name} changed {n} files you also changed in the patch mod: the patch mod’s copies were kept, the update does not reach them ({list})', changes.keptStale.length, { name: mod.name, list: shortList(changes.keptStale) }));

    end.mod = mod;
    end.modFiles = modFiles;
    end.patch = patch;
    end.manifest = manifest;
    end.before = hashFiles(patch.root!, patchFiles(patch.root!));
    end.since = existing && !existing.files ? mtimeOf(join(patch.root!, MANIFEST_FILE)) : undefined;
    // (which mod this patch mod is for: the Mods view tells when that mod catches up with the game)
    manifest.base = { id: mod.id, name: mod.name };

    // (the version's new folders the mod's replace_paths call for, read by the re-index below)
    const hidden = addReplacePaths(patch, plan.replacePaths ?? [], announce);

    // (the folders it hid for a replace_path the mod no longer has)
    const freed = removeReplacePaths(patch, hiddenGone(patch, existing, plan.replacePaths ?? []), announce);
    // (a folder the mod has files of its own in: an older run hid it for the mod's replace_path, and with it the mod's files)
    const freedOwn = freed.filter((p) => (plan.replacePathsOwn ?? []).some((o) => lc(o) === lc(p.replace(/\\/g, '/').replace(/\/+$/, ''))));

    if (freedOwn.length)
        notes.push(tr('The patch mod no longer hides {list}: {name} has files of its own directly in them, which the hiding took too', { list: freedOwn.join(', '), name: mod.name }));

    if (freed.length > freedOwn.length)
        notes.push(tr('The patch mod no longer hides the game’s and earlier mods’ files in {list}: {name} does not replace what they belong to any more', { list: freed.filter((p) => !freedOwn.includes(p)).join(', '), name: mod.name }));

    manifest.hidden = plan.replacePaths ?? [];

    if (hidden.length)
        notes.push(tr('The patch mod hides the game’s and earlier mods’ files in {list} (the mod replaces what they belong to)', { list: hidden.join(', ') }));

    // (what that takes from the mods before this one, the mod's own files it spares, a hiding an older run did that it should not)
    for (const h of (plan.replacePathHides ?? []).filter((x) => hidden.includes(x.folder)))
        notes.push(trn('{n} file of {mod} in {folder} is hidden too — put {mod} after the patch mod to keep it', '{n} files of {mod} in {folder} are hidden too — put {mod} after the patch mod to keep them', h.files, { mod: h.mod, folder: h.folder }));

    if (plan.replacePathsOwn?.length)
        notes.push(trn('The patch mod does not hide {list}: {name} has files of its own directly in it', 'The patch mod does not hide {list}: {name} has files of its own directly in them', plan.replacePathsOwn.length, { list: plan.replacePathsOwn.join(', '), name: mod.name }));

    if (plan.replacePathsShadowed?.length)
        notes.push(tr('The patch mod hides {list} although {name} has files of its own directly in them: its religions still hold their faiths, which the fixes write there, and the game’s must not load against them — the files of its own there are hidden too', { list: plan.replacePathsShadowed.join(', '), name: mod.name }));

    if (plan.replacePathsStale?.length)
        notes.push(tr('The patch mod still hides {list}, which holds files of {name}: take the replace_path line out of its descriptor.mod and .mod file', { list: plan.replacePathsStale.join(', '), name: mod.name }));

    // (copies of game files the rules leave alone: they are the game's, or the new version's)
    if (plan.leftAlone?.same.length)
        notes.push(trn('{n} file of {name} is the game’s own file, byte for byte: nothing to copy — {list}', '{n} files of {name} are the game’s own files, byte for byte: nothing to copy — {list}', plan.leftAlone.same.length, { name: mod.name, list: shortList(plan.leftAlone.same) }));

    if (plan.leftAlone?.current.length)
        notes.push(trn('{n} file of {name} holds the lines of the game’s new file, bar a few it changed, and adds its own: left as {name} has it — {list}', '{n} files of {name} hold the lines of the game’s new files, bar a few they changed, and add their own: left as {name} has them — {list}',plan.leftAlone.current.length, { name: mod.name, list: shortList(plan.leftAlone.current) }));

    // (the patch mod needs the mod: its replace_paths hide the game's files for good when only it is loaded)
    addDependency(patch, mod.name, announce);

    // 2. the loaded list with the patch mod right after the mod (a custom list: the app's own; a launcher playset or
    // the game's list is copied into one)
    const list = state.lists.find((l) => l.ref === state.selected);
    // (named by the list it was made from; no patch mod in the name, which later runs add more to)
    const listName = list?.kind === 'custom' ? list.name : tr('{name} with {version} fixes', { name: list?.name ?? tr('Mods'), version: to });
    // (a custom list of that name from a run before is reused (not one more of the same name each run), and it is the
    // base then, not the playset: the owner's edits of it (order, mods added or taken out) stay)
    const reuse = list?.kind === 'custom' ? list : state.lists.find((l) => l.kind === 'custom' && l.name === listName);
    const base = reuse ?? list;
    const entries = (base?.mods ?? []).filter((m) => lc(m.id) !== lc(patch!.id));
    const at = entries.findIndex((m) => lc(m.id) === lc(mod.id));
    entries.splice(at < 0 ? entries.length : at + 1, 0, { id: patch.id, enabled: true });

    // (a list the app makes from a playset or the game's list: the patch mods of runs before come along; a second mod's run
    // from the playset must not make a list without the first's)
    if (base?.kind !== 'custom')
        for (const other of patchesMissing(state, entries, patch.id))
            entries.splice(entries.findIndex((m) => lc(m.id) === lc(other.after)) + 1, 0, { id: other.patch, enabled: true });

    // (saving the loaded list re-indexes when it changes what the index loads (manager.ts change()): that build starts after
    // everything this run changed so far (the patch mod made, its stale copies deleted, its replace_paths), a second one
    // below would read the same)
    let reindexed = false;
    const saving: ModsHost = Object.assign(Object.create(host) as ModsHost, {
        reindex: (): void =>
        {
            reindexed = true;
            // (the build reads the files as they are now: what the run wrote so far (the stale copies deleted, the descriptors) needs no update)
            end.writes.reindexed();
            host.reindex();
        }
    });
    state = await saveList(saving, { ref: reuse?.ref, name: listName, mods: entries });
    const ref = reuse?.ref ?? [...state.lists].reverse().find((l) => l.kind === 'custom' && l.name === listName)?.ref;

    report({ stage: tr('Reading the mods again…'), done: 0, total: 0 });

    if (ref && ref !== state.selected)
        state = await selectList(saving, ref);
    else if (!reindexed)
        saving.reindex();

    await setActive(host, patch.id);
    await host.ready?.();
    // (the fixes write the patch mod's files only: the mods as they stand now, read once for all of them, not by each)
    const fixState = await modsState(host);

    const copied: string[] = [];
    const fixed: string[] = [];
    const failed: { name: string; why: string; }[] = [];
    const tried = new Set<string>();
    const keyOf = (f: MigrationFinding): string => `${f.fix!.fix}|${f.fix!.type}|${f.fix!.name}`;
    let total = 0;
    // (Cancel is looked at before each pass and between the fixes, and in step 5's work before the rules: what was fixed stays)
    const stopFixes = (): void =>
    {
        if (run.cancelled?.())
            throw new MigrationCancelled(tr('Cancelled after {n} fixes — they stay in the patch mod (each can be undone)', { n: fixed.length }));
    };

    for (let pass = 0; pass < MAX_PASSES; pass++)
    {
        stopFixes();
        // (planned on the index as it is now, the patch mod and its list loaded: the plan made before them can be
        // stale, e.g. made while the index still held a deleted patch mod's fixed copies, which marks nothing; later
        // passes: what the fixes brought up. Only the index's marks: a pass reads the findings, and the steps after the
        // last; the file rules are planned in step 5)
        plan = (await indexPlan(host, modId)).plan;

        const fixes = plan.findings.filter((f) => f.fix && !tried.has(keyOf(f)));

        if (!fixes.length)
            break;

        total += fixes.length;

        // 3. the files to fix copied from the mod into the patch mod (unless it has them already: a second run)
        const rels = [...new Set(fixes.map((f) => f.rel))];
        const now: string[] = [];
        let zip: ZipArchive | undefined;

        for (const rel of rels)
        {
            const out = join(patch.root!, ...rel.split('/'));

            if (existsSync(out))
                continue;

            if (mod.root)
                put(announce, out, readFileSync(join(mod.root, ...rel.split('/'))));
            else if (mod.archive)
            {
                zip ??= new ZipArchive(mod.archive);
                const data = zip.readEntry(rel);

                if (!data)
                    throw new Error(tr('{rel} could not be read from {zip}', { rel, zip: mod.archive }));

                put(announce, out, data);
            }

            now.push(rel);
        }

        zip?.close();
        copied.push(...now);

        if (now.length)
            await refresh(now.map((rel) => join(patch!.root!, ...rel.split('/'))));

        // 4. each entry fixed in the patch mod, unless a fix before did it (a religion's update moves its faiths)
        for (const f of fixes)
        {
            stopFixes();
            tried.add(keyOf(f));
            report({ stage: tr('Fixing {name}', { name: f.display }), done: tried.size, total });

            if (!(await host.query!<boolean>('migrationStillOld', f.type, f.name)))
                continue;

            try
            {
                const r = await withModsState(fixState, () => createEntries(host, [{ what: 'modernize', key: f.fix!.name, fields: [['type', f.fix!.type], ['fix', f.fix!.fix], ['from', mod.id]] }]));
                fixed.push(`${f.display} (${f.fix!.fix})`);
                notes.push(...r.notes);
            }
            catch (e)
            {
                failed.push({ name: f.display, why: e instanceof Error ? e.message : String(e) });
            }
        }
    }

    // 5. the file rules: keys renamed in the patch mod's copy; the game's own files where the mod's older copy breaks
    // (a rule the patch mod has done already (`ruleTodo`) is not run again: a second run writes nothing; the game's
    // files it carries are refreshed when the game changed them since, kept when changed by hand)
    const rewritten: string[] = [];
    const gameDir = host.gameDir();
    const touched = end.touched;
    const dropped: string[] = [];
    // (blocks of a key the version dropped: file and key, once per block)
    const gone: string[] = [];
    const refreshed: string[] = [];
    // (merged shader files written again: the game's or the mod's file changed, or an older run left the plain game file)
    const rewrittenShaders: string[] = [];
    const kept: string[] = [];
    let known: Set<string> | undefined;
    // (the files chosen once stay taken in the runs after)
    const chosen = [...new Set([...(manifest.optional ?? []), ...(run.restore ?? [])])];

    if (chosen.length)
        manifest.optional = chosen;

    const steps = plan.steps.map((s) => MIGRATIONS.find((m) => m.from === s.from && m.to === s.to)!).filter(Boolean);
    // (read after the fixes: the tenets they moved into the patch mod are tenets now)
    stopFixes();
    const script = gameDir ? await scriptEnv(host, mod, modFiles, gameDir, patch.root, steps) : undefined;
    stopFixes();
    // (the index is current: the patch mod's replace_paths are loaded, so what the game's statements name is asked of the real world)
    const world: RuleWorld = gameDir ? { others: otherRoots(state, [mod.id, patch.id]), absent: await absentRefs(host, steps, gameDir) } : {};
    stopFixes();

    if (gameDir)
    {
        world.namedKeys = await namedContextKeys({ mod, modFiles, gameDir, patchRoot: patch.root, others: world.others }, steps, script, stopFixes);
        stopFixes();
    }

    if (gameDir && steps.some((m) => m.renamed))
    {
        const planned = mergeDefinitions(mod, steps, gameDir, modFiles, script, world.others);
        stopFixes();
        world.renamed = await renamedWorld(host, mod, modFiles, gameDir, patch.root, world.others, folder, steps, planned, stopFixes);
        stopFixes();
    }

    const rc: RuleContext = { mod, modFiles, gameDir: gameDir ?? '', folder, patchRoot: patch.root, ...world, manifest, script, wrote: announce };

    const allRules = gameDir ? fileRules(mod, steps, gameDir, modFiles, script, patch.root, chosen, undefined, world, stopFixes) : [];
    stopFixes();
    await prepareShaders(rc, allRules, undefined, stopFixes);
    stopFixes();

    // (what no rule asks for any more: a game file the mod stopped overriding, a merge or defines file whose rule has no hits)
    if (gameDir)
    {
        const orphans = orphansOf(rc, allRules);
        deleteFiles(patch.root!, orphans.remove, announce);
        touched.push(...orphans.remove.map((rel) => join(patch.root!, ...rel.split('/'))));

        for (const rel of [...orphans.remove, ...orphans.forget])
        {
            delete manifest.restored[rel];
            delete manifest.merged[rel];
            delete manifest.lost[rel];
            manifest.generated &&= manifest.generated.filter((g) => g !== rel);
            manifest.optional &&= manifest.optional.filter((o) => lc(o) !== lc(rel));

            // (an older run's copy of a game database file: no copy of the inert step's any more, and its game file no source of one)
            if (manifest.inert?.copies?.includes(rel))
            {
                manifest.inert.copies = manifest.inert.copies.filter((x) => x !== rel);
                delete manifest.inert.sources[rel];
            }
        }

        if (orphans.remove.length)
            notes.push(trn('{n} file the patch mod carried is not needed any more (no rule asks for it: {name} stopped overriding it, the game dropped it) — deleted: {list}', '{n} files the patch mod carried are not needed any more (no rule asks for them: {name} stopped overriding them, the game dropped them) — deleted: {list}', orphans.remove.length, { name: mod.name, list: shortList(orphans.remove) }));

        if (orphans.edited.length)
            notes.push(trn('{n} file the patch mod carries is not needed any more but was changed by hand — kept (delete it to take the game’s file): {list}', '{n} files the patch mod carries are not needed any more but were changed by hand — kept (delete one to take the game’s file): {list}', orphans.edited.length, { list: shortList(orphans.edited) }));
    }

    // (an exception in one rule is a failure of that rule, told in the result: the others still run, and the manifest keeps what
    // was done; see `finishRun`)
    const applyRule = async (rule: FileRule, at: number): Promise<void> =>
    {
        // (a restore is walked through even when done: the manifest records the copies that are the game's; a merge likewise)
        const todo = ruleTodo(rule, rc);

        if (!todo.length && rule.kind !== 'restore' && rule.kind !== 'mergefx')
        {
            // (sites no rewrite maps, and what no rule can give (tenets without personal settings), are told in every run, though there is nothing to write;
            // so are the entries and values the game renamed)
            if (rule.kind === 'dataCalls' || rule.kind === 'gains' || rule.kind === 'renamed')
                notes.push(...(rule.notes ?? []));

            return;
        }

        report({ stage: rule.label, done: at, total: allRules.length });
        const wrote = rewritten.length;

        // (script statements: the files with one to change, the patch mod's own too, in one pass; the statements no rule can
        // map are told in the notes, after the rules)
        if (rule.kind === 'statements')
        {
            const written = applyStatements(rule, todo, rc);
            rewritten.push(...written);
            touched.push(...written.map((rel) => join(patch.root!, ...rel.split('/'))));

            if (written.length)
                notes.push(`${rule.label}: ${trn('{n} file', '{n} files', written.length)}`);

            return;
        }

        // (statements the version requires: added to the definitions lacking them, in the patch mod's copy)
        if (rule.kind === 'adds')
        {
            const written = applyEdited(todo, rc, (text) => applyStatementEdits(text, addKeyEdits(text, rule.add!, gameAddsOf(rc, rule.add!))));
            rewritten.push(...written);
            touched.push(...written.map((rel) => join(patch.root!, ...rel.split('/'))));

            if (written.length)
                notes.push(`${rule.label}: ${trn('{n} file', '{n} files', written.length)}`);

            return;
        }

        // (what the version added to the definitions the mod's older files hold: in the patch mod's copy; the files a fix still
        // moves definitions out of are only planned, nothing is written there)
        if (rule.kind === 'gains')
        {
            const g = rule.gain!;
            const w = gainWorkOf(rc, g);
            let entries = 0;
            const written = applyEdited(todo.filter((rel) => g.files.some((p) => globMatch(p, rel))), rc, (text) =>
            {
                const r = gainEdits(text, g, w.scope, w.game, g.dropAbsent ? rc.absent : undefined);
                entries += r.entries.length;
                return applyStatementEdits(text, r.edits);
            });
            rewritten.push(...written);
            touched.push(...written.map((rel) => join(patch.root!, ...rel.split('/'))));

            if (written.length)
                notes.push(`${rule.label}: ${trn('{n} definition', '{n} definitions', entries)}, ${trn('{n} file', '{n} files', written.length)}`);

            notes.push(...(rule.notes ?? []));
            return;
        }

        // (entries and values the game renamed: the copies edited as the rules before left them, the texts and files of the old names written)
        if (rule.kind === 'renamed')
        {
            const w = rule.renamed!;
            const written = applyEdited(todo.filter((rel) => w.files.has(rel)), rc, (text, rel) => renamedFileText(text, w.files.get(rel)!));

            for (const rel of todo.filter((r) => w.outputs.has(r)))
            {
                const o = w.outputs.get(rel)!;
                put(announce, join(patch.root!, ...rel.split('/')), o.text ?? readFileSync(o.copy!));
                written.push(rel);
            }

            rewritten.push(...written);
            touched.push(...written.map((rel) => join(patch.root!, ...rel.split('/'))));

            if (written.length)
                notes.push(`${rule.label}: ${trn('{n} file', '{n} files', written.length)}`);

            notes.push(...(rule.notes ?? []));
            return;
        }

        // (the game's animation states and animations the copies of its portrait models lack: added in the patch mod's copy, which the
        // settings rule may have made already; per file what came in, and what was left out)
        if (rule.kind === 'modelStates')
        {
            const w = modelStatesWork(rc, rule, (rel) => currentText(rc, rel));
            const written = applyEdited(todo, rc, (text, rel) => addModelEntries(text, w.adds.get(rel)));
            rewritten.push(...written);
            touched.push(...written.map((rel) => join(patch.root!, ...rel.split('/'))));

            if (written.length)
                notes.push(`${rule.label}: ${trn('{n} file', '{n} files', written.length)}`, ...written.map((rel) =>
                {
                    const a = w.adds.get(rel)!;
                    const s = addsSummary(a);
                    const n = s.entries.length;
                    const what = a.kind === 'packs' ? trn('{n} modifier pack', '{n} modifier packs', n) : a.kind === 'modifiers' ? trn('{n} portrait modifier', '{n} portrait modifiers', n)
                        : a.kind === 'templates' ? trn('{n} gene template', '{n} gene templates', n) : a.kind === 'accessories' ? trn('{n} accessory', '{n} accessories', n) : undefined;

                    if (what)
                        return tr('{file}: {entries} ({list})', { file: rel, entries: what, list: shortList(s.entries, 8) });

                    return tr('{file}: {states}, {animations} ({list})', { file: rel, states: trn('{n} state', '{n} states', s.states.length), animations: trn('{n} animation', '{n} animations', s.animations.length), list: shortList([...s.states, ...s.animations], 8) });
                }));

            notes.push(...modelStateNotes(w));
            return;
        }

        // (calls in interface and localization text: each file's current text rewritten in the patch mod's copy)
        if (rule.kind === 'dataCalls')
        {
            const env = dataCallEnv(gameDir!, script!.sets.tenets, rc.namedKeys);
            const written = applyEdited(todo, rc, (text, rel) => applyCallEdits(text, dataCallEdits(text, rel, rule.calls!, env).edits));
            rewritten.push(...written);
            touched.push(...written.map((rel) => join(patch.root!, ...rel.split('/'))));

            if (written.length)
                notes.push(`${rule.label}: ${trn('{n} file', '{n} files', written.length)}`);

            notes.push(...(rule.notes ?? []));
            return;
        }

        // (tenet banners: the definitions changed in the patch mod's copy, the mod's textures brought into the new folder)
        if (rule.kind === 'banners')
        {
            const w = bannerWork(mod, modFiles, gameDir!, rule.banner!, patch.root);
            const written = applyEdited(todo.filter((rel) => /\.txt$/i.test(rel)), rc, (text) => applyStatementEdits(text, bannerEdits(text, rule.banner!, w.env)));
            rewritten.push(...written);
            touched.push(...written.map((rel) => join(patch.root!, ...rel.split('/'))));

            for (const [rel, src] of w.copies)
            {
                const out = join(patch.root!, ...rel.split('/'));
                const data = src.file ? readFileSync(src.file) : src.game ? readFileSync(src.game) : src.entry && mod.archive ? zipEntry(mod.archive, src.entry) : undefined;

                if (!data || existsSync(out))
                    continue;

                put(announce, out, data);
                rewritten.push(rel);

                // (the mod's own texture, taken to another path: the mod updating it has to reach the copy, patchLife.ts)
                if (src.file || src.entry)
                    end.carried.set(rel, src);
            }

            if (w.copies.size)
                notes.push(tr('Tenet banners carried into {folder}: {list}', { folder: rule.banner!.to, list: shortList([...w.copies.keys()].map((rel) => rel.slice(rel.lastIndexOf('/') + 1))) }));

            if (w.lost.size)
                notes.push(trn('{n} tenet banner the mod names has no texture (with its _small variant) in {from} or {to}: not carried over (a family gets the game’s banner, a religion its family’s): {list}', '{n} tenet banners the mod names have no texture (with their _small variant) in {from} or {to}: not carried over (a family gets the game’s banners, a religion its family’s): {list}', w.lost.size, { from: w.from, to: rule.banner!.to, list: shortList([...w.lost]) }));

            if (written.length)
                notes.push(`${rule.label}: ${trn('{n} file', '{n} files', written.length)}`);

            return;
        }

        // (particle graph names, textures: the patch mod's copy of each file, written from the bytes the rules see now)
        if (rule.kind === 'particles' || rule.kind === 'ddsLegacy' || rule.kind === 'maskMips')
        {
            const w = rule.kind === 'particles' ? applyParticles(rc, todo, rule.compounds!) : rule.kind === 'ddsLegacy' ? applyDds(rc, todo) : applyMasks(rc, rule.folder!, todo);
            rewritten.push(...w.written);

            if (w.written.length)
                notes.push(`${rule.label}: ${trn('{n} file', '{n} files', w.written.length)}`, ...(rule.notes ?? []));

            return;
        }

        // (effect files: the game's with the mod's effects added; each against the patch mod's copy as a restore is)
        if (rule.kind === 'mergefx')
        {
            const w = shaderWorkOf(rc, rule);

            for (const rel of rule.files)
            {
                const f = w.files.get(rel)!;
                const action = shaderAction(rc, rel, f);

                if (action === 'kept')
                {
                    kept.push(rel);
                    continue;
                }

                // (written first: the record says what the copy is, a write that failed must not leave one for the new text)
                if (action !== 'same')
                {
                    const out = join(patch.root!, ...rel.split('/'));
                    put(announce, out, f.data);
                    rewritten.push(rel);
                }

                // (a file with the mod's effects in it has a record of its own; a plain copy of the game's file the restore's)
                if (f.carries)
                {
                    manifest.merged[rel] = { game: f.game, mod: w.mod, out: f.hash };
                    delete manifest.restored[rel];
                }
                else
                {
                    manifest.restored[rel] = f.hash;
                    delete manifest.merged[rel];
                }

                // (what the mod changed that stays the game's: kept whole, the notes may be a long list)
                if (f.notes.lost.length)
                    manifest.lost[rel] = f.notes.lost;
                else
                    delete manifest.lost[rel];

                if (action === 'same')
                    continue;

                if (action === 'refresh')
                    rewrittenShaders.push(rel);
            }

            // (what was added, left out and lost, from the work: the files written now or before)
            if (todo.length)
                notes.push(...shaderNotes(w));

            if (rewritten.length > wrote)
                notes.push(`${rule.label}: ${trn('{n} file', '{n} files', rewritten.length - wrote)}`);

            return;
        }

        for (const rel of rule.kind === 'restore' ? rule.files : rule.files.filter((f) => todo.includes(f)))
        {
            const out = join(patch.root!, ...rel.split('/'));

            if (rule.kind === 'restore')
            {
                const s = restoreAction(rc, rel);

                if (s.action === 'kept')
                {
                    kept.push(rel);
                    continue;
                }

                if (s.action === 'same')
                {
                    manifest.restored[rel] = s.hash;
                    continue;
                }

                // (the record after the write: one that failed must not claim the game's file)
                put(announce, out, readFileSync(gameFile(gameDir!, rel)!));
                manifest.restored[rel] = s.hash;
                rewritten.push(rel);

                if (s.action === 'refresh')
                    refreshed.push(rel);

                continue;
            }

            // (an empty file of the same path: the mod's copy no longer loads)
            if (rule.kind === 'empty')
            {
                const cut = rule.trim?.get(rel);
                put(announce, out, cut ? withoutEntries(readTextFile(gameFile(gameDir!, rel)!), cut) : '');
                rewritten.push(rel);
                notes.push(...(rule.notes ?? []).filter((n) => n.startsWith(rel + ':')));
                continue;
            }

            // (a database file's merge, the icons: done for the whole rule after the loop)
            if (rule.kind === 'merge' || rule.kind === 'icons' || rule.kind === 'defines')
                continue;

            // (the others change the patch mod's copy of the mod's file, made first, byte for byte)
            if (!existsSync(out))
            {
                const where = modFiles.get(rel);
                const data = where?.file ? readFileSync(where.file) : where?.entry && mod.archive ? zipEntry(mod.archive, where.entry) : undefined;

                if (!data)
                    continue;

                put(announce, out, data);
            }

            const raw = readTextFile(out);
            const bom = raw.startsWith('﻿');
            let text = bom ? raw.slice(1) : raw;

            if (rule.kind === 'settings' || rule.kind === 'rewrite')
            {
                let next = text;

                if (rule.kind === 'settings')
                {
                    // (from the end: earlier offsets stay right)
                    for (const s of missingSettings(settingsGame(gameDir!, rel, rule), text, rule.block!, rule.keys!, rule.own).sort((a, b) => b.at - a.at))
                        next = next.slice(0, s.at) + s.text.replace(/\n/g, text.includes('\r\n') ? '\r\n' : '\n') + next.slice(s.at);
                }
                else
                    next = text.replace(new RegExp(rule.find!, 'g'), rule.replace!);

                if (next !== text)
                {
                    put(announce, out, (bom ? '﻿' : '') + next);
                    rewritten.push(rel);
                    touched.push(out);
                }

                continue;
            }

            const sites = renameSites(text, rule.from!);

            if (!sites.length)
                continue;

            // (from the end: earlier offsets stay right; a block whose parameter nothing defines goes: it never applied,
            // and the new key with such a parameter crashes the game)
            // (read once, and only for a rule that asks: a rule without definedParameter must not leave an empty set for the next)
            if (rule.definedParameter)
                known ??= definedParameters(gameDir!, mod, patch.root!);

            for (const n of [...sites].sort((a, b) => b.s - a.s))
            {
                const p = blockParameter(n);

                // (a key the version dropped: the block goes, the result tells it)
                if (rule.drop)
                {
                    text = cutBlock(text, n);
                    gone.push(`${rel}: ${rule.from}`);
                }
                else if (rule.definedParameter && p && !known!.has(p))
                {
                    text = cutBlock(text, n);
                    dropped.push(`${rel}: ${rule.from} { parameter = ${p} }`);
                }
                else
                    text = text.slice(0, n.s) + rule.to! + text.slice(n.s + rule.from!.length);
            }

            put(announce, out, (bom ? '﻿' : '') + text);
            rewritten.push(rel);
            touched.push(out);
        }

        // (the merge: per folder one file of the patch mod named to load after the mod's (`zz_…`); written when it
        // differs from what is there)
        if (rule.kind === 'merge')
        {
            for (const [rel, o] of mergeOutputs(rule, rc))
            {
                const out = join(patch.root!, ...rel.split('/'));

                if (mergeDone(rc, rel, o.text))
                    continue;

                put(announce, out, o.text);
                rewritten.push(rel);
                touched.push(out);
            }
        }

        // (defines: one file of the patch mod named to load after every file of the folder, per namespace the keys the
        // game's versions add; written when it differs)
        if (rule.kind === 'defines')
        {
            const o = definesOutput(rule, rc);
            const out = join(patch.root!, ...o.rel.split('/'));

            put(announce, out, o.text);
            rewritten.push(o.rel);
            notes.push(...(rule.notes ?? []));
        }

        // (icons: the definitions (the patch mod's too, the fixes moved tenets there) renamed in the patch mod's copy;
        // the mod's icons copied into the new folder)
        if (rule.kind === 'icons')
        {
            const w = iconWork(mod, modFiles, gameDir!, rule.icon!, patch.root!);

            for (const [rel, edits] of w.renames)
            {
                const out = join(patch.root!, ...rel.split('/'));

                if (!existsSync(out))
                {
                    const where = modFiles.get(rel);
                    const data = where?.file ? readFileSync(where.file) : where?.entry && mod.archive ? zipEntry(mod.archive, where.entry) : undefined;

                    if (!data)
                        continue;

                    put(announce, out, data);
                }

                const raw = readTextFile(out);
                const bom = raw.startsWith('﻿');
                let text = bom ? raw.slice(1) : raw;

                // (from the end: earlier offsets stay right)
                for (const x of [...edits].sort((a, b) => b.s - a.s))
                    text = text.slice(0, x.s) + `icon = ${x.name}` + text.slice(x.e);

                put(announce, out, (bom ? '﻿' : '') + text);
                rewritten.push(rel);
                touched.push(out);
            }

            for (const [rel, src] of w.copies)
            {
                const out = join(patch.root!, ...rel.split('/'));
                const data = src.file ? readFileSync(src.file) : src.game ? readFileSync(src.game) : src.entry && mod.archive ? zipEntry(mod.archive, src.entry) : undefined;

                if (!data || existsSync(out))
                    continue;

                put(announce, out, data);
                rewritten.push(rel);

                // (the mod's own texture, taken to another path: the mod updating it has to reach the copy, patchLife.ts)
                if (src.file || src.entry)
                    end.carried.set(rel, src);
            }
        }

        if (rewritten.length > wrote)
            notes.push(`${rule.label}: ${trn('{n} file', '{n} files', rewritten.length - wrote)}`);
    };

    // (Cancel is looked at between the rules: what was written stays, a second run goes on; each rule is idempotent)
    const stopped = (message: () => string): void =>
    {
        if (run.cancelled?.())
            throw new MigrationCancelled(message());
    };

    for (const [at, rule] of allRules.entries())
    {
        stopped(() => tr('Cancelled after {n} of {total} rules — what was written stays in the patch mod; running it again goes on where it stopped', { n: at, total: allRules.length }));

        try
        {
            await applyRule(rule, at);
        }
        catch (e)
        {
            failed.push({ name: rule.label, why: e instanceof Error ? e.message : String(e) });
        }
    }

    // 6. the interface the game's windows use: types the mod's older copies lack, files nothing uses any more, against the
    // files as the rules above left them (the index takes them in first: a restored window brings its types back)
    const interfaceStep = async (): Promise<void> =>
    {
        report({ stage: tr('Looking for interface types the mod’s older files lack…'), done: 0, total: 0 });
        const abs = [...new Set(rewritten)].map((rel) => join(patch.root!, ...rel.split('/')));

        if (abs.length)
            await refresh(abs);

        const gui = await guiPlan(host, mod, folder, patch, guiConfig(steps, allRules), guiCalls(steps, gameDir!, script), scriptTexts(mod));

        const guiWrite = gui ? guiTodo(gui, patch.root) : [];

        for (const o of guiWrite)
        {
            const out = join(patch.root!, ...o.rel.split('/'));

            // (the types file of an older run that nothing carries now: deleted)
            if (o.remove)
            {
                deleteFiles(patch.root!, [o.rel], announce);
                touched.push(out);
                continue;
            }

            put(announce, out, o.text);
            rewritten.push(o.rel);
            touched.push(out);
        }

        if (gui)
            notes.push(...guiNotes(gui, guiWrite));
    };

    // (a step that fails is told in the result like a rule: the next one still runs, the manifest keeps what was done)
    const guarded = async (name: string, step: () => Promise<void>): Promise<void> =>
    {
        try
        {
            await step();
        }
        catch (e)
        {
            failed.push({ name, why: e instanceof Error ? e.message : String(e) });
        }
    };

    if (gameDir && steps.some((m) => m.dataCalls?.length || m.restore?.length))
    {
        stopped(() => tr('Cancelled before the interface step — what was written stays in the patch mod; running it again goes on where it stopped'));
        await guarded(tr('Interface types'), interfaceStep);
    }

    // 7. the definitions the game version added to files the mod replaces, that loaded files still use: last, against
    // the files as the rules above left them (the index takes them in first: a renamed call, a merged rule, a restored
    // file name what the mod's own files did not)
    // (per folder the line of its entries that the step's last pass to write the folder gave: the step can run more than once, step 8)
    const libraryLines = new Map<string, string>();
    const librariesStep = async (): Promise<void> =>
    {
        report({ stage: tr('Looking for definitions the mod’s older files hide…'), done: 0, total: 0 });
        const abs = [...new Set(rewritten)].map((rel) => join(patch.root!, ...rel.split('/')));

        if (abs.length)
            await refresh(abs);

        const lib = await libraryPlan(host, mod, steps, folder, patch, [], undefined, inertOptions(allRules, folder, patch.root, manifest, end.before, world.renamed?.aliases));

        const wrote = new Set<string>();

        const gone: string[] = [];

        for (const o of lib ? libraryTodo(lib.outputs, patch.root) : [])
        {
            const out = join(patch.root!, ...o.rel.split('/'));

            // (an older run's file the rule does not produce any more: deleted, with the folder if nothing else is in it)
            if (o.remove)
            {
                deleteFiles(patch.root!, [o.rel], announce);
                touched.push(out);
                gone.push(o.rel);
                continue;
            }

            put(announce, out, o.text);
            rewritten.push(o.rel);
            touched.push(out);
            wrote.add(o.folder);
        }

        for (const f of lib?.work.folders ?? [])
            if (wrote.has(f.folder) && f.entries.length)
            {
                notes.push(`${f.label}: ${trn('{n} entry', '{n} entries', f.entries.length)}`);
                libraryLines.set(f.folder, notes[notes.length - 1]);
            }

        notes.push(...(lib ? [...workNotes(lib.work), ...(lib.work.inert ? inertNotes(lib.work.inert) : [])] : []));

        if (gone.length)
            notes.push(removedLibraryNote(gone));

        if (lib?.left.length)
            notes.push(leftLibraryNote(lib.left));

        // (the game files the overrides come from: a game update that changes one leaves the override masking the new text)
        if (lib)
        {
            const modHash = modFileHash(mod, modFiles);
            const record = lib.work.inert ? inertRecord(lib.work.inert, (rel) => gameFile(gameDir!, rel), manifest.inert?.names, modHash.hash, manifest.inert, (rel) => existsSync(join(patch.root!, ...rel.split('/')))) : undefined;
            modHash.close();

            if (record)
                manifest.inert = record;
            else
                delete manifest.inert;
        }
    };

    // 8. the texts the game version added to localization files the mod replaces, that loaded files use: after the libraries step,
    // whose files name some of them (read from the patch mod on disk); one file per language, an older run's file nothing needs goes
    const textRules = steps.flatMap((m) => m.texts ?? []);
    // (what the step's passes wrote and deleted, and its last work: told once, after the last pass)
    const texts = { written: new Set<string>(), deleted: new Set<string>(), work: undefined as TextsWork | undefined };
    const textsStep = async (): Promise<void> =>
    {
        report({ stage: tr('Looking for texts the mod’s older localization files hide…'), done: 0, total: 0 });
        const w = textsWork(textsInput({ mod, modFiles, gameDir: gameDir!, patchRoot: patch.root, others: world.others }, folder, patch, textRules.flatMap((r) => r.files), [], world.renamed?.aliases));
        texts.work = w;

        for (const o of w.outputs.values())
        {
            if (textsDone(patch.root, o))
                continue;

            const out = join(patch.root!, ...o.rel.split('/'));
            put(announce, out, o.text);
            rewritten.push(o.rel);
            touched.push(out);
            texts.written.add(o.rel);
        }

        if (w.stale.length)
        {
            deleteFiles(patch.root!, w.stale, announce);
            touched.push(...w.stale.map((rel) => join(patch.root!, ...rel.split('/'))));
            w.stale.forEach((rel) => texts.deleted.add(rel));
        }
    };

    // (a text the texts step brings back can call a library entry the loaded files lack, a custom localization of the game's file the
    // mod hides (`[GovernmentType.Custom('GetGovernmentTypeIcon')]`): while the texts step writes, the libraries step runs again against
    // the files as it left them, then the texts step (what a carried entry names), at most three rounds; a run after it writes nothing.
    // The libraries step tells the notes of its first pass, a later pass only the lines of the folders it wrote again (it reads the files
    // the first pass changed: its other notes would tell less); the texts step what all its passes did)
    let libraryNotes: string[] | undefined;
    const pass = async (which: 'libraries' | 'texts'): Promise<boolean> =>
    {
        const mark = notes.length;
        const wrote = touched.length;
        const lines = new Map(libraryLines);

        if (which === 'libraries')
        {
            stopped(() => tr('Cancelled before the definitions step — what was written stays in the patch mod; running it again goes on where it stopped'));
            await guarded(tr('Definitions the mod’s older files hide'), librariesStep);
        }
        else
        {
            stopped(() => tr('Cancelled before the texts step — what was written stays in the patch mod; running it again goes on where it stopped'));
            await guarded(tr('Texts the mod’s older files hide'), textsStep);
        }

        const added = notes.splice(mark);

        if (which === 'texts')
            notes.push(...added);
        else if (!libraryNotes)
            libraryNotes = added;
        else
        {
            const kept = libraryNotes;

            // (a folder the pass wrote again: its line instead of the earlier pass's)
            for (const [f, line] of libraryLines)
                if (lines.get(f) !== line)
                {
                    const at = lines.has(f) ? kept.indexOf(lines.get(f)!) : -1;

                    if (at >= 0)
                        kept[at] = line;
                    else
                        kept.unshift(line);
                }
        }

        return touched.length > wrote;
    };
    const libraryRun = !!gameDir && steps.some((m) => m.libraries);

    if (libraryRun)
        await pass('libraries');

    // (the texts step's notes go after the libraries step's)
    const textsMark = notes.length;

    for (let round = 0; gameDir && textRules.length && round < 3; round++)
        if (!(await pass('texts')) || !libraryRun || !(await pass('libraries')))
            break;

    notes.splice(textsMark, 0, ...(libraryNotes ?? []));

    if (texts.deleted.size)
        notes.push(trn('{n} file of texts an older run wrote is not needed any more (no copy lacks a key loaded files use): deleted ({list})', '{n} files of texts an older run wrote are not needed any more (no copy lacks a key loaded files use): deleted ({list})', texts.deleted.size, { list: shortList([...texts.deleted]) }));

    if (texts.written.size && texts.work)
        notes.push(`${textRules[0].label}: ${trn('{n} file', '{n} files', texts.written.size)}`, ...textsNotes(texts.work));

    // (the statements no rule could map: in all the mod's files, not only the ones a rule wrote)
    const unmapped = gameDir ? unmappedStatements(rc, steps.flatMap((m) => m.statements ?? [])) : [];

    if (unmapped.length)
        notes.push(trn('{n} statement the game version changed stays as written (its value cannot be mapped): {list}', '{n} statements the game version changed stay as written (their values cannot be mapped): {list}', unmapped.length, { list: shortList(unmapped) }));

    // (and the defines the mod's files read that no loaded defines file defines, as the files are now)
    if (gameDir)
        notes.push(...undefinedDefines(rc, steps));

    if (refreshed.length)
        notes.push(tr('The game changed {n} of its files the patch mod carries since it took them — copied again: {list}', { n: refreshed.length, list: shortList(refreshed) }));

    if (rewrittenShaders.length)
        notes.push(trn('{n} shader file the patch mod carries was written again (the game’s or the mod’s files changed since, or it was the plain game file): {list}', '{n} shader files the patch mod carries were written again (the game’s or the mod’s files changed since, or they were the plain game files): {list}', rewrittenShaders.length, { list: shortList(rewrittenShaders) }));

    if (kept.length)
        notes.push(tr('{n} of the game’s files in the patch mod were changed by hand since it took them — kept (delete one to take the game’s again): {list}', { n: kept.length, list: shortList(kept) }));

    // (the game version this run was made for, written with the hashes of the game files the patch mod carries and the files
    // it left, by `finishRun`, which also takes the written files into the index)
    // (a run with a failed rule did not bring it up to the game)
    end.game = failed.length ? undefined : state.gameVersion;
    // (the files the rules write by name: a later run deletes the ones no rule writes any more)
    manifest.generated = allRules.flatMap((r) => (r.kind === 'merge' ? [...new Set(r.files.map((rel) => mergeFile(rel.slice(0, rel.lastIndexOf('/')), folder)))] : r.kind === 'defines' ? [definesFile(r.folder!, folder)] : r.kind === 'renamed' ? [...r.renamed!.outputs.keys()] : []));

    if (gone.length)
    {
        const count = new Map<string, number>();

        for (const g of gone)
            count.set(g, (count.get(g) ?? 0) + 1);

        notes.push(tr('Left out (the game version has no such key any more): {list}', { list: [...count].map(([g, n]) => (n > 1 ? `${g} (${n}×)` : g)).join('; ') }));
    }

    if (dropped.length)
        notes.push(tr('Left out (their parameter is defined nowhere — they never applied, and the game version crashes on them): {list}', { list: dropped.join('; ') }));

    // (a file several rules changed counts once)
    return { patch: { id: patch.id, name: patch.name, folder }, list: listName, copied, fixed, failed, notes, hidden, rewritten: [...new Set(rewritten)] };
}
