/**
 * Shared pieces of the realm cards (cards/realm.ts and its realm-*.ts modules): a `RealmCard` reads one definition's
 * statements, remembers the top-level keys it showed and ends with the generic sections for the rest (a mod's own
 * keys), then the AI section.
 */
import type { PNode } from '../../indexer/parser.ts';
import type { FollowUp, Line, Rich, RichSeg, SectionSource } from '../../../shared/api.ts';
import { fieldOf, fieldText } from '../../../shared/fieldCatalog.ts';
import type { Ctx, Describer } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import { capitalize, formatNumber, humanize, rich } from '../text.ts';
import type { CardInput } from './types.ts';
import { weightLines } from './weight.ts';

export type Block = PNode & { v: PNode[]; };

export const isBlock = (n: PNode | undefined): n is Block => !!n && Array.isArray(n.v);

/** A statement's value in a list (the first `key = value`). */
export function val(list: PNode[], k: string): string | undefined
{
    const c = list.find((x) => x.k === k && typeof x.v === 'string');
    return c?.v as string | undefined;
}

/** The entries of a plain list `{ a b c }` (nodes without a key). */
export function items(n: PNode | undefined): PNode[]
{
    return isBlock(n) ? n.v.filter((x) => !x.k && typeof x.v === 'string') : [];
}

/** "a, b and c" */
export function join(parts: (RichSeg | Rich)[], last = ' and '): Rich
{
    return rich(...parts.flatMap((p, i) => (i ? [i === parts.length - 1 ? last : ', ', p] : [p])));
}

/** A line's text without its comment (`#` outside quotes). */
function uncomment(line: string): string
{
    let quoted = false;

    for (let i = 0; i < line.length; i++)
    {
        const ch = line[i];

        if (ch === '"')
            quoted = !quoted;
        else if (ch === '#' && !quoted)
            return line.slice(0, i);
    }

    return line;
}

/**
 * The value of a statement written right inside a definition's block (`group = conquest` of a casus belli), read from
 * its text line by line (comments cut off) without parsing it.
 */
export function ownValue(text: string, key: string): string | undefined
{
    const re = new RegExp(`^\\s*${key}\\s*=\\s*"?([\\w.:-]+)`);
    let depth = 0;

    for (const raw of text.split('\n'))
    {
        const line = uncomment(raw);
        const m = depth === 1 && re.exec(line);

        if (m)
            return m[1];

        for (const ch of line)
            depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
    }

    return undefined;
}

export class RealmCard
{
    readonly b: StoryBuilder;
    readonly d: Describer;
    readonly x: CardInput;
    readonly ctx: Ctx;
    /** top-level keys shown (left out of the generic sections) */
    private shown = new Set<string>();
    private aiLines: Line[] = [];
    private constMap: Map<string, string> | undefined;

    constructor(b: StoryBuilder, x: CardInput)
    {
        this.b = b;
        this.d = b.d;
        this.x = x;
        this.ctx = x.ctx;
    }

    /** A top-level statement (from now on shown). */
    node(k: string): PNode | undefined
    {
        this.shown.add(k);
        return this.x.body.find((c) => c.k === k);
    }

    block(k: string): Block | undefined
    {
        const n = this.node(k);
        return isBlock(n) ? n : undefined;
    }

    val(k: string): string | undefined
    {
        const n = this.node(k);
        return typeof n?.v === 'string' ? n.v : undefined;
    }

    /** Every top-level statement of a key (`flag = a  flag = b`). */
    all(k: string): PNode[]
    {
        this.shown.add(k);
        return this.x.body.filter((c) => c.k === k);
    }

    /** Keys shown some other way, or not worth showing (map colours, interface layout). */
    skip(...keys: string[]): void
    {
        for (const k of keys)
            this.shown.add(k);
    }

    fact(...parts: (RichSeg | Rich | string | undefined | false)[]): void
    {
        this.x.card.facts.push(rich(...parts));
    }

    /** Adds a section when it has lines, or a place to add them. */
    section(title: string, lines: Line[], src?: SectionSource): void
    {
        if (lines.length || src)
            this.x.card.sections.push({ title, lines, src });
    }

    /** The card's title from the loc key the game names the entry with (`rule_<key>`, `setting_<key>`), when it has one. */
    title(key: string): void
    {
        const r = this.d.loc(key);

        if (r)
        {
            this.x.card.title = this.d.richString(r).trim();
            // (edited in place in a mod's entry)
            this.x.card.titleKey = key;
        }
    }

