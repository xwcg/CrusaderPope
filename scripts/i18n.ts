// The app's texts and their translation (docs/localization.md): finds the user-visible English texts in the code,
// wraps them in tr() (shared/i18n.ts), lists what is left, and writes the catalog template.
//
// Usage: node --experimental-strip-types --no-warnings scripts/i18n.ts <mode> [paths…]
//   wrap [--dry] [--labels] <paths…>  (--labels: single-word labels by their place, labelEditsOf) wraps the texts found in those files / folders (JSX text, UI attributes and properties,
//                           prose literals and templates) in tr('…', { vars }), adds the import; runs to a fixpoint
//   check [--list] [--maybe] the texts not wrapped yet, per file (--list: each one); exit 1 when there are any;
//                           --maybe: single capitalised words in other places too (table labels: "Added") to look at
//   extract                 every tr / trc / trn / trm text → src/shared/locales/template.json; per catalog what it
//                           lacks and what it has that the code no longer uses
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const I18N = join(ROOT, 'src/shared/i18n.ts');
const FNS = new Set(['tr', 'trc', 'trn', 'trm']);

/** attributes of JSX elements that are text for the user */
const UI_ATTRS = new Set(['title', 'placeholder', 'label', 'aria-label', 'alt', 'text', 'hint', 'note', 'tooltip', 'message', 'why', 'caption', 'header', 'heading', 'summary', 'empty', 'confirm', 'question', 'detail', 'none', 'what', 'initial', 'kind']);
/** properties of objects whose literal values are text for the user (single words too) */
const UI_PROPS = new Set(['label', 'title', 'hint', 'note', 'text', 'placeholder', 'explain', 'why', 'message', 'summary', 'crumb', 'tooltip', 'caption', 'desc', 'description', 'help', 'heading', 'header', 'warn', 'row', 'question', 'detail', 'details', 'empty', 'confirm', 'typeLabel', 'about', 'subtitle', 'unit', 'verb', 'what', 'labelText', 'none', 'ask']);
/** properties whose values are data (names, keys, paths, script), never translated */
const DATA_PROPS = new Set(['name', 'id', 'key', 'type', 'kind', 'className', 'class', 'path', 'file', 'rel', 'abs', 'effect', 'shader', 'op', 'mode', 'role', 'value', 'src', 'href', 'url', 'icon', 'image', 'color', 'k', 'v', 'ext', 'dir', 'scope', 'tag', 'group', 'field', 'lang', 'code', 'style', 'css', 'script', 'snippet', 'template', 'prefix', 'suffix', 'match', 'channel', 'event', 'loc', 'locKey', 'raw', 'sql', 'query', 'pattern', 'font', 'format']);
/** elements whose content is code or a picture, not text */
const CODE_TAGS = new Set(['code', 'kbd', 'pre', 'ScriptText', 'GameImg', 'CoatOfArms', 'style', 'script']);
/** callees whose string arguments are never text for the user */
const SKIP_CALLS = new Set([
    'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'split', 'replace', 'replaceAll', 'match', 'matchAll', 'test', 'exec', 'search',
    'get', 'has', 'set', 'delete', 'add', 'querySelector', 'querySelectorAll', 'getElementById', 'closest', 'matches', 'addEventListener', 'removeEventListener',
    'require', 'import', 'postMessage', 'send', 'invoke', 'handle', 'on', 'once', 'off', 'emit', 'getItem', 'setItem', 'removeItem', 'RegExp',
    'join', 'resolve', 'dirname', 'basename', 'extname', 'readFileSync', 'writeFileSync', 'appendFileSync', 'existsSync', 'mkdirSync', 'statSync',
    'readdirSync', 'logShader', 'timing', 'createElement', 'setAttribute', 'getAttribute', 'removeAttribute', 'toggle', 'contains', 'fetch', 'URL',
    'getPropertyValue', 'setProperty', 'localeCompare', 'padStart', 'padEnd', 'normalize', 'Symbol', 'call', 'query', 'list', 'detail', 'tooltip',
    'getContext', 'getExtension', 'getUniformLocation', 'getAttribLocation', 'defineProperty', 'measureText', 'font', 'trc', 'trn', 'tr', 'trm'
]);

/** names that are Map / Set / DOM methods when called on something, but a file's own helper when called plainly: set('At least 2', …) */
const LOCAL_HELPERS = new Set(['set', 'add', 'tooltip', 'detail', 'toggle']);

// ---------------------------------------------------------------------------
// What is text
// ---------------------------------------------------------------------------

/**
 * Text for the user: letters, not code (paths, script, keys, markup). `ui`: in a place that only holds text; `jsx`:
 * JSX text (always shown, a single lower-case word too: "loaded").
 */
