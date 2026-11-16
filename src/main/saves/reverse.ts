/**
 * An edit of a loaded save's character as the explorer shows it (its generated history-like block, saves/project.ts)
 * turned into changes of the save itself (docs/saves.md, "Edits"): the block before and after compared field by field.
 * What the save can take this way: name, sex, nickname, house / dynasty, culture, faith, skills, traits, sexuality, birth
 * date; the rest (parents, spouses, death, other history) is named as not written into the save.
 */
import type { SaveCharacterEdit } from '../../shared/api.ts';
import { tr } from '../../shared/i18n.ts';
import { child, children, scalar, type PNode } from '../indexer/parser.ts';
import { entries, type Gamestate } from './gamestate.ts';

const SKILLS = ['diplomacy', 'martial', 'stewardship', 'intrigue', 'learning', 'prowess'];
const SEXUALITY: Record<string, string> = { heterosexual: 'he', homosexual: 'ho', bisexual: 'bi', asexual: 'as' };
const HANDLED = new Set(['name', 'female', 'give_nickname', 'dynasty_house', 'dynasty', 'culture', 'religion', 'faith', 'sexuality', 'trait', ...SKILLS]);
const DATE = /^\d+\.\d+\.\d+$/;

/** A node as text, offsets aside (to compare what a block says). */
function said(n: PNode): string
{
    const v = Array.isArray(n.v) ? `{ ${n.v.map(said).join(' ')} }` : n.v;
    return n.k === null ? String(v) : `${n.k}${n.op ?? '='}${v}`;
}

/** Its birth date: the dated block holding `birth = yes`. */
const birthOf = (body: PNode[]): string | undefined => body.find((n) => n.k && DATE.test(n.k) && Array.isArray(n.v) && n.v.some((x) => x.k === 'birth'))?.k ?? undefined;

/** A dated block that is only the birth (handled); the others are history the save can't take. */
const onlyBirth = (n: PNode): boolean => !!n.k && DATE.test(n.k) && Array.isArray(n.v) && n.v.every((x) => x.k === 'birth');

/** The save's house for `dynasty_house = <key>` / `dynasty = <key>` (a dynasty: its first house without a key of its own). */
function houseFor(g: Gamestate, kind: string, key: string): number | undefined
{
    const b = g.buf;
    const dyn = g.section('dynasties');
    const str = (s: number, e: number): string => b.subarray(s, e).toString('latin1').replace(/^"|"$/g, '');
    let dynasty: number | undefined;

    if (kind === 'dynasty')
    {
        const d = g.sub(dyn, 'dynasties');

        for (const x of d?.block ? entries(b, d.vs, d.ve) : [])
        {
            if (x.block && x.key && [...entries(b, x.vs, x.ve)].some((f) => f.key === 'key' && !f.block && str(f.vs, f.ve) === key))
            {
                dynasty = Number(x.key);
                break;
            }
        }

        if (dynasty === undefined)
            return undefined;
    }

    const h = g.sub(dyn, 'dynasty_house');

    for (const x of h?.block ? entries(b, h.vs, h.ve) : [])
    {
        if (!x.block || !x.key)
            continue;

        let k: string | undefined;
        let d: number | undefined;

        for (const f of entries(b, x.vs, x.ve))
        {
            if (f.key === 'key' && !f.block)
                k = str(f.vs, f.ve);
            else if (f.key === 'dynasty' && !f.block)
                d = Number(str(f.vs, f.ve));
        }

        if (kind === 'dynasty_house' ? k === key : !k && d === dynasty)
            return Number(x.key);
    }

    return undefined;
}

/** The save's changes for a character's generated block edited from `before` to `after` (the blocks' bodies). */
export function characterChanges(g: Gamestate, before: PNode[], after: PNode[]): { edits: Omit<SaveCharacterEdit, 'id'>[]; unsupported: string[]; }
{
    const edits: Omit<SaveCharacterEdit, 'id'>[] = [];
    const unsupported: string[] = [];
    const s = (body: PNode[], k: string): string | undefined => scalar(child(body, k));
    const changed = (k: string): boolean => s(before, k) !== s(after, k);

    if (changed('name'))
        edits.push({ field: 'firstName', text: s(after, 'name') ?? '' });

    if (changed('female'))
        edits.push({ field: 'female', number: s(after, 'female') === 'yes' ? 1 : 0 });

    if (changed('give_nickname'))
        edits.push({ field: 'nicknameKey', text: s(after, 'give_nickname') ?? '' });

    const houseRef = (body: PNode[]): [string, string] | undefined =>
        s(body, 'dynasty_house') ? ['dynasty_house', s(body, 'dynasty_house')!] : s(body, 'dynasty') ? ['dynasty', s(body, 'dynasty')!] : undefined;
    const hb = houseRef(before);
    const ha = houseRef(after);

    if (JSON.stringify(hb) !== JSON.stringify(ha))
    {
        const id = ha && houseFor(g, ha[0], ha[1]);

        if (id === undefined)
            unsupported.push(ha ? tr('the house {key} (not a house of this save)', { key: ha[1] }) : tr('no house (a character keeps one in the save)'));
        else
            edits.push({ field: 'house', number: id });
    }

    if (changed('culture'))
    {
        const key = s(after, 'culture');
        const id = [...g.cultures()].find(([, k]) => k === key)?.[0];

        if (id === undefined)
            unsupported.push(tr('the culture {key} (not a culture of this save)', { key: key ?? '?' }));
        else
            edits.push({ field: 'culture', number: id });
    }

    const faithKey = (body: PNode[]): string | undefined => s(body, 'religion') ?? s(body, 'faith');

    if (faithKey(before) !== faithKey(after))
    {
        const key = faithKey(after);
        // (a game faith: its tag; a reformed one written by its template: the first of that template)
        const id = [...g.faiths()].find(([, tag]) => tag === key)?.[0];

        if (id === undefined)
            unsupported.push(tr('the faith {key} (not a faith of this save)', { key: key ?? '?' }));
        else
            edits.push({ field: 'faith', number: id });
    }

    if (SKILLS.some((k) => changed(k)))
        edits.push({ field: 'skills', numbers: SKILLS.map((k) => Math.max(0, Math.round(Number(s(after, k) ?? 0)) || 0)) });

    const traits = (body: PNode[]): string[] => children(body, 'trait').map((n) => scalar(n) ?? '').filter(Boolean);

    if (traits(before).join() !== traits(after).join())
        edits.push({ field: 'traits', keys: traits(after) });

    if (changed('sexuality'))
        edits.push({ field: 'sexuality', text: SEXUALITY[s(after, 'sexuality') ?? ''] ?? s(after, 'sexuality') ?? '' });

    const born = birthOf(after);

    if (birthOf(before) !== born && born)
        edits.push({ field: 'birth', text: born });

    // everything else: what it said before and after (parents, spouses, death, history)
    const rest = (body: PNode[]): string[] => body.filter((n) => !(n.k && HANDLED.has(n.k)) && !onlyBirth(n)).map(said).sort();
    const rb = rest(before);
    const ra = rest(after);

    for (const x of ra.filter((x) => !rb.includes(x)))
        unsupported.push(x);

    for (const x of rb.filter((x) => !ra.includes(x)))
        unsupported.push(tr('removed: {what}', { what: x }));

    return { edits, unsupported };
}