    /** A loc text. */
    text(key: string): Rich | undefined
    {
        return this.d.loc(key);
    }

    /** The card's description from a loc key, when it has none yet. */
    describe(key: string): void
    {
        if (!this.x.card.description)
        {
            this.x.card.description = this.text(key);

            if (this.x.card.description)
                this.x.card.descriptionKey = key;
        }
    }

    /** Statements with the file's `@constants` read as their numbers (copies keep their place in the file). */
    consts(list: PNode[]): PNode[]
    {
        return list.map((c) =>
        {
            if (Array.isArray(c.v))
                return { ...c, v: this.consts(c.v) };

            const n = c.v.startsWith('@') ? this.num(c.v) : undefined;
            return n !== undefined ? { ...c, v: String(n) } : c;
        });
    }

    /** A cost block's lines (StoryBuilder.cost); a script value that is no constant is a link to it. */
    cost(n: Block): Line[]
    {
        const list = this.consts(n.v).filter((c) => c.k);
        return this.b.cost(list, this.ctx).map((l, i) =>
        {
            const v = list[i].v;
            return typeof v === 'string' && this.d.evalValue(v) === undefined && this.b.idx.get('script_values', v) ? { ...l, text: [this.d.valueSeg(v, this.ctx), ...l.text.slice(1)] } : l;
        });
    }

    /** A script value block's lines (weight.ts), or a note when they read nothing (the script is its tooltip). */
    value(n: Block): Line[]
    {
        const lines = weightLines(this.b, this.consts(n.v), this.ctx);

        if (lines.length || !n.v.length)
            return lines;

        const script = this.ctx.src.slice(n.s, n.e);
        return [{ text: ['Worked out in script (see the Source tab)'], icon: 'note', tip: script.length > 600 ? script.slice(0, 600) + '\n…' : script }];
    }

    /** A number from a written value: a number, an `@constant` of the file, a constant script value. */
    num(v: string): number | undefined
    {
        if (v.startsWith('@'))
            v = (this.constMap ??= this.b.idx.fileConstants(this.x.e)).get(v.slice(1)) ?? v;

        return this.d.evalValue(v);
    }

    anchor(n: PNode, kind: SectionSource['kind'], inner = false): Line['src']
    {
        return this.d.anchor(n, this.ctx, kind, inner);
    }

    /** The key of the block the definition is written in — a law's group, a title's de jure liege, an option's rule. */
    enclosing(): string | undefined
    {
        const d = this.b.idx.winningDef(this.x.e);

        if (!d)
            return undefined;

        // backwards from where the definition starts: the first unmatched `{` (no scan over the type's entries)
        const src = this.b.idx.readFile(d.file);
        let depth = 0;

        for (let end = d.start; end > 0;)
        {
            const start = src.lastIndexOf('\n', end - 1) + 1;
            const line = uncomment(src.slice(start, end));

            for (let i = line.length - 1; i >= 0; i--)
            {
                if (line[i] === '}')
                    depth++;
                else if (line[i] === '{' && depth-- === 0)
                    return /([\w.:-]+)\s*=\s*$/.exec(src.slice(Math.max(0, start + i - 200), start + i))?.[1];
            }

            end = start - 1;
        }

        return undefined;
    }

    /**
     * One scalar statement of a field set (shared/fields/realm.ts) as a line: known fields read their way (fieldText),
     * references as links, numbers from `@constants` and script values, names made readable; `loc`: the value is a loc
     * key, shown as its text. Unknown keys read "Key: value". Anchored with the set's name (the picker changes it).
     */
    field(set: string, c: PNode, loc = false): Line
    {
        const raw = c.v as string;
        const f = fieldOf(set, c.k!);
        const n = !f || f.kind === 'number' ? this.num(raw) : undefined;
        // the value as a segment of the field's text: a link, a loc text, a name, a value that is no number
        const seg: RichSeg | undefined = f?.kind === 'ref'
            ? this.d.ref(raw, f.ref ? [f.ref] : undefined)
            : loc
            ? { text: `“${this.d.richString(this.d.loc(raw) ?? [humanize(raw)])}”`, kind: 'value', tip: raw }
            : f?.kind === 'text'
            ? { text: humanize(raw), kind: 'value', tip: raw }
            : f?.kind === 'number' && n === undefined
            ? this.d.valueSeg(raw, this.ctx)
            : undefined;
        let text: Rich;
        let tone: Line['tone'];

        if (f && seg && typeof f.read === 'string')
        {
            const i = f.read.indexOf('$');
            text = rich(f.read.slice(0, i), seg, f.read.slice(i + 1));
        }
        else
        {
            const t = f && fieldText(set, c.k!, n !== undefined ? String(n) : raw);

            if (t)
            {
                text = t.tone ? [{ text: t.text, kind: t.tone }] : [t.text];
                tone = t.tone;
            }
            else
                text = rich(capitalize(humanize(c.k!)), ': ', this.d.valueSeg(raw.startsWith('@') && n !== undefined ? String(n) : raw, this.ctx));
        }

        return { text, tone, tip: `${c.k} = ${raw}`, src: this.b.fieldAnchor(c, this.ctx, set) };
    }

