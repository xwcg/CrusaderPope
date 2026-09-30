/**
 * Cards: Characters' lives and things — death reasons, memories, accolades, artifacts (life-artifacts.ts), bookmarks
 * (life-bookmarks.ts), chronicles, domiciles, catalysts, court amenities, character backgrounds, tutorial lessons.
 */
import type { PNode } from '../../indexer/parser.ts';
import type { Line, Rich, RichSeg } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import { capitalize, humanize, rich, signed } from '../text.ts';
import type { CardFn } from './types.ts';
import { weightLines } from './weight.ts';
import { ARTIFACT_CARDS } from './life-artifacts.ts';
import { BOOKMARK_CARDS } from './life-bookmarks.ts';
import { addSection, blockOf, charTriggers, commentLines, costLines, descLines, durationText, entries, joined, kids, modifierGroup, quoted, settingsSection, str, triggerSection, trimmed, words } from './life-shared.ts';

/** What a death reason's icon (common/deathreasons: death_<kind>.dds) says about the death. */
const DEATH_KINDS: Record<string, string> = { murder: 'Violent death', disease: 'Death by disease', natural: 'Natural death', unknown: 'Unknown cause' };

/** Death reason texts speak of the one who died (CHARACTER) and the killer (TARGET_CHARACTER). */
function deathText(r: Rich): Rich
{
    return r.map((s) => (typeof s === 'string' || s.kind !== 'ph' ? s : { ...s, text: s.text.replace(/^Target Character/, 'the killer').replace(/^Character\b/, 'the deceased') }));
}

/**
 * A chronicle's texts (legends/chronicles/_chronicles.info): root is the legend — `[ROOT.Legend.GetProtagonist.GetName]`
 * its protagonist —, `[Localize( beast )]` the value of a property.
 */
function legendText(r: Rich): Rich
{
    return r.map((s) =>
    {
        if (typeof s === 'string' || s.kind !== 'ph' || !s.tip)
            return s;

        const up = (t: string): string => (/\|U\]$/.test(s.tip!) ? capitalize(t) : t);
        const prop = /Localize\(\s*(\w+)\s*\)/.exec(s.tip);

        if (prop)
            return { ...s, text: up(humanize(prop[1])) };

        if (/GetProtagonist\.Get\w*Name\w*\|?\w*\]$/.test(s.tip))
            return { ...s, text: up(/Possessive/.test(s.tip) ? 'the protagonist’s' : 'the protagonist') };

        // (longer chains: "the protagonist’s faith high god name")
        return { ...s, text: s.text.replace(/^[Yy]our legend protagonist /, up('the protagonist’s ')) };
    });
}

/** The perspectives of a memory's texts (common/character_memory_types/_character_memories.info). */
const MEMORY_TEXTS: [string, string][] = [
    ['description', 'As they remember it'],
    ['second_perspective_description', 'As it is said to them'],
    ['third_perspective_description', 'As others tell it']
];

/** The glory each accolade rank needs (common/defines: NAccolade.ACCOLADE_GLORY_LEVELS; rank 1 → 100 …). */
function gloryLevels(b: StoryBuilder): number[]
{
    const e = b.idx.get('defines', 'NAccolade');
    const d = e && b.idx.defNode(e);
    return words(d ? blockOf(kids(d.node), 'ACCOLADE_GLORY_LEVELS') : undefined).map(Number);
}

/** Who an accolade rank's modifier blocks apply to (common/accolade_types/_accolade_type.info). */
const RANK_MODIFIERS: Record<string, string> = { liege_modifier: 'The liege:', knight_modifier: 'The knight:', knight_army_modifier: 'The knight’s army:' };

/** An accolade parameter's text (its loc key; the engine's list bullet `$EFFECT_LIST_BULLET$` at its start dropped). */
function parameterText(b: StoryBuilder, key: string): Rich
{
    const r = b.d.loc(key);

    if (!r)
        return [capitalize(humanize(key))];

    return typeof r[0] === 'string' ? rich(capitalize(r[0].replace(/^\s*(\$\w+\$|[•·–-])\s*/, '')), r.slice(1)) : r;
}

