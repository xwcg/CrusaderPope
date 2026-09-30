/** Cards: Presentation and data — game concepts, event backgrounds/themes, messages, flavorization, customizable/effect/trigger localization, genes, defines, colours, coats of arms. */
import type { PNode } from '../../indexer/parser.ts';
import type { Line, Rich, RichSeg } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import type { CardFn } from './types.ts';
import { capitalize, formatNumber, humanize, rich } from '../text.ts';
import { colorText, commentAbove, entryLines, keyTitle, kids, lineComment, membersBy, note, settingLines, str, values, words } from './presentation-util.ts';
import { SCENE_CARDS } from './presentation-scenes.ts';
import { TEXT_CARDS } from './presentation-text.ts';
import { LOOK_CARDS } from './presentation-looks.ts';

/** A define's value: a number, a date, an entry it names, else as written. */
function defineValue(b: StoryBuilder, v: string): RichSeg
{
    if (/^-?\d+(\.\d+)?$/.test(v))
        return { text: formatNumber(parseFloat(v), 6), kind: 'value' };

    const e = !/^\d/.test(v) && b.idx.named(v)[0];
    return e ? b.d.entitySeg(e) : { text: v, kind: 'value' };
}

/**
 * The values of a define group, one line each with the comment written beside or above it (common/defines: the game
 * documents most values that way); lists joined, nested groups as children. Anchored: each can be changed in place.
 */
function defineLines(b: StoryBuilder, list: PNode[], ctx: Ctx): Line[]
{
    const out: Line[] = [];

    for (const c of list)
    {
        if (!c.k)
            continue;

        const kids_ = kids(c);
        const nested = kids_.some((x) => x.k);
        const vals = values(c);
        const shown: Rich = typeof c.v === 'string' ? [defineValue(b, c.v)] : nested ? [] : vals.length > 24 ? [{ text: `${vals.slice(0, 24).join(', ')} … (${vals.length})`, kind: 'value' }] : [{ text: vals.join(', ') || '(none)', kind: 'value' }];
        const comment = lineComment(ctx.src, c) ?? commentAbove(ctx.src, c);
        const l: Line = { text: rich(capitalize(humanize(c.k).replace(/^n(?=[a-z])/, '')), nested ? ':' : ': ', shown, comment ? rich(' ', note(`— ${comment}`)) : ''), tip: typeof c.v === 'string' ? `${c.k} = ${c.v}` : c.k };

        if (nested)
            l.children = defineLines(b, kids_, ctx);

        if (ctx.file)
            l.src = b.d.anchor(c, ctx, 'other', nested);

        out.push(l);
    }

    return out;
}

/**
 * A group of entries (decision groups, activity groups, situation groups, interaction categories): its settings, how
 * the interface shows it (`gui_tags`), and its members — the entries naming it with `key` (read from their files: the
 * index does not link these).
 */
function groupCard(member: string, key: string, what: string, extra?: (b: StoryBuilder, body: PNode[], facts: Rich[], src: string) => void): CardFn
{
    return (b, { e, body, card, ctx, own }) =>
    {
        const members = membersBy(b, member, key).get(e.name) ?? [];
        card.facts.push([`${members.length} ${what}`]);
        extra?.(b, body, card.facts, ctx.src);
        const tags = values(body.find((c) => c.k === 'gui_tags'));

        if (tags.length)
            card.facts.push(rich('Shown as ', { text: tags.map((t) => humanize(t)).join(', '), kind: 'code', tip: 'gui_tags' }));

        // (`desc`: a loc key)
        if (members.length)
            card.sections.push({ title: capitalize(what), lines: entryLines(b, members, undefined, 80) });

        const show = (k: string, v: string): Rich | undefined => (k === 'desc' ? rich('Described as “', b.d.loc(v) ?? v, '”') : undefined);
        card.sections.push({ title: 'Settings', lines: settingLines(b, e.type, body, ctx, show), src: own('field', e.type) });
        return true;
    };
}

