/** Cards of the game's start screen (common/bookmarks/*): bookmarks, their groups and the challenge characters. */
import type { PNode } from '../../indexer/parser.ts';
import type { Line, Rich, RichSeg } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import { capitalize, humanize, rich } from '../text.ts';
import type { CardFn } from './types.ts';
import { weightLines } from './weight.ts';
import { addSection, blockOf, dateSeg, entries, familySeg, joined, kids, settingsSection, str, trimmed, words, type SettingValue } from './life-shared.ts';

/** What a bookmark character starts as (`bookmark_type`, _bookmarks.info; default existing_ruler). */
const BOOKMARK_TYPES: Record<string, string> = { new_landless_adventurer: 'Starts as a new landless adventurer', new_noble_family: 'Starts as a new noble family' };

/**
 * A bookmark character (common/bookmarks/bookmarks/_bookmarks.info `character = { … }`: its loc `name` (and
 * `<name>_desc`), `history_id` — the historical character —, `title`, `difficulty`, nested characters shown beside it
 * with their `relation`) as a line: the name links to the historical character. `shown`: a text the card shows already.
 */
function bookmarkCharacter(b: StoryBuilder, n: PNode, ctx: Ctx, shown?: string): Line
{
    const list = kids(n);
    const s = (k: string): string | undefined => str(list, k);
    const key = s('name');
    const name = key ? b.d.richString(b.d.loc(key) ?? [humanize(key)]) : '?';
    const id = s('history_id');
    const link = id ? b.d.ref(id, ['characters']) : undefined;
    const who: RichSeg = link && typeof link !== 'string' ? { ...link, text: name } : { text: name, kind: 'value' };
    const relation = s('relation') && b.d.loc(s('relation')!);
    const title = s('title');
    const children: Line[] = [];
    const desc = key && `${key}_desc` !== shown && b.d.loc(`${key}_desc`);

    if (desc)
        children.push({ text: trimmed(desc), icon: 'note', tip: `${key}_desc` });

    const facts: Rich[] = [];
    const difficulty = s('difficulty') && b.d.loc(s('difficulty')!);

    if (difficulty)
        facts.push(rich(difficulty, ' difficulty'));

    const sex = s('type');
    const birth = s('birth');

    if (sex || birth)
        facts.push(rich(sex === 'female' ? 'A woman' : sex === 'male' ? 'A man' : 'Born', birth ? rich(sex ? ', born ' : ' ', dateSeg(birth)) : ''));

    const links = [
        s('culture') && b.d.ref(s('culture')!, ['culture/cultures']),
        s('religion') && b.d.ref(s('religion')!, ['faith']),
        s('government') && b.d.ref(s('government')!, ['governments']),
        s('dynasty_house') ? familySeg(b, 'dynasty_houses', s('dynasty_house')!) : s('dynasty') && familySeg(b, 'dynasties', s('dynasty')!)
    ].filter((x): x is RichSeg => !!x);

    if (links.length)
        facts.push(rich(...links.flatMap((l, i) => (i ? [' · ', l] : [l]))));

    for (const f of facts)
        children.push({ text: f, icon: 'note' });

    const type = s('bookmark_type');

    if (type && BOOKMARK_TYPES[type])
        children.push({ text: [BOOKMARK_TYPES[type]], icon: 'note', tip: `bookmark_type = ${type}` });

    if (s('tutorial') === 'yes')
        children.push({ text: ['The tutorial’s character'], icon: 'note' });

    if (s('display') === 'no')
        children.push({ text: ['Not shown on the map'], icon: 'note' });

    for (const c of list)
        if (c.k === 'character' && Array.isArray(c.v))
            children.push(bookmarkCharacter(b, c, ctx));

    const l: Line = { text: rich(who, relation ? rich(' ', relation) : '', title ? rich(' — ', b.d.ref(title, ['landed_titles'])) : ''), icon: 'scope', children, tip: key };

    if (ctx.file)
        l.src = b.d.anchor(n, ctx, 'other', false);

    return l;
}

/** Start dates in words in the settings lines. */
const dates: SettingValue = (v, f) => (/date/.test(f.key) ? dateSeg(v) : undefined);

/** The characters of a bookmark or challenge. */
function characterLines(b: StoryBuilder, body: PNode[], ctx: Ctx, shown?: string): Line[]
{
    return body.filter((c) => c.k === 'character' && Array.isArray(c.v)).map((c) => bookmarkCharacter(b, c, ctx, shown));
}

export const BOOKMARK_CARDS: Record<string, CardFn> = {
    // common/bookmarks/bookmarks/_bookmarks.info
    'bookmarks/bookmarks': (b, x) =>
    {
        const { e, body, card, ctx } = x;
        const group = str(body, 'group');
        const groupDef = group ? b.idx.get('bookmarks/groups', group) : undefined;
        const groupBody = groupDef ? kids(b.idx.defNode(groupDef)?.node) : [];
        const start = str(body, 'start_date') ?? str(groupBody, 'default_start_date');

        if (start)
            card.facts.push(rich('Starts on ', dateSeg(start)));

        if (str(body, 'recommended') === 'yes')
            card.facts.push([{ text: 'Recommended', kind: 'good' }]);

        if (str(body, 'is_playable') === 'no')
            card.facts.push([{ text: 'Not playable', kind: 'bad' }]);

        const dlc = str(body, 'requires_dlc_flag');

        if (dlc)
            card.facts.push(rich('Needs ', { text: capitalize(humanize(dlc)), kind: 'value', tip: dlc }));

        addSection(card, 'Characters', characterLines(b, body, ctx));
        settingsSection(b, x, dates);
        b.genericSections(e, body, card, ctx, x.own, new Set(['character', 'weight']));
        const w = body.find((c) => c.k === 'weight');

        if (w)
            addSection(card, 'Chance to be the default', weightLines(b, Array.isArray(w.v) ? w.v : [{ ...w, k: 'value' }], ctx));

        return true;
    },

    // common/bookmarks/groups/_bookmark_groups.info
    'bookmarks/groups': (b, x) =>
    {
        const { e, body, card } = x;
        const start = str(body, 'default_start_date');

        if (start)
            card.facts.push(rich('Starts on ', dateSeg(start)));

        const marks = [...entries(b, 'bookmarks/bookmarks')].filter((m) => str(m.body, 'group') === e.name);
        addSection(
            card,
            'Bookmarks',
            marks.map((m) =>
            {
                const d = str(m.body, 'start_date');
                return { text: rich(b.d.entitySeg(m.e), d && d !== start ? rich(' — ', dateSeg(d)) : ''), icon: 'note' };
            })
        );
        settingsSection(b, x, dates);
        return true;
    },

    // common/bookmarks/challenge_characters/_challenge_characters.info: a start date, achievements and a bookmark character
    'bookmarks/challenge_characters': (b, x) =>
    {
        const { e, body, card, ctx } = x;
        const start = str(body, 'start_date');

        if (start)
            card.facts.push(rich('Starts on ', dateSeg(start)));

        const ach = words(blockOf(body, 'achievements'));

        if (ach.length)
            card.facts.push(rich(ach.length > 1 ? 'Achievements: ' : 'Achievement: ', joined(ach.map((a) => b.d.ref(a, ['achievements'])))));

        // (the card's description is the character's: `<key>_desc`)
        addSection(card, 'Character', characterLines(b, body, ctx, card.description && `${e.name}_desc`));
        settingsSection(b, x, dates);
        b.genericSections(e, body, card, ctx, x.own, new Set(['character', 'achievements']));
        return true;
    }
};
