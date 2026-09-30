/**
 * Weight blocks read as lines: `ai_will_do`, `ai_weight`, `weight`, `ai_chance` … and scripted modifiers
 * (common/scripted_modifiers/_scripted_modifiers.info, events/_events.info `ai_chance`): `base`, `factor`, `add`,
 * `modifier = { add|factor = … <triggers> desc = … }`, `opinion_modifier`, `ai_value_modifier`, `compare_modifier`,
 * `compatibility_modifier`, `first_valid`, scripted modifiers used by name — and the script value operations weight
 * blocks mix in (jomini/common/script_values/_script_values.info: value, add … min / max, rounding, if / else_if /
 * else, ranges, lists, scope switches). Shared by every card group; the scripted group (cards/scripted.ts) owns it.
 */
import type { PNode } from '../../indexer/parser.ts';
import type { Line, Rich, RichSeg } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import { capitalize, formatNumber, humanize, rich, richToString, signed } from '../text.ts';

/** The lines of a weight block's statements (its body); written numbers are edited with the field set `weight`. */
export function weightLines(b: StoryBuilder, list: PNode[], ctx: Ctx): Line[]
{
    return new WeightReader(b, 'weight').lines(list, ctx);
}

/** The lines of a script value's statements (a cost, an agent's contribution …), edited with the field set `script_value`. */
export function valueLines(b: StoryBuilder, list: PNode[], ctx: Ctx): Line[]
{
    return new WeightReader(b, 'script_value').lines(list, ctx);
}

/** Operations on the value so far: what they read as with a number, and as a heading with a calculated amount. */
const OPS: Record<string, { sign?: '+' | '−' | '×' | '÷'; label: string; }> = {
    base: { label: 'Starts at' },
    value: { label: 'Starts at' },
    add: { sign: '+', label: 'Add' },
    subtract: { sign: '−', label: 'Subtract' },
    factor: { sign: '×', label: 'Multiply by' },
    multiply: { sign: '×', label: 'Multiply by' },
    divide: { sign: '÷', label: 'Divide by' },
    modulo: { label: 'Remainder after dividing by' },
    min: { label: 'At least' },
    max: { label: 'At most' }
};

/** `round = yes` & co. (_script_values.info) */
const ROUNDING: Record<string, string> = { round: 'Rounded', ceiling: 'Rounded up', floor: 'Rounded down' };

/** Iterator parameters that are no operations (describer.ts ITERATOR_PARAMS without min / max, which are ops here). */
const ITERATOR_PARAMS = new Set(['limit', 'type', 'order_by', 'position', 'check_range_bounds', 'alternative_limit', 'even_if_dead', 'only_if_dead', 'include_self', 'filter', 'relation', 'province']);

/** Condition lines read inline as one clause up to this many leaves and characters; longer ones become a list. */
const CLAUSE_LEAVES = 3;
const CLAUSE_CHARS = 110;

class WeightReader
{
    private b: StoryBuilder;
    /** the field set of the written numbers (LineSource.fields) */
    private fields: string;

    constructor(b: StoryBuilder, fields: string)
    {
        this.b = b;
        this.fields = fields;
    }

    lines(list: PNode[], ctx: Ctx): Line[]
    {
        const out: Line[] = [];

        for (const c of list)
        {
            if (!c.k || c.k === 'desc' || c.k === 'format' || /^(save_|debug_)/.test(c.k))
                continue;

            // (a calculated start — `value = { … }` first — reads as its own lines)
            if (!out.length && (c.k === 'value' || c.k === 'base') && Array.isArray(c.v) && !c.v.some((x) => x.k === 'desc'))
            {
                out.push(...this.lines(c.v, ctx));
                continue;
            }

            const l = this.line(c, ctx);

            if (l)
                out.push(l);
        }

        return out;
    }

