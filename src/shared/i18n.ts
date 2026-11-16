/**
 * The app's own texts in the user's language (docs/localization.md). The English text is the key: `tr('Zoom to it')`,
 * placeholders by name `tr('Faith of {county}', { county })`; a catalog (src/shared/locales/<lang>.json) maps the
 * English text to the translation, and anything it lacks stays English. `trc` tells apart one English text meaning
 * two things (`trc('verb', 'Open')`), `trn` picks a plural form by count (`trn('{n} county', '{n} counties', n)`).
 *
 * The language is fixed for the process's life (a change applies at the next start): main's boot entry puts it into
 * the environment before anything else loads (workers inherit it), the renderer gets it in its URL (`?lang=de`), so
 * texts translated at module level (menus, catalogs) are right too.
 */
import { CATALOGS, LANGUAGES } from './locales/index.ts';

/** A catalog: English text (or context + U+0004 + text) → translation; plurals as an object of plural categories. */
export type Catalog = Record<string, string | Partial<Record<Intl.LDMLPluralRule, string>>>;

/** the languages offered: code → its name in itself */
export { LANGUAGES };

let lang = 'en';
let table: Catalog = {};
let plural = new Intl.PluralRules('en');

/**
 * The pseudo-language `qps` (a test: CRUSADERPOPE_LOCALE=qps, docs/localization.md): every translated text accented
 * and bracketed (⟦Zóóm tó ít⟧), so English left on screen is a text not wrapped yet, and code that compares shown
 * texts shows up; placeholders stay as they are.
 */
const PSEUDO = 'qps';
const ACCENTS: Record<string, string> = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', c: 'ç', n: 'ñ', y: 'ý', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', C: 'Ç', N: 'Ñ', Y: 'Ý' };

function pseudo(text: string): string
{
    return '⟦' + text.replace(/\{\w+\}|[aeioucnyAEIOUCNY]/g, (m) => ACCENTS[m] ?? m) + '⟧';
}

/** Sets the language (an unknown one: English). */
export function setLocale(code: string | undefined | null): void
{
    lang = code && (CATALOGS[code] || code === PSEUDO) ? code : 'en';
    table = CATALOGS[lang] ?? {};
    plural = new Intl.PluralRules(lang === PSEUDO ? 'en' : lang);
}

/** A text not found in the catalog: the English one (in the pseudo-language marked). */
const fallback = (text: string): string => (lang === PSEUDO && !text.startsWith('⟦') ? pseudo(text) : text);

/** The language in use (a BCP 47 code: 'en', 'de' …), also for Intl number and date formats. */
export function locale(): string
{
    return lang;
}

// the language this process starts with: main's boot entry (and the workers it starts) by the environment, the
// renderer by its URL
const g = globalThis as { process?: { env?: Record<string, string | undefined>; }; location?: { search: string; }; };
setLocale(g.process?.env?.CRUSADERPOPE_LOCALE ?? (g.location ? new URLSearchParams(g.location.search).get('lang') : 'en'));

/** placeholder values: shown as a template string shows them (null and undefined: nothing) */
type Vars = Record<string, unknown>;

/** `{name}` in a text replaced by its value (an unknown name stays as written). */
function fill(text: string, vars?: Vars): string
{
    if (!vars)
        return text;

    return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m));
}

/** A text of the app in the user's language. */
export function tr(text: string, vars?: Vars): string
{
    const s = table[text];
    return fill(typeof s === 'string' && s ? s : fallback(text), vars);
}

/** A text that means different things in different places: the context tells which (`trc('verb', 'Open')`). */
export function trc(context: string, text: string, vars?: Vars): string
{
    const s = table[context + '\u0004' + text];
    return fill(typeof s === 'string' && s ? s : fallback(text), vars);
}

/**
 * A text with a count: the language's plural form for `n` (`{n}` is the count, formatted). The catalog keys it by the
 * English `other` form: `{ "{n} counties": { "one": "{n} Grafschaft", "other": "{n} Grafschaften" } }`.
 */
export function trn(one: string, other: string, n: number, vars?: Vars): string
{
    const s = table[other];
    const v = { n: n.toLocaleString(lang), ...vars };

    if (s && typeof s === 'object')
    {
        const form = s[plural.select(n)] ?? s.other;

        if (form)
            return fill(form, v);
    }

    return fill(fallback(n === 1 ? one : other), v);
}

/**
 * A text marked for translation without translating it here: lists of constants read before the language could
 * matter, translated where they are shown with tr(text). Returns the text as it is.
 */
export function trm<T extends string>(text: T): T
{
    return text;
}
