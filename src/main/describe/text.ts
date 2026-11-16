/**
 * Helpers that turn script identifiers and localization data functions into readable text.
 */
import type { BracketLink, Rich, RichSeg } from '../../shared/api.ts';

import { locale, tr } from '../../shared/i18n.ts';
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

    return english() ? withoutRepeats(withArticles(out)) : out;
}

/** English text: a/an before an entry's name is chosen by its first sound ("a Indebted" → "an Indebted"). */
function english(): boolean
{
    return locale() === 'en';
}

const AN_AFTER_VOWEL = /^[aeiou]/i;
// (a vowel letter that sounds like a consonant, a silent h)
const A_BEFORE_VOWEL = /^(uni|use|usu|uti|uto|ukr|ubi|eu|one|once|ur[aeiu])/i;
const AN_BEFORE_CONSONANT = /^(hour|honou?r|heir|honest)/i;

/** The concept words a name the script supplies is followed by or preceded by again ("Mending Faith" + "Faith", "House" + "House Yamato"). */
const CONCEPT_WORDS = 'Building|Law|Title|House|Culture|Gold|Faith|Regiment|Dynasty|Religion|County|Duchy|Kingdom|Empire|Province|Rite|Tradition';
const REPEATED_WORD = /\b(Building|Law|Title|House|Culture|Gold|Faith|Regiment|Dynasty|Religion|County|Duchy|Kingdom|Empire|Province|Rite|Tradition) \1\b/g;

const CONCEPT_SET = new Set(CONCEPT_WORDS.split('|'));

/** the last word of a segment's text (an image has none) */
const lastOf = (r: RichSeg | undefined): string | undefined => (r === undefined || (typeof r !== 'string' && r.kind === 'image') ? undefined : (typeof r === 'string' ? r : r.text).trim().split(/\s+/).pop());

/** A name followed by its own last word again ("Major Gold" + " Gold to …": a value named for the thing it counts; "Mending Faith" + " " + the concept "Faith"): the repeat is dropped. */
function withoutRepeats(out: Rich): Rich
{
    for (let i = 0; i < out.length; i++)
    {
        const t = out[i];
        const prev = out[i - 1];

        if (typeof t === 'string')
        {
            // (a plain text: the same concept word twice)
            const same = t.replace(REPEATED_WORD, '$1');

            if (same !== t)
                out[i] = same;

            // (a name, then its last word as text)
            const word = /^\s+([A-Za-z]{3,})(?![A-Za-z])/.exec(out[i] as string);
            const last = prev !== undefined && typeof prev !== 'string' ? lastOf(prev) : undefined;

            // (only a repeat written as a name or concept: "Hit" + " hit points" keeps its word)
            if (word && last && word[1].toLowerCase() === last.toLowerCase() && /^[A-Z]/.test(word[1]))
            {
                const rest = (out[i] as string).slice(word[0].length);

                if (rest)
                    out[i] = rest;
                else
                    out.splice(i--, 1);
            }

            // (a text ending in the first word of the name that follows: "House " + "House Yamato")
            const next = out[i + 1];
            const end = /(?:^|\s)([A-Za-z]{3,}) $/.exec(out[i] as string);

            if (end && next !== undefined && typeof next !== 'string' && next.kind !== 'image' && CONCEPT_SET.has(end[1]) && (next.text === end[1] || next.text.startsWith(end[1] + ' ')))
                out[i] = (out[i] as string).slice(0, -end[1].length - 1);

            continue;
        }

        // (the concept word, a space, the name that starts with it: [house|E] [house_yamato.GetBaseName])
        const after = out[i + 2];

        if (/^\[\w+\|E\]$/.test(t.tip ?? '') && out[i + 1] === ' ' && after !== undefined && typeof after !== 'string' && after.kind !== 'image' && after.text.startsWith(t.text + ' '))
        {
            out.splice(i, 2);
            i--;
            continue;
        }

        // (a name, a space, the concept word again: [FAITH.GetName] [faith|E])
        if (/^\[\w+\|E\]$/.test(t.tip ?? '') && prev === ' ' && i >= 2)
        {
            const last = lastOf(out[i - 2]);

            if (last && last.toLowerCase() === t.text.toLowerCase())
            {
                out.splice(i - 1, 2);
                i -= 2;
            }
        }
    }

    return out;
}