    private line(c: PNode, ctx: Ctx): Line | null
    {
        const k = c.k!;
        const block = Array.isArray(c.v) ? c.v : null;

        if (!block)
        {
            const v = c.v as string;

            if (OPS[k])
                return { text: this.amount(k, v, ctx), tip: `${k} = ${v}`, src: ctx.file && this.b.fieldAnchor(c, ctx, this.fields) };

            if (this.b.idx.get('scripted_modifiers', k) || k.includes('$'))
                return this.scripted(c, ctx);

            if (ROUNDING[k] && v !== 'yes')
                return null;

            return { text: ROUNDING[k] ? [ROUNDING[k]] : rich(capitalize(humanize(k)), ': ', this.seg(v, ctx)), tip: `${k} = ${v}`, src: ctx.file && this.b.d.anchor(c, ctx, 'other', false) };
        }

        let l: Line;

        switch (k)
        {
            case 'modifier':
                return this.modifier(c, block, ctx);
            case 'opinion_modifier':
            case 'compatibility_modifier':
                l = this.opinion(k, block, ctx);
                break;
            case 'ai_value_modifier':
                l = this.personality(block, ctx);
                break;
            case 'compare_modifier':
                l = this.compare(block, ctx);
                break;
            case 'first_valid':
                l = { text: ['The first of these that applies:'], children: this.lines(block, ctx), icon: 'if' };
                break;
            case 'if':
            case 'else_if':
            case 'else':
                return this.branch(c, block, ctx);
            case 'fixed_range':
            case 'integer_range':
            {
                const min = block.find((x) => x.k === 'min')?.v;
                const max = block.find((x) => x.k === 'max')?.v;
                l = { text: rich('Random ', k === 'integer_range' ? 'whole number ' : '', 'between ', typeof min === 'string' ? this.seg(min, ctx) : '?', ' and ', typeof max === 'string' ? this.seg(max, ctx) : '?'), icon: 'chance' };
                break;
            }
            case 'switch':
            {
                const on = block.find((x) => x.k === 'trigger')?.v;
                const cases = block
                    .filter((x) => x.k && x.k !== 'trigger' && Array.isArray(x.v))
                    .map((x) => ({ text: [x.k === 'fallback' ? 'Otherwise:' : `If ${humanize(x.k!)}:`], children: this.lines(x.v as PNode[], ctx), icon: 'if', src: ctx.file && this.b.fieldAnchor(x, ctx, this.fields, true) }));
                l = { text: [typeof on === 'string' ? `Depending on ${humanize(on)}:` : 'Depending on the case:'], children: cases };
                break;
            }
            default:
            {
                if (OPS[k])
                    return this.calculated(c, block, ctx);

                if (this.b.idx.get('scripted_modifiers', k) || k.includes('$'))
                    return this.scripted(c, ctx);

                const it = /^(every|random|ordered)_(\w+)$/.exec(k);

                if (it)
                    return this.iterator(c, it[1], it[2], block, ctx);

                // (`x ?= { }`: in x when it exists — also links the describer does not know, like culture_head)
                if (this.b.d.isScopeKey(k) || c.op === '?=')
                {
                    const label = this.b.d.scopeLabel(k, ctx);
                    return { text: [this.b.d.scopeSeg(k, ctx, true), ':'], children: this.lines(block, { ...ctx, scope: label, scopeType: undefined }), icon: 'scope', tip: this.raw(c, ctx), src: ctx.file && this.b.fieldAnchor(c, ctx, this.fields, true) };
                }

                l = { text: [capitalize(humanize(k)) + ':'], children: this.lines(block, ctx) };
            }
        }

        l.tip = this.raw(c, ctx);

        if (ctx.file)
            l.src = this.b.d.anchor(c, ctx, 'other', false);

        return l;
    }

