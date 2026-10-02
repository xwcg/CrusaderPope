/**
 * Turns CK3 trigger and effect blocks into readable lines ("Has the trait Brave", "+100 Prestige",
 * "Leads to: The Good Doctor in 7–14 days"), similar to the in-game tooltips.
 *
 * Scripted triggers/effects are expanded inline (with $PARAM$ substitution) like the game does, unless
 * trigger_localization / effect_localization gives them a custom text. Every trigger_event on the way is
 * collected as a FollowUp together with the conditions/chances that lead to it.
 */
import type { PNode } from '../indexer/parser.ts';
import type { DefAnchor, Entity, GameIndex } from '../indexer/gameIndex.ts';
import { typeLabel } from '../indexer/schema.ts';
import { stmtCheck } from '../indexer/override.ts';
import type { EntityKey, FollowUp, Line, LineSource, Rich, RichSeg, SectionSource, StatementCheck } from '../../shared/api.ts';
import { capitalize, formatNumber, humanize, locToRich, rich, richToString, signed, titleCase } from './text.ts';
import { ITERATORS, modifierScopeOf, scopeTypeByName } from '../../shared/scriptCatalog.ts';

export interface Ctx
{
    /** Readable label of the current scope ("you", "Recipient", "each vassal"). */
    scope: string;
    /** Conditions/chances on the way here (for follow-ups). */
    when: Rich[];
    hidden: boolean;
    followUps: FollowUp[];
    /** Remaining depth for expanding scripted triggers/effects. */
    expand: number;
    /** Names of scripted things currently being expanded (cycle guard). */
    stack: string[];
    /** Source text the current nodes were parsed from (for tooltips). */
    src: string;
    /**
     * The definition `src` is the text of, when the nodes are its own text as written: lines made from them carry
     * `src` anchors (docs/mods.md, "Editing in place"). Absent in expanded scripted triggers/effects (their text is
     * another definition's, with $PARAM$ substituted) and in snippets.
     */
    file?: DefAnchor;
    /** Scope type of the current scope when known ('character', 'landed_title' …): a hint for adding statements. */
    scopeType?: string;
    /** Scope type of the script's root when it is not a character (a doctrine's: faith) — the anchors' `root`. */
    rootType?: string;
    /** the types of the saved scopes the script knows (`target_title` → landed_title): `scope:x = { … }` blocks' scope hints */
    savedTypes?: Record<string, string>;
    /** the type of the definition described (a card's): its condition blocks' hints for the picker (blockSection) */
    entityType?: string;
    /**
     * the nodes are another definition's text read in place of a call (an inlined scripted effect / trigger): that
     * definition — its lines' anchors say so (LineSource.owner)
     */
    owner?: EntityKey;
    /** the lines are read for a mod's text (its entry, or an effect it calls, at any depth): inlined ones are anchored */
    inMod?: boolean;
}

export function rootCtx(src: string, file?: DefAnchor, scopeType?: string): Ctx
{
    return { scope: 'you', when: [], hidden: false, followUps: [], expand: 4, stack: [], src, file, scopeType, ...(scopeType && scopeType !== 'character' ? { rootType: scopeType } : {}) };
}

const LOGIC_LABELS: Record<string, string> = {
    AND: 'All of the following:',
    OR: 'At least one of the following:',
    NOR: 'None of the following:',
    NAND: 'Not all of the following:'
};

/** An if's one logic group as its heading ("If any of these are true:"). */
const IF_GROUP: Record<string, string> = {
    [LOGIC_LABELS.AND]: 'all of these are true:',
    [LOGIC_LABELS.OR]: 'any of these are true:',
    [LOGIC_LABELS.NOR]: 'none of these are true:',
    [LOGIC_LABELS.NAND]: 'not all of these are true:'
};

/** Keys that switch scope when used with a block (besides scope:x / var:x / chains). */
const SCOPE_LINKS = new Set([
    'root',
    'prev',
    'this',
    'from',
    'liege',
    'top_liege',
    'father',
    'mother',
    'real_father',
    'primary_spouse',
    'betrothed',
    'primary_heir',
    'player_heir',
    'designated_heir',
    'employer',
    'host',
    'holder',
    'faith',
    'culture',
    'religion',
    'house',
    'dynasty',
    'primary_title',
    'capital_county',
    'capital_province',
    'capital_barony',
    'location',
    'title_province',
    'county',
    'duchy',
    'kingdom',
    'empire',
    'de_jure_liege',
    'killer',
    'imprisoner',
    'court_owner',
    'domicile',
    'owner',
    'artifact_owner',
    'scheme_owner',
    'scheme_target',
    'target',
    'recipient',
    'actor',
    'secondary_actor',
    'secondary_recipient',
    'secret_owner',
    'secret_target',
    'involved_activity',
    'current_travel_plan',
    'activity_host',
    'spouse',
    'councillor',
    'war',
    'army',
    'house_head',
    'dynast',
    'religious_head',
    'head_of_faith',
    'story_owner',
    'task_contract_employer',
    'task_contract_taker'
]);

const SKIP_EFFECT_KEYS = new Set([
    'save_scope_as',
    'save_temporary_scope_as',
    'save_scope_value_as',
    'save_temporary_scope_value_as',
    'clear_saved_scope',
    'play_music_cue',
    'play_sound_effect',
    'add_activity_log_entry',
    'set_artifact_description',
    'set_artifact_name',
    'debug_log',
    'debug_log_scopes',
    'assert_if',
    'assert_read',
    'name',
    'ai_chance',
    'flavor',
    'trigger',
    'show_as_unavailable',
    'fallback',
    'exclusive',
    'is_cancel_option',
    'clicksound',
    'highlight_portrait',
    'skill',
    'reason',
    'custom_tooltip_type',
    'duel_mode'
]);

const QUIET_EFFECT = /(^|_)(flag|variable|variable_list|list|temporary_list|global_list)$|^(add_to|remove_from|clear)_|_variable$|^set_(global_|local_)?variable|^change_(global_|local_)?variable|^remove_(global_|local_)?variable|^round_|^clamp_/;

/** Resource-style effects: key → [label, tone when positive]. */
const RESOURCES: Record<string, [string, 'good' | 'bad', string]> = {
    add_gold: ['Gold', 'good', 'gold'],
    add_short_term_gold: ['Gold', 'good', 'gold'],
    remove_short_term_gold: ['Gold', 'bad', 'gold'],
    remove_long_term_gold: ['Gold', 'bad', 'gold'],
    add_prestige: ['Prestige', 'good', 'prestige'],
    add_prestige_no_experience: ['Prestige', 'good', 'prestige'],
    add_prestige_experience: ['Prestige experience', 'good', 'prestige'],
    add_piety: ['Piety', 'good', 'piety'],
    add_piety_no_experience: ['Piety', 'good', 'piety'],
    add_piety_experience: ['Piety experience', 'good', 'piety'],
    add_stress: ['Stress', 'bad', 'stress'],
    add_dread: ['Dread', 'good', 'dread'],
    add_tyranny: ['Tyranny', 'bad', 'dread'],
    add_legitimacy: ['Legitimacy', 'good', 'prestige'],
    change_influence: ['Influence', 'good', 'prestige'],
    add_influence: ['Influence', 'good', 'prestige'],
    add_treasury: ['Treasury', 'good', 'gold'],
    add_herd: ['Herd', 'good', 'gold'],
    add_county_control: ['County control', 'good', 'modifier'],
    change_county_control: ['County control', 'good', 'modifier'],
    change_development_progress: ['Development progress', 'good', 'modifier'],
    change_development_level: ['Development', 'good', 'modifier'],
    add_diplomacy_skill: ['Diplomacy', 'good', 'skill'],
    add_martial_skill: ['Martial', 'good', 'skill'],
    add_stewardship_skill: ['Stewardship', 'good', 'skill'],
    add_intrigue_skill: ['Intrigue', 'good', 'skill'],
    add_learning_skill: ['Learning', 'good', 'skill'],
    add_prowess_skill: ['Prowess', 'good', 'skill'],
    add_diplomacy_lifestyle_xp: ['Diplomacy lifestyle experience', 'good', 'skill'],
    add_martial_lifestyle_xp: ['Martial lifestyle experience', 'good', 'skill'],
    add_stewardship_lifestyle_xp: ['Stewardship lifestyle experience', 'good', 'skill'],
    add_intrigue_lifestyle_xp: ['Intrigue lifestyle experience', 'good', 'skill'],
    add_learning_lifestyle_xp: ['Learning lifestyle experience', 'good', 'skill'],
    add_wanderer_lifestyle_xp: ['Wanderer lifestyle experience', 'good', 'skill']
};

const COMPARE_WORDS: Record<string, string> = {
    '>=': 'is at least',
    '>': 'is more than',
    '<=': 'is at most',
    '<': 'is less than',
    '=': 'is',
    '==': 'is',
    '!=': 'is not',
    '?=': 'is'
};

