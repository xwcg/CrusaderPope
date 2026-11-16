/**
 * The interface rules on the main side (guiWork.ts finds the work in the index worker): the types the game's windows use
 * that the mod's older copies lack, the files nothing uses once the game's own are restored, and the restores the dialog
 * offers. One file of the patch mod holds the types (`gui/zz_<patch folder>_types.gui`); an orphan is emptied like a file the
 * game version removed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationPlan, ModInfo } from '../../shared/api.ts';
import { tr, trn } from '../../shared/i18n.ts';
import { applyCallEdits, dataCallEdits, type DataCallEnv, type DataCallGroup } from './dataCalls.ts';
import type { GuiConfig, GuiWork } from './guiWork.ts';
import { interfaceLossNotes, type ScriptText } from './lostInterface.ts';
import type { ModsHost } from './manager.ts';
import { readTextFile } from './textCodec.ts';

const BOM = '﻿';

/** What the interface rules do for a run, from the loaded files. */
export interface GuiPlan
{
    work: GuiWork;
    typesRel: string;
    /** the text of the types file (undefined: nothing to write, none carried) */
    typesText?: string;
    /** the types file of an older run, which nothing carries now and which the tool wrote: deleted */
    typesRemove?: boolean;
    /** the mod's files nothing live uses: emptied in the patch mod */
    orphans: string[];
    /** the plan's entries and what the plan adds */
    entries: NonNullable<MigrationPlan['rewrites']>;
    optional: NonNullable<MigrationPlan['optional']>;
    notes: string[];
}

/** The file of the patch mod that holds the types. */
export const typesFile = (patchFolder: string): string => `gui/zz_${patchFolder}_types.gui`;

/** A file of the patch mod as it is; undefined when missing. */
function patchFile(patchRoot: string | undefined, rel: string): string | undefined
{
    const file = patchRoot ? join(patchRoot, ...rel.split('/')) : undefined;
    return file && existsSync(file) ? readTextFile(file) : undefined;
}

const shortList = (list: string[], n = 6): string => (list.length > n ? list.slice(0, n).join(', ') + ', …' : list.join(', '));

/** Whether the types file's text is one the tool wrote: its first line ends with "Written by CrusaderPope." or is the stub older runs left ("Nothing to carry over (any more)…", in the app's language of that run). */
const writtenByTool = (text: string): boolean =>
{
    const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0].trim();
    return /Written by CrusaderPope\.$/.test(first) || first.startsWith('# Nothing to carry over (any more)') || first === tr('# Nothing to carry over (any more): every type the game’s windows use is defined by a loaded file.');
};

/** Whether the patch mod holds an emptied copy of the file (it exists and is blank). */
export const emptied = (patchRoot: string | undefined, rel: string): boolean =>
{
    const text = patchFile(patchRoot, rel);
    return text !== undefined && !text.replace(/^﻿/, '').trim();
};

/**
 * The interface work for a mod and its patch mod: asks the index worker (the loaded files are its), then makes the plan's
 * entries. `restore` / `empty`: the interface files the other rules take whole / empty.
 */
