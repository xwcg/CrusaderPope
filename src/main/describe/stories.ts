/**
 * Builds the readable views: event stories, on_action stories and tooltip-style cards for everything else.
 */
import type { PNode } from '../indexer/parser.ts';
import type { Entity, GameIndex } from '../indexer/gameIndex.ts';
import { descriptionCandidates, displayNameCandidates, typeLabel } from '../indexer/schema.ts';
import { riteHistory } from '../indexer/layouts.ts';
import { BOOKMARK_DATE } from '../portraits/modifiers.ts';
import type {
    CardSection,
    CastMember,
    DescNode,
    EntityCard,
    EventScene,
    EventCast,
    EventPortrait,
    OnActionInfo,
    EventStory,
    FollowUp,
    Line,
    FieldSuggestion,
    LineSource,
    LocCodes,
    ModifierKeyInfo,
    OnActionStory,
    PickTarget,
    Rich,
    RichSeg,
    SectionSource,
    StoryOption,
    StoryOrigin,
    TooltipInfo,
    UsageSummary
} from '../../shared/api.ts';
import { Describer, rootCtx, type Ctx } from './describer.ts';
import { FIELDS, bareField, fieldOf, fieldText } from '../../shared/fieldCatalog.ts';
import { capitalize, formatNumber, humanize, rich, richToString, titleCase } from './text.ts';
import { TYPE_CARDS } from './cards/index.ts';
import { doctrineGroups } from './cards/culture-faith.ts';
import { paramLines } from './cards/culture-util.ts';
import { TRIGGER_BLOCKS } from './scriptKeys.ts';
import { modifierScopeOf, scopeTypeByName } from '../../shared/scriptCatalog.ts';
import { weightLines } from './cards/weight.ts';

const EVENT_KIND: Record<string, string> = {
    character_event: 'Event',
    letter_event: 'Letter',
    court_event: 'Court event',
    activity_event: 'Activity event',
    duel_event: 'Duel',
    none: 'Background event',
    empty: 'Background event'
};

const TRIGGER_SECTIONS: Record<string, string> = {
    is_shown: 'Shown when',
    potential: 'Available when',
    is_valid: 'Requirements',
    is_valid_showing_failures_only: 'Requirements',
    can_send: 'Can be sent when',
    can_pick: 'Can be picked when',
    can_be_picked: 'Can be picked when',
    allow: 'Allowed when',
    can_create: 'Can be created when',
    can_start: 'Can start when',
    trigger: 'Conditions',
    is_highlighted: 'Highlighted when',
    valid: 'Stays valid while',
    is_valid_target: 'Valid targets',
    can_be_picked_artifact: 'Can be picked when',
    ai_potential: 'AI considers it when',
    is_available_on_create: 'Offered when creating a faith if'
};

/** AI weight blocks (read by cards/weight.ts, edited with the field set `weight`: parts under a condition with "When…"). */
const WEIGHT_SECTIONS: Record<string, string> = {
    ai_will_do: 'How much the AI wants it',
    ai_accept: 'How willing the AI is to accept'
};

const EFFECT_SECTIONS: Record<string, string> = {
    effect: 'Effects',
    immediate: 'Immediately',
    on_accept: 'When accepted',
    on_decline: 'When declined',
    on_send: 'When sent',
    on_auto_accept: 'When accepted automatically',
    on_blocked_effect: 'When blocked',
    on_complete: 'On completion',
    on_start: 'At the start',
    on_end: 'At the end',
    on_success: 'On success',
    on_failure: 'On failure',
    on_invalidated: 'When it becomes invalid',
    on_monthly: 'Every month',
    on_yearly: 'Every year',
    on_activate: 'When activated',
    on_deactivate: 'When deactivated',
    after: 'Afterwards',
    on_enter: 'When entering',
    on_leave: 'When leaving',
    on_death: 'On death',
    on_become_head: 'On becoming head'
};

/** Types whose script runs with a character as root (a scope hint for adding statements). */
const CHARACTER_ROOT = new Set(['traits', 'decisions', 'character_interactions', 'lifestyle_perks', 'focuses', 'schemes/scheme_types', 'secret_types', 'hook_types', 'characters']);

/** A scope as the .info files name it ("root ( Faith )") → the picker's scope type. */
const SCOPE_NAMES: Record<string, string> = {
    character: 'character',
    faith: 'faith',
    culture: 'culture',
    'landed title': 'landed_title',
    title: 'landed_title',
    ruler: 'character',
    holder: 'character',
    province: 'province',
    dynasty: 'dynasty',
    'dynasty house': 'dynasty_house',
    house: 'dynasty_house',
    artifact: 'artifact',
    scheme: 'scheme',
    secret: 'secret',
    war: 'war',
    activity: 'activity',
    army: 'army'
};

/** A condition block of a type: its section's title, the scope its root is (its .info's "root ( Faith )"). */
export interface ConditionBlock
{
    title: string;
    scope?: string;
    /** what the .info says it is for (its comment lines) */
    about?: string;
}

/** Context strings that mean "this fires the event". */
/** Portrait toggles written `= yes` (the game's events/_events.info). */
const PORTRAIT_FLAGS = new Set(['hide_info', 'animate_if_dead', 'override_imprisonment_visuals', 'remove_default_outfit']);

const FIRES = /trigger_event|(^| › )(events|random_events|first_valid|fallback|on_actions|random_on_actions|first_valid_on_action)( › |$)/;

/** A text of the game showing a name form, split around it (StoryBuilder.nameExample). */
export interface NameExample
{
    /** its loc key */
    key: string;
    before: string;
    after: string;
    /** the form is written capitalized there (|U, or at the start) */
    cap: boolean;
}

export class StoryBuilder
{
    readonly idx: GameIndex;
    readonly d: Describer;
    /** what a character text code prints for the sample character (LocExamples — set by the index worker) */
    locExample?: (chain: string) => string | undefined;

    constructor(idx: GameIndex)
    {
        this.idx = idx;
        this.d = new Describer(idx);
    }

    private modifierList: ModifierKeyInfo[] | undefined;

    /**
     * Every stat modifier the game defines (modifier_definition_formats), most used first — counted in the definitions
     * that hold modifiers (traits, modifiers, and their nested `*_modifier` blocks). Hidden ones are left out.
     */
    modifierKeys(): ModifierKeyInfo[]
    {
        if (this.modifierList)
            return this.modifierList;

        const counts = new Map<string, number>();
        const walk = (list: PNode[]): void =>
        {
            for (const c of list)
            {
                if (!c.k)
                    continue;

                if (typeof c.v === 'string')
                    counts.set(c.k, (counts.get(c.k) ?? 0) + 1);
                else if (/_modifier$/.test(c.k))
                    walk(c.v);
            }
        };

        for (const type of ['traits', 'modifiers'])
        {
            for (const item of this.idx.list(type))
            {
                const e = this.idx.get(type, item.name);
                const d = e && this.idx.defNode(e);

                if (d && Array.isArray(d.node.v))
                    walk(d.node.v);
            }
        }

        const kinds = this.modifierKinds();
        const out: ModifierKeyInfo[] = [];

        for (const item of this.idx.list('modifier_definition_formats'))
        {
            const f = this.d.modifierFormat(item.name);

            if (f.hidden)
                continue;

            const k = kinds.get(item.name);
            out.push({ key: item.name, label: f.label, percent: f.percent, alreadyPercent: f.alreadyPercent || undefined, color: f.color, count: counts.get(item.name) ?? 0, ...(k ? { kinds: k } : {}) });
        }

        out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
        return (this.modifierList = out);
    }

    /**
     * Where the game puts each stat modifier (docs/picker.md, "Modifiers and settings"), with how often: a trait's own
     * modifiers and every `*_modifier` block by its key (`modifierScopeOf`: character_modifier, county_modifier,
     * province_modifier …) in the definitions of every type; a modifier entry (common/modifiers) by the effects giving
     * it (add_character_modifier, add_county_modifier, add_province_modifier … — its references' contexts).
     */
    private modifierKinds(): Map<string, NonNullable<ModifierKeyInfo['kinds']>>
    {
        type Kind = keyof NonNullable<ModifierKeyInfo['kinds']>;
        const out = new Map<string, NonNullable<ModifierKeyInfo['kinds']>>();
        const bump = (key: string, kind: Kind): void =>
        {
            const k = out.get(key) ?? out.set(key, {}).get(key)!;
            k[kind] = (k[kind] ?? 0) + 1;
        };
        const walk = (list: PNode[], kind: Kind): void =>
        {
            for (const c of list)
            {
                if (!c.k)
                    continue;

                if (typeof c.v === 'string')
                {
                    if (this.d.isModifierKey(c.k))
                        bump(c.k, kind);
                }
                else if (/_modifier$/.test(c.k) && !/^(ai_value|opinion|has_opinion|compare)_modifier$/.test(c.k))
                    walk(c.v, modifierScopeOf(c.k) ?? kind);
            }
        };
        const bodies = (type: string): PNode[][] =>
            this.idx.names(type).flatMap((name) =>
            {
                const e = this.idx.get(type, name);
                const d = e && this.idx.defNode(e);
                return d && Array.isArray(d.node.v) ? [d.node.v] : [];
            });

        for (const body of bodies('traits'))
            walk(body, 'character');

        // a modifier entry: by the effects giving it (add_county_modifier → a county's …)
        for (const name of this.idx.names('modifiers'))
        {
            const e = this.idx.get('modifiers', name);
            const d = e && this.idx.defNode(e);

            if (!e || !d || !Array.isArray(d.node.v))
                continue;

            const given = this.modifierGiven(e);
            walk(d.node.v, given.size === 1 ? [...given][0] : given.size ? 'character' : 'other');

            // (given to both a character and a county …: each)
            for (const k of [...given].slice(1))
                walk(d.node.v, k);
        }

        // every other type's modifier blocks (buildings, laws, traditions, doctrines, innovations …) — the types whose
        // first definitions have one (reading every definition of every type takes seconds)
        const isBlock = (c: PNode): boolean => !!c.k && Array.isArray(c.v) && (c.k === 'modifier' || /_modifier$/.test(c.k)) && !/^(ai_value|opinion|has_opinion|compare)_modifier$/.test(c.k);

        for (const t of this.idx.types())
        {
            if (['traits', 'modifiers', 'characters', 'events', 'on_action', 'localization', 'flag', 'variable', 'images', 'models', 'scripted_effects', 'scripted_triggers', 'script_values'].includes(t.id))
                continue;

            const names = this.idx.names(t.id);
            const sample = names.slice(0, 40).some((name) =>
            {
                const e = this.idx.get(t.id, name);
                const d = e && this.idx.defNode(e);
                return !!d && Array.isArray(d.node.v) && d.node.v.some(isBlock);
            });

            if (!sample)
                continue;

            for (const body of bodies(t.id))
                for (const c of body)
                    if (isBlock(c))
                        walk(c.v as PNode[], modifierScopeOf(c.k!) ?? 'other');
        }

        return out;
    }

    /**
     * The saved scopes in reach of a definition's script (docs/picker.md, "Scopes in reach") — the statement picker's
     * targets: the ones its type's .info documents (an interaction's actor, recipient, secondary actor …, a scheme's
     * target, an activity's host), the ones it saves (save_scope_as, save_temporary_scope_as — with who they are and
     * their type), the ones it uses without either (given by what runs it). Types by name (`scopeTypeByName`); names of
     * things the picker has no statements for (an activity, a story, an epidemic …) are left out.
     */
    private cardTargets(e: Entity, body: PNode[], node: PNode, ctx: Ctx): PickTarget[]
    {
        if (['characters', 'localization', 'images', 'models', 'flag', 'variable', 'events', 'on_action'].includes(e.type))
            return [];

        const out: PickTarget[] = [];
        const text = ctx.src.slice(node.s, node.e);
        // (names holding values or flags, not someone: save_scope_value_as, an interaction's option flags, `scope:x = yes`)
        const values = new Set([
            ...[...text.matchAll(/save_(?:temporary_)?scope_value_as\s*=\s*\{[^}]*?\bname\s*=\s*(\w+)/g)].map((m) => m[1]),
            ...[...text.matchAll(/\bflag\s*=\s*(\w+)/g)].map((m) => m[1]),
            ...[...text.matchAll(/\bscope:(\w+)\s*(?:=|>=|<=|>|<|!=)\s*(?:yes|no|-?\d)/g)].map((m) => m[1])
        ]);
        const add = (t: PickTarget): void =>
        {
            if (!out.some((o) => o.key === t.key) && !values.has(t.key.slice(6)))
                out.push(t);
        };
        const label = (n: string): string => capitalize(humanize(n));
        const typeName = typeLabel(e.type).toLowerCase();

        for (const doc of this.idx.typeDoc(e.type))
        {
            for (const name of new Set([...doc.text.matchAll(/\bscope:(\w+)/g)].map((m) => m[1])))
            {
                const type = scopeTypeByName(name);

                if (type !== null)
                    add({ key: `scope:${name}`, label: label(name), about: `given to every ${typeName.replace(/s$/, '')} (its .info)`, ...(type ? { type } : {}) });
            }
        }

        for (const s of this.d.savedScopes(body, ctx))
        {
            const type = s.type ?? scopeTypeByName(s.name);

            if (type !== null)
                add({ key: `scope:${s.name}`, label: label(s.name) + (s.temporary ? ' (for a moment)' : ''), about: `${s.who} — saved here${s.temporary ? ' with save_temporary_scope_as: only in the block it is saved in' : ''}`, ...(type ? { type } : {}) });
        }

        for (const name of new Set([...text.matchAll(/\bscope:(\w+)/g)].map((m) => m[1])))
        {
            const type = scopeTypeByName(name);

            if (type !== null)
                add({ key: `scope:${name}`, label: label(name), about: 'used here — given by what runs it', ...(type ? { type } : {}) });
        }

        return out;
    }

    /** What a modifier entry is given to: the effects its references are in (add_character_modifier, add_county_modifier …). */
    private modifierGiven(e: Entity): Set<'character' | 'landed_title' | 'province'>
    {
        const GIVEN: [RegExp, 'character' | 'landed_title' | 'province'][] = [[/(^|›\s*)(add|remove|has)_character_modifier/, 'character'], [/(^|›\s*)(add|remove|has)_county_modifier/, 'landed_title'], [/(^|›\s*)(add|remove|has)_province_modifier/, 'province']];
        const contexts = this.idx.incomingSources(e).flatMap((s) => s.contexts);
        return new Set(GIVEN.filter(([re]) => contexts.some((c) => re.test(c))).map(([, k]) => k));
    }