    /** An operation with a written amount: "+10", "×0.5", "Starts at ‹Base value›", "At most 50". */
    private amount(k: string, v: string, ctx: Ctx): Rich
    {
        const op = OPS[k];
        const n = constValue(this.b, v);
        const tip = n !== undefined && v !== String(n) ? v : undefined;

        if (op.sign === '+' || op.sign === '−')
        {
            if (n !== undefined)
                return [{ text: signed(op.sign === '−' ? -n : n), kind: 'value', tip }];

            return rich(op.sign, ' ', this.seg(v, ctx));
        }

        if (op.sign)
            return n !== undefined ? [{ text: op.sign + formatNumber(n), kind: 'value', tip }] : rich(op.sign, ' ', this.seg(v, ctx));

        return rich(op.label, ' ', this.seg(v, ctx));
    }

    /**
     * An operation with a block: `add = { value = 10 desc = KEY }` reads as its value with the reason (the breakdown
     * text), anything longer as a heading over its own lines.
     */
    private calculated(c: PNode, block: PNode[], ctx: Ctx): Line
    {
        const { v, reason, rest } = this.split(block);
        const src = ctx.file && this.b.fieldAnchor(c, ctx, this.fields, v === undefined);

        if (v !== undefined)
            return { text: rich(this.amount(c.k!, v, ctx), reason), tip: this.raw(c, ctx), src };

        return { text: rich(OPS[c.k!].label, reason, ':'), children: this.lines(rest, ctx), tip: this.raw(c, ctx), src };
    }

    /** A block amount: its single `value` (when that is all), its `desc` as a reason, the rest. */
    private split(block: PNode[]): { v?: string; reason: Rich; rest: PNode[]; }
    {
        const desc = block.find((x) => x.k === 'desc');
        const rest = block.filter((x) => x.k && x.k !== 'desc' && x.k !== 'format');
        const only = rest.length === 1 && rest[0].k === 'value' && typeof rest[0].v === 'string' ? rest[0].v : undefined;
        return { v: only, reason: typeof desc?.v === 'string' ? this.reason(desc.v) : [], rest };
    }

    /** The breakdown text of a `desc` (" (Weak hook used)"): its loc without the value placeholder. */
    private reason(key: string): Rich
    {
        const t = this.b.d.templateLoc(key);

        if (!t)
            return [];

        const text = rich(...t.map((s, i) => (i === t.length - 1 && typeof s === 'string' ? s.replace(/[\s:=+-]+$/, '') : s)));
        return richToString(text).trim() ? rich(' (', text, ')') : [];
    }

    /** `modifier = { add|factor = … <conditions> desc = … }`: "+10 (reason) if you are at war". */
    private modifier(c: PNode, block: PNode[], ctx: Ctx): Line
    {
        const parts: Rich[] = [];
        const kids: Line[] = [];
        const conds: PNode[] = [];
        let reason: Rich = [];

        for (const x of block)
        {
            if (!x.k)
                continue;

            if (x.k === 'desc' && typeof x.v === 'string')
                reason = this.reason(x.v);
            else if (x.k === 'trigger' && Array.isArray(x.v))
                conds.push(...x.v);
            else if (OPS[x.k] && x.k !== 'min' && x.k !== 'max')
            {
                if (typeof x.v === 'string')
                    parts.push(this.amount(x.k, x.v, ctx));
                else
                {
                    const s = this.split(x.v);

                    if (s.v !== undefined)
                        parts.push(this.amount(x.k, s.v, ctx));
                    else
                    {
                        parts.push([OPS[x.k].label]);
                        kids.push(...this.lines(s.rest, ctx));
                    }
                }
            }
            else
                conds.push(x);
        }

        const head = rich(...parts.flatMap((p, i) => (i ? [' and ', ...p] : p)), reason);
        const l: Line = { ...conditional(this.b, head, this.b.d.triggers(conds, ctx), kids.length > 0, ' if ', subjectOf(ctx)), tip: this.raw(c, ctx) };

        if (kids.length)
            l.children = kids;

        // (its statements are conditions, besides the amount: "＋" adds a condition)
        if (ctx.file)
            l.src = this.b.d.anchor(c, ctx, 'trigger', true);

        return l;
    }