/** Men-at-arms bonuses by terrain, winter or holding: `terrain_bonus = { light_infantry = { plains = { damage = 15 } } }`. */
function bonusLines(b: StoryBuilder, n: PNode, consts: Map<string, string>): Line[]
{
    return kids(n).flatMap((maa) =>
        kids(maa)
            .filter((t) => t.k && Array.isArray(t.v))
            .map((t) =>
            {
                const stats = kids(t)
                    .filter((s) => s.k && typeof s.v === 'string')
                    .map((s) =>
                    {
                        const raw = s.v as string;
                        const v = b.d.evalValue(raw.startsWith('@') ? (consts.get(raw.slice(1)) ?? raw) : raw);
                        return rich(v !== undefined ? { text: signed(v), kind: v >= 0 ? 'good' : 'bad' } : { text: raw, kind: 'value' }, ' ', humanize(s.k!));
                    });
                return { text: rich(b.d.ref(maa.k!, ['men_at_arms_types']), ' in ', b.d.ref(t.k!, ['terrain_types', 'holdings']), ': ', joined(stats)), icon: 'modifier', tip: `${maa.k} › ${t.k}` };
            })
    );
}

/** The lines of one accolade rank: who gets which modifiers, the men-at-arms and parameters it unlocks. */
function rankLines(b: StoryBuilder, list: PNode[], ctx: Ctx, consts: Map<string, string>): Line[]
{
    const out: Line[] = [];

    for (const c of list)
    {
        if (!c.k)
            continue;

        const src = ctx.file ? b.d.anchor(c, ctx, 'other', false) : undefined;

        if (RANK_MODIFIERS[c.k] && Array.isArray(c.v))
            out.push(modifierGroup(b, c, RANK_MODIFIERS[c.k], ctx, consts));
        else if (c.k === 'men_at_arms')
            out.push({ text: rich('The liege can raise ', joined(words(c).map((m) => b.d.ref(m, ['men_at_arms_types'])))), icon: 'modifier', tip: c.k, src });
        else if (c.k === 'accolade_parameters')
        {
            for (const p of words(c))
                out.push({ text: parameterText(b, p), icon: 'note', tip: p, src });
        }
        else if (/_bonus$/.test(c.k) && Array.isArray(c.v))
            out.push({ text: [`${capitalize(humanize(c.k.replace(/_bonus$/, '')))} bonuses of the knight’s men-at-arms:`], icon: 'modifier', children: bonusLines(b, c, consts), tip: c.k, src });
    }

    return out;
}

/**
 * Where struggle and situation phases count a catalyst: `<phase> = { future_phases = { <next> = { catalysts = {
 * <catalyst> = <points> } } } }` (common/situation/situations/_situations.info; struggles the same in `phase_list`).
 */
function catalystLines(b: StoryBuilder, name: string): Line[]
{
    const phase = (n: PNode | undefined): RichSeg => ({ text: n?.k ? b.d.richString(b.d.loc(n.k) ?? [capitalize(humanize(n.k))]) : '?', kind: 'value', tip: n?.k ?? undefined });
    const out: Line[] = [];

    for (const type of ['struggle/struggles', 'situation/situations'])
    {
        for (const { e, body } of entries(b, type))
        {
            const found: Line[] = [];
            const walk = (list: PNode[], path: PNode[]): void =>
            {
                for (const c of list)
                {
                    if (!Array.isArray(c.v))
                        continue;

                    if (c.k !== 'catalysts')
                    {
                        walk(c.v, [...path, c]);
                        continue;
                    }

                    const hit = c.v.find((x) => x.k === name && typeof x.v === 'string');

                    if (!hit)
                        continue;

                    const v = hit.v as string;
                    const n = b.d.evalValue(v);
                    const points: RichSeg = n !== undefined ? { text: signed(n), kind: 'value', tip: v } : b.d.valueSeg(v);
                    const from = path[path.length - 2]?.k === 'future_phases' ? path[path.length - 3] : undefined;
                    found.push({ text: rich(points, ' points towards ', phase(path[path.length - 1]), from ? rich(' during ', phase(from)) : ''), icon: 'chance', tip: `${hit.k} = ${v}` });
                }
            };
            walk(body, []);

            if (found.length)
                out.push({ text: [b.d.entitySeg(e)], children: found });
        }
    }

    return out;
}