/** Whether "an" goes before the word (by its first sound); an acronym (MAA, AI) is left as the script has it. */
function takesAn(word: string): boolean
{
    return AN_BEFORE_CONSONANT.test(word) || (AN_AFTER_VOWEL.test(word) && !A_BEFORE_VOWEL.test(word));
}

function withArticles(out: Rich): Rich
{
    for (let i = 0; i < out.length; i++)
    {
        const t = out[i];

        if (typeof t !== 'string')
            continue;

        // (a plain text: a Capitalized word after the article, "in a Adventurer Invasion")
        out[i] = t.replace(/(^|[\s(])([Aa])n? (?=[A-Z][a-z])(\w+)/g, (_m, pre: string, a: string, w: string) => `${pre}${a}${takesAn(w) ? 'n' : ''} ${w}`);
        const next = out[i + 1];

        if (next === undefined || typeof next === 'string' || next.kind === 'image' || !/(^|[\s(])[Aa]n? $/.test(out[i] as string))
            continue;

        // (a number first: how it is read is not known here, the article stays)
        if (/^\s*\d/.test(next.text))
            continue;

        const word = next.text.trimStart().replace(/^[^A-Za-z]+/, '');

        if (!word || /^[A-Z]{2,}/.test(word))
            continue;

        out[i] = (out[i] as string).replace(/([Aa])n? $/, (_m, a: string) => a + (takesAn(word) ? 'n ' : ' '));
    }

    return out;
}

export function richToString(r: Rich): string
{
    // (a picture as its value as written, not its path)
    return r.map((s) => (typeof s === 'string' ? s : s.kind === 'image' ? (s.tip ?? '') : s.text)).join('');
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
    'Goddess',
    'Lass',
    'Wench',
    'Sow',
    'Mare',
    'Hag',
    'Crone',
    'Bride',
    'Nun',
    'Abbess'
]);

/** `SCOPE.sC('liege')` is one scope segment (a saved scope): it becomes the plain name before the call arguments are dropped. */
function collapseScopes(chain: string): string
{
    return chain.replace(/SCOPE\.sC\(\s*'(\w+)'\s*\)/g, '$1');
}

/** Scope part of a data function (`position_holder` in `[position_holder.GetName]`) → readable label. */
function scopePart(seg: string): string
{
    if (/^root$/i.test(seg) || seg === 'GetPlayer')
        return 'you';

    // (THIS in a tooltip: whoever the text is about, not a name "This")
    if (seg === 'THIS')
        return tr('this one');

    const sc = /^SCOPE\.sC\('(\w+)'\)$/.exec(seg);

    // (a saved scope's name without its "_scope": `holder_scope` "Holder", not "Holder Scope")
    const name = (s: string): string => titleCase(humanize(s.replace(/(?<=\w)_scope$/i, '')));

    if (sc)
        return name(sc[1]);

    return name(seg);
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
    // a glossary term (1.20): `Glossary('Visible text','KEY')` shows its text, the key's text on hover
    const glossary = /^\s*Glossary\(\s*'((?:[^'\\]|\\.)*)'/.exec(e);

    if (glossary)
        return glossary[1];

    // (a date the game works out, `GetCurrentDateWithDiff( GetVarTimeRemaining( … ) )`: "a date", not its arguments)
    if (/^\s*(?:\w+\.)*GetCurrentDate(?:WithDiff)?\b/.test(e))
        return tr('a date');

    // resolved database objects: GetTrait('brave').GetName, GetCourtPositionType('x').GetName(): the last one named in a
    // chain (GetSituationType('x').GetPhaseType('y').GetName: the phase); other getters by the entry's own texts:
    // GetFaithByKey('catholic').GetAdjective → its `_adj`, GetAdherentName(Plural) → `_adherent(_plural)`
    // (the getter after each one read on its own: in a chain it is the next one's start)
    const quotes = [...e.matchAll(/Get\w+\(\s*'([\w.]+)'\s*\)/g)];
    const quoted = quotes[quotes.length - 1];

    if (quoted)
    {
        const acc = /^\.(\w+)/.exec(e.slice(quoted.index + quoted[0].length))?.[1] ?? '';

        // (an icon of the game's text: nothing to read; GetNameWithIcon is the name, its icon left out)
        if (/Icon$/.test(acc) && !/Name/.test(acc))
            return '';

        // GetReligionFamily('rf_abrahamic').GetReligions: the list of a family's religions (the game fills the list in)
        if (acc === 'GetReligions' && /GetReligionFamily\(/.test(quoted[0]))
            return tr('the religions of the {name} family', { name: lookup(quoted[1]) ?? capitalize(humanize(quoted[1].replace(/^rf_/, ''))) });

        const suffix = /AdherentNamePlural/.test(acc) ? '_adherent_plural' : /AdherentName/.test(acc) ? '_adherent' : /Adjective/.test(acc) ? '_adj' : undefined;
        const named = !acc || /Name/.test(acc);
        const d = suffix ? (lookup(quoted[1] + suffix) ?? lookup(quoted[1])) : named ? lookup(quoted[1]) : undefined;

        if (d)
            return d;

        // (a name the index can't look up (a situation's phase): its key made readable, not the code's words)
        if (named)
            return capitalize(humanize(quoted[1]));
    }

    // level names of a currency: GetPietyLevelName('(int32)3') → "Piety level 3"
    const level = /Get(\w+?)LevelName\(\s*'\(int32\)([^']*)'/.exec(e);

    if (level)
        return tr('{capitalize} level{value}', { capitalize: capitalize(humanize(level[1].replace(/([a-z])([A-Z])/g, '$1_$2'))), value: /^\d+$/.test(level[2]) ? ' ' + level[2] : '' });

    // pronoun helpers (a gendered word for the character, or "you" for the player): "they" / "their" / "them" fit both:
    // CharYouSheHe, CharYouThey, CharYourHerHis, CharYourHerHimself, CharYoursHerHis, CharYouHerHim, CharMeHerHim, CharMyFirstNames …
    const pronoun = /^\s*Char(?:You|Your|Yours|My|Me)((?:Herself|Himself|Hers|Her|His|Him|She|He|Their|They|Them|Theirs|Themselves)+)\(/.exec(e);

    if (pronoun)
        return pronounWord(pronoun[1], /^\s*CharYours/.test(e));

    if (/^\s*CharMyFirstNames\(/.test(e))
        return tr('their');

    // (CharDontDoesnt: the verb with its apostrophe)
    if (/^\s*CharDontDoesnt\(/.test(e))
        return tr("doesn't");

    // verb helpers: CharHaveHas(actor) → "has", CharBecomeBecomes(x) → "becomes"
    const verb = /^\s*Char[A-Z][a-z]+([A-Z][a-z]+)\(/.exec(e);

    if (verb)
        return verb[1].toLowerCase();

    // a word chosen by a condition (Select_CString): read where the readable view can tell which (selectWord)
    const chosen = /^\s*Select_CString\(/.test(e) ? selectWord(e, lookup) : undefined;

    if (chosen !== undefined)
        return chosen;

    // text functions that add an optional piece the game fills in when it applies (an ordinal before a name, a line, a
    // localization, a text by a condition): nothing readable stands for them
    if (/^\s*(Select(Localization|LocalizationKey|_CString)|ConcatIfNeitherEmpty|AddLocalizationIf|AddTextIf|AddLine)\(/.test(e))
        return '';

    const custom = /Custom2?\(\s*'(\w+)'/.exec(e);

    if (custom)
        return humanizeCustom(e.slice(0, custom.index), custom[1]);

    // (a number the game works out: "N", not the value's name; the readable view links it, its number when constant:
    // GameIndex.bracketRef)
    if (/ScriptValue\(\s*'(\w+)'/.test(e))
        return tr('N');

    // (a saved scope, SCOPE.sC('x'), is one segment: kept as its name; a variable, `.Var('melee_winner')`, too:
    // "Activity’s “melee winner”", getterWords)
    e = collapseScopes(e).replace(/\b(?:Var|GetVariable)\(\s*'(\w+)'\s*\)/g, 'VAR__$1');

    // drop call arguments (innermost first, so nested calls like GetCurrentDateWithDiff( GetVarTimeRemaining( … ) ) go too)
    for (let before = ''; before !== e;)
    {
        before = e;
        e = e.replace(/\(\s*[^()]*\)/g, '');
    }

    const parts = e.split('.').filter((p) => p && p !== 'Char' && p !== 'Self');

    if (parts.length === 0)
        return expr;

    const last = parts[parts.length - 1];
    const scope = parts.length > 1 ? scopePart(parts[0]) : 'they';

    // gendered getters: GetHerHis → her/his
    const words = last.replace(/^Get/, '').match(/[A-Z][a-z]+/g) ?? [];

    if (words.length === 2 && FEMALE_WORDS.has(words[0]))
        return `${words[0].toLowerCase()}/${words[1].toLowerCase()}`;

    // (a faith's god's pronoun, `GetFaith.CreatorHerHis`, `HighGodSheHe`: the pair, "her/his", not "creator her his")
    const pair = /(Her|She|Hers|Herself)(His|He|Him|Himself)$/.exec(last);

    if (pair && words.length > 2)
        return `${pair[1].toLowerCase()}/${pair[2].toLowerCase()}`;

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

    // (a name getter at the end of a chain names what the chain leads to: "Sieging Location’s title", not its function)
    const named = NAME_GETTER.test(last);
    // (each link of the chain its own, "your faith’s high god", not "your faith high god name")
    const middle = parts
        .slice(1, named ? -1 : undefined)
        .map(getterWords)
        .filter((p) => p && p !== 'name')
        // (a link that names what the one before already is: “pilgrimage badge province” then `GetProvince`)
        .filter((p, i, all) => !i || !all[i - 1].replace(/”$/, '').endsWith(' ' + p))
        .join('’s ')
        .replace(/’s’s /g, '’s ')
        .replace(/’s adjective$/, ' adjective');
    const poss = named && /Possessive/.test(last) ? '’s' : '';
    return (scope === 'you' ? tr('your {middle}', { middle }) : `${scope}’s ${middle}`) + poss;
}

/**
 * A getter of a data chain in words: `HighGodName` "high god", `HighGodNamePossessive` "high god’s",
 * `HighGodNameAlternate` "high god (another name)", `GetNameRegnal` "regnal name", `GetDeathReason` "death reason".
 */
function getterWords(p: string): string
{
    const g = p.replace(/^Get(?=[A-Z])/, '').replace(/NoTooltip$/, '');
    const variable = /^VAR__(\w+)$/.exec(p);

    if (variable)
        return `“${humanize(variable[1])}”`;

    // (the chain's plumbing, no word of its own: `MakeScope`, `Var('x')`, `ScriptValue`)
    if (/^(MakeScope|Var|GlobalVar|LocalVar|Scope|ScriptValue)$/.test(g))
        return '';

    // (a character's title as a word, `GetTitleAsName`: "King", "Bearer of the King’s Sword")
    const asName = /^TitleAsName(?:Nicknamed|NoTier|OrMe|Regnal|NoTooltip)*(Possessive)?/.exec(g);

    if (asName)
        return asName[1] ? tr('title’s') : tr('title');

    const name = /^(\w+?)Name(Possessive)?(Alternate)?$/.exec(g);

    if (name)
        return humanize(name[1]) + (name[3] ? tr(' (another name)') : '') + (name[2] ? '’s' : '');

    if (/^Name(\w+)$/.test(g))
        return tr('{what} name', { what: humanize(g.slice(4)) });

    return humanize(g);
}

const NAME_GETTER = /^Get(Titled)?(First|Short|Full|UI|ShortUI|FullUI|Base|Birth|Barony|County|Nicknamed)?Name(NoTier|NoTooltip|Possessive|Only|Explicitly|Nicknamed)*$|^GetShortUIName|^GetUIName|^GetTitleAsNameNoTier/;

/** A call's top-level arguments (`f( a, g( b, c ), 'x, y' )` → `a`, `g( b, c )`, `'x, y'`), trimmed. */
function callArgs(call: string): string[]
{
    const open = call.indexOf('(');
    const out: string[] = [];
    let depth = 0;
    let quote = false;
    let start = open + 1;

    for (let i = open + 1; i < call.length; i++)
    {
        const c = call[i];

        if (c === "'")
            quote = !quote;
        else if (quote)
            continue;
        else if (c === '(')
            depth++;
        else if (c === ')' && depth-- === 0)
        {
            out.push(call.slice(start, i).trim());
            break;
        }
        else if (c === ',' && depth === 0)
        {
            out.push(call.slice(start, i).trim());
            start = i + 1;
        }
    }

    return out;
}

/** first-person words of a "the player" branch, said to the reader instead (the readable view's root is "you") */
const TO_YOU: Record<string, string> = { i: 'you', me: 'you', my: 'your', mine: 'yours', myself: 'yourself', am: 'are' };

/**
 * `Select_CString( condition, a, b )`, a word the game picks by a condition, read where the readable view can tell
 * which (docs/readable-view.md): on `X.IsLocalPlayer` the other branch, as the view names characters by their role
 * ("As Imprisoner has a fair reason", not "As  a fair reason"), and for the root ("you") the player's branch with its
 * first-person words said to the reader ("you have"); two words otherwise ("woman/man" by IsFemale, as the gendered
 * getters read). Undefined: nothing readable (an optional piece with an empty branch, icons, two data paths by another
 * condition): the caller reads it as nothing.
 */
function selectWord(e: string, lookup: (key: string) => string | undefined): string | undefined
{
    const [cond, a, b] = callArgs(e);

    if (cond === undefined || a === undefined || b === undefined)
        return undefined;

    const literal = (x: string): string | undefined => /^'((?:[^'\\]|\\.)*)'$/.exec(x)?.[1];
    const read = (x: string, you: boolean): string | undefined =>
    {
        const l = literal(x);

        if (l === undefined)
            return humanizeExpr(x, lookup) || undefined;

        // (an icon or a line break: nothing to read)
        if (!l.trim() || /^@\w+!$/.test(l.trim()) || l.includes('\\n'))
            return undefined;

        return you ? l.replace(/\b(I|me|my|mine|myself|am)\b/gi, (w) => TO_YOU[w.toLowerCase()]) : l;
    };
    const player = /^(.*)\.IsLocalPlayer$/.exec(cond.replace(/\s+/g, ''));

    if (player)
    {
        const subject = player[1].split('.').filter((p) => p && p !== 'Char' && p !== 'Self');
        const root = subject.length === 1 && scopePart(subject[0]) === 'you';
        return root ? read(a, true) : read(b, false);
    }

    const la = literal(a);
    const lb = literal(b);

    if (la?.trim() && lb?.trim() && !/[@\\]/.test(la + lb))
        return `${la.trim()}/${lb.trim()}`;

    return undefined;
}

const PRONOUN = '(?:Herself|Himself|Hers|Her|His|Him|She|He|Their|They|Them|Theirs|Themselves)';

/** The neutral word for a run of pronouns ("SheHe" → they, "HerHim" → them, "HerHis" → their, "HerselfHimself" → themselves). */
function pronounWord(words: string, yours = false): string
{
    if (/self|Themselves/.test(words))
        return tr('themselves');

    // (a lone object form is "them")
    if (words === 'Her')
        return tr('them');

    if (yours || /Hers|Theirs/.test(words))
        return tr('theirs');

    if (/Him|Them/.test(words))
        return tr('them');

    if (/His|Their/.test(words))
        return tr('their');

    return tr('they');
}

/**
 * `Custom('Name')` / `Custom2('Name', …)`: a customizable localization of the game or a mod. Pronoun-shaped names
 * (GetDragonSheHe, CatStoryHerHis, …All, …Opposite) read as the neutral word, name functions as the scope they name,
 * other names as the scope's … and the name made readable. `before` is the chain before the call.
 */
function humanizeCustom(before: string, name: string): string
{
    const key = name.replace(/NoTooltip/g, '');
    const pron = new RegExp(`(${PRONOUN}{1,2})(?:All|Opposite)?$`).exec(key);

    // (the word before it must end the name's own words: "Hero" is not "He")
    if (pron && pron.index > 0)
        return pronounWord(pron[1]);

    // (a gendered word pair the game picks by the character's sex, `GetDaughterSon`, `QueenKing`: both words, as the
    // gendered getters read, "daughter/son"; not "Child's get daughter son")
    const bare = key.replace(/^Get(?=[A-Z])/, '');
    const pair = bare.match(/[A-Z][a-z]+/g) ?? [];

    if (pair.length === 2 && pair.join('') === bare && FEMALE_WORDS.has(pair[0]))
        return `${pair[0].toLowerCase()}/${pair[1].toLowerCase()}`;

    let pre = collapseScopes(before.replace(/\.$/, ''));

    for (let prev = ''; prev !== pre;)
    {
        prev = pre;
        pre = pre.replace(/\(\s*[^()]*\)/g, '');
    }

    const parts = pre.split('.').filter((p) => p && p !== 'Char' && p !== 'Self');
    const scope = parts.length ? scopePart(parts[parts.length - 1].replace(/^Get(?=[A-Z])/, '')) : '';
    const poss = /Possessive$/.test(key);

    if (/UIName|Name(Possessive)?(OrMe)?$/.test(key))
    {
        const who = scope || tr('they');

        if (who === 'you')
            return poss ? tr('your') : tr('you');

        return poss ? tr('{who}’s', { who }) : who;
    }

    // (its name without the function word: "Child’s birth omen", not "Child’s get birth omen"; the readable view shows
    // the entry's own texts where they are short: GameIndex.bracketRef)
    const words = humanize(bare);
    return scope && scope !== 'you' ? tr('{who}’s {words}', { who: scope, words }) : words;
}

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
            out.push(...argsToRich(text.slice(last, b.start), false));

        // data functions naming a database object (GetTrait('brave') …) and concept links ([faith|E]) become links
        // (a link's text can hold an argument too: [Concept( 'obligations', '$NAME|q$' )|E])
        const link = resolve?.(b.inner);
        const h = link?.text !== undefined ? dropTemplateArgs(link.text, '…') : humanizeDataFunction(b.inner, lookup);
        const tip = text.slice(b.start, b.end);

        if (h)
            out.push(link ? { text: h, kind: 'entity', ref: { type: link.type, name: link.name }, tip } : { text: h, kind: 'ph', tip });

        last = b.end;

        // (one that reads as nothing (an icon, an optional piece) takes one space with it: "•  Be married" read so, and
        // "no longer  any land"; before punctuation or at the end the space before it goes)
        if (!h)
        {
            const before = b.start === 0 || /\s$/.test(text.slice(0, b.start));
            const after = text[b.end];

            if (before && after === ' ')
                last++;
            else if (b.start > 0 && text[b.start - 1] === ' ' && (after === undefined || /[.,;:!?)]/.test(after)))
            {
                const prev = out[out.length - 1];

                if (typeof prev === 'string' && prev.endsWith(' '))
                    out[out.length - 1] = prev.slice(0, -1);
            }
        }
    }

    if (last < text.length)
        out.push(...argsToRich(text.slice(last), true));

    return rich(out);
}

/** a template argument named for an amount (`$VALUE$`, `$NUM$`, `$GOLD_COST$`): read as "…" like one with a number format */
const AMOUNT_ARG = /(^|_)(VALUE|NUM|NUMBER|AMOUNT|COST|COUNT|PERCENT|CHANCE|DAYS|MONTHS|YEARS|GOLD|PRESTIGE|PIETY)$/i;

/**
 * A text's template arguments (values the game's code fills in) as placeholders that name themselves, the argument as
 * written their tip: "Gets a weak hook ($TYPE$)" reads "Gets a weak hook (Type)", not "(…)"; an amount (a number format,
 * or a name like VALUE or COST) stays "…". `end`: a label whose value is the argument at the very end loses it with its
 * colon, as dropTemplateArgs ("Followers: $NUM|V0$" → "Followers").
 */
function argsToRich(text: string, end: boolean): Rich
{
    const t = end ? text.replace(/\s*:\s*\$[A-Za-z_]\w*(?:\|[^$\s]*)?\$\s*$/, '') : text;
    const out: Rich = [];
    let last = 0;

    for (const m of t.matchAll(/\$([A-Za-z_]\w*)(\|[^$\s]*)?\$/g))
    {
        if (m.index > last)
            out.push(t.slice(last, m.index));

        // (an amount the code fills in, written with a number format or named for one ("Cost: $COST|0$ gold"): "…", as
        // before; a name ($TYPE$, $EVENT_NAME$) names itself)
        out.push(m[2] || AMOUNT_ARG.test(m[1]) ? '…' : { text: titleCase(humanize(m[1])), kind: 'ph', tip: m[0] });
        last = m.index + m[0].length;
    }

    if (last < t.length)
        out.push(t.slice(last));

    return out;
}

/**
 * The template arguments a text leaves (`$NUM|V0$`, `$EXTORTIONATE_RANSOM_COST|0$`, `$OldBuildingName$`: values the
 * game's code fills in; the $key$ references are resolved before): replaced by `instead`.
 */
export function dropTemplateArgs(text: string, instead: string, end = true): string
{
    // ("Number of County Followers: $NUM|V0$": a label whose value is the argument loses the colon too, only at the
    // end of the whole text: before a [bracket] the colon and the space stay, "[levies|E]: $VALUE|0V$ [soldiers|E]")
    const label = end ? text.replace(/\s*:\s*\$[A-Za-z_]\w*(?:\|[^$\s]*)?\$\s*$/, '') : text;
    return label.replace(/\$[A-Za-z_]\w*(?:\|[^$\s]*)?\$/g, instead);
}

/**
 * A name the script gave a template with the concept word the template adds after it ("Remove the [LAW.GetName] [law|E]" with
 * a saved scope "Old Law": "Old Law Law"), and a "the" before a name that starts with its own: the repeated word is dropped.
 */
export function dropRepeats(parts: Rich): Rich
{
    const out: Rich = [];

    for (let i = 0; i < parts.length; i++)
    {
        const p = parts[i];
        const prev = out[out.length - 1];

        // (name, a space, the concept word again)
        if (typeof p !== 'string' && /^\[\w+\|E\]$/.test(p.tip ?? '') && prev === ' ' && out.length >= 2)
        {
            const before = out[out.length - 2];
            const last = typeof before === 'string' ? before.trim().split(/\s+/).pop() : before.text.trim().split(/\s+/).pop();

            if (last && last.toLowerCase() === p.text.toLowerCase())
            {
                out.pop();
                continue;
            }
        }

        // ("the " + "The Savior")
        if (typeof p !== 'string' && typeof prev === 'string' && /(^|\s)the $/i.test(prev) && /^the\s/i.test(p.text))
            out[out.length - 1] = prev.replace(/the $/i, '');

        out.push(p);
    }

    return out;
}
