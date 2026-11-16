/**
 * Calls of the game's shader functions whose parameter list a game version changed (docs/shaders.md, "Changed game functions").
 * A mod's effect file written for the older version calls the function with the old number of arguments; HLSL overloads by
 * parameter count, so the call finds no function (`X3013 'GetBorderColorAndBlendGame': no matching 5 parameter function`)
 * and the stage does not compile: the material draws nothing. Elder Kings 2 is the case seen: its `bordercolor.fxh` and
 * `pdxwater.shader` are already 1.20's, its `pdxmesh.shader` still calls the 1.19 function in one place.
 *
 * `SHADER_CALL_CHANGES` is the table of the changes that an extra argument adapts without changing what is computed: 1.20
 * appended `SkipSecondaryProvinceOverlay` to the three border functions (found by comparing the 1.19 copies mods carry with the
 * game's 1.20 files); its test is `if ( SkipSecondaryProvinceOverlay < 0.00001f ) ApplySecondaryProvinceOverlay( … )`, so the old
 * calls' behaviour is the argument `0.0f`: the game's own `pdxwater.shader` passes exactly that. Changes that are not an
 * appended neutral argument (the province effect functions of `province_effects.fxh` gained `float3` and `float2` parameters in
 * the middle, `CalcDecal` takes `EffectIntensities`) are no entries: nothing says what to pass, the check of the merged files
 * reports the stages that fail with them.
 *
 * A new entry is a name, the parameter count before, and the text appended: the call is rewritten only when it has exactly
 * the old number of arguments. A definition or declaration of the name (a type before it), a member call, a comment and a
 * string are not calls.
 */

export interface ShaderCallChange
{
    /** the function */
    name: string;
    /** its parameter count before the change: only a call with that many arguments is adapted */
    params: number;
    /** the argument appended: the one that keeps what the old call did */
    append: string;
    /** the game version that changed it */
    since: string;
    /** the parameter, for the notes */
    param: string;
}

export const SHADER_CALL_CHANGES: ShaderCallChange[] = [
    { name: 'GetProvinceOverlayAndBlend', params: 4, append: '0.0f', since: '1.20', param: 'SkipSecondaryProvinceOverlay' },
    { name: 'GetBorderColorAndBlendGame', params: 5, append: '0.0f', since: '1.20', param: 'SkipSecondaryProvinceOverlay' },
    { name: 'GetBorderColorAndBlendGameLerp', params: 6, append: '0.0f', since: '1.20', param: 'SkipSecondaryProvinceOverlay' }
];

/** a call that was adapted: the function and the 1-based line of the call */
export interface AdaptedCall
{
    name: string;
    line: number;
    /** the call as it reads after the change, line ends as LF (to find it in a merged file: only the code the merge carries has it) */
    site: string;
}

export interface AdaptResult
{
    text: string;
    calls: AdaptedCall[];
}

const NAMES = new RegExp(`\\b(${SHADER_CALL_CHANGES.map((c) => c.name).sort((a, b) => b.length - a.length).join('|')})\\s*\\(`, 'g');
const IDENT = /[A-Za-z0-9_]/;
const KEYWORDS_BEFORE_CALL = new Set(['else', 'return', 'do']);

/** Which characters of a text are in a comment or a string (the scanner skips them). */
function maskOf(text: string): Uint8Array
{
    const mask = new Uint8Array(text.length);

    for (let i = 0; i < text.length; i++)
    {
        const c = text[i];
        const next = text[i + 1];

        if (c === '/' && next === '/')
        {
            const end = text.indexOf('\n', i);
            const to = end < 0 ? text.length : end;
            mask.fill(1, i, to);
            i = to - 1;
        }
        else if (c === '/' && next === '*')
        {
            const end = text.indexOf('*/', i + 2);
            const to = end < 0 ? text.length : end + 2;
            mask.fill(1, i, to);
            i = to - 1;
        }
        else if (c === '"')
        {
            let j = i + 1;

            while (j < text.length && text[j] !== '"' && text[j] !== '\n')
                j += text[j] === '\\' ? 2 : 1;

            mask.fill(1, i, Math.min(text.length, j + 1));
            i = j;
        }
    }

    return mask;
}