    /** The one thing a modifier entry is given to, when it is only one (the picker's modifiers for its "Effects"). */
    modifierGivenTo(e: Entity): 'character' | 'landed_title' | 'province' | undefined
    {
        const g = this.modifierGiven(e);
        return g.size === 1 ? [...g][0] : undefined;
    }

    /**
     * The fields of a definition as lines (opinion modifiers: "+30 opinion", "Lasts 5 years", "Fades over time"),
     * one per field, anchored when `ctx` reads the definition's own text. Unknown keys read "key: value".
     */
    fieldLines(type: string, list: PNode[], ctx?: Ctx): Line[]
    {
        const out: Line[] = [];
        const bare = bareField(type);

        for (const c of list)
        {
            // (a list's items written alone: `opposites = { craven }`)
            const key = c.k ?? (bare && typeof c.v === 'string' ? bare.key : null);

            if (!key || typeof c.v !== 'string')
                continue;

            const def = fieldOf(type, key);
            const f = fieldText(type, key, c.v);
            const tip = c.k ? `${c.k} = ${c.v}` : c.v;
            // an entry linked, a text key read ("Label: $" split around the value); a number written as a named value:
            // "Label: <the value>"
            const named = def?.kind === 'number' && !/^-?[\d.]+$/.test(c.v);
            const around = def && typeof def.read === 'string' && def.read.includes('$') && (def.kind === 'ref' || def.kind === 'text') ? def.read.replace('%k', key.replace(/_/g, ' ')).split('$') : undefined;
            const l: Line = named && ctx
                ? { text: rich(capitalize(def!.label.replace('…', '')), ': ', this.settingValue(c.v, ctx, key)), tip }
                : around
                ? { text: rich(capitalize(around[0]), def!.ref ? this.d.ref(c.v, [def!.ref]) : ctx ? this.settingValue(c.v, ctx, key) : c.v, around.slice(1).join('$')), tip }
                : f
                ? { text: f.tone ? [{ text: f.text, kind: f.tone }] : [f.text], tone: f.tone, tip }
                : { text: rich(capitalize(humanize(key)), ': ', { text: c.v, kind: 'value' }), tip };

            if (ctx?.file)
            {
                const src = this.d.anchor(c, ctx, 'field', false);

                if (src)
                    l.src = { ...src, fields: type };
            }

            out.push(l);
        }

        return out;
    }

    label(e: Entity): string
    {
        return this.idx.displayName(e) ?? titleCase(humanize(e.name));
    }