    /**
     * `opinion_modifier = { who opinion_target multiplier min max step trigger }` — `who`'s opinion of the target (default
     * the scope's own); `compatibility_modifier = { who compatibility_target … }` the same with their compatibility.
     */
    private opinion(k: string, block: PNode[], ctx: Ctx): Line
    {
        const f = fieldsOf(block);
        const target = f.opinion_target ?? f.target ?? f.compatibility_target;
        const what = k === 'compatibility_modifier' ? ' compatibility with ' : ' opinion of ';
        const kids: Line[] = [];
        const head = rich('Adds ', this.whose(f.who, ctx), what, target ? this.b.d.scopeSeg(target, ctx) : 'them', this.times(block, 'multiplier', ctx, kids), this.bounds(f, ctx));
        return { ...conditional(this.b, head, this.conditions(block, ctx), kids.length > 0, ' if ', subjectOf(ctx)), children: kids.length ? kids : undefined, icon: 'opinion' };
    }

    /** `ai_value_modifier = { who ai_boldness = 0.5 … }`: the AI personality values of `who`, each times its factor. */
    private personality(block: PNode[], ctx: Ctx): Line
    {
        const f = fieldsOf(block);
        const kids: Line[] = [];
        const parts = block
            .filter((x) => x.k && /^ai_/i.test(x.k) && !/_modifier$/.test(x.k))
            .map((x) =>
            {
                const name = humanize(x.k!.replace(/^(dread_modified_)?ai_/i, ''));

                if (typeof x.v === 'string')
                    return rich(name, this.times([x], x.k!, ctx, kids, true));

                kids.push({ text: [capitalize(name) + ' factor:'], children: this.lines(x.v, ctx), tip: this.raw(x, ctx) });
                return rich(name, ' (calculated)');
            });
        const head = rich(f.who ? rich(this.whose(f.who, ctx, true), ' personality: ') : 'Personality: ', ...parts.flatMap((p, i) => (i ? [', ', ...p] : p)), this.bounds(f, ctx));
        return { ...conditional(this.b, head, this.conditions(block, ctx), kids.length > 0, ' if ', subjectOf(ctx)), children: kids.length ? kids : undefined, icon: 'trait' };
    }

    /**
     * `compare_modifier = { target value multiplier offset min max step trigger desc }`: adds (value + offset) ×
     * multiplier, the value read in `target` (some write `factor` for the multiplier).
     */
    private compare(block: PNode[], ctx: Ctx): Line
    {
        const f = fieldsOf(block);
        const kids: Line[] = [];
        const valueNode = block.find((x) => x.k === 'value' || x.k === 'skill');
        let value: Rich = ['a value'];

        if (typeof valueNode?.v === 'string')
            value = [this.seg(valueNode.v, ctx)];
        else if (valueNode && Array.isArray(valueNode.v))
        {
            value = ['the value below'];
            kids.push({ text: ['Value:'], children: this.lines(valueNode.v, ctx), tip: this.raw(valueNode, ctx) });
        }

        if (f.target)
            value = rich(this.whose(f.target, ctx), ' ', value.map((s) => (typeof s === 'string' ? s.toLowerCase() : s)));

        const offset = f.offset !== undefined ? constValue(this.b, f.offset) : undefined;

        if (f.offset !== undefined)
            value = rich('(', value, offset !== undefined ? ` ${offset < 0 ? '−' : '+'} ${formatNumber(Math.abs(offset))}` : rich(' + ', this.seg(f.offset, ctx)), ')');

        const desc = typeof f.desc === 'string' ? this.reason(f.desc) : [];
        const head = rich('Adds ', value, this.times(block, block.some((x) => x.k === 'multiplier') ? 'multiplier' : 'factor', ctx, kids), this.bounds(f, ctx), desc);
        return { ...conditional(this.b, head, this.conditions(block, ctx), kids.length > 0, ' if ', subjectOf(ctx)), children: kids.length ? kids : undefined };
    }

