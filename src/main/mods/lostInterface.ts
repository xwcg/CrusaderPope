/**
 * What the interface rules take away that the mod's script still leads to (docs/mods.md, the interface rules): a window the patch mod
 * restores as the game's file loses what the mod's copy of it added (a tab, its types), and the file of types only that copy used
 * is emptied. The mod's important actions (`open_view_data = { view = faith }`) still open the window, and its scripted GUIs
 * (`GetScriptedGui('x')` in the emptied types) still run, but the interface they were written for is not there. Nothing can be
 * ported by a rule (the new window has another structure), so the plan and the result name what leads nowhere.
 */
import { trn } from '../../shared/i18n.ts';
import { parse } from '../indexer/parser.ts';
import type { GuiOrphan } from './guiWork.ts';

/** A script file of the mod (`common/important_actions/x.txt`, `common/scripted_guis/x.txt`). */
export interface ScriptText
{
    rel: string;
    text: string;
}

const shortList = (list: string[], n: number): string => (list.length > n ? list.slice(0, n).join(', ') + ', …' : list.join(', '));

/** The view a window file shows: `gui/window_faith.gui` is `faith`. */
const viewOf = (rel: string): string | undefined => /^gui\/window_(\w+)\.gui$/i.exec(rel)?.[1].toLowerCase();

/** The top-level entries of the script files and the views each one opens (`view = x`, `open_view = x`). */
function viewOpeners(files: ScriptText[]): Map<string, { name: string; rel: string; }[]>
{
    const out = new Map<string, { name: string; rel: string; }[]>();

    for (const f of files)
    {
        for (const n of parse(f.text))
        {
            if (!n.k || !Array.isArray(n.v))
                continue;

            const text = f.text.slice(n.s, n.e);
            const views = new Set([...text.matchAll(/\bview\s*=\s*"?(\w+)/g), ...text.matchAll(/\bopen_view\s*=\s*"?(\w+)/g)].map((m) => m[1].toLowerCase()));

            for (const v of views)
                out.set(v, [...(out.get(v) ?? []), { name: n.k, rel: f.rel }]);
        }
    }

    return out;
}

/**
 * The notes for the emptied interface files (`orphans`) that the mod's script leads to: its important actions that open the window a
 * restore replaced (the file's definitions were that window's tabs and types), and the scripted GUIs the emptied file's types call.
 */
export function interfaceLossNotes(orphans: GuiOrphan[], actions: ScriptText[], guis: ScriptText[]): string[]
{
    if (!orphans.length)
        return [];

    const notes: string[] = [];
    const openers = viewOpeners(actions);
    const defined = new Set(guis.flatMap((f) => parse(f.text).map((n) => n.k).filter((k): k is string => !!k)));
    const byView = new Map<string, { names: Set<string>; files: Set<string>; }>();

    for (const o of orphans)
    {
        for (const by of o.by)
        {
            const view = viewOf(by);

            if (!view || !openers.has(view))
                continue;

            const w = byView.get(view) ?? byView.set(view, { names: new Set(), files: new Set() }).get(view)!;
            o.names.forEach((n) => w.names.add(n));
            w.files.add(o.rel);
        }
    }

    for (const [view, w] of [...byView].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    {
        const who = openers.get(view)!;
        const names = [...new Set(who.map((x) => x.name))];
        notes.push(trn(
            'The important action {list} opens the {view} window, whose interface the mod added ({defs}, in {files}) the patch mod no longer carries: the window is the game’s file, and the mod’s additions to it — a tab, its types — are not in it. They have to be written again for the 1.20 window',
            'The important actions {list} open the {view} window, whose interface the mod added ({defs}, in {files}) the patch mod no longer carries: the window is the game’s file, and the mod’s additions to it — a tab, its types — are not in it. They have to be written again for the 1.20 window',
            names.length,
            { list: shortList(names, 5), view, defs: shortList([...w.names], 6), files: [...w.files].join(', ') }
        ));
    }

    for (const o of orphans)
    {
        const guisHere = o.scripted.filter((s) => defined.has(s));

        if (guisHere.length)
            notes.push(trn(
                '{file} is emptied, and the scripted GUI {list} of the mod, which its types called, has no interface in the patch mod any more',
                '{file} is emptied, and the scripted GUIs {list} of the mod, which its types called, have no interface in the patch mod any more',
                guisHere.length,
                { file: o.rel, list: shortList(guisHere, 6) }
            ));
    }

    return notes;
}
