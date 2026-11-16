/**
 * Small text rules the picker (renderer) and the entry creation (main) share, so that what the picker shows for a new
 * entry is what gets written when nothing was typed (docs/picker.md "New entries").
 */

/** A key made readable: `_opinion` dropped, underscores to spaces, first letter in capitals. */
export function humanizeKey(key: string): string
{
    const t = key.replace(/_opinion$/, '').replace(/_/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * The name a new entry gets in game when none is typed: its key made readable. An event's key is `namespace.0003`, so
 * its name is the namespace made readable plus the number without leading zeros ("Test 3"); any other key loses
 * what stands before its last dot.
 */
export function defaultEntryName(type: string, key: string): string
{
    const dot = key.lastIndexOf('.');

    if (type === 'events' && dot > 0 && /^\d+$/.test(key.slice(dot + 1)))
        return `${humanizeKey(key.slice(0, dot))} ${Number(key.slice(dot + 1))}`;

    return humanizeKey(key.replace(/^.*\./, ''));
}

/** A field's or menu's label without its trailing "…" (the crumb, the title): an ellipsis inside the text stays. */
export function plainLabel(label: string): string
{
    return label.replace(/\s*…$/, '');
}
