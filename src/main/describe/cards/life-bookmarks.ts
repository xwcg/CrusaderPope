/** Cards of the game's start screen (common/bookmarks/*): bookmarks, their groups and the challenge characters. */
import type { PNode } from '../../indexer/parser.ts';
import type { Line, Rich, RichSeg } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import { capitalize, humanize, rich } from '../text.ts';
import type { CardFn } from './types.ts';
import { riteHistory } from '../../indexer/layouts.ts';
import { BOOKMARK_DATE } from '../../portraits/modifiers.ts';
import { weightLines } from './weight.ts';
import { addSection, blockOf, dateSeg, entries, familySeg, joined, kids, settingsSection, str, trimmed, words, type SettingValue } from './life-shared.ts';

import { tr } from '../../../shared/i18n.ts';
/** What a bookmark character starts as (`bookmark_type`, _bookmarks.info; default existing_ruler). */
const BOOKMARK_TYPES: Record<string, string> = { new_landless_adventurer: tr('Starts as a new landless adventurer'), new_noble_family: tr('Starts as a new noble family') };

/** `religion = x` of a bookmark character: 1.20 writes rites there too (roman_rite, hanafi …), so a rite is its faith at the start date. */
function faithAt(b: StoryBuilder, value: string, start?: string): string
{
    const [y, m, d] = (start ?? '').split('.').map(Number);
    return riteHistory(b.idx).faithOf(value, y ? y * 10000 + (m || 1) * 100 + (d || 1) : BOOKMARK_DATE) ?? value;
}

/**
 * A bookmark character (common/bookmarks/bookmarks/_bookmarks.info `character = { … }`: its loc `name` (and
 * `<name>_desc`), `history_id` (the historical character), `title`, `difficulty`, nested characters shown beside it
 * with their `relation`) as a line: the name links to the historical character. `shown`: a text the card shows already.
 */