function isProse(s: string, ui: boolean, jsx = false): boolean
{
    const x = s.replace(/\{\w+\}/g, 'X');

    // (letters of its own, not only placeholders)
    if (!/\p{L}\p{L}/u.test(s.replace(/\{\w+\}/g, ' ')))
        return false;

    // (JSX text continuing after an element or an expression starts with its punctuation: ". In Steam: …")
    const body = jsx ? x.replace(/^[.,;:!?)]+\s+/, '') : x;
    const spoken = (s: string): number => s.split(/\s+/).filter((w) => /^[("“‘]?[\p{L}’'-]+[,.;:!?…)"”’]*$/u.test(w)).length;

    // (a back-tick quotes a key in a sentence: "The `types` group it is in")
    if (/[$]|\{|\}|:\/\/|^[.#:@-]/.test(body) || (/`/.test(body) && !((ui || jsx) && spoken(body.replace(/`[^`]*`/g, '')) >= 3)))
        return false;

    // (CSS values: transforms, calc())
    if (/^(translate[XYZ3d]*|rotate|scale|matrix|calc|var|rgba?|hsla?)\(/.test(x.trim()))
        return false;

    // (names: the game's, the app's, the publisher's; paths and titles use them as they are)
    if (/^(Crusader Kings III|CrusaderPope|Paradox Interactive|rakaly)$/.test(x.trim()))
        return false;

    // (SQL: the launcher's database)
    if (/^\s*(select|insert|update|delete|create|pragma|with)\s/i.test(x) && /\b(from|into|set|table|where)\b/i.test(x))
        return false;

    // (a sentence may name a key or a path: "Writes change_development_level", "into a replace/ folder"; else
    // underscores, file names and slashes are code; a slash between spaced words is prose: "and / or")
    const words = spoken(x);
    // (in JSX text a key in parentheses is part of a sentence: "Game moment (on_action)"; a single slash between words
    // too: "Hide flags/variables"; a path has two or begins with one)
    const noParens = jsx ? x.replace(/\([^()]*\)/g, '()') : x;
    const slashCode = jsx ? /^\s*\/|\/.*\/|\/\s*$/.test(x) : /\S\/|\/\S/.test(x);

    if (words < 4 && (/[=<>\\]|\w_\w|\.(dds|png|txt|gui|ts|tsx|js|json|mod|yml|csv|mesh|asset|anim)\b/.test(noParens) || slashCode))
        return false;

    if (jsx)
        return true;

    // (CSS, fonts, colours, shader and script code)
    if (/;\S|;\s*$|^(rgba?|hsla?)\(|[\dX](px|em|rem|vh|vw)\b|\b(sans-serif|serif|monospace)\b|\b(uniform|varying|vec[234]|sampler2D)\b/.test(x))
        return false;

    // (all lower case and one word: a key, a class, an id, but a piece of a sentence, spaced, in a text place: ' with ')
    if (/^[\p{Ll}\d-]+$/u.test(x.trim()) && !(ui && /^\s|\s$/.test(x)))
        return false;

    if (ui)
        return true;

    return /\p{L}[\p{L},.;:!?)'’”"]* +[\p{L}("“'‘X]/u.test(x) || /…$/.test(x.trim());
}

/** The name of a call's callee (`a.b.c(` → c). */
function calleeName(e: ts.Expression): string | undefined
{
    if (ts.isIdentifier(e))
        return e.text;

    if (ts.isPropertyAccessExpression(e))
        return e.name.text;

    return undefined;
}

function tagName(n: ts.JsxOpeningLikeElement): string
{
    return n.tagName.getText();
}

/**
 * Whether a string literal / template at this place is text for the user: 'ui' (a UI property or attribute, single
 * words too), 'prose' (a general place: prose only), or false (code: comparisons, keys, calls that take keys …).
 */
function placeOf(node: ts.Node): 'ui' | 'prose' | false
{
    let n: ts.Node = node;
    let p = n.parent;

    // (through parentheses, conditionals, ??, ||, as, arrays and spreads: the place is the outer one's)
    while (p && (ts.isParenthesizedExpression(p) || (ts.isConditionalExpression(p) && p.condition !== n) || (ts.isBinaryExpression(p) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(p.operatorToken.kind) && (p.right === n || p.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isArrayLiteralExpression(p) || ts.isNonNullExpression(p) || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken)))
    {
        // (an array whose method takes keys: ['Shift', 'Alt'].includes(k))
        if (ts.isArrayLiteralExpression(p) && ts.isPropertyAccessExpression(p.parent) && SKIP_CALLS.has(p.parent.name.text))
        {
            // (lines of a tooltip: ['…', '…'].join('\n'))
            const call = p.parent.parent;

            if (p.parent.name.text === 'join' && ts.isCallExpression(call) && call.arguments.length === 1 && (ts.isStringLiteral(call.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(call.arguments[0])) && /^(\n| |\n\n)$/.test(call.arguments[0].text))
            {
                n = call;
                p = call.parent;
                continue;
            }

            return false;
        }

        n = p;
        p = p.parent;
    }

    if (!p)
        return false;

    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p) || ts.isCaseClause(p) || ts.isEnumMember(p) || ts.isTaggedTemplateExpression(p) || ts.isElementAccessExpression(p) || ts.isComputedPropertyName(p) || ts.isTypeOfExpression(p))
        return false;

    if (ts.isBinaryExpression(p))
    {
        const k = p.operatorToken.kind;

        if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken].includes(k))
            return false;

        // (assigned to a UI property: el.title = '…')
        if (k === ts.SyntaxKind.EqualsToken && p.right === n && ts.isPropertyAccessExpression(p.left))
            return UI_PROPS.has(p.left.name.text) || ['textContent', 'innerText', 'placeholder'].includes(p.left.name.text) ? 'ui' : 'prose';

        // (+ concatenation: the parts as prose)
        return k === ts.SyntaxKind.PlusToken ? 'prose' : false;
    }

    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(n as ts.Expression))
    {
        const name = calleeName(p.expression);

        if (name && SKIP_CALLS.has(name) && !(ts.isIdentifier(p.expression) && LOCAL_HELPERS.has(name)))
            return false;

        // (the readable view's sentence pieces: rich('If ', x, ' is ', y))
        if (name === 'rich')
            return 'ui';

        // console.*
        if (ts.isPropertyAccessExpression(p.expression) && ts.isIdentifier(p.expression.expression) && ['console', 'path', 'JSON', 'Object', 'Reflect', 'document', 'window', 'process', 'ipcRenderer', 'ipcMain', 'api', 'Math', 'Number', 'String'].includes(p.expression.expression.text))
            return false;

        return 'prose';
    }

    if (ts.isPropertyAssignment(p))
    {
        if (p.name === n)
            return false;

        const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : '';
        return UI_PROPS.has(key) ? 'ui' : DATA_PROPS.has(key) ? false : 'prose';
    }

    if (ts.isJsxAttribute(p) || (ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent)))
    {
        const a = (ts.isJsxAttribute(p) ? p : (p.parent as ts.JsxAttribute));
        const el = a.parent.parent as ts.JsxOpeningLikeElement;
        return UI_ATTRS.has(a.name.getText()) && !CODE_TAGS.has(tagName(el)) ? 'ui' : false;
    }

    // a JSX child expression: {cond ? 'Loading…' : 'Done'}
    if (ts.isJsxExpression(p))
        return inCode(p) ? false : 'ui';

    if (ts.isReturnStatement(p) || ts.isArrowFunction(p) || ts.isVariableDeclaration(p) || ts.isTemplateSpan(p) || ts.isShorthandPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isSpreadElement(p) || ts.isThrowStatement(p) || ts.isExpressionStatement(p))
        return ts.isVariableDeclaration(p) && p.name === n ? false : 'prose';

    return false;
}