/** A catalyst: only a name (situation/catalysts, struggle/catalysts _catalysts.info) — the phases that count it. */
const catalyst: CardFn = (b, { e, card }) =>
{
    const lines = catalystLines(b, e.name);

    if (!lines.length)
        card.facts.push(['Not counted by any phase']);

    addSection(card, e.type.startsWith('struggle') ? 'Moves the struggle' : 'Moves the situation', lines);
    addSection(card, 'Notes in the file', commentLines(b, e));
    return true;
};

/** A tutorial lesson's own keys (common/tutorial_lessons/_tutorial_lesson.info); every other block is a step. */
const LESSON_KEYS = new Set(['chain', 'start_automatically', 'trigger', 'gui_tag', 'highlight_widget', 'trigger_transition', 'delay', 'default_lesson_step_delay', 'finish_gamestate_tutorial', 'shown_in_encyclopedia']);

/** Where a lesson transition leads: another step, or the lesson's end. */
function lessonTarget(lesson: string, target: string | undefined): Rich
{
    if (target === 'lesson_finish')
        return ['finishes the lesson'];

    if (target === 'lesson_abort')
        return ['closes the lesson for now'];

    return target ? rich('goes on to ', { text: capitalize(humanize(target.replace(lesson + '_', ''))), kind: 'value', tip: target }) : ['—'];
}

/** A lesson (step)'s transitions: buttons (`gui_transition`, enabled when …) and automatic ones (`trigger_transition`). */
function transitionLines(b: StoryBuilder, lesson: string, list: PNode[], ctx: Ctx): Line[]
{
    const out: Line[] = [];

    for (const c of list)
    {
        if ((c.k !== 'gui_transition' && c.k !== 'trigger_transition') || !Array.isArray(c.v))
            continue;

        const target = lessonTarget(lesson, str(c.v, 'target'));
        const button = str(c.v, 'button_text');
        const conds = blockOf(c.v, c.k === 'gui_transition' ? 'enabled' : 'trigger');
        const l: Line = c.k === 'gui_transition'
            ? { text: rich('Button ', button ? quoted(b, button) : '', ' ', target, conds ? ' — enabled when:' : ''), icon: 'event' }
            : { text: rich(capitalize(b.d.richString(target)), ' by itself', button ? rich(' (button ', quoted(b, button), ')') : '', ' when:'), icon: 'if' };

        if (conds)
            l.conditions = charTriggers(b, conds, ctx);

        if (ctx.file)
            l.src = b.d.anchor(c, ctx, 'other', false);

        out.push(l);
    }

    return out;
}

