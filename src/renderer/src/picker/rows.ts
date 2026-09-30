/**
 * The rows a picker menu shows for the typed filter, their mnemonics and the row selected when it opens (docs/picker.md,
 * "Mechanics"). Plain TypeScript (no React): Picker.tsx renders them, scripts/picker-check.ts checks them.
 */
import type { Item, Menu } from './model.ts';

export interface Row
{
    item: Item;
    key?: string;
}

/** rows rendered at most (type to filter the rest) */
export const MAX_ROWS = 100;

/** Mnemonics: an item's own key when still free, else the first free initial of its words, then any letter. */
export function assignKeys(items: Item[]): Map<Item, string>
{
    const used = new Set<string>();
    const out = new Map<Item, string>();

    for (const i of items)
        if (i.key && !i.role && !i.explicit && !used.has(i.key))
        {
            used.add(i.key);
            out.set(i, i.key);
        }

    for (const i of items)
    {
        if (out.has(i) || i.role || i.explicit)
            continue;

        const l = i.label.toLowerCase();
        const cands = [
            ...l.split(/[^a-z0-9]+/)
                .filter(Boolean)
                .map((w) => w[0]),
            ...l.replace(/[^a-z0-9]/g, '')
        ];
        const k = cands.find((c) => !used.has(c));

        if (k)
        {
            used.add(k);
            out.set(i, k);
        }
    }

    return out;
}

/**
 * Rows of a menu for the typed filter: typed number / value rows, matching items (best first), search results. Rows
 * chosen only on purpose (`Item.explicit`: "＋ New trait…") come last, after the cap too.
 */
export function rowsOf(menu: Menu, filter: string, found: Item[] | undefined): Row[]
{
    // (while typing, letters go to the filter: no row keys shown)
    const keys = menu.typeahead || filter ? new Map<Item, string>() : assignKeys(menu.items);
    const f = filter.trim();

    if (!f)
    {
        // (rows listed only while filtering stay out)
        const shown = menu.items.filter((item) => !item.filtered && !item.explicit);
        const last = menu.items.filter((item) => !item.filtered && item.explicit).map((item) => ({ item }));
        return [...capped(shown.slice(0, MAX_ROWS + 1).map((item) => ({ item, key: keys.get(item) })), shown.length), ...last];
    }

    const rows: Row[] = [];
    const numeric = /^-?\d+(\.\d+)?$/.test(f);

    if (numeric && menu.number)
    {
        for (const item of menu.number(parseFloat(f), f))
            rows.push({ item });
    }

    const lower = f.toLowerCase();
    const terms = lower.split(/\s+/);
    const scored: { item: Item; score: number; }[] = [];
    const last: Row[] = [];

    for (const item of menu.items)
    {
        if (item.role === 'info' || item.unfiltered)
            continue;

        const label = item.label.toLowerCase();
        const extra = item.hint || item.match ? `${item.hint ?? ''} ${item.match ?? ''}`.toLowerCase() : '';

        if (!terms.every((t) => label.includes(t) || extra.includes(t)))
            continue;

        if (item.explicit)
        {
            last.push({ item });
            continue;
        }

        const score = label === lower || (item.match ?? '').toLowerCase() === lower ? 0 : label.startsWith(terms[0]) ? 1 : extra.split(/\s+/).some((w) => w.startsWith(terms[0])) ? 2 : 3;
        scored.push({ item, score: score + (item.rank ?? 0) });
    }

    // (a stable sort keeps the menu's order — most used first — within a score)
    scored.sort((a, b) => a.score - b.score);
    const input = !(numeric && menu.number) ? menu.input?.(f) : null;
    // (a preset equal to the typed number is not listed twice)
    const typed = new Set(rows.map((r) => r.item.label));

    for (const { item } of scored)
        if (!typed.has(item.label))
            rows.push({ item, key: keys.get(item) });

    for (const item of found ?? [])
        rows.push({ item });

    // (the typed text as a value comes after everything listed that matches it)
    if (input)
        rows.push({ item: input });

    return [...capped(rows), ...last];
}

/** At most MAX_ROWS rows, then a note on how many more there are. */
export function capped(rows: Row[], total = rows.length): Row[]
{
    if (total <= MAX_ROWS)
        return rows;

    return [...rows.slice(0, MAX_ROWS), { item: { label: `… and ${total - MAX_ROWS} more — type to filter`, role: 'info' } }];
}

/**
 * The row selected when a menu opens or its filter changes: the first that can be chosen — never one chosen only on
 * purpose ("＋ New trait…": ⏎ must not make an entry), unless the typed filter found nothing else. -1: none.
 */
export function firstSelectable(rows: Row[], filtered = false): number
{
    const ok = (r: Row): boolean => r.item.role !== 'info' && !!r.item.go;
    const i = rows.findIndex((r) => ok(r) && !r.item.explicit);
    return i >= 0 || !filtered ? i : rows.findIndex(ok);
}