/** Inside an element whose content is code. */
function inCode(n: ts.Node): boolean
{
    for (let p: ts.Node | undefined = n; p; p = p.parent)
        if ((ts.isJsxElement(p) && CODE_TAGS.has(tagName(p.openingElement))) || ts.isJsxSelfClosingElement(p) && CODE_TAGS.has(tagName(p)))
            return true;

    return false;
}

/** The text of a tr() call already (its first argument; trc's and trn's first two); its vars are looked at. */
function inWrapped(n: ts.Node): boolean
{
    const p = n.parent;

    if (!p || !ts.isCallExpression(p) || !FNS.has(calleeName(p.expression) ?? ''))
        return false;

    const i = p.arguments.indexOf(n as ts.Expression);
    return i === 0 || (i === 1 && calleeName(p.expression) !== 'tr');
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

interface Edit
{
    start: number;
    end: number;
    text: string;
    /** the text (for check / reports) */
    key: string;
    line: number;
}

const quote = (s: string): string => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n') + "'";

/** Names placeholders after their expressions (an identifier, a property, a call), unique in the text. */
class Vars
{
    private names = new Map<string, string>();
    private used = new Set<string>();
    readonly list: [string, string][] = [];

    of(expr: ts.Expression, sf: ts.SourceFile): string
    {
        const src = expr.getText(sf);
        let name = this.names.get(src);

        if (name)
            return name;

        let e: ts.Expression = expr;

        while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e))
            e = e.expression;

        let base = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : ts.isCallExpression(e) ? (calleeName(e.expression) ?? 'value') : ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression) ? e.expression.text : 'value';

        if (!/^[A-Za-z_]\w*$/.test(base) || FNS.has(base))
            base = 'value';

        name = base;

        for (let i = 2; this.used.has(name); i++)
            name = base + i;

        this.used.add(name);
        this.names.set(src, name);
        this.list.push([name, src]);
        return name;
    }

    /** `{ a, b: x.y }` or nothing */
    object(): string
    {
        return this.list.length ? `, { ${this.list.map(([k, v]) => (k === v ? k : `${k}: ${v}`)).join(', ')} }` : '';
    }
}