export const LIFE_CARDS: Record<string, CardFn> = {
    ...ARTIFACT_CARDS,
    ...BOOKMARK_CARDS,

    // common/deathreasons/_death_reasons.info
    deathreasons: (b, x) =>
    {
        const { e, body, card, ctx } = x;
        card.title = capitalize(card.title);
        const epidemic = str(body, 'epidemic');
        const trigger = blockOf(body, 'natural_death_trigger');
        const kind = DEATH_KINDS[/death_(\w+)\.dds$/i.exec(str(body, 'icon') ?? '')?.[1] ?? ''];

        // (natural ones say so below)
        if (kind && !(kind === DEATH_KINDS.natural && (trigger || str(body, 'default') === 'yes')))
            card.facts.push([kind]);

        if (epidemic)
            card.facts.push(rich('From the epidemic ', b.d.ref(epidemic, ['epidemics'])));
        else if (trigger)
            card.facts.push([`Natural death, priority ${str(body, 'priority') ?? 0}`]);
        else if (str(body, 'default') === 'yes')
            card.facts.push(['Fallback natural death']);
        else
            card.facts.push([str(body, 'public_knowledge') === 'yes' ? 'The killer is known to all' : 'The killer can stay secret']);

        // the text after the character's name: `<key>`, `<key>_killer` when the killer is known
        const lines: Line[] = [];

        for (
            const [k, label] of [
                [e.name, ''],
                [e.name + '_killer', 'With the killer known: ']
            ]
        )
        {
            const t = b.d.loc(k);

            if (t)
                lines.push({ text: rich(label, '“', deathText(t), '”'), icon: 'death', tip: k });
        }

        addSection(card, 'How it reads', lines);
        triggerSection(b, card, trigger, 'Dies of it naturally when', ctx);
        settingsSection(b, x);
        b.genericSections(e, body, card, ctx, x.own, new Set(['icon', 'natural_death_trigger', 'public_knowledge', 'priority', 'default', 'epidemic', 'use_equipped_artifact_in_slot']));
        return true;
    },

    // common/character_memory_types/_character_memories.info
    character_memory_types: (b, x) =>
    {
        const { e, body, card, ctx } = x;
        card.title = capitalize(card.title);
        // (positive / negative first)
        const cats = words(blockOf(body, 'categories')).sort((p, q) => +/^(posi|nega)tive$/.test(q) - +/^(posi|nega)tive$/.test(p));

        if (cats.length)
            card.facts.push(rich(...cats.flatMap((c, i): (RichSeg | string)[] => [i ? ' · ' : '', c === 'positive' ? { text: 'Positive', kind: 'good' } : c === 'negative' ? { text: 'Negative', kind: 'bad' } : capitalize(humanize(c))])));

        const dur = durationText(b, kids(blockOf(body, 'duration')), ctx);

        if (dur)
            card.facts.push(rich('Remembered for ', dur));

        for (const [k, title] of MEMORY_TEXTS)
        {
            const n = body.find((c) => c.k === k);

            if (n)
                addSection(card, title, descLines(b, n, ctx), Array.isArray(n.v) ? b.blockSection(n, 'other', ctx) : undefined);
        }

        // (the first-person text is its section's)
        if (body.some((c) => c.k === 'description'))
            card.description = undefined;

        const who = blockOf(body, 'participants');

        if (who)
            addSection(card, 'Who else takes part', words(who).map((p) => ({ text: [{ text: capitalize(humanize(p)), kind: 'scope', tip: `memory_participant:${p}` }], icon: 'scope' })), b.blockSection(who, 'other', ctx));

        b.genericSections(e, body, card, ctx, x.own, new Set(['categories', 'icon', 'duration', 'participants', ...MEMORY_TEXTS.map(([k]) => k)]));
        return true;
    },

    // common/accolade_types/_accolade_type.info
    accolade_types: (b, x) =>
    {
        const { e, body, card, ctx } = x;
        const consts = b.idx.fileConstants(e);
        const catNode = blockOf(body, 'accolade_categories');
        const cats = words(catNode);
        // (the tier: `tier`, or one of the categories — 00_accolade_categories.txt)
        const tier = str(body, 'tier') ?? cats.find((c) => ['common', 'skilled', 'exceptional', 'eminent'].includes(c));

        if (tier)
            card.facts.push([`${capitalize(tier)} accolade`]);

        const adj = str(body, 'adjective');
        const noun = str(body, 'noun');
        const about: Line[] = [];

        if (adj || noun)
        {
            const n = body.find((c) => c.k === (adj ? 'adjective' : 'noun'))!;
            about.push({
                text: rich('Called ', adj ? rich(quoted(b, adj), noun ? ' or ' : '') : '', noun ? quoted(b, noun) : '', ' when no name of its own fits'),
                icon: 'note',
                tip: [adj && `adjective = ${adj}`, noun && `noun = ${noun}`].filter(Boolean).join('\n'),
                src: ctx.file ? b.d.anchor(n, ctx, 'other', false) : undefined
            });
        }

        if (catNode)
            about.push({
                text: rich(
                    'Categories: ',
                    cats.filter((c) => c !== tier)
                        .map(humanize)
                        .join(', ')
                ),
                icon: 'note',
                src: ctx.file ? b.d.anchor(catNode, ctx, 'other', false) : undefined
            });

        addSection(card, 'About', about);
        const ranks = blockOf(body, 'ranks');

        if (ranks)
        {
            const glory = gloryLevels(b);
            const lines = kids(ranks)
                .filter((r) => r.k && Array.isArray(r.v))
                .map((r) =>
                {
                    const n = Number(r.k);
                    const need = Number.isInteger(n) && n >= 1 && n <= glory.length ? `Rank ${n} — from ${glory[n - 1]} glory` : `From ${r.k} glory`;
                    const l: Line = { text: [need], icon: 'skill', children: rankLines(b, kids(r), ctx, consts), tip: r.k! };

                    if (ctx.file)
                        l.src = b.d.anchor(r, ctx, 'other', true);

                    return l;
                });
            addSection(card, 'Ranks', lines, b.blockSection(ranks, 'other', ctx));
        }

        triggerSection(b, card, blockOf(body, 'squire_perfect_fit'), 'A perfect fit', ctx, 'Anyone');
        triggerSection(b, card, blockOf(body, 'squire_acceptable_fit'), 'An acceptable fit', ctx, 'Anyone');
        b.genericSections(e, body, card, ctx, x.own, new Set(['adjective', 'noun', 'icon', 'portrait_pose', 'accolade_categories', 'tier', 'ranks', 'squire_perfect_fit', 'squire_acceptable_fit', 'weight']));
        const w = body.find((c) => c.k === 'weight');

        if (w)
            addSection(card, 'Chance to be picked', weightLines(b, Array.isArray(w.v) ? w.v : [{ ...w, k: 'value' }], ctx));

        return true;
    },

    // common/character_backgrounds: `trait` — what characters generated with the background (pool_character_selectors) get
    character_backgrounds: (b, x) =>
    {
        const trait = str(x.body, 'trait');

        if (trait)
            x.card.facts.push(rich('Comes with the trait ', b.d.ref(trait, ['traits'])));

        settingsSection(b, x);
        b.genericSections(x.e, x.body, x.card, x.ctx, x.own, new Set(['trait']));
        return true;
    },

    'situation/catalysts': catalyst,
    'struggle/catalysts': catalyst,

    // common/court_amenities/_court_amenities.info: a category of levels, left to right as written
    court_amenities: (b, { e, body, card, ctx, own }) =>
    {
        const levels = body.filter((c) => c.k && Array.isArray(c.v));
        const name = (k: string): string => b.d.richString(b.d.loc(k) ?? [capitalize(humanize(k))]);
        const def = str(body, 'default') ?? levels[0]?.k ?? undefined;
        card.facts.push([`${levels.length} levels`]);

        if (def)
            card.facts.push(rich('Starts at ', { text: name(def), kind: 'value', tip: def }));

        const ai: Line[] = [];
        levels.forEach((lv, i) =>
        {
            const lines: Line[] = [];
            const desc = b.d.loc(lv.k + '_desc');

            if (desc)
                lines.push({ text: rich('“', desc, '”'), icon: 'note', tip: lv.k + '_desc' });

            for (const c of kids(lv))
            {
                if (c.k === 'cost' && Array.isArray(c.v))
                    lines.push({ text: ['Costs:'], icon: 'gold', children: costLines(b, c.v, ctx), src: b.fieldAnchor(c, ctx, 'cost', true) });
                else if (c.k === 'owner_modifier' || c.k === 'courtier_guest_modifier')
                {
                    const g = modifierGroup(b, c, c.k === 'owner_modifier' ? 'The ruler:' : 'Courtiers and guests:', ctx);
                    const note = str(kids(lv), c.k + '_description');

                    if (note)
                        g.children!.push({ text: b.d.loc(note) ?? [humanize(note)], icon: 'note', tip: note });

                    lines.push(g);
                }
                else if (c.k === 'can_pick' && Array.isArray(c.v))
                    lines.push({ text: ['Can be picked when:'], icon: 'if', children: charTriggers(b, c, ctx), src: ctx.file ? b.d.anchor(c, ctx, 'trigger', true) : undefined });
                else if (c.k === 'ai_will_do' && Array.isArray(c.v))
                    ai.push({ text: [name(lv.k!) + ':'], children: weightLines(b, c.v, ctx), src: ctx.file ? b.d.anchor(c, ctx, 'other', false) : undefined });
            }

            card.sections.push({ title: `${i + 1}. ${name(lv.k!)}`, lines, src: b.blockSection(lv, 'other', ctx) });
        });
        b.genericSections(e, body, card, ctx, own, new Set(['default', ...levels.map((l) => l.k!)]));
        addSection(card, 'AI', ai);
        return true;
    },

    // common/tutorial_lessons/_tutorial_lesson.info
    tutorial_lessons: (b, x) =>
    {
        const { e, body, card, ctx } = x;

        if (str(body, 'start_automatically') === 'no')
            card.facts.push(['Started by script']);

        const chain = str(body, 'chain');

        if (chain)
            card.facts.push(rich('Chain: ', b.d.ref(chain, ['tutorial_lesson_chains'])));

        triggerSection(b, card, blockOf(body, 'trigger'), 'Starts when', ctx);
        settingsSection(b, x);
        addSection(card, 'While it is open', transitionLines(b, e.name, body, ctx));

        for (const step of body.filter((c) => c.k && Array.isArray(c.v) && !LESSON_KEYS.has(c.k)))
        {
            const list = kids(step);
            const lines: Line[] = [];
            const text = list.find((c) => c.k === 'text' && typeof c.v === 'string');

            if (text)
            {
                const key = text.v as string;
                lines.push({ text: trimmed(b.d.loc(key) ?? [humanize(key)]), icon: 'note', tip: key, src: ctx.file ? b.d.anchor(text, ctx, 'other', false) : undefined });

                // (the card's description is this text: `<lesson>_desc`)
                if (key === `${e.name}_desc`)
                    card.description = undefined;
            }

            const delay = str(list, 'delay');

            if (delay && delay !== '0')
                lines.push({ text: [`Waits ${delay} seconds before it shows`], icon: 'note', tip: `delay = ${delay}` });

            if (str(list, 'force_pause_game') === 'yes')
                lines.push({ text: ['Pauses the game until it moves on'], icon: 'note' });
            else if (str(list, 'pause_game') === 'yes')
                lines.push({ text: ['Pauses the game'], icon: 'note' });

            lines.push(...transitionLines(b, e.name, list, ctx));

            for (const k of ['effect', 'interface_effect'])
            {
                const n = blockOf(list, k);
                const effects = n && b.d.effects(kids(n), { ...ctx, scopeType: 'character' });

                // (only behind-the-scenes effects: the group is one too)
                if (n && effects)
                    lines.push({ text: [k === 'effect' ? 'Effects:' : 'Interface effects:'], icon: 'event', children: effects, hidden: effects.every((l) => l.hidden) || undefined, src: ctx.file ? b.d.anchor(n, ctx, 'effect', true) : undefined });
            }

            const title = capitalize(humanize(step.k!.startsWith(e.name + '_') ? step.k!.slice(e.name.length + 1) : step.k!));
            card.sections.push({ title, lines, src: b.blockSection(step, 'other', ctx) });
        }

        return true;
    },

    // common/legends/chronicles/_chronicles.info
    'legends/chronicles': (b, { e, body, card, ctx, own }) =>
    {
        // (without `name` / `description` blocks: the loc keys legend_chronicle_<key>, legend_chronicle_<key>_desc)
        const title = b.d.loc(`legend_chronicle_${e.name}`);

        if (title)
        {
            card.title = capitalize(b.d.richString(legendText(title)));
            card.titleKey = `legend_chronicle_${e.name}`;
        }

        const desc = card.description ?? b.d.loc(`legend_chronicle_${e.name}_desc`);
        card.description = desc && legendText(desc);

        if (desc && !card.descriptionKey)
            card.descriptionKey = `legend_chronicle_${e.name}_desc`;

        for (
            const [k, t] of [
                ['name', 'Name'],
                ['description', 'Description']
            ]
        )
        {
            const n = body.find((c) => c.k === k);

            if (n)
                addSection(card, t, descLines(b, n, ctx, legendText), b.blockSection(n, 'other', ctx));
        }

        const props = blockOf(body, 'properties');

        if (props)
            addSection(
                card,
                'What it is about',
                kids(props)
                    .filter((p) => p.k && typeof p.v === 'string')
                    .map((p) => ({ text: rich({ text: capitalize(humanize(p.k!)), kind: 'scope', tip: `scope:${p.k}` }, ' — ', /^[aeiou]/.test(p.v as string) ? 'an ' : 'a ', humanize(p.v as string)), icon: 'scope', src: ctx.file ? b.d.anchor(p, ctx, 'other', false) : undefined })),
                b.blockSection(props, 'other', ctx)
            );

        const chapters = blockOf(body, 'chapters');

        if (chapters)
        {
            card.facts.push([`${kids(chapters).length} chapters`]);
            addSection(
                card,
                'Chapters',
                kids(chapters).map((c) =>
                {
                    const label = c.k ?? (typeof c.v === 'string' ? c.v : '');
                    const loc = typeof c.v === 'string' && c.k ? b.d.loc(c.v) : undefined;
                    const text = loc && legendText(loc);
                    return { text: rich({ text: capitalize(humanize(label)), kind: 'value' }, text ? rich(': “', text, '”') : ' (no default text)'), icon: 'note', tip: c.k ? `${c.k} = ${c.v}` : label, src: ctx.file ? b.d.anchor(c, ctx, 'other', false) : undefined };
                }),
                b.blockSection(chapters, 'other', ctx)
            );
        }

        const impact = blockOf(body, 'impact');

        if (impact)
        {
            const WHO: Record<string, string> = { province_modifier: 'Provinces with the legend:', county_modifier: 'Counties whose capital adopted it:', owner_modifier: 'Its owner:', promoter_modifier: 'Everyone promoting it:' };
            const lines: Line[] = [];

            for (const c of kids(impact))
            {
                if (!c.k || !Array.isArray(c.v))
                    continue;

                if (WHO[c.k])
                    lines.push(modifierGroup(b, c, WHO[c.k], ctx));
                else if (c.k === 'on_complete')
                    lines.push({ text: ['When its owner completes it:'], icon: 'event', children: b.d.effects(c.v, { ...ctx, scopeType: 'character' }), src: ctx.file ? b.d.anchor(c, ctx, 'effect', true) : undefined });
            }

            addSection(card, 'Impact', lines, b.blockSection(impact, 'other', ctx));
        }

        b.genericSections(e, body, card, ctx, own, new Set(['name', 'description', 'properties', 'chapters', 'impact', 'portrait_animation']));
        return true;
    },

    // common/domiciles/types/_domicile_types.info
    'domiciles/types': (b, x) =>
    {
        const { e, body, card, ctx } = x;
        card.title = capitalize(card.title);
        const yes = (k: string): boolean => str(body, k) === 'yes';
        card.facts.push([yes('travel') ? (yes('provisions') ? 'Travels, on provisions' : 'Travels') : 'Stays in one place']);

        if (yes('herd'))
            card.facts.push(['Keeps a herd']);

        if (yes('culture_and_faith'))
            card.facts.push(['Has its own culture and faith']);

        triggerSection(b, card, blockOf(body, 'allowed_for_character'), 'Who can have it', ctx);
        settingsSection(b, x);
        const moving: Line[] = [];
        const cooldown = blockOf(body, 'move_cooldown');
        const every = cooldown && durationText(b, kids(cooldown), ctx);

        if (every)
            moving.push({ text: rich('Can be moved again after ', every), icon: 'note', tip: 'move_cooldown', src: ctx.file ? b.d.anchor(cooldown, ctx, 'other', false) : undefined });

        const cost = blockOf(body, 'move_cost');

        if (cost)
            moving.push({ text: ['Costs:'], icon: 'gold', children: costLines(b, kids(cost), ctx), src: b.fieldAnchor(cost, ctx, 'cost', true) });

        addSection(card, 'Moving it', moving);

        // the temperament modifiers: `name` (their loc) and a `scale` script value
        for (
            const [k, title] of [
                ['domicile_temperament_low_modifier', 'When most of the court dislikes them'],
                ['domicile_temperament_high_modifier', 'When most of the court likes them']
            ]
        )
        {
            const lines = body
                .filter((c) => c.k === k && Array.isArray(c.v))
                .map((c) =>
                {
                    const nm = str(kids(c), 'name');
                    const g = modifierGroup(b, c, nm ? b.d.richString(b.d.loc(nm) ?? [humanize(nm)]) + ':' : 'Modifiers:', ctx);
                    const scale = blockOf(kids(c), 'scale');

                    if (scale)
                        g.children!.push({ text: ['Scaled by:'], icon: 'chance', children: b.formula(kids(scale), ctx) });

                    return g;
                });
            addSection(card, title, lines);
        }

        const slots = blockOf(body, 'domicile_building_slots');

        if (slots)
            addSection(
                card,
                'Building slots',
                kids(slots)
                    .filter((s) => s.k && Array.isArray(s.v))
                    .map((s) => ({ text: rich({ text: capitalize(humanize(s.k!)), kind: 'value' }, str(kids(s), 'slot_type') === 'main' ? ' — the main building' : ' — an external building'), icon: 'note', tip: s.k!, src: ctx.file ? b.d.anchor(s, ctx, 'other', false) : undefined })),
                b.blockSection(slots, 'other', ctx)
            );

        b.genericSections(e, body, card, ctx, x.own, new Set(['allowed_for_character', 'move_cooldown', 'move_cost', 'domicile_temperament_low_modifier', 'domicile_temperament_high_modifier', 'domicile_building_slots', 'domicile_asset', 'map_entity']));
        return true;
    }
};