    /** " ×0.5" for a multiplier (nothing for 1; `always`: also for 1), a calculated one as a child line. */
    private times(block: PNode[], key: string, ctx: Ctx, kids: Line[], always = false): Rich
    {
        const m = block.find((x) => x.k === key);

        if (!m)
            return always ? [' ×1'] : [];

        if (Array.isArray(m.v))
        {
            const s = this.split(m.v);

            if (s.v === undefined)
            {
                kids.push({ text: ['Multiplied by:'], children: this.lines(s.rest, ctx), tip: this.raw(m, ctx) });
                return [' × the amount below'];
            }

            return this.times([{ ...m, v: s.v }], key, ctx, kids, always);
        }

        const n = constValue(this.b, m.v);

        if (n === 1 && !always)
            return [];

        return n !== undefined ? [{ text: ` ×${formatNumber(n)}`, kind: 'value', tip: m.v !== String(n) ? m.v : undefined }] : rich(' × ', this.seg(m.v, ctx));
    }

    /** " (between −5 and 5, in steps of 5)" */
    private bounds(f: Record<string, string>, ctx: Ctx): Rich
    {
        const parts: Rich[] = [];

        if (f.min !== undefined && f.max !== undefined)
            parts.push(rich('between ', this.seg(f.min, ctx), ' and ', this.seg(f.max, ctx)));
        else if (f.min !== undefined)
            parts.push(rich('at least ', this.seg(f.min, ctx)));
        else if (f.max !== undefined)
            parts.push(rich('at most ', this.seg(f.max, ctx)));

        if (f.step !== undefined)
            parts.push(rich('in steps of ', this.seg(f.step, ctx)));

        return parts.length ? rich(' (', ...parts.flatMap((p, i) => (i ? [', ', ...p] : p)), ')') : [];
    }

    /** The `trigger = { }` of an opinion / personality / compare modifier as condition lines. */
    private conditions(block: PNode[], ctx: Ctx): Line[]
    {
        const t = block.find((x) => x.k === 'trigger');
        return t && Array.isArray(t.v) ? this.b.d.triggers(t.v, ctx) : [];
    }

    /** "your" / "Recipient’s" (`head`: at the start of a line — "Your") */
    private whose(who: string | undefined, ctx: Ctx, head = false): Rich
    {
        const your = head ? 'Your' : 'your';

        if (!who || /^(root|this)$/.test(who))
            return [your];

        const s = this.b.d.scopeSeg(who, ctx, head);
        const t = typeof s === 'string' ? s : s.text;
        return /^you$/i.test(t) ? [your] : [s, t.endsWith('s') ? '’' : '’s'];
    }

    /** `if` / `else_if` / `else = { limit = { … } <ops> }` */
    private branch(c: PNode, block: PNode[], ctx: Ctx): Line
    {
        const limit = block.find((x) => x.k === 'limit');
        const conds = limit && Array.isArray(limit.v) ? this.b.d.triggers(limit.v, ctx) : [];
        const kids = this.lines(
            block.filter((x) => x.k !== 'limit'),
            ctx
        );
        const l = c.k === 'else' ? { text: ['Otherwise:'] } : conditional(this.b, [c.k === 'if' ? 'If' : 'Otherwise, if'], conds, true, ' ', subjectOf(ctx));
        // (its limit: "＋ condition" adds one, the limit made when missing)
        const limitSrc = ctx.file && c.k !== 'else' ? this.b.d.limitOf(c, ctx) : undefined;
        return { ...l, children: kids, icon: c.k === 'else' ? 'else' : 'if', tip: this.raw(c, ctx), src: ctx.file && this.b.fieldAnchor(c, ctx, this.fields, true), ...(limitSrc ? { limitSrc } : {}) };
    }