/** A template literal as a text with placeholders and its vars; null when it has none of text. */
function templateText(node: ts.TemplateExpression, sf: ts.SourceFile): { text: string; vars: Vars; } | null
{
    const vars = new Vars();
    let text = node.head.text;

    for (const span of node.templateSpans)
        text += '{' + vars.of(span.expression, sf) + '}' + span.literal.text;

    return { text, vars };
}

/** React's whitespace rule for JSX text: lines trimmed, empty ones dropped, the rest joined by a space. */
function jsxTextValue(raw: string): string
{
    const lines = raw.split(/\r\n|\n|\r/);
    let last = 0;

    lines.forEach((l, i) =>
    {
        if (/[^ \t]/.test(l))
            last = i;
    });

    let out = '';

    lines.forEach((line, i) =>
    {
        let s = line.replace(/\t/g, ' ');

        if (i !== 0)
            s = s.replace(/^[ ]+/, '');

        if (i !== lines.length - 1)
            s = s.replace(/[ ]+$/, '');

        if (s)
        {
            if (i !== last)
                s += ' ';

            out += s;
        }
    });

    return out.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&hellip;/g, '…').replace(/&middot;/g, '·');
}

/** An expression a text can take as a placeholder: a string or number (React shows it as such), no JSX in it. */
function textual(e: ts.Expression, checker: ts.TypeChecker): boolean
{
    let jsx = false;
    const look = (n: ts.Node): void =>
    {
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n))
            jsx = true;
        else
            n.forEachChild(look);
    };
    look(e);

    if (jsx)
        return false;

    const type = checker.getTypeAtLocation(e);
    const parts = type.isUnion() ? type.types : [type];
    return parts.every((p) => (p.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0) && parts.some((p) => (p.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) !== 0);
}

/** calls whose argument (index; -1: the last) is a label: the picker's crumbs, the readable view's section titles */
const LABEL_ARGS: Record<string, number[]> = {
    go: [-1], partOr: [-1], partDo: [-1], put: [-1], settings: [0], section: [0], addSection: [1], sectionOf: [0],
    // the change bar's text (what was done) and a file dialog's title
    runScriptEdit: [1], pickImage: [0],
    // the field catalogs' helpers (shared/fields): flag / bool (key, label, yes, no), num / entry / pick (key, label, …), text (type, key, label)
    flag: [1, 2, 3], bool: [1, 2, 3], num: [1], entry: [1], pick: [1], text: [2]
};
/** tables of labels (their string values are shown) */
const LABEL_TABLE = /LABEL|NAMES|VERB|CATEGOR|TITLES|HEADING|WORDS_SHOWN/i;

/**
 * `wrap --labels`: single words that are labels by where they stand: a label table's values, a crumb or section
 * title argument, beside texts wrapped already (an array or conditional with tr() in it: both sides of a comparison
 * stay alike).
 */
