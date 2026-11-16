/**
 * The value editor's knowledge of a simple statement's value (docs/mods.md "Editing in place", the Value tab): what
 * kinds of value it takes (kindsOf: the catalog's statement, the key scan's shapes, what is written) and what to offer
 * while typing (suggestValues). Kept apart from InPlaceEdit.tsx so the check scripts can run it
 * (scripts/value-kinds-check.ts): no window, no api; the data comes in through ValueSources.
 */
import type { Line, PickPlace, PickTarget, ScopeReach, ScriptKeyInfo } from '../../../shared/api.ts';
import { findStatement, type ParamDef } from '../../../shared/scriptCatalog.ts';
import { tr } from '../../../shared/i18n.ts';
import { fold, foldHas } from '../../../shared/fold.ts';
import { inReach } from '../picker/targets.ts';

// ---------------------------------------------------------------------------
// A simple statement
// ---------------------------------------------------------------------------

const SCALAR = /^([A-Za-z0-9_:.@$'-]+)\s*(=|==|!=|<=|>=|<|>|\?=)\s*(?:"([^"\n]*)"|([^\s{}"#]+))\s*$/;
export const NUMBER = /^-?\d+(\.\d+)?$/;

export interface Scalar
{
    key: string;
    op: string;
    value: string;
    quoted: boolean;
}

export function parseScalar(text: string): Scalar | null
{
    const m = SCALAR.exec(text.trim());
    return m ? { key: m[1], op: m[2], value: m[3] ?? m[4], quoted: m[3] !== undefined } : null;
}

export const scalarText = (s: Scalar): string => `${s.key} ${s.op} ${s.quoted ? `"${s.value}"` : s.value}`;

// ---------------------------------------------------------------------------
// What a value is
// ---------------------------------------------------------------------------

/**
 * A kind of value a statement takes: a number or a script value (and the saved values, `scope:x` of
 * save_scope_value_as), a scope (`root`, `scope:x`, a chain `liege.father`), a flag (`flag:x`, a `…_flag` statement), a
 * variable (`var:x`), a list's name (`add_to_list`), an entry of a type (`trait:brave`), one of a fixed set, else text.
 */
export type ValueKind =
    | { kind: 'number'; }
    | { kind: 'scope'; }
    | { kind: 'flag'; }
    | { kind: 'variable'; }
    | { kind: 'list'; }
    | { kind: 'entry'; type: string; prefix?: string; }
    | { kind: 'choice'; options: { value: string; label: string; }[]; }
    | { kind: 'text'; };

const SCOPE_VALUE = /^(root|this|prev|from|scope:|[\w-]+\.)/;
const VARIABLE = /^(local_|global_)?var:/;
const LIST_KEY = /^(add_to_(temporary_)?list|is_in_list|remove_from_list)$/;

/** The database type a value names, from the line's links ("Has the trait ‹Brave›" → traits). */
export function typeOfValue(value: string, line?: Line): string | undefined
{
    const name = value.replace(/^\w+:/, '');

    for (const s of line?.text ?? [])
        if (typeof s !== 'string' && s.ref && (s.ref.name === name || s.ref.name === value))
            return s.ref.type;

    return undefined;
}

/** What the written value is, by itself (the fallback, and the first kind: the field opens as it). */
export function writtenKind(s: Scalar, line?: Line): ValueKind
{
    const type = typeOfValue(s.value, line);

    if (NUMBER.test(s.value) || type === 'script_values')
        return { kind: 'number' };

    if (VARIABLE.test(s.value))
        return { kind: 'variable' };

    if (s.value.startsWith('flag:') || /(^|_)flag$/.test(s.key) || type === 'flag')
        return { kind: 'flag' };

    if (LIST_KEY.test(s.key))
        return { kind: 'list' };

    if (SCOPE_VALUE.test(s.value))
        return { kind: 'scope' };

    return type ? { kind: 'entry', type } : { kind: 'text' };
}

/** A catalog parameter's kind (undefined: says nothing about the value). */
function paramKind(p: ParamDef): ValueKind | undefined
{
    switch (p.kind)
    {
        case 'number':
        case 'duration':
            return { kind: 'number' };
        case 'scope':
            return { kind: 'scope' };
        case 'ref':
            return { kind: 'entry', type: p.type, ...(p.prefix ? { prefix: p.prefix } : {}) };
        case 'name':
            return { kind: p.type === 'flag' ? 'flag' : 'variable' };
        case 'choice':
            return { kind: 'choice', options: p.options.map((o) => ({ value: o.value, label: o.label })) };
    }

    return undefined;
}

/** The kind the catalog's statement gives the written value (the picker's StatementDef, findStatement). */
export function catalogKind(s: Scalar, trigger: boolean): ValueKind | undefined
{
    const found = findStatement(trigger ? 'trigger' : 'effect', scalarText(s));

    if (!found)
        return undefined;

    for (const p of [...found.def.params, ...(found.def.extra ?? [])])
        if (found.values[p.name] === s.value)
            return paramKind(p);

    return undefined;
}

/** The key scan's shapes that make up at least 5 % of the statement's uses (number, compare: a number; scope). */
export function shapeKinds(info: ScriptKeyInfo | undefined): ValueKind[]
{
    const shapes = info?.shapes ?? {};
    const total = Object.values(shapes).reduce((a, n) => a + (n ?? 0), 0);
    const share = (k: keyof typeof shapes): boolean => total > 0 && (shapes[k] ?? 0) / total >= 0.05;
    const out: ValueKind[] = [];

    if (share('number') || share('compare'))
        out.push({ kind: 'number' });

    if (share('scope'))
        out.push({ kind: 'scope' });

    return out;
}

const same = (a: ValueKind, b: ValueKind): boolean => a.kind === b.kind && (a.kind !== 'entry' || (b.kind === 'entry' && a.type === b.type));

/**
 * The kinds a statement's value takes: what is written first (the field opens as it), then the catalog statement's
 * parameter, then the key scan's shapes (`info`: ScriptKeyInfo of the key, when loaded). Text only when nothing else.
 */
export function kindsOf(s: Scalar, trigger: boolean, line?: Line, info?: ScriptKeyInfo): ValueKind[]
{
    const out: ValueKind[] = [];
    const add = (k: ValueKind | undefined): void =>
    {
        if (k && k.kind !== 'text' && !out.some((o) => same(o, k)))
            out.push(k);
    };
    add(writtenKind(s, line));
    add(catalogKind(s, trigger));

    for (const k of shapeKinds(info))
        add(k);

    return out.length ? out : [{ kind: 'text' }];
}

/** The kinds in words ("number or script value, scope"). */
export function kindsLabel(kinds: ValueKind[]): string | undefined
{
    const words = kinds.map((k) => (k.kind === 'number' ? tr('number or script value') : k.kind === 'scope' ? tr('scope') : k.kind === 'flag' ? tr('flag') : k.kind === 'variable' ? tr('variable') : k.kind === 'list' ? tr('list') : k.kind === 'entry' ? k.type : k.kind === 'choice' ? tr('one of a set') : '')).filter((w) => w);
    return words.length ? words.join(', ') : undefined;
}

/** The field lists its suggestions right away (before typing): its first kind is a scope, flag, list or set. */
export const listsRightAway = (kinds: ValueKind[]): boolean => ['scope', 'flag', 'list', 'choice'].includes(kinds[0]?.kind);

// ---------------------------------------------------------------------------
// What a value field offers
// ---------------------------------------------------------------------------

/** A value offered for a field: what is written (whole, its `prefix:` too), how it reads, a hint (where it is from). */
export interface Suggestion
{
    value: string;
    label?: string;
    hint?: string;
}

/** Scopes every script can name (besides the shown entry's own; picker/targets.ts). */
export const COMMON_SCOPES: [string, string][] = [
    ['root', tr('the one the script is about')],
    ['this', tr('the current scope')],
    ['prev', tr('the scope before this one')],
    ['scope:actor', tr('an interaction’s actor')],
    ['scope:recipient', tr('an interaction’s recipient')],
    ['scope:secondary_actor', tr('an interaction’s secondary actor')],
    ['scope:secondary_recipient', tr('an interaction’s secondary recipient')],
    ['liege', tr('their liege')],
    ['top_liege', tr('their top liege')],
    ['father', tr('their father')],
    ['mother', tr('their mother')],
    ['primary_spouse', tr('their primary spouse')],
    ['primary_heir', tr('their primary heir')],
    ['employer', tr('who employs them')],
    ['host', tr('whose court they are in')],
    ['primary_title', tr('their primary title')],
    ['capital_county', tr('their capital county')],
    ['faith', tr('their faith')],
    ['culture', tr('their culture')],
    ['dynasty', tr('their dynasty')],
    ['house', tr('their house')]
];

/**
 * The common scopes offered: all of them, but when the shown entry's scopes are known (picker/targets.ts
 * viewTargetsKnown: an event's cast, an entry its type's .info documents) the saved ones (`scope:actor` …) only when the
 * entry has them (they come with its own targets then).
 */
export function commonScopes(known: boolean, targets: PickTarget[]): [string, string][]
{
    return COMMON_SCOPES.filter(([v]) => !known || !v.startsWith('scope:') || targets.some((t) => t.key === v));
}

/** A list name of the shown entry (EntityCard.lists): where it comes from, where it is in reach. */
export interface ListName
{
    name: string;
    about?: string;
    reach?: ScopeReach;
}

/** The statements that make a list (their value, or their `list = x` field) or read one: their names are lists'. */
const LIST_MAKERS: [kind: 'effect' | 'trigger', key: string, field?: string][] = [
    ['effect', 'add_to_list'],
    ['effect', 'add_to_temporary_list'],
    ['trigger', 'add_to_temporary_list'],
    ['effect', 'remove_from_list'],
    ['trigger', 'is_in_list'],
    ['effect', 'every_in_list', 'list'],
    ['effect', 'random_in_list', 'list'],
    ['effect', 'ordered_in_list', 'list'],
    ['trigger', 'any_in_list', 'list']
];

/**
 * Every list name the key scan saw the game's script use (pure): the values of add_to_list, add_to_temporary_list,
 * remove_from_list and is_in_list, the `list = x` of the *_in_list iterators, each name with its uses summed, most
 * used first. The scan keeps a statement's 16 commonest values and a block field's 60, so rarer names are not there.
 */
export function gameListNames(effects: ScriptKeyInfo[] | undefined, triggers: ScriptKeyInfo[] | undefined): [string, number][]
{
    const n = new Map<string, number>();

    for (const [kind, key, field] of LIST_MAKERS)
    {
        const info = (kind === 'effect' ? effects : triggers)?.find((x) => x.key === key);

        for (const [v, c] of (field ? info?.fieldValues?.[field] : info?.values) ?? [])
            if (/^\w+$/.test(v))
                n.set(v, (n.get(v) ?? 0) + c);
    }

    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** What suggestValues reads: the index's lists, the shown entry's scopes and saved values (InPlaceEdit.tsx fills it). */
export interface ValueSources
{
    /** script values, the active mod's first (`mine`) */
    scriptValues(): Promise<{ name: string; display?: string; mine?: boolean; }[]>;
    /** the shown entry's scopes (picker/targets.ts viewTargets) and whether they are all of them */
    targets(): PickTarget[];
    targetsKnown(): boolean;
    /** where the edited statement is: the shown entry's scopes are offered where they are in reach (picker/targets.ts inReach) */
    place?: PickPlace;
    /**
     * the values the shown entry saves (EntityCard.values) and the list names in reach of its script (EntityCard.lists),
     * each offered where it is in reach at `place`
     */
    values(): Promise<PickTarget[]>;
    lists(): Promise<ListName[]>;
    /** every list name the game's script uses (gameListNames), most used first: offered after the ones in reach */
    gameLists?(): Promise<[string, number][]>;
    /** the values the game's script writes with this statement (the key scan), most used first */
    keyValues(key: string, trigger: boolean): Promise<[string, number][]>;
    /** entries of an index type ('flag', 'variable', 'traits' …) matching what is typed */
    search(type: string, q: string): Promise<{ name: string; display?: string; }[]>;
}

const matches = (q: string, ...parts: (string | undefined)[]): boolean =>
{
    if (!q)
        return true;

    const f = fold(q);
    return parts.some((p) => foldHas(p, f));
};

/** How many suggestions a field shows. */
const LIMIT = 16;

/** The rows one kind offers for what is typed (`typed`: the field's text, prefixes like `flag:` included). */
async function rowsOf(k: ValueKind, key: string, trigger: boolean, typed: string, src: ValueSources): Promise<Suggestion[]>
{
    switch (k.kind)
    {
        case 'number':
        {
            // (a variable holds a number: `var:x` typed lists the variables)
            const v = /^((?:local_|global_)?var:)(.*)$/.exec(typed);

            if (v)
                return rowsOf({ kind: 'variable' }, key, trigger, typed, src);

            if (!typed || /^-?[\d.]+$/.test(typed))
                return [];

            const saved = inReach(await src.values(), src.place).filter((x) => matches(typed, x.key, x.label)).map((x): Suggestion => ({ value: x.key, label: x.label, hint: x.about }));
            const named = (await src.scriptValues()).filter((e) => matches(typed, e.name, e.display)).map((e): Suggestion => ({ value: e.name, label: e.display && e.display !== e.name ? e.display : undefined, hint: e.mine ? tr('script value · your mod') : tr('script value') }));
            return [...saved, ...named];
        }

        case 'scope':
        {
            const targets = inReach(src.targets(), src.place);
            const own = targets.map((x): Suggestion => ({ value: x.key, label: x.label, hint: x.about }));
            const common = commonScopes(src.targetsKnown(), targets).filter(([v]) => !own.some((o) => o.value === v)).map(([value, hint]): Suggestion => ({ value, hint }));
            return [...own, ...common].filter((s) => matches(typed, s.value, s.label));
        }

        case 'flag':
        case 'variable':
        {
            const re = k.kind === 'flag' ? /^(flag:)?(.*)$/ : /^((?:local_|global_)?var:)?(.*)$/;
            const [, prefix = '', q = ''] = re.exec(typed) ?? [];
            const used = (await src.keyValues(key, trigger))
                .map(([v, n]) => ({ v: v.replace(/^(flag|(local_|global_)?var):/, ''), n }))
                .filter((x) => /^[\w.-]+$/.test(x.v) && matches(q, x.v))
                .map((x): Suggestion => ({ value: prefix + x.v, hint: tr('used {n}× with {key}', { n: x.n, key }) }));
            const more = q ? (await src.search(k.kind, q)).filter((e) => !used.some((u) => u.value === prefix + e.name)).map((e): Suggestion => ({ value: prefix + e.name, hint: k.kind === 'flag' ? tr('flag') : tr('variable') })) : [];
            return [...used, ...more];
        }

        case 'list':
        {
            // (the names in reach first (the entry's own, its called scripted effects', its callers'), then every name
            // the game uses, but none the entry itself has out of reach here)
            const all = await src.lists();
            const own = inReach(all, src.place).filter((l) => matches(typed, l.name)).map((l): Suggestion => ({ value: l.name, hint: l.about ?? tr('a list this entry adds to') }));
            const game = (await src.gameLists?.() ?? [])
                .filter(([n]) => matches(typed, n) && !all.some((l) => l.name === n))
                .map(([n, c]): Suggestion => ({ value: n, hint: tr('used {n}× in the game', { n: c }) }));
            return [...own, ...game];
        }

        case 'entry':
        {
            // (the prefix typed, else the catalog parameter's: `faith:` for a statement that names a faith that way)
            const typedPrefix = /^\w+:/.exec(typed)?.[0] ?? '';
            const prefix = typedPrefix || k.prefix || '';
            const q = typed.slice(typedPrefix.length);
            return q ? (await src.search(k.type, q)).map((r): Suggestion => ({ value: prefix + r.name, label: r.display && r.display !== r.name ? r.display : undefined })) : [];
        }

        case 'choice':
            return k.options.filter((o) => matches(typed, o.value, o.label)).map((o): Suggestion => ({ value: o.value, label: o.label !== o.value ? o.label : undefined }));
    }

    return [];
}

/**
 * What a value field offers for what is typed: the rows of every kind the statement takes (kindsOf), in their order,
 * each value once: script values and saved values for a number, the shown entry's scopes and the common ones for a
 * scope, the flags / variables the game writes with this statement and then any, the lists the entry adds to, entries
 * of a type, a fixed set's values.
 */
export async function suggestValues(kinds: ValueKind[], key: string, trigger: boolean, typed: string, src: ValueSources): Promise<Suggestion[]>
{
    const out: Suggestion[] = [];

    for (const k of kinds)
        for (const s of await rowsOf(k, key, trigger, typed, src))
            if (!out.some((o) => o.value === s.value))
                out.push(s);

    return out.slice(0, LIMIT);
}
