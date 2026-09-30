/** Cards: Scripted helpers — scripted modifiers, rules, costs, lists, animations, relations, character templates, pool selectors, agent types, guest invite rules and management, ruler objective advice, achievements, activity intents. */
import type { PNode } from '../../indexer/parser.ts';
import type { Entity } from '../../indexer/gameIndex.ts';
import type { EntityCard, FollowUp, Line, Rich } from '../../../shared/api.ts';
import { fieldOf } from '../../../shared/fieldCatalog.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import { capitalize, humanize, rich, signed } from '../text.ts';
import type { CardFn } from './types.ts';
import { conditional, operand, subjectOf, valueLines, weightLines } from './weight.ts';
import { templateCard } from './scripted-templates.ts';
import { blockOf, capFirst, joinRich, listOf, plural, raw, scalarOf } from './scripted-common.ts';

/** The comment lines right above a statement in the definition's text (`# Can this character visit a court?`). */
function commentAbove(src: string, n: PNode): string[]
{
    const lines: string[] = [];
    let end = src.lastIndexOf('\n', n.s - 1);

    while (end > 0)
    {
        const start = src.lastIndexOf('\n', end - 1) + 1;
        const line = src.slice(start, end).trim();

        if (!line.startsWith('#'))
            break;

        lines.unshift(line);
        end = start - 1;
    }

    return lines;
}

type Role = { name: string; who: string; };

/**
 * What comment lines say: who root and the scopes are ("Root is the potential commander", "root: Character
 * hybridizing", "root, scope:guest = the potential guest"), the rest as notes (commented-out script left out).
 */