function labelEditsOf(sf: ts.SourceFile): Edit[]
{
    const out: Edit[] = [];
    const isTr = (e: ts.Node): boolean => ts.isCallExpression(e) && FNS.has(calleeName(e.expression) ?? '');
    const visit = (n: ts.Node): void =>
    {
        // a field's reading (`read: 'Category: $'`, `read: { yes: 'Hidden', no: 'Shown' }`: $ stands for the value)
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !inWrapped(n) && ts.isPropertyAssignment(n.parent) && n.parent.initializer === n && /\p{L}\p{L}/u.test(n.text))
        {
            const key = n.parent.name.getText(sf);
            const inRead = ts.isObjectLiteralExpression(n.parent.parent) && ts.isPropertyAssignment(n.parent.parent.parent) && n.parent.parent.parent.name.getText(sf) === 'read';

            if (key === 'read' || (inRead && (key === 'yes' || key === 'no')))
                out.push({ start: n.getStart(sf), end: n.getEnd(), text: `tr(${quote(n.text)})`, key: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
        }

        // a labelled pair: an option [value, 'Label'] or a group ['Label', [members]]
        if (ts.isArrayLiteralExpression(n) && n.elements.length === 2)
        {
            const [a, b] = n.elements;
            const str = (e: ts.Expression): e is ts.StringLiteral => ts.isStringLiteral(e) && !inWrapped(e);

            if (str(a) && str(b) && /^[a-z0-9_:.@-]+$/.test(a.text) && /^\p{Lu}/u.test(b.text) && /\p{L}\p{L}/u.test(b.text))
                out.push({ start: b.getStart(sf), end: b.getEnd(), text: `tr(${quote(b.text)})`, key: b.text, line: sf.getLineAndCharacterOfPosition(b.getStart(sf)).line + 1 });
            else if (str(a) && ts.isArrayLiteralExpression(b) && /^\p{Lu}\p{Ll}/u.test(a.text))
                out.push({ start: a.getStart(sf), end: a.getEnd(), text: `tr(${quote(a.text)})`, key: a.text, line: sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1 });
        }

        // a label parameter's default: (label = 'Mods')
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && ts.isParameter(n.parent) && n.parent.initializer === n && UI_PROPS.has(n.parent.name.getText(sf)) && /\p{L}\p{L}/u.test(n.text))
            out.push({ start: n.getStart(sf), end: n.getEnd(), text: `tr(${quote(n.text)})`, key: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });

        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !inWrapped(n) && /^\p{Lu}[\p{L}’'-]*[?…]?$/u.test(n.text))
        {
            const p = n.parent;
            let label = false;

            if (ts.isPropertyAssignment(p) && p.initializer === n && ts.isObjectLiteralExpression(p.parent))
            {
                const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : '';
                const holder = p.parent.parent;
                label = !DATA_PROPS.has(key) && ts.isVariableDeclaration(holder) && LABEL_TABLE.test(holder.name.getText(sf));
            }
            else if (ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression))
            {
                const at = p.arguments.indexOf(n as ts.Expression);
                label = (LABEL_ARGS[calleeName(p.expression) ?? ''] ?? []).some((i) => at === (i < 0 ? p.arguments.length - 1 : i));
            }
            else if (ts.isArrayLiteralExpression(p))
                label = p.elements.some(isTr);
            else if (ts.isConditionalExpression(p) && p.condition !== n)
                label = isTr(p.whenTrue) || isTr(p.whenFalse) || (ts.isConditionalExpression(p.whenFalse) && (isTr(p.whenFalse.whenTrue) || isTr(p.whenFalse.whenFalse)));

            if (label)
                out.push({ start: n.getStart(sf), end: n.getEnd(), text: `tr(${quote(n.text)})`, key: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
        }

        n.forEachChild(visit);
    };
    visit(sf);
    return out;
}

/**
 * `unwrap`: tr() calls that stand where no text for the user can (a CSS class, a style, a key, a data property)
 * back to the literal or template they were (a wrap of the first pass that went too far).
 */
function unwrapEditsOf(sf: ts.SourceFile): Edit[]
{
    const out: Edit[] = [];
    const visit = (n: ts.Node): void =>
    {
        if (ts.isCallExpression(n) && calleeName(n.expression) === 'tr' && n.arguments.length && ts.isStringLiteral(n.arguments[0]))
        {
            // where the call's value ends up: through parentheses, conditionals, +, ?? …
            let c: ts.Node = n;
            let p = c.parent;

            while (p && (ts.isParenthesizedExpression(p) || (ts.isConditionalExpression(p) && p.condition !== c) || (ts.isBinaryExpression(p) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind)) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isJsxExpression(p) && !ts.isJsxAttribute(p.parent)))
            {
                c = p;
                p = p.parent;
            }

            if (ts.isJsxExpression(p))
                p = p.parent;

            const bad = (ts.isJsxAttribute(p) && !UI_ATTRS.has(p.name.getText(sf))) ||
                (ts.isPropertyAssignment(p) && p.initializer === c && DATA_PROPS.has(p.name.getText(sf)) &&
                    // (not a placeholder's value: tr('…{value}…', { value: tr('…') }))
                    !(ts.isCallExpression(p.parent.parent) && calleeName(p.parent.parent.expression) === 'tr'));

            if (bad)
            {
                const text = (n.arguments[0] as ts.StringLiteral).text;
                const vars = n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1]) ? n.arguments[1] : undefined;
                const exprOf = (name: string): string | undefined =>
                {
                    for (const pr of vars?.properties ?? [])
                    {
                        if (ts.isPropertyAssignment(pr) && pr.name.getText(sf) === name)
                            return pr.initializer.getText(sf);

                        if (ts.isShorthandPropertyAssignment(pr) && pr.name.text === name)
                            return name;
                    }

                    return undefined;
                };
                const back = vars ? '`' + text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\{(\w+)\}/g, (m, k: string) => { const e = exprOf(k); return e ? '${' + e + '}' : m; }) + '`' : quote(text);
                out.push({ start: n.getStart(sf), end: n.getEnd(), text: back, key: text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
            }
        }

        n.forEachChild(visit);
    };
    visit(sf);
    return out;
}

/**
 * Texts the codemod cannot wrap but `check` must not miss: an English word or fragment passed as a placeholder's
 * value (tr('Used by {who}', { who: 'the game and ' }): the translator cannot reorder or translate it) and
 * placeholders named after the call they came from ({toLocaleString2}, {join}, {value}: a translator sees no meaning).
 */
