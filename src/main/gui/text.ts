/**
 * Texts of the GUI preview (docs/gui-designer.md): the game's text formats (`textformatting = { format = { name = high
 * format = "color_white" } }`, chained down to `color:{r,g,b}` and styles) and its fonts (`fonts/fonts.font`: a font
 * name → a file per style, e.g. StandardGameFont → fonts/Gitan/GitanLatin-Regular.otf).
 */
import type { GameFiles } from '../mods/gamefiles.ts';
import type { GuiFontFiles, GuiRun } from '../../shared/api.ts';
import type { GuiLibrary } from './library.ts';
import { gvalue, gwalk } from './parser.ts';
import { parse } from '../indexer/parser.ts';

import { tr } from '../../shared/i18n.ts';
export interface TextStyle
{
    color?: [number, number, number];
    italic?: boolean;
    bold?: boolean;
}

export class GuiText
{
    private formats = new Map<string, string>();
    readonly fonts = new Map<string, GuiFontFiles>();
    /** text icons: `gold_icon` → its texture (`texticon = { icon = gold_icon texture = "…" }`) */
    readonly icons = new Map<string, string>();

    constructor(lib: GuiLibrary, vfs: GameFiles)
    {
        // (later files win, as the game loads them)
        for (const f of lib.files)
            for (const n of f.nodes)
                if (n.key === 'textformatting')
                {
                    for (const c of n.children ?? [])
                    {
                        const name = c.key === 'format' ? gvalue(c.children, 'name') : undefined;
                        const v = gvalue(c.children, 'format');

                        if (name && v !== undefined)
                            this.formats.set(name, v);
                    }
                }

        // (text icons: in texticon blocks anywhere in the files)
        for (const f of lib.files)
            gwalk(f.nodes, (n) =>
            {
                if (n.key === 'texticon' && n.children)
                {
                    // (`texticon = { icon = x iconsize = { texture = "…" size = … } }`: the texture in the first size block)
                    const icon = gvalue(n.children, 'icon');
                    const tex = gvalue(n.children, 'texture') ?? n.children.map((c) => gvalue(c.children, 'texture')).find((t) => t);

                    if (icon && tex)
                        this.icons.set(icon, tex);
                }
            });

        this.readFonts(vfs);
    }

    /**
     * A text in runs (stage 4): `#format …#!` spans (nested, resolved by `style`), `@icon!` text icons as pictures,
     * `[Data.Function]` as a sample, `[concept|E]` as the concept's word, `$key$` looked up once (`loc`), `\n` breaks.
     */
    runs(raw: string, loc?: (key: string) => string | undefined): GuiRun[]
    {
        const out: GuiRun[] = [];
        const stack: TextStyle[] = [{}];
        const top = (): TextStyle => stack[stack.length - 1];
        const push = (t: string): void =>
        {
            if (!t)
                return;

            const st = top();
            const last = out[out.length - 1];

            // (the same style as the run before: one run)
            if (last && last.t !== undefined && !last.icon && last.color?.join() === st.color?.join() && !!last.italic === !!st.italic && !!last.bold === !!st.bold)
            {
                last.t += t;
                return;
            }

            const r: GuiRun = { t };

            if (st.color)
                r.color = st.color;

            if (st.italic)
                r.italic = true;

            if (st.bold)
                r.bold = true;

            out.push(r);
        };
        const text = raw.replace(/\$(\w+)\$/g, (m, k: string) => loc?.(k) ?? m).replace(/\\n/g, '\n');
        let i = 0;

        while (i < text.length)
        {
            const c = text[i];

            if (c === '#' && text[i + 1] === '!')
            {
                if (stack.length > 1)
                    stack.pop();

                i += 2;
                continue;
            }

            if (c === '#')
            {
                // `#high ` / `#low;italic `, up to a space
                const m = /^#([\w;:{},.]+)\s?/.exec(text.slice(i));

                if (m)
                {
                    stack.push({ ...top(), ...this.style(m[1]) });
                    i += m[0].length;
                    continue;
                }
            }

            if (c === '@')
            {
                const m = /^@(\w+)!/.exec(text.slice(i));

                if (m)
                {
                    const tex = this.icons.get(m[1]);
                    out.push(tex ? { icon: tex } : { t: '◆' });
                    i += m[0].length;
                    continue;
                }
            }

            if (c === '[')
            {
                const e = text.indexOf(']', i);

                if (e > i)
                {
                    const inner = text.slice(i + 1, e);
                    const concept = /^([\w ]+)\|E$/.exec(inner);
                    push(concept ? concept[1] : sampleFor('[' + inner + ']', loc));
                    i = e + 1;
                    continue;
                }
            }

            push(c);
            i++;
        }

        return out;
    }