function roles(lines: string[]): { notes: string[]; who: Role[]; }
{
    const notes: string[] = [];
    const who: Role[] = [];

    for (const raw of lines)
    {
        const t = raw.replace(/^[#\s]+/, '').trim();

        if (!t || /^[=\-*#\s]+$/.test(t))
            continue;

        const m = /^((?:(?:root|scope:\w+)[\s,]*(?:and\s+)?)+?)\s*(?:=|:|-|–|\bis\b|\bare\b)\s*(.+)$/i.exec(t);

        if (m)
        {
            for (const n of m[1].split(/[\s,]+/).filter((x) => x && x !== 'and'))
                who.push({ name: /^root$/i.test(n) ? 'root' : n, who: m[2].replace(/\.$/, '') });

            continue;
        }

        if (!/[{}]|^\w+\s*=\s*\S/.test(t))
            notes.push(t);
    }

    return { notes, who };
}

/** Who's who lines: "You — the potential commander", "Army Owner — who owns the army to command". */
function whoLines(b: StoryBuilder, who: Role[], ctx: Ctx): Line[]
{
    // (names for the same one share a line: "You, Guest — the potential guest")
    const same = new Map<string, Role[]>();

    for (const w of who)
        same.set(w.who, [...(same.get(w.who) ?? []), w]);

    return [...same].map(([text, ws]) => ({ text: rich(joinRich(ws.map((w) => [w.name === 'root' ? 'You' : b.d.scopeSeg(w.name, ctx, true)]), ', '), ' — ', text), icon: 'scope' }));
}

/** Comment lines as one text, each ending as a sentence. */
function sentences(notes: string[]): string
{
    return notes.map((n) => (/[.!?:;)]$/.test(n) ? n : n + '.')).join(' ');
}

/**
 * A definition's comment above it: the description (when it has no text of its own) and a "Who’s who" section — added
 * after the card's own sections (the hover card shows the first section with lines).
 */
function docSections(b: StoryBuilder, e: Entity, card: EntityCard, ctx: Ctx): void
{
    const doc = b.idx.winningDef(e)?.doc;

    if (!doc)
        return;

    const { notes, who } = roles(doc.split('\n'));

    if (notes.length && !card.description)
        card.description = [sentences(notes)];

    if (who.length)
        card.sections.push({ title: 'Who’s who', lines: whoLines(b, who, ctx) });
}

/**
 * A definition's own settings (a field set of shared/fields/scripted.ts), one line per written value; entries a field
 * names (`kind: 'ref'`) as links.
 */
function settingLines(b: StoryBuilder, type: string, nodes: PNode[], ctx: Ctx): Line[]
{
    return nodes.flatMap((c) =>
    {
        const f = c.k && typeof c.v === 'string' ? fieldOf(type, c.k) : undefined;

        if (!f || f.kind !== 'ref' || typeof f.read !== 'string')
            return b.fieldLines(type, [c], ctx);

        const [before, after] = f.read.split('$');
        return [{ text: rich(capitalize(before), b.d.ref(c.v as string, f.ref ? [f.ref] : undefined), after), tip: `${c.k} = ${c.v}`, src: ctx.file && b.fieldAnchor(c, ctx, type) }];
    });
}

/**
 * A scripted modifier's statements with its `$PARAM$`s read as named scopes (`$CHARACTER$ = { … }` → "Character:",
 * `multiply = $SCALE$` → "× Scale", `$A$.$B$` → "A’s b") and the file's `@constants` as their values; the nodes keep
 * their offsets (anchors, tooltips show the text as written).
 */
function paramScopes(list: PNode[], consts: Map<string, string>): PNode[]
{
    const name = (s: string): string => (s.startsWith('$') ? s.replace(/^\$(\w+)\$(?=\.|$)/, (_m, p: string) => 'scope:' + p).replace(/\.\$(\w+)\$(?=\.|$)/g, '.$1') : s.startsWith('@') ? (consts.get(s.slice(1)) ?? s) : s);
    return list.map((n) => ({ ...n, k: n.k && name(n.k), v: typeof n.v === 'string' ? name(n.v) : paramScopes(n.v, consts) }));
}

/** An animation name (gfx/portraits/portrait_animations) as a value. */
function animSeg(name: string): Rich
{
    return [{ text: capitalize(humanize(name)), kind: 'value', tip: name }];
}

/**
 * What a scripted animation's statements show (common/scripted_animations/_scripted_animations.info): `animation` (one,
 * or `{ a b c }`: one of them at random), `scripted_animation` (another scripted animation), `camera`.
 */
function animationOf(b: StoryBuilder, list: PNode[]): Rich
{
    const parts: Rich[] = [];

    for (const c of list)
    {
        if (c.k === 'animation')
        {
            if (typeof c.v === 'string')
                parts.push(animSeg(c.v));
            else
            {
                const names = c.v.filter((x) => typeof x.v === 'string').map((x) => animSeg(x.v as string));
                parts.push(names.length > 1 ? rich('one of ', joinRich(names, ' or '), ' at random') : rich(...names));
            }
        }
        else if (c.k === 'scripted_animation' && typeof c.v === 'string')
            parts.push(rich('as ', b.d.ref(c.v, ['scripted_animations'])));
    }

    const camera = scalarOf(list, 'camera');
    return parts.length ? rich(joinRich(parts, ' or '), camera ? rich(' (camera: ', humanize(camera), ')') : '') : [];
}

/** The animations of a scripted animation: each `triggered_animation` with its conditions (the first that applies), then the default. */
function animationLines(b: StoryBuilder, list: PNode[], ctx: Ctx): Line[]
{
    const out: Line[] = [];

    for (const c of list)
    {
        if (c.k !== 'triggered_animation' || !Array.isArray(c.v))
            continue;

        const t = blockOf(c.v, 'trigger');
        out.push({ ...conditional(b, capFirst(animationOf(b, c.v)), t ? b.d.triggers(t.v, ctx) : []), tip: raw(c, ctx), src: ctx.file && b.d.anchor(c, ctx, 'other', false) });
    }

    const fallback = animationOf(b, list);

    if (fallback.length)
        out.push({
            text: out.length ? rich('Otherwise: ', fallback) : capFirst(fallback),
            tip: list.filter((c) => typeof c.v === 'string')
                .map((c) => `${c.k} = ${c.v}`)
                .join('\n')
        });

    return out;
}

/**
 * A guest invite rule's `effect` (activities/guest_invite_rules/_invite_rules.info): who it puts in the list
 * `characters` — "Every relation (Friend)", "Your liege" — with the iterators' limits as conditions; other effects as
 * they read.
 */
function invited(b: StoryBuilder, list: PNode[], ctx: Ctx): Line[]
{
    const out: Line[] = [];
    const isInvite = (l: Line): boolean => !l.children && l.text.length === 1 && l.text[0] === 'Invited';

    for (const c of list)
    {
        if (!c.k)
            continue;

        const src = ctx.file && b.d.anchor(c, ctx, 'effect', Array.isArray(c.v));

        // (another list: gathered for a scripted effect that picks the guests from it)
        if (c.k === 'add_to_list' && typeof c.v === 'string')
        {
            out.push({ text: c.v === 'characters' ? ['Invited'] : rich('Put on the list ', { text: `“${humanize(c.v)}”`, kind: 'code', tip: c.v }), icon: 'note', tip: raw(c, ctx), src });
            continue;
        }

        const block = Array.isArray(c.v) ? c.v : null;
        const it = block && /^(every|random|ordered)_(\w+)$/.exec(c.k);
        // (`x ?= { }`: in x when it exists — a scope link the describer may not know, like suzerain)
        const scope = block && !it && (b.d.isScopeKey(c.k) || c.op === '?=');
        const branch = block && (c.k === 'if' || c.k === 'else_if' || c.k === 'else');

        if (!block || (!it && !scope && !branch) || b.idx.get('scripted_effects', c.k))
        {
            out.push(...b.d.effects([c], ctx));
            continue;
        }

        const limit = scope ? undefined : blockOf(block, 'limit');
        const conds = limit ? b.d.triggers(limit.v, ctx) : [];
        const type = it ? scalarOf(block, 'type') : undefined;
        const label = it ? `the ${humanize(it[2])}` : scope ? b.d.scopeLabel(c.k, ctx) : ctx.scope;
        const kids = invited(
            b,
            block.filter((x) => x.k !== 'limit' && x.k !== 'type'),
            { ...ctx, scope: label, scopeType: undefined }
        );

        if (!kids.length)
            continue;

        let head: Rich;

        if (it)
            head = rich(it[1] === 'every' ? 'Every ' : it[1] === 'random' ? 'One random ' : 'The best ', humanize(it[2]), type ? rich(' (', b.d.ref(type, ['scripted_relations']), ')') : '');
        else if (scope)
            head = [b.d.scopeSeg(c.k, ctx, true)];
        else
            head = [c.k === 'else' ? 'Otherwise' : c.k === 'if' ? 'If' : 'Otherwise, if'];

        // (only "Invited" inside: the head says who)
        const only = kids.length === 1 && isInvite(kids[0]);
        const l = branch ? conditional(b, head, conds, true, ' ', subjectOf(ctx)) : conditional(b, head, conds, !only, ' that ', null);
        out.push({ ...l, children: only && !branch ? undefined : kids, icon: it ? 'loop' : scope ? 'scope' : c.k === 'else' ? 'else' : 'if', tip: raw(c, ctx), src });
    }

    return out;
}

/** `guest_description = { description = { limit weight desc } … }`: each text, its weight, when it applies. */
function descriptionLines(b: StoryBuilder, list: PNode[], ctx: Ctx): Line[]
{
    // a dynamic description's text: its parts in order, the variants of a first_valid / random_valid as "a / b"
    const text = (n: PNode): Rich =>
    {
        if (typeof n.v === 'string')
            return n.v ? (b.d.loc(n.v) ?? [humanize(n.v)]) : [];

        if (n.k === 'first_valid' || n.k === 'random_valid')
            return joinRich(n.v.map(text).filter((t) => t.length), ' / ');

        return rich(...n.v.filter((x) => x.k === 'desc' || x.k === 'triggered_desc' || x.k === 'first_valid' || x.k === 'random_valid').map(text));
    };
    return list
        .filter((c): c is PNode & { v: PNode[]; } => c.k === 'description' && Array.isArray(c.v))
        .map((c) =>
        {
            const desc = c.v.find((x) => x.k === 'desc');
            const limit = blockOf(c.v, 'limit');
            const weight = blockOf(c.v, 'weight');
            const base = weight && weight.v.length === 1 ? scalarOf(weight.v, 'base') : undefined;
            const head = rich('“', desc ? text(desc) : '…', '”', base ? rich(' — weight ', operand(b, base, ctx)) : '');
            const l: Line = { ...conditional(b, head, limit ? b.d.triggers(limit.v, ctx) : []), icon: 'note', tip: raw(c, ctx), src: ctx.file && b.d.anchor(c, ctx, 'other', false) };

            if (weight && !base)
                l.children = [{ text: ['Weight:'], children: weightLines(b, weight.v, ctx) }];

            return l;
        });
}

/** The blocks of the courtier / guest management (common/courtier_guest_management): section title and what it holds. */
const MANAGEMENT: Record<string, [string, 'trigger' | 'weight' | 'descriptions']> = {
    guest_can_arrive: ['Can arrive when', 'trigger'],
    guest_score: ['Which guests arrive first', 'weight'],
    guest_description: ['How a guest is described', 'descriptions'],
    can_leave: ['Wants to leave when', 'trigger'],
    monthly_leave_chance_x10: ['Chance to leave each month (‰)', 'weight']
};

/** schemes/agent_types/_agent_types.info: what an agent adds to (the field set's choices). */
const contributionLabel = (v: string): string => fieldOf('schemes/agent_types', 'contribution_type')?.options?.find(([k]) => k === v)?.[1] ?? capitalize(humanize(v));

/** activities/intents/_intents.info `ai_target_quick_trigger`: cheap checks on the target. */
const QUICK_TARGET: Record<string, string> = { adult: 'an adult', attracted_to_owner: 'attracted to the one picking it', owner_attracted: 'attractive to the one picking it', prison: 'in prison' };

export const SCRIPTED_CARDS: Record<string, CardFn> = {
    // common/scripted_modifiers/_scripted_modifiers.info: a weight block used by name, with $PARAM$ arguments
    scripted_modifiers: (b, { e, body, card, ctx, own }) =>
    {
        const params = [...new Set([...ctx.src.matchAll(/\$(\w+)\$/g)].map((m) => m[1]))];

        if (params.length)
            card.facts.push(rich('Arguments: ', joinRich(params.map((p) => [{ text: capitalize(humanize(p)), kind: 'ph', tip: `$${p}$` }]))));

        card.sections.push({ title: 'How it weighs', lines: weightLines(b, paramScopes(body, b.idx.fileConstants(e)), ctx), src: own('field', 'weight') });
        return true;
    },

    // common/scripted_rules: conditions the game itself checks (the comment above says when and who root is)
    scripted_rules: (b, { e, body, card, ctx, own }) =>
    {
        card.sections.push({ title: 'Holds when', lines: b.d.triggers(body, ctx), src: own('trigger') });
        docSections(b, e, card, ctx);
        return true;
    },

    // common/scripted_costs: a script value per resource (`add = { value desc format }`: the breakdown lines), `round`
    scripted_costs: (b, { e, body, card, ctx, own }) =>
    {
        const lines: Line[] = [];

        for (const c of body)
        {
            if (!c.k)
                continue;

            if (c.k === 'round')
            {
                if (c.v === 'yes')
                    card.facts.push(['Rounded to whole numbers']);

                continue;
            }

            const label = capitalize(humanize(c.k));
            const src = ctx.file && b.fieldAnchor(c, ctx, 'cost');

            if (typeof c.v === 'string')
                lines.push({ text: rich(operand(b, c.v, ctx), ' ', label), icon: c.k, tip: `${c.k} = ${c.v}`, src });
            else
                lines.push({ text: [label + ':'], icon: c.k, children: valueLines(b, c.v, ctx), tip: raw(c, ctx), src });
        }

        card.sections.push({ title: 'Cost', lines, src: own('field', 'cost') });
        docSections(b, e, card, ctx);
        return true;
    },

    // common/scripted_lists: `base` (a list the game has: vassal, held_title …) narrowed by `conditions`, iterated as any_/every_/random_/ordered_<name>
    scripted_lists: (b, { e, body, card, ctx }) =>
    {
        const base = scalarOf(body, 'base');
        const what = base ? humanize(base) : 'item';

        if (base)
            card.facts.push(rich('Narrows the list of ', { text: plural(what), kind: 'value', tip: `base = ${base}` }));

        card.facts.push(rich('Used as ', { text: `every_${e.name}`, kind: 'code' }, ' (and any_, random_, ordered_)'));
        const conds = blockOf(body, 'conditions');
        const lines = conds ? b.d.triggers(conds.v, { ...ctx, scope: `the ${what}`, scopeType: undefined }) : [];
        card.sections.push({ title: `Which ${plural(what)} it lists`, lines, src: conds && b.blockSection(conds, 'trigger', ctx) });
        return true;
    },

    scripted_animations: (b, { body, card, ctx, own }) =>
    {
        card.sections.push({ title: 'Which animation', lines: animationLines(b, body, ctx), src: own('other') });
        return true;
    },

    // common/scripted_relations/_scripted_relations.info
    scripted_relations: (b, { e, body, card, ctx, own }) =>
    {
        const op = scalarOf(body, 'opinion');

        if (op)
        {
            const n = b.d.evalValue(op);
            card.facts.push(rich('Opinion ', n !== undefined ? { text: signed(n), kind: n >= 0 ? 'good' : 'bad' } : b.d.valueSeg(op, ctx)));
        }

        const other = scalarOf(body, 'corresponding');

        if (other)
            card.facts.push(other === e.name ? ['Two-way'] : rich('Paired with ', b.d.ref(other, ['scripted_relations'])));

        if (scalarOf(body, 'hidden') === 'yes')
            card.facts.push(['Hidden']);

        const lines = settingLines(
            b,
            'scripted_relations',
            body.filter((c) => typeof c.v === 'string'),
            ctx
        );
        const lists: [string, string, string?][] = [
            ['opposites', 'Opposite of ', 'scripted_relations'],
            ['relation_aliases', 'Also counts as ', 'scripted_relations'],
            ['flags', 'Can carry the flags ']
        ];

        for (const [k, label, type] of lists)
        {
            const n = blockOf(body, k);
            const names = listOf(n);

            if (!n || !names.length)
                continue;

            const segs = names.map((x) => [type ? b.d.ref(x, [type]) : { text: `“${humanize(x)}”`, kind: 'code' as const, tip: x }]);
            lines.push({ text: rich(label, joinRich(segs)), icon: k === 'flags' ? 'flag' : 'opinion', tip: raw(n, ctx), src: ctx.file && b.d.anchor(n, ctx, 'other', false) });
        }

        card.sections.push({ title: 'Settings', lines, src: own('field', 'scripted_relations') });
        const mod = blockOf(body, 'modifier');

        if (mod)
            card.sections.push({ title: 'Modifiers', lines: b.d.statsOf(mod.v, ctx), src: b.blockSection(mod, 'modifier', ctx) });

        // each relation has its on_actions: on_set_relation_<key>, on_remove_relation_<key>, on_death_relation_<key>
        const hooks: Line[] = [];

        for (
            const [when, label] of [
                ['set', 'When it is set'],
                ['remove', 'When it is removed'],
                ['death', 'When its holder is about to die']
            ]
        )
        {
            const oa = b.idx.get('on_action', `on_${when}_relation_${e.name}`);

            if (oa)
                hooks.push({ text: rich(label, ': ', b.d.entitySeg(oa)), icon: 'event' });
        }

        if (hooks.length)
            card.sections.push({ title: 'On actions', lines: hooks });

        return true;
    },

    scripted_character_templates: templateCard,

    // common/pool_character_selectors/_pool_character_selectors.info: root is the pool character considered
    pool_character_selectors: (b, { body, card, ctx, own }) =>
    {
        const cfg = blockOf(body, 'config')?.v ?? [];
        const bg = scalarOf(cfg, 'background');

        if (bg)
            card.facts.push(rich('Background: ', b.d.ref(bg, ['character_backgrounds'])));

        const age = blockOf(cfg, 'age');
        const ages = age ? age.v.filter((x) => typeof x.v === 'string').map((x) => operand(b, x.v as string, ctx)) : [];

        if (ages.length === 2)
            card.facts.push(rich('Aged ', ages[0], '–', ages[1]));

        const valid = blockOf(body, 'valid_character');

        if (valid)
            card.sections.push({ title: 'Who can be picked', lines: b.d.triggers(valid.v, ctx), src: b.blockSection(valid, 'trigger', ctx) });

        const score = blockOf(body, 'character_score');

        if (score)
            card.sections.push({ title: 'How they are scored', lines: weightLines(b, score.v, ctx), src: b.blockSection(score, 'field', ctx, 'weight') });

        const settings: Line[] = [];

        for (const c of body)
        {
            if (!c.k || typeof c.v !== 'string')
                continue;

            const n = c.k === 'selection_count' ? b.d.evalValue(c.v) : undefined;
            const text = c.k === 'selection_count'
                ? (n !== undefined && n <= 0 ? ['Picks among all valid ones'] : n === 1 ? ['Always picks the best one'] : rich('Picks at random among the ', b.d.valueSeg(c.v, ctx), ' best'))
                : rich(capitalize(humanize(c.k)), ': ', { text: humanize(c.v), kind: 'value' as const, tip: c.v });
            settings.push({ text, tip: `${c.k} = ${c.v}`, src: ctx.file && b.d.anchor(c, ctx, 'other', false) });
        }

        if (settings.length)
            card.sections.push({ title: 'Settings', lines: settings, src: own('other') });

        const who = [
            { name: 'root', who: 'the pool character considered' },
            { name: 'scope:base', who: 'the base character, usually the council owner or the predecessor' }
        ];
        card.sections.push({ title: 'Who’s who', lines: whoLines(b, who, ctx) });
        return true;
    },

    // common/schemes/agent_types/_agent_types.info: root is the agent; scope:owner, scope:target, scope:scheme
    'schemes/agent_types': (b, { body, card, ctx, own }) =>
    {
        const type = body.find((c) => c.k === 'contribution_type' && typeof c.v === 'string');

        if (type)
            card.facts.push(rich('Contributes to ', { text: contributionLabel(type.v as string), kind: 'value', tip: `contribution_type = ${type.v}` }));

        const valid = blockOf(body, 'valid_agent_for_slot');

        if (valid)
            card.sections.push({ title: 'Who can fill the slot', lines: b.d.triggers(valid.v, ctx), src: b.blockSection(valid, 'trigger', ctx) });

        const contribution = blockOf(body, 'contribution');

        if (contribution)
            card.sections.push({ title: 'How much they contribute', lines: valueLines(b, contribution.v, ctx), src: b.blockSection(contribution, 'field', ctx, 'script_value') });

        card.sections.push({ title: 'Settings', lines: type ? b.fieldLines('schemes/agent_types', [type], ctx) : [], src: own('field', 'schemes/agent_types') });
        return true;
    },

    // activities/guest_invite_rules/_invite_rules.info: root is the host; the effect adds the guests to the list `characters`
    'activities/guest_invite_rules': (b, { body, card, ctx }) =>
    {
        const effect = blockOf(body, 'effect');
        card.sections.push({ title: 'Who is invited', lines: effect ? invited(b, effect.v, ctx) : [], src: effect && b.blockSection(effect, 'effect', ctx) });
        return true;
    },

    // common/courtier_guest_management: the blocks the game evaluates for guests and courtiers, each documented above
    courtier_guest_management: (b, { body, card, ctx }) =>
    {
        const who = new Map<string, Role>();

        for (const c of body)
        {
            if (!c.k || !Array.isArray(c.v))
                continue;

            const [title, kind] = MANAGEMENT[c.k] ?? [capitalize(humanize(c.k)), 'trigger'];
            const doc = roles(commentAbove(ctx.src, c));

            for (const w of doc.who)
                if (!who.has(w.name))
                    who.set(w.name, w);

            const lines: Line[] = doc.notes.length ? [{ text: [sentences(doc.notes)], icon: 'note' }] : [];

            if (kind === 'trigger')
                lines.push(...b.d.triggers(c.v, ctx));
            else if (kind === 'weight')
                lines.push(...weightLines(b, c.v, ctx));
            else
                lines.push(...descriptionLines(b, c.v, ctx));

            card.sections.push({ title, lines, src: kind === 'trigger' ? b.blockSection(c, 'trigger', ctx) : kind === 'weight' ? b.blockSection(c, 'field', ctx, 'weight') : b.blockSection(c, 'other', ctx) });
        }

        if (who.size)
            card.sections.push({ title: 'Who’s who', lines: whoLines(b, [...who.values()], ctx) });

        return true;
    },

    // common/guest_system: effects the game runs (the comment above says when)
    guest_system: (b, { e, body, card, ctx, own }) =>
    {
        const fctx = { ...ctx, followUps: [] as FollowUp[] };
        card.sections.push({ title: 'What it does', lines: b.d.effects(body, fctx), followUps: fctx.followUps, src: own('effect') });
        docSections(b, e, card, ctx);
        return true;
    },

    // common/ruler_objective_advice_types/_ruler_objective_advice_types.info
    ruler_objective_advice_types: (b, { body, card, ctx }) =>
    {
        const text = (k: string): Rich | undefined =>
        {
            const v = scalarOf(body, k);
            return v ? (b.d.loc(v) ?? [humanize(v)]) : undefined;
        };
        card.description = text('description') ?? card.description;

        if (scalarOf(body, 'description') && b.idx.plainLoc(scalarOf(body, 'description')!) !== undefined)
            card.descriptionKey = scalarOf(body, 'description');

        const summary = text('summary');

        if (summary)
            card.facts.push(rich('“', summary, '”'));

        const names = listOf(blockOf(body, 'decisions')).map((x) => [b.d.ref(x, ['decisions'])]);

        if (names.length)
            card.facts.push(rich('Advice for ', joinRich(names, ' and ')));

        const triggers: Record<string, string> = { is_valid_advice: 'Relevant when', is_doing: 'Already followed when', is_valid_for_title: 'Fits a title when' };

        for (const c of body)
        {
            if (!c.k || !Array.isArray(c.v))
                continue;

            if (triggers[c.k])
                card.sections.push({ title: triggers[c.k], lines: b.d.triggers(c.v, ctx), src: b.blockSection(c, 'trigger', ctx) });
            else if (c.k === 'relevance')
                card.sections.push({ title: 'How relevant it is', lines: valueLines(b, c.v, ctx), src: b.blockSection(c, 'field', ctx, 'script_value') });
        }

        const who = [
            { name: 'root', who: 'the one taking the objective decision (the player)' },
            { name: 'scope:title', who: 'the title the advice is evaluated for' },
            { name: 'scope:doing', who: 'whether you already follow it (after “Already followed when”)' }
        ];
        card.sections.push({ title: 'Who’s who', lines: whoLines(b, who, ctx) });
        return true;
    },

    // common/achievements/_achievements.info: name ACHIEVEMENT_<key>, description ACHIEVEMENT_DESC_<key>; `happened` holds one custom_description
    achievements: (b, { e, body, card, ctx }) =>
    {
        const name = b.d.loc(`ACHIEVEMENT_${e.name}`);

        if (name)
        {
            card.title = b.d.richString(name);
            card.titleKey = `ACHIEVEMENT_${e.name}`;
        }

        const desc = b.d.loc(`ACHIEVEMENT_DESC_${e.name}`);

        if (desc)
        {
            card.description = desc;
            card.descriptionKey = `ACHIEVEMENT_DESC_${e.name}`;
        }

        const possible = blockOf(body, 'possible');
        // (an empty `possible`: always)
        const lines = possible ? b.d.triggers(possible.v, ctx) : [];

        if (possible)
            card.sections.push({ title: 'Can be earned in this game when', lines: lines.length ? lines : [{ text: ['Always'] }], src: b.blockSection(possible, 'trigger', ctx) });

        const happened = blockOf(body, 'happened');

        if (happened)
        {
            // (its custom_description's text is the description again: the conditions inside are what counts)
            const kids = happened.v.filter((c) => c.k);
            const inner = kids.length === 1 && kids[0].k === 'custom_description' && Array.isArray(kids[0].v) ? (kids[0] as PNode & { v: PNode[]; }) : undefined;
            const nodes = inner ? inner.v.filter((c) => !['text', 'subject', 'object', 'value'].includes(c.k ?? '')) : happened.v;
            card.sections.push({ title: 'Earned when', lines: b.d.triggers(nodes, ctx), src: b.blockSection(inner ?? happened, 'trigger', ctx) });
        }

        return true;
    },

    // activities/intents/_intents.info: root is the character picking the intent, scope:target its target
    'activities/intents': (b, { e, body, card, ctx, own }) =>
    {
        if (scalarOf(body, 'auto_complete') === 'yes')
            card.facts.push([{ text: 'Completes on its own', kind: 'value', tip: 'auto_complete = yes' }]);

        b.genericSections(e, body, card, ctx, own, new Set(['icon', 'auto_complete', 'ai_will_do', 'ai_target_score', 'ai_targets', 'ai_target_quick_trigger', 'is_target_valid', 'scripted_animation']));
        const targets: Line[] = [];

        for (const c of body)
        {
            if (c.k === 'is_target_valid' && Array.isArray(c.v))
                card.sections.push({ title: 'Valid targets', lines: b.d.triggers(c.v, ctx), src: b.blockSection(c, 'trigger', ctx) });
            else if (c.k === 'ai_will_do' && Array.isArray(c.v))
                card.sections.push({ title: 'How much the AI wants it', lines: weightLines(b, c.v, ctx), src: b.blockSection(c, 'field', ctx, 'weight') });
            else if (c.k === 'ai_target_score' && Array.isArray(c.v))
                card.sections.push({ title: 'Which target the AI picks', lines: weightLines(b, c.v, ctx), src: b.blockSection(c, 'field', ctx, 'weight') });
            else if (c.k === 'ai_targets' && Array.isArray(c.v))
            {
                // (one line per block: its lists, how many of them at most, the chance each is looked at)
                const lists = c.v.filter((x) => x.k === 'ai_recipients' && typeof x.v === 'string').map((x) => [{ text: capitalize(humanize(x.v as string)), kind: 'value' as const, tip: x.v as string }]);
                const max = scalarOf(c.v, 'max');
                const chance = scalarOf(c.v, 'chance');

                if (lists.length)
                    targets.push({ text: rich(joinRich(lists), max ? rich(', at most ', b.d.valueSeg(max, ctx)) : '', chance ? rich(', each with a chance of ', b.d.valueSeg(chance, ctx)) : ''), icon: 'scope', tip: raw(c, ctx), src: ctx.file && b.d.anchor(c, ctx, 'other', false) });
            }
            else if (c.k === 'ai_target_quick_trigger' && Array.isArray(c.v))
            {
                const musts = c.v.filter((x) => x.k && x.v === 'yes').map((x) => QUICK_TARGET[x.k!] ?? humanize(x.k!));

                if (musts.length)
                    targets.push({ text: [`Only those who are ${musts.join(', ')}`], tip: raw(c, ctx), src: ctx.file && b.d.anchor(c, ctx, 'other', false) });
            }
            else if (c.k === 'scripted_animation')
            {
                const lines = typeof c.v === 'string' ? [{ text: rich('Shown as ', b.d.ref(c.v, ['scripted_animations'])), tip: `scripted_animation = ${c.v}` }] : animationLines(b, c.v, ctx);
                card.sections.push({ title: 'Animation', lines, src: b.blockSection(c, 'other', ctx) });
            }
        }

        if (targets.length)
            card.sections.push({ title: 'Whom the AI considers', lines: targets });

        return true;
    }
};