    /** `every_x = { limit = { … } add = 1 }`: "For each child that is an adult:" (inside, "the child" is the subject) */
    private iterator(c: PNode, how: string, what: string, block: PNode[], ctx: Ctx): Line
    {
        const limit = block.find((x) => x.k === 'limit');
        const conds = limit && Array.isArray(limit.v) ? this.b.d.triggers(limit.v, ctx) : [];
        const type = block.find((x) => x.k === 'type' && typeof x.v === 'string');
        const name = humanize(what);
        const head = rich(how === 'every' ? `For each ${name}` : how === 'random' ? `For one random ${name}` : `For the best ${name}`, type ? rich(' (', this.b.d.ref(type.v as string), ')') : '');
        const kids = this.lines(
            block.filter((x) => !ITERATOR_PARAMS.has(x.k ?? '')),
            { ...ctx, scope: `the ${name}`, scopeType: undefined }
        );
        return { ...conditional(this.b, head, conds, true, ' that ', null), children: kids, icon: 'loop', tip: this.raw(c, ctx), src: ctx.file && this.b.fieldAnchor(c, ctx, this.fields, true) };
    }

    /**
     * A scripted modifier used by name (`name = yes`, `name = { PARAM = value }`): a link with its arguments, its lines
     * (with the arguments filled in) folded inside. A name holding a `$PARAM$` of its own lists the modifiers it can be.
     */
    private scripted(c: PNode, ctx: Ctx): Line
    {
        const k = c.k!;
        const tip = this.raw(c, ctx);
        const src = ctx.file && this.b.d.anchor(c, ctx, 'other', false);

        if (k.includes('$'))
        {
            const re = new RegExp('^' + k.replace(/[.*+?^{}()|[\]\\]/g, '\\$&').replace(/\$\w+\$/g, '\\w+') + '$');
            const params = [...k.matchAll(/\$(\w+)\$/g)].map((m) => humanize(m[1]));
            const names = this.b.idx.names('scripted_modifiers').filter((n) => re.test(n));
            const links = names.slice(0, 8).map((n) => this.b.d.entitySeg(this.b.idx.get('scripted_modifiers', n)!));
            const text = links.length
                ? rich('One of ', ...links.flatMap((l, i) => (i ? [i === links.length - 1 ? ' or ' : ', ', l] : [l])), names.length > 8 ? ` (+${names.length - 8})` : '', `, by ${params.join(' and ')}`)
                : rich('A scripted modifier named by ', params.join(' and '), ' (', { text: k, kind: 'code' }, ')');
            return { text, icon: 'modifier', tip, src };
        }

        const e = this.b.idx.get('scripted_modifiers', k)!;
        const args = Array.isArray(c.v) ? c.v.filter((x) => x.k && typeof x.v === 'string') : [];
        const text = rich(this.b.d.entitySeg(e), args.length ? rich(' (', ...args.flatMap((x, i) => [i ? ', ' : '', humanize(x.k!), ': ', this.seg(x.v as string, ctx)]), ')') : '');
        let children: Line[] | undefined;

        if (ctx.expand > 0 && !ctx.stack.includes(k))
        {
            const d = this.b.idx.defNode(e, args.length ? Object.fromEntries(args.map((x) => [x.k!, x.v as string])) : undefined);

            // (another definition's text, $PARAM$ substituted: its lines are not this file's)
            if (d && Array.isArray(d.node.v))
                children = this.lines(d.node.v, { ...ctx, src: d.src, file: undefined, expand: ctx.expand - 1, stack: [...ctx.stack, k] });
        }

        return { text, children: children?.length ? children : undefined, collapsed: true, icon: 'modifier', tip, src };
    }

    /** A written operand: number, script value, scope, `$PARAM$` (a placeholder). */
    private seg(v: string, ctx: Ctx): RichSeg
    {
        return operand(this.b, v, ctx);
    }