function lintOf(sf: ts.SourceFile): Edit[]
{
    const out: Edit[] = [];
    const at = (n: ts.Node, key: string): void =>
    {
        out.push({ start: n.getStart(sf), end: n.getEnd(), text: '', key, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    };
    const visit = (n: ts.Node): void =>
    {
        if (ts.isCallExpression(n) && FNS.has(calleeName(n.expression) ?? '') && n.arguments.length)
        {
            const text = n.arguments.find((a) => ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) as ts.StringLiteral | undefined;

            for (const m of text?.text.matchAll(/\{(\w+)\}/g) ?? [])
            {
                // (names the codemod made from the expression it saw)
                if (/^(value|toLocaleString|toFixed|toString|toLowerCase|toUpperCase|charAt|substring|formatCount|capitalize|humanize|join|slice|length|map|replace|trim|split|concat|reduce|sort|find)\d*$/.test(m[1]))
                    at(text!, `placeholder {${m[1]}}: ${text!.text}`);
            }

            for (const a of n.arguments)
            {
                if (!ts.isObjectLiteralExpression(a))
                    continue;

                for (const pr of a.properties)
                {
                    if (!ts.isPropertyAssignment(pr) || !(ts.isStringLiteral(pr.initializer) || ts.isNoSubstitutionTemplateLiteral(pr.initializer)))
                        continue;

                    // (words and fragments; not keys, paths, ids or what the placeholder is named after)
                    const v = pr.initializer.text;

                    if (/\p{L}{2}/u.test(v) && !/[/\\_.:{}=#$@]/.test(v) && !/^(key|type|name|id|path|file|dir|folder|mod|scope|ext|code|kind|field|tag|event|effect|trigger|loc|lang|date|version|title|entry|list|want|unit|n|count)\d*$/i.test(pr.name.getText(sf)))
                        at(pr.initializer, `English as a placeholder's value: ${v}`);
                }
            }
        }

        n.forEachChild(visit);
    };
    visit(sf);
    return out;
}

/** Single capitalised words where only prose is taken (lists and tables of labels): to look at by hand. */
function maybesOf(sf: ts.SourceFile): Edit[]
{
    const out: Edit[] = [];
    const visit = (n: ts.Node): void =>
    {
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !inWrapped(n) && placeOf(n) === 'prose' && /^\p{Lu}\p{Ll}+$/u.test(n.text))
            out.push({ start: n.getStart(sf), end: n.getEnd(), text: '', key: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });

        n.forEachChild(visit);
    };
    visit(sf);
    return out;
}

/** The edits that wrap a file's texts (overlapping ones: the outer; the inner come in the next pass). */
function editsOf(sf: ts.SourceFile, checker: ts.TypeChecker | null): Edit[]
{
    const edits: Edit[] = [];
    const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

    // runs of JSX text and textual expressions among an element's children: one text with placeholders
    const children = (list: ts.NodeArray<ts.JsxChild>): void =>
    {
        let run: ts.JsxChild[] = [];
        const flush = (): void =>
        {
            // (whitespace-only text at the ends stays outside)
            while (run.length && ts.isJsxText(run[0]) && !jsxTextValue(run[0].text).trim())
                run.shift();

            while (run.length && ts.isJsxText(run[run.length - 1]) && !jsxTextValue((run[run.length - 1] as ts.JsxText).text).trim())
                run.pop();

            const texts = run.filter(ts.isJsxText).map((x) => jsxTextValue(x.text)).join('');

            if (run.length && /\p{L}\p{L}/u.test(texts))
            {
                const vars = new Vars();
                let text = '';

                for (const c of run)
                    text += ts.isJsxText(c) ? jsxTextValue(c.text) : '{' + vars.of((c as ts.JsxExpression).expression!, sf) + '}';

                // (spaces at the ends outside the text: {' '})
                const lead = /^\s+/.exec(text)?.[0] ?? '';
                const trail = /\s+$/.exec(text)?.[0] ?? '';
                const full = text.trim();
                // (punctuation continuing the sentence before an element or an expression stays outside the text: ". In Steam: …")
                const punct = ts.isJsxText(run[0]) ? (/^[.,;:!?]+(?=\s)/.exec(full)?.[0] ?? '') : '';
                const core = punct ? full.slice(punct.length).trim() : full;

                if (isProse(core, true, true))
                {
                    const start = run[0].getStart(sf);
                    const end = run[run.length - 1].getEnd();
                    edits.push({ start, end, text: `${lead ? "{' '}" : ''}${punct ? punct + "{' '}" : ''}{tr(${quote(core)}${vars.object()})}${trail ? "{' '}" : ''}`, key: core, line: lineOf(start) });
                }
            }

            run = [];
        };

        for (const c of list)
        {
            if (ts.isJsxText(c))
                run.push(c);
            else if (ts.isJsxExpression(c) && c.expression && checker && textual(c.expression, checker) && !ts.isStringLiteral(c.expression) && !ts.isConditionalExpression(c.expression))
                run.push(c);
            else
                flush();
        }

        flush();
    };

    const visit = (n: ts.Node): void =>
    {
        if (ts.isJsxElement(n) && !CODE_TAGS.has(tagName(n.openingElement)))
            children(n.children);
        else if (ts.isJsxFragment(n))
            children(n.children);

        if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer))
        {
            const el = n.parent.parent as ts.JsxOpeningLikeElement;

            if (UI_ATTRS.has(n.name.getText()) && !CODE_TAGS.has(tagName(el)) && isProse(n.initializer.text, true))
                edits.push({ start: n.initializer.getStart(sf), end: n.initializer.getEnd(), text: `{tr(${quote(n.initializer.text)})}`, key: n.initializer.text, line: lineOf(n.getStart(sf)) });
        }
        else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !ts.isJsxAttribute(n.parent) && !inWrapped(n))
        {
            const place = placeOf(n);

            if (place && isProse(n.text, place === 'ui'))
                edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `tr(${quote(n.text)})`, key: n.text, line: lineOf(n.getStart(sf)) });
        }
        else if (ts.isTemplateExpression(n) && !inWrapped(n))
        {
            const place = placeOf(n);
            const tt = place ? templateText(n, sf) : null;

            if (tt && isProse(tt.text, place === 'ui'))
                edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `tr(${quote(tt.text)}${tt.vars.object()})`, key: tt.text, line: lineOf(n.getStart(sf)) });
        }

        n.forEachChild(visit);
    };
    visit(sf);

    // outer edits win; the ones inside them are done in the next pass
    edits.sort((a, b) => a.start - b.start || b.end - a.end);
    const out: Edit[] = [];
    let reach = -1;

    for (const e of edits)
    {
        if (e.start < reach)
            continue;

        out.push(e);
        reach = e.end;
    }

    return out;
}