/** The call of a match: its argument count and the end of its last argument, or undefined when the parentheses do not close. */
function argumentsOf(text: string, mask: Uint8Array, open: number): { count: number; lastEnd: number; close: number; } | undefined
{
    let depth = 0;
    let count = 0;
    let lastEnd = -1;
    let any = false;

    for (let i = open; i < text.length; i++)
    {
        if (mask[i])
            continue;

        const c = text[i];

        if (c === '(' || c === '[' || c === '{')
        {
            depth++;

            if (depth > 1)
            {
                any = true;
                lastEnd = i;
            }

            continue;
        }

        if (c === ')' || c === ']' || c === '}')
        {
            depth--;

            if (depth === 0)
                return { count: any ? count + 1 : 0, lastEnd, close: i };

            lastEnd = i;
            continue;
        }

        if (c === ';' && depth === 1)
            return undefined;

        if (c === ',' && depth === 1)
        {
            count++;
            lastEnd = i;
            continue;
        }

        if (!/\s/.test(c))
        {
            any = true;
            lastEnd = i;
        }
    }

    return undefined;
}

/** Whether the name at a match is called (not defined, declared or a member): what stands before it. */
function isCall(text: string, at: number): boolean
{
    let i = at - 1;

    while (i >= 0 && /\s/.test(text[i]))
        i--;

    if (i < 0)
        return true;

    if (text[i] === '.')
        return false;

    if (!IDENT.test(text[i]))
        return true;

    // (a word before the name: a type (a definition) unless it is a statement keyword)
    let from = i;

    while (from > 0 && IDENT.test(text[from - 1]))
        from--;

    return KEYWORDS_BEFORE_CALL.has(text.slice(from, i + 1));
}

/**
 * The names the text defines with the old parameter count of a change (`void GetBorderColorAndBlendGame( … 5 parameters … ) {`):
 * a file of the mod's own that defines the function itself keeps its calls.
 */
export function definedWithOldParams(text: string): Set<string>
{
    const out = new Set<string>();
    const mask = maskOf(text);

    for (const m of text.matchAll(NAMES))
    {
        const at = m.index!;
        const change = SHADER_CALL_CHANGES.find((c) => c.name === m[1])!;

        if (mask[at] || isCall(text, at))
            continue;

        const args = argumentsOf(text, mask, at + m[0].length - 1);

        if (args && args.count === change.params && /^\s*\{/.test(text.slice(args.close + 1, args.close + 40)))
            out.add(change.name);
    }

    return out;
}

/** Whether the text has a call that `adaptShaderCalls` would change. */
export function callsToAdapt(text: string, skip?: ReadonlySet<string>): boolean
{
    return adaptShaderCalls(text, skip).calls.length > 0;
}

/**
 * The text with every call of a changed game function that has the old number of arguments given the appended one. `skip`: names
 * the mod defines itself (`definedWithOldParams`), whose calls are the mod's own. Line ends, indentation and everything else stay.
 */
export function adaptShaderCalls(text: string, skip?: ReadonlySet<string>): AdaptResult
{
    const mask = maskOf(text);
    const inserts: { at: number; text: string; }[] = [];
    const calls: AdaptedCall[] = [];

    for (const m of text.matchAll(NAMES))
    {
        const at = m.index!;
        const change = SHADER_CALL_CHANGES.find((c) => c.name === m[1])!;

        if (mask[at] || skip?.has(change.name) || !isCall(text, at))
            continue;

        const args = argumentsOf(text, mask, at + m[0].length - 1);

        if (!args || args.count !== change.params)
            continue;

        inserts.push({ at: args.lastEnd + 1, text: `, ${change.append}` });
        calls.push({ name: change.name, line: text.slice(0, at).split('\n').length, site: (text.slice(at, args.lastEnd + 1) + `, ${change.append}`).replace(/\r\n/g, '\n') });
    }

    if (!inserts.length)
        return { text, calls };

    let out = '';
    let from = 0;

    for (const ins of inserts)
    {
        out += text.slice(from, ins.at) + ins.text;
        from = ins.at;
    }

    return { text: out + text.slice(from), calls };
}