    body(node: PNode): PNode[]
    {
        return Array.isArray(node.v) ? node.v : [];
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /**
     * Loc keys in a title/name node, in order, with the conditions of triggered_desc variants; an unconditional entry
     * after conditional ones in a first_valid is the fallback ("Otherwise"). (An event's description: descTree.)
     */
    private locVariants(n: PNode | undefined, ctx: Ctx): { text: Rich; key?: string; conditional?: Line[]; otherwise?: boolean; trigger?: PNode; }[]
    {
        if (!n)
            return [];

        if (typeof n.v === 'string')
            return n.v ? [{ text: this.d.loc(n.v) ?? [humanize(n.v)], key: n.v }] : [];

        const out: { text: Rich; key?: string; conditional?: Line[]; otherwise?: boolean; trigger?: PNode; }[] = [];
        const visit = (list: PNode[], conds?: Line[], firstValid = false, trigger?: PNode): void =>
        {
            let afterConditional = false;

            for (const c of list)
            {
                if (c.k === 'trigger' || c.k === 'limit')
                    continue;

                if (c.k === 'triggered_desc' && Array.isArray(c.v))
                {
                    const t = c.v.find((x) => x.k === 'trigger');
                    const cs = t && Array.isArray(t.v) ? this.d.triggers(t.v, ctx) : undefined;

                    if (cs?.length)
                        afterConditional = true;

                    visit(c.v, cs, false, t);
                }
                else if (typeof c.v === 'string')
                {
                    if ((c.k === 'desc' || c.k === null) && c.v)
                        out.push({ text: this.d.loc(c.v) ?? [humanize(c.v)], key: c.v, conditional: conds, otherwise: firstValid && afterConditional && !conds, trigger });
                }
                else
                    visit(c.v, conds, c.k === 'first_valid');
            }
        };
        visit(n.v);
        return out;
    }

    /**
     * An event's description as a tree (DescNode, docs/readable-view.md "Descriptions"): `desc = key` a text, a block a
     * sequence of parts, `first_valid` / `random_valid` versions, a `triggered_desc` its content with its condition.
     * Paths count keyed statements from the `desc` statement down.
     */
    private descTree(n: PNode, ctx: Ctx): DescNode | undefined
    {
        const node = (c: PNode, path: number[] | undefined): DescNode | undefined =>
        {
            if (typeof c.v === 'string')
                return c.v ? { kind: 'text', text: this.d.loc(c.v) ?? [humanize(c.v)], key: c.v, path } : undefined;

            const list = c.v;
            // (the keyed index of each statement of the block)
            const keyed: number[] = [];
            let k = -1;

            for (const x of list)
                keyed.push(x.k !== null ? ++k : -1);

            const sub = (i: number): number[] | undefined => (path && keyed[i] >= 0 ? [...path, keyed[i]] : undefined);

            if (c.k === 'triggered_desc')
            {
                const t = list.find((x) => x.k === 'trigger');
                const di = list.findIndex((x) => x.k === 'desc');
                const inner = di >= 0 ? node(list[di], sub(di)) : undefined;

                if (!inner)
                    return undefined;

                const cs = t && Array.isArray(t.v) ? this.d.triggers(t.v, ctx) : [];
                return {
                    ...inner,
                    path,
                    when: cs.length ? rich('If ', this.d.conditionClause(cs), ':') : ['If … (no condition yet):'],
                    triggerSrc: t && Array.isArray(t.v) ? this.blockSection(t, 'trigger', ctx) : undefined
                };
            }

            const kind: DescNode['kind'] = c.k === 'first_valid' ? 'first' : c.k === 'random_valid' ? 'random' : 'seq';
            const kids: DescNode[] = [];
            let afterConditional = false;

            list.forEach((x, i) =>
            {
                if (x.k === 'trigger' || x.k === 'limit' || (x.k === null && typeof x.v !== 'string'))
                    return;

                const kid = node(x, sub(i));

                if (!kid)
                    return;

                if (kid.when)
                    afterConditional = true;
                else if (kind === 'first' && afterConditional)
                    kid.otherwise = true;

                kids.push(kid);
            });

            return kids.length ? { kind, kids, path, at: path } : undefined;
        };
        return node(n, []);
    }

    /**
     * An event's scenes: every `override_background = { trigger = { … } reference = x }` in order (the first whose
     * condition holds shows; none — the theme's), with its picture and "If …:".
     */
    private eventScenes(body: PNode[], ctx: Ctx): EventScene[]
    {
        return body
            .filter((n) => n.k === 'override_background')
            .map((n) =>
            {
                const list = Array.isArray(n.v) ? n.v : [];
                const r = typeof n.v === 'string' ? n.v : list.find((x) => x.k === 'reference')?.v;
                const ref = typeof r === 'string' ? r : undefined;
                const t = list.find((x) => x.k === 'trigger' && Array.isArray(x.v));
                const cs = t ? this.d.triggers(t.v as PNode[], ctx) : [];
                const bg = ref ? this.idx.get('event_backgrounds', ref) : undefined;
                const im = bg && this.idx.imagesOf(bg);
                const src = this.d.anchor(n, ctx, 'other', true);
                const out: EventScene = { ref, image: (im?.illu ?? im?.icon)?.name, src };

                if (cs.length)
                    out.when = rich('If ', this.d.conditionClause(cs), ':');

                // (its trigger block, or — none yet — where "＋ condition" makes one)
                out.triggerSrc = t ? this.blockSection(t, 'trigger', ctx) : src?.inner ? { parent: { ...src, kind: 'trigger' }, key: 'trigger', kind: 'trigger' } : undefined;
                return out;
            });
    }

    /** What a description reads as at first sight: every part, the first version of each choice. */
    private descReading(n: DescNode | undefined): Rich
    {
        if (!n)
            return [];

        if (n.kind === 'text')
            return n.text ?? [];

        return n.kind === 'seq' ? n.kids!.flatMap((k) => this.descReading(k)) : this.descReading(n.kids![0]);
    }

    eventStory(e: Entity): EventStory | null
    {
        const def = this.idx.defNode(e);

        if (!def)
            return null;

        const body = this.body(def.node);
        // (the lines read the event's own text: they carry anchors for editing in place)
        const ctx = rootCtx(def.src, this.idx.defAnchor(e), 'character');
        // (the lines' scope hints: what the event saves — `scope:target_title = { … }` holds a title)
        ctx.savedTypes = Object.fromEntries(
            this.d.savedScopes(body, ctx)
                .filter((s) => s.type)
                .map((s) => [s.name, s.type!])
        );
        const get = (k: string): PNode | undefined => body.find((n) => n.k === k);
        const scalar = (k: string): string | undefined =>
        {
            const n = get(k);
            return typeof n?.v === 'string' ? n.v : undefined;
        };
        const titles = this.locVariants(get('title'), ctx);
        const descNode = get('desc');
        const eventType = scalar('type') ?? 'character_event';
        const hidden = scalar('hidden') === 'yes';

        const immediateCtx = { ...ctx, followUps: [] as FollowUp[] };
        const immediateNode = get('immediate');
        const immediate = immediateNode && Array.isArray(immediateNode.v) ? this.d.effects(immediateNode.v, immediateCtx) : [];

        const options: StoryOption[] = body
            .filter((n) => n.k === 'option' && Array.isArray(n.v))
            .map((n) =>
            {
                const list = n.v as PNode[];
                const names = this.locVariants(
                    list.find((c) => c.k === 'name'),
                    ctx
                );
                const trig = list.find((c) => c.k === 'trigger');
                const octx = { ...ctx, followUps: [] as FollowUp[] };
                const option: StoryOption = {
                    text: names[0]?.text ?? ['OK'],
                    nameKey: names[0]?.key,
                    alternatives: names.slice(1).map((x) => x.text),
                    conditions: trig && Array.isArray(trig.v) ? this.d.triggers(trig.v, ctx) : [],
                    effects: this.d.effects(list, octx),
                    followUps: octx.followUps,
                    fallback: list.some((c) => c.k === 'fallback' && c.v === 'yes')
                };
                const src = this.d.anchor(n, ctx, 'effect', true);

                if (src)
                {
                    option.src = src;
                    option.trigger = this.section(trig, 'trigger', 'trigger', ctx, src);
                }

                return option;
            });

        const afterCtx = { ...ctx, followUps: [] as FollowUp[] };
        const afterNode = get('after');
        const after = afterNode && Array.isArray(afterNode.v) ? this.d.effects(afterNode.v, afterCtx) : [];
        const trigger = get('trigger');
        const cooldown = get('cooldown');

        const portraits: Rich[] = body
            .filter((n) => n.k !== null && /portrait$/.test(n.k))
            .map((n) =>
            {
                const ch = typeof n.v === 'string' ? n.v : (n.v.find((c) => c.k === 'character')?.v as string | undefined);
                return typeof ch === 'string' ? [this.d.scopeSeg(ch)] : [];
            })
            .filter((r) => r.length);

        const images = this.idx.imagesOf(e);
        const src = this.d.anchor(def.node, ctx, 'other', true);
        // a new trigger / immediate goes before the first option (where they usually are), a new `after` at the end
        const firstOption = body.find((n) => n.k === 'option');
        const before = firstOption && this.d.anchor(firstOption, ctx, 'effect', false);
        const sections: EventStory['sections'] = src && {
            trigger: this.section(trigger, 'trigger', 'trigger', ctx, src, before),
            immediate: this.section(immediateNode, 'immediate', 'effect', ctx, src, before),
            after: this.section(afterNode, 'after', 'effect', ctx, src)
        };
        const origins = this.origins(e);
        return {
            src,
            sections,
            cast: this.eventCast(e, body, def.node, ctx, origins),
            key: { type: e.type, name: e.name },
            illustration: images.illu?.name,
            icon: images.icon?.name,
            title: titles[0]?.text ?? [titleCase(humanize(e.name))],
            titleKey: titles[0]?.key,
            titleSrc: get('title') && this.d.anchor(get('title')!, ctx, 'other', false),
            descSrc: get('desc') && this.d.anchor(get('desc')!, ctx, 'other', false),
            backgroundSrc: get('override_background') && this.d.anchor(get('override_background')!, ctx, 'other', false),
            scenes: this.eventScenes(body, ctx),
            themeSrc: get('theme') && this.d.anchor(get('theme')!, ctx, 'other', false),
            background: this.idx.eventBackground(e).ref,
            themeKey: scalar('theme'),
            titleVariants: titles.slice(1).map((t) => t.text),
            desc: descNode && this.descTree(descNode, ctx),
            kindLabel: hidden ? 'Hidden event' : (EVENT_KIND[eventType] ?? capitalize(humanize(eventType))),
            theme: scalar('theme') ? capitalize(humanize(scalar('theme')!)) : undefined,
            hidden,
            cooldown: cooldown && Array.isArray(cooldown.v) ? this.d.duration(cooldown.v) : undefined,
            portraits,
            origins,
            conditions: trigger && Array.isArray(trigger.v) ? this.d.triggers(trigger.v, ctx) : [],
            immediate,
            immediateFollowUps: immediateCtx.followUps,
            options,
            after,
            afterFollowUps: afterCtx.followUps
        };
    }

    /**
     * Where a section is written: its block when the definition has one, else the statement to create `key = { }` in
     * (right before `before` when given).
     */
    private section(node: PNode | undefined, key: string, kind: SectionSource['kind'], ctx: Ctx, parent: LineSource, before?: LineSource): SectionSource
    {
        const src = node && Array.isArray(node.v) ? this.d.anchor(node, ctx, kind, true) : undefined;
        return src ? { src, key, kind } : { parent, before, key, kind };
    }

    /**
     * What an event is given by what fires it: who root is (the on_action's documentation, or whom an origin sends it
     * to) and the scopes it gets — an on_action's documented ones and those saved in the effect that sends it, the names
     * a firing event saves, and — saved scopes carry over with trigger_event — the ones that event was given itself (its
     * own origins, back along the whole chain: each event once, at most 60).
     */
    private givenTo(e: Entity, origins: StoryOrigin[], depth: number, seen: Set<number>): { rootNotes: EventCast['rootNotes']; given: CastMember[]; }
    {
        const rootNotes: EventCast['rootNotes'] = [];
        const given: CastMember[] = [];
        const give = (m: CastMember): void =>
        {
            if (!given.some((g) => g.name === m.name))
                given.push(m);
        };

        for (const o of origins.slice(0, depth ? 6 : 12))
        {
            const src = this.idx.get(o.ref.type, o.ref.name);

            if (!src)
                continue;

            if (o.ref.type === 'character_interactions')
            {
                give({ name: 'actor', who: ['The one who uses the interaction'], from: o.label });
                give({ name: 'recipient', who: ['The one it is used on'], from: o.label });
                continue;
            }

            if (o.ref.type !== 'on_action' && o.ref.type !== 'events')
                continue;

            const doc = o.ref.type === 'on_action' ? this.onActionDoc(src) : undefined;
            // "they": the origin's own character — its documented root, else "the one … is about"
            const about = doc?.root ?? (o.ref.type === 'events' ? `the one “${o.label}” happens to` : `the one ${o.label} is about`);
            // (on_actions merge: the definition that fires the event; an on_action fires from its effect, an event anywhere)
            let sent: { who: string; conditions?: Line[]; } | null = null;
            const saves: { name: string; who: string; conditions?: Line[]; type?: string; }[] = [];
            this.idx.liveDefs(src).forEach((def) =>
            {
                const d = this.idx.defNode(src, undefined, src.defs.indexOf(def));

                if (!d || !d.src.includes(e.name))
                    return;

                const oc = rootCtx(d.src, undefined, 'character');
                const scripts = o.ref.type === 'on_action' ?
                    this.body(d.node)
                        .filter((n) => n.k === 'effect' && Array.isArray(n.v))
                        .flatMap((n) => n.v as PNode[]) :
                    this.body(d.node);
                const w = this.d.firedWho(scripts, e.name, oc);
                sent ??= w;

                // (an on_action's effect saves reach only the events it sends from there, not those of its lists)
                if (o.ref.type === 'on_action' && !w)
                    return;

                // (its saved names go along with trigger_event; read from "they" when the event goes to someone else)
                const top = w?.who ? { who: about, owner: 'them' } : { who: o.ref.type === 'events' ? 'you' : about, owner: w?.who ? 'them' : 'you' };

                for (const s of this.d.savedScopes(scripts, oc, top))
                    if (!s.temporary)
                        saves.push(s);
            });
            const w = sent as { who: string; conditions?: Line[]; } | null;

            if (w?.who)
                rootNotes.push({ from: o.label, who: capitalize(w.who), of: about, conditions: w.conditions });
            else if (doc?.root)
                rootNotes.push({ from: o.label, who: doc.root });

            for (const s of doc?.scopes ?? [])
                give({ name: s.name, who: [s.who ? capitalize(s.who) : '(not described)'], from: o.label });

            for (const s of saves)
                give({ name: s.name, who: [capitalize(s.who)], conditions: s.conditions, from: o.label, type: s.type });

            // (what the firing event had itself goes along too)
            if (o.ref.type === 'events' && !seen.has(src.id) && seen.size < 60)
            {
                seen.add(src.id);

                // (named by the event before, and where the name began: "A pretty daughter (First time), from Testmod 000 on …")
                for (const g of this.givenTo(src, this.origins(src), depth + 1, seen).given)
                    give({ ...g, from: g.from ? `${o.label}, from ${g.from.split(', from ').pop()}` : o.label });
            }
        }

        return { rootNotes, given };
    }

    /**
     * Who is who in an event (the card's "Who's who", docs/readable-view.md): root, the scopes what fires it gives (the
     * on_actions' documentation, the names the firing events saved, an interaction's actor / recipient), the ones it
     * names itself, the ones it uses without either, its portraits.
     */
    private eventCast(e: Entity, body: PNode[], node: PNode, ctx: Ctx, origins: StoryOrigin[]): EventCast
    {
        const { rootNotes, given } = this.givenTo(e, origins, 0, new Set([e.id]));
        const named: CastMember[] = this.d.savedScopes(body, ctx).map((s) =>
        {
            const m: CastMember = { name: s.name, who: [s.who], conditions: s.conditions, temporary: s.temporary || undefined, type: s.type };
            const src = s.alone && s.holder ? this.d.anchor(s.holder, ctx, 'effect', false) : this.d.anchor(s.save, ctx, 'effect', false);

            if (src)
                m.src = src;

            return m;
        });
        const known = new Set([...given, ...named].map((m) => m.name));
        const text = ctx.src.slice(node.s, node.e);
        const unknown = [...new Set([...text.matchAll(/\bscope:(\w+)/g)].map((m) => m[1]))].filter((n) => !known.has(n));
        const portraits: EventPortrait[] = [];
        let portraitAt: LineSource | undefined;
        // (a statement as written, without the indentation of its first line on the others)
        const rawOf = (n: PNode): string =>
        {
            let ls = n.s;

            while (ls > 0 && ctx.src.charCodeAt(ls - 1) !== 10)
                ls--;

            const base = /^[ \t]*/.exec(ctx.src.slice(ls, n.s))![0];
            return ctx.src
                .slice(n.s, n.e)
                .split(/\r?\n/)
                .map((l, i) => (i && l.startsWith(base) ? l.slice(base.length) : l))
                .join('\n');
        };
        const str = (n: PNode | undefined): string | undefined => (typeof n?.v === 'string' ? n.v : undefined);

        for (const n of body)
        {
            const m = n.k && /^(left|right|center|lower_left|lower_center|lower_right)_portrait$/.exec(n.k);

            if (!m)
                continue;

            const kids = Array.isArray(n.v) ? n.v : undefined;
            const scope = typeof n.v === 'string' ? n.v : str(kids?.find((c) => c.k === 'character'));
            const src = this.d.anchor(n, ctx, 'other', false);

            if (src)
                portraitAt = src;

            if (typeof scope !== 'string')
                continue;

            const get = (k: string): PNode | undefined => kids?.find((c) => c.k === k);
            const who = this.d.scopeSeg(scope, ctx);
            // (conditions of a portrait are about the one shown)
            const clause = (t: PNode | undefined): Rich | undefined => (t && Array.isArray(t.v) ? this.d.conditionClause(this.d.triggers(t.v, { ...ctx, scope: typeof who === 'string' ? who : who.text }), scope === 'root' ? 'you' : who) : undefined);
            const outfit = get('outfit_tags');
            const p: EventPortrait = {
                pos: m[1],
                scope,
                animation: str(get('animation')),
                scripted: str(get('scripted_animation')),
                camera: str(get('camera')),
                outfitTags: outfit && Array.isArray(outfit.v) ? outfit.v.map((x) => str(x)).filter((x): x is string => !!x) : [],
                flags: (kids ?? []).filter((c) => c.k && c.v === 'yes' && PORTRAIT_FLAGS.has(c.k)).map((c) => c.k!),
                shownIf: clause(get('trigger')),
                triggered: (kids ?? [])
                    .filter((c) => c.k === 'triggered_animation' && Array.isArray(c.v))
                    .map((t) =>
                    {
                        const tk = t.v as PNode[];
                        const anim = tk.find((c) => c.k === 'animation' || c.k === 'scripted_animation');
                        const list = anim && Array.isArray(anim.v) ?
                            anim.v.map((x) => str(x))
                                .filter(Boolean)
                                .join(' / ') :
                            str(anim);
                        return { when: clause(tk.find((c) => c.k === 'trigger')) ?? ['always'], animation: list, text: rawOf(t) };
                    }),
                kids: kids ? kids.filter((c) => c.k).map((c) => ({ key: c.k!, text: rawOf(c) })) : [{ key: 'character', text: `character = ${scope}` }],
                src
            };
            portraits.push(p);
        }

        if (!portraitAt)
        {
            const after = body.find((n) => n.k === 'desc') ?? body.find((n) => n.k === 'title') ?? body.find((n) => n.k === 'theme');
            portraitAt = after && this.d.anchor(after, ctx, 'other', false);
        }

        return { rootNotes, given, named, unknown, portraits, portraitAt };
    }

    /**
     * The names an event uses that it does not save itself (`scope:x` in its script): what whoever fires it passes
     * along — the picker's "Pass along…" after "Trigger an event" —, with who they are by what fires it now.
     */
    eventScopes(e: Entity): { name: string; about?: string; }[]
    {
        const c = this.eventStory(e)?.cast;

        if (!c)
            return [];

        const out: { name: string; about?: string; }[] = c.unknown.map((name) => ({ name }));
        const text = this.idx.defNode(e)?.src ?? '';

        for (const g of c.given)
            if (new RegExp(`\\bscope:${g.name}\\b`).test(text) && !out.some((o) => o.name === g.name))
                out.push({ name: g.name, about: `${richToString(g.who)}${g.from ? ` — given by ${g.from}` : ''}` });

        return out;
    }

    private infoDocs?: Map<string, string>;

    /** The on_actions the game's `_on_actions.info` lists ("- name  # what it is # Root is …"): name → its text. */
    private onActionInfo(): Map<string, string>
    {
        if (this.infoDocs)
            return this.infoDocs;

        const m = new Map<string, string>();

        for (const d of this.idx.typeDoc('on_action'))
            for (const line of d.text.split(/\r?\n/))
            {
                const x = /^\s*-\s*([\w.]+)\s+#\s*(.+)$/.exec(line);

                if (x)
                    m.set(x[1], x[2]);
            }

        return (this.infoDocs = m);
    }

    /** What an on_action's documentation says (the comment above it, the .info list): a summary, who root is, its scopes. */
    onActionDoc(e: Entity): { summary?: string; root?: string; scopes: { name: string; who: string; }[]; }
    {
        const out: { summary?: string; root?: string; scopes: { name: string; who: string; }[]; } = { scopes: [] };
        const tidy = (t: string): string =>
        {
            const s = t.trim().replace(/[.;,]+$/, '');
            return s.length > 180 ? s.slice(0, 177) + '…' : s;
        };
        const lines: string[] = [];

        for (const d of this.idx.liveDefs(e))
            if (d.doc)
                lines.push(...d.doc.split('\n'));

        const info = this.onActionInfo().get(e.name);

        if (info)
            lines.push(...info.split(/\s#\s*/));

        for (const raw of lines)
        {
            const t = raw.replace(/^[#\s-]+/, '').trim();

            if (!t)
                continue;

            const sc = /^(?:saved\s+)?scope:(\w+)\s*(?:=|:|-|,|\bis\b)?\s*(.*)$/i.exec(t);

            if (sc)
            {
                if (!out.scopes.some((s) => s.name === sc[1]))
                    out.scopes.push({ name: sc[1], who: tidy(sc[2]) });

                continue;
            }

            // ("# called for the newborn child": root is the child)
            const r = /^root\s*(?:=|:|-|\bis\b)\s*(.+)$/i.exec(t) ?? /^(?:called|fired|run) (?:for|on) (.+)$/i.exec(t) ?? /\broot (?:is|=) ([^.#]+)/i.exec(t);

            if (r)
            {
                out.root ??= tidy(r[1]);

                // (a sentence of its own: the summary too)
                if (!/^root\b/i.test(t))
                    out.summary ??= tidy(t);

                continue;
            }

            if (!out.summary && t.length > 3 && !/^[=\-*#\s]+$/.test(t))
                out.summary = tidy(t);
        }

        return out;
    }

    /**
     * Every on_action for the event card's "When it happens…" (docs/mods.md, "What fires an event"): its documentation,
     * how many events it fires, whether the game fires it (nothing in script does), whether it fires `event` already.
     */
    onActionList(event?: Entity): OnActionInfo[]
    {
        const fires = new Map<string, 'always' | 'sometimes'>();

        if (event)
        {
            for (const o of this.origins(event))
                if (o.ref.type === 'on_action')
                    fires.set(o.ref.name, o.when === 'sometimes' ? 'sometimes' : 'always');
        }

        const out: OnActionInfo[] = [];

        for (const name of this.idx.names('on_action'))
        {
            const e = this.idx.get('on_action', name);

            if (!e || this.idx.isRemoved(e))
                continue;

            let events = 0;
            let randomEvents = 0;
            e.defs.forEach((d, i) =>
            {
                if (!this.idx.liveDefs(e).includes(d))
                    return;

                const n = this.idx.defNode(e, undefined, i);

                for (const c of n && Array.isArray(n.node.v) ? n.node.v : [])
                {
                    if (!Array.isArray(c.v))
                        continue;

                    if (c.k === 'events')
                        events += c.v.filter((x) => x.k === null && typeof x.v === 'string').length;

                    if (c.k === 'random_events')
                        randomEvents += c.v.filter((x) => x.k !== null && /^\d+(\.\d+)?$/.test(x.k) && x.v !== '0').length;
                }
            });
            const doc = this.onActionDoc(e);
            const item: OnActionInfo = {
                name,
                label: capitalize(humanize(name.replace(/^on_/, ''))),
                summary: doc.summary,
                root: doc.root,
                scopes: doc.scopes,
                byGame: !this.origins(e).length,
                events,
                randomEvents
            };
            const f = fires.get(name);

            if (f)
                item.fires = f;

            const mod = this.idx.modTouch(e);

            if (mod)
                item.mod = mod;

            out.push(item);
        }

        return out;
    }

    /** What fires this event / on_action. */
    origins(e: Entity): StoryOrigin[]
    {
        const out: StoryOrigin[] = [];

        for (const s of this.idx.incomingSources(e))
        {
            const src = s.entity;

            if (src.type === 'localization' || src.type === 'flag' || src.type === 'variable')
                continue;

            if (!s.contexts.some((c) => FIRES.test(c)) && src.type !== 'on_action')
                continue;

            const ctx = s.contexts.find((c) => FIRES.test(c)) ?? s.contexts[0];
            const when = /random_events/.test(ctx) ? 'sometimes' : /(^| › )events/.test(ctx) ? 'always' : undefined;
            const o: StoryOrigin = { ref: { type: src.type, name: src.name }, label: this.originLabel(src), typeLabel: typeLabel(src.type), when };
            const mods = this.idx.refMods(src, e);

            if (mods.length)
                o.mods = mods;

            out.push(o);
        }

        return out.sort((a, b) => a.typeLabel.localeCompare(b.typeLabel) || a.label.localeCompare(b.label)).slice(0, 60);
    }

    private originLabel(e: Entity): string
    {
        if (e.type === 'on_action')
            return capitalize(humanize(e.name.replace(/^on_/, '')));

        return this.label(e);
    }

    // -------------------------------------------------------------------------
    // on_actions
    // -------------------------------------------------------------------------

    onActionStory(e: Entity): OnActionStory
    {
        const story: OnActionStory = {
            key: { type: e.type, name: e.name },
            label: capitalize(humanize(e.name.replace(/^on_/, ''))),
            doc: this.idx.liveDefs(e).find((d) => d.doc)?.doc,
            conditions: [],
            events: [],
            randomEvents: [],
            firstValid: [],
            onActions: [],
            effects: [],
            effectFollowUps: [],
            origins: this.origins(e)
        };
        // the definition edits go into (editing in place): a mod's last loaded one, else the winning one
        const loaded = e.defs.map((_d, i) => i).filter((i) => !this.idx.isHiddenDef(e.defs[i]));
        const own = [...loaded].reverse().find((i) => this.idx.defAnchor(e, i)?.mod) ?? loaded[loaded.length - 1];
        // (its list entries carry anchors: ✕ removes one)
        let anchorOf: ((n: PNode) => LineSource | undefined) | undefined;
        const follow = (type: string, name: string, delay?: string, when: Rich[] = [], at?: PNode): FollowUp =>
        {
            const t = this.idx.get(type, name);
            const f: FollowUp = { target: { type, name }, label: t ? this.originLabel(t) : name, delay, when };
            const src = at && anchorOf?.(at);

            if (src)
                f.src = src;

            return f;
        };

        // every loaded definition merges in (files a mod hid don't count)
        for (let i = 0; i < e.defs.length; i++)
        {
            if (this.idx.isHiddenDef(e.defs[i]))
                continue;

            const def = this.idx.defNode(e, undefined, i);

            if (!def)
                continue;

            const ctx = rootCtx(def.src, this.idx.defAnchor(e, i), 'character');
            anchorOf = i === own ? (n) => this.d.anchor(n, ctx, 'other', false) : undefined;

            if (i === own)
            {
                story.src = this.d.anchor(def.node, ctx, 'other', true);
                const body = this.body(def.node);
                const section = (key: string, kind: SectionSource['kind']): SectionSource =>
                {
                    const b = [...body].reverse().find((n) => n.k === key && Array.isArray(n.v));
                    const src = b && this.d.anchor(b, ctx, kind, true);
                    return src ? { src, key, kind } : { parent: story.src && { ...story.src, kind }, key, kind };
                };
                story.sections = { trigger: section('trigger', 'trigger'), effect: section('effect', 'effect'), events: section('events', 'other'), random_events: section('random_events', 'other'), on_actions: section('on_actions', 'other') };
            }

            for (const n of this.body(def.node))
            {
                const list = Array.isArray(n.v) ? n.v : null;

                if (!list)
                    continue;

                // (a list's only entry stands for the list: ✕ takes both)
                const at = (c: PNode): PNode => (list.length === 1 ? n : c);

                if (n.k === 'trigger')
                    story.conditions.push(...this.d.triggers(list, ctx));
                else if (n.k === 'effect')
                {
                    const c = { ...ctx, followUps: [] as FollowUp[] };
                    story.effects.push(...this.d.effects(list, c));
                    story.effectFollowUps.push(...c.followUps);
                }
                else if (n.k === 'events' || n.k === 'first_valid')
                {
                    let delay: string | undefined;

                    for (const c of list)
                    {
                        if (c.k === 'delay' && Array.isArray(c.v))
                            delay = 'after ' + this.d.duration(c.v);
                        else if (c.k === null && typeof c.v === 'string')
                            (n.k === 'events' ? story.events : story.firstValid).push(follow('events', c.v, delay, [], at(c)));
                    }
                }
                else if (n.k === 'random_events')
                {
                    let delay: string | undefined;
                    const entries: { w: number; ev: string; delay?: string; at: PNode; }[] = [];

                    for (const c of list)
                    {
                        if (c.k === 'delay' && Array.isArray(c.v))
                            delay = 'after ' + this.d.duration(c.v);
                        else if (c.k === 'chance_to_happen' && typeof c.v === 'string')
                            story.noEventChance = `Only happens ${c.v}% of the time`;
                        else if (c.k === 'chance_of_no_event')
                            story.noEventChance = typeof c.v === 'string' ? `${c.v}% chance that nothing happens` : 'Sometimes nothing happens';
                        else if (c.k && /^\d+(\.\d+)?$/.test(c.k) && typeof c.v === 'string')
                            entries.push({ w: parseFloat(c.k), ev: c.v, delay, at: at(c) });
                        else if (c.k === null && typeof c.v === 'string')
                            entries.push({ w: 1, ev: c.v, delay, at: at(c) });
                    }

                    const total = entries.reduce((s, x) => s + x.w, 0);

                    for (const x of entries)
                    {
                        const pct = total ? Math.round((x.w / total) * 1000) / 10 : 0;

                        if (x.ev === '0')
                            story.noEventChance = `${formatNumber(pct)}% chance that nothing happens`;
                        else
                            story.randomEvents.push(follow('events', x.ev, x.delay, [[`${formatNumber(pct)}%`]], x.at));
                    }
                }
                else if (n.k === 'on_actions' || n.k === 'random_on_actions' || n.k === 'first_valid_on_action' || n.k === 'fallback')
                {
                    for (const c of list)
                    {
                        const name = c.k === null ? c.v : typeof c.v === 'string' ? c.v : undefined;

                        if (typeof name === 'string' && name !== '0')
                            story.onActions.push(follow('on_action', name, undefined, n.k === 'on_actions' ? [] : [[humanize(n.k)]], at(c)));
                    }
                }
            }
        }

        return story;
    }

    // -------------------------------------------------------------------------
    // Cards (everything else)
    // -------------------------------------------------------------------------

    card(e: Entity): EntityCard
    {
        const images = this.idx.imagesOf(e);
        const card: EntityCard = {
            key: { type: e.type, name: e.name },
            title: this.label(e),
            typeLabel: typeLabel(e.type),
            icon: images.icon?.name,
            illustration: images.illu?.name,
            facts: [],
            sections: [],
            usage: this.usage(e)
        };

        if (e.type === 'images')
            return this.imageCard(e, card);

        if (e.type === 'events')
        {
            card.event = this.eventStory(e) ?? undefined;
            return card;
        }

        if (e.type === 'on_action')
        {
            card.onAction = this.onActionStory(e);
            return card;
        }

        if (e.type === 'localization')
        {
            // (the text is the key's own: ✎ changes it — the mod's line, else an override in its replace file)
            card.description = this.d.loc(e.name);
            card.descriptionKey = e.name;
            card.src = this.idx.locAnchor(e);
            return card;
        }

        for (const k of descriptionCandidates(e.type, e.name))
        {
            const r = this.d.loc(k);

            if (r)
            {
                card.description = r;
                card.descriptionKey = k;
                break;
            }
        }

        // (its name's text key: edited in place — the first the game looks up that exists)
        for (const k of displayNameCandidates(e.type, e.name))
        {
            if (this.idx.plainLoc(k) !== undefined)
            {
                card.titleKey = k;
                break;
            }
        }

        if (e.type === 'flag' || e.type === 'variable')
        {
            card.sections = this.usageSections(e);
            return card;
        }

        const def = this.idx.defNode(e);

        if (!def)
            return card;

        // (the lines read the definition's own text: they carry anchors for editing in place)
        const ctx = rootCtx(def.src, this.idx.defAnchor(e), this.rootScopeOf(e.type));
        ctx.entityType = e.type;
        const node = def.node;
        const body = this.body(node);
        card.src = this.d.anchor(node, ctx, 'other', true);
        // (the saved scopes its script can speak of: the picker's targets)
        const targets = this.forTooltip ? [] : this.cardTargets(e, body, node, ctx);

        if (targets.length)
        {
            card.targets = targets;
            // (the lines' scope hints: `scope:target_title = { … }` holds a title)
            ctx.savedTypes = Object.fromEntries(targets.filter((t) => t.type).map((t) => [t.key.slice(6), t.type!]));
        }

        // a description of its own (`desc = key`: interactions, decisions …) wins over the one found by its name
        const own0 = body.find((c) => c.k === 'desc' && typeof c.v === 'string' && c.v && !/s/.test(c.v as string));

        if (own0 && this.idx.plainLoc(own0.v as string) !== undefined)
        {
            card.description = this.d.loc(own0.v as string);
            card.descriptionKey = own0.v as string;
        }

        // the definition's own block as a section's place (scripted effects, modifiers)
        const own = (kind: SectionSource['kind'], fields?: string): SectionSource | undefined => card.src && { src: { ...card.src, kind, ...(fields ? { fields } : {}) }, key: e.name, kind };

        switch (e.type)
        {
            case 'scripted_effects':
            {
                const c = { ...ctx, expand: 3, followUps: [] as FollowUp[] };
                card.sections.push({ title: 'What it does', lines: this.d.effects(body, c), followUps: c.followUps, src: own('effect') });
                return card;
            }
            case 'scripted_triggers':
                card.sections.push({ title: 'What it checks', lines: this.d.triggers(body, ctx), src: own('trigger') });
                return card;
            case 'script_values':
                if (typeof node.v === 'string')
                    card.facts.push(rich('Value: ', this.d.valueSeg(node.v)));
                else
                    card.sections.push({ title: 'How it is calculated', lines: this.formula(body, ctx), src: own('field', 'script_value') });

                return card;
            case 'modifiers':
            {
                // (what it is given to — a county, a character …: the picker offers those modifiers)
                const src = own('modifier');
                const applies = this.modifierGivenTo(e);
                card.sections.push({ title: 'Effects', lines: this.d.statsOf(body, ctx), src: src && applies ? { ...src, scope: applies } : src });
                return card;
            }
            case 'opinion_modifiers':
                this.opinionFacts(body, card);
                card.sections.push({ title: 'How it works', lines: this.fieldLines(e.type, body, ctx), src: own('field', e.type) });
                return card;
            case 'characters':
                this.characterFacts(body, card, ctx);
                return card;
            case 'traits':
                this.traitFacts(body, card);
                this.traitSections(e, body, card, ctx, own('field', 'traits'));
                break;
            default:
            {
                // the per-type builders (cards/): true = complete
                const fn = TYPE_CARDS[e.type];

                if (fn && fn(this, { e, node, body, card, ctx, own }))
                    return card;

                // (a type without a builder of its own: the statements no section reads as its settings)
                if (!fn)
                {
                    this.genericSections(e, body, card, ctx, own, undefined, true);
                    return card;
                }
            }
        }

        this.genericSections(e, body, card, ctx, own);
        return card;
    }

    /**
     * The sections every definition gets from its statements: modifiers, trigger / effect blocks (TRIGGER_SECTIONS,
     * EFFECT_SECTIONS, `on_*`) and `cost`; keys in `skip` are left out (a per-type builder shows them its own way).
     */
    genericSections(e: Entity, body: PNode[], card: EntityCard, ctx: Ctx, own: (kind: SectionSource['kind'], fields?: string) => SectionSource | undefined, skip?: Set<string>, settings = false): void
    {
        const all = body;
        const written = new Set(body.map((c) => c.k));
        const blocks = this.conditionBlocks(e.type);

        if (skip)
            body = body.filter((c) => !c.k || !skip.has(c.k));

        const stats = this.d.statsOf(body, ctx);

        // (a trait without modifiers yet: the section to add them to)
        if (stats.length || (e.type === 'traits' && card.src))
        {
            // (a trait's modifiers are its holder's: the picker offers character modifiers)
            const src = own('modifier');
            card.sections.push({ title: 'Modifiers', lines: stats, src: src && e.type === 'traits' ? { ...src, scope: 'character' } : src });
        }

        if (e.type === 'traits')
        {
            const opinion = this.traitOpinion(body, card.title, ctx);

            // (when anchored also empty: opinion fields can be added)
            if (opinion.length || card.src)
                card.sections.push({ title: 'Opinion', lines: opinion, src: own('field', 'trait_opinion') });
        }

        // sections with a block of their own come also when empty (when anchored): statements can be added to them
        for (const c of body)
        {
            if (!c.k || !Array.isArray(c.v))
                continue;

            if (TRIGGER_SECTIONS[c.k] || blocks.has(c.k))
            {
                const lines = this.d.triggers(c.v, ctx);
                const scope = blocks.get(c.k)?.scope;
                const src = this.blockSection(c, 'trigger', ctx);

                if (lines.length || src)
                    card.sections.push({ title: TRIGGER_SECTIONS[c.k] ?? blocks.get(c.k)!.title, lines, src: src && scope ? { ...src, scope } : src });
            }
            else if (EFFECT_SECTIONS[c.k] || (/^on_/.test(c.k) && c.k !== 'on_action'))
            {
                const fctx = { ...ctx, followUps: [] as FollowUp[] };
                const lines = this.d.effects(c.v, fctx);
                const src = this.blockSection(c, 'effect', ctx);

                if (lines.length || src)
                    card.sections.push({ title: EFFECT_SECTIONS[c.k] ?? capitalize(humanize(c.k)), lines, followUps: fctx.followUps, src });
            }
            else if (c.k === 'cost')
            {
                const lines = this.cost(c.v, ctx);
                const src = this.blockSection(c, 'field', ctx, 'cost');

                if (lines.length || src)
                    card.sections.push({ title: 'Cost', lines, src });
            }
            else if (WEIGHT_SECTIONS[c.k])
            {
                const lines = weightLines(this, c.v, ctx);
                const src = this.blockSection(c, 'field', ctx, 'weight');

                if (lines.length || src)
                    card.sections.push({ title: WEIGHT_SECTIONS[c.k], lines, src });
            }
        }

        // the statements no section reads (types without a builder of their own): Settings
        if (settings)
        {
            const read = (c: PNode): boolean => !!c.k && (!!TRIGGER_SECTIONS[c.k] || blocks.has(c.k) || !!EFFECT_SECTIONS[c.k] || (/^on_/.test(c.k) && c.k !== 'on_action' && Array.isArray(c.v)) || c.k === 'cost' || !!WEIGHT_SECTIONS[c.k] || this.d.statsOf([c]).length > 0);
            const rest = all.filter((c) => c.k && !read(c) && !(c.k === 'desc' && card.descriptionKey === c.v));
            // (a type the field catalog knows: its settings read as fields and change through the picker — the others as script)
            const docs = this.keyDocs(e.type);
            const known = (c: PNode): boolean => !!FIELDS[e.type] && typeof c.v === 'string' && !!fieldOf(e.type, c.k!);
            const lines = rest.flatMap((c) =>
                known(c)
                    ? this.fieldLines(e.type, [c], ctx).map((l) => (docs.get(c.k!) ? { ...l, tip: `${l.tip} — ${docs.get(c.k!)}` } : l))
                    : this.settingLines([c], ctx, docs)
            );

            if (lines.length || card.src)
                card.sections.push({ title: 'Settings', lines, src: own(FIELDS[e.type] ? 'field' : 'other', FIELDS[e.type] ? e.type : undefined), addLabel: 'setting' });
        }

        // the condition blocks the type takes and this definition lacks: a row each, made with its first condition (a
        // mod's entry — the game's are not edited)
        if (card.src?.mod)
        {
            const missing = [...blocks].filter(([key]) => !written.has(key));
            const lines: Line[] = [];

            for (const [key, b] of missing)
            {
                const parent = { ...card.src, kind: 'trigger' as const, ...(b.scope ? { scope: b.scope, innerScope: b.scope } : {}) };
                const at: SectionSource = { parent, key, kind: 'trigger', ...(b.scope ? { scope: b.scope } : {}), ...this.blockHint(e.type, key) };
                // (two blocks of the same title — is_valid and is_valid_showing_failures_only — told apart by their keys)
                const label = [...blocks].some(([k, o]) => k !== key && o.title === b.title) ? `${b.title} (${key})` : b.title;
                lines.push({ text: rich(label, ': ', { text: 'not written', kind: 'ph' }), placeholder: true, tip: `${key} = { … }${b.about ? ` — ${b.about}` : ''}`, act: { label: '＋ condition', src: card.src, do: { kind: 'add', at, title: b.title } } });
            }

            if (lines.length)
                card.sections.push({ title: 'More conditions', lines, noAdd: true });

            // the modifier blocks it lacks: a row each, made with its first modifier
            const mods: Line[] = [];

            for (const [key, b] of this.modifierBlocks(e.type))
            {
                if (written.has(key))
                    continue;

                const applies = modifierScopeOf(key);
                const at: SectionSource = { parent: { ...card.src, kind: 'modifier' }, key, kind: 'modifier', ...(applies ? { scope: applies } : {}), ...this.blockHint(e.type, key, 'modifier') };
                mods.push({ text: rich(b.title, ': ', { text: 'not written', kind: 'ph' }), placeholder: true, tip: `${key} = { … }${b.about ? ` — ${b.about}` : ''}`, act: { label: '＋ modifier', src: card.src, do: { kind: 'add', at, title: b.title } } });
            }

            if (mods.length)
                card.sections.push({ title: 'More modifiers', lines: mods, noAdd: true });
        }
    }

    /**
     * Statements as settings (docs/readable-view.md, "Settings"): "Label: value" — an entry linked, a text key read, yes /
     * no —, a duration read ("5 years"), a list of values joined, a block "Label:" with its statements under it. The
     * tooltip is the key with the type's .info comment on it (`keyDocs`). Anchored: each is edited as script.
     */
    settingLines(list: PNode[], ctx: Ctx, docs: Map<string, string>): Line[]
    {
        const out: Line[] = [];

        for (const c of list)
        {
            if (!c.k)
                continue;

            const label = capitalize(humanize(c.k));
            const doc = docs.get(c.k);
            const tip = doc ? `${c.k} — ${doc}` : c.k;
            const src = ctx.file ? this.d.anchor(c, ctx, 'other', Array.isArray(c.v)) : undefined;
            const line: Line = { text: [], tip, ...(src ? { src } : {}) };

            if (typeof c.v === 'string')
            {
                line.text = rich(label, ': ', this.settingValue(c.v, ctx, c.k));

                // (a text key's text: ✎ text changes it in place)
                if (this.isTextKey(c.v, c.k))
                    line.locKey = c.v;
            }
            else
            {
                const keyed = c.v.filter((x) => x.k);
                const bare = c.v.filter((x) => !x.k && typeof x.v === 'string').map((x) => x.v as string);

                if (keyed.length && keyed.every((x) => x.k === 'years' || x.k === 'months' || x.k === 'days') && !bare.length)
                    line.text = rich(label, ': ', this.d.duration(c.v));
                else if (!keyed.length)
                    line.text = rich(label, ': ', ...(bare.length ? bare.flatMap((v, i) => (i ? [', ', this.settingValue(v, ctx, c.k!)] : [this.settingValue(v, ctx, c.k!)])) : ['none']));
                else
                {
                    line.text = [label + ':'];
                    line.children = this.settingLines(c.v, ctx, new Map());
                }
            }

            out.push(line);
        }

        return out;
    }

    /**
     * A setting's value: yes / no; a file path, or the value of a picture / icon / sound key, as written; a text key's
     * text (quoted); else as values read (entries linked, numbers, scopes).
     */
    private settingValue(v: string, ctx: Ctx, key: string): RichSeg
    {
        if (v === 'yes' || v === 'no')
            return v;

        if (/[/\\]|\.(dds|png|tga|txt|gui|mesh|asset)$/i.test(v) || /icon|picture|texture|reference|sound|background|illustration|gfx/.test(key))
            return { text: v, kind: 'code' };

        const t = this.isTextKey(v, key) && this.idx.plainLoc(v);

        if (t)
            return { text: `“${t.length > 80 ? t.slice(0, 80) + '…' : t}”`, kind: 'value', tip: v };

        return this.d.valueSeg(v, ctx);
    }

    /** A setting's value that names a localization text (read quoted, edited as text). */
    private isTextKey(v: string, key: string): boolean
    {
        return v !== 'yes' && v !== 'no' && !/^-?[\d.]+$/.test(v) && !/[/\\]|\.(dds|png|tga|txt|gui|mesh|asset)$/i.test(v) && !/icon|picture|texture|reference|sound|background|illustration|gfx/.test(key) && this.idx.plainLoc(v) !== undefined;
    }

    private keyDocCache = new Map<string, Map<string, string>>();

    /**
     * What a type's .info says about each key of its definitions: the comment lines directly above `key = …` (or the
     * comment after it on its line), joined — "auto_accept — Will the interaction be accepted …".
     */
    keyDocs(type: string): Map<string, string>
    {
        const hit = this.keyDocCache.get(type);

        if (hit)
            return hit;

        const out = new Map<string, string>();

        for (const doc of this.idx.typeDoc(type))
        {
            let comment: string[] = [];

            for (const raw of doc.text.split(/\r?\n/))
            {
                const line = raw.trim();

                if (line.startsWith('#'))
                {
                    comment.push(line.replace(/^#+\s*/, ''));
                    continue;
                }

                const m = /^([a-z_][\w]*)\s*=\s*([^#]*?)\s*(?:#\s*(.*))?$/i.exec(line);

                if (m && !out.has(m[1]))
                {
                    const text = [...comment, m[3] ?? '']
                        .map((x) => x.trim())
                        .filter(Boolean)
                        .join(' ');

                    if (text)
                        out.set(m[1], text.length > 400 ? text.slice(0, 400) + '…' : text);
                }

                comment = [];
            }
        }

        this.keyDocCache.set(type, out);
        return out;
    }

    private conditionBlockCache = new Map<string, Map<string, ConditionBlock>>();

    /**
     * The condition blocks a type's definitions take (docs/readable-view.md, "Condition blocks"): the ones its .info
     * documents as triggers (`### Brief: can_pick ( trigger )`, with the scope its root is — "root ( Faith )") and the
     * top-level trigger blocks its definitions write (in the game and the loaded mods).
     */
    conditionBlocks(type: string): Map<string, ConditionBlock>
    {
        const hit = this.conditionBlockCache.get(type);

        if (hit)
            return hit;

        const out = new Map<string, ConditionBlock>();
        const title = (k: string): string => TRIGGER_SECTIONS[k] ?? capitalize(humanize(k));

        for (const doc of this.idx.typeDoc(type))
        {
            const briefs = [...doc.text.matchAll(/###\s*brief:\s*([a-z_0-9]+)\s*\(\s*trigger\s*\)/gi)];

            for (const m of briefs)
            {
                // (its part of the text: up to the next brief)
                const next = doc.text.slice(m.index! + m[0].length).search(/###\s*brief:/i);
                const part = doc.text.slice(m.index!, next < 0 ? undefined : m.index! + m[0].length + next);
                // its root: "root ( Faith )", "Root scope = title for which …", "Root = ruler in question", "root is the ruler …"
                const root = (/root\s*\(\s*([a-z ]+?)\s*\)/i.exec(part)?.[1] ?? /\broot(?:\s+scope)?\s*(?:=|is)\s*(?:the\s+|a\s+)?([a-z]+(?:\s+(?:title|house))?)/i.exec(part)?.[1])?.toLowerCase();
                const scope = root ? (SCOPE_NAMES[root] ?? SCOPE_NAMES[root.split(' ')[0]]) : undefined;
                // what it is for: its comment lines (the root's line left out)
                const about = part
                    .split(/\r?\n/)
                    .slice(1)
                    .map((l) => l.trim())
                    .filter((l) => l.startsWith('#') && !/^#+\s*root\b/i.test(l))
                    .map((l) => l.replace(/^#+\s*/, ''))
                    .join(' ')
                    .trim();
                out.set(m[1], { title: title(m[1]), ...(scope ? { scope } : {}), ...(about ? { about: about.length > 300 ? about.slice(0, 300) + '…' : about } : {}) });
            }
        }

        if (!['events', 'on_action', 'scripted_effects', 'scripted_triggers', 'script_values', 'localization', 'flag', 'variable', 'images', 'models', 'characters'].includes(type))
        {
            for (const name of this.idx.names(type))
            {
                const e = this.idx.get(type, name);
                const d = e && this.idx.defNode(e);

                for (const c of d && Array.isArray(d.node.v) ? d.node.v : [])
                    if (c.k && c.k !== 'limit' && Array.isArray(c.v) && (TRIGGER_SECTIONS[c.k] || TRIGGER_BLOCKS.has(c.k)) && !out.has(c.k))
                        out.set(c.k, { title: title(c.k) });
            }
        }

        this.conditionBlockCache.set(type, out);
        return out;
    }

    /** The scope a type's script runs in: a character (CHARACTER_ROOT), else the one its conditions' docs name. */
    rootScopeOf(type: string): string | undefined
    {
        if (CHARACTER_ROOT.has(type))
            return 'character';

        // (only when every condition block of the type names the same one)
        const scopes = [...this.conditionBlocks(type).values()].map((b) => b.scope);
        return scopes.length && scopes[0] && scopes.every((s) => s === scopes[0]) ? scopes[0] : undefined;
    }

    blockSection(node: PNode, kind: SectionSource['kind'], ctx: Ctx, fields?: string): SectionSource | undefined
    {
        const src = this.d.anchor(node, ctx, kind, true);

        if (!src)
            return undefined;

        const out: SectionSource = { src: fields ? { ...src, fields } : src, key: node.k!, kind };
        // (a modifier block: what its modifiers apply to — character_modifier, county_modifier …)
        const applies = kind === 'modifier' ? modifierScopeOf(node.k!) : undefined;

        if (applies)
            out.scope = applies;

        // a condition or modifier block of the definition described: its scope, what it is for, the conditions / modifiers
        // the game writes in it
        if ((kind === 'trigger' || kind === 'modifier') && ctx.entityType && node.k)
            Object.assign(out, this.blockHint(ctx.entityType, node.k, kind));

        return out;
    }

    private blockHints = new Map<string, Partial<SectionSource>>();
    private modifierBlockCache = new Map<string, Map<string, ConditionBlock>>();

    /**
     * The modifier blocks a type's definitions take (docs/readable-view.md, "Modifier blocks"): the ones its .info
     * documents (`### brief: modifier ( character modifier )`, with what they are for) and the top-level
     * `modifier` / `*_modifier` blocks its definitions write holding modifiers (a building's `county_modifier`).
     */
    modifierBlocks(type: string): Map<string, ConditionBlock>
    {
        const hit = this.modifierBlockCache.get(type);

        if (hit)
            return hit;

        const out = new Map<string, ConditionBlock>();
        const title = (k: string): string => (k === 'modifier' ? 'Modifiers' : capitalize(humanize(k)));

        for (const doc of this.idx.typeDoc(type))
        {
            for (const m of doc.text.matchAll(/###\s*brief:\s*([a-z_0-9]+)\s*\(\s*([a-z ]*?)\s*modifier\s*\)/gi))
            {
                const next = doc.text.slice(m.index! + m[0].length).search(/###\s*brief:/i);
                const part = doc.text.slice(m.index!, next < 0 ? undefined : m.index! + m[0].length + next);
                const about = part
                    .split(/\r?\n/)
                    .slice(1)
                    .map((l) => l.trim())
                    .filter((l) => l.startsWith('#'))
                    .map((l) => l.replace(/^#+\s*/, ''))
                    .join(' ')
                    .trim();
                const what = m[2].trim();
                out.set(m[1], { title: title(m[1]), ...(about || what ? { about: [what ? capitalize(what) + ' modifier.' : '', about].filter(Boolean).join(' ') } : {}) });
            }
        }

        if (!['events', 'on_action', 'scripted_effects', 'scripted_triggers', 'script_values', 'localization', 'flag', 'variable', 'images', 'models', 'characters', 'modifiers', 'traits'].includes(type))
        {
            for (const name of this.idx.names(type))
            {
                const e = this.idx.get(type, name);
                const d = e && this.idx.defNode(e);

                for (const c of d && Array.isArray(d.node.v) ? d.node.v : [])
                {
                    if (!c.k || out.has(c.k) || !Array.isArray(c.v) || !(c.k === 'modifier' || /_modifier$/.test(c.k)) || c.k === 'ai_value_modifier' || c.k === 'opinion_modifier')
                        continue;

                    if (c.v.some((x) => x.k && typeof x.v === 'string' && this.d.isModifierKey(x.k)))
                        out.set(c.k, { title: title(c.k) });
                }
            }
        }

        this.modifierBlockCache.set(type, out);
        return out;
    }

    /**
     * The picker's hints for a condition block of a type (`SectionSource.hint`): the scope its .info documents, what it
     * is for, and the conditions the game's definitions write in it — leaf keys through AND / OR / NOT, trigger_if,
     * custom descriptions; scope switches, iterators and chains left out (they are about someone else) — most used first.
     */
    blockHint(type: string, key: string, kind: 'trigger' | 'modifier' = 'trigger'): Partial<SectionSource>
    {
        const id = type + '|' + key + '|' + kind;
        const hit = this.blockHints.get(id);

        if (hit)
            return hit;

        const doc = kind === 'trigger' ? this.conditionBlocks(type).get(key) : this.modifierBlocks(type).get(key);
        const counts = new Map<string, number>();
        const LOGIC = new Set(['AND', 'OR', 'NOT', 'NOR', 'NAND', 'trigger_if', 'trigger_else_if', 'trigger_else', 'limit', 'custom_description', 'custom_description_no_bullet', 'custom_tooltip', 'calc_true_if']);
        const walk = (list: PNode[]): void =>
        {
            for (const c of list)
            {
                if (!c.k || ['text', 'subject', 'object', 'value', 'amount'].includes(c.k))
                    continue;

                // (a modifier block: its modifiers — keys with a value the game knows as a modifier)
                if (kind === 'modifier')
                {
                    if (typeof c.v === 'string' && this.d.isModifierKey(c.k))
                        counts.set(c.k, (counts.get(c.k) ?? 0) + 1);

                    continue;
                }

                if (LOGIC.has(c.k))
                {
                    if (Array.isArray(c.v))
                        walk(c.v);

                    continue;
                }

                if (c.k.includes('.') || c.k.includes(':') || /^(any|every|random|ordered)_/.test(c.k) || /^(this|root|prev|from)$/.test(c.k) || (Array.isArray(c.v) && this.d.isScopeKey(c.k)))
                    continue;

                counts.set(c.k, (counts.get(c.k) ?? 0) + 1);
            }
        };

        for (const name of this.idx.names(type))
        {
            const e = this.idx.get(type, name);
            const d = e && this.idx.defNode(e);

            for (const c of d && Array.isArray(d.node.v) ? d.node.v : [])
                if (c.k === key && Array.isArray(c.v))
                    walk(c.v);
        }

        const common = [...counts]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 24)
            .map(([k]) => k);
        const out: Partial<SectionSource> = {};

        if (doc?.scope)
            out.scope = doc.scope;

        if (common.length || doc?.about)
            out.hint = { ...(doc?.about ? { about: doc.about } : {}), ...(common.length ? { common } : {}) };

        this.blockHints.set(id, out);
        return out;
    }

    /** The anchor of a statement that is one of a field set's settings (`cost`, `script_value` …: shared/fieldCatalog.ts). */
    fieldAnchor(node: PNode, ctx: Ctx, fields: string, inner = false): LineSource | undefined
    {
        const src = this.d.anchor(node, ctx, 'field', inner);
        return src && { ...src, fields };
    }

    /** a card made for a tooltip: no picker targets (they cost a walk of the script) */
    private forTooltip = false;

    tooltip(e: Entity): TooltipInfo
    {
        let card: EntityCard;
        this.forTooltip = true;

        try
        {
            card = this.card(e);
        }
        finally
        {
            this.forTooltip = false;
        }

        let lines: Line[] = [];

        if (card.event)
            lines = card.event.conditions.slice(0, 6);
        else
        {
            // (sections come also when empty: the first with lines)
            const skip = new Set(['Names in game', 'Group', 'More conditions', 'Who they are', 'More settings']);
            const s = card.sections.find((x) => (x.title === 'Modifiers' || x.title === 'Effects' || x.title === 'What it does') && x.lines.length) ??
                card.sections.find((x) => x.lines.length && !skip.has(x.title));
            lines = s ? s.lines.filter((l) => !l.hidden).slice(0, 10) : [];
        }

        // (an event's text: every part, the first version of each choice)
        const descText = card.event ? this.descReading(card.event.desc) : card.description;
        return {
            key: card.key,
            title: card.event ? this.d.richString(card.event.title) : card.title,
            typeLabel: card.event ? card.event.kindLabel : card.typeLabel,
            icon: card.picture ? undefined : card.icon,
            illustration: card.picture?.path ?? card.illustration ?? card.event?.illustration,
            description: descText ? truncate(this.d.richString(descText), 280) : undefined,
            lines: [...card.facts.map((f) => ({ text: f })), ...lines]
        };
    }

    private imageCard(e: Entity, card: EntityCard): EntityCard
    {
        const h = this.idx.imageHeader(e);
        const folder = e.name.slice(0, e.name.lastIndexOf('/'));
        card.icon = undefined;
        card.title = titleCase(humanize(this.label(e)));
        card.typeLabel = 'Image';
        card.picture = { path: e.name, width: h.width, height: h.height };

        if (h.width)
            card.facts.push([`${h.width} × ${h.height} px`]);

        if (h.format)
            card.facts.push([h.format + (h.mips && h.mips > 1 ? ` · ${h.mips} mip levels` : '')]);

        if (h.bytes)
            card.facts.push([h.bytes > 1048576 ? `${(h.bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(h.bytes / 1024)} KB`]);

        card.facts.push([{ text: humanize(folder.replace(/^gfx\/(interface\/)?/, '')), kind: 'ph', tip: e.name }]);
        const users = this.idx.imageUsers(e);

        if (users.length)
        {
            const lines: Line[] = users.slice(0, 40).map((u) => ({ text: [this.d.entitySeg(u), { text: ' · ' + typeLabel(u.type), kind: 'ph' as const }] }));

            if (users.length > 40)
                lines.push({ text: [`… and ${users.length - 40} more`] });

            card.sections.push({ title: 'Shown for', lines });
        }

        return card;
    }

    private usage(e: Entity): UsageSummary[]
    {
        const byType = new Map<string, { e: Entity; n: number; }[]>();

        for (const s of this.idx.incomingSources(e))
        {
            if (s.entity.type === 'localization')
                continue;

            const l = byType.get(s.entity.type) ?? [];
            l.push({ e: s.entity, n: s.count });
            byType.set(s.entity.type, l);
        }

        return [...byType.entries()]
            .map(([type, list]) => ({
                type,
                typeLabel: typeLabel(type),
                count: list.length,
                examples: list
                    .sort((a, b) => b.n - a.n)
                    .slice(0, 4)
                    .map((x) => ({ ref: { type: x.e.type, name: x.e.name }, label: this.label(x.e) }))
            }))
            .sort((a, b) => b.count - a.count);
    }

    /** Every entry of one type using `e` (the "Used by" row revealed in full), most references first. */
    usageAll(e: Entity, type: string): UsageSummary['examples']
    {
        return this.idx
            .incomingSources(e)
            .filter((s) => s.entity.type === type)
            .sort((a, b) => b.count - a.count)
            .map((s) => ({ ref: { type: s.entity.type, name: s.entity.name }, label: this.label(s.entity) }));
    }

    private usageSections(e: Entity): CardSection[]
    {
        const buckets: Record<string, Line[]> = { 'Set by': [], 'Checked by': [], 'Removed by': [], 'Also used by': [] };

        for (const s of this.idx.incomingSources(e))
        {
            const ctx = s.contexts.join(' ');
            const bucket = /remove_|clear_/.test(ctx) ? 'Removed by' : /(add_|set_|change_)\w*(flag|variable)|add_to_/.test(ctx) ? 'Set by' : /has_|exists|is_target|is_in/.test(ctx) ? 'Checked by' : 'Also used by';
            buckets[bucket].push({ text: [this.d.entitySeg(s.entity), { text: ` · ${typeLabel(s.entity.type)}`, kind: 'ph' }] });
        }

        return Object.entries(buckets)
            .filter(([, l]) => l.length)
            .map(([title, lines]) => ({ title, lines: lines.length > 40 ? [...lines.slice(0, 40), { text: [`… and ${lines.length - 40} more (see Expert)`] }] : lines }));
    }

    cost(list: PNode[], ctx: Ctx): Line[]
    {
        const out: Line[] = [];

        for (const c of list)
        {
            if (!c.k)
                continue;

            const label = capitalize(humanize(c.k));

            if (typeof c.v === 'string')
            {
                const n = this.d.evalValue(c.v);
                out.push({ text: [n !== undefined ? { text: formatNumber(n), kind: 'value', tip: c.v } : this.d.valueSeg(c.v, ctx), ' ', label], icon: c.k, src: this.fieldAnchor(c, ctx, 'cost') });
            }
            else
            {
                // (one written number: that; else how it is worked out, its parts editable as a script value's)
                const keyed = c.v.filter((x) => x.k);
                const v = keyed.length === 1 && (keyed[0].k === 'value' || keyed[0].k === 'add') ? keyed[0] : undefined;
                const n = typeof v?.v === 'string' ? this.d.evalValue(v.v) : undefined;

                if (n !== undefined)
                    out.push({ text: [{ text: formatNumber(n), kind: 'value' }, ' ', label], icon: c.k, src: this.fieldAnchor(c, ctx, 'cost') });
                else
                    out.push({ text: [label + ':'], icon: c.k, children: this.formula(c.v, ctx), src: this.fieldAnchor(c, ctx, 'script_value', true) });
            }
        }

        return out;
    }

    formula(list: PNode[], ctx: Ctx): Line[]
    {
        const out: Line[] = [];
        const OPS: Record<string, string> = { value: 'Starts at', add: 'Add', subtract: 'Subtract', multiply: 'Multiply by', divide: 'Divide by', min: 'At least', max: 'At most' };

        for (const c of list)
        {
            if (!c.k)
                continue;

            let l: Line | undefined;

            if (OPS[c.k] && typeof c.v === 'string')
                l = { text: rich(OPS[c.k], ' ', this.d.valueSeg(c.v, ctx)), tip: `${c.k} = ${c.v}` };
            else if ((c.k === 'if' || c.k === 'else_if' || c.k === 'else') && Array.isArray(c.v))
            {
                const limit = c.v.find((x) => x.k === 'limit');
                const conds = limit && Array.isArray(limit.v) ? this.d.triggers(limit.v, ctx) : [];
                const kids = this.formula(
                    c.v.filter((x) => x.k !== 'limit'),
                    ctx
                );
                l = { text: [c.k === 'else' ? 'Otherwise:' : c.k === 'else_if' ? 'Otherwise, if:' : 'If:'], conditions: conds, children: kids, icon: 'if' };

                // (its limit: "＋ condition" adds one, the limit made when missing)
                if (ctx.file && c.k !== 'else')
                    l.limitSrc = this.d.limitOf(c, ctx);
            }
            else if ((c.k === 'fixed_range' || c.k === 'integer_range') && Array.isArray(c.v))
            {
                const min = c.v.find((x) => x.k === 'min')?.v;
                const max = c.v.find((x) => x.k === 'max')?.v;
                l = { text: [`Random between ${min} and ${max}`], icon: 'chance' };
            }
            else if (Array.isArray(c.v) && /^(every|any|ordered|random)_/.test(c.k))
            {
                l = { text: [`For each ${humanize(c.k.replace(/^\w+?_/, ''))}:`], children: this.formula(c.v.filter((x) => x.k !== 'limit'), ctx), icon: 'loop' };
            }
            else if (Array.isArray(c.v) && OPS[c.k])
            {
                // (`multiply = { value = 0 desc = … }`: one value — read as `multiply = 0`)
                const keyed = c.v.filter((x) => x.k && x.k !== 'desc');
                const one = keyed.length === 1 && keyed[0].k === 'value' && typeof keyed[0].v === 'string' ? keyed[0].v : undefined;
                l = one !== undefined ? { text: rich(OPS[c.k], ' ', this.d.valueSeg(one, ctx)), tip: `${c.k} = { value = ${one} }` } : { text: [OPS[c.k] + ':'], children: this.formula(c.v, ctx) };
            }

            if (!l)
                continue;

            if (ctx.file)
                l.src = this.fieldAnchor(c, ctx, 'script_value', !!l.children);

            out.push(l);
        }

        return out;
    }

    private opinionFacts(list: PNode[], card: EntityCard): void
    {
        const s = (k: string): string | undefined =>
        {
            const c = list.find((x) => x.k === k);
            return typeof c?.v === 'string' ? c.v : undefined;
        };
        const op = s('opinion');

        if (op)
        {
            const n = this.d.evalValue(op);
            card.facts.push(rich('Opinion ', n !== undefined ? { text: (n > 0 ? '+' : '') + formatNumber(n), kind: n >= 0 ? 'good' : 'bad' } : this.d.valueSeg(op)));
        }

        const dur = this.d.duration(list);

        if (dur)
            card.facts.push([`Lasts ${dur}`]);
    }

    private traitFacts(list: PNode[], card: EntityCard): void
    {
        const s = (k: string): string | undefined =>
        {
            const c = list.find((x) => x.k === k);
            return typeof c?.v === 'string' ? c.v : undefined;
        };

        if (s('category'))
            card.facts.push([capitalize(humanize(s('category')!)) + ' trait']);

        // (its other properties are the "Settings" section, its opposites and compatibility sections of their own —
        // changeable there)
    }

    /**
     * A trait's own properties as a "Settings" section (every scalar the trait catalog knows, and any other scalar that
     * is no modifier — shared/fieldCatalog.ts FIELDS.traits: shown, changed and added through the picker), and its blocks:
     * compatibility, experience tracks (their modifiers per XP level), the terrain of commander traits.
     */
    private traitSections(e: Entity, list: PNode[], card: EntityCard, ctx: Ctx, settings: SectionSource | undefined): void
    {
        const known = new Set((FIELDS.traits ?? []).map((f) => f.key));
        // (name, description and icon show as the card's; the opinion fields in the "Opinion" section)
        const skip = new Set(['name', 'desc', 'icon', ...(FIELDS.trait_opinion ?? []).map((f) => f.key)]);
        // a value written as a file constant (`@pos_compat_high`) reads as its number
        const consts = this.idx.fileConstants(e);
        const valueOf = (v: string): number | undefined => this.d.evalValue(v.startsWith('@') ? (consts.get(v.slice(1)) ?? v) : v);
        const scalars = list.filter((c) => c.k && typeof c.v === 'string' && !skip.has(c.k) && (known.has(c.k) || !this.d.isModifierKey(c.k)));
        const lines = this.fieldLines('traits', scalars, ctx);

        if (lines.length || settings)
            card.sections.push({ title: 'Settings', lines, src: settings });

        const block = (k: string): PNode | undefined => list.find((c) => c.k === k && Array.isArray(c.v));
        // a block of the trait, or — in a mod's trait without it — where it is made (with its first item)
        const place = (k: string, fields: string): SectionSource | undefined =>
        {
            const b = block(k);
            return b ? this.blockSection(b, 'field', ctx, fields) : card.src?.mod ? { parent: { ...card.src, kind: 'field', fields }, key: k, kind: 'field' } : undefined;
        };
        // opposites: a trait each (`opposites = { craven }`), each line changed or removed, "＋" another
        const opp = block('opposites');
        const oppAt = place('opposites', 'trait_opposites');

        if (opp || oppAt)
            card.sections.push({ title: 'Opposites', lines: opp ? this.fieldLines('trait_opposites', opp.v as PNode[], ctx).map((l) => ({ ...l, icon: 'trait' })) : [], src: oppAt, addLabel: 'opposite' });

        // compatibility: how well holders get along with holders of another trait (`compatibility = { brave = 15 }`)
        const compat = block('compatibility');
        const compatAt = place('compatibility', 'trait_compatibility');

        if (compat || compatAt)
        {
            const rows: Line[] = [];

            for (const c of compat && Array.isArray(compat.v) ? compat.v : [])
            {
                if (!c.k || typeof c.v !== 'string')
                    continue;

                const n = valueOf(c.v);
                const l: Line = { text: rich(n !== undefined ? { text: (n > 0 ? '+' : '') + formatNumber(n), kind: n >= 0 ? 'good' : 'bad', tip: c.v } : { text: c.v, kind: 'value' }, ' with ', this.d.ref(c.k, ['traits'])), icon: 'trait', tip: `${c.k} = ${c.v}` };

                if (ctx.file)
                    l.src = this.fieldAnchor(c, ctx, 'trait_compatibility');

                rows.push(l);
            }

            card.sections.push({ title: 'Compatibility', lines: rows, src: compatAt, addLabel: 'trait' });
        }

        // experience tracks: `track = { 20 = { <modifiers> } }`, `tracks = { name = { 20 = { … } } }`
        const levels = (b: PNode[]): Line[] =>
            b
                .filter((c) => c.k && /^\d+$/.test(c.k) && Array.isArray(c.v))
                .map((c) =>
                {
                    const l: Line = { text: [`From ${c.k} experience:`], children: this.d.statsOf(c.v as PNode[], ctx), icon: 'modifier', tip: c.k! };

                    if (ctx.file)
                        l.src = this.d.anchor(c, ctx, 'modifier', true);

                    return l;
                });
        const track = block('track');

        if (track && Array.isArray(track.v))
            card.sections.push({ title: 'Experience track', lines: levels(track.v), src: this.blockSection(track, 'field', ctx, 'trait_track'), addLabel: 'level' });
        // (a mod's trait without one: a row to make it with its first level)
        else if (card.src?.mod && !block('tracks'))
        {
            const at: SectionSource = { parent: { ...card.src, kind: 'field', fields: 'trait_track' }, key: 'track', kind: 'field' };
            card.sections.push({
                title: 'More settings',
                lines: [{ text: rich('Experience track: ', { text: 'not written', kind: 'ph' }), placeholder: true, tip: 'track = { 50 = { <modifiers> } } — modifiers from an amount of experience with the trait', act: { label: '＋ level', src: card.src, do: { kind: 'add', at, title: 'Experience track' } } }],
                noAdd: true
            });
        }

        const tracks = block('tracks');

        if (tracks && Array.isArray(tracks.v))
        {
            const rows = tracks.v
                .filter((t) => t.k && Array.isArray(t.v))
                .map((t) =>
                {
                    const l: Line = { text: [capitalize(humanize(t.k!)) + ':'], children: levels(t.v as PNode[]), tip: t.k! };

                    // (⤷＋ adds a level)
                    if (ctx.file)
                        l.src = this.fieldAnchor(t, ctx, 'trait_track', true);

                    return l;
                });
            card.sections.push({ title: 'Experience tracks', lines: rows, src: this.blockSection(tracks, 'other', ctx) });
        }

        const terrain = block('trait_exclusive_if_realm_contains');

        if (terrain && Array.isArray(terrain.v))
        {
            const names = terrain.v.filter((x) => typeof x.v === 'string').map((x) => this.d.ref(x.v as string, ['terrain_types']));
            const l: Line = { text: rich('Only assigned where the realm has ', ...names.flatMap((n, i) => (i ? [i === names.length - 1 ? ' or ' : ', ', n] : [n]))), icon: 'note' };

            if (ctx.file)
                l.src = this.d.anchor(terrain, ctx, 'other', false);

            card.sections.push({ title: 'Commander terrain', lines: [l] });
        }
    }

    /**
     * A trait's opinion effects beyond its modifiers: `same_opinion` / `same_opinion_if_same_faith` between holders,
     * `opposite_opinion` with holders of an opposite trait, and `triggered_opinion` blocks applying an opinion modifier
     * (value and punishment reasons read from common/opinion_modifiers) under conditions — see traits/_traits.info.
     */
    private traitOpinion(list: PNode[], trait: string, ctx: Ctx): Line[]
    {
        const lines: Line[] = [];
        const str = (l: PNode[], k: string): string | undefined =>
        {
            const c = l.find((x) => x.k === k);
            return typeof c?.v === 'string' ? c.v : undefined;
        };
        const num = (l: PNode[], k: string): number | undefined =>
        {
            const v = str(l, k);
            return v === undefined ? undefined : this.d.evalValue(v);
        };
        const val = (n: number): RichSeg => ({ text: (n > 0 ? '+' : '') + formatNumber(n), kind: n >= 0 ? 'good' : 'bad' });
        // (anchored to the statement it reads, when it is one)
        const line = (n: number | undefined, text: Rich, node?: PNode): Line =>
        {
            const l: Line = { text, icon: 'opinion', tone: n === undefined || n < 0 ? 'bad' : 'good' };

            if (node && ctx.file)
                l.src = this.fieldAnchor(node, ctx, 'trait_opinion');

            return l;
        };
        const name: RichSeg = { text: trait, kind: 'ph' };
        const nodeOf = (k: string): PNode | undefined => list.find((x) => x.k === k);

        const same = num(list, 'same_opinion');

        if (same)
            lines.push(line(same, rich(val(same), ' opinion between characters who are both ', name), nodeOf('same_opinion')));

        const sameFaith = num(list, 'same_opinion_if_same_faith');

        if (sameFaith)
            lines.push(line(sameFaith, rich(val(sameFaith), ' opinion between characters of the same faith who are both ', name), nodeOf('same_opinion_if_same_faith')));

        const opp = num(list, 'opposite_opinion');

        if (opp)
        {
            const node = list.find((x) => x.k === 'opposites');
            const names = (Array.isArray(node?.v) ? node.v : []).filter((x) => typeof x.v === 'string').map((x) => this.d.ref(x.v as string, ['traits']));
            lines.push(line(opp, rich(val(opp), ' opinion with characters who are ', ...names.flatMap((n, i) => (i ? [i === names.length - 1 ? ' or ' : ', ', n] : [n]))), nodeOf('opposite_opinion')));
        }

        // blocks that differ only in their doctrine parameter become one line listing the doctrines
        const groups = new Map<string, { b: PNode[]; params: string[]; always: boolean; nodes: PNode[]; }>();

        for (const tr of list.filter((x) => x.k === 'triggered_opinion' && Array.isArray(x.v)))
        {
            const b = tr.v as PNode[];

            if (!str(b, 'opinion_modifier'))
                continue;

            const k = ['opinion_modifier', 'same_faith', 'same_dynasty', 'check_missing', 'ignore_opinion_value_if_same_trait', 'male_only', 'female_only'].map((x) => str(b, x) ?? '').join('|');
            const g = groups.get(k) ?? { b, params: [], always: false, nodes: [] };
            g.nodes.push(tr);
            const param = str(b, 'parameter');

            if (param)
            {
                if (!g.params.includes(param))
                    g.params.push(param);
            }
            else
                g.always = true;

            groups.set(k, g);
        }

        const join = (segs: Rich[]): Rich => rich(...segs.flatMap((s, i) => (i ? [i === segs.length - 1 ? ' or ' : ', ', ...s] : s)));

        for (const { b, params, always, nodes } of groups.values())
        {
            const key = str(b, 'opinion_modifier')!;
            const om = this.idx.get('opinion_modifiers', key);
            const omDef = om ? this.idx.defNode(om) : undefined;
            const omBody = omDef ? this.body(omDef.node) : [];
            const value = num(omBody, 'opinion');
            const who = str(b, 'same_faith') === 'yes' ? 'characters of the same faith' : str(b, 'same_dynasty') === 'yes' ? 'members of the same dynasty' : 'others';
            let text = rich(value !== undefined ? rich(val(value), ' opinion from ') : 'Opinion from ', who, ' (', this.d.ref(key, ['opinion_modifiers']), ')');

            if (params.length && !always)
            {
                const missing = str(b, 'check_missing') === 'yes';
                // the doctrines setting a parameter read best by name (when few), else the game's sentence for it
                const doctrines = [...new Set(params.flatMap((p) => this.doctrinesWith(p)))];

                if (doctrines.length && doctrines.length <= 5 && params.every((p) => this.doctrinesWith(p).length))
                {
                    text = rich(text, missing ? ', unless their faith has ' : ', if their faith has ', join(doctrines.map((d) => [this.d.entitySeg(d)])));
                }
                else
                {
                    const sentences = params.map((p) =>
                    {
                        const s = this.d.loc('doctrine_parameter_' + p);
                        return s ? rich('“', s, '”') : [`“${humanize(p)}”`];
                    });
                    text = rich(text, missing ? ', unless their faith holds that ' : ', if their faith holds that ', join(sentences));
                }
            }

            if (str(b, 'ignore_opinion_value_if_same_trait') === 'yes')
                text = rich(text, ', not from others who are ', name, ' too');

            if (str(b, 'male_only') === 'yes')
                text = rich(text, ' (men only)');

            if (str(b, 'female_only') === 'yes')
                text = rich(text, ' (women only)');

            const reasons = [
                ['imprisonment_reason', 'imprison'],
                ['execute_reason', 'execute'],
                ['banish_reason', 'banish'],
                ['revoke_title_reason', 'revoke titles']
            ]
                .filter(([k]) => str(omBody, k) === 'yes')
                .map(([, w]) => w);

            if (reasons.length)
                text = rich(text, ' — lets them ', reasons.length > 1 ? reasons.slice(0, -1).join(', ') + ' or ' + reasons[reasons.length - 1] : reasons[0]);

            // (merged blocks are several statements: no anchor)
            lines.push(line(value, text, nodes.length === 1 ? nodes[0] : undefined));
        }

        return lines;
    }

    private nameExamples: Map<string, { score: number; ex: NameExample; }> | undefined;

    /**
     * An example of the game's own texts using a faith's or religion's name form (`GetName`, `GetAdjective`,
     * `GetAdherentName`, `GetAdherentNamePlural`): the shortest clean sentence — a few other codes at most, each filled in
     * as the text codes' examples print it (William of Normandy), else it is passed over — split around the form. A
     * religion's form without an example of its own: a faith's. Every loc text is scanned once per build.
     */
    nameExample(owner: 'faith' | 'religion', fn: string): NameExample | undefined
    {
        const m = (this.nameExamples ??= this.scanNameExamples());
        return (m.get(`${owner}:${fn}`) ?? (owner === 'religion' ? m.get(`faith:${fn}`) : undefined))?.ex;
    }

    private scanNameExamples(): Map<string, { score: number; ex: NameExample; }>
    {
        const forms = new Set(['GetName', 'GetAdjective', 'GetAdherentName', 'GetAdherentNamePlural']);
        const best = new Map<string, { score: number; ex: NameExample; }>();

        for (const key of this.idx.names('localization'))
        {
            const raw = this.idx.locRaw(key);

            // (a sentence: no line breaks, $values$, formatting, icons or concept links)
            if (!raw || raw.length < 24 || raw.length > 130 || !raw.includes('.Get') || /\\n|\$|#|@|\|E\]/.test(raw))
                continue;

            if (!/^["“]?[A-Z[]/.test(raw) || !/[.!?"”…]$/.test(raw))
                continue;

            const codes = [...raw.matchAll(/\[([^\][]+)\]/g)];

            if (!codes.length || codes.length > 3)
                continue;

            for (const target of codes)
            {
                const [chain, fmt] = target[1].split('|');
                const last = chain.slice(chain.lastIndexOf('.') + 1).replace(/NoTooltip$/, '');

                if (!forms.has(last))
                    continue;

                const lower = chain.toLowerCase();
                const owner = lower.includes('religion') ? 'religion' : lower.includes('faith') ? 'faith' : undefined;

                if (!owner)
                    continue;

                let before = '';
                let text = '';
                let at = 0;
                let ok = true;

                for (const c of codes)
                {
                    text += raw.slice(at, c.index);
                    at = c.index! + c[0].length;

                    if (c === target)
                    {
                        before = text;
                        text = '';
                        continue;
                    }

                    const fill = this.codeExample(c[1]);

                    if (fill === undefined)
                    {
                        ok = false;
                        break;
                    }

                    text += fill;
                }

                if (!ok)
                    continue;

                const after = text + raw.slice(at);
                const score = Math.abs(raw.length - 60) + 25 * (codes.length - 1);
                const k = `${owner}:${last}`;
                const cur = best.get(k);

                if (!cur || score < cur.score || (score === cur.score && key < cur.ex.key))
                    best.set(k, { score, ex: { key, before: before.replace(/^["“]/, ''), after: after.replace(/["”]$/, ''), cap: !!fmt?.includes('U') || !before.replace(/^["“]/, '').trim() } });
            }
        }

        return best;
    }

    /** What a character text code prints for the sample character (`spouse.GetSheHe` → "she"), else undefined. */
    private codeExample(inner: string): string | undefined
    {
        const [body, fmt] = inner.split('|');
        const parts = body.split('.');
        // (the scope — ROOT.Char, CHARACTER, a saved scope —, then the chain)
        let i = /^(ROOT|THIS|PREV|CHARACTER|Character|[a-z_][a-z0-9_]*)$/.test(parts[0]) ? 1 : 0;

        if (parts[i] === 'Char')
            i++;

        if (!i || i >= parts.length)
            return undefined;

        return this.locExample?.(parts.slice(i).join('.') + (fmt ? '|' + fmt : ''))?.split(' / ')[0];
    }

    /** A doctrine's parameters in the game's words (the picker's preview of the field set doctrine_parameters). */
    doctrineParamLines(nodes: PNode[]): Line[]
    {
        return paramLines(this, nodes, rootCtx(''), 'doctrine_parameter_');
    }

    /** A trait's opinion lines of a script snippet (the picker's preview of trait_opinion fields). */
    traitOpinionLines(nodes: PNode[]): Line[]
    {
        return this.traitOpinion(nodes, 'this trait', rootCtx(''));
    }

    /**
     * Values a text field offers (shared/fieldCatalog.ts `suggest`): `doctrine_parameters` — every boolean doctrine
     * parameter, named by the doctrines that set it; `doctrine_groups` — every doctrine with its group, in the game's
     * order of groups (a field's `group`); `faith_icons` / `doctrine_icons` — the icons of their folders.
     */
    fieldSuggestions(source: string): FieldSuggestion[]
    {
        if (source === 'doctrine_groups')
        {
            const out: FieldSuggestion[] = [];

            for (const g of doctrineGroups(this).list)
            {
                const group = { key: g.key, label: g.label, category: g.category, picks: g.picks };

                for (const d of g.doctrines)
                {
                    const e = this.idx.get('religion/doctrine_types', d);
                    const mods = e && this.idx.modTouch(e)?.mods;
                    out.push({ value: d, label: (e && this.idx.displayName(e)) ?? humanize(d), group, ...(mods?.length ? { mods } : {}) });
                }
            }

            return out;
        }

        if (source === 'faith_icons' || source === 'doctrine_icons')
        {
            const folder = source === 'faith_icons' ? 'gfx/interface/icons/faith' : 'gfx/interface/icons/faith_doctrines';
            return this.idx.imagesIn(folder).map((p) =>
            {
                const name = p.slice(p.lastIndexOf('/') + 1).replace(/\.dds$/i, '');
                return { value: name, label: p, image: p };
            });
        }

        // `keys:<type>`: the keys with a value of their own the type's definitions write (the picker's "Other setting…")
        const ks = /^keys:(.+)$/.exec(source);

        if (ks)
        {
            const counts = new Map<string, number>();

            // (big types — 70,000 characters —: the first definitions tell the keys)
            for (const name of this.idx.names(ks[1]).slice(0, 6000))
            {
                const e = this.idx.get(ks[1], name);
                const d = e && this.idx.defNode(e);

                for (const c of d && Array.isArray(d.node.v) ? d.node.v : [])
                    if (c.k && typeof c.v === 'string' && !this.d.isModifierKey(c.k))
                        counts.set(c.k, (counts.get(c.k) ?? 0) + 1);
            }

            return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count, label: `${count}×` }));
        }

        // `values:<type>:<key>`: the values the type's definitions write for a key (trait flags, groups …), most used first
        const v = /^values:([^:]+):(.+)$/.exec(source);

        if (v)
        {
            const counts = new Map<string, number>();

            for (const name of this.idx.names(v[1]).slice(0, 20000))
            {
                const e = this.idx.get(v[1], name);
                const d = e && this.idx.defNode(e);

                for (const c of d && Array.isArray(d.node.v) ? d.node.v : [])
                    if (c.k === v[2] && typeof c.v === 'string')
                        counts.set(c.v, (counts.get(c.v) ?? 0) + 1);
            }

            return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count, label: `${count}×` }));
        }

        if (source !== 'doctrine_parameters')
            return [];

        this.doctrinesWith('');
        const out: FieldSuggestion[] = [];

        for (const [param, doctrines] of this.paramDoctrines ?? [])
        {
            const names = doctrines.map((d) => this.idx.displayName(d) ?? humanize(d.name));
            const mods = [...new Set(doctrines.flatMap((d) => this.idx.modTouch(d)?.mods ?? []))];
            out.push({ value: param, label: names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : ''), count: doctrines.length, ...(mods.length ? { mods } : {}) });
        }

        return out.sort((a, b) => (a.value < b.value ? -1 : 1));
    }

    private locCodeList: LocCodes | undefined;

    /**
     * The codes the game's localization uses (the text editor's "Insert code…"), most used first: a character's data
     * functions after \`ROOT.Char.\` / \`<scope>.\` (\`GetHerHis\`, \`GetFaith.HighGodName\`, with \`|U\` variants), concept links
     * (\`[faith|E]\`), icons (\`@gold_icon!\`), formatting (\`#P … #!\`). Scanned once from every loc text (~0.4 s).
     */
    locCodes(): LocCodes
    {
        if (this.locCodeList)
            return this.locCodeList;

        const fns = new Map<string, number>();
        const concepts = new Map<string, number>();
        const icons = new Map<string, number>();
        const formats = new Map<string, number>();
        const add = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

        for (const key of this.idx.names('localization'))
        {
            const raw = this.idx.locRaw(key);

            if (!raw)
                continue;

            if (raw.includes('['))
            {
                for (const m of raw.matchAll(/\[([^\][]+)\]/g))
                {
                    const c = m[1];
                    const concept = /^([a-z_0-9]+)\|[A-Za-z]+$/.exec(c);

                    if (concept)
                    {
                        add(concepts, concept[1]);
                        continue;
                    }

                    const parts = c.split('.');
                    const chain = parts[0] === 'ROOT' && parts[1] === 'Char' ? parts.slice(2).join('.') : /^[a-z_][a-z_0-9]*$/.test(parts[0]) && parts[1]?.startsWith('Get') ? parts.slice(1).join('.') : undefined;

                    if (chain && !chain.includes('(') && !chain.includes("'"))
                        add(fns, chain);
                }
            }

            if (raw.includes('@'))
            {
                for (const m of raw.matchAll(/@(\w+)!/g))
                    add(icons, m[1]);
            }

            if (raw.includes('#'))
            {
                for (const m of raw.matchAll(/#([A-Za-z_]+)[ ;]/g))
                    add(formats, m[1]);
            }
        }

        const top = (m: Map<string, number>, n: number): [string, number][] => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
        this.locCodeList = {
            functions: top(fns, 400),
            concepts: top(concepts, 600).map(([key, count]) => ({ key, count, label: this.idx.plainLoc(`game_concept_${key}`) ?? humanize(key) })),
            icons: top(icons, 200),
            formats: top(formats, 30)
        };
        return this.locCodeList;
    }

    /** The scopes an entry's script names (saved scopes, `scope:x`): who its texts can speak of (`[actor.GetFirstName]`). */
    locScopes(e: Entity): string[]
    {
        const d = this.idx.defNode(e);

        if (!d)
            return [];

        const seen = new Map<string, number>();

        for (const m of d.src.matchAll(/(?:scope:|save_(?:temporary_)?scope_as\s*=\s*)([a-z_][a-z_0-9]*)/g))
            seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);

        return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    }

    private paramDoctrines: Map<string, Entity[]> | null = null;

    /** Doctrines whose `parameters` block turns a doctrine parameter on (built once). */
    private doctrinesWith(param: string): Entity[]
    {
        if (!this.paramDoctrines)
        {
            const m = (this.paramDoctrines = new Map<string, Entity[]>());

            for (const name of this.idx.names('religion/doctrine_types'))
            {
                const e = this.idx.get('religion/doctrine_types', name)!;
                const def = this.idx.defNode(e);
                const params = def ? this.body(def.node).find((c) => c.k === 'parameters') : undefined;

                for (const p of params && Array.isArray(params.v) ? params.v : [])
                {
                    if (!p.k || p.v !== 'yes')
                        continue;

                    const l = m.get(p.k);

                    if (l)
                        l.push(e);
                    else
                        m.set(p.k, [e]);
                }
            }
        }

        return this.paramDoctrines.get(param) ?? [];
    }

    private characterFacts(list: PNode[], card: EntityCard, ctx: Ctx): void
    {
        const s = (k: string): string | undefined =>
        {
            const c = list.find((x) => x.k === k);
            return typeof c?.v === 'string' ? c.v : undefined;
        };

        if (s('dynasty'))
            card.facts.push(rich('Dynasty: ', this.d.ref(s('dynasty')!, ['dynasties'])));

        if (s('culture'))
            card.facts.push(rich('Culture: ', this.d.ref(s('culture')!, ['culture/cultures'])));

        // (1.20: the rite — it wins over a faith; its faith at the first bookmark)
        const rite = s('rite');
        const faith = (rite && riteHistory(this.idx).faithOf(rite, BOOKMARK_DATE)) || s('religion') || s('faith');

        if (faith)
            card.facts.push(rich('Faith: ', this.d.ref(faith, ['faith'])));

        if (rite)
            card.facts.push(rich('Rite: ', this.d.ref(rite, ['religion/rite_types'])));

        const own = card.src && { src: { ...card.src, kind: 'field' as const, fields: 'character_history' }, key: card.key.name, kind: 'field' as const };
        // who they are: name, sex, dynasty, house, culture, faith, parents, skills … (shared/fields/settings.ts `characters`)
        const fields = list.filter((x) => x.k && typeof x.v === 'string' && x.k !== 'trait' && fieldOf('characters', x.k));

        if (fields.length || card.src)
            card.sections.push({ title: 'Who they are', lines: this.fieldLines('characters', fields, ctx), src: card.src && { src: { ...card.src, kind: 'field', fields: 'characters' }, key: card.key.name, kind: 'field' }, addLabel: 'setting' });

        const traits = list.filter((x) => x.k === 'trait' && typeof x.v === 'string');

        if (traits.length || card.src)
            card.sections.push({ title: 'Traits', lines: traits.map((x) => ({ text: [this.d.ref(x.v as string, ['traits'])], icon: 'trait', tip: `trait = ${x.v}`, src: this.fieldAnchor(x, ctx, 'character_history') })), src: own });

        // Life: each date's statements in words — the history keys here, the rest (effect = { … }, add_trait_xp …) as effects
        const born = list.find((c) => c.k && /^\d+\.\d+\.\d+$/.test(c.k) && Array.isArray(c.v) && c.v.some((x) => x.k === 'birth'))?.k;
        const year = (d: string): number =>
        {
            const [y, m, day] = d.split('.').map(Number);
            return y + (m - 1) / 12 + (day - 1) / 365;
        };
        const person = (id: string): RichSeg => this.d.ref(id, ['characters']);
        const say = (x: PNode): Line[] =>
        {
            const v = typeof x.v === 'string' ? x.v : undefined;
            const field = (k: string): string | undefined =>
            {
                const f = Array.isArray(x.v) ? x.v.find((c) => c.k === k) : undefined;
                return typeof f?.v === 'string' ? f.v : undefined;
            };
            const tip = `${x.k} = ${v ?? '{ … }'}`;

            switch (x.k)
            {
                case 'birth':
                    return [{ text: ['Born'], icon: 'note', tip }];
                case 'death':
                {
                    const reason = field('death_reason');
                    const killer = field('killer');
                    const why = reason ? (this.idx.plainLoc(reason) ?? humanize(reason.replace(/^death_/, ''))) : undefined;
                    return [{ text: rich('Dies', why ? ` — ${why.charAt(0).toLowerCase()}${why.slice(1)}` : '', killer ? ', killed by ' : '', killer ? person(killer) : ''), icon: 'death', tip }];
                }
                case 'trait':
                    return v ? [{ text: rich('Gets the trait ', this.d.ref(v, ['traits'])), icon: 'trait', tip }] : [];
                case 'add_spouse':
                case 'add_matrilineal_spouse':
                    return v ? [{ text: rich(x.k === 'add_matrilineal_spouse' ? 'Marries (matrilineal) ' : 'Marries ', person(v)), icon: 'opinion', tip }] : [];
                case 'remove_spouse':
                    return v ? [{ text: rich('No longer married to ', person(v)), tip }] : [];
                case 'add_concubine':
                    return v ? [{ text: rich('Takes ', person(v), ' as a concubine'), tip }] : [];
                case 'give_nickname':
                    return v ? [{ text: rich('Known as “', this.idx.plainLoc(v) ?? humanize(v.replace(/^nick_/, '')), '”'), icon: 'note', tip }] : [];
                case 'culture':
                    return v ? [{ text: rich('Culture: ', this.d.ref(v, ['culture/cultures'])), tip }] : [];
                case 'religion':
                case 'faith':
                    return v ? [{ text: rich('Faith: ', this.d.ref(v, ['faith'])), tip }] : [];
                case 'rite':
                    return v ? [{ text: rich('Rite: ', this.d.ref(v, ['religion/rite_types'])), tip }] : [];
                case 'employer':
                    return v ? [{ text: rich('At the court of ', person(v)), tip }] : [];
                case 'dynasty':
                case 'dynasty_house':
                    return v ? [{ text: rich(x.k === 'dynasty' ? 'Dynasty: ' : 'House: ', this.d.ref(v, x.k === 'dynasty' ? ['dynasties'] : ['dynasty_houses'])), tip }] : [];
                case 'set_father':
                    return v ? [{ text: rich('Father: ', person(v)), tip }] : [];
                case 'set_mother':
                    return v ? [{ text: rich('Mother: ', person(v)), tip }] : [];
                case 'government':
                    return v ? [{ text: rich('Government: ', this.d.ref(v, ['governments'])), tip }] : [];
                case 'effect':
                    return Array.isArray(x.v) ? this.d.effects(x.v, ctx) : [];
            }

            return this.d.effects([x], ctx);
        };
        const life: Line[] = [];

        for (const c of list)
        {
            if (!c.k || !/^\d+\.\d+\.\d+$/.test(c.k) || !Array.isArray(c.v))
                continue;

            const lines = c.v.filter((x) => x.k).flatMap(say);
            const age = born && c.k !== born ? Math.floor(year(c.k) - year(born)) : undefined;
            life.push({
                text: rich({ text: c.k, kind: 'value' }, age !== undefined && age >= 0 ? ` · age ${age}` : ''),
                icon: 'note',
                children: lines,
                // (nothing but behind-the-scenes lines: the date is one too)
                hidden: lines.length > 0 && lines.every((l) => l.hidden),
                src: this.d.anchor(c, ctx, 'effect', true)
            });
        }

        if (life.length)
            card.sections.push({ title: 'Life', lines: life, src: own });
    }
}

function truncate(s: string, n: number): string
{
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