    private readFonts(vfs: GameFiles): void
    {
        const files = new Map<string, string>();
        const fonts: { name: string; styles: [string, string][]; }[] = [];

        for (const f of vfs.list('fonts', { engine: true, ext: /\.font$/i }))
        {
            const text = vfs.readText(f);

            if (!text)
                continue;

            for (const n of parse(text))
            {
                const name = n.v && typeof n.v !== 'string' ? (n.v.find((c) => c.k === 'name')?.v as string | undefined) : undefined;

                if (!name || typeof n.v === 'string' || !n.v)
                    continue;

                if (n.k === 'fontfiles')
                {
                    const group = n.v.find((c) => c.k === 'group');
                    const list = group && typeof group.v !== 'string' ? group.v?.find((c) => c.k === 'files') : undefined;
                    const first = list && typeof list.v !== 'string' ? list.v?.[0] : undefined;

                    if (first && typeof first.v === 'string')
                        files.set(name, first.v);
                    else if (first && first.k)
                        files.set(name, first.k);
                }
                else if (n.k === 'font')
                {
                    const styles: [string, string][] = [];

                    for (const s of n.v)
                        if (s.k === 'fontstyle' && s.v && typeof s.v !== 'string')
                        {
                            const style = s.v.find((c) => c.k === 'style')?.v;
                            const ff = s.v.find((c) => c.k === 'fontfiles')?.v;

                            if (typeof style === 'string' && typeof ff === 'string')
                                styles.push([style.toLowerCase(), ff]);
                        }

                    fonts.push({ name, styles });
                }
            }
        }

        for (const f of fonts)
        {
            const out: GuiFontFiles = {};

            for (const [style, ff] of f.styles)
            {
                const file = files.get(ff);

                if (!file)
                    continue;

                if (style === 'regular')
                    out.regular = file;
                else if (style === 'bold')
                    out.bold = file;
                else if (style === 'italic')
                    out.italic = file;
                else if (style === 'bold|italic' || style === 'italic|bold')
                    out.boldItalic = file;
            }

            if (out.regular)
                this.fonts.set(f.name, out);
        }
    }

    /** A format (`high`, `weak`, `#medium` …, `;`-separated parts) as a colour and styles. */
    style(format: string | undefined, depth = 0): TextStyle
    {
        const out: TextStyle = {};

        if (!format || depth > 12)
            return out;

        for (const raw of format.replace(/^#/, '').split(';'))
        {
            const part = raw.trim();
            const c = /^color:\s*\{\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)/.exec(part);

            if (c)
                out.color = [parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3])];
            else if (part === 'italic')
                out.italic = true;
            else if (part === 'bold')
                out.bold = true;
            else if (this.formats.has(part))
                Object.assign(out, this.style(this.formats.get(part), depth + 1));
        }

        return out;
    }
}

/** prose for a bound description (the decision window's runs to two lines in the game) */
const PROSE = tr('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.');

/**
 * A sample for a bound text (stage 4: the game fills it from its data): by the function's name (a description as prose,
 * a name, a number, a date), else the function's name in ‹ ›.
 */
export function sampleFor(binding: string, loc?: (key: string) => string | undefined): string
{
    // (a formatting suffix: `[X.GetName|U]`, `[X.GetOpinionOf( Y )|=]`, not part of the function)
    const expr = binding.replace(/^\[|\]$/g, '').replace(/\|[^|()]*$/, '');

    // a choice of texts (`SelectLocalization( cond, 'KEY_A', 'KEY_B' )`, `Select_CString( cond, 'a', 'b' )`): the first
    const choice = /^\s*Select(?:Localization|_CString)\s*\([^']*'([^']*)'/.exec(expr);

    if (choice)
        return loc?.(choice[1]) ?? choice[1];

    const f = /(\w+)\s*(\(|$)/.exec((expr
        .replace(/\(.*\)/g, '')
        .split('.')
        .pop() ?? '').trim())?.[1] ?? binding;

    // (a name before the rest: `GetNameNoTooltip` is a name)
    if (/Desc|Description/i.test(f))
        return PROSE;

    if (/Name|Title|Label|Header/i.test(f))
        return tr('Sample Name');

    if (/Effect|Requirement|Tooltip|Text$|Explanation|Summary/i.test(f))
        return PROSE;

    if (/Count|Number|Value|Amount|Cost|Level|Age|Gold|Prestige|Piety|Percent|Days|Months|Years|Size|Score|Progress|Max|Min/i.test(f))
        return '42';

    if (/Date/i.test(f))
        return '1 January 1066';

    if (/Name|Title|Label|Header/i.test(f))
        return tr('Sample Name');

    return '‹' + f + '›';
}

/**
 * A text as the game would show it, its markup taken out: `#high …#!` formats, `[Data.Function]` (its function's name),
 * `@icon!` text icons, `$key$` kept as written.
 */
export function plainText(s: string): string
{
    return s
        .replace(/#[\w;:{},. ]*?\s/g, (m) => (/^#[a-zA-Z_][\w;]*\s$/.test(m) ? '' : m))
        .replace(/#!/g, '')
        // (as the runs show them: a concept's word, else the data's sample)
        .replace(/\[([^\]]*)\]/g, (_, f: string) => /^([\w ]+)\|E$/.exec(f)?.[1] ?? sampleFor('[' + f + ']'))
        .replace(/@\w+!/g, '◆')
        .replace(/\\n/g, '\n');
}