    /** The scalar statements of a list as field lines (`loc`: keys whose values are loc keys). */
    fields(set: string, list: PNode[], loc: string[] = []): Line[]
    {
        return list.filter((c) => c.k && typeof c.v === 'string').map((c) => this.field(set, c, loc.includes(c.k!)));
    }

    /**
     * The top-level scalars not shown yet (but for stat modifiers the field set does not know: the generic "Modifiers")
     * as field lines; they count as shown.
     */
    private settingLines(set: string, loc: string[] = []): Line[]
    {
        const list = this.x.body.filter((c) => c.k && typeof c.v === 'string' && !this.shown.has(c.k) && (fieldOf(set, c.k) || !this.d.isModifierKey(c.k)));

        for (const c of list)
            this.shown.add(c.k!);

        return this.fields(set, list, loc);
    }

    /** A section of `lines` and the settings not shown yet, at the definition's own block (fields of the set can be added). */
    settings(title: string, set: string, lines: Line[] = [], loc: string[] = []): void
    {
        this.section(title, [...lines, ...this.settingLines(set, loc)], this.x.own('field', set));
    }

    /** A trigger block as a section (`scope`: the scope type of its root, a hint for adding conditions). */
    triggers(k: string, title: string, scope?: string): void
    {
        for (const n of this.all(k))
        {
            if (!isBlock(n))
                continue;

            const ctx = scope ? { ...this.ctx, scopeType: scope } : this.ctx;
            this.section(title, this.d.triggers(n.v, ctx), this.b.blockSection(n, 'trigger', ctx));
        }
    }

    /** An effect block as a section, with the events it leads to. */
    effects(k: string, title: string, scope?: string): void
    {
        for (const n of this.all(k))
        {
            if (!isBlock(n))
                continue;

            const ctx = { ...this.ctx, followUps: [] as FollowUp[], ...(scope ? { scopeType: scope } : {}) };
            const lines = this.d.effects(n.v, ctx);
            const src = this.b.blockSection(n, 'effect', ctx);

            if (lines.length || src)
                this.x.card.sections.push({ title, lines, followUps: ctx.followUps, src });
        }
    }

    /** Condition lines of a block inside the definition (a limit, an obligation level's is_valid). */
    conditions(n: PNode | undefined, scope?: string): Line[]
    {
        return isBlock(n) ? this.d.triggers(n.v, scope ? { ...this.ctx, scopeType: scope } : this.ctx) : [];
    }

    /** A weight or score (a block, or a plain value) as one line, its statements below (weight.ts). */
    weight(n: PNode, label: string): Line
    {
        if (typeof n.v === 'string')
        {
            const v = this.num(n.v);
            return { text: rich(label, ': ', v !== undefined ? { text: formatNumber(v), kind: 'value', tip: n.v } : this.d.valueSeg(n.v, this.ctx)), icon: 'chance', tip: `${n.k} = ${n.v}`, src: this.anchor(n, 'other') };
        }

        return { text: [label + ':'], children: this.value(n as Block), icon: 'chance', tip: n.k ?? undefined, src: this.anchor(n, 'other') };
    }

    /** Adds a top-level weight block to the AI section (shown last). */
    ai(k: string, label: string): void
    {
        for (const n of this.all(k))
            this.aiLines.push(this.weight(n, label));
    }

    /** Adds lines to the AI section. */
    aiMore(lines: Line[]): void
    {
        this.aiLines.push(...lines);
    }

    /** Ends the card: the generic sections for keys not shown yet, then the AI section. */
    done(): true
    {
        const { e, body, card, ctx, own } = this.x;
        this.b.genericSections(e, body, card, ctx, own, this.shown);
        this.section('AI', this.aiLines);
        return true;
    }
}