export async function guiPlan(host: ModsHost, mod: ModInfo, patchFolder: string, patch: ModInfo | undefined, cfg: Omit<GuiConfig, 'typesRel'>, calls?: { groups: DataCallGroup[]; env: DataCallEnv; }, script?: { actions: ScriptText[]; guis: ScriptText[]; }): Promise<GuiPlan | undefined>
{
    const typesRel = typesFile(patchFolder);
    const work = await host.query!<GuiWork | null>('migrationGui', { ...cfg, typesRel }, mod.id, patch?.id);

    if (!work)
        return undefined;

    const existing = patchFile(patch?.root, typesRel);
    // (a definition carried with the mod's old body goes through the data call rules like the mod's other interface text: the types
    // the game's files give are the 1.20 text, which the rules leave as it is)
    const carried = calls && work.types.text ? carriedCalls(work.types.text, typesRel, calls.groups, calls.env) : undefined;
    const typesText = (carried?.text ?? work.types.text) || undefined;
    // (the file of an older run that holds nothing now: deleted when the tool wrote it (its header, or the stub older runs left),
    // kept and told when it was changed by hand)
    const leftover = typesText === undefined && existing !== undefined;
    const typesRemove = leftover && writtenByTool(existing);
    const entries: GuiPlan['entries'] = [];
    const notes: string[] = [];

    if (typesRemove)
        entries.push({ kind: 'guiTypes', label: tr('Interface types an older run carried over that are not needed any more'), files: [typesRel], todo: [typesRel] });

    if (leftover && !typesRemove)
        notes.push(tr('{file} holds types an older run carried over, which every loaded file defines now, but it was changed by hand — kept (delete it if you do not need it)', { file: typesRel }));

    if (typesText !== undefined && work.types.defs.length)
    {
        const defNotes = work.types.defs.map((d) => (d.aliasOf ? tr('{name} is {to} in the game’s {file}: an alias to the game’s definition, used by {by}', { name: d.name, to: d.aliasOf, file: d.file, by: d.by }) : d.fromMod ? tr('{name} ({kind}) from the mod’s copy of {file}, line {line} (the patch mod hides that copy), used by {by}', { name: d.name, kind: d.kind, file: d.file, line: d.line, by: d.by }) : tr('{name} ({kind}) from the game’s {file}, line {line}, used by {by}', { name: d.name, kind: d.kind, file: d.file, line: d.line, by: d.by })) + (d.inlined ? '; ' + inlinedNote(d.name, d.inlined) : ''));
        entries.push({
            kind: 'guiTypes',
            label: tr('Interface types: the game’s windows use types and templates the mod’s older copies of shared interface files lack — added from the game’s files'),
            files: [typesRel],
            todo: existing === typesText ? [] : [typesRel],
            notes: [...defNotes, ...work.types.skipped, ...(carried?.left ?? [])]
        });
    }

    // (the roots the game's code looks up by name that the mod's copy of a file lacks: appended to the patch mod's copy of it)
    if (work.roots.length)
    {
        entries.push({
            kind: 'guiTypes',
            label: tr('Interface root widgets: the game’s code looks up these widgets by name in the file, and the mod’s copy of it lacks them — added from the game’s file'),
            files: work.roots.map((r) => r.rel),
            todo: work.roots.filter((r) => patchFile(patch?.root, r.rel) !== r.text).map((r) => r.rel),
            notes: work.roots.map((r) => tr('{file}: {list} (the game’s file, lines {lines}) — the game’s code looks these widgets up by name; the mod’s copy lacks them', { file: r.rel, list: shortList(r.roots.map((x) => x.name), 8), lines: shortList(r.roots.map((x) => String(x.line)), 8) }))
        });
    }

    if (work.orphans.length)
    {
        entries.push({
            kind: 'empty',
            label: tr('Interface files that only the game’s own windows (restored in the patch mod) used: emptied'),
            files: work.orphans.map((o) => o.rel),
            todo: work.orphans.filter((o) => !emptied(patch?.root, o.rel)).map((o) => o.rel),
            notes: work.orphans.map((o) => tr('{file}: {n} definitions, nothing that loads uses them any more (the mod’s copy of {by} did)', { file: o.rel, n: o.defs, by: shortList(o.by, 4) || tr('a game file') }))
        });
    }

    const optional: GuiPlan['optional'] = work.offers.map((o) => ({
        rel: o.rel,
        names: o.names,
        custom: o.custom,
        orphans: o.orphans,
        takes: o.takes,
        // (why besides the names: what the file uses that the restored files no longer give, the hooks its game version declares)
        reasons: [
            ...(o.lost.length ? [tr('uses {list}, which the mod’s copy of a game file defined and the game’s file in the patch mod does not', { list: shortList(o.lost, 5) })] : []),
            ...(o.hooks.length ? [trn('the game’s version declares the hook {list}, which loaded files override and this copy lacks', 'the game’s version declares the hooks {list}, which loaded files override and this copy lacks', o.hooks.length, { list: shortList(o.hooks, 5) })] : [])
        ]
    }));

    // (the mod's script that leads to the interface the restores and the emptying took away)
    if (script)
        notes.push(...interfaceLossNotes(work.orphans, script.actions, script.guis));

    for (const f of work.ownUnknown.slice(0, 10))
        notes.push(trn('{file}: {n} name the game does not know (the mod’s own data, or removed): {list}', '{file}: {n} names the game does not know (the mod’s own data, or removed): {list}', f.names.length, { file: f.rel, list: shortList(f.names, 8) }));

    // (what the restores took away that loaded files use; the hooks the mod's older copies lack)
    for (const l of work.lost)
        for (const u of l.users)
            notes.push(tr('{file}: line {lines} uses {name}, which the mod’s copy of {from} defined and the game’s file in the patch mod does not — the engine will report an unknown type', { file: u.rel, lines: u.lines.join(', '), name: l.name, from: l.from }));

    for (const h of work.hooks)
        notes.push(trn('{file}: the game’s version declares the hook {list}, which loaded files override ({users}) and the mod’s copy lacks — the override lands on nothing', '{file}: the game’s version declares the hooks {list}, which loaded files override ({users}) and the mod’s copy lacks — the overrides land on nothing', h.names.length, { file: h.file, list: shortList(h.names, 6), users: shortList(h.users, 4) }));

    return { work, typesRel, typesText, typesRemove, orphans: work.orphans.map((o) => o.rel), entries, optional, notes };
}

