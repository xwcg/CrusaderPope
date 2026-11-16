/** What the GUI tab shows (docs/gui-designer.md): the library's definitions as plain data, their uses resolved against the index. */
import type { GameIndex } from '../indexer/gameIndex.ts';
import type { GuiDefView, GuiDetail, GuiItem, GuiKind, GuiUse } from '../../shared/api.ts';
import type { GuiEntry, GuiLibrary } from './library.ts';

const MAX_USED_BY = 300;

export function guiItem(e: GuiEntry): GuiItem
{
    const i: GuiItem = { kind: e.kind, name: e.name, base: e.base, file: e.file.rel, line: e.line };

    if (e.group)
        i.group = e.group;

    if (e.local)
        i.local = true;

    if (e.file.mod)
        i.mod = e.file.mod;

    return i;
}

export function guiList(lib: GuiLibrary): GuiItem[]
{
    return lib.entries().map(guiItem);
}

/** A name written in script: the window, else the widget, type or template of that name. */
export function guiFind(lib: GuiLibrary, name: string): GuiItem | undefined
{
    for (const k of ['window', 'root', 'type', 'template'] as const)
    {
        const e = lib.defs(k, name)[0];

        if (e)
            return guiItem(e);
    }

    return undefined;
}

/** A definition's uses: one row per name and kind, linked where the name has a target. */
function usesOf(lib: GuiLibrary, idx: GameIndex, e: GuiEntry): GuiUse[]
{
    const rows = new Map<string, GuiUse>();

    for (const r of lib.refsOf(e))
    {
        const k = r.kind + ':' + r.name;
        const hit = rows.get(k);

        if (hit)
        {
            hit.count++;
            continue;
        }

        const u: GuiUse = { kind: r.kind, name: r.name, count: 1, line: r.line };

        if (r.kind === 'template' || r.kind === 'type')
        {
            if (lib.defs(r.kind, r.name).length)
                u.gui = { kind: r.kind, name: r.name };
        }
        else if (r.kind === 'texture')
        {
            const img = idx.imageAt(r.name);

            if (img)
                u.entry = { type: img.type, name: img.name };
        }
        else if (r.kind === 'scriptedGui')
        {
            if (idx.get('scripted_guis', r.name))
                u.entry = { type: 'scripted_guis', name: r.name };
        }
        else if (r.kind === 'text')
        {
            // (a literal text, `text = "Cancel"`, is no key)
            if (idx.locRaw(r.name) !== undefined)
            {
                u.entry = { type: 'localization', name: r.name };
                u.text = idx.plainLoc(r.name)?.slice(0, 160);
            }
        }

        rows.set(k, u);
    }

    return [...rows.values()];
}

export function guiDetail(lib: GuiLibrary, idx: GameIndex, kind: GuiKind, name: string): GuiDetail | null
{
    const entries = lib.defs(kind, name);

    if (!entries.length)
        return null;

    const defs = entries.map((e): GuiDefView =>
    {
        const text = lib.source(e);
        return { item: guiItem(e), text, endLine: e.line + text.split('\n').length - 1, where: e.file.where, uses: usesOf(lib, idx, e) };
    });
    // (only types and templates are used by name)
    const list = kind === 'type' || kind === 'template' ? lib.usedBy(kind, name).filter((u) => !entries.includes(u)) : [];
    return { kind, name, defs, usedBy: list.slice(0, MAX_USED_BY).map(guiItem), usedByCount: list.length };
}