const OTHER_CARDS: Record<string, CardFn> = {
    // common/defines: `NGame = { END_DATE = "1453.1.1" … }` — every file and sub-folder merges into these groups
    defines: (b, { e, body, card, ctx, own }) =>
    {
        card.title = keyTitle(e.name);
        const lines = defineLines(b, body, ctx);
        card.facts.push([`${lines.length} values`]);
        card.sections.push({ title: 'Values', lines, src: own('other') });
        return true;
    },
    decision_group_types: groupCard('decisions', 'decision_group_type', 'decisions'),
    'activities/activity_group_types': groupCard('activities/activity_types', 'activity_group_type', 'activities'),
    'situation/situation_group_types': groupCard('situation/situations', 'situation_group_type', 'situations'),
    // common/character_interaction_categories: `index` (the menu's order, no gaps), `color`, `desc` (a loc key), `default`, `favorite_interactions`
    character_interaction_categories: groupCard('character_interactions', 'category', 'interactions', (b, body, facts, src) =>
    {
        const color = body.find((c) => c.k === 'color' && Array.isArray(c.v));
        const t = color && colorText(color, src);

        if (t)
            facts.push(rich('Colour ', t));

        const desc = str(body, 'desc');
        const d = desc && b.d.loc(desc);

        if (d)
            facts.push(rich('“', d, '”'));

        if (str(body, 'favorite_interactions') === 'yes')
            facts.push(['Holds the player’s favourite interactions']);
    }),
    // common/connection_arrows: the map's arrows (silk road) — `provinces` from the start to the end point, the ones between shape the line
    connection_arrows: (b, { body, card, ctx, own }) =>
    {
        if (str(body, 'is_primary') === 'yes')
            card.facts.push(['Main route']);

        const type = str(body, 'arrow_type');

        if (type)
            card.facts.push(rich('Arrow: ', { text: words(type.replace(/([a-z])([A-Z])/g, '$1_$2')), kind: 'code', tip: type }));

        const provs = kids(body.find((c) => c.k === 'provinces')).filter((c) => c.k === null && typeof c.v === 'string');
        // (the provinces are named by the comments beside them: `10148 # Chang'an (Zhouzhi)`)
        const name = (n: PNode): string | undefined => lineComment(ctx.src, n)?.split('#')[0].trim() || undefined;
        const named = (n: PNode): Rich => rich({ text: `province ${n.v}`, kind: 'value' }, name(n) ? ` (${name(n)})` : '');
        const lines: Line[] = provs.length ? [{ text: rich('From ', named(provs[0]), ' to ', named(provs[provs.length - 1]), ` — ${provs.length} provinces`), src: b.d.anchor(body.find((c) => c.k === 'provinces')!, ctx, 'other', true) }] : [];
        const between = provs
            .slice(1, -1)
            .map(name)
            .filter((n): n is string => !!n);

        if (between.length)
            lines.push({ text: [`Through ${between.join(', ')}`] });

        card.sections.push({ title: 'Route', lines, src: own('other') });
        return true;
    },
    // common/console_groups: console commands grouped for the debug console
    console_groups: (b, { body, card, ctx, own }) =>
    {
        const cmds = body.filter((c) => c.k === null && typeof c.v === 'string');
        card.facts.push([`${cmds.length} console command${cmds.length === 1 ? '' : 's'}`]);
        card.sections.push({ title: 'Commands', lines: cmds.map((c): Line => ({ text: [{ text: c.v as string, kind: 'code' }], src: b.d.anchor(c, ctx, 'other', false) })), src: own('other') });
        return true;
    },
    // common/ai_goaltypes: goals the AI weighs (the game's one test goal sets nothing)
    ai_goaltypes: (b, { body, card }) =>
    {
        if (!body.length)
            card.facts.push(['Nothing set — the game’s defaults apply']);
    }
};

export const PRESENTATION_CARDS: Record<string, CardFn> = { ...SCENE_CARDS, ...TEXT_CARDS, ...LOOK_CARDS, ...OTHER_CARDS };