    /** The statement as written (a line's tooltip). */
    private raw(n: PNode, ctx: Ctx): string
    {
        const t = ctx.src.slice(n.s, n.e);
        return t.length > 600 ? t.slice(0, 600) + '\n…' : t;
    }
}

/**
 * A line's head with its conditions: inline when short ("+10 if you are at war", `link` before the clause), else as a
 * list ("+10 if:"); `more`: lines follow (a colon at the end). `subject`: whom the conditions are about (null: the
 * iterated item — "that is an adult").
 */
export function conditional(b: StoryBuilder, head: Rich, conds: Line[], more = false, link = ' if ', subject: RichSeg | null = 'you'): Pick<Line, 'text' | 'conditions' | 'icon'>
{
    if (!conds.length)
        return { text: rich(head, more ? ':' : '') };

    const clause = b.d.conditionClause(conds, subject);

    if (leaves(conds) <= CLAUSE_LEAVES && richToString(clause).length <= CLAUSE_CHARS)
        return { text: rich(head, link, clause, more ? ':' : ''), icon: 'if' };

    return { text: rich(head, link.trimEnd(), ':'), conditions: conds, icon: 'if' };
}

/** Whom conditions here are about: "you" at the top, the scope inside a scope switch or an iterator ("your suzerain", "the child"). */
export function subjectOf(ctx: Ctx): RichSeg
{
    return ctx.scope === 'you' ? 'you' : { text: ctx.scope, kind: 'scope' };
}

/** A written operand: number, script value (its number when it comes to a constant), scope, `$PARAM$` (a placeholder). */
export function operand(b: StoryBuilder, v: string, ctx: Ctx): RichSeg
{
    const p = /^\$(\w+)\$$/.exec(v);

    if (p)
        return { text: humanize(p[1]), kind: 'ph', tip: v };

    const n = constValue(b, v);
    return n !== undefined && !/^-?[\d.]+$/.test(v) ? { text: formatNumber(n), kind: 'value', tip: v } : b.d.valueSeg(v, ctx);
}

/**
 * The number of a value: a number, or a script value whose formula comes to a constant (`add = high_skill_rating
 * subtract = skill_variance`: value / add / subtract / multiply / divide / min / max of constants).
 */
export function constValue(b: StoryBuilder, v: string, depth = 0): number | undefined
{
    const n = b.d.evalValue(v);

    if (n !== undefined || depth > 6)
        return n;

    const e = b.idx.get('script_values', v);
    const d = e && b.idx.defNode(e);

    if (!d || !Array.isArray(d.node.v))
        return undefined;

    let x = 0;

    for (const c of d.node.v)
    {
        if (!c.k)
            continue;

        const o = typeof c.v === 'string' ? constValue(b, c.v, depth + 1) : undefined;

        if (o === undefined)
            return undefined;

        if (c.k === 'value')
            x = o;
        else if (c.k === 'add')
            x += o;
        else if (c.k === 'subtract')
            x -= o;
        else if (c.k === 'multiply')
            x *= o;
        else if (c.k === 'divide' && o)
            x /= o;
        else if (c.k === 'min')
            x = Math.max(x, o);
        else if (c.k === 'max')
            x = Math.min(x, o);
        else
            return undefined;
    }

    return x;
}

/** The scalar fields of a block by key. */
function fieldsOf(block: PNode[]): Record<string, string>
{
    const f: Record<string, string> = {};

    for (const x of block)
        if (x.k && typeof x.v === 'string')
            f[x.k] = x.v;

    return f;
}

/** How many conditions a clause of these lines names (a folded line — a scripted trigger, a custom text — is one). */
function leaves(lines: Line[]): number
{
    return lines.reduce((n, l) => n + (l.children?.length && !l.collapsed ? leaves(l.children) : 1) + (l.conditions?.length ? leaves(l.conditions) : 0), 0);
}