type LinePart = Partial<Line> & { text: Rich; };

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Whether the if / else_if chain continuing at `from` in the text ends in an else (else_ifs skipped, brace-matched). */
function chainHasElse(src: string, from: number): boolean
{
    let i = from;
    const skip = (): void =>
    {
        for (;;)
        {
            while (i < src.length && /\s/.test(src[i]))
                i++;

            if (src[i] !== '#')
                return;

            while (i < src.length && src[i] !== '\n')
                i++;
        }
    };

    for (;;)
    {
        skip();
        const m = /^(trigger_)?else(_if)?\s*=\s*\{/.exec(src.slice(i, i + 40));

        if (!m)
            return false;

        if (!m[2])
            return true;

        // (past the else_if's block: braces counted, strings and comments skipped)
        i += m[0].length;

        for (let depth = 1; i < src.length && depth > 0; i++)
        {
            const c = src[i];

            if (c === '"')
            {
                for (i++; i < src.length && src[i] !== '"'; i++);
            }
            else if (c === '#')
            {
                for (; i < src.length && src[i] !== '\n'; i++);
            }
            else if (c === '{')
                depth++;
            else if (c === '}')
                depth--;
        }
    }
}

export class Describer
{
    private idx: GameIndex;
    private formatCache = new Map<string, Record<string, string> | null>();

    constructor(idx: GameIndex)
    {
        this.idx = idx;
    }

    // -------------------------------------------------------------------------
    // Values & names
    // -------------------------------------------------------------------------

    lookupDisplay = (key: string): string | undefined =>
    {
        const e = this.idx.named(key)[0];
        return e ? this.idx.displayName(e) : undefined;
    };

    loc(key: string): Rich | undefined
    {
        const t = this.idx.plainLoc(key, 0, true);
        return t === undefined ? undefined : locToRich(t, this.lookupDisplay, (inner) => this.idx.bracketRef(inner));
    }

    entitySeg(e: Entity): RichSeg
    {
        const d = this.idx.displayName(e);
        return { text: d ?? titleCase(humanize(e.name)), kind: 'entity', ref: { type: e.type, name: e.name }, tip: `${typeLabel(e.type)}: ${e.name}` };
    }

    /** Link to a definition by name, preferring the given types. */
    ref(name: string, types?: string[]): RichSeg
    {
        let e: Entity | undefined;

        if (types)
        {
            for (const t of types)
                if ((e = this.idx.get(t, name)))
                    break;
        }

        if (!e)
            e = this.idx.named(name)[0];

        if (e)
            return this.entitySeg(e);

        return { text: titleCase(humanize(name)), kind: 'code', tip: name };
    }

    /** Readable label of a scope expression: `scope:recipient.liege` → "Recipient’s liege". */
    scopeLabel(path: string, ctx?: Ctx): string
    {
        const segs = path.split('.');
        // a link is someone's: `liege` at the top is your liege, inside "each child" that child's liege
        const first = segs[0];
        const relative = !!ctx && !first.includes(':') && !/^(root|this|prev|from)$/i.test(first);
        const words = segs.map((s) =>
        {
            if (/^root$/i.test(s))
                return 'you';

            if (s === 'this')
                return ctx?.scope ?? 'they';

            if (s === 'prev')
                return 'the previous one';

            const c = s.indexOf(':');

            if (c > 0)
            {
                const p = s.slice(0, c);
                const n = s.slice(c + 1);

                if (p === 'scope')
                    return titleCase(humanize(n));

                if (p === 'var' || p === 'local_var' || p === 'global_var' || p === 'dead_var')
                    return `“${humanize(n)}”`;

                const e = this.idx.named(n)[0];
                const d = e && this.idx.displayName(e);
                return d ?? titleCase(humanize(n));
            }

            return humanize(s);
        });
        let out = words[0];

        if (relative)
            out = `${possessive(ctx!.scope)} ${out.toLowerCase()}`;

        for (let i = 1; i < words.length; i++)
            out = possessive(out) + ' ' + words[i].toLowerCase();

        return out;
    }

    /** `head`: a line's head ("Your liege:") — capitalized */
    scopeSeg(path: string, ctx?: Ctx, head = false): RichSeg
    {
        const text = this.scopeLabel(path, ctx);
        return { text: head ? capitalize(text) : text, kind: 'scope', tip: path };
    }

    /** Tries to resolve a script value to a constant. */
    evalValue(name: string, depth = 0): number | undefined
    {
        if (NUMERIC.test(name))
            return parseFloat(name);

        if (depth > 6)
            return undefined;

        const e = this.idx.get('script_values', name);

        if (!e)
            return undefined;

        const d = this.idx.defNode(e);

        if (!d)
            return undefined;

        const v = d.node.v;

        if (typeof v === 'string')
            return this.evalValue(v, depth + 1);

        if (v.length === 1 && v[0].k === 'value' && typeof v[0].v === 'string')
            return this.evalValue(v[0].v, depth + 1);

        return undefined;
    }

    /** A value operand: number, script value, scope, or a definition. */
    valueSeg(v: string, ctx?: Ctx): RichSeg
    {
        if (NUMERIC.test(v))
            return { text: formatNumber(parseFloat(v)), kind: 'value' };

        if (/^(scope|root|prev|this|var|local_var|global_var)\b/.test(v) || v.includes('.'))
            return this.scopeSeg(v, ctx);

        if (v.startsWith('tier_'))
            return { text: capitalize(humanize(v.slice(5))), kind: 'value', tip: v };

        if (v.startsWith('flag:'))
            return { text: `“${humanize(v)}”`, kind: 'value', tip: v };

        // database links: trait:measles, faith:catholic, character:163110
        const db = /^\w+:([\w-]+)$/.exec(v);
        const dbEntity = db && this.idx.named(db[1])[0];

        if (dbEntity)
            return this.entitySeg(dbEntity);

        const n = this.evalValue(v);

        if (n !== undefined)
            return { text: formatNumber(n), kind: 'value', tip: v };

        const e = this.idx.named(v)[0];

        if (e)
            return this.entitySeg(e);

        return { text: humanize(v), kind: 'value', tip: v };
    }

    private tip(n: PNode, ctx: Ctx): string
    {
        const t = ctx.src.slice(n.s, n.e);
        return t.length > 600 ? t.slice(0, 600) + '\n…' : t;
    }

    /**
     * Where a node is written in its file (Line.src), when the context reads a definition's own text. `inner`: the node
     * is a block of statements of the same kind — statements can be added inside (at its end).
     */
    anchor(n: PNode, ctx: Ctx, kind: LineSource['kind'], inner: boolean): LineSource | undefined
    {
        const f = ctx.file;

        if (!f)
            return undefined;

        // (a text with $PARAM$s filled in: its offsets are mapped back to the definition's own)
        const m = f.map ?? ((o: number): number => o);
        const a: LineSource = { file: f.file, rel: f.rel, line: f.line + n.line - 1, s: f.start + m(n.s), e: f.start + m(n.e), kind, hash: f.hash };

        if (f.mod)
            a.mod = f.mod;

        // (found again by its own text when the file changes elsewhere before the index has read it again)
        if (f.text)
            a.stmt = this.stmtOf(f, a.s, a.e);

        if (ctx.owner)
            a.owner = ctx.owner;

        // (an unclosed block has no closing brace to add before)
        if (inner && Array.isArray(n.v) && ctx.src.charCodeAt(n.e - 1) === 125)
            a.inner = [f.start + m(n.vs) + 1, f.start + m(n.e) - 1];

        if (ctx.scopeType)
            a.scope = ctx.scopeType;

        if (ctx.rootType)
            a.root = ctx.rootType;

        if (n.k && /^(trigger_)?(if|else_if)$/.test(n.k) && Array.isArray(n.v) && !chainHasElse(ctx.src, n.e))
            a.ifKey = n.k;

        // (inside an iterator or a scope switch: another scope, someone else)
        if (a.inner)
        {
            const inside = this.insideOf(n, ctx);

            if (inside.scope)
                a.innerScope = inside.scope;

            if (inside.subject)
                a.subject = inside.subject;
        }

        return a;
    }

    /**
     * Statement checks made (LineSource.stmt), by file and offsets: an inlined scripted effect repeats its statements at
     * every call. The texts don't change while this describer lives (one per index revision); a cap bounds it.
     */
    private stmts = new Map<string, StatementCheck>();

    private stmtOf(f: DefAnchor, s: number, e: number): StatementCheck
    {
        const key = `${f.file}|${s}|${e}`;
        let c = this.stmts.get(key);

        if (!c)
        {
            if (this.stmts.size > 200_000)
                this.stmts.clear();

            this.stmts.set(key, c = stmtCheck(f.text!, s, e));
        }

        return c;
    }

    /**
     * The context a scripted effect / trigger is read in where it is called (its text `src`, `$PARAM$`s filled in with
     * `args`): where it can be edited from the view — the calling text is a mod's, or the definition is — its lines are
     * anchored to the definition (the filled-in offsets mapped back to its own, `owner` its key: docs/mods.md "Editing
     * in place"); else, as the game's are read, without anchors.
     */
    inlinedCtx(e: Entity, src: string, args: Record<string, string> | undefined, ctx: Ctx): Ctx
    {
        const inMod = !!ctx.inMod || !!ctx.file?.mod;
        const inner: Ctx = { ...ctx, src, file: undefined, owner: undefined, expand: ctx.expand - 1, stack: [...ctx.stack, e.name], inMod };
        // (the game's text only read for a mod's entry — at any depth —: the game's entries calling the game's effects stay
        // as they were)
        const first = ctx.file && this.idx.defAnchor(e);
        const a = first && (inMod || first.mod) ? (first.text ? first : this.idx.defAnchor(e, undefined, true)) : undefined;

        if (!a?.text)
            return inner;

        // (the text read must be the definition's, filled in: else its offsets say nothing about the file — both come
        // from the same file text, so its length tells)
        const map = args ? filledMap(a.text.slice(a.start, a.end), args) : undefined;

        if ((map ? map.text.length : a.end - a.start) !== src.length)
            return inner;

        return { ...inner, file: map ? { ...a, map: map.map } : a, owner: { type: e.type, name: e.name } };
    }

    /** Who a block's statements are about: an iterator's item ("the child"), a scope switch's target ("Liege"). */
    insideOf(n: PNode, ctx: Ctx): { scope?: string; subject?: string; }
    {
        const k = n.k ?? '';
        const it = !NOT_ITERATORS.has(k) && /^(any|every|random|ordered)_(\w+)$/.exec(k);

        if (it && !this.idx.get('scripted_effects', k) && !this.idx.get('scripted_triggers', k))
            return { scope: iteratedScope(it[2]), subject: `the ${this.iterLabel(it[2])}` };

        if (this.isScopeKey(k))
            return { scope: linkedScope(k, ctx.scopeType, ctx), subject: this.scopeLabel(k, ctx) };

        return {};
    }

    // -------------------------------------------------------------------------
    // Triggers
    // -------------------------------------------------------------------------

    triggers(nodes: PNode[], ctx: Ctx): Line[]
    {
        const out: Line[] = [];

        for (const n of nodes)
        {
            if (n.k === null || n.k === '')
                continue;

            const l = this.trigger(n, ctx, false);

            if (l)
                out.push(l);
        }

        return out;
    }

    private group(text: Rich | string, children: Line[], extra: Partial<Line> = {}): Line
    {
        return { text: typeof text === 'string' ? [text] : text, children, ...extra };
    }

    trigger(n: PNode, ctx: Ctx, neg: boolean): Line | null
    {
        const l = this.triggerLine(n, ctx, neg);

        if (l && ctx.file)
        {
            // a line of an inner statement (NOT / AND / OR around a single condition) stands for the whole statement; its
            // block is not what the line shows, so nothing is added inside
            const collapsed = l.src !== undefined;
            l.src = this.anchor(n, ctx, 'trigger', !collapsed && Array.isArray(n.v) && this.holdsTriggers(n.k!));

            // (a trigger_if: "＋ if" into its limit)
            if (n.k === 'trigger_if' || n.k === 'trigger_else_if')
                l.limitSrc = this.limitOf(n, ctx);
        }

        return l;
    }

    /** Blocks whose statements are conditions of their own (statements can be added inside). */
    private holdsTriggers(k: string): boolean
    {
        return TRIGGER_BLOCKS.has(k) || k.startsWith('any_') || this.isScopeKey(k);
    }

    private triggerLine(n: PNode, ctx: Ctx, neg: boolean): Line | null
    {
        const k = n.k!;
        const block = Array.isArray(n.v) ? n.v : null;
        const v = typeof n.v === 'string' ? n.v : '';
        const tip = this.tip(n, ctx);

        // `key != value`: the negation of `key = value` (the phrases read `=`; scope comparisons read `!=` themselves)
        if (n.op === '!=' && !block && !/^\w+:/.test(k) && k !== 'this' && k !== 'root' && k !== 'prev')
            return this.triggerLine({ ...n, op: '=' }, ctx, !neg);

        if (k === 'NOT' && block)
        {
            const kids = this.triggers(block, ctx);

            if (kids.length === 1 && block.filter((c) => c.k).length === 1)
                return this.trigger(block.find((c) => c.k)!, ctx, !neg);

            return this.group(neg ? 'All of the following:' : 'None of the following:', kids, { tip });
        }

        if (LOGIC_LABELS[k] && block)
        {
            const kids = this.triggers(block, ctx);

            if (kids.length === 1 && (k === 'AND' || k === 'OR') && !neg)
                return kids[0];

            let label = LOGIC_LABELS[k];

            if (neg)
                label = k === 'AND' ? LOGIC_LABELS.NAND : k === 'OR' ? LOGIC_LABELS.NOR : k === 'NOR' ? LOGIC_LABELS.OR : LOGIC_LABELS.AND;

            return this.group(label, kids, { tip });
        }

        if ((k === 'trigger_if' || k === 'trigger_else_if' || k === 'trigger_else') && block)
        {
            const limit = block.find((c) => c.k === 'limit');
            const rest = block.filter((c) => c.k !== 'limit');
            const conds = limit && Array.isArray(limit.v) ? this.triggers(limit.v, ctx) : [];
            return this.ifLine(k === 'trigger_else' ? 'else' : k === 'trigger_else_if' ? 'elseif' : 'if', conds, this.triggers(rest, ctx), tip);
        }

        if (k === 'calc_true_if' && block)
        {
            const amount = block.find((c) => c.k === 'amount');
            const kids = this.triggers(
                block.filter((c) => c.k !== 'amount'),
                ctx
            );
            return this.group(`${neg ? 'Fewer than' : 'At least'} ${typeof amount?.v === 'string' ? amount.v : '?'} of the following:`, kids, { tip });
        }

        if (TRIGGER_SKIP.has(k))
            return null;

        if (k === 'always')
            return { text: [(v === 'yes') !== neg ? 'Always' : 'Never'], tip };

        if ((k === 'custom_description' || k === 'custom_description_no_bullet' || k === 'custom_tooltip') && block)
        {
            const textNode = block.find((c) => c.k === 'text');
            const key = typeof textNode?.v === 'string' ? textNode.v : '';
            // (its text: a trigger_localization entry's, else the loc key's — ✎ text changes that one: locKey)
            const tl = this.triggerLoc(key, neg);
            const own = tl ? undefined : this.loc(key);
            const text = tl?.text ?? own ?? [humanize(key)];
            const inner = this.triggers(
                block.filter((c) => !['text', 'subject', 'object', 'value'].includes(c.k ?? '')),
                ctx
            );
            const locKey = tl?.key ?? (own || k === 'custom_tooltip' ? key : undefined);
            return { text, tip, children: inner, collapsed: true, ...(locKey ? { locKey } : {}) };
        }

        if (k === 'custom_tooltip' && v)
            return { text: this.loc(v) ?? [humanize(v)], tip, locKey: v };

        // iterators: any_vassal = { count = 2 ... }
        const any = /^any_(\w+)$/.exec(k);

        if (any && block)
        {
            const count = block.find((c) => c.k === 'count');
            const percent = block.find((c) => c.k === 'percent');
            const what = this.iterLabel(any[1]);
            const typeNode = block.find((c) => c.k === 'type' && typeof c.v === 'string');
            const kids = this.triggers(
                block.filter((c) => !ITERATOR_PARAMS.has(c.k ?? '') && c.k !== 'count' && c.k !== 'percent'),
                { ...ctx, scope: what, scopeType: iteratedScope(any[1]) }
            );
            let head: string;
            let many = false;

            if (count && typeof count.v === 'string')
                ({ head, many } = countHead(count.op ?? '=', count.v, what, neg));
            else if (percent && typeof percent.v === 'string')
            {
                many = true;
                const op = neg ? negateOp(percent.op ?? '>=') : (percent.op ?? '>=');
                head = `${COUNT_WORDS[op] ?? 'At least'} ${formatNumber(parseFloat(percent.v) * 100)}% of ${plural(what)}`;
            }
            else
                head = neg ? `No ${what}` : `Any ${what}`;

            const headRich = rich(head, typeNode ? rich(' (', this.ref(typeNode.v as string), ')') : '', kids.length ? ' where:' : many ? ' exist' : ' exists');
            return this.group(headRich, kids, { icon: 'loop', tip });
        }

        // scope switch
        if (block && this.isScopeKey(k))
        {
            const label = this.scopeLabel(k, ctx);
            const sctx = { ...ctx, scope: label, scopeType: linkedScope(k, ctx.scopeType, ctx) };
            let kids = this.triggers(block, sctx);

            // NOT = { liege = { … } }: one condition is negated in place, several become "Not all of the following"
            if (neg)
            {
                const keyed = block.filter((c) => c.k);
                const one = keyed.length === 1 ? this.trigger(keyed[0], sctx, true) : null;
                kids = one ? [one] : [this.group(LOGIC_LABELS.NAND, kids)];
            }

            return this.group([this.scopeSeg(k, ctx, true), ':'], kids, { icon: 'scope', tip });
        }

        // scripted trigger
        const st = this.idx.get('scripted_triggers', k);

        if (st)
        {
            const negate = neg !== (v === 'no');
            return this.scriptedTrigger(st, block, negate, ctx, tip);
        }

        // comparisons with a scope on the left: scope:a = scope:b, this = root
        if (!block && (/^\w+:/.test(k) || k === 'this' || k === 'root' || k === 'prev') && !NUMERIC.test(v))
        {
            const op = n.op ?? '=';
            const word = /^[<>]/.test(op) ? ` ${neg ? negateCompare(op) : COMPARE_WORDS[op]} ` : (op === '!=') !== neg ? ' is not ' : ' is ';
            return { text: rich(this.valueSeg(k, ctx), word, this.valueSeg(v, ctx)), tip };
        }

        const phrase = this.triggerPhrase(k, n, block, v, ctx, neg);

        if (phrase)
            return { tip, ...phrase };

        // numeric / script-value comparison: age >= 16, my_value > 3
        if (!block && n.op && n.op !== '=' && n.op !== '?=')
        {
            return { text: rich(this.compareLabel(k), ' ', neg ? negateCompare(n.op) : COMPARE_WORDS[n.op] ?? n.op, ' ', this.valueSeg(v, ctx)), tip };
        }

        if (!block && (NUMERIC.test(v) || this.idx.get('script_values', k)))
        {
            return { text: rich(this.compareLabel(k), neg ? ' is not ' : ' is ', this.valueSeg(v, ctx)), tip };
        }

        // generic: has_x = y / is_x = yes
        if (!block)
            return { text: this.genericPredicate(k, v, ctx, neg), tip };

        // unknown block trigger: show key + a summary of its fields
        return { text: rich(neg ? 'Not: ' : '', capitalize(humanize(k)), this.fieldSummary(block, ctx)), tip };
    }

    private negSwap(neg: boolean, yes: string, no: string): string
    {
        return neg ? no : yes;
    }

    private triggerPhrase(k: string, n: PNode, block: PNode[] | null, v: string, ctx: Ctx, negIn: boolean): LinePart | null
    {
        const isNo = v === 'no';
        const neg = negIn !== isNo;
        const field = (key: string): string | undefined =>
        {
            const c = block?.find((x) => x.k === key);
            return typeof c?.v === 'string' ? c.v : undefined;
        };

        switch (k)
        {
            case 'has_trait':
            case 'has_inactive_trait':
                return { text: rich(this.negSwap(neg, 'Has the trait ', 'Does not have the trait '), this.traitSeg(v)), icon: 'trait' };
            case 'has_character_flag':
            case 'has_dynasty_flag':
            case 'has_house_flag':
            case 'has_title_flag':
            case 'has_county_flag':
            case 'has_global_flag':
                return { text: rich(this.negSwap(neg, 'Has been marked ', 'Has not been marked '), this.codeSeg(v, 'flag', 'Flag')), icon: 'flag' };
            case 'has_variable':
            case 'has_global_variable':
            case 'has_local_variable':
            case 'has_variable_list':
                return { text: rich('Variable ', this.codeSeg(v, 'variable', 'Variable'), neg ? ' is not set' : ' is set'), icon: 'var' };
            case 'exists':
                if (v.startsWith('var:') || v.startsWith('global_var:') || v.startsWith('local_var:'))
                    return { text: rich('Variable ', this.codeSeg(v.slice(v.indexOf(':') + 1), 'variable', 'Variable'), neg ? ' is not set' : ' is set'), icon: 'var' };

                return { text: rich(this.scopeSeg(v, ctx), neg ? ' does not exist' : ' exists') };
            case 'is_ai':
                return { text: [neg ? 'Is the player' : 'Is an AI character'] };
            case 'is_alive':
                return { text: [neg ? 'Is dead' : 'Is alive'] };
            case 'is_adult':
                return { text: [neg ? 'Is a child' : 'Is an adult'] };
            case 'is_female':
                return { text: [neg ? 'Is male' : 'Is female'] };
            case 'is_male':
                return { text: [neg ? 'Is female' : 'Is male'] };
            case 'faith':
            case 'culture':
            case 'religion':
                return { text: rich(capitalize(k), neg ? ' is not ' : ' is ', this.valueSeg(v, ctx)) };
            case 'has_character_modifier':
            case 'has_county_modifier':
            case 'has_province_modifier':
            case 'has_dynasty_modifier':
            case 'has_house_modifier':
                return { text: rich(neg ? 'Is not affected by ' : 'Is affected by ', this.ref(v, ['modifiers'])), icon: 'modifier' };
            case 'has_realm_law':
                return { text: rich(neg ? 'Does not have the law ' : 'Has the law ', this.ref(v, ['laws'])) };
            case 'has_title':
                return { text: rich(neg ? 'Does not hold ' : 'Holds ', this.valueSeg(v, ctx)) };
            case 'government_has_flag':
                return { text: rich(neg ? 'Government is not ' : 'Government is ', { text: humanize(v.replace(/^government_(is_)?/, '')), kind: 'value', tip: v }) };
            case 'has_government':
                return { text: rich(neg ? 'Government is not ' : 'Government is ', this.ref(v, ['governments'])) };
            case 'has_doctrine':
                return { text: rich(neg ? 'Faith lacks the doctrine ' : 'Faith has the doctrine ', this.ref(v, ['religion/doctrine_types'])) };
            case 'has_cultural_pillar':
            case 'has_cultural_tradition':
                return { text: rich(neg ? 'Culture does not have ' : 'Culture has ', this.ref(v)) };
            case 'has_dlc_feature':
                return { text: rich(neg ? 'Requires the DLC feature ' : 'Needs the DLC feature ', { text: humanize(v), kind: 'value', tip: v }, neg ? ' to be missing' : '') };
            case 'has_game_rule':
                return { text: rich(neg ? 'Game rule is not ' : 'Game rule is ', this.ref(v, ['game_rule_options'])) };
            case 'geographical_region':
                return { text: rich(neg ? 'Is not in ' : 'Is in ', { text: titleCase(humanize(v.replace(/^(world|custom|ghw_region|special)_/, ''))), kind: 'value', tip: v }) };
            case 'terrain':
                return { text: rich(neg ? 'Terrain is not ' : 'Terrain is ', this.ref(v, ['terrain_types'])) };
            case 'has_perk':
                return { text: rich(neg ? 'Does not have the perk ' : 'Has the perk ', this.ref(v, ['lifestyle_perks'])) };
            case 'has_focus':
                return { text: rich(neg ? 'Does not have the focus ' : 'Has the focus ', this.ref(v, ['focuses'])) };
            case 'has_court_position':
                return { text: rich(neg ? 'Is not the ' : 'Is the ', this.ref(v, ['court_positions/types'])) };
            case 'employs_court_position':
                return { text: rich(neg ? 'Does not employ a ' : 'Employs a ', this.ref(v, ['court_positions/types'])) };
            case 'is_in_list':
                return { text: rich(neg ? 'Is not in the list ' : 'Is in the list ', this.codeSeg(v)) };
            case 'is_target_in_variable_list':
            case 'is_target_in_global_variable_list':
                return {
                    text: rich(this.valueSeg(field('target') ?? '?', ctx), neg ? ' is not in list ' : ' is in list ', this.codeSeg(field('name') ?? '?', 'variable', 'Variable')),
                    hidden: true
                };
            case 'opinion':
            case 'reverse_opinion':
            {
                const target = field('target') ?? '?';
                const valNode = block?.find((x) => x.k === 'value');
                const cmp = valNode ? `${negIn ? negateCompare(valNode.op ?? '=') : COMPARE_WORDS[valNode.op ?? '='] ?? valNode.op} ${this.valueText(String(valNode.v), ctx)}` : '';
                return {
                    text: k === 'opinion'
                        ? rich('Opinion of ', this.scopeSeg(target, ctx), ' ', cmp)
                        : rich(this.scopeSeg(target, ctx), '’s opinion of ', ctx.scope === 'you' ? 'you' : ctx.scope, ' ', cmp),
                    icon: 'opinion'
                };
            }
            case 'has_opinion_modifier':
            case 'reverse_has_opinion_modifier':
                return {
                    text: rich(
                        neg ? 'Does not have the opinion ' : 'Has the opinion ',
                        this.ref(field('modifier') ?? '?', ['opinion_modifiers']),
                        k === 'has_opinion_modifier' ? ' towards ' : ' from ',
                        this.scopeSeg(field('target') ?? '?', ctx)
                    ),
                    icon: 'opinion'
                };
            case 'has_trait_xp':
            {
                const valNode = block?.find((x) => x.k === 'value');
                return {
                    text: rich(
                        this.traitSeg(field('trait') ?? '?'),
                        field('track') ? ` (${humanize(field('track')!)})` : '',
                        ' experience ',
                        valNode ? `${COMPARE_WORDS[valNode.op ?? '='] ?? valNode.op} ${this.valueText(String(valNode.v), ctx)}` : ''
                    ),
                    icon: 'trait'
                };
            }
            case 'is_at_war':
                return { text: [neg ? 'Is at peace' : 'Is at war'] };
            case 'has_activity_type':
            {
                const seg = this.ref(v, ['activities/activity_types']);
                return { text: rich(neg ? 'Is not ' : 'Is ', /^[aeiou]/i.test(typeof seg === 'string' ? seg : seg.text) ? 'an ' : 'a ', seg) };
            }
            case 'is_available_quick':
            {
                const words: Record<string, [string, string]> = {
                    alive: ['alive', 'dead'],
                    adult: ['an adult', 'a child'],
                    at_war: ['at war', 'not at war'],
                    imprisoned: ['imprisoned', 'not imprisoned'],
                    activity: ['in an activity', 'not in an activity'],
                    hostage: ['a hostage', 'not a hostage'],
                    travelling: ['travelling', 'not travelling'],
                    incapable: ['incapable', 'not incapable']
                };
                const parts = (block ?? [])
                    .filter((x) => x.k && typeof x.v === 'string')
                    .map((x) => (words[x.k!] ? words[x.k!][x.v === 'yes' ? 0 : 1] : `${x.v === 'yes' ? '' : 'not '}${humanize(x.k!)}`));
                return { text: [(neg ? 'Is not available' : 'Is available') + (parts.length ? ` (${parts.join(', ')})` : '')] };
            }
            case 'trait_is_virtue':
            case 'trait_is_sin':
                return { text: rich(this.traitSeg(v), neg ? ' is not a ' : ' is a ', k === 'trait_is_virtue' ? 'virtue' : 'sin', ' of their faith'), icon: 'trait' };
        }

        const rel = /^has_relation_(\w+)$/.exec(k);

        if (rel && v)
            return { text: rich(neg ? 'Is not ' : 'Is ', this.relationSeg(rel[1]), ' of ', this.scopeSeg(v, ctx)), icon: 'opinion' };

        const of = /^is_(\w+)_of$/.exec(k);

        if (of && v && !['yes', 'no'].includes(v))
            return { text: rich(neg ? 'Is not ' : 'Is ', humanize(of[1]), ' of ', this.scopeSeg(v, ctx)) };

        return null;
    }

    private ifLine(kind: 'if' | 'elseif' | 'else', conds: Line[], children: Line[], tip?: string): Line
    {
        if (kind === 'else')
            return { text: ['Otherwise:'], icon: 'else', children, tip };

        const prefix = kind === 'if' ? 'If ' : 'Otherwise, if ';

        // (the one condition in the line's text, its segments kept apart: the view edits it on its own — Line.condSegs)
        // (also a scripted trigger read through — collapsed: its name says what it checks)
        if (conds.length === 1 && (!conds[0].children?.length || conds[0].collapsed) && !conds[0].conditions)
        {
            const cond = lowerFirst(conds[0].text);
            return { text: [prefix, ...cond, ':'], condSegs: [1, 1 + cond.length], icon: 'if', ifConds: conds, children, tip };
        }

        // (one AND / OR / NOR / NAND around all of them: "If any of these are true:" with its conditions, not a group in a group)
        const only = conds.length === 1 && conds[0].children?.length && !conds[0].collapsed && conds[0].text.length === 1 ? IF_GROUP[String(conds[0].text[0])] : undefined;

        if (only)
            return { text: [prefix + only], icon: 'if', conditions: conds[0].children, ifConds: conds, children, tip };

        return { text: [prefix + 'all of these are true:'], icon: 'if', conditions: conds, ifConds: conds, children, tip };
    }

    /**
     * Condition lines → one clause for an "If …" label, with subjects filled in: "you have the trait Vengeful",
     * "Lover has the trait Adulterer", "your opinion of First Lover is more than 20", "you are Parent of Child".
     * Scope groups lend their scope as subject, AND/OR/NOR groups become and/or lists, short scripted triggers are
     * read through, iterators become "any vassal that …".
     */
    conditionClause(lines: Line[], subject: RichSeg | null | 'plural' = 'you'): Rich
    {
        return joinList(
            simplifyTriggerIf(lines)
                .map((l) => this.lineClause(l, subject))
                .filter((p) => p.length),
            ' and '
        );
    }

    private lineClause(l: Line, subject: RichSeg | null | 'plural'): Rich
    {
        const kids = l.children ?? [];
        const first = l.text[0];
        const label = typeof first === 'string' ? first : '';

        // trigger_if inside a condition: only checked when its limit holds → "… (when you are travelling)"
        if (l.icon === 'if' || l.icon === 'else')
        {
            if (!kids.length)
                return [];

            const body = this.conditionClause(kids, subject);

            if (l.icon === 'else')
                return rich(body, ' (otherwise)');

            const cond = l.ifConds?.length ? this.conditionClause(l.ifConds, subject) : lowerFirst(stripColon(l.text));
            return rich(body, label.startsWith('Otherwise') ? ' (otherwise, when ' : ' (when ', cond, ')');
        }

        if (kids.length)
        {
            // scope switch "‹Lover›:" → Lover is the subject of the inner conditions
            if (l.icon === 'scope' && typeof first !== 'string' && l.text.length === 2)
                return this.conditionClause(kids, /^you$/i.test(first.text) ? 'you' : first);

            const sub = (join: string): Rich =>
                joinList(
                    kids.map((k) => this.lineClause(k, subject)).filter((p) => p.length),
                    join
                );

            if (label === LOGIC_LABELS.AND)
                return sub(' and ');

            if (label === LOGIC_LABELS.OR)
                return kids.length === 2 ? rich('either ', sub(' or ')) : sub(' or ');

            if (label === LOGIC_LABELS.NOR)
                return kids.length === 2 ? rich('neither ', sub(' nor ')) : rich('none of these: ', sub('; '));

            if (label === LOGIC_LABELS.NAND)
                return kids.length === 2 ? rich('not both ', sub(' and ')) : rich('not all of these: ', sub('; '));

            const atLeast = /^(At least|Fewer than) (\S+) of the following:$/.exec(label);

            if (atLeast)
                return rich(atLeast[1].toLowerCase(), ' ', atLeast[2], ' of these: ', sub('; '));

            if (l.icon === 'loop')
            {
                // "Any vassal where:" → "there is a vassal that has …", "Every child where:" → "every child is …",
                // "At least 3 knights where:" → "at least 3 knights that have …"
                const head = l.text.map((s) => (typeof s === 'string' ? s.replace(/ where:$/, '') : s));
                const q = typeof head[0] === 'string' ? /^(Any|No|Every|At least [^ ]+(?: of)?) ([\s\S]*)$/.exec(head[0]) : null;

                if (q)
                {
                    const rest = rich(q[2], head.slice(1));
                    const article = /^[aeiou]/i.test(q[2]) ? 'an ' : 'a ';

                    if (q[1] === 'Any')
                        return rich('there is ', article, rest, ' that ', this.conditionClause(kids, null));

                    if (q[1] === 'No')
                        return rich('there is no ', rest, ' that ', this.conditionClause(kids, null));

                    if (q[1] === 'Every')
                        return rich('every ', rest, ' ', this.conditionClause(kids, null));

                    return rich(q[1].toLowerCase(), ' ', rest, ' that ', this.conditionClause(kids, 'plural'));
                }

                return rich(lowerFirst(head), ' that ', this.conditionClause(kids, null));
            }

            // scripted triggers: read their content when it is short
            if (l.collapsed && countLeaves(kids) <= 3)
            {
                const inner = this.conditionClause(kids, subject);
                return label.startsWith('Not: ') ? rich('not (', inner, ')') : inner;
            }
        }

        // a named (scripted) condition: "Lover meets ‹Lover 0001 breakup opinion›" (the link shows its content)
        if (typeof first !== 'string' && first.kind === 'entity' && subject !== null)
        {
            return subject === 'you' ? rich('you meet ', l.text) : subject === 'plural' ? rich('meet ', l.text) : rich(subject, ' meets ', l.text);
        }

        if (typeof first === 'string' && first.startsWith('Not: ') && typeof l.text[1] !== 'string' && l.text[1]?.kind === 'entity' && subject !== null)
        {
            const rest = l.text.slice(1);
            return subject === 'you' ? rich('you do not meet ', rest) : subject === 'plural' ? rich('do not meet ', rest) : rich(subject, ' does not meet ', rest);
        }

        return withSubject(stripColon(l.text), subject);
    }

    private scriptedTrigger(e: Entity, block: PNode[] | null, neg: boolean, ctx: Ctx, tip: string): Line
    {
        const custom = this.triggerLoc(e.name, neg);

        if (custom)
            return { text: custom.text, tip, locKey: custom.key };

        const label = capitalize(humanize(e.name));

        if (ctx.expand <= 0 || ctx.stack.includes(e.name))
            return { text: [neg ? 'Not: ' : '', { text: label, kind: 'entity', ref: { type: e.type, name: e.name }, tip: e.name }], tip };

        const args = block ? argsOf(block) : undefined;
        const d = this.idx.defNode(e, args);
        // (another definition's text, $PARAM$ substituted: its lines are anchored to that definition — inlinedCtx)
        const inner = d && Array.isArray(d.node.v) ? this.triggers(d.node.v, this.inlinedCtx(e, d.src, args, ctx)) : [];

        // one-line scripted triggers read better as their content ("Has bp1 dlc" → "Needs the DLC feature …")
        if (inner.length === 1 && !inner[0].children?.length && !inner[0].conditions)
        {
            return neg ? { ...inner[0], text: rich('Not: ', inner[0].text), tip } : { ...inner[0], tip };
        }

        return {
            text: rich(neg ? 'Not: ' : '', { text: label, kind: 'entity', ref: { type: e.type, name: e.name }, tip: e.name }),
            children: inner,
            collapsed: true,
            tip
        };
    }

    /** Text from common/trigger_localization for a (scripted) trigger. */
    private triggerLocText(name: string, neg: boolean): Rich | undefined
    {
        return this.triggerLoc(name, neg)?.text;
    }

    /** Text from common/trigger_localization for a (scripted) trigger, and the loc key it comes from. */
    private triggerLoc(name: string, neg: boolean): { text: Rich; key: string; } | undefined
    {
        const e = this.idx.get('trigger_localization', name);

        if (!e)
            return undefined;

        const d = this.idx.defNode(e);

        if (!d || !Array.isArray(d.node.v))
            return undefined;

        // (an entry may have only the text for when it fails — `first_not` —: then the condition reads "Not: <that>")
        const keys = neg ? ['global_not', 'first_not', 'third_not', 'global', 'first', 'third'] : ['global', 'first', 'third', 'global_not', 'first_not', 'third_not'];

        for (const k of keys)
        {
            const c = d.node.v.find((x) => x.k === k);

            if (typeof c?.v === 'string')
            {
                const r = this.templateLoc(c.v);

                if (r)
                    return { text: !neg && k.endsWith('_not') ? rich('Not: ', r) : r, key: c.v };
            }
        }

        return undefined;
    }

    /** Loc text with $VALUE$-style template parameters filled in (unknown ones removed). */
    templateLoc(key: string, value?: string): Rich | undefined
    {
        const t = this.idx.plainLoc(key);

        if (t === undefined)
            return undefined;

        const filled = t.replace(/\$([A-Z_]+)(\|[^$]*)?\$/g, (_m, p: string, fmt: string | undefined) =>
        {
            if (p !== 'VALUE' || value === undefined)
                return '';

            const n = this.evalValue(value);

            if (n === undefined)
                return humanize(value);

            return fmt && fmt.includes('+') ? signed(n) : formatNumber(n);
        });
        const out = locToRich(filled, this.lookupDisplay);

        // ([TARGET_TITLE.GetName] reads "Target Title": the statement's value is that target — "on England")
        if (value === undefined || !/^\w+:[\w-]+$|^(root|scope:\w+)$/.test(value))
            return out;

        return out.flatMap((s) =>
        {
            if (typeof s !== 'string')
                return /^Target [A-Z][a-z]+$/i.test(s.text) ? [this.valueSeg(value)] : [s];

            if (!/\bTarget [A-Z][a-z]+\b/.test(s))
                return [s];

            const parts = s.split(/\bTarget [A-Z][a-z]+\b/);
            return parts.flatMap((p, i) => (i ? [this.valueSeg(value), p] : [p]));
        });
    }

    private effectLocText(name: string, value?: string): Rich | undefined
    {
        const e = this.idx.get('effect_localization', name);

        if (e)
        {
            const d = this.idx.defNode(e);

            if (d && Array.isArray(d.node.v))
            {
                for (const k of ['global', 'first', 'third'])
                {
                    const c = d.node.v.find((x) => x.k === k);

                    if (typeof c?.v === 'string')
                    {
                        const r = this.templateLoc(c.v, value);

                        if (r)
                            return r;
                    }
                }
            }
        }

        return this.templateLoc(name + '_global', value) ?? this.templateLoc(name + '_first', value);
    }

    private genericPredicate(k: string, v: string, ctx: Ctx, neg: boolean): Rich
    {
        const words = humanize(k);
        const yesNo = v === 'yes' || v === 'no';
        const n = neg !== (v === 'no');

        if (yesNo)
        {
            if (words.startsWith('is '))
                return [capitalize(n ? 'is not ' + words.slice(3) : words)];

            if (words.startsWith('has '))
                return [capitalize(n ? 'does not have ' + words.slice(4) : words)];

            if (words.startsWith('can '))
                return [capitalize(n ? 'cannot ' + words.slice(4) : words)];

            return [n ? 'Not: ' + words : capitalize(words)];
        }

        return rich(n ? 'Not: ' : '', capitalize(words), ': ', this.valueSeg(v, ctx));
    }

    private compareLabel(k: string): RichSeg
    {
        const sv = this.idx.get('script_values', k);

        if (sv)
            return { text: capitalize(humanize(k)), kind: 'entity', ref: { type: sv.type, name: sv.name }, tip: k };

        const loc = this.idx.plainLoc(k);
        return capitalize(loc && loc.length < 40 ? loc : humanize(k));
    }

    private valueText(v: string, ctx: Ctx): string
    {
        const s = this.valueSeg(v, ctx);
        return typeof s === 'string' ? s : s.text;
    }

    private fieldSummary(block: PNode[], ctx: Ctx): Rich
    {
        const parts: Rich = [];

        for (const c of block)
        {
            if (!c.k || typeof c.v !== 'string' || parts.length >= 6)
                continue;

            parts.push(parts.length ? ', ' : ' (', humanize(c.k), ': ', this.valueSeg(c.v, ctx));
        }

        if (parts.length)
            parts.push(')');

        return rich(parts);
    }

    private traitSeg(v: string): RichSeg
    {
        const name = v.replace(/^trait:/, '');
        return this.ref(name, ['traits']);
    }

    private relationSeg(rel: string): RichSeg
    {
        const e = this.idx.get('scripted_relations', rel);
        return e ? this.entitySeg(e) : { text: humanize(rel), kind: 'value', tip: rel };
    }

    private codeSeg(v: string, type?: string, label?: string): RichSeg
    {
        const name = v.replace(/^(flag|var|global_var|local_var):/, '');
        return { text: `“${humanize(name)}”`, kind: 'code', ref: type ? { type, name } : undefined, tip: `${label ?? 'Name'}: ${name}` };
    }

    private iterLabel(what: string): string
    {
        const e = this.idx.get('scripted_lists', what);
        const w = humanize(what)
            .replace(/^(owned|held) /, '$1 ')
            .replace(/\bin list\b/, 'in the list');
        return e ? w : w;
    }

    /**
     * Walks a script's scope blocks, knowing at each statement who it is about — "you", "your liege", "one of your
     * courtiers, at random" (with the iterator's conditions: a limit, or an any_'s own statements) — for the event card's
     * "Who's who". `top`: who the script's root is and how its links read ('you' → "your liege", 'them' → "their
     * liege"). `holder`: the scope block around the statement; `scoped`: inside one (not the root any more).
     */
    private walkScopes(
        nodes: PNode[],
        ctx: Ctx,
        top: { who: string; owner: string; },
        visit: (n: PNode, at: { who: string; conditions?: Line[]; holder?: PNode; scoped: boolean; scopeType?: string; }) => void
    ): void
    {
        const scripted = (k: string): boolean => !!(this.idx.get('scripted_effects', k) || this.idx.get('scripted_triggers', k));
        // who: the one a statement right here is about; owner: whose links / lists the block's own blocks go through
        const walk = (list: PNode[], who: string, owner: string, c: Ctx, holder: PNode | undefined, conds: Line[] | undefined, scoped: boolean): void =>
        {
            for (const n of list)
            {
                const k = n.k;

                if (!k)
                    continue;

                visit(n, { who, conditions: conds, holder, scoped, scopeType: c.scopeType });

                if (!Array.isArray(n.v))
                    continue;

                const it = !NOT_ITERATORS.has(k) && /^(any|every|random|ordered)_(\w+)$/.exec(k);

                if (it && !scripted(k))
                {
                    const what = this.iterLabel(it[2]);
                    const many = `${possessive(owner)} ${plural(what)}`;
                    const label = it[1] === 'random' ? `one of ${many}, at random` : it[1] === 'ordered' ? `the first of ${many} in order` : it[1] === 'every' ? `each of ${many}` : `one of ${many}`;
                    // (an effect iterator's limit; a trigger iterator's own statements are its conditions)
                    const limit = n.v.find((x) => x.k === 'limit');
                    const inner = it[1] === 'any' ? n.v.filter((x) => x.k && !ITERATOR_PARAMS.has(x.k) && !/^save_/.test(x.k) && x.k !== 'count' && x.k !== 'percent') : limit && Array.isArray(limit.v) ? limit.v : [];
                    const ic: Ctx = { ...c, scope: `the ${what}`, scopeType: iteratedScope(it[2]) };
                    const lines = inner.length ? this.triggers(inner, ic) : [];
                    walk(n.v, label, `the ${what}`, ic, n, lines.length ? lines : undefined, true);
                    continue;
                }

                if (this.isScopeKey(k) && !scripted(k))
                {
                    const label = this.scopeLabel(k, { ...c, scope: owner });
                    walk(n.v, label, label, { ...c, scope: label, scopeType: linkedScope(k, c.scopeType, c) }, n, undefined, true);
                    continue;
                }

                // (if, limit, trigger, an option, an on_action's effect …: the same one)
                walk(n.v, who, owner, c, holder, conds, scoped);
            }
        };
        walk(nodes, top.who, top.owner, ctx, undefined, undefined, false);
    }

    /**
     * The scopes a script names (`save_scope_as` / `save_temporary_scope_as`) and who each is, read from where the save
     * stands: "You", "Your liege", "One of your courtiers, at random" with the iterator's conditions. `alone`: the block
     * around the save does nothing else (forgetting the name removes the block).
     */
    savedScopes(
        nodes: PNode[],
        ctx: Ctx,
        top: { who: string; owner: string; } = { who: 'you', owner: 'you' }
    ): { name: string; who: string; conditions?: Line[]; temporary: boolean; save: PNode; holder?: PNode; alone: boolean; type?: string; }[]
    {
        const out: { name: string; who: string; conditions?: Line[]; temporary: boolean; save: PNode; holder?: PNode; alone: boolean; type?: string; }[] = [];
        this.walkScopes(nodes, ctx, top, (n, at) =>
        {
            if ((n.k !== 'save_scope_as' && n.k !== 'save_temporary_scope_as') || typeof n.v !== 'string' || out.some((o) => o.name === n.v))
                return;

            const h = at.holder;
            const alone = !!h && Array.isArray(h.v) && h.v.every((x) => x === n || (x.k !== null && (x.k === 'limit' || ITERATOR_PARAMS.has(x.k))));
            out.push({ name: n.v, who: capitalize(at.who), conditions: at.conditions, temporary: n.k === 'save_temporary_scope_as', save: n, holder: h, alone, type: at.scopeType });
        });
        return out;
    }

    /**
     * Who a script sends `event` to (`trigger_event = event` / `{ id = event }`): '' when its own root gets it, else who
     * — "one of their parents, at random" (`top.owner` 'them': the script's root is "they") — with the conditions; null
     * when the script does not fire it.
     */
    firedWho(nodes: PNode[], event: string, ctx: Ctx, top: { who: string; owner: string; } = { who: 'them', owner: 'them' }): { who: string; conditions?: Line[]; } | null
    {
        let found: { who: string; conditions?: Line[]; } | null = null;
        this.walkScopes(nodes, ctx, top, (n, at) =>
        {
            if (found || n.k !== 'trigger_event')
                return;

            if (n.v === event || (Array.isArray(n.v) && n.v.some((x) => x.k === 'id' && x.v === event)))
                found = { who: at.scoped ? at.who : '', conditions: at.conditions };
        });
        return found;
    }

    isScopeKey(k: string): boolean
    {
        if (/^\w+:/.test(k))
            return true;

        if (k.includes('.'))
            return true;

        return SCOPE_LINKS.has(k);
    }

    // -------------------------------------------------------------------------
    // Effects
    // -------------------------------------------------------------------------

    effects(nodes: PNode[], ctx: Ctx): Line[]
    {
        const out: Line[] = [];

        for (let i = 0; i < nodes.length; i++)
        {
            const n = nodes[i];

            if (n.k === null || n.k === '')
                continue;

            // if / else_if / else chains share "previous conditions"
            const l = this.effect(n, ctx);

            if (!l)
                continue;

            for (const x of Array.isArray(l) ? l : [l])
            {
                const fin = finalize(x);

                if (fin)
                    out.push(fin);
            }
        }

        return out;
    }

    private withWhen(ctx: Ctx, w: Rich | string): Ctx
    {
        return { ...ctx, when: [...ctx.when, typeof w === 'string' ? [w] : w] };
    }

    effect(n: PNode, ctx: Ctx): Line | Line[] | null
    {
        const l = this.effectLine(n, ctx);

        // (several lines: a hidden_effect's statements, anchored each, or an inlined scripted effect's, from another text)
        if (l && !Array.isArray(l) && ctx.file)
        {
            l.src = this.anchor(n, ctx, 'effect', Array.isArray(n.v) && this.holdsEffects(n.k!));
            l.limitSrc = this.limitOf(n, ctx);
        }

        // an inlined scripted effect in a mod's entry: the call gets a line of its own — edited, moved, removed — with the
        // effect's lines under it (the game's entries read it inline, as the game shows it)
        const se = Array.isArray(l) && l.length && ctx.file?.mod && n.k ? this.idx.get('scripted_effects', n.k) : undefined;

        if (se && Array.isArray(l))
        {
            const args = Array.isArray(n.v) ? n.v.filter((c) => c.k && typeof c.v === 'string') : [];
            const text: Rich = [
                { text: capitalize(humanize(n.k!)), kind: 'entity', ref: { type: se.type, name: se.name }, tip: n.k! },
                ...(args.length ? [' (', ...args.flatMap((c, i): Rich => [i ? ', ' : '', capitalize(humanize(c.k!)), ': ', this.valueSeg(c.v as string, ctx)]), ')'] : []),
                ':'
            ];
            return { text, children: l, icon: 'call', hidden: l.every((x) => x.hidden), src: this.anchor(n, ctx, 'effect', false) };
        }

        return l;
    }

    /**
     * An `if` / `else_if` (`trigger_if` / `trigger_else_if` among conditions) or effect iterator's `limit` as a place to
     * add conditions ("＋ if"): the block, or — none yet — where one is made (before the block's first statement).
     * Conditions there are about the iterator's item.
     */
    limitOf(n: PNode, ctx: Ctx): SectionSource | undefined
    {
        const k = n.k ?? '';

        if (!Array.isArray(n.v))
            return undefined;

        const isIf = k === 'if' || k === 'else_if' || k === 'trigger_if' || k === 'trigger_else_if';

        if (!isIf && !(/^(every|random|ordered)_\w+$/.test(k) && !this.idx.get('scripted_effects', k)))
            return undefined;

        const inside = isIf ? {} : this.insideOf(n, ctx);
        const scope = inside.scope ?? ctx.scopeType;
        const extra = { ...(scope ? { scope } : {}), ...(inside.subject ? { subject: inside.subject } : {}) };
        const limit = n.v.find((c) => c.k === 'limit' && Array.isArray(c.v));

        if (limit)
        {
            const src = this.anchor(limit, ctx, 'trigger', true);
            return src && { src: { ...src, ...(scope ? { innerScope: scope } : {}), ...(inside.subject ? { subject: inside.subject } : {}) }, key: 'limit', kind: 'trigger', ...extra };
        }

        const first = n.v.find((c) => c.k);
        const body = k.startsWith('trigger_') ? 'trigger' : 'effect';
        const before = first && this.anchor(first, ctx, body, false);
        const parent = this.anchor(n, ctx, body, true);

        if (!before && !parent)
            return undefined;

        return { ...(before ? { before } : { parent }), key: 'limit', kind: 'trigger', ...extra };
    }

    /** Blocks whose statements are effects of their own (statements can be added inside). */
    private holdsEffects(k: string): boolean
    {
        if (EFFECT_BLOCKS.has(k))
            return true;

        return (/^(every|random|ordered)_/.test(k) || this.isScopeKey(k)) && !this.idx.get('scripted_effects', k);
    }

    private effectLine(n: PNode, ctx: Ctx): Line | Line[] | null
    {
        const k = n.k!;
        const block = Array.isArray(n.v) ? n.v : null;
        const v = typeof n.v === 'string' ? n.v : '';
        const tip = this.tip(n, ctx);
        const field = (key: string): string | undefined =>
        {
            const c = block?.find((x) => x.k === key);
            return typeof c?.v === 'string' ? c.v : undefined;
        };

        if (SKIP_EFFECT_KEYS.has(k))
            return null;

        if ((k === 'if' || k === 'else_if' || k === 'else') && block)
        {
            const limit = block.find((c) => c.k === 'limit');
            const conds = limit && Array.isArray(limit.v) ? this.triggers(limit.v, ctx) : [];
            const whenText: Rich = k === 'else' ? ['otherwise'] : conds.length === 1 ? rich('if ', lowerFirst(conds[0].text)) : [`if ${conds.length} conditions are met`];
            const kids = this.effects(
                block.filter((c) => c.k !== 'limit'),
                this.withWhen(ctx, whenText)
            );

            // (an empty one is shown in a mod's files — it is being written: its statements are added with ⤷＋)
            if (!kids.length && !ctx.file?.mod)
                return null;

            return this.ifLine(k === 'else' ? 'else' : k === 'else_if' ? 'elseif' : 'if', conds, kids, tip);
        }

        if (k === 'hidden_effect' && block)
        {
            const kids = this.effects(block, { ...ctx, hidden: true });

            if (!kids.length)
                return null;

            return kids.map((l) => ({ ...l, hidden: true }));
        }

        if (k === 'show_as_tooltip' && block)
        {
            const kids = this.effects(block, { ...ctx, followUps: [] });
            return kids.length ? { text: ['Shown in the tooltip (applied elsewhere):'], children: kids, icon: 'note', tip } : null;
        }

        if (k === 'custom_tooltip' || k === 'custom_description' || k === 'custom_description_no_bullet')
        {
            // (✎ text changes the loc text: a custom_tooltip's key is one, a custom_description's when it has a text)
            if (!block)
                return { text: this.loc(v) ?? [humanize(v)], icon: 'note', tip, ...(k === 'custom_tooltip' || this.loc(v) ? { locKey: v } : {}) };

            const key = field('text') ?? '';
            const kids = this.effects(
                block.filter((c) => !['text', 'subject', 'object', 'value'].includes(c.k ?? '')),
                ctx
            );
            const own = this.loc(key);
            return { text: own ?? [humanize(key)], icon: 'note', children: kids, collapsed: true, tip, ...(key && (own || k === 'custom_tooltip') ? { locKey: key } : {}) };
        }

        if ((k === 'random_list' || k === 'duel') && block)
            return this.randomList(k, block, ctx, tip);

        if (k === 'random' && block)
        {
            const chance = field('chance');
            const c = chance ? this.valueText(chance, ctx) : '?';
            const kids = this.effects(
                block.filter((x) => x.k !== 'chance' && x.k !== 'modifier'),
                this.withWhen(ctx, `${c}% chance`)
            );
            return { text: [`${c}% chance:`], icon: 'chance', children: kids, tip };
        }

        if (k === 'switch' && block)
        {
            const on = field('trigger') ?? '?';
            const cases = block
                .filter((c) => c.k && c.k !== 'trigger' && Array.isArray(c.v))
                .map((c) =>
                {
                    const label = c.k === 'fallback' ? 'Otherwise' : on === 'yes' ? `If ${this.scopeLabel(c.k!)}` : `If ${humanize(on)} is ${humanize(c.k!)}`;
                    const l: Line = { text: [label + ':'], icon: 'if', children: this.effects(c.v as PNode[], this.withWhen(ctx, label.toLowerCase())) };

                    if (ctx.file)
                        l.src = this.anchor(c, ctx, 'effect', true);

                    return l;
                });
            return { text: [on === 'yes' ? 'Depending on the situation:' : `Depending on ${humanize(on)}:`], children: cases, tip };
        }

        if (k === 'trigger_event')
            return this.triggerEvent(n, block, v, ctx, tip);

        // iterators
        const it = /^(every|random|ordered)_(\w+)$/.exec(k);

        if (it && block && !this.idx.get('scripted_effects', k))
        {
            const what = this.iterLabel(it[2]);
            const limit = block.find((c) => c.k === 'limit');
            const conds = limit && Array.isArray(limit.v) ? this.triggers(limit.v, ctx) : [];
            const label = it[1] === 'every' ? `each ${what}` : it[1] === 'random' ? `a random ${what}` : `the top ${what}`;
            const kids = this.effects(
                block.filter((c) => !ITERATOR_PARAMS.has(c.k ?? '')),
                { ...ctx, scope: label, scopeType: iteratedScope(it[2]) }
            );

            if (!kids.length)
                return null;

            // (which relation, secret, scheme: `type = friend`; an ordered one's order: `order_by = age`)
            const typeNode = block.find((c) => c.k === 'type' && typeof c.v === 'string');
            const order = block.find((c) => c.k === 'order_by' && typeof c.v === 'string');
            const head = capitalize(it[1] === 'every' ? `For each ${what}` : it[1] === 'random' ? `For one random ${what}` : order ? `For the ${what} with the highest ${humanize(order.v as string)}` : `For the best ${what}`);
            return { text: rich(head, typeNode ? rich(' (', this.ref(typeNode.v as string), ')') : '', conds.length ? ' where:' : ':'), conditions: conds.length ? conds : undefined, children: kids, icon: 'loop', tip };
        }

        // scope switch
        if (block && this.isScopeKey(k) && !this.idx.get('scripted_effects', k))
        {
            const label = this.scopeLabel(k, ctx);
            const kids = this.effects(block, { ...ctx, scope: label, scopeType: linkedScope(k, ctx.scopeType, ctx) });

            if (!kids.length)
                return null;

            return { text: [this.scopeSeg(k, ctx, true), ':'], children: kids, icon: 'scope', tip };
        }

        // scripted effect
        const se = this.idx.get('scripted_effects', k);

        if (se)
            return this.scriptedEffect(se, block, ctx, tip);

        const res = RESOURCES[k];

        if (res && !block)
            return this.resourceLine(res, v, ctx, tip, k.startsWith('remove_'));

        const phrase = this.effectPhrase(k, block, v, ctx, field);

        if (phrase)
            return { tip, hidden: ctx.hidden || phrase.hidden, ...phrase };

        if (QUIET_EFFECT.test(k))
        {
            const name = block ? (field('name') ?? field('flag') ?? '') : v;
            return { text: rich(capitalize(humanize(k)), name ? ' ' : '', name ? this.codeSeg(name, k.includes('flag') ? 'flag' : k.includes('variable') ? 'variable' : undefined) : ''), hidden: true, icon: k.includes('flag') ? 'flag' : 'var', tip };
        }

        const custom = this.effectLocText(k, v || undefined);

        if (custom && !block)
            return { text: custom, tip, hidden: ctx.hidden };

        // generic fallback
        if (!block)
            return { text: v === 'yes' ? [capitalize(humanize(k))] : rich(capitalize(humanize(k)), ': ', this.valueSeg(v, ctx)), tip, hidden: ctx.hidden };

        const inner = this.effects(block, ctx);
        return { text: rich(capitalize(humanize(k)), this.fieldSummary(block, ctx)), children: inner.length ? inner : undefined, collapsed: true, tip, hidden: ctx.hidden };
    }

    private resourceLine(res: [string, 'good' | 'bad', string], v: string, ctx: Ctx, tip: string, removal: boolean): Line
    {
        const n = this.evalValue(v);
        const [label, goodWhenPositive, icon] = res;

        if (n !== undefined)
        {
            const val = removal ? -Math.abs(n) : n;
            const good = (val > 0) === (goodWhenPositive === 'good');
            return { text: [{ text: `${signed(val)} ${label}`, kind: good ? 'good' : 'bad', tip: v !== String(n) ? v : undefined }], tone: good ? 'good' : 'bad', icon, tip, hidden: ctx.hidden };
        }

        const neg = v.startsWith('-') || removal;
        const name = v.replace(/^-/, '');
        return {
            text: rich(neg ? 'Loses ' : 'Gains ', { text: humanize(name), kind: 'value', tip: name }, ' ', label),
            tone: neg === (goodWhenPositive === 'good') ? 'bad' : 'good',
            icon,
            tip,
            hidden: ctx.hidden
        };
    }

    private effectPhrase(k: string, block: PNode[] | null, v: string, ctx: Ctx, field: (k: string) => string | undefined): LinePart | null
    {
        switch (k)
        {
            case 'add_trait':
            case 'add_trait_force_tooltip':
                return { text: rich('Gains the trait ', this.traitSeg(v)), icon: 'trait' };
            case 'remove_trait':
            case 'remove_trait_force_tooltip':
                return { text: rich('Loses the trait ', this.traitSeg(v)), icon: 'trait' };
            case 'add_trait_xp':
            {
                const val = field('value') ?? '?';
                const n = this.evalValue(val);
                return {
                    text: rich(n !== undefined ? signed(n) : humanize(val), ' experience in ', this.traitSeg(field('trait') ?? '?'), field('track') ? ` (${humanize(field('track')!)})` : ''),
                    icon: 'trait'
                };
            }
            // (1.20's name: it also touches spiritual fulfillment)
            case 'stress_impact':
            case 'stress_and_fulfillment_impact':
                return block ? this.stressImpact(block, ctx) : null;
            case 'add_opinion':
            case 'reverse_add_opinion':
            {
                const mod = field('modifier') ?? '?';
                const target = this.scopeSeg(field('target') ?? '?', ctx);
                const opVal = field('opinion');
                const value = opVal ? this.evalValue(opVal) ?? this.opinionValue(mod) : this.opinionValue(mod);
                const self: RichSeg = ctx.scope === 'you' ? 'You' : { text: capitalize(ctx.scope), kind: 'scope' };
                const [who, of] = k === 'add_opinion' ? [self, target] : [target, ctx.scope === 'you' ? 'you' : ctx.scope];
                return {
                    text: rich(who, ' now ', typeof who === 'string' && who === 'You' ? 'feel ' : 'feels ', this.ref(mod, ['opinion_modifiers']), ' towards ', of, value !== undefined ? ` (${signed(value)})` : ''),
                    icon: 'opinion',
                    tone: value !== undefined ? (value >= 0 ? 'good' : 'bad') : undefined
                };
            }
            case 'add_character_modifier':
            case 'add_county_modifier':
            case 'add_province_modifier':
            case 'add_dynasty_modifier':
            case 'add_house_modifier':
            case 'add_realm_modifier':
            case 'add_title_modifier':
            {
                const mod = block ? (field('modifier') ?? '?') : v;
                const dur = block ? this.duration(block) : '';
                const e = this.idx.get('modifiers', mod);
                return {
                    text: rich(k === 'add_character_modifier' ? 'Gains ' : `${capitalize(humanize(k.replace(/^add_|_modifier$/g, '')))} gains `, this.ref(mod, ['modifiers']), dur ? ` for ${dur}` : ''),
                    icon: 'modifier',
                    children: e ? this.modifierStats(e) : undefined
                };
            }
            case 'remove_character_modifier':
            case 'remove_county_modifier':
            case 'remove_province_modifier':
                return { text: rich('Loses ', this.ref(v, ['modifiers'])), icon: 'modifier' };
            case 'death':
                return { text: rich('Dies', block && field('death_reason') ? rich(' (', this.ref(field('death_reason')!, ['deathreasons']), ')') : ''), icon: 'death', tone: 'bad' };
            case 'give_nickname':
                return { text: rich('Becomes known as ', this.ref(v, ['nicknames'])), icon: 'trait' };
            case 'add_hook':
            case 'add_hook_no_toast':
                return { text: rich('Gains a ', this.ref(field('type') ?? '?', ['hook_types']), ' on ', this.scopeSeg(field('target') ?? '?', ctx)), icon: 'opinion', tone: 'good' };
            case 'remove_hook':
                return { text: rich('Loses the hook on ', this.scopeSeg(field('target') ?? v, ctx)), icon: 'opinion' };
            case 'add_secret':
                return { text: rich('Gains the secret ', this.ref(field('type') ?? '?', ['secret_types']), field('target') ? rich(' about ', this.scopeSeg(field('target')!, ctx)) : ''), icon: 'note' };
            case 'reveal_to':
                return { text: rich('The secret is revealed to ', this.scopeSeg(v, ctx)), icon: 'note' };
            case 'start_scheme':
                return { text: rich('Starts a ', this.ref(field('type') ?? '?', ['schemes/scheme_types']), ' scheme against ', this.scopeSeg(field('target_character') ?? field('target') ?? '?', ctx)) };
            case 'create_character':
                return { text: rich('A new character appears', field('template') ? rich(' (', this.ref(field('template')!, ['scripted_character_templates']), ')') : '') };
            case 'add_courtier':
                return { text: rich(this.scopeSeg(v, ctx), ' joins the court') };
            case 'imprison':
                return { text: rich('Imprisons ', this.scopeSeg(field('target') ?? v, ctx)), tone: 'bad' };
            case 'add_realm_law':
            case 'add_realm_law_skip_effects':
                return { text: rich('Adopts the law ', this.ref(v, ['laws'])) };
            case 'pay_short_term_gold':
            case 'pay_long_term_gold':
            {
                const g = field('gold') ?? '?';
                const n = this.evalValue(g);
                return { text: rich('Pays ', { text: n !== undefined ? formatNumber(n) : humanize(g), kind: 'bad', tip: g }, ' Gold to ', this.scopeSeg(field('target') ?? '?', ctx)), icon: 'gold', tone: 'bad' };
            }
            case 'send_interface_toast':
            case 'send_interface_message':
            {
                const title = field('title');
                const kids = block
                    ? this.effects(
                        block.filter((c) => !['type', 'title', 'desc', 'left_icon', 'right_icon', 'goto'].includes(c.k ?? '')),
                        ctx
                    )
                    : [];

                if (!title)
                    return kids.length ? { text: ['Notification:'], children: kids, icon: 'note' } : null;

                return { text: rich('Notification “', this.loc(title) ?? humanize(title), '”'), children: kids, icon: 'note' };
            }
            case 'add_to_guest_subset':
                return null;
        }

        const setRel = /^(set|remove)_relation_(\w+)$/.exec(k);

        if (setRel)
        {
            const target = block ? (field('target') ?? '?') : v;
            return {
                text: rich(setRel[1] === 'set' ? 'Becomes ' : 'Is no longer ', this.relationSeg(setRel[2]), ' of ', this.scopeSeg(target, ctx)),
                icon: 'opinion'
            };
        }

        return null;
    }

    private opinionValue(mod: string): number | undefined
    {
        const e = this.idx.get('opinion_modifiers', mod);

        if (!e)
            return undefined;

        const d = this.idx.defNode(e);
        const op = d && Array.isArray(d.node.v) ? d.node.v.find((c) => c.k === 'opinion') : undefined;
        return typeof op?.v === 'string' ? this.evalValue(op.v) : undefined;
    }

    duration(block: PNode[]): string
    {
        for (const unit of ['years', 'months', 'weeks', 'days'])
        {
            const c = block.find((x) => x.k === unit);

            if (!c)
                continue;

            if (typeof c.v === 'string')
            {
                const n = this.evalValue(c.v);
                return `${n !== undefined ? formatNumber(n) : humanize(c.v)} ${n === 1 ? unit.slice(0, -1) : unit}`;
            }

            const nums = c.v.filter((x) => x.k === null && typeof x.v === 'string').map((x) => x.v as string);

            if (nums.length === 2)
                return `${nums[0]}–${nums[1]} ${unit}`;
        }

        return '';
    }

    private stressImpact(block: PNode[], ctx: Ctx): LinePart
    {
        const parts: Rich = [];
        let tone: 'good' | 'bad' | undefined;

        for (const c of block)
        {
            if (!c.k || typeof c.v !== 'string')
                continue;

            const n = this.evalValue(c.v);
            const val: RichSeg = n !== undefined ? { text: signed(n), kind: n > 0 ? 'bad' : 'good', tip: c.v } : { text: humanize(c.v), kind: 'value', tip: c.v };

            if (parts.length)
                parts.push(', ');

            if (c.k === 'base')
                parts.push(val, ' base');
            else
                parts.push(val, ' if ', this.traitSeg(c.k));

            if (n !== undefined)
                tone = n > 0 ? 'bad' : 'good';
        }

        return { text: rich('Stress: ', parts), icon: 'stress', tone, hidden: ctx.hidden };
    }

    private randomList(k: string, block: PNode[], ctx: Ctx, tip: string): Line
    {
        const entries = block.filter((c) => c.k !== null && Array.isArray(c.v) && (NUMERIC.test(c.k) || this.evalValue(c.k) !== undefined || this.idx.get('script_values', c.k)));
        const weights = entries.map((c) => this.evalValue(c.k!) ?? 0);
        const total = weights.reduce((a, b) => a + b, 0);
        const children: Line[] = entries.map((c, i) =>
        {
            const body = c.v as PNode[];
            const variable = body.some((x) => x.k === 'modifier' || x.k === 'opinion_modifier' || x.k === 'compare_modifier');
            const pct = total > 0 ? Math.round((weights[i] / total) * 100) : 0;
            const chance = `${variable ? '~' : ''}${pct}%`;
            const descNode = body.find((x) => x.k === 'desc');
            const desc = typeof descNode?.v === 'string' ? this.loc(descNode.v) : undefined;
            const trig = body.find((x) => x.k === 'trigger');
            const conds = trig && Array.isArray(trig.v) ? this.triggers(trig.v, ctx) : [];
            const kids = this.effects(
                body.filter((x) => !['modifier', 'opinion_modifier', 'compare_modifier', 'trigger', 'desc', 'show_chance', 'min', 'max', 'ai_value_modifier'].includes(x.k ?? '')),
                this.withWhen(ctx, desc ? rich(chance + ' — ', desc) : `${chance} chance`)
            );
            const l: Line = { text: rich({ text: chance, kind: 'value', tip: `weight ${c.k}` }, desc ? rich(' — ', desc) : ''), icon: 'chance', conditions: conds.length ? conds : undefined, children: kids };

            if (ctx.file)
                l.src = this.anchor(c, ctx, 'effect', true);

            return l;
        });
        const head = k === 'duel'
            ? rich('Duel (', this.ref(block.find((c) => c.k === 'skill')?.v as string ?? 'prowess'), ')', block.find((c) => c.k === 'target') ? rich(' against ', this.scopeSeg(block.find((c) => c.k === 'target')!.v as string, ctx)) : '', ':')
            : ['One of these outcomes:'];
        return { text: head, icon: 'chance', children, tip };
    }

    private triggerEvent(n: PNode, block: PNode[] | null, v: string, ctx: Ctx, tip: string): Line | null
    {
        let id = v;
        let onAction: string | undefined;
        let delay = '';

        if (block)
        {
            const f = (k: string): PNode | undefined => block.find((c) => c.k === k);
            id = typeof f('id')?.v === 'string' ? (f('id')!.v as string) : '';
            onAction = typeof f('on_action')?.v === 'string' ? (f('on_action')!.v as string) : undefined;
            const d = this.duration(block);

            if (d)
                delay = 'in ' + d;
        }

        const target: EntityKey | undefined = onAction ? { type: 'on_action', name: onAction } : id ? { type: 'events', name: id } : undefined;

        if (!target)
            return null;

        const e = this.idx.get(target.type, target.name);
        const label = e ? (this.idx.displayName(e) ?? (onAction ? capitalize(humanize(onAction)) : id)) : target.name;
        const followUp: FollowUp = {
            target,
            label: label ?? target.name,
            delay: delay || undefined,
            when: ctx.when,
            who: ctx.scope === 'you' ? undefined : capitalize(ctx.scope),
            hidden: ctx.hidden
        };
        ctx.followUps.push(followUp);
        return {
            followUp,
            text: rich(
                onAction ? 'Something may happen: ' : 'Leads to ',
                e ? this.entitySeg(e) : { text: target.name, kind: 'code' },
                ctx.scope !== 'you' ? ` (for ${ctx.scope})` : '',
                delay ? ` ${delay}` : ''
            ),
            icon: 'event',
            tip,
            hidden: ctx.hidden
        };
    }

    private scriptedEffect(e: Entity, block: PNode[] | null, ctx: Ctx, tip: string): Line | Line[] | null
    {
        const custom = this.effectLocText(e.name);
        const label = capitalize(humanize(e.name));
        const expandable = ctx.expand > 0 && !ctx.stack.includes(e.name);
        let inner: Line[] = [];

        if (expandable)
        {
            const args = block ? argsOf(block) : undefined;
            const d = this.idx.defNode(e, args);

            // (another definition's text, $PARAM$ substituted: its lines are anchored to that definition — inlinedCtx)
            if (d && Array.isArray(d.node.v))
                inner = this.effects(d.node.v, this.inlinedCtx(e, d.src, args, ctx));
        }

        const allHidden = inner.length > 0 && inner.every((l) => l.hidden);

        // The game shows the contents of scripted effects inline; do the same unless the effect has its own
        // tooltip text or is too big to read inline.
        if (!custom && inner.length > 0 && countLines(inner) <= INLINE_LIMIT)
            return inner.map((l) => (ctx.hidden ? { ...l, hidden: true } : l));

        return {
            text: custom ?? [{ text: label, kind: 'entity', ref: { type: e.type, name: e.name }, tip: e.name }],
            children: inner.length ? inner : undefined,
            collapsed: true,
            tip,
            hidden: ctx.hidden || allHidden
        };
    }

    // -------------------------------------------------------------------------
    // Modifiers (stat blocks)
    // -------------------------------------------------------------------------

    private format(key: string): Record<string, string> | null
    {
        let f = this.formatCache.get(key);

        if (f !== undefined)
            return f;

        f = null;
        const e = this.idx.get('modifier_definition_formats', key);

        if (e)
        {
            const d = this.idx.defNode(e);

            if (d && Array.isArray(d.node.v))
            {
                f = {};

                for (const c of d.node.v)
                    if (c.k && typeof c.v === 'string')
                        f[c.k] = c.v;
            }
        }

        this.formatCache.set(key, f);
        return f;
    }

    /** Is this key a modifier stat (diplomacy, monthly_prestige_gain_mult, …)? */
    isModifierKey(key: string): boolean
    {
        return this.format(key) !== null || this.idx.locRaw('MOD_' + key.toUpperCase()) !== undefined;
    }

    /**
     * How a stat modifier reads (modifier_definition_formats, MOD_<KEY>): its name, percent or not, decimals, whether a
     * positive value is good; hidden ones are not shown in game.
     */
    modifierFormat(key: string): { label: string; percent: boolean; alreadyPercent: boolean; decimals: number; color: 'good' | 'bad' | 'neutral'; hidden: boolean; }
    {
        const fmt = this.format(key) ?? {};
        const label = this.plainText(this.idx.plainLoc('MOD_' + key.toUpperCase()) ?? this.idx.plainLoc(key) ?? capitalize(humanize(key))).trim();
        const percent = fmt.percent === 'yes' || (!fmt.percent && /_mult$/.test(key));
        const color = fmt.color === 'bad' || fmt.color === 'neutral' ? fmt.color : 'good';
        return {
            label: capitalize(label),
            percent,
            alreadyPercent: fmt.already_percent === 'yes',
            decimals: fmt.decimals !== undefined ? parseInt(fmt.decimals) : percent ? 0 : 2,
            color,
            hidden: fmt.hidden === 'yes'
        };
    }

    statLine(key: string, raw: string): Line | null
    {
        const fmt = this.modifierFormat(key);

        if (fmt.hidden)
            return null;

        const num = this.evalValue(raw);
        const label = fmt.label;

        if (num === undefined)
            return { text: rich(label, ': ', { text: humanize(raw), kind: 'value', tip: raw }), tip: `${key} = ${raw}` };

        const percent = fmt.percent;
        const shown = percent ? num * 100 : num;
        const decimals = fmt.decimals;
        const valueText = signed(Number(shown.toFixed(decimals)), decimals) + (percent || fmt.alreadyPercent ? '%' : '');
        const color = fmt.color;
        const good = color === 'neutral' ? undefined : (num > 0) === (color !== 'bad');
        return {
            text: rich({ text: valueText, kind: good === undefined ? 'value' : good ? 'good' : 'bad' }, ' ', label.trim()),
            tone: good === undefined ? undefined : good ? 'good' : 'bad',
            tip: `${key} = ${raw}`
        };
    }

    /**
     * Stat lines of a block: direct stat keys, plus nested *_modifier blocks as groups. `ctx`: the nodes are a
     * definition's own text — the lines get anchors.
     */
    statsOf(nodes: PNode[], ctx?: Ctx): Line[]
    {
        const out: Line[] = [];

        for (const c of nodes)
        {
            if (!c.k)
                continue;

            if (typeof c.v === 'string')
            {
                if ((NUMERIC.test(c.v) || this.idx.get('script_values', c.v)) && this.isModifierKey(c.k))
                {
                    const l = this.statLine(c.k, c.v);

                    if (l && ctx?.file)
                        l.src = this.anchor(c, ctx, 'modifier', false);

                    if (l)
                        out.push(l);
                }
            }
            else if (/_modifier$/.test(c.k) && c.k !== 'ai_value_modifier')
            {
                const inner = this.statsOf(c.v, ctx);

                if (!inner.length)
                    continue;

                const param = c.v.find((x) => x.k === 'parameter');
                const who = capitalize(humanize(c.k.replace(/_modifier$/, '')));
                const label = typeof param?.v === 'string' ? rich('If ', who.toLowerCase(), ' has “', humanize(param.v), '”:') : [who + ':'];
                const l: Line = { text: label, children: inner, icon: 'modifier', tip: c.k };

                if (ctx?.file)
                    l.src = this.anchor(c, ctx, 'modifier', true);

                // (what its modifiers apply to — the picker offers those: county_modifier → a county's)
                const applies = modifierScopeOf(c.k);

                if (l.src && applies)
                    l.src = { ...l.src, innerScope: applies };

                out.push(l);
            }
        }

        return out;
    }

    modifierStats(e: Entity): Line[]
    {
        const d = this.idx.defNode(e);
        return d && Array.isArray(d.node.v) ? this.statsOf(d.node.v) : [];
    }

    /** Loc text as a single readable string (placeholders humanized). */
    plainText(t: string): string
    {
        return richToString(locToRich(t, this.lookupDisplay)).replace(/\s+/g, ' ');
    }

    richString(r: Rich): string
    {
        return richToString(r);
    }
}

/**
 * A definition's text with `$PARAM$`s filled in (as GameIndex.defNode fills them) and the map of its offsets back to
 * the text as written: offsets before, between and after the filled-in parameters shift; the start and end of one map
 * to the start and end of its `$PARAM$` (inside one — no statement starts there — to its start).
 */
function filledMap(own: string, args: Record<string, string>): { text: string; map: (o: number) => number; }
{
    const reps: { os: number; oe: number; ns: number; ne: number; }[] = [];
    let delta = 0;
    const text = own.replace(/\$(\w+)\$/g, (m: string, k: string, at: number) =>
    {
        const v = args[k];

        if (v === undefined)
            return m;

        reps.push({ os: at, oe: at + m.length, ns: at + delta, ne: at + delta + v.length });
        delta += v.length - m.length;
        return v;
    });
    const map = (o: number): number =>
    {
        let shift = 0;

        for (const r of reps)
        {
            if (o < r.ns)
                break;

            if (o <= r.ne)
                return o === r.ne && r.ne > r.ns ? r.oe : r.os;

            shift = r.oe - r.ne;
        }

        return o + shift;
    };
    return { text, map };
}

function argsOf(block: PNode[]): Record<string, string>
{
    const args: Record<string, string> = {};

    for (const c of block)
        if (c.k && typeof c.v === 'string')
            args[c.k] = c.v;

    return args;
}

/** A comparison and its opposite (an iterator's count inside NOT). */
function negateOp(op: string): string
{
    return ({ '>': '<=', '>=': '<', '<': '>=', '<=': '>', '=': '!=', '==': '!=', '!=': '=' } as Record<string, string>)[op] ?? op;
}

const COUNT_WORDS: Record<string, string> = { '>': 'More than', '>=': 'At least', '<': 'Fewer than', '<=': 'At most', '=': 'Exactly', '==': 'Exactly', '!=': 'Not exactly' };

/**
 * The head of an `any_` iterator's line for its `count` with any operator (`count > 0`: any, `count = 0` / `count < 1`:
 * none, `count >= 3`, `count = all` …); `neg`: inside NOT (the opposite comparison). `many`: the noun is plural.
 */
function countHead(op0: string, v: string, what: string, neg: boolean): { head: string; many: boolean; }
{
    const op = neg ? negateOp(op0) : op0;

    if (v === 'all')
        return { head: op === '!=' ? `Not every ${what}` : `Every ${what}`, many: false };

    const n = Number(v);

    if (!Number.isFinite(n))
        return { head: `${COUNT_WORDS[op] ?? op} ${v} ${plural(what)}`, many: true };

    // (at least one / none, however it is written)
    const least = op === '>' ? n + 1 : op === '>=' ? n : op === '!=' && n === 0 ? 1 : undefined;
    const most = op === '<' ? n - 1 : op === '<=' ? n : undefined;

    if (least !== undefined && least <= 0)
        return { head: `Any number of ${plural(what)} (also none)`, many: true };

    if (least === 1)
        return { head: `Any ${what}`, many: false };

    if ((most !== undefined && most <= 0) || ((op === '=' || op === '==') && n === 0))
        return { head: most !== undefined && most < 0 ? `Never (fewer than ${v} ${plural(what)})` : `No ${what}`, many: false };

    if ((op === '=' || op === '==') && n === 1)
        return { head: `Exactly one ${what}`, many: false };

    return { head: `${COUNT_WORDS[op] ?? op} ${v} ${plural(what)}`, many: true };
}

function negateCompare(op: string): string
{
    switch (op)
    {
        case '>=':
            return 'is less than';
        case '>':
            return 'is at most';
        case '<=':
            return 'is more than';
        case '<':
            return 'is at least';
        case '!=':
            return 'is';
        default:
            return 'is not';
    }
}

function lowerFirst(r: Rich): Rich
{
    if (!r.length)
        return r;

    const [first, ...rest] = r;

    if (typeof first === 'string')
        return [first.charAt(0).toLowerCase() + first.slice(1), ...rest];

    if (first.kind === 'scope' || first.kind === 'entity')
        return r;

    return [{ ...first, text: first.text.charAt(0).toLowerCase() + first.text.slice(1) }, ...rest];
}

/** Plural of the last word of an iterator label: child → children, county → counties, vassal → vassals. */
function plural(label: string): string
{
    return label.replace(/(\w+)$/, (w) =>
    {
        const irregular: Record<string, string> = { child: 'children', person: 'people', man: 'men', woman: 'women', ally: 'allies' };

        if (irregular[w])
            return irregular[w];

        if (/[^aeiou]y$/.test(w))
            return w.slice(0, -1) + 'ies';

        if (/(s|x|z|ch|sh)$/.test(w))
            return w + 'es';

        return w + 's';
    });
}

/**
 * trigger_if / trigger_else pairs inside a condition: `trigger_else = { always = yes }` is what a trigger_if does
 * anyway (dropped); `trigger_else = { always = no }` turns the pair into "limit and body".
 */
function simplifyTriggerIf(lines: Line[]): Line[]
{
    const out: Line[] = [];

    for (let i = 0; i < lines.length; i++)
    {
        const l = lines[i];
        const next = lines[i + 1];
        const only = next?.icon === 'else' && next.children?.length === 1 && !next.children[0].children?.length ? next.children[0].text : null;
        const word = only?.length === 1 ? only[0] : undefined;

        if (l.icon === 'if' && l.ifConds && !String(l.text[0]).startsWith('Otherwise') && (word === 'Always' || word === 'Never'))
        {
            if (word === 'Always')
                out.push(l);
            else
                out.push(...l.ifConds, ...(l.children ?? []));

            i++;
            continue;
        }

        out.push(l);
    }

    return out;
}

/** Drops a trailing ":" (group labels) so a line can sit inside a sentence. */
function stripColon(r: Rich): Rich
{
    const last = r[r.length - 1];

    if (typeof last !== 'string' || !last.endsWith(':'))
        return r;

    const t = last.slice(0, -1);
    return t ? [...r.slice(0, -1), t] : r.slice(0, -1);
}

/** "a", "a and b", "a, b and c" */
function joinList(parts: Rich[], last: string): Rich
{
    const out: Rich = [];
    parts.forEach((p, i) =>
    {
        if (i > 0)
            out.push(i === parts.length - 1 ? last : last === '; ' ? '; ' : ', ');

        out.push(...p);
    });
    return rich(out);
}

function countLeaves(lines: Line[]): number
{
    return lines.reduce((n, l) => n + (l.children?.length ? countLeaves(l.children) : 1), 0);
}

/** Present tense for "you": Is → are, Has → have, Holds → hold, Reaches → reach. */
function youVerb(word: string): string
{
    const w = word.toLowerCase();
    const irregular: Record<string, string> = { is: 'are', has: 'have', was: 'were', does: 'do' };

    if (irregular[w])
        return irregular[w];

    if (/(ch|sh|ss|x|z)es$/.test(w))
        return w.slice(0, -2);

    if (/ies$/.test(w))
        return w.slice(0, -3) + 'y';

    return w.endsWith('s') ? w.slice(0, -1) : w;
}

const MODAL_VERBS = new Set(['Is', 'Has', 'Was', 'Does', 'Can', 'Could', 'Will', 'Would', 'Had', 'Did', 'Must', 'Should']);
/** Sentence starts that already carry their own subject or are not about the scope. */
const OWN_SUBJECT = new Set(['You', 'Your', 'They', 'Their', 'It', 'The', 'A', 'An', 'This', 'That', 'Any', 'Every', 'No', 'None', 'Not', 'At', 'Fewer', 'Always', 'Never', 'Variable', 'Game', 'Otherwise']);

/**
 * Puts a subject in front of a condition line: "Has the trait X" → "you have the trait X" / "Lover has the trait X";
 * noun phrases become possessive: "Opinion of Y is more than 20" → "your opinion of Y …" / "Lover’s opinion …".
 * Lines that start with their own subject ("First Lover exists") stay as they are.
 */
function withSubject(text: Rich, subject: RichSeg | null | 'plural'): Rich
{
    const [first, ...rest] = text;

    if (typeof first !== 'string')
        return text;

    const m = /^([A-Z][a-z]+)\b([\s\S]*)$/.exec(first);

    if (!m)
        return lowerFirst(text);

    const [, word, tail] = m;

    if (OWN_SUBJECT.has(word))
        return word === 'You' || word === 'Your' ? text : lowerFirst(text);

    const verb = MODAL_VERBS.has(word) || (/[^s]s$/.test(word) && !/(ous|is|us)$/.test(word));

    if (verb)
    {
        if (subject === null)
            return [word.toLowerCase() + tail, ...rest];

        if (subject === 'plural')
            return [youVerb(word) + tail, ...rest];

        if (subject === 'you')
            return rich('you ', youVerb(word) + tail, rest);

        return rich(subject, ' ', word.toLowerCase() + tail, rest);
    }

    // noun phrase ("Opinion of …", "Faith is …", "Stress is at least …")
    if (subject === null)
        return lowerFirst(text);

    if (subject === 'plural')
        return rich('their ', word.toLowerCase() + tail, rest);

    if (subject === 'you')
        return rich('your ', word.toLowerCase() + tail, rest);

    return rich(subject, '’s ', word.toLowerCase() + tail, rest);
}

/** Keys that look like iterators but are none (a weighted choice, text / on_action lists). */
const NOT_ITERATORS = new Set(['random_list', 'random_valid', 'random_events', 'random_on_actions', 'random_on_action']);

const ITERATOR_PARAMS = new Set([
    'limit',
    'order_by',
    'max',
    'min',
    'position',
    'check_range_bounds',
    'weight',
    'alternative_limit',
    'type',
    'even_if_dead',
    'only_if_dead',
    'include_self',
    'filter',
    'relation',
    'province'
]);

const GROUP_ICONS = new Set(['if', 'else', 'scope', 'loop']);

/** Drops empty groups and marks groups hidden when everything inside them is hidden. */
function finalize(l: Line): Line | null
{
    // (an empty if / else a mod writes stays: it is being written)
    if (l.children && l.children.length === 0 && GROUP_ICONS.has(l.icon ?? '') && !((l.icon === 'if' || l.icon === 'else') && l.src?.mod))
        return null;

    if (l.children?.length && l.children.every((c) => c.hidden))
        return { ...l, hidden: true };

    return l;
}

/** Scripted effects with up to this many lines are shown inline instead of as a collapsed group. */
const INLINE_LIMIT = 12;

function countLines(lines: Line[]): number
{
    let n = 0;

    for (const l of lines)
        n += 1 + (l.children ? countLines(l.children) : 0);

    return n;
}

/** Trigger blocks holding conditions (besides iterators and scope switches): statements are added inside them. */
const TRIGGER_BLOCKS = new Set(['AND', 'OR', 'NOT', 'NOR', 'NAND', 'trigger_if', 'trigger_else_if', 'trigger_else', 'calc_true_if', 'custom_description', 'custom_description_no_bullet', 'custom_tooltip']);
/** Effect blocks holding effects (besides iterators and scope switches). */
const EFFECT_BLOCKS = new Set(['if', 'else_if', 'else', 'hidden_effect', 'show_as_tooltip', 'custom_tooltip', 'custom_description', 'custom_description_no_bullet', 'random', 'send_interface_message', 'send_interface_toast']);

/** Scope links whose target is not a character (a hint for the statement picker). */
const LINK_SCOPES: Record<string, string> = {
    faith: 'faith',
    religion: 'religion',
    culture: 'culture',
    house: 'dynasty_house',
    dynasty: 'dynasty',
    primary_title: 'landed_title',
    capital_county: 'landed_title',
    capital_barony: 'landed_title',
    county: 'landed_title',
    duchy: 'landed_title',
    kingdom: 'landed_title',
    empire: 'landed_title',
    de_jure_liege: 'landed_title',
    capital_province: 'province',
    location: 'province',
    title_province: 'province',
    war: 'war',
    army: 'army',
    domicile: 'domicile',
    involved_activity: 'activity',
    current_travel_plan: 'travel_plan'
};

/** "you" → "your", "the child" → "the child’s", "Wales" → "Wales’" */
function possessive(who: string): string
{
    if (/^you$/i.test(who))
        return who[0] === 'Y' ? 'Your' : 'your';

    if (/^the[ym]$/i.test(who))
        return who[0] === 'T' ? 'Their' : 'their';

    return who.endsWith('s') ? who + '’' : who + '’s';
}

/** Database prefixes that lead to a scope (`title:k_france = { … }`). */
const PREFIX_SCOPES: Record<string, string> = { character: 'character', title: 'landed_title', faith: 'faith', culture: 'culture', dynasty: 'dynasty', house: 'dynasty_house', province: 'province', religion: 'religion' };

/**
 * Scope type of a scope switch, link by link: `liege = { }` → character, `primary_title.holder` → character, `root` → the
 * script's root (`ctx.rootType`), `scope:x` → what the script saved there (`ctx.savedTypes`), else what its name says
 * (`target_title` → a title; `actor` → a character), `title:x` → a title; undefined when not known (`prev`, variables,
 * links the describer does not know).
 */
function linkedScope(k: string, current?: string, ctx?: Ctx): string | undefined
{
    let at = current;
    const parts = k.split('.');

    for (let i = 0; i < parts.length; i++)
    {
        const part = parts[i];
        const prefix = /^(\w+):(.+)$/.exec(part);

        if (part === 'this')
            continue;

        if (part === 'prev' || part === 'from' || (prefix && i > 0))
            return undefined;

        if (part === 'root')
            at = ctx?.rootType ?? 'character';
        else if (prefix?.[1] === 'scope')
        {
            const byName = scopeTypeByName(prefix[2]);
            at = ctx?.savedTypes?.[prefix[2]] ?? (byName === null ? undefined : (byName ?? 'character'));
        }
        else if (prefix)
            at = PREFIX_SCOPES[prefix[1]];
        else
            at = LINK_SCOPES[part] ?? (SCOPE_LINKS.has(part) ? 'character' : undefined);

        if (!at)
            return undefined;
    }

    return at;
}

/** Scope type of an iterator's items (`every_vassal` → character, `any_held_title` → landed_title): the picker's catalog, else by name. */
function iteratedScope(what: string): string
{
    const known = ITERATORS.find((i) => i.list === what);

    if (known)
        return known.to;

    if (/title|county|duchy|kingdom|empire|barony/.test(what))
        return 'landed_title';

    if (/province/.test(what))
        return 'province';

    if (/faith/.test(what))
        return 'faith';

    if (/culture/.test(what))
        return 'culture';

    if (/war\b|wars$/.test(what))
        return 'war';

    if (/scheme/.test(what))
        return 'scheme';

    if (/secret/.test(what))
        return 'secret';

    if (/artifact/.test(what))
        return 'artifact';

    if (/army|armies|regiment/.test(what))
        return 'army';

    if (/activit/.test(what))
        return 'activity';

    return 'character';
}

/** Keys inside triggers that only store scopes; nothing for a reader. */
const TRIGGER_SKIP = new Set(['save_temporary_scope_as', 'save_temporary_scope_value_as', 'save_scope_as', 'save_scope_value_as', 'debug_log']);