function bookmarkCharacter(b: StoryBuilder, n: PNode, ctx: Ctx, shown?: string, bookmark?: string, main = true, start?: string): Line
{
    // (a mod's own bookmark: the character's fields with the picker, its texts in place, characters beside it added)
    const own = !!ctx.file?.mod && !!bookmark;
    const src = ctx.file ? (own ? b.fieldAnchor(n, ctx, 'bookmark_character', true) : b.d.anchor(n, ctx, 'other', false)) : undefined;
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
    const desc = key && `${key}_desc` !== shown && b.idx.plainLoc(`${key}_desc`)?.trim() && b.d.loc(`${key}_desc`);

    // (its texts are no statements: "✎ text" where the character's statement is the active mod's, Line.locAt)
    const at = src ? { locAt: src } : {};

    if (own && key)
        children.push({ text: rich(tr('Name: '), { text: name, kind: 'value' }), icon: 'note', tip: key, locKey: key, ...at });

    if (desc)
        children.push({ text: trimmed(desc), icon: 'note', tip: `${key}_desc`, ...(own ? { locKey: `${key}_desc`, ...at } : {}) });
    else if (own && key && src && `${key}_desc` !== shown)
        children.push({ text: [{ text: tr('No description'), kind: 'ph' }], icon: 'note', placeholder: true, act: { label: tr('＋ description'), src, do: { kind: 'loc', key: `${key}_desc`, multiline: true } } });

    const facts: Rich[] = [];
    const difficulty = s('difficulty') && b.d.loc(s('difficulty')!);

    if (difficulty)
        facts.push(rich(difficulty, tr(' difficulty')));

    const sex = s('type');
    const birth = s('birth');

    if (sex || birth)
        facts.push(rich(sex === 'female' ? tr('A woman') : sex === 'male' ? tr('A man') : tr('Born'), birth ? rich(sex ? tr(', born ') : ' ', dateSeg(birth)) : ''));

    const links = [
        s('culture') && b.d.ref(s('culture')!, ['culture/cultures']),
        s('religion') && b.d.ref(faithAt(b, s('religion')!, start), ['faith']),
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
        children.push({ text: [tr('The tutorial’s character')], icon: 'note' });

    if (s('display') === 'no')
        children.push({ text: [tr('Not shown on the map')], icon: 'note' });

    for (const c of list)
        if (c.k === 'character' && Array.isArray(c.v))
            children.push(bookmarkCharacter(b, c, ctx, undefined, bookmark, false, start));

    const l: Line = { text: rich(who, relation ? rich(' ', relation) : '', title ? rich(', ', b.d.ref(title, ['landed_titles'])) : ''), icon: 'scope', children, tip: key };

    if (src)
        l.src = src;

    // (a main character: one beside them (a relative, a rival) added from history)
    if (own && main && key && l.src)
        children.push({ text: [{ text: tr('Characters beside them'), kind: 'ph' }], icon: 'scope', placeholder: true, act: { label: tr('＋ beside'), src: l.src, do: { kind: 'bookmarkCharacter', bookmark: bookmark!, under: key } } });

    return l;
}

/** Start dates in words in the settings lines. */
const dates: SettingValue = (v, f) => (/date/.test(f.key) ? dateSeg(v) : undefined);

/** The characters of a bookmark or challenge (`bookmark`: a bookmark's key: its characters are edited when the mod's own). */
function characterLines(b: StoryBuilder, body: PNode[], ctx: Ctx, shown?: string, bookmark?: string, start?: string): Line[]
{
    return body.filter((c) => c.k === 'character' && Array.isArray(c.v)).map((c) => bookmarkCharacter(b, c, ctx, shown, bookmark, true, start));
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
            card.facts.push(rich(tr('Starts on '), dateSeg(start)));

        if (str(body, 'recommended') === 'yes')
            card.facts.push([{ text: tr('Recommended'), kind: 'good' }]);

        if (str(body, 'is_playable') === 'no')
            card.facts.push([{ text: tr('Not playable'), kind: 'bad' }]);

        const dlc = str(body, 'requires_dlc_flag');

        if (dlc)
            card.facts.push(rich(tr('Needs '), { text: capitalize(humanize(dlc)), kind: 'value', tip: dlc }));

        const own = !!ctx.file?.mod;
        const chars = characterLines(b, body, ctx, undefined, own ? e.name : undefined, start);
        const at = own ? b.d.anchor(x.node, ctx, 'other', false) : undefined;

        // (a mod's own: a historical character added, filled from history at the start date)
        if (at)
            chars.push({ text: [{ text: chars.length ? tr('Another character') : tr('No characters yet'), kind: 'ph' }], icon: 'scope', placeholder: true, act: { label: tr('＋ character'), src: at, do: { kind: 'bookmarkCharacter', bookmark: e.name } } });

        addSection(card, tr('Characters'), chars);

        // (a mod's own: its name and description on the bookmark screen, changed in place)
        if (own)
        {
            // (an empty text, a new bookmark's "", counts as none: the card offers to write it)
            const name = b.idx.plainLoc(e.name)?.trim() ? b.d.loc(e.name) : undefined;
            const desc = b.idx.plainLoc(`${e.name}_desc`)?.trim() ? b.d.loc(`${e.name}_desc`) : undefined;
            addSection(card, tr('Texts'), [
                name ?
                    { text: rich(tr('Name: '), { text: b.d.richString(name), kind: 'value' }), icon: 'note', tip: e.name, locKey: e.name, ...(at ? { locAt: at } : {}) } :
                    { text: [{ text: tr('No name'), kind: 'ph' }], icon: 'note', placeholder: true, act: { label: tr('＋ name'), src: at!, do: { kind: 'loc', key: e.name } } },
                desc ?
                    { text: trimmed(desc), icon: 'note', tip: `${e.name}_desc`, locKey: `${e.name}_desc`, ...(at ? { locAt: at } : {}) } :
                    { text: [{ text: tr('No description'), kind: 'ph' }], icon: 'note', placeholder: true, act: { label: tr('＋ description'), src: at!, do: { kind: 'loc', key: `${e.name}_desc`, multiline: true } } }
            ]);
        }

        settingsSection(b, x, dates);
        b.genericSections(e, body, card, ctx, x.own, new Set(['character', 'weight']));
        const w = body.find((c) => c.k === 'weight');

        if (w)
            addSection(card, tr('Chance to be the default'), weightLines(b, Array.isArray(w.v) ? w.v : [{ ...w, k: 'value' }], ctx));

        return true;
    },

    // common/bookmarks/groups/_bookmark_groups.info
    'bookmarks/groups': (b, x) =>
    {
        const { e, body, card } = x;
        const start = str(body, 'default_start_date');

        if (start)
            card.facts.push(rich(tr('Starts on '), dateSeg(start)));

        const marks = [...entries(b, 'bookmarks/bookmarks')].filter((m) => str(m.body, 'group') === e.name);
        addSection(
            card,
            tr('Bookmarks'),
            marks.map((m) =>
            {
                const d = str(m.body, 'start_date');
                return { text: rich(b.d.entitySeg(m.e), d && d !== start ? rich(' (', dateSeg(d), ')') : ''), icon: 'note' };
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
            card.facts.push(rich(tr('Starts on '), dateSeg(start)));

        const ach = words(blockOf(body, 'achievements'));

        if (ach.length)
            card.facts.push(rich(ach.length > 1 ? tr('Achievements: ') : tr('Achievement: '), joined(ach.map((a) => b.d.ref(a, ['achievements'])))));

        // (the card's description is the character's: `<key>_desc`)
        addSection(card, tr('Character'), characterLines(b, body, ctx, card.description && `${e.name}_desc`, undefined, start));
        settingsSection(b, x, dates);
        b.genericSections(e, body, card, ctx, x.own, new Set(['character', 'achievements']));
        return true;
    }
};
