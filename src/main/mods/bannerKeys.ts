/**
 * The tenet banners of 1.20 (migrations.ts `banners`; religion_family_types/_religion_family_types.info): 1.19's one
 * `doctrine_background_icon = x.dds` is four keys now: `tenet_background_icon` (approved by the faith, core for a rite),
 * `tenet_heretical_background_icon`, `tenet_neutral_background_icon`, `tenet_unknown_background_icon`; their values are names without
 * extension of textures in gfx/interface/icons/faith_tenets that exist with a `_small` variant. A family without all four
 * is "Religious family X needs complete icon setup" in the game's log. A religion overrides its family's banners only when
 * its `religion_details` has all four.
 *
 * Each definition of the rule's files loses the old key and gets the keys it lacks, from two places: the banner the mod named
 * (`env.carry`: the texture the mod ships, brought into faith_tenets, for the first key) and the game's own values
 * (`env.values`, read from its families when the rule runs, so a later game version is followed). Pure text edits, applied
 * with `applyStatementEdits`.
 */
import { parse, type PNode } from '../indexer/parser.ts';
import { dropRange, indentAt, insertFirst, statementNote, type StatementEdit } from './scriptRules.ts';
import { appendLines } from './wrapKeys.ts';

export interface BannerRule
{
    /** path patterns of the files it concerns */
    files: string[];
    /** the key 1.19 wrote: it goes */
    old: string;
    /** the keys 1.20 requires, all of them; the first one takes the banner the old key named */
    keys: string[];
    /** the block of a definition that holds the keys (a religion's `religion_details`); absent: the definition itself */
    into?: string;
    /**
     * every definition gets the keys it lacks (a religion family); else only one that had the old key does, and only when its
     * banner can be carried: a religion without its own four takes its family's, which is what the old key without a texture
     * of its own came to
     */
    always?: boolean;
    /** the folders of the banner textures: 1.19's and 1.20's */
    from: string;
    to: string;
    /** the folder of the game's definitions that hold the values (a religion's keys are the families') */
    valuesIn: string;
    label: string;
}

export interface BannerEnv
{
    /** the game's value of each key (its most common one among the families) */
    values: Record<string, string>;
    /** the name (in the new folder) of the banner an old value names, when the textures are there or are brought; else undefined */
    carry(value: string): string | undefined;
}

const scalar = (n: PNode | undefined): string | undefined => (n && typeof n.v === 'string' ? n.v : undefined);

/** A banner as 1.19 named it (`core_tenet_banner_x.dds`, maybe quoted): the name of its texture without extension. */
export function bannerName(value: string): string
{
    return value.replace(/^"|"$/g, '').replace(/\.dds$/i, '');
}

/** The edits of one definition: the old key replaced by the keys it lacks, or the keys added. */
function definitionEdits(text: string, entry: PNode, rule: BannerRule, env: BannerEnv): StatementEdit[]
{
    const kids = Array.isArray(entry.v) ? entry.v : [];
    const olds = kids.filter((c) => c.k === rule.old && scalar(c));
    const old = olds[0];
    const box = rule.into ? kids.find((c) => c.k === rule.into && Array.isArray(c.v)) : entry;

    if (!old && !rule.always)
        return [];

    const have = new Set((box && Array.isArray(box.v) ? box.v : []).map((c) => c.k));
    const carried = old ? env.carry(scalar(old)!) : undefined;
    // (an override of a family's banners is all four or none: without the banner of its own there is none)
    const lines = rule.always || carried
        ? rule.keys.filter((k) => !have.has(k) && (k === rule.keys[0] ? (carried ?? env.values[k]) : env.values[k]) !== undefined).map((k) => `${k} = ${k === rule.keys[0] ? (carried ?? env.values[k]) : env.values[k]}`)
        : [];
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    // (a key written twice: the first stands for them, the others go)
    const more = olds.slice(1).map((c) => dropRange(text, c));

    // (the family: the old key's place; religion: the block)
    if (!rule.into)
    {
        if (old)
        {
            // (its comment stays with the banner it described: the first key; a key that shares its line with the brace puts the others one tab in)
            const note = statementNote(text, old, kids, entry.vs);
            const ls = text.lastIndexOf('\n', old.s - 1) + 1;
            const ind = text.slice(ls, old.s).trim() ? indentAt(text, old.s) + '\t' : indentAt(text, old.s);
            const body = lines.map((l, i) => (i === 0 && note.trail ? `${l} ${note.trail}` : l));
            return [...(lines.length ? [{ s: old.s, e: note.end, text: body.join(eol + ind) }] : [dropRange(text, { ...old, e: note.end })]), ...more];
        }

        return lines.length ? [insertFirst(entry, text, lines)] : [];
    }

    if (box && Array.isArray(box.v))
    {
        const inner = box.v.length ? indentAt(text, box.v[0].s) : indentAt(text, box.s) + '\t';
        return [...(lines.length ? [appendLines(text, box, lines.map((l) => inner + l))] : []), ...olds.map((c) => dropRange(text, c))];
    }

    // (no block: it takes the old key's place)
    if (old && lines.length)
    {
        const base = indentAt(text, old.s);
        const note = statementNote(text, old, kids, entry.vs);
        return [{ s: old.s, e: note.end, text: `${rule.into} = {${eol}${lines.map((l, i) => `${base}\t${l}${i === 0 && note.trail ? ' ' + note.trail : ''}${eol}`).join('')}${base}}` }, ...more];
    }

    return olds.map((c) => dropRange(text, c));
}

/** The edits for every definition of a text. */
export function bannerEdits(text: string, rule: BannerRule, env: BannerEnv): StatementEdit[]
{
    return parse(text).filter((n) => n.k && Array.isArray(n.v)).flatMap((n) => definitionEdits(text, n, rule, env));
}

/**
 * The game's value of each key among its family definitions' texts: the most common one (the game's families all share
 * theirs; the most common keeps one odd family from deciding), the first on a tie.
 */
export function gameBannerValues(texts: string[], keys: string[]): Record<string, string>
{
    const count = new Map<string, Map<string, number>>();

    for (const text of texts)
    {
        for (const n of parse(text))
        {
            for (const c of Array.isArray(n.v) ? n.v : [])
            {
                const v = scalar(c);

                if (c.k && keys.includes(c.k) && v !== undefined)
                {
                    const m = count.get(c.k) ?? new Map<string, number>();
                    m.set(v, (m.get(v) ?? 0) + 1);
                    count.set(c.k, m);
                }
            }
        }
    }

    const out: Record<string, string> = {};

    for (const [k, m] of count)
        out[k] = [...m].sort((a, b) => b[1] - a[1])[0][0];

    return out;
}
