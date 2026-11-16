/**
 * Conditional versions of an event's texts (docs/mods.md, "Editing in place"): "＋ text version when…" builds the
 * condition with the statement picker, gives the version a new localization key (`<event>.desc.<n>`, empty: it reads
 * "(no text yet)" until written; made in the same request as the statement, so one undo step takes both back) and puts
 * it into the text's statement in the game's form:
 *
 *     desc = x   →   desc = { first_valid = { triggered_desc = { trigger = { … } desc = <new> } desc = x } }
 *
 * A `first_valid` / `random_valid` the text has gets the new version before its unconditional fallback; texts made of
 * several parts (no first_valid: every valid part is shown) get it as one more part.
 *
 * "＋ text part" adds a part without a condition; the parts of a text are shown one after another:
 *
 *     desc = x   →   desc = { desc = x desc = <new> }        desc = { … }   →   desc = { … desc = <new> }
 *
 * Descriptions nest (DescNode): every part or version, at any depth, is moved up and down by swapping its statement
 * with its neighbour's, removed by removing its statement, and containers get parts / versions added, located by
 * their paths (keyed statement indexes from the `desc` statement down).
 */
import type { EntryCreate, LineSource } from '../../shared/api';
import { parseSnippet, printScript, type SNode } from '../../shared/scriptCatalog';
import { api } from './api';
import { pickStatement } from './picker/pickStatement';
import { createsOf, reportEditError, rewrittenText, runScriptEdit } from './scriptEdits';

import { tr } from '../../shared/i18n';
/** The text statement with a new conditional version (`key` shown when `condition` holds). */
export function withTextVariant(statement: string, key: string, condition: string): string
{
    const nodes = parseSnippet(statement);
    const n = nodes[0];

    if (!n)
        throw new Error(tr('No text statement to add to.'));

    const variant: SNode = {
        k: 'triggered_desc',
        op: '=',
        kids: [
            { k: 'trigger', op: '=', kids: parseSnippet(condition) },
            { k: 'desc', op: '=', v: key }
        ]
    };
    let out: SNode;

    if (!n.kids)
        out = { k: n.k, op: '=', kids: [{ k: 'first_valid', op: '=', kids: [variant, { k: 'desc', op: '=', v: n.v ?? '' }] }] };
    else
    {
        const kids = n.kids.map((c) => ({ ...c }));
        const fv = kids.find((c) => (c.k === 'first_valid' || c.k === 'random_valid') && c.kids);

        if (fv)
        {
            const list = [...fv.kids!];
            // (before the unconditional fallback at the end)
            let i = list.length;

            while (i > 0 && list[i - 1].k === 'desc' && !list[i - 1].kids)
                i--;

            list.splice(i, 0, variant);
            fv.kids = list;
        }
        else
            kids.push(variant);

        out = { ...n, kids };
    }

    return printScript([out]);
}

/** The text statement with one more part at its end (shown after the others, always). */
export function withTextPart(statement: string, key: string): string
{
    const n = parseSnippet(statement)[0];

    if (!n)
        throw new Error(tr('No text statement to add to.'));

    const part: SNode = { k: 'desc', op: '=', v: key };
    const out: SNode = n.kids ? { ...n, kids: [...n.kids, part] } : { k: n.k, op: '=', kids: [{ k: 'desc', op: '=', v: n.v ?? '' }, part] };
    return printScript([out]);
}

/** Index in `list` of its `i`-th keyed statement (bare values are not counted). */
function keyedAt(list: SNode[], i: number): number | undefined
{
    return list.map((c, j) => (c.op ? j : -1)).filter((j) => j >= 0)[i];
}

/**
 * The text statement with the statements of the block at `parent` (a path of keyed indexes from the statement's own
 * block down; [] = its block) changed by `change` (given the list and a resolver of keyed indexes).
 */
function editAt(statement: string, parent: number[], change: (list: SNode[], at: (i: number) => number) => SNode[]): string
{
    const root = parseSnippet(statement)[0];
    const stale = (): never =>
    {
        throw new Error(tr('The text changed — nothing done.'));
    };
    const walk = (n: SNode, rest: number[]): SNode =>
    {
        if (!n.kids)
            stale();

        if (!rest.length)
            return { ...n, kids: change(n.kids!, (i) => keyedAt(n.kids!, i) ?? stale()) };

        const j = keyedAt(n.kids!, rest[0]) ?? stale();
        const kids = [...n.kids!];
        kids[j] = walk(kids[j], rest.slice(1));
        return { ...n, kids };
    };

    if (!root)
        stale();

    return printScript([walk(root, parent)]);
}

/** The text statement with two items of the block at `parent` swapped (keyed indexes `a`, `b`). */
export function withSwapped(statement: string, parent: number[], a: number, b: number): string
{
    return editAt(statement, parent, (list, at) =>
    {
        const [i, j] = [at(a), at(b)];
        const out = [...list];
        [out[i], out[j]] = [out[j], out[i]];
        return out;
    });
}

/** The text statement without the item `a` of the block at `parent`. */
export function withRemoved(statement: string, parent: number[], a: number): string
{
    return editAt(statement, parent, (list, at) =>
    {
        const i = at(a);
        return list.filter((_, j) => j !== i);
    });
}

