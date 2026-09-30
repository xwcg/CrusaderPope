/**
 * Helpers that turn script identifiers and localization data functions into readable text.
 */
import type { BracketLink, Rich, RichSeg } from '../../shared/api.ts';

export function humanize(id: string): string
{
    const s = id
        .replace(/^(scope|var|local_var|global_var|flag):/, '')
        .replace(/_(trigger|effect|value|modifier|decision|interaction)$/, '')
        .replace(/[_.]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .trim()
        .toLowerCase();
    return s;
}

export function capitalize(s: string): string
{
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function titleCase(s: string): string
{
    return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function formatNumber(n: number, decimals = 2): string
{
    const f = Number.isInteger(n) ? String(n) : n.toFixed(decimals).replace(/\.?0+$/, '');
    return f.replace('-', '−');
}

export function signed(n: number, decimals = 2): string
{
    return (n > 0 ? '+' : '') + formatNumber(n, decimals);
}

/** Concatenates rich parts, merging adjacent plain strings. */
export function rich(...parts: (RichSeg | Rich | string | undefined | null | false)[]): Rich
{
    const out: Rich = [];
    const push = (p: RichSeg): void =>
    {
        const last = out[out.length - 1];

        if (typeof p === 'string' && typeof last === 'string')
            out[out.length - 1] = last + p;
        else if (p !== '')
            out.push(p);
    };

    for (const p of parts)
    {
        if (p === undefined || p === null || p === false)
            continue;

        if (Array.isArray(p))
            p.forEach(push);
        else
            push(p);
    }

    return out;
}

export function richToString(r: Rich): string
{
    return r.map((s) => (typeof s === 'string' ? s : s.text)).join('');
}

const FEMALE_WORDS = new Set([
    'Her',
    'She',
    'Herself',
    'Hers',
    'Woman',
    'Women',
    'Daughter',
    'Daughters',
    'Girl',
    'Girls',
    'Lady',
    'Ladies',
    'Mother',
    'Sister',
    'Wife',
    'Queen',
    'Princess',
    'Niece',
    'Aunt',
    'Grandmother',
    'Granddaughter',
    'Mistress',
    'Empress',
    'Duchess',
    'Countess',
    'Baroness',
    'Female',
    'Maiden',
    'Madam',
    'Dame',
    'Matriarch',
    'Heiress',
    'Widow',
    'Priestess',
    'Sorceress',
    'Goddess'
]);

/** Scope part of a data function (`position_holder` in `[position_holder.GetName]`) → readable label. */
function scopePart(seg: string): string
{
    if (/^root$/i.test(seg) || seg === 'GetPlayer')
        return 'you';

    const sc = /^SCOPE\.sC\('(\w+)'\)$/.exec(seg);

    if (sc)
        return titleCase(humanize(sc[1]));

    return titleCase(humanize(seg));
}

/**
 * Turns one `[...]` data-function expression into a short placeholder, e.g.
 * `position_holder.GetHerHis|U` → "her/his", `ROOT.Char.GetFirstName` → "you".
 * `lookup` resolves quoted database keys (GetTrait('brave')) to display names.
 */
export function humanizeDataFunction(expr: string, lookup: (key: string) => string | undefined): string
{
    const fmt = /\|([A-Za-z0-9=+\-]*)$/.exec(expr)?.[1] ?? '';
    const out = humanizeExpr(expr.replace(/\|[A-Za-z0-9=+\-]*$/, '').trim(), lookup);
    return fmt.includes('U') ? capitalize(out) : out;
}

function humanizeExpr(expr: string, lookup: (key: string) => string | undefined): string
{
    let e = expr;
    // resolved database objects: GetTrait('brave').GetName, GetCourtPositionType('x').GetName()
    const quoted = /Get\w+\(\s*'([\w.]+)'\s*\)(?:\.(\w+)\(?\)?)?/.exec(e);

    if (quoted && (!quoted[2] || /Name/.test(quoted[2])))
    {
        const d = lookup(quoted[1]);

        if (d)
            return d;
    }

    if (/^\s*Select(Localization|LocalizationKey)\(/.test(e))
        return '';

    const custom = /Custom2?\(\s*'(\w+)'/.exec(e);

    if (custom)
        return humanize(custom[1].replace(/NoTooltip/g, ''));

    const sv = /ScriptValue\(\s*'(\w+)'/.exec(e);

    if (sv)
        return humanize(sv[1]);

    e = e.replace(/\(\s*[^)]*\)/g, ''); // drop call arguments
    const parts = e.split('.').filter((p) => p && p !== 'Char' && p !== 'Self');

    if (parts.length === 0)
        return expr;

    const last = parts[parts.length - 1];
    const scope = parts.length > 1 ? scopePart(parts[0]) : 'they';

    // gendered getters: GetHerHis → her/his
    const words = last.replace(/^Get/, '').match(/[A-Z][a-z]+/g) ?? [];

    if (words.length === 2 && FEMALE_WORDS.has(words[0]))
        return `${words[0].toLowerCase()}/${words[1].toLowerCase()}`;

    if (NAME_GETTER.test(last) && parts.length <= 2)
    {
        if (scope === 'you')
            return /Possessive/.test(last) ? 'your' : 'you';

        return /Possessive/.test(last) ? scope + '’s' : scope;
    }

    if (parts.length === 1)
    {
        // [concept] or [Getter]
        return humanize(last.replace(/^Get/, ''));
    }

    const middle = parts
        .slice(1)
        .map((p) => humanize(p.replace(/^Get/, '').replace(/NoTooltip$/, '')))
        .filter((p) => p && p !== 'name')
        .join(' ');
    return scope === 'you' ? `your ${middle}` : `${scope}’s ${middle}`;
}

const NAME_GETTER = /^Get(Titled)?(First|Short|Full|UI|ShortUI|FullUI|Base|Birth)?Name(NoTooltip|Possessive|NoTooltipPossessive|Only)?$|^GetShortUIName|^GetUIName/;

/** Finds top-level [ ... ] expressions, respecting nested brackets and quoted strings. */
export function scanBrackets(text: string): { start: number; end: number; inner: string; }[]
{
    const out: { start: number; end: number; inner: string; }[] = [];
    let i = 0;

    while (i < text.length)
    {
        if (text[i] !== '[')
        {
            i++;
            continue;
        }

        let depth = 0;
        let quote = false;
        let j = i;

        for (; j < text.length; j++)
        {
            const c = text[j];

            if (c === "'")
                quote = !quote;
            else if (!quote && c === '[')
                depth++;
            else if (!quote && c === ']' && --depth === 0)
                break;
        }

        if (j >= text.length)
            break;

        out.push({ start: i, end: j + 1, inner: text.slice(i + 1, j) });
        i = j + 1;
    }

    return out;
}

/** Replaces every [data function] in a string by its readable placeholder. */
export function humanizeBrackets(text: string, lookup: (key: string) => string | undefined): string
{
    let out = '';
    let last = 0;

    for (const b of scanBrackets(text))
    {
        out += text.slice(last, b.start) + humanizeDataFunction(b.inner, lookup);
        last = b.end;
    }

    return out + text.slice(last);
}

/**
 * Localization text (already $-resolved, formatting codes removed) → Rich, with [data functions] as placeholders.
 */
export function locToRich(text: string, lookup: (key: string) => string | undefined, resolve?: (inner: string) => BracketLink | undefined): Rich
{
    const out: Rich = [];
    let last = 0;

    for (const b of scanBrackets(text))
    {
        if (b.start > last)
            out.push(text.slice(last, b.start));

        // data functions naming a database object (GetTrait('brave') …) and concept links ([faith|E]) become links
        const link = resolve?.(b.inner);
        const h = link?.text ?? humanizeDataFunction(b.inner, lookup);
        const tip = text.slice(b.start, b.end);

        if (h)
            out.push(link ? { text: h, kind: 'entity', ref: { type: link.type, name: link.name }, tip } : { text: h, kind: 'ph', tip });

        last = b.end;
    }

    if (last < text.length)
        out.push(text.slice(last));

    return rich(out);
}