/**
 * The text of the types file after the interface data call rules (migrations.ts `dataCalls`, the groups for .gui files), one group
 * after the other; `left`: the sites a rule names but cannot map, told with the file.
 */
export function carriedCalls(text: string, rel: string, groups: DataCallGroup[], env: DataCallEnv): { text: string; left: string[]; }
{
    const bom = text.startsWith(BOM);
    let cur = bom ? text.slice(1) : text;
    const left: string[] = [];

    for (const g of groups.filter((x) => x.files.some((p) => /\.gui$/i.test(p))))
    {
        const r = dataCallEdits(cur, rel, g, env);
        cur = applyCallEdits(cur, r.edits);
        left.push(...r.left.map((l) => `${rel}: ${l}`));
    }

    return { text: (bom ? BOM : '') + cur, left: [...new Set(left)] };
}

/** A type written with the game's base inlined: what it replaces. */
const inlinedNote = (name: string, i: { base: string; hooks: string[]; dropped?: string[]; }): string =>
    trn('the mod’s older {base} lacks the hook {list} that {name} overrides: written with the game’s {base} body', 'the mod’s older {base} lacks the hooks {list} that {name} overrides: written with the game’s {base} body', i.hooks.length, { base: i.base, list: shortList(i.hooks, 5), name })
    + (i.dropped?.length ? ', ' + trn('without {n} widget that names an entry no loaded file defines (the game logs each lookup): {list}', 'without {n} widgets that name entries no loaded file defines (the game logs each lookup): {list}', i.dropped.length, { list: shortList(i.dropped, 5) }) : '');

/** The files of a gui plan the patch mod does not hold as they would be written: [rel, text] (an orphan: emptied). */
export function guiTodo(p: GuiPlan, patchRoot: string | undefined): { rel: string; text: string; remove?: boolean; }[]
{
    const out: { rel: string; text: string; remove?: boolean; }[] = [];

    if (p.typesRemove)
        out.push({ rel: p.typesRel, text: '', remove: true });

    for (const r of p.work.roots)
        if (patchFile(patchRoot, r.rel) !== r.text)
            out.push({ rel: r.rel, text: r.text });

    if (p.typesText !== undefined && patchFile(patchRoot, p.typesRel) !== p.typesText)
        out.push({ rel: p.typesRel, text: p.typesText });

    for (const rel of p.orphans)
        if (!emptied(patchRoot, rel))
            out.push({ rel, text: '' });

    return out;
}

/** What a run tells of the interface work it did (`todo`: the files it wrote) and found. */
export function guiNotes(p: GuiPlan, todo: { rel: string; text: string; remove?: boolean; }[]): string[]
{
    const notes: string[] = [];

    if (todo.some((t) => t.remove && t.rel === p.typesRel))
        notes.push(tr('{file} is deleted: every type the game’s windows use is defined by a loaded file now', { file: p.typesRel }));
    const wroteTypes = todo.some((t) => t.rel === p.typesRel);

    for (const r of p.work.roots.filter((x) => todo.some((t) => t.rel === x.rel)))
        notes.push(trn('{file}: {n} root widget the game’s code looks up by name was added from the game’s file: {list}', '{file}: {n} root widgets the game’s code looks up by name were added from the game’s file: {list}', r.roots.length, { file: r.rel, list: shortList(r.roots.map((x) => x.name), 8) }));

    if (wroteTypes && p.work.types.defs.length)
        notes.push(trn('{n} type or template the game’s windows use was added from the game’s files ({file}): {list}', '{n} types and templates the game’s windows use were added from the game’s files ({file}): {list}', p.work.types.defs.length, { file: p.typesRel, list: shortList(p.work.types.defs.map((d) => d.name), 12) }));

    if (wroteTypes)
        for (const d of p.work.types.defs)
            if (d.inlined)
                notes.push(d.name + ': ' + inlinedNote(d.name, d.inlined));

    notes.push(...p.work.types.skipped);

    for (const o of p.work.orphans.filter((x) => todo.some((t) => t.rel === x.rel)))
        notes.push(tr('{file} is emptied in the patch mod: its {n} definitions were used by {by}, which the patch mod replaces with the game’s file', { file: o.rel, n: o.defs, by: shortList(o.by, 4) || tr('a game file') }));

    return [...notes, ...p.notes];
}