/** The import of tr in a file (added after its last import; the path in the file's own style). */
function withImport(text: string, file: string): string
{
    if (/import\s*\{[^}]*\btr\b[^}]*\}\s*from\s*['"][^'"]*i18n/.test(text))
        return text;

    let rel = relative(dirname(file), I18N).split(sep).join('/').replace(/\.ts$/, '');

    if (!rel.startsWith('.'))
        rel = './' + rel;

    // (main and shared write .ts in their imports; Node runs them in the checks)
    if (/from '\.[^']*\.ts'/.test(text) || /[\\/]src[\\/](main|shared)[\\/]/.test(file))
        rel += '.ts';

    const existing = /import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]*i18n(?:\.ts)?)\2;?/.exec(text);

    if (existing)
        return text.replace(existing[0], `import { ${[...existing[1].split(',').map((s) => s.trim()).filter(Boolean), 'tr'].sort().join(', ')} } from '${existing[3]}';`);

    const imports = [...text.matchAll(/^import[^;]*;\s*$/gm)];
    const at = imports.length ? imports[imports.length - 1].index! + imports[imports.length - 1][0].length : 0;
    return text.slice(0, at) + (at ? '\n' : '') + `import { tr } from '${rel}';` + (at ? '' : '\n') + text.slice(at);
}

// ---------------------------------------------------------------------------
// Files and programs
// ---------------------------------------------------------------------------

function filesUnder(p: string): string[]
{
    const abs = resolve(ROOT, p);

    if (statSync(abs).isFile())
        return [abs];

    return readdirSync(abs, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(abs, e.name)) : /\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [join(abs, e.name)] : []));
}

/** files the tool leaves alone: itself and the catalogs, the i18n module, tests and checks */
// (valueTypes.ts: generated data of script keys, no texts)
const SKIP_FILE = /[\\/](i18n\.ts|locales[\\/].*|scripts[\\/].*|preload[\\/].*|testApi\.ts|shaderErrors\.ts|shaderLog\.ts|valueTypes\.ts)$/;

function program(files: string[]): ts.Program
{
    // (the renderer's config for renderer files, else the node one)
    const web = files.some((f) => f.includes(`${sep}renderer${sep}`));
    const cfgPath = join(ROOT, web ? 'tsconfig.web.json' : 'tsconfig.node.json');
    const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
    return ts.createProgram({ rootNames: cfg.fileNames, options: cfg.options });
}

function wrap(paths: string[], dry: boolean, labels: boolean, unwrap = false): void
{
    const all = paths.flatMap(filesUnder).filter((f) => !SKIP_FILE.test(f));
    const groups = [all.filter((f) => f.includes(`${sep}renderer${sep}`)), all.filter((f) => !f.includes(`${sep}renderer${sep}`))].filter((g) => g.length);
    let total = 0;

    for (const files of groups)
    {
        for (let pass = 1; pass <= 6; pass++)
        {
            const prog = program(files);
            const checker = prog.getTypeChecker();
            let changed = 0;

            for (const f of files)
            {
                const sf = prog.getSourceFile(f);

                if (!sf)
                    continue;

                const edits = unwrap ? unwrapEditsOf(sf) : labels ? labelEditsOf(sf) : editsOf(sf, checker);

                if (!edits.length)
                    continue;

                let text = sf.getFullText();

                for (const e of [...edits].reverse())
                    text = text.slice(0, e.start) + e.text + text.slice(e.end);

                text = withImport(text, f);
                changed += edits.length;

                if (dry)
                    console.log(relative(ROOT, f), edits.length, edits.slice(0, 5).map((e) => `${e.line}: ${e.text}`).join('\n  '));
                else
                    writeFileSync(f, text);
            }

            total += changed;
            console.log(`pass ${pass}: ${changed} texts`);

            if (!changed || dry)
                break;
        }
    }

    console.log(`${total} texts wrapped`);
}