/**
 * The text statement with `item` added to the block at `parent`: at its end, or (`beforeFallback`, a first_valid's
 * new conditional version) before the unconditional versions at its end.
 */
export function withAdded(statement: string, parent: number[], item: SNode, beforeFallback: boolean): string
{
    return editAt(statement, parent, (list) =>
    {
        let i = list.length;

        while (beforeFallback && i > 0 && list[i - 1].k === 'desc')
            i--;

        return [...list.slice(0, i), item, ...list.slice(i)];
    });
}

/**
 * Runs a rewrite of the text statement at `at` and reports it. `creates`: the entries the new text needs. The written
 * statement's comments are kept (rewrittenText).
 */
async function rewrite(at: LineSource, make: (text: string) => string, done: string, failed: string, creates?: EntryCreate[]): Promise<void>
{
    try
    {
        const text = await rewrittenText(at, make);
        const made = createsOf(creates);
        await runScriptEdit({ op: 'replace', at, text, ...(made.creates ? { creates: made.creates } : {}) }, done + made.note);
    }
    catch (e)
    {
        reportEditError(failed)(e);
    }
}

/** Swaps two items of a description's block (`withSwapped`). */
export function moveText(at: LineSource, parent: number[], a: number, b: number): Promise<void>
{
    return rewrite(at, (t) => withSwapped(t, parent, a, b), tr('Moved a text'), tr('Not moved'));
}

/** Removes an item of a description's block (`withRemoved`); its localization stays. */
export function removeText(at: LineSource, parent: number[], a: number): Promise<void>
{
    return rewrite(at, (t) => withRemoved(t, parent, a), tr('Removed a text'), tr('Not removed'));
}

/**
 * Adds a text to the block at `parent` of a description: a part of a sequence or a version of a `first_valid` /
 * `random_valid`; `conditional`: a `triggered_desc` whose condition the picker builds (a first_valid's goes before
 * its fallback). The text gets a new key `<eventId>.desc.<n>`, empty until written.
 */
export async function addDescItem(at: LineSource, eventId: string, parent: number[], conditional: boolean, firstValid: boolean, pos?: { x: number; y: number; }): Promise<void>
{
    const cond = conditional ? await pickStatement({ kind: 'trigger', scope: 'character', title: tr('a text: shown when…'), at: pos, newEntries: true }) : undefined;

    if (conditional && !cond?.text.trim())
        return;

    const key = await freeKey(eventId, 'desc');
    const text: SNode = { k: 'desc', op: '=', v: key };
    const item: SNode = cond ? { k: 'triggered_desc', op: '=', kids: [{ k: 'trigger', op: '=', kids: parseSnippet(cond.text) }, text] } : text;
    await rewrite(at, (t) => withAdded(t, parent, item, !!cond && firstValid), tr('Added a text — write it with ✎'), tr('No text added'), [emptyText(key), ...(cond?.creates ?? [])]);
}

/**
 * A new text's key, empty, written with the statement that names it (a `loc` create: the same request, so one undo
 * step takes both back, and a refused statement leaves no key behind). The text controls are on events only, which a
 * loaded save never holds (its layer has characters and faiths), so saveEdit's refusal of creates never meets them.
 */
const emptyText = (key: string): EntryCreate => ({ what: 'loc', key, fields: [], loc: '' });

/** A key `<eventId>.<part>.<n>` no localization has yet. */
async function freeKey(eventId: string, part: 'desc' | 't'): Promise<string>
{
    let n = 2;

    while ((await api.locEntry(`${eventId}.${part}.${n}`))?.rel)
        n++;

    return `${eventId}.${part}.${n}`;
}

/** Makes the key of a new part of the description and writes it at the text's end (see the file comment). */
export async function addTextPart(at: LineSource, eventId: string): Promise<void>
{
    try
    {
        const key = await freeKey(eventId, 'desc');
        const next = await rewrittenText(at, (t) => withTextPart(t, key));
        await runScriptEdit({ op: 'replace', at, text: next, creates: [emptyText(key)] }, tr('Added a text part — write it with ✎'));
    }
    catch (e)
    {
        reportEditError(tr('No text part added'))(e);
    }
}

/** Asks for the condition, makes the key, writes both (see the file comment). `eventId`: the event's id. */
export async function addTextVariant(at: LineSource, eventId: string, part: 'desc' | 't', pos?: { x: number; y: number; }): Promise<void>
{
    const cond = await pickStatement({ kind: 'trigger', scope: 'character', title: part === 'desc' ? tr('a text version: shown when…') : tr('a title version: shown when…'), at: pos, newEntries: true });

    if (!cond?.text.trim())
        return;

    try
    {
        const key = await freeKey(eventId, part);
        const next = await rewrittenText(at, (t) => withTextVariant(t, key, cond.text));
        const made = createsOf([emptyText(key), ...(cond.creates ?? [])]);
        await runScriptEdit({ op: 'replace', at, text: next, creates: made.creates }, tr('Added a {kind} version{condition} — write it with ✎', { kind: part === 'desc' ? 'text' : 'title', condition: cond.summary ? tr(' (when {summary}{summary2})', { summary: cond.summary.charAt(0).toLowerCase(), summary2: cond.summary.slice(1) }) : '' }) + made.note);
    }
    catch (e)
    {
        reportEditError(tr('No text version added'))(e);
    }
}