function check(list: boolean, maybe: boolean, all: boolean): void
{
    const files = ['src/renderer/src', 'src/main', 'src/shared'].flatMap(filesUnder).filter((f) => !SKIP_FILE.test(f));
    let total = 0;
    const per: [number, string][] = [];

    for (const group of [files.filter((f) => f.includes(`${sep}renderer${sep}`)), files.filter((f) => !f.includes(`${sep}renderer${sep}`))])
    {
        const prog = program(group);
        const checker = prog.getTypeChecker();

        for (const f of group)
        {
            const sf = prog.getSourceFile(f);
            // (check also counts the single-word labels by their place and the placeholder problems wrap cannot fix)
            const edits = sf ? (maybe ? maybesOf(sf) : [...editsOf(sf, checker), ...labelEditsOf(sf), ...(all || f.includes(`${sep}renderer${sep}`) ? lintOf(sf) : [])]) : [];

            if (!edits.length)
                continue;

            total += edits.length;
            per.push([edits.length, relative(ROOT, f)]);

            if (list)
                for (const e of edits)
                    console.log(`${relative(ROOT, f)}:${e.line}  ${e.key}`);
        }
    }

    if (!list)
        console.log(per.sort((a, b) => b[0] - a[0]).map(([n, f]) => `${n}\t${f}`).join('\n'));

    console.log(`${total} texts not wrapped`);
    process.exitCode = total ? 1 : 0;
}

function extract(): void
{
    const files = ['src/renderer/src', 'src/main', 'src/shared'].flatMap(filesUnder).filter((f) => !SKIP_FILE.test(f));
    const keys = new Map<string, string[]>();
    const dynamic: string[] = [];

    for (const f of files)
    {
        const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const visit = (n: ts.Node): void =>
        {
            if (ts.isCallExpression(n) && FNS.has(calleeName(n.expression) ?? ''))
            {
                const name = calleeName(n.expression)!;
                const args = n.arguments;
                const lit = (a: ts.Expression | undefined): string | undefined => (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : undefined);
                const at = `${relative(ROOT, f).split(sep).join('/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
                const add = (k: string | undefined): void =>
                {
                    if (k === undefined)
                        dynamic.push(at);
                    else
                        keys.set(k, [...(keys.get(k) ?? []), at]);
                };

                if (name === 'trc')
                    add(lit(args[0]) !== undefined && lit(args[1]) !== undefined ? lit(args[0]) + '\u0004' + lit(args[1]) : undefined);
                else if (name === 'trn')
                {
                    add(lit(args[1]));
                }
                else if (n.expression.getText(sf) !== 'tr' || args.length)
                    add(lit(args[0]));
            }

            n.forEachChild(visit);
        };
        visit(sf);
    }

    const sorted = [...keys.keys()].sort((a, b) => a.localeCompare(b));
    writeFileSync(join(ROOT, 'src/shared/locales/template.json'), JSON.stringify(Object.fromEntries(sorted.map((k) => [k, ''])), null, 2) + '\n');
    console.log(`${sorted.length} texts → src/shared/locales/template.json; ${dynamic.length} calls with a text not written out (translated if a catalog has it)`);

    for (const f of readdirSync(join(ROOT, 'src/shared/locales')).filter((x) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(x)))
    {
        const cat = JSON.parse(readFileSync(join(ROOT, 'src/shared/locales', f), 'utf8')) as Record<string, unknown>;
        const missing = sorted.filter((k) => !(k in cat) || !cat[k]);
        const stale = Object.keys(cat).filter((k) => !keys.has(k));
        console.log(`${f}: ${sorted.length - missing.length} of ${sorted.length} translated, ${stale.length} no longer used`);
    }
}

const [mode, ...rest] = process.argv.slice(2);

if (mode === 'wrap')
    wrap(rest.filter((a) => !a.startsWith('--')), rest.includes('--dry'), rest.includes('--labels'));
else if (mode === 'unwrap')
    wrap(rest.filter((a) => !a.startsWith('--')), rest.includes('--dry'), false, true);
else if (mode === 'check')
    check(rest.includes('--list'), rest.includes('--maybe'), rest.includes('--all'));
else if (mode === 'extract')
    extract();
else
    console.log('Usage: scripts/i18n.ts wrap [--dry] <paths…> | check [--list] | extract');
