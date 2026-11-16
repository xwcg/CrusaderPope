/**
 * The game's effect files with a mod's own effects in them (migrations.ts `mergeShaders`; docs/mods.md "Shaders").
 *
 * A mod written for an older game overrides game shaders with its copies to add effects of its own (AGOT: the
 * `standard_winter` and `snap_to_terrain` variants of its buildings and mountains, the dragons' portrait effects, its sky),
 * and changes to the game's own code around them. The game's interfaces change with a version, so the old copies no
 * longer compile; restoring the game's files whole takes the mod's effects with them, and its materials fail ("Failed
 * getting Effect"). The merge writes the game's file and, behind it, what the mod's copy has that the game's lacks:
 *
 * - the **effects** of the mod's copy the game's file does not have, and everything they need, found by following the
 *   names in their code: stage blocks, `Code` functions, defines, variables, structs, constant buffers, samplers, states,
 *   `MainCode` blocks. Roots are effects only: a definition no effect reaches is left out (invalid-but-unused code of the
 *   mod would otherwise sit in the game's own units).
 * - a name the game's side has stays the game's (its body is not followed): the mod's changes to it are lost, and listed.
 * - the fields the mod added to the game's `VertexStruct`s are appended to its structs when code the merge carries writes
 *   them and no game function takes the struct as `out` / `inout` (fxc demands such a struct to be written whole: X3508).
 * - a copy of the mod that stays as it is (`keep`: the game's file, or the new version's with the mod's changes to code) is the
 *   file the engine loads: the other files are merged against its real text, and what arrives through it counts as present.
 * - what an effect needs from another restored file (an include the game also has) is demanded there, and the whole pass
 *   repeats until the demands stop growing.
 * - an effect that cannot be resolved is left out with its reason (the code it needs uses a field only the mod's struct
 *   has, a function nothing provides, a define the mod redirects to another name than the game's, a sampler whose slot the
 *   game's already uses in the stage, a compute shader …). A sampler bound to a file whose texture id the game's stage already
 *   has (the engine's rule: shaders/textureIds.ts) is moved to a free slot first.
 * - the mod's own effect files (no game counterpart) stay as they are, but what their effects need from the mod's copy of
 *   a restored include is carried there like what the restored files' own effects need; an effect of theirs that still
 *   lacks something is reported (`unserved`).
 * - a file the game's border renderer draws with (`FxMergeOptions.borders`) keeps the game's text: what the mod's copy would
 *   have brought is only listed (`notes.border`).
 * - in a function or main that stays the game's, the statements the mod's copy commented out (and did not replace with its
 *   own) are commented out in the game's text too (`disabledLines`, `notes.disabled`).
 * - in a border file's vertex mains, the plain statements the mod's copy adds on the game's own names are carried
 *   (`vertexAdditions`, `notes.vertexLines`): the vertex stage places the border, declarations and pixel stage stay the game's.
 *
 * Names are resolved by identifier and argument count (a call may leave out the arguments after a default value), not by
 * type. A definition the game has only under an `#if` is there in some builds only: the mod's own (written unconditionally
 * or under other conditions) is carried for the others, with the game's condition negated in front. The result is text only:
 * the caller writes it.
 */
import { COND_SEPARATOR, FIELD_NAMES, fxDefinitions, keyNoStage, scanFx, unionVertexStructs, type FxDef, type FxFile, type FxStage } from './fxBlocks.ts';
import { fileSlotCount, isFileSlot, textureIdOf } from '../shaders/textureIds.ts';

/** The key of an effect file: its path below `gfx/FX`, in lower case (`jomini/portrait.shader`). */
export const fxKey = (path: string): string => path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^gfx\/FX\//i, '').toLowerCase();

export interface FxSources
{
    /** the game's file by key as the game layers it (game, DLCs, jomini, clausewitz); text without byte order mark */
    game(key: string): string | undefined;
    /** the mod's file by key */
    mod(key: string): string | undefined;
}

/** Why an effect of the mod is left out of a merged file. */
export interface DropReason
{
    kind: 'stage' | 'unavailable' | 'field' | 'define' | 'clash' | 'binding' | 'compute' | 'demand' | 'missing' | 'verify';
    /** the definition that cannot be carried */
    def: string;
    /** the name it needs */
    name: string;
    /** `define`: the mod's and the game's value; `demand`: the file; `binding`: the sampler's `Index` and the game's sampler that has it; `verify`: what the check of the merged files found (name: the stage) */
    detail?: string;
}

/** An effect of a file of the mod's own (no game counterpart: it stays as it is) that the patch mod cannot serve what its code needs. */
export interface FxUnserved
{
    file: string;
    effect: string;
    reason: DropReason;
}

export interface FxMergeResult
{
    /** the merged files by key */
    files: Map<string, FxMerged>;
    /** effects of the mod's own files that lack what they need (nothing carries it, or the engine would refuse it) */
    unserved: FxUnserved[];
}

export interface FxMergeNotes
{
    /** the effects of the mod written into the file */
    effects: string[];
    /** the definitions written, effects included (keys) */
    carried: string[];
    /** the mod's effects left out */
    dropped: { name: string; reason: DropReason; }[];
    /** definitions both files have with another body: the game's stays (names) */
    lost: string[];
    /** `Struct.field` of the mod's vertex structs appended to the game's; those it could not (under `@ifdef`) */
    fields: string[];
    skippedFields: string[];
    /** `Struct.field` of the mod's vertex structs left out: the game's code takes the struct as `out` / `inout`, or no carried code writes the field */
    refused: string[];
    /** samplers moved to another `Index` (`Name: 32 -> 31`): the engine gives `Index = 32` the id of `PdxShadowmap` */
    moved: string[];
    /** samplers moved because their `Index` is past the engine's file slots (`Name: 36 -> 29`; shaders/textureIds.ts `fileSlotCount`) */
    movedPast: string[];
    /** includes added to the game's file */
    includes: string[];
    /** values of the mod taken into the game's text: a single-line `#define` value, a sampler's `File` / `Index` (`name`, the mod's value, the game's) */
    values: { name: string; mod: string; game: string; }[];
    /**
     * the includes of the mod's own whose macros over the game's names (`#define CameraPosition Camera_Position_Mod()` under a flag, or
     * replacing a hook of the game's) are written into an early block of the game's file; the include itself is not added
     */
    overlays: string[];
    /** those macros written, with the stages they are written for */
    macros: { name: string; stages: ('vs' | 'ps')[]; }[];
    /** macros of those includes not written in a stage, and why (`declared`: the code after the block declares the name (`def`); `unresolved`: what they call cannot be carried (`def`, `detail`); `unused`: a hook no code of the mod reaches and nothing of the mod's replaced (`def` the mod's target, `detail` `replaced` when the mod's copy of a main dropped the call); `unfit`: the mod's replacement reaches a hook whose target does not fit the game's call (`def` the mod's function, `detail` the target)) */
    macrosLeft: { name: string; stage: 'vs' | 'ps'; why: 'declared' | 'unresolved' | 'unused' | 'unfit'; def: string; detail?: string; }[];
    /**
     * hook macros written with another target than the mod's own: no code of the mod reaches the hook (`name`), its copy of the main
     * calls a function of its own there (`via`) that reaches another hook of the overlay (`hook`), and the game's call is pointed at
     * that one's target (`target`)
     */
    remapped: { name: string; stage: 'vs' | 'ps'; target: string; via: string; hook: string; }[];
    /** declarations of the game's code in this file renamed so that an overlay macro over the name applies (`def`: the function, `kind`: parameter or local) */
    renamed: { def: string; name: string; to: string; kind: 'parameter' | 'local'; }[];
    /** the flags the written macros are conditional on (`PORTRAIT_WIDGET`): the check builds the file's effects with and without them */
    flags: string[];
    /** the game's effects given such a flag in their `Defines`, as the mod's copies of them have it */
    flagged: string[];
    /** by the name of a definition carried (or a member of a constant buffer): the effects written into the file that need it */
    needs: Record<string, string[]>;
    /**
     * the file is one the game's border renderer draws with (`FxMergeOptions.borders`): it keeps the game's text, and what the mod's
     * copy would have brought is not written (the overlay macros (`macros`, of the includes `overlays`), the mod's effects the game's
     * file lacks (`effects`) and the number of its other definitions the game's file lacks (`others`))
     */
    border?: { macros: string[]; overlays: string[]; effects: string[]; others: number; };
    /**
     * disabled-line carry (`disabledLines`): in a definition the game's stays (`lost`), the statements the mod's copy commented out that
     * the game's text has live are commented out there too; per definition (`def`, `key` its definition key) the lines as code
     */
    disabled: { def: string; key: string; lines: string[]; }[];
    /**
     * such lines left live, and why (`used`: a declaration whose name a live line of the game's still uses (`name`) with its uses;
     * `replaced`: the mod wrote a line of its own in its place, which writes `name`; the definition's lost change, not told again)
     */
    disabledLeft: { def: string; line: string; why: 'used' | 'replaced'; name: string; }[];
    /**
     * a border file's vertex-stage additions (`vertexAdditions`): in a vertex main of a file the game's border renderer draws with, the
     * plain statements the mod's copy adds, carried into the game's text; per definition (`def`, `key` its definition key) the lines as code
     */
    vertexLines: { def: string; key: string; lines: string[]; }[];
    /** such statements not carried, and why (`AddedWhy`; `name`: the name or field it is about) */
    vertexLeft: { def: string; line: string; why: AddedWhy; name: string; }[];
}

/**
 * Why a statement a mod's copy of a border file adds to a vertex main is not carried (`vertexAdditions`): `statement`: not one complete
 * simple statement on its line; `preprocessor`: a preprocessor line, or under a condition the line before it does not have; `target`:
 * it does not write a local the game's main declares; `field`: it names a field no struct of the game's side has; `name`: a name the
 * game's vertex stage does not see there; `mod`: a name the mod's copy defines its own way (its macro, its own definition); `place`: no
 * line both mains share right before it (and after it the line that follows there in the game's); `with`: it goes with a line of the
 * same place that is not carried.
 */
export type AddedWhy = 'statement' | 'preprocessor' | 'target' | 'field' | 'name' | 'mod' | 'place' | 'with';

/** What a caller can ask of the merge besides the files. */
export interface FxMergeOptions
{
    /** the keys among `restore` whose copy stays as it is in the mod (read as the real file, nothing written for it) */
    keep?: string[];
    /** `file|name`: the definitions of a name (or with a member of it) not to write (the engine sees them twice: the check of the merged files found the duplicate) */
    skip?: Set<string>;
    /** `file|effect`: an effect to leave out, with the reason */
    leave?: Map<string, DropReason>;
    /** files whose overlay macros are not written (the check found the game's effects fail with them) */
    noOverlay?: Set<string>;
    /**
     * the keys of the effect files the game's border renderer draws with (read from the border settings: shaderRule.ts
     * `borderEffectKeys`). Such a file keeps the game's text (no overlay macro, no carried code, sampler, value or effect): since the
     * mod's fog of war and its texture file went into the game's `pdxborder.shader`, the engine drew every province border as an
     * opaque pink strip (game tests 2 and 3; with the game's file, test 1, they were right). Why the engine does that is not known; it
     * reacts to what the effect declares, not to what its code computes (docs/shaders.md "Overlay macros")
     */
    borders?: Set<string>;
    /** `file|definition key`: definitions whose disabled lines are not carried (the check found the game's effects fail with them) */
    noDisabled?: Set<string>;
    /** `file|definition key`: definitions that get none of the mod's added lines (a border file's vertex-stage additions: the check found the game's effects fail with them) */
    noAdditions?: Set<string>;
}

/** Notes with nothing in them. */
export const emptyNotes = (): FxMergeNotes => ({ effects: [], carried: [], dropped: [], lost: [], fields: [], skippedFields: [], refused: [], moved: [], movedPast: [], includes: [], values: [], overlays: [], macros: [], macrosLeft: [], remapped: [], renamed: [], flags: [], flagged: [], needs: {}, disabled: [], disabledLeft: [], vertexLines: [], vertexLeft: [] });

export interface FxMerged
{
    key: string;
    /** the merged file; the game's own text when the mod's copy has nothing to add */
    text: string;
    /** the game's file as it was */
    game: string;
    notes: FxMergeNotes;
}

/** The stages a block compiles for. */
const stagesOf = (s: FxStage): ('vs' | 'ps')[] => (s === 'both' ? ['vs', 'ps'] : [s]);

/** One parsed effect file of a layer. */
interface Layer
{
    key: string;
    src: string;
    file: FxFile;
    /** the include paths as keys */
    includes: string[];
}

const parseLayer = (key: string, src: string): Layer =>
{
    const file = fxDefinitions(src);
    return { key, src, file, includes: file.includes.map(fxKey) };
};

/** A layering of effect files: the reader's, with files replaced by merged ones during a pass. */
class FxLayers
{
    private readonly cache = new Map<string, Layer | null>();
    private readonly over = new Map<string, Layer>();

    private readonly read: (key: string) => string | undefined;

    constructor(read: (key: string) => string | undefined)
    {
        this.read = read;
    }

    /** The reader's file, merged ones aside. */
    base(key: string): Layer | null
    {
        let l = this.cache.get(key);

        if (l === undefined)
        {
            const src = this.read(key);
            l = src === undefined ? null : parseLayer(key, src);
            this.cache.set(key, l);
        }

        return l;
    }

    file(key: string): Layer | null
    {
        return this.over.get(key) ?? this.base(key);
    }

    override(key: string, src: string): void
    {
        this.over.set(key, parseLayer(key, src));
    }

    clearOverrides(): void
    {
        this.over.clear();
    }

    /** A file and its includes, each once, includes first (the order the engine reads them). */
    ordered(key: string, seen = new Set<string>(), out: Layer[] = []): Layer[]
    {
        const f = this.file(key);

        if (!f || seen.has(f.key))
            return out;

        seen.add(f.key);

        for (const inc of f.includes)
            this.ordered(inc, seen, out);

        out.push(f);
        return out;
    }
}

const KEYWORDS = new Set('if else for while do return break continue discard switch case default struct static const in out inout uniform void float float2 float3 float4 int int2 int3 int4 uint uint2 uint3 uint4 bool bool2 bool3 bool4 half float2x2 float3x3 float4x4 float3x4 float4x3 true false sampler2D'.split(' '));

/** A name a definition's text uses: `argc` when it is called. For an effect: `stage` = its VertexShader / PixelShader, `state` = the kind of a state. */
interface Ref
{
    name: string;
    argc?: number;
    stage?: 'vs' | 'ps' | 'cs';
    state?: string;
}

const refCache = new WeakMap<FxDef, Ref[]>();
const localCache = new WeakMap<FxDef, Set<string>>();

/** The identifiers of a text (member accesses `x.field` aside), the called ones with their argument count. */
function textRefs(text: string): Ref[]
{
    const t = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/"[^"]*"/g, ' ');
    const out: Ref[] = [];
    const re = /[A-Za-z_]\w*/g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(t)))
    {
        const name = m[0];

        // (a member access, and the word of a preprocessor line inside code: `#undef X` names `X`, not a definition called "undef")
        if (KEYWORDS.has(name) || (m.index > 0 && t[m.index - 1] === '.') || /#[ \t]*$/.test(t.slice(Math.max(0, m.index - 8), m.index)))
            continue;

        let j = m.index + name.length;

        while (/\s/.test(t[j] ?? ''))
            j++;

        let argc: number | undefined;

        if (t[j] === '(')
        {
            let depth = 0;
            let commas = 0;
            let any = false;

            for (let k = j; k < t.length; k++)
            {
                const c = t[k];

                if (c === '(' || c === '[' || c === '{')
                    depth++;
                else if (c === ')' || c === ']' || c === '}')
                {
                    depth--;

                    if (depth === 0)
                        break;
                }
                else if (c === ',' && depth === 1)
                    commas++;
                else if (depth === 1 && !/\s/.test(c))
                    any = true;
            }

            argc = any ? commas + 1 : 0;
        }

        out.push({ name, argc });
    }

    return out;
}

/** What a definition refers to (an effect: its stage mains and states, a main: its in- and output structs too). */
function refsOf(d: FxDef): Ref[]
{
    let refs = refCache.get(d);

    if (refs)
        return refs;

    if (d.kind === 'effect')
    {
        refs = [];

        // (a compute shader's main sits in a block the merge does not read: such an effect is left out, as `compute`)
        for (const m of d.text.matchAll(/(VertexShader|PixelShader|ComputeShader)\s*=\s*"?(\w+)"?/g))
            refs.push({ name: m[2], stage: m[1] === 'VertexShader' ? 'vs' : m[1] === 'PixelShader' ? 'ps' : 'cs' });

        for (const m of d.text.matchAll(/(BlendState|RasterizerState|DepthStencilState)\s*=\s*"?(\w+)"?/g))
            refs.push({ name: m[2], state: m[1] });
    }
    else
    {
        refs = textRefs(d.text);

        if (d.kind === 'main')
            for (const m of d.text.matchAll(/(?:Input|Output)\s*=\s*"?(\w+)"?/g))
                refs.push({ name: m[1] });
    }

    refCache.set(d, refs);
    return refs;
}

const pastedCache = new WeakMap<FxDef, RegExp[]>();

/**
 * The names a definition's function-like macros build by token pasting (`AGOT_FOW_CLOUDS_##TO##_HEIGHT_MIN` in a `#define
 * FADE(FROM, TO)`): one pattern per pasted sequence, the macro's parameters standing for any name part. The scan of names cannot
 * see them; the closure takes the definitions whose names match.
 */
function pastedPatterns(d: FxDef): RegExp[]
{
    let out = pastedCache.get(d);

    if (out)
        return out;

    out = [];

    if (d.text.includes('##'))
    {
        const params = new Set([...d.text.matchAll(/#\s*define\s+\w+\(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((x) => x.trim())).filter(Boolean));

        for (const m of d.text.matchAll(/[A-Za-z_]\w*(?:\s*##\s*[A-Za-z_]\w*)+/g))
        {
            const parts = m[0].split(/\s*##\s*/);

            if (parts.some((x) => params.has(x)))
                out.push(new RegExp('^' + parts.map((x) => (params.has(x) ? '\\w+' : x)).join('') + '$'));
        }
    }

    pastedCache.set(d, out);
    return out;
}

const TYPED_LOCAL =/\b(?:float[1-4]?(?:x[1-4])?|int[1-4]?|uint[1-4]?|bool[1-4]?|half[1-4]?)\s+(?:inout\s+|out\s+|in\s+)?([A-Za-z_]\w*)\s*(?=[=;,)[])|\b[A-Z]\w*\s+(?:inout\s+|out\s+|in\s+)?([a-z_]\w*)\s*(?=[=;,)[])/g;

/** The names a definition declares itself (locals and parameters; a guess from the declarations' look). */
function localsOf(d: FxDef): Set<string>
{
    let s = localCache.get(d);

    if (s)
        return s;

    s = new Set<string>();
    const t = d.text.replace(/\/\/[^\n]*/g, '');

    for (const m of t.matchAll(TYPED_LOCAL))
        s.add(m[1] ?? m[2]);

    for (const m of t.matchAll(/\b(?:in|out|inout)\s+\w+\s+(\w+)/g))
        s.add(m[1]);

    localCache.set(d, s);
    return s;
}

/** The number of parameters of a function key (`fn:Name(a,b)@stage`). */
function arityOf(key: string): number
{
    const m = /^fn:[^(]+\((.*)\)@/.exec(key);
    return !m ? -1 : m[1] === '' ? 0 : m[1].split(',').length;
}

/** A definition's name for a person. */
const labelOf = (d: FxDef): string => (d.kind === 'cbuffer' ? `ConstantBuffer( ${d.name} )` : d.name || d.key);

/** The members a constant buffer, vertex struct or struct declares. */
const hasMembers = (d: FxDef): boolean => d.kind === 'cbuffer' || d.kind === 'vstruct' || d.kind === 'struct' || d.kind === 'c-struct';

interface Pooled
{
    d: FxDef;
    file: Layer;
    order: number;
}

/** A closure that could not be resolved: the effect is left out. */
class Unresolved extends Error
{
    readonly reason: DropReason;

    constructor(reason: DropReason)
    {
        super(reason.kind);
        this.reason = reason;
    }
}

/** The `#if` lines (without the `#`) around a definition. */
const levelsOf = (cond: string | undefined): string[] => (cond ? cond.split(COND_SEPARATOR) : []);

/** One `#if` line as an expression. */
function levelExpr(level: string): string
{
    const m = /^(ifdef|ifndef|if) (.*)$/s.exec(level);
    return !m ? '1' : m[1] === 'ifdef' ? `defined(${m[2]})` : m[1] === 'ifndef' ? `!defined(${m[2]})` : `(${m[2]})`;
}

/** The `#if` line that holds where all the levels of a condition do not. */
function negation(cond: string): string
{
    const ls = levelsOf(cond);
    const single = ls.length === 1 ? /^(ifdef|ifndef) (.*)$/s.exec(ls[0]) : null;
    return single ? (single[1] === 'ifdef' ? 'ifndef ' : 'ifdef ') + single[2] : 'if !(' + ls.map(levelExpr).join(' && ') + ')';
}

/** The definition a `#if` stack wraps, as text: the conditions around it, in front (`guard` first), and their ends behind. */
function withConditions(d: FxDef, guard: string[] = []): string
{
    const open = [...guard, ...levelsOf(d.cond)];

    if (!open.length)
        return d.text;

    return open.map((x) => '#' + x).join('\n') + '\n' + d.text + '\n' + open.map(() => '#endif').join('\n');
}

/** What a `#define` replaces its name with: comments, the name and its parameters left out, white space as one blank. */
const defineBody = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '').replace(/^\s*#\s*define\s+\w+(\([^)]*\))?/, '').replace(/\s+/g, ' ').trim();

/** A function's text without the default values of its parameters (`float s = 1.0` → `float s`): for a definition after a prototype that has them. */
function withoutDefaults(text: string): string
{
    const brace = text.indexOf('{');
    const close = text.lastIndexOf(')', brace < 0 ? text.length : brace);
    let depth = 0;
    let open = -1;

    // (the parenthesis that opens the parameter list: the one matching the last before the body)
    for (let i = close; i >= 0; i--)
    {
        if (text[i] === ')')
            depth++;
        else if (text[i] === '(' && --depth === 0)
        {
            open = i;
            break;
        }
    }

    if (open < 0)
        return text;

    const params: string[] = [];
    let from = open + 1;
    depth = 0;

    for (let i = open + 1; i <= close; i++)
    {
        const c = text[i];

        if (c === '(' || c === '[' || c === '{')
            depth++;
        else if ((c === ')' || c === ']' || c === '}') && i < close)
            depth--;
        else if ((c === ',' && depth === 0) || i === close)
        {
            params.push(text.slice(from, i));
            from = i + 1;
        }
    }

    const cut = params.map((p) =>
    {
        let d = 0;

        for (let i = 0; i < p.length; i++)
        {
            if (p[i] === '(' || p[i] === '[')
                d++;
            else if (p[i] === ')' || p[i] === ']')
                d--;
            else if (p[i] === '=' && d === 0)
                return p.slice(0, i).replace(/\s+$/, '') + (/\s$/.test(p) ? ' ' : '');
        }

        return p;
    });

    return text.slice(0, open + 1) + cut.join(',') + text.slice(close);
}

/** The types of a constant buffer's members in their order, array sizes included: the layout the engine fills (the names do not matter). */
function layoutOf(d: FxDef): string
{
    const body = d.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/^[ \t]*#.*$/gm, ' ');
    return [...body.slice(body.indexOf('{') + 1).matchAll(/([A-Za-z_]\w*)\s+[A-Za-z_]\w*\s*(\[[^\]]*\])?\s*(?::\s*\w+\s*)?;/g)].map((m) => m[1] + (m[2] ?? '').replace(/\s+/g, '')).join(',');
}

/** What the merge of all files shares: the two layerings and the definitions other files must carry for the ones that include them. */
interface MergeRun
{
    /** the mod's files over the game's */
    mod: FxLayers;
    game: FxLayers;
    /** `file|key without stage`: a definition of the mod's copy of a restored file that another file's effects need */
    demands: Set<string>;
    /** the names of the structs a function of the game's takes as `out` or `inout` */
    outStructs: Set<string>;
    skip: Set<string>;
    leave: Map<string, DropReason>;
    /** per restored file: the macros of the mod's overlay includes (`overlayMacros`) */
    overlays: Map<string, OverlayMacro[]>;
    /** the files this merge writes from the game's text (restored, not kept) */
    written: Set<string>;
    /** `file|definition key|name`: a parameter or local of a game function to rename (`renameDeclared`), so that an overlay macro over the name applies */
    renames: Set<string>;
    /** `file|definition key`: no disabled-line carry there (`FxMergeOptions.noDisabled`) */
    noDisabled: Set<string>;
}

/** The new name of a declaration renamed for an overlay macro. */
export const renamedName = (name: string): string => name + '_MOD_MERGE';

/**
 * Whether a function's declaration of a name can be renamed (`renameDeclared`): a parameter, or a local whose first use in the body
 * is its declaration (before it the name is the global one), not the function's own name, and not when the text reads a member
 * of that name (`x.Name`: the macro would still break that).
 */
function renamable(d: FxDef, name: string): boolean
{
    if (d.kind !== 'c-function' || d.name === name || !localsOf(d).has(name))
        return false;

    const t = d.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

    if (new RegExp(`\\.\\s*${name}\\b`).test(t) || t.includes(renamedName(name)))
        return false;

    const brace = t.indexOf('{');
    const head = brace < 0 ? t : t.slice(0, brace);

    if (new RegExp(`\\b${name}\\b`).test(head.slice(head.indexOf('('))))
        return true;

    const first = new RegExp(`\\b${name}\\b`).exec(t.slice(brace));
    return !!first && /\b[A-Za-z_]\w*\s+(?:in\s+|out\s+|inout\s+)?$/.test(t.slice(brace, brace + first.index)) && !/\breturn\s+$/.test(t.slice(brace, brace + first.index));
}

/** A function's text with a name it declares renamed (`renamedName`): every whole word, not after `.` (a member of that name is another). */
export function renameDeclared(text: string, name: string): string
{
    return text.replace(new RegExp(`(?<!\\.\\s*)\\b${name}\\b`, 'g'), renamedName(name));
}

/**
 * A macro of an include of the mod's own that lays a name the game's code uses over with the mod's code: `#define CameraPosition
 * Camera_Position_Mod()` under `#ifdef PORTRAIT_WIDGET` (AGOT's portrait camera, pulled back by marker decals), or a hook the game
 * offers (`#ifndef ApplyFogOfWar` / `#define ApplyFogOfWar …` in the game's file) pointed at the mod's function.
 */
export interface OverlayMacro
{
    /** the include the mod's copy lists (as the mod writes it) */
    path: string;
    /** the file of the chain the macro is in (key) */
    file: string;
    name: string;
    /** what the name is replaced with (after the name and its parameters) */
    body: string;
    /** the `#define` line as the mod writes it (comments left out) */
    line: string;
    /** the stage block it sits in */
    stage: FxStage;
    /** the `#if` lines around it (fxBlocks COND_SEPARATOR) */
    cond?: string;
    /** the name is a hook the game's code offers (`#ifndef NAME` / `#define NAME …`) */
    hook?: boolean;
}

/** The `#if` stacks of lines, written with each level opened once for a run of lines that share it. */
function writeLevels(items: { levels: string[]; line: string; }[], indent: string, eol: string): string
{
    const out: string[] = [];
    let open: string[] = [];

    for (const it of items)
    {
        let common = 0;

        while (common < open.length && common < it.levels.length && open[common] === it.levels[common])
            common++;

        for (let i = open.length - 1; i >= common; i--)
            out.push(indent + '#endif');

        for (let i = common; i < it.levels.length; i++)
            out.push(indent + '#' + it.levels[i]);

        open = it.levels;
        out.push(indent + it.line);
    }

    for (let i = open.length - 1; i >= 0; i--)
        out.push(indent + '#endif');

    return out.join(eol);
}

/**
 * The merge of one restored file: the game's text, and what the mod's copy has to add to it.
 *
 * With `own` the file is one of the mod's own (no game counterpart; it stays in the mod, and the patch mod loads after it, so
 * the game's merged includes are what it includes): nothing is written; each of its effects is resolved the same way, soft:
 * a definition it needs from the mod's copy of a restored include is demanded of that include, and an effect that still lacks
 * something is returned with the reason.
 */
function mergeFile(key: string, run: MergeRun, own: true): FxUnserved[];
function mergeFile(key: string, run: MergeRun, own?: false): FxMerged;
function mergeFile(key: string, run: MergeRun, own = false): FxMerged | FxUnserved[]
{
    // (a field of the mod's vertex struct that no carried code writes is not appended: the merge is made again without it, and the
    // effects that read it are left out)
    const banned = new Set<string>();

    for (;;)
    {
        const r = mergeOnce(key, run, own, banned);

        if (!r.unwritten.length)
            return r.out;

        for (const f of r.unwritten)
            banned.add(f);
    }
}

/** The tokens of a piece of code: names, numbers (with their suffix), operators, single characters. Two statements with the same are the same. */
function codeTokens(code: string): string[]
{
    return code.match(/[A-Za-z_]\w*|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?[fFhHuUlL]?|>>=|<<=|[-+*/%&|^!=<>]=|&&|\|\||\+\+|--|<<|>>|\S/g) ?? [];
}

/** A line of a definition: its live code (comments left out) as tokens, and, a line that is all a `//` comment, the code in it (a line its author disabled). */
interface CodeLine
{
    raw: string;
    /** the line without its trailing `//` comment, and that comment */
    code: string;
    tail: string;
    live: string[];
    disabled: string[];
}

function codeLines(text: string): CodeLine[]
{
    let block = false;

    return text.split('\n').map((raw) =>
    {
        const s = raw.replace(/\r$/, '');
        const startsInBlock = block;
        let live = '';
        let cut = s.length;

        for (let i = 0; i < s.length;)
        {
            if (block)
            {
                const e = s.indexOf('*/', i);
                block = e < 0;
                i = e < 0 ? s.length : e + 2;
                live += ' ';
            }
            else if (s.startsWith('/*', i))
            {
                block = true;
                i += 2;
            }
            else if (s.startsWith('//', i))
            {
                cut = i;
                break;
            }
            else
                live += s[i++];
        }

        const off = startsInBlock ? undefined : /^\s*\/\/(.*)$/.exec(s)?.[1];
        return { raw, code: s.slice(0, cut).trim(), tail: s.slice(cut).trim(), live: codeTokens(live), disabled: off === undefined ? [] : codeTokens(off.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, ' ')) };
    });
}

/** Words that make a line control flow, not a statement the carry may switch off (a disabled `return` without the mod's replacement breaks the function). */
const CONTROL = new Set('if else for while do switch case default return break continue discard goto'.split(' '));

/** A complete simple statement on one line: it ends with `;`, has its brackets closed and no braces, and is no control flow or preprocessor line. */
function isSimpleStatement(t: string[]): boolean
{
    if (t.length < 2 || t[t.length - 1] !== ';' || !/^[A-Za-z_]/.test(t[0]) || CONTROL.has(t[0]))
        return false;

    let depth = 0;

    for (const x of t)
    {
        if (x === '{' || x === '}')
            return false;

        depth += x === '(' || x === '[' ? 1 : x === ')' || x === ']' ? -1 : 0;

        if (depth < 0)
            return false;
    }

    return depth === 0;
}

/** The local a statement declares (`float2 UV = …;`, `static const float X = …;`), if it is a declaration. */
function declaredBy(t: string[]): string | undefined
{
    let i = 0;

    while (/^(?:static|const|uniform|precise|in|out|inout)$/.test(t[i] ?? ''))
        i++;

    return /^[A-Za-z_]\w*$/.test(t[i] ?? '') && /^[A-Za-z_]\w*$/.test(t[i + 1] ?? '') && !KEYWORDS.has(t[i + 1]) && ['=', ';', '[', ','].includes(t[i + 2] ?? '') && !CONTROL.has(t[i]) ? t[i + 1] : undefined;
}

/** Whether tokens use a name (not as a member: `x.name` is another thing). */
const usesName = (t: string[], name: string): boolean => t.some((x, j) => x === name && t[j - 1] !== '.');

const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

/**
 * What the statement a line holds or begins writes: the left side of its assignment (`Diffuse . rgb`), the local it declares, the name it
 * steps (`i++`), or the function it calls as a statement (`call FinalizeOutput`), as tokens; nothing for anything else.
 */
function targetOf(t: string[]): string[] | undefined
{
    if (!/^[A-Za-z_]/.test(t[0] ?? '') || CONTROL.has(t[0]))
        return undefined;

    const decl = declaredBy(t);

    if (decl)
        return [decl];

    let depth = 0;

    for (let i = 0; i < t.length; i++)
    {
        depth += t[i] === '(' || t[i] === '[' ? 1 : t[i] === ')' || t[i] === ']' ? -1 : 0;

        if (depth === 0 && ASSIGN.has(t[i]))
            return t.slice(0, i);
    }

    return t[1] === '(' ? ['call ' + t[0]] : t[1] === '++' || t[1] === '--' ? [t[0]] : undefined;
}

/** Whether two targets are the same thing or one is part of the other (`Color` and `Color . rgb`). */
const sameTarget = (a: string[], b: string[]): boolean => a.slice(0, Math.min(a.length, b.length)).join(' ') === b.slice(0, Math.min(a.length, b.length)).join(' ');

/**
 * DISABLED-LINE CARRY. A definition both files have with another body stays the game's (`lost`). Where the mod's copy of it has a
 * statement commented out (`//Color *= 0.1;`) that the game's text of the definition has live and verbatim (the same tokens, exactly
 * once on one line, a complete simple statement) and the mod's copy has no live copy of, that line is commented out in the game's text
 * too: the mod switched that step off, and with it off the game's code does what the mod's did there.
 *
 * Not when the mod wrote its own line in its place (`//FinalColor = ApplyFogOfWar( … );` followed by `FinalColor =
 * AGOT_ApplyAtmosphericEffects( … );`): a line of its own that writes the same target (or calls the same function as a statement) after
 * the disabled one, or before it with no line both files have in between, makes it a replacement, which the game's definition does not get
 * (switching the game's line off alone would drop the step: `replaced`). A declaration goes with all its uses or not at all: one whose
 * name a line of the game's that stays live still uses stays live, and so do the lines of the carry that use it (`used`). A game line
 * with other tokens is not touched. Returns the new text, the lines carried (as code) and those left (with the target or the name).
 */
export function disabledLines(game: string, mod: string): { text: string; lines: string[]; left: { line: string; why: 'used' | 'replaced'; name: string; }[]; }
{
    const g = codeLines(game);
    const m = codeLines(mod);
    const k = (t: string[]): string => t.join(' ');
    const modLive = new Set(m.filter((x) => x.live.length).map((x) => k(x.live)));
    const gameLive = new Set(g.filter((x) => x.live.length).map((x) => k(x.live)));
    const gameAt = new Map<string, number[]>();

    g.forEach((x, i) =>
    {
        if (isSimpleStatement(x.live) && !x.disabled.length)
            (gameAt.get(k(x.live)) ?? gameAt.set(k(x.live), []).get(k(x.live))!).push(i);
    });

    const set = new Set<number>();
    const left: { line: string; why: 'used' | 'replaced'; name: string; }[] = [];
    // (a live line of the mod's own, not one the game's definition has, that writes the target)
    const writes = (x: CodeLine, target: string[]): boolean =>
    {
        const t = x.live.length && !gameLive.has(k(x.live)) ? targetOf(x.live) : undefined;
        return !!t && sameTarget(t, target);
    };

    m.forEach((x, p) =>
    {
        if (!isSimpleStatement(x.disabled) || modLive.has(k(x.disabled)))
            return;

        const at = gameAt.get(k(x.disabled));

        if (at?.length !== 1 || set.has(at[0]))
            return;

        const target = targetOf(x.disabled);
        let replaced = !!target && m.slice(p + 1).some((y) => writes(y, target));

        for (let q = p - 1; target && !replaced && q >= 0 && !gameLive.has(k(m[q].live)); q--)
            replaced = writes(m[q], target);

        if (replaced)
            left.push({ line: g[at[0]].code, why: 'replaced', name: target!.join('').replace(/^call /, '') });
        else
            set.add(at[0]);
    });

    // (a declaration whose name a line that stays live uses: it, and the lines of the carry that use it, stay live, until nothing changes)
    for (let changed = true; changed;)
    {
        changed = false;

        for (const i of [...set].sort((a, b) => a - b))
        {
            const name = set.has(i) ? declaredBy(g[i].live) : undefined;

            if (!name || !g.some((x, j) => j !== i && !set.has(j) && usesName(x.live, name)))
                continue;

            for (const j of [...set].sort((a, b) => a - b))
                if (j === i || usesName(g[j].live, name))
                {
                    set.delete(j);
                    left.push({ line: g[j].code, why: 'used', name });
                }

            changed = true;
        }
    }

    const order = [...set].sort((a, b) => a - b);
    const text = g.map((x, i) =>
    {
        if (!set.has(i))
            return x.raw;

        const indent = /^\s*/.exec(x.raw)![0];
        return indent + '// MOD-MERGE: the mod\'s copy disables this line: `' + x.code + '`' + (x.tail ? ' ' + x.tail : '') + (x.raw.endsWith('\r') ? '\r' : '');
    }).join('\n');

    return { text, lines: order.map((i) => g[i].code), left };
}

/** HLSL's intrinsic functions a carried statement may call without a definition (those that write through a parameter left out). */
const INTRINSICS = new Set('abs acos all any asfloat asin asint asuint atan atan2 ceil clamp cos cosh cross ddx ddy degrees determinant distance dot exp exp2 faceforward floor fmod frac fwidth isfinite isinf isnan ldexp length lerp lit log log10 log2 mad max min mul normalize pow radians rcp reflect refract round rsqrt saturate sign sin sinh smoothstep sqrt step tan tanh transpose trunc'.split(' '));

/** A member that is a swizzle (`.xz`, `.rgb`), not a field. */
const SWIZZLE = /^(?:[xyzw]{1,4}|[rgba]{1,4})$/;

/** Per line of a definition: the brace depth before it and the `#if` lines open around it (one string; an `#else` / `#elif` is a branch of its own). */
function lineContexts(lines: CodeLine[]): { depth: number; pp: string; }[]
{
    let depth = 0;
    const open: string[] = [];

    return lines.map((x) =>
    {
        const here = { depth, pp: open.join('\n') };
        const t = x.live;

        if (t[0] === '#')
        {
            const w = t[1] ?? '';

            if (w.startsWith('if'))
                open.push(t.join(' '));
            else if (w === 'else' || w === 'elif')
                open.push(open.pop() + ' | ' + t.join(' '));
            else if (w === 'endif')
                open.pop();
        }
        else
            for (const c of t)
                depth += c === '{' ? 1 : c === '}' ? -1 : 0;

        return here;
    });
}

/** What the game's vertex stage sees for `vertexAdditions`, besides the main's own locals, the names the main uses and the intrinsics. */
export interface VertexScope
{
    /** a name visible there: a member of a constant buffer of the game's include tree */
    sees(name: string): boolean;
    /** a field of a struct, vertex struct or constant buffer of the game's side */
    field(name: string): boolean;
    /** a name the mod's copy defines its own way: a macro of its overlay includes, a name of the game's side that its copy or an include only the mod has defines again with another body */
    own(name: string): boolean;
}

/**
 * VERTEX-STAGE ADDITIONS of a border file (`untouchedFile`). Such a file keeps the game's text: what the mod's copy declares or does in
 * a pixel stage changed how the engine drew the borders (game tests 2 and 3, docs/shaders.md "Border effect files keep the game's text").
 * A vertex main only places the border's geometry, though, and a mod may move it there (AGOT lifts every border vertex 5 units towards
 * the camera, against its lower, flatter camera and its water above the border's floor: without that the band sinks into ground and
 * water close up). A statement the mod's copy of the main adds is carried into the game's text when it is a complete simple statement on
 * one line (no braces, control flow or preprocessor line, under no `#if` the line before it lacks), writes a local the game's main
 * declares (before that place), names only what the game's vertex stage sees there (the main's locals and the names it uses, constant
 * buffer members of the game's include tree, intrinsics, literals; a member access a field of the game's side or a swizzle) and nothing
 * the mod's copy defines its own way, and follows a line both mains share: exactly once each, at the same brace depth and conditions,
 * with the same line after it in the game's main as after the mod's lines. The lines the mod adds at one place are carried together or
 * not at all. Each goes after that shared line, behind a marker. Returns the new text, the lines carried (as code) and those left (why).
 */
export function vertexAdditions(game: string, mod: string, scope: VertexScope): { text: string; lines: string[]; left: { line: string; why: AddedWhy; name: string; }[]; }
{
    const g = codeLines(game);
    const m = codeLines(mod);
    const k = (t: string[]): string => t.join(' ');
    const gc = lineContexts(g);
    const mc = lineContexts(m);
    const gameAt = new Map<string, number[]>();
    const modCount = new Map<string, number>();

    g.forEach((x, i) =>
    {
        if (x.live.length)
            (gameAt.get(k(x.live)) ?? gameAt.set(k(x.live), []).get(k(x.live))!).push(i);
    });

    for (const x of m)
        if (x.live.length)
            modCount.set(k(x.live), (modCount.get(k(x.live)) ?? 0) + 1);

    // the locals the game's main declares (the line of the declaration) and the names it uses
    const declared = new Map<string, number>();
    const used = new Set<string>();

    g.forEach((x, i) =>
    {
        const d = declaredBy(x.live);

        if (d && !declared.has(d))
            declared.set(d, i);

        x.live.forEach((t, j) =>
        {
            if (/^[A-Za-z_]/.test(t) && x.live[j - 1] !== '.')
                used.add(t);
        });
    });

    // the mod's lines of its own, by the line both have before them (`anchor`, -1: none) and the next one both have (`next`)
    const runs: { anchor: number; next: number; lines: number[]; }[] = [];
    let cur: { anchor: number; next: number; lines: number[]; } | undefined;

    m.forEach((x, p) =>
    {
        if (!x.live.length)
            return;

        if (gameAt.has(k(x.live)))
        {
            if (cur)
                cur.next = p;

            cur = { anchor: p, next: -1, lines: [] };
            runs.push(cur);
            return;
        }

        if (!cur)
        {
            cur = { anchor: -1, next: -1, lines: [] };
            runs.push(cur);
        }

        cur.lines.push(p);
    });

    const after = new Map<number, number[]>();
    const left: { line: string; why: AddedWhy; name: string; }[] = [];

    for (const r of runs.filter((x) => x.lines.length))
    {
        const a = r.anchor < 0 ? undefined : m[r.anchor];
        const at = a ? gameAt.get(k(a.live)) ?? [] : [];
        const gi = at.length === 1 ? at[0] : -1;
        const gnext = gi < 0 ? -1 : g.findIndex((x, i) => i > gi && x.live.length > 0);
        const placed = !!a && gi >= 0 && r.next >= 0 && modCount.get(k(a.live)) === 1 && isSimpleStatement(a.live) && gc[gi].depth === mc[r.anchor].depth && gc[gi].pp === mc[r.anchor].pp && gnext >= 0 && k(g[gnext].live) === k(m[r.next].live);
        const why = (p: number): { why: AddedWhy; name: string; } | undefined =>
        {
            const t = m[p].live;

            if (t[0] === '#' || (a && mc[p].pp !== mc[r.anchor].pp))
                return { why: 'preprocessor', name: '' };

            if (!isSimpleStatement(t))
                return { why: 'statement', name: '' };

            if (!placed)
                return { why: 'place', name: '' };

            const target = targetOf(t);

            if (!target || declaredBy(t) || target[0].startsWith('call ') || !declared.has(target[0]))
                return { why: 'target', name: (target ?? []).join('').replace(/^call /, '') };

            for (const [j, x] of t.entries())
            {
                if (!/^[A-Za-z_]/.test(x))
                    continue;

                if (t[j - 1] === '.')
                {
                    if (!SWIZZLE.test(x) && !scope.field(x))
                        return { why: 'field', name: x };

                    continue;
                }

                if (KEYWORDS.has(x))
                    continue;

                // (a local of the game's main declared after that place is not there yet)
                if (declared.has(x))
                {
                    if (declared.get(x)! > gi)
                        return { why: 'name', name: x };

                    continue;
                }

                if (scope.own(x))
                    return { why: 'mod', name: x };

                if (!used.has(x) && !INTRINSICS.has(x) && !scope.sees(x))
                    return { why: 'name', name: x };
            }

            return undefined;
        };
        const verdicts = r.lines.map(why);

        if (verdicts.every((v) => !v))
        {
            after.set(gi, [...(after.get(gi) ?? []), ...r.lines]);
            continue;
        }

        // (a preprocessor line itself is not listed: the statements under it are)
        r.lines.forEach((p, n) =>
        {
            if (m[p].live[0] !== '#')
                left.push({ line: m[p].code, ...(verdicts[n] ?? { why: 'with', name: '' }) });
        });
    }

    const lines: string[] = [];
    const text = g.map((x, i) =>
    {
        const add = after.get(i);

        if (!add)
            return x.raw;

        const indent = /^[ \t]*/.exec(x.raw)![0];
        const cr = x.raw.endsWith('\r') ? '\r' : '';

        return [x.raw, ...add.flatMap((p) =>
        {
            lines.push(m[p].code);
            return [indent + '// MOD-MERGE: the mod\'s line carried: `' + m[p].code + '`' + cr, indent + m[p].code + (m[p].tail ? ' ' + m[p].tail : '') + cr];
        })].join('\n');
    }).join('\n');

    return { text, lines, left };
}

/** Whether two code texts have the same live tokens (comments and white space aside). */
const sameCode = (a: string, b: string): boolean => codeLines(a).flatMap((x) => x.live).join(' ') === codeLines(b).flatMap((x) => x.live).join(' ');

/** Whether a text assigns a struct's field or hands it to a call (a macro writes through its argument). */
function writesField(text: string, field: string): boolean
{
    // (a field name is an identifier: nothing to escape)
    const f = field;
    return new RegExp(`\\.\\s*${f}\\b(?:\\s*\\[[^\\]]*\\])?(?:\\s*\\.\\s*\\w+)?\\s*(?:[-+*/|&^%]|<<|>>)?=(?!=)|[(,]\\s*[A-Za-z_]\\w*\\s*\\.\\s*${f}\\s*[,)]`).test(text);
}

function mergeOnce(key: string, run: MergeRun, own: boolean, banned: Set<string>): { out: FxMerged | FxUnserved[]; unwritten: string[]; }
{
    const { mod: M, game: G, demands } = run;
    const notes = emptyNotes();
    const gameText = own ? '' : G.base(key)!.src;
    const eol = gameText.includes('\r\n') ? '\r\n' : '\n';
    const mF = M.file(key)!;
    const mFiles = M.ordered(key);

    // 1. the fields the mod added to the game's VertexStructs (before anything is resolved against them)
    if (!own)
    {
        const union = unionVertexStructs(gameText, mF.src, eol, (s, f) => banned.has(`${s}.${f}`) || run.outStructs.has(s));
        notes.fields = union.added;
        notes.skippedFields = union.skipped;
        notes.refused = union.refused;

        // (also when none is added: an earlier round of this file may have left the game's text with fields in the layer)
        if (union.added.length || G.file(key)!.src !== gameText)
            G.override(key, union.text);

        // 1b. the declarations another file's overlay macros asked to rename (4a): a parameter or local of one function, in its text
        // only; an alpha-rename, nothing changes but the name, and the macro over the name then applies to the code that uses it
        const asked = [...run.renames].filter((r) => r.startsWith(key + '|'));

        if (asked.length)
        {
            const layer = G.file(key)!;
            let src = layer.src;

            for (const r of asked)
            {
                const defKey = r.slice(key.length + 1, r.lastIndexOf('|'));
                const name = r.slice(r.lastIndexOf('|') + 1);

                for (const d of layer.file.defs.get(defKey) ?? [])
                {
                    if (!renamable(d, name) || src.indexOf(d.text) < 0 || src.indexOf(d.text) !== src.lastIndexOf(d.text))
                        continue;

                    const head = d.text.slice(0, d.text.indexOf('{') < 0 ? d.text.length : d.text.indexOf('{'));
                    src = src.replace(d.text, () => renameDeclared(d.text, name));
                    notes.renamed.push({ def: d.name, name, to: renamedName(name), kind: new RegExp(`\\b${name}\\b`).test(head.slice(head.indexOf('('))) ? 'parameter' : 'local' });
                }
            }

            if (src !== layer.src)
                G.override(key, src);
        }
    }

    const gF = own ? undefined : G.file(key)!;
    // 2. the game's side as the file sees it: all its definitions by key and by name (members of structs and buffers too); a
    // file of the mod's own sees the game's files it includes (the mod's copies of them are replaced by the patch mod's)
    const gFiles: Layer[] = [];

    if (own)
    {
        const seen = new Set<string>();

        for (const f of mFiles)
            if (f.key !== key && G.base(f.key))
                G.ordered(f.key, seen, gFiles);
    }
    else
        gFiles.push(...G.ordered(key));

    // (the mod's own files the file includes, without passing through a game file: they stay in the mod)
    const reach = new Set<string>([key]);

    if (own)
    {
        const stack = [key];

        while (stack.length)
            for (const i of M.file(stack.pop()!)?.includes ?? [])
                if (!reach.has(i) && !G.base(i))
                {
                    reach.add(i);
                    stack.push(i);
                }
    }

    const vis = new Map<string, FxDef[]>();
    const visName = new Map<string, FxDef[]>();
    const push = (map: Map<string, FxDef[]>, k: string, d: FxDef): void =>
    {
        const list = map.get(k);

        if (list)
            list.push(d);
        else
            map.set(k, [d]);
    };

    for (const f of gFiles)
    {
        for (const list of f.file.defs.values())
        {
            for (const d of list)
            {
                push(vis, keyNoStage(d), d);

                if (d.name)
                    push(visName, d.name, d);

                if (hasMembers(d))
                    for (const m of d.text.matchAll(FIELD_NAMES))
                        push(visName, m[1], d);
            }
        }
    }

    const gKeys = new Set(gFiles.map((f) => f.key));
    // the game's definitions of the mod's definition's key that exist in the stage; one counts as the mod's own when it is written
    // under no condition or only under conditions the mod's has too; one under another condition (`#ifdef FOO` around the game's
    // function, the mod's unconditional) is there in some builds only
    const providers = (d: FxDef, stage: 'vs' | 'ps'): FxDef[] => (vis.get(keyNoStage(d)) ?? []).filter((x) => stagesOf(x.stage).includes(stage));
    const covered = (d: FxDef, stage: 'vs' | 'ps'): boolean => providers(d, stage).some((x) => levelsOf(x.cond).every((l) => levelsOf(d.cond).includes(l)));
    // the stages a definition of the mod is not covered for on the game's side
    const missingStages = (d: FxDef): ('vs' | 'ps')[] => stagesOf(d.stage).filter((s) => !covered(d, s));
    // the conditions under which the game provides a definition in a stage only in some builds: the mod's is carried for the others
    const guardOf = (d: FxDef, stage: 'vs' | 'ps'): string[] => [...new Set(providers(d, stage).map((x) => negation(x.cond ?? '')))];

    // 3. the mod's side: the pool of definitions to carry, this file's and those of the mod's own includes (a game file
    // the mod overrides merges on its own)
    const pool: Pooled[] = [];

    for (const f of mFiles)
    {
        if (own ? !reach.has(f.key) : f.key !== key && (gKeys.has(f.key) || G.base(f.key)))
            continue;

        for (const list of f.file.defs.values())
            for (const d of list)
                pool.push({ d, file: f, order: pool.length });
    }

    const poolName = new Map<string, Pooled[]>();

    for (const p of pool)
    {
        if (p.d.name)
            (poolName.get(p.d.name) ?? poolName.set(p.d.name, []).get(p.d.name)!).push(p);

        if (hasMembers(p.d))
            for (const m of p.d.text.matchAll(FIELD_NAMES))
                (poolName.get(m[1]) ?? poolName.set(m[1], []).get(m[1])!).push(p);
    }

    // the mod's #defines by name, every name it declares anywhere (to tell "the mod has it but nothing available does" from
    // a local or a built-in), and the fields only its version of a vertex struct or buffer has
    const modDefines = new Map<string, FxDef[]>();
    const modNames = new Set<string>();
    const missingFields = new Set<string>();

    for (const f of mFiles)
    {
        for (const list of f.file.defs.values())
        {
            for (const d of list)
            {
                if (d.kind === 'c-define')
                    (modDefines.get(d.name) ?? modDefines.set(d.name, []).get(d.name)!).push(d);

                if (d.name)
                    modNames.add(d.name);

                if (d.kind !== 'cbuffer' && d.kind !== 'vstruct')
                    continue;

                const names = [...d.text.matchAll(FIELD_NAMES)].map((m) => m[1]);

                for (const n of names)
                    modNames.add(n);

                const game = vis.get(keyNoStage(d));

                if (!game)
                    continue;

                const gameNames = new Set(game.flatMap((x) => [...x.text.matchAll(FIELD_NAMES)].map((m) => m[1])));

                for (const n of names)
                    if (!gameNames.has(n))
                        missingFields.add(n);
            }
        }
    }

    // the names the game's own code uses (the game's files as they are, not the tails earlier merges added): a define of the mod's
    // with one of them would change that code (a feature flag the game tests with `#ifdef`, a name its macros expand); the tail
    // comes after the game's `Code` blocks, `MainCode` after all of them
    let gameUsed: Set<string> | undefined;
    const gameUses = (name: string): boolean =>
    {
        if (!gameUsed)
        {
            gameUsed = new Set();

            for (const f of gFiles)
                for (const list of (G.base(f.key) ?? f).file.defs.values())
                    for (const d of list)
                    {
                        for (const r of refsOf(d))
                            gameUsed.add(r.name);

                        // (the `#if` / `#ifdef` lines around a definition are not part of its text)
                        for (const m of (d.cond ?? '').matchAll(/[A-Za-z_]\w*/g))
                            gameUsed.add(m[0]);
                    }
        }

        return gameUsed.has(name);
    };

    // a second declaration of a game constant buffer whose members are all new names (AGOT's cw/agot_camera.fxh copy of
    // PdxCamera): the engine fills a buffer by its layout, so the copy is another view of it, carried as one more declaration,
    // when its layout (the members' types in order) is the game's: another layout would read the wrong offsets
    const aliases = new Set<Pooled>();
    const isAlias = (q: Pooled): boolean =>
    {
        if (q.d.kind !== 'cbuffer')
            return false;

        const same = vis.get(keyNoStage(q.d)) ?? [];
        return same.length > 0 && !same.some((x) => x.norm === q.d.norm) && [...q.d.text.matchAll(FIELD_NAMES)].every((m) => !(visName.get(m[1]) ?? []).some((x) => x.kind === 'cbuffer')) && same.some((x) => layoutOf(x) === layoutOf(q.d));
    };

    // the texture ids the samplers of the game's side take, by stage (file-scope ones in both): the engine refuses a stage in which
    // two have the same one ("Texture Samplers have same binding index"; `Index = n` is `Ref = PdxTexture<n>`, 32 is PdxShadowmap),
    // and that would break the game's own effects of the file too. A mod sampler bound to a file (`File = …`) moves to a free
    // `Index`; one the material or the mesh feeds, or a `Ref`, cannot, and its effect is left out
    const samplerKey = (d: FxDef): { index?: string; ref?: string; id?: number; } =>
    {
        const index = /\bIndex\s*=\s*(-?\d+)/.exec(d.text)?.[1];
        const ref = /\bRef\s*=\s*"?(\w+)"?/.exec(d.text)?.[1];
        return { index, ref, id: textureIdOf(index, ref) };
    };
    const isBuffer = (d: FxDef): boolean => /^\s*BufferTexture\b/.test(d.text);
    let taken: Record<'vs' | 'ps', Map<number, FxDef>> | undefined;
    const takenIds = (): Record<'vs' | 'ps', Map<number, FxDef>> =>
    {
        if (!taken)
        {
            taken = { vs: new Map(), ps: new Map() };

            for (const f of gFiles)
                for (const list of f.file.defs.values())
                    for (const x of list)
                        if (x.kind === 'sampler' && !isBuffer(x))
                        {
                            const id = samplerKey(x).id;

                            for (const s of stagesOf(x.stage))
                                if (id !== undefined && !taken[s].has(id))
                                    taken[s].set(id, x);
                        }
        }

        return taken;
    };
    // (the ids of every sampler of the mod's pool and of the ones already moved: a slot is chosen once)
    const poolIds = new Set<number>();
    const rebound = new Map<Pooled, string>();

    for (const q of pool)
        if (q.d.kind === 'sampler' && !isBuffer(q.d))
        {
            const id = samplerKey(q.d).id;

            if (id !== undefined)
                poolIds.add(id);
        }

    /** A carried sampler whose texture id the game's side has in a stage it is written for: moved, or Unresolved. */
    const placeSampler = (q: Pooled, effect: string): void =>
    {
        const d = q.d;

        if (own || d.kind !== 'sampler' || isBuffer(d) || rebound.has(q))
            return;

        const { index, ref, id } = samplerKey(d);
        const stages = stagesOf(d.stage);
        const other = id === undefined ? undefined : stages.map((s) => takenIds()[s].get(id)).find((x) => x && keyNoStage(x) !== keyNoStage(d));
        // (a texture file on an `Index` past the engine's file slots (1.19 had more) gets an id of another range: the file does not
        // reach the stage as it should. One without `File` is fed by the material or the mesh: as before)
        const past = index !== undefined && id !== undefined && !isFileSlot(index) && /\bFile\s*=/.test(d.text);

        // (an `Index` outside the engine's ids is refused by its builder as well)
        if (!other && !past && !(index !== undefined && id === undefined))
            return;

        const fail = (): never =>
        {
            throw new Unresolved({ kind: 'binding', def: effect, name: d.name, detail: `${index ?? ref ?? ''} | ${other?.name ?? '-'}` });
        };

        if (index === undefined || !/\bFile\s*=/.test(d.text))
            fail();

        for (let n = fileSlotCount() - 1; n >= 0; n--)
        {
            const free = textureIdOf(String(n), undefined)!;

            if (poolIds.has(free) || stages.some((s) => takenIds()[s].has(free)))
                continue;

            poolIds.add(free);
            rebound.set(q, String(n));
            (past && !other ? notes.movedPast : notes.moved).push(`${d.name}: ${index} -> ${n}`);
            return;
        }

        fail();
    };

    /** The mod's definitions a root needs (each with the stages it is needed in) and the game files to include; throws `Unresolved` when it cannot be carried. */
    const closure = (seed: Pooled, stages: ('vs' | 'ps' | 'both')[]): { set: Map<Pooled, Set<string>>; includes: Set<string>; } =>
    {
        const set = new Map<Pooled, Set<string>>();
        const includes = new Set<string>();
        const queue: { p: Pooled; st: string; }[] = [];
        const need = (p: Pooled, st: string): void =>
        {
            const have = set.get(p) ?? set.set(p, new Set()).get(p)!;

            if (have.has(st))
                return;

            have.add(st);
            queue.push({ p, st });
        };

        for (const st of stages)
            need(seed, st);

        while (queue.length)
        {
            const { p, st } = queue.pop()!;
            const d = p.d;
            // (the stage this code compiles for)
            const ctx = d.stage === 'both' ? st : d.stage;

            if (d.stage !== 'both' && st !== 'both' && d.stage !== st && d.kind !== 'effect')
                throw new Unresolved({ kind: 'stage', def: labelOf(d), name: st });

            const locals = localsOf(d);
            // (and the names its macros paste together, as the pool and the game's side have them)
            const pasted = pastedPatterns(d);
            const refs = pasted.length ? [...refsOf(d), ...[...new Set([...poolName.keys(), ...visName.keys()])].filter((n) => pasted.some((re) => re.test(n))).map((name) => ({ name }) as Ref)] : refsOf(d);

            for (const r of refs)
            {
                const name = r.name;

                if (locals.has(name) && d.kind !== 'effect')
                    continue;

                // (a compute shader's main sits in a block the merge does not read: its needs are unknown)
                if (r.stage === 'cs')
                {
                    if (own)
                        continue;

                    throw new Unresolved({ kind: 'compute', def: labelOf(d), name });
                }

                // what kind of definition the name stands for here: an effect names mains and states, code calls functions (or
                // macros) or reads anything else
                const wantKind = (k: string): boolean => (d.kind === 'effect' ? (r.stage ? k === 'main' : k === r.state) : r.argc !== undefined ? k === 'c-function' || k === 'c-define' : k !== 'c-function');
                const wantStage: string = d.kind === 'effect' ? (r.stage ?? 'both') : ctx;
                const stageOk = (x: FxDef): boolean => (d.kind === 'effect' ? (r.stage ? x.stage === r.stage : true) : x.stage === 'both' || wantStage === 'both' || x.stage === wantStage);
                // (a call may leave out the arguments after the first default value)
                const arityOk = (x: FxDef): boolean => x.kind !== 'c-function' || r.argc === undefined || (r.argc <= arityOf(x.key) && r.argc >= (x.minArgs ?? arityOf(x.key)));
                // 1. the game's side has it
                const seen = (visName.get(name) ?? []).filter((x) => wantKind(x.kind) && stageOk(x) && arityOk(x));
                // 2. the mod has definitions of that name the game's side lacks (overloads of other arity, its own functions …)
                // but not a function that fits the call by leaving out arguments with default values when the game's side has one the
                // call fits too, or the other way round (two overloads the compiler could not tell apart: the game's stays)
                const fitsByDefaults = (x: FxDef): boolean => x.kind === 'c-function' && r.argc !== undefined && arityOf(x.key) !== r.argc;
                const gameFits = seen.some((x) => x.kind === 'c-function');
                const gameByDefaults = seen.some(fitsByDefaults);
                const cands = (poolName.get(name) ?? []).filter((q) => wantKind(q.d.kind) && arityOk(q.d) && stageOk(q.d) && (missingStages(q.d).length > 0 || isAlias(q)) && !(gameFits && (fitsByDefaults(q.d) || gameByDefaults)));

                if (seen.length && !cands.length)
                {
                    // (a define the mod points at another name than the game does: `#define ApplyFogOfWar GameApplyFogOfWar` against
                    // the game's JominiApplyFogOfWar; the code was written for the mod's)
                    const gd = seen.find((x) => x.kind === 'c-define');

                    if (gd)
                    {
                        const body = (t: string): string => t.replace(/^#\s*define\s+\w+/, '').replace(/\/\/.*$/, '').trim();
                        const bare = (t: string): boolean => /^[A-Za-z_]\w*$/.test(body(t));
                        const other = (modDefines.get(name) ?? []).filter((x) => x.norm !== gd.norm && bare(x.text) && bare(gd.text));

                        if (other.length)
                            throw new Unresolved({ kind: 'define', def: labelOf(d), name, detail: `${other.map((x) => body(x.text)).join('/')} | ${body(gd.text)}` });
                    }

                    continue;
                }

                if (cands.length)
                {
                    for (const q of cands)
                    {
                        if (isAlias(q))
                        {
                            aliases.add(q);
                            need(q, 'both');
                            continue;
                        }

                        // (a file of the mod's own writes nothing: a define it keeps in the mod changes no code of the game's)
                        if (!own && q.d.kind === 'c-define' && gameUses(q.d.name))
                            throw new Unresolved({ kind: 'clash', def: labelOf(d), name: q.d.name });

                        placeSampler(q, labelOf(d));

                        const ms = missingStages(q.d);
                        const stages2 = q.d.stage === 'both' ? (wantStage === 'both' ? ms : ms.filter((s) => s === wantStage)) : [q.d.stage];

                        if (!stages2.length && !seen.length)
                            throw new Unresolved({ kind: 'stage', def: labelOf(q.d), name: wantStage });

                        for (const s of stages2)
                            need(q, q.d.kind === 'effect' || q.d.kind === 'main' || q.d.kind === 'sampler' ? q.d.stage : s);
                    }

                    continue;
                }

                // 3. a game file the mod includes and the game's file does not: its include is added (a file of the mod's own
                // keeps its includes: nothing can be added to it)
                let found = false;

                for (const f of own ? [] : mFiles)
                {
                    if (f.key === key || gKeys.has(f.key) || !G.base(f.key))
                        continue;

                    for (const ff of G.ordered(f.key))
                        for (const list of ff.file.defs.values())
                            for (const x of list)
                                if (!found && x.name === name && wantKind(x.kind) && arityOk(x))
                                {
                                    includes.add(f.key);
                                    found = true;
                                }
                }

                if (found)
                    continue;

                // 4. the mod defines it in another file the game has too (merged on its own): that file carries it; it is demanded, and
                // the next pass sees it (for a file of the mod's own the effect is not left out: the demand is all there is to do)
                let asked = false;

                for (const f of mFiles)
                {
                    if (f.key === key || !gKeys.has(f.key))
                        continue;

                    for (const list of f.file.defs.values())
                    {
                        for (const x of list)
                        {
                            if (x.name === name && wantKind(x.kind) && arityOk(x) && !(vis.get(keyNoStage(x)) ?? []).length)
                            {
                                demands.add(f.key + '|' + keyNoStage(x));
                                asked = true;

                                if (!own)
                                    throw new Unresolved({ kind: 'demand', def: labelOf(d), name, detail: f.key });
                            }
                        }
                    }
                }

                if (asked)
                    continue;

                // 5. the mod knows the name, nothing available has it
                if (modNames.has(name) && d.kind !== 'effect')
                    throw new Unresolved({ kind: missingFields.has(name) ? 'field' : 'unavailable', def: labelOf(d), name });

                if (d.kind === 'effect')
                    throw new Unresolved({ kind: 'missing', def: labelOf(d), name });
            }

            // (a field only the mod's version of a struct or buffer has)
            if (d.kind !== 'effect')
                for (const m of d.text.matchAll(/\.\s*([A-Za-z_]\w*)/g))
                    if (missingFields.has(m[1]))
                        throw new Unresolved({ kind: 'field', def: labelOf(d), name: m[1] });
        }

        return { set, includes };
    };

    // 4. the roots: the mod's effects the game's side lacks (this file's and the mod's own includes'), and the definitions
    // other files' effects demanded of this one
    const demanded = (p: Pooled): boolean => demands.has(key + '|' + keyNoStage(p.d));

    // a file of the mod's own: every effect in it is a root, resolved soft (nothing is written), and the ones that lack something are told
    if (own)
    {
        const unserved: FxUnserved[] = [];

        for (const s of pool.filter((p) => p.d.kind === 'effect'))
        {
            try
            {
                closure(s, ['both']);
            }
            catch (e)
            {
                if (!(e instanceof Unresolved))
                    throw e;

                unserved.push({ file: key, effect: s.d.name, reason: e.reason });
            }
        }

        return { out: unserved, unwritten: [] };
    }

    const seeds = pool.filter((p) => missingStages(p.d).length > 0 && (p.d.kind === 'effect' || demanded(p)) && (p.file.key === key || p.d.kind === 'effect'));

    const final = new Map<Pooled, Set<string>>();
    const addIncludes = new Set<string>();

    // (effects first; a root that cannot be resolved is left out whole, with its reason)
    for (const s of [...seeds.filter((x) => x.d.kind === 'effect'), ...seeds.filter((x) => x.d.kind !== 'effect')])
    {
        if (s.d.kind !== 'effect' && final.has(s))
            continue;

        const left = s.d.kind === 'effect' ? run.leave.get(key + '|' + s.d.name) : undefined;

        if (left)
        {
            notes.dropped.push({ name: s.d.name, reason: left });
            continue;
        }

        try
        {
            const c = closure(s, s.d.kind === 'effect' ? ['both'] : missingStages(s.d));

            for (const [p, st] of c.set)
            {
                const have = final.get(p) ?? final.set(p, new Set()).get(p)!;

                for (const x of st)
                    have.add(x);
            }

            for (const i of c.includes)
                addIncludes.add(i);

            if (s.d.kind === 'effect')
            {
                notes.effects.push(s.d.name);

                for (const p of c.set.keys())
                    if (p.d.kind !== 'effect')
                        for (const n of [p.d.name, ...(hasMembers(p.d) ? [...p.d.text.matchAll(FIELD_NAMES)].map((m) => m[1]) : [])])
                            if (n && !(notes.needs[n] ??= []).includes(s.d.name))
                                notes.needs[n].push(s.d.name);
            }
        }
        catch (e)
        {
            if (!(e instanceof Unresolved))
                throw e;

            if (s.d.kind === 'effect')
                notes.dropped.push({ name: s.d.name, reason: e.reason });
        }
    }

    // 4a. the macros of the mod's overlay includes (`overlayMacros`), written into an early block of the game's file, per stage, with
    // prototypes of the functions they name: those are carried like an effect's needs, below the game's code that calls them. A macro
    // is written in a stage when the code after the block spells its name there (the game's file and every stage block of its
    // includes: the engine puts the top level's code of the includes before it), and not when that code declares the name (a
    // parameter, a local, a field: the macro would make the declaration a call), or what it names cannot be carried. One the game's
    // file has already (the merged file merged again) is there.
    const written: { m: OverlayMacro; stage: 'vs' | 'ps'; protos: FxDef[]; }[] = [];
    const macros = run.overlays.get(key) ?? [];

    if (macros.length)
    {
        const isCode = (d: FxDef): boolean => d.kind.startsWith('c-') || d.kind === 'main';
        const after = (s: 'vs' | 'ps'): FxDef[] =>
        [
            ...gFiles.flatMap((f) => [...f.file.defs.values()].flat().filter((d) => isCode(d) && (d.stage === s || (f.key === key && d.stage === 'both')))),
            ...[...final].filter(([p, st]) => isCode(p.d) && (p.d.stage === s || st.has(s) || st.has('both'))).map(([p]) => p.d)
        ];
        const spells = (d: FxDef, name: string): boolean => (d.kind === 'c-define' ? new RegExp(`\\b${name}\\b`).test(defineBody(d.text)) : refsOf(d).some((r) => r.name === name));
        const declares = (d: FxDef, name: string): boolean => d.kind !== 'c-define' && d.kind !== 'c-pp' &&
            (d.name === name || localsOf(d).has(name) || (d.kind === 'c-struct' && [...d.text.matchAll(FIELD_NAMES)].some((m) => m[1] === name)) || new RegExp(`\\.\\s*${name}\\b`).test(d.text.replace(/\/\/[^\n]*/g, '')));
        // (the game's side has the macro as it is: an earlier merge wrote it)
        const present = (m: OverlayMacro): boolean => gFiles.some((f) => ['both', 'vs', 'ps'].some((st) => (f.file.defs.get(`def:${m.name}@${st}`) ?? []).some((d) => defineBody(d.text) === defineBody(m.line))));
        const label = (d: FxDef): string => (d.kind === 'main' ? d.name : labelOf(d));
        // (the file of the game's side a definition is in)
        const fileOf = new Map<FxDef, string>(gFiles.flatMap((f) => [...f.file.defs.values()].flat().map((d) => [d, f.key] as [FxDef, string])));

        // a hook of the game's that no code of the mod reaches (its copy of the file, with the includes as the mod has them): the
        // mod's copy of a main replaced the game's call of the hook. Where it calls a function of its own there that reaches another
        // hook of the overlay, the game's call goes to that hook's target when the call fits it (the argument count, default values
        // allowed, and the types of the function the game's hook names); otherwise, and where nothing replaced the call, the mod's
        // macro is not written (it would point the game's call at a function the mod never used there)
        const bareName = (b: string): boolean => /^[A-Za-z_]\w*$/.test(b);
        let modCode: FxDef[] | undefined;
        const modReaches = (name: string): boolean =>
        {
            modCode ??= M.ordered(key).flatMap((f) => [...f.file.defs.values()].flat()).filter(isCode);
            // (an `#undef` of the name is no use of it)
            return modCode.some((d) => d.kind !== 'c-pp' && d.name !== name && spells(d, name));
        };
        // (a main's statements in order, comments and preprocessor lines left out: `text` with white space as one blank, `key` without it)
        const statementsOf = (text: string): { text: string; key: string; }[] =>
            text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/^[ \t]*#.*$/gm, ' ').split(/[;{}]/)
                .map((x) => ({ text: x.replace(/\s+/g, ' ').trim(), key: x.replace(/\s+/g, '') })).filter((x) => x.key);
        // (a function's return type and parameter types, qualifiers, names and default values left out)
        const signatureOf = (d: FxDef): { ret: string; params: string[]; } | undefined =>
        {
            const t = d.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
            const head = t.indexOf('{') < 0 ? t : t.slice(0, t.indexOf('{'));
            const open = head.indexOf('(');
            const close = head.lastIndexOf(')');

            if (open < 0 || close < open)
                return undefined;

            const list: string[] = [];
            let depth = 0;
            let from = open + 1;

            for (let i = open + 1; i <= close; i++)
            {
                const c = head[i];

                if (c === '(' || c === '[')
                    depth++;
                else if ((c === ')' || c === ']') && i < close)
                    depth--;
                else if ((c === ',' && depth === 0) || i === close)
                {
                    list.push(head.slice(from, i));
                    from = i + 1;
                }
            }

            const params = list.length === 1 && !list[0].trim() ? [] : list.map((p) => p.replace(/=[\s\S]*$/, '').replace(/:\s*\w+\s*$/, '').replace(/\b(?:in|out|inout|uniform|const)\b/g, ' ').trim().split(/\s+/).slice(0, -1).join(' '));
            return { ret: head.slice(0, open).trim().split(/\s+/).slice(0, -1).filter((w) => !/^(?:inline|static|precise)$/.test(w)).join(' '), params };
        };
        type HookTarget = { m: OverlayMacro; via?: string; hook?: string; } | { why: 'unused' | 'unfit'; via?: string; detail?: string; };
        const hookTarget = (m: OverlayMacro, s: 'vs' | 'ps'): HookTarget =>
        {
            if (modReaches(m.name))
                return { m };

            // (the other hooks of the overlay in this stage; of a name, the last one is what the stage sees)
            const hookOf = (name: string): OverlayMacro | undefined => macros.filter((x) => x.hook && x.name === name && x.name !== m.name && bareName(x.body) && (x.stage === 'both' || x.stage === s)).pop();
            const reached = (w: string): OverlayMacro | undefined =>
            {
                const seen = new Set<string>();

                for (const stack = [w]; stack.length;)
                {
                    const n = stack.pop()!;

                    if (seen.has(n))
                        continue;

                    seen.add(n);

                    for (const q of poolName.get(n) ?? [])
                        if (q.d.kind === 'c-function')
                            for (const r of refsOf(q.d))
                            {
                                const h = r.argc !== undefined ? hookOf(r.name) : undefined;

                                if (h)
                                    return h;

                                stack.push(r.name);
                            }
                }

                return undefined;
            };
            // the game's calls of the hook in its mains, and what the mod's copy of the same main does in their place: a statement between
            // the same neighbours (the nearest statements both have) that assigns the same target with a call of a function of its own
            const sites: { via: string; hook: OverlayMacro; argc: number; }[] = [];
            let calls = 0;

            for (const gm of [...gF!.file.defs.values()].flat().filter((d) => d.kind === 'main' && (d.stage === s || d.stage === 'both')))
            {
                const mm = mF.file.defs.get(gm.key)?.[0];
                const gs = statementsOf(gm.text);
                const ms = mm ? statementsOf(mm.text) : [];
                const mKeys = ms.map((x) => x.key);
                const gKeys = new Set(gs.map((x) => x.key));

                gs.forEach((st, i) =>
                {
                    const call = textRefs(st.text).find((r) => r.name === m.name && r.argc !== undefined);

                    if (!call)
                        return;

                    calls++;
                    const lhs = /^([\w.[\]]+)=(?!=)/.exec(st.key)?.[1];
                    let a = i - 1;
                    let b = i + 1;

                    while (a >= 0 && !mKeys.includes(gs[a].key))
                        a--;

                    while (b < gs.length && !mKeys.includes(gs[b].key))
                        b++;

                    const from = a >= 0 ? mKeys.indexOf(gs[a].key) + 1 : 0;
                    const end = b < gs.length ? mKeys.indexOf(gs[b].key, from) : -1;

                    for (const x of ms.slice(from, end < 0 ? ms.length : end))
                    {
                        const xm = /^([\w.[\]]+)=(?!=)([\s\S]*)$/.exec(x.key);

                        if (gKeys.has(x.key) || xm?.[1] !== lhs)
                            continue;

                        const w = /^([A-Za-z_]\w*)\(/.exec(xm ? xm[2] : x.key)?.[1];
                        const h = w && (poolName.get(w) ?? []).some((q) => q.d.kind === 'c-function') && !(visName.get(w) ?? []).some((q) => q.kind === 'c-function') ? reached(w) : undefined;

                        if (w && h)
                        {
                            sites.push({ via: w, hook: h, argc: call.argc! });
                            break;
                        }
                    }
                });
            }

            if (!sites.length)
                return { why: 'unused', detail: calls ? 'replaced' : 'other' };

            const h = sites[0].hook;
            const via = sites[0].via;

            if (sites.some((x) => x.hook.body !== h.body))
                return { why: 'unfit', via, detail: [...new Set(sites.map((x) => x.hook.body))].join(' / ') };

            // (the function the game's hook names: its types are what the call passes)
            const fns = (n: string): FxDef[] => [...(poolName.get(n) ?? []).map((q) => q.d), ...(visName.get(n) ?? [])].filter((x) => x.kind === 'c-function');
            const gameTargets = (visName.get(m.name) ?? []).filter((x) => x.kind === 'c-define' && bareName(defineBody(x.text)) && defineBody(x.text) !== h.body).map((x) => defineBody(x.text));
            const refs = [...gameTargets.flatMap(fns), ...(gameTargets.length ? [] : fns(m.body))];
            const same = (f: FxDef, r: FxDef, n: number): boolean =>
            {
                const a = signatureOf(f);
                const b = signatureOf(r);
                return !!a && !!b && a.ret === b.ret && a.params.slice(0, n).join(',') === b.params.slice(0, n).join(',');
            };
            const fits = (n: number): boolean => fns(h.body).some((f) => n <= arityOf(f.key) && n >= (f.minArgs ?? arityOf(f.key)) && (!refs.length || refs.some((r) => arityOf(r.key) === n && same(f, r, n))));
            const bad = sites.find((x) => !fits(x.argc));

            if (bad)
                return { why: 'unfit', via, detail: h.body };

            return { m: { ...m, body: h.body, line: `#define ${m.name} ${h.body}` }, via, hook: h.name };
        };

        for (const s of ['vs', 'ps'] as const)
        {
            const code = after(s);
            const blocked = new Set<string>();

            // (the block holds a stage's macros at one place: of a name defined again under the same condition (the top level's, then
            // a stage block's after `#undef`), the last one is what that stage's code sees)
            const inStage = macros.filter((x) => x.stage === 'both' || x.stage === s);

            for (const m0 of inStage.filter((x, i) => !inStage.slice(i + 1).some((y) => y.name === x.name && (y.cond ?? '') === (x.cond ?? ''))))
            {
                if (blocked.has(m0.name) || !code.some((d) => spells(d, m0.name)))
                    continue;

                const target = m0.hook ? hookTarget(m0, s) : { m: m0 };

                if (!('m' in target))
                {
                    blocked.add(m0.name);
                    notes.macrosLeft.push({ name: m0.name, stage: s, why: target.why, def: target.via ?? m0.body, ...(target.detail ? { detail: target.detail } : {}) });
                    continue;
                }

                const m = target.m;

                if (present(m))
                    continue;

                const decls = code.filter((d) => declares(d, m.name));
                const decl = decls[0];

                if (decl)
                {
                    // (a parameter or local of the game's functions in files this merge writes: renamed there, asked of that file; the
                    // next pass writes the macro. A field, a member access, a global, or a file the merge does not write: as it is)
                    const at = decls.map((d) => ({ d, file: fileOf.get(d) }));

                    if (at.every((x) => x.file && run.written.has(x.file) && renamable(x.d, m.name)))
                        for (const x of at)
                            run.renames.add(`${x.file}|${x.d.key}|${m.name}`);

                    blocked.add(m.name);
                    notes.macrosLeft.push({ name: m.name, stage: s, why: 'declared', def: label(decl) });
                    continue;
                }

                // (a bare function name stands for a call of each of its overloads)
                const bare = /^[A-Za-z_]\w*$/.test(m.body);
                const calls = bare ? (poolName.get(m.body) ?? []).filter((q) => q.d.kind === 'c-function').map((q) => `${m.body}(${Array.from({ length: arityOf(q.d.key) }, () => '0').join(',')})`) : [];
                const text = bare && calls.length ? calls.join(' ') : m.body;
                const seed: Pooled = { d: { key: `overlay:${m.name}@${s}`, kind: 'c-other', name: '', norm: text, text, stage: s, cond: m.cond }, file: mF, order: -1 };

                try
                {
                    const c = closure(seed, [s]);
                    c.set.delete(seed);
                    const skipped = [...c.set.keys()].find((p) => p.d.name && run.skip.has(key + '|' + p.d.name));

                    if (skipped)
                        throw new Unresolved({ kind: 'unavailable', def: m.name, name: skipped.d.name, detail: 'skip' });

                    for (const [p, st] of c.set)
                    {
                        const have = final.get(p) ?? final.set(p, new Set()).get(p)!;

                        for (const x of st)
                            have.add(x);
                    }

                    for (const i of c.includes)
                        addIncludes.add(i);

                    const named = new Set(textRefs(text).filter((r) => r.argc !== undefined).map((r) => r.name));
                    written.push({ m, stage: s, protos: [...c.set.keys()].filter((p) => p.d.kind === 'c-function' && named.has(p.d.name)).map((p) => p.d) });

                    if (target.via && target.hook)
                        notes.remapped.push({ name: m.name, stage: s, target: m.body, via: target.via, hook: target.hook });
                }
                catch (e)
                {
                    if (!(e instanceof Unresolved))
                        throw e;

                    blocked.add(m.name);
                    notes.macrosLeft.push({ name: m.name, stage: s, why: 'unresolved', def: e.reason.def, detail: `${e.reason.kind}: ${e.reason.name}` });
                }
            }
        }

        notes.overlays = [...new Set(written.map((w) => w.m.path))];

        for (const w of written)
        {
            const x = notes.macros.find((y) => y.name === w.m.name) ?? (notes.macros.push({ name: w.m.name, stages: [] }), notes.macros[notes.macros.length - 1]);

            if (!x.stages.includes(w.stage))
                x.stages.push(w.stage);
        }

        notes.flags = [...new Set(written.flatMap((w) => levelsOf(w.m.cond).map((l) => /^ifdef\s+(\w+)$/.exec(l.trim())?.[1] ?? '').filter(Boolean)))];
    }

    // the fields appended to the game's vertex structs that no carried code writes: not appended (the game's mains never write them, and
    // fxc refuses a struct passed as `out` that is not written whole); the merge is made again without them
    const carriedText = [...final.keys()].map((p) => p.d.text).join('\n');
    const unwritten = notes.fields.filter((f) => !writesField(carriedText, f.slice(f.indexOf('.') + 1)));

    if (unwritten.length)
        return { out: undefined as unknown as FxMerged, unwritten };

    // 4b. value carry: a single-line `#define NAME value` or a sampler's `File` / `Index` that both files have with another value takes
    // the mod's value in the game's text (a retune of the mod: the cloud shadows off, its lighting values) when the value names
    // nothing only the mod has, and (an `Index`) the texture id is not another sampler's in the stage. The rest of a definition
    // (a sampler's other lines) must be the same, or the mod changed more than a value and the game's stays.
    const valueEdits: { from: string; to: string; }[] = [];
    const valued = new Set<FxDef>();

    if (!own)
    {
        const gSrc0 = gF!.src;
        const onlyMods = (value: string): string | undefined =>
            [...value.replace(/\b\d[\w.]*/g, ' ').matchAll(/[A-Za-z_]\w*/g)].map((m) => m[0]).find((n) => !KEYWORDS.has(n) && !visName.has(n) && modNames.has(n));

        for (const [k, glist] of gF!.file.defs)
        {
            const mlist = mF.file.defs.get(k);
            const gd = glist[0];
            const md = mlist?.[0];

            if (!md || glist.length !== 1 || mlist!.length !== 1 || gd.norm === md.norm || (gd.cond ?? '') !== (md.cond ?? ''))
                continue;

            const from = gd.text;

            if (gSrc0.indexOf(from) < 0 || gSrc0.indexOf(from) !== gSrc0.lastIndexOf(from))
                continue;

            if (gd.kind === 'c-define' && md.kind === 'c-define')
            {
                const parse = (t: string): { head: string; value: string; tail: string; } | undefined =>
                {
                    const m = /^(#[ \t]*define[ \t]+\w+[ \t]+)(.*?)([ \t]*(?:\/\/.*)?)$/.exec(t);
                    return !m || t.includes('\n') || t.includes('/*') || /\\\s*$/.test(t) || !m[2] || m[2].startsWith('//') ? undefined : { head: m[1], value: m[2].replace(/\s+/g, ' '), tail: m[3] };
                };
                const gv = parse(gd.text.replace(/\r$/, ''));
                const mv = parse(md.text.replace(/\r$/, ''));

                if (!gv || !mv || gv.value === mv.value || !/^#[ \t]*define[ \t]+\w+[ \t]/.test(md.text) || onlyMods(mv.value))
                    continue;

                valueEdits.push({ from, to: gv.head + mv.value + gv.tail + ' ' + '// MOD-MERGE: the mod\'s value (the game\'s: `' + gv.value + '`)' + (from.endsWith('\r') ? '\r' : '') });
                notes.values.push({ name: gd.name, mod: mv.value, game: gv.value });
                valued.add(md);
            }
            else if (gd.kind === 'sampler' && md.kind === 'sampler')
            {
                const read = (t: string): { file?: string; index?: string; rest: string; } => ({
                    file: /\bFile\s*=\s*"([^"]*)"/.exec(t)?.[1],
                    index: /\bIndex\s*=\s*(-?\d+)/.exec(t)?.[1],
                    rest: t.replace(/\/\/[^\n]*|#[^\n]*/g, '').replace(/\bFile\s*=\s*"[^"]*"|\bIndex\s*=\s*-?\d+/g, '').replace(/\s+/g, ' ').trim()
                });
                const g1 = read(gd.text);
                const m1 = read(md.text);
                const fileDiff = g1.file !== undefined && m1.file !== undefined && g1.file !== m1.file;
                const indexDiff = g1.index !== undefined && m1.index !== undefined && g1.index !== m1.index;

                if (g1.rest !== m1.rest || (!fileDiff && !indexDiff) || (g1.file === undefined) !== (m1.file === undefined))
                    continue;

                if (indexDiff)
                {
                    const id = textureIdOf(m1.index, undefined);
                    // (or a texture file past the engine's file slots: the game's Index stays)
                    const clash = id === undefined || (m1.file !== undefined && !isFileSlot(m1.index!)) || stagesOf(gd.stage).some((s) => { const o = takenIds()[s].get(id); return !!o && o !== gd; });

                    if (clash)
                        continue;
                }

                let to = gd.text;
                const eolG = to.includes('\r\n') ? '\r\n' : '\n';

                if (fileDiff)
                    to = to.replace(/(\bFile\s*=\s*")[^"]*(")/, (_m, a: string, b: string) => a + m1.file + b);

                if (indexDiff)
                    to = to.replace(/(\bIndex\s*=\s*)-?\d+/, `$1${m1.index}`);

                const line = /^([ \t]*)[^\n]*\b(?:File|Index)\s*=/m.exec(to);
                const note = (line?.[1] ?? '\t\t') + '# MOD-MERGE: the mod\'s value (the game\'s: ' + [fileDiff ? g1.file : '', indexDiff ? 'Index ' + g1.index : ''].filter(Boolean).join(', ') + ')' + eolG;
                to = line ? to.slice(0, line.index) + note + to.slice(line.index) : to;
                valueEdits.push({ from, to });

                if (fileDiff)
                    notes.values.push({ name: gd.name + ' File', mod: m1.file!, game: g1.file! });

                if (indexDiff)
                    notes.values.push({ name: gd.name + ' Index', mod: m1.index!, game: g1.index! });

                valued.add(md);
            }
        }
    }

    // 4c. the flag the overlay macros are written under (`#ifdef PORTRAIT_WIDGET`) is set by the effects (their `Defines`), not by the
    // engine: a game effect whose copy in the mod's file has it gets it too, only the flag (the copy's other changes stay lost), so
    // that the game's effects the mod's assets use (a saddle on the dragon with the game's `portrait_attachment_pattern`) see the
    // macros as they did with the mod's file
    const flagEdits: { from: string; to: string; }[] = [];

    if (notes.flags.length)
    {
        const definesOf = (t: string): string[] => [...(/\bDefines\s*=\s*\{([^}]*)\}/.exec(t.replace(/#[^\n]*/g, ''))?.[1] ?? '').matchAll(/"([^"]*)"|([A-Za-z_]\w*)/g)].map((m) => m[1] ?? m[2]);
        const rest = (t: string): string => t.replace(/#[^\n]*/g, '').replace(/\bDefines\s*=\s*\{[^}]*\}/, '').replace(/\s+/g, ' ').trim();

        for (const [k, glist] of gF!.file.defs)
        {
            const mlist = k.startsWith('effect:') ? mF.file.defs.get(k) ?? [] : [];
            const want = notes.flags.filter((fl) => mlist.some((m) => definesOf(m.text).includes(fl)));

            for (const g of want.length ? glist : [])
            {
                const add = want.filter((fl) => !definesOf(g.text).includes(fl));

                if (!add.length || flagEdits.some((e) => e.from === g.text))
                    continue;

                const eolG = g.text.includes('\r\n') ? '\r\n' : '\n';
                const quoted = add.map((fl) => `"${fl}"`).join(' ');
                const note = ' ' + '# MOD-MERGE: the mod\'s flag for its macros above';
                const dm = /(\bDefines\s*=\s*\{)([^}]*?)(\s*\})/.exec(g.text);
                const to = dm ?
                    g.text.slice(0, dm.index) + dm[1] + dm[2] + ' ' + quoted + dm[3] + note + g.text.slice(dm.index + dm[0].length) :
                    g.text.replace(/\s*\}\s*$/, `${eolG}\tDefines = { ${quoted} }${note}${eolG}}`);
                flagEdits.push({ from: g.text, to });

                if (!notes.flagged.includes(g.name))
                    notes.flagged.push(g.name);

                // (a copy that differs from the game's effect by the flag only lost nothing)
                for (const m of mlist)
                    if (rest(m.text) === rest(to) && [...new Set(definesOf(m.text))].sort().join() === [...new Set(definesOf(to))].sort().join())
                        valued.add(m);
            }
        }
    }

    // what the mod changed in definitions both have: the game's stays (a definition under other conditions than the game's that no
    // effect reaches is as lost as one under the same)
    const carriedDefs = new Set([...[...final.keys()].map((p) => p.d), ...valued]);
    const lostDefs = new Set<FxDef>();

    for (const list of mF.file.defs.values())
    {
        for (const d of list)
        {
            const g = vis.get(keyNoStage(d));

            // (a vertex struct whose fields all came across (appended to the game's) lost nothing)
            if (d.kind === 'vstruct' && g && [...d.text.matchAll(FIELD_NAMES)].every((m) => g.some((x) => [...x.text.matchAll(FIELD_NAMES)].some((y) => y[1] === m[1]))))
                continue;

            if (g && !carriedDefs.has(d) && stagesOf(d.stage).every((s) => providers(d, s).length > 0) && !g.some((x) => x.norm === d.norm))
            {
                lostDefs.add(d);

                if (!notes.lost.includes(labelOf(d)))
                    notes.lost.push(labelOf(d));
            }
        }
    }

    // 4d. disabled-line carry (`disabledLines`): in a function or main of this file that stays the game's, the statements the mod's copy
    // commented out are commented out in the game's text too (not where the check found the game's effects failing with them: `noDisabled`);
    // a definition that is the mod's after that is no longer lost
    const disabledEdits: { from: string; to: string; }[] = [];

    for (const [k, list] of mF.file.defs)
    {
        const d = list[0];
        const glist = gF!.file.defs.get(k) ?? [];
        const gd = glist[0];

        if (list.length !== 1 || !lostDefs.has(d) || (d.kind !== 'main' && d.kind !== 'c-function') || !gd || glist.length !== 1 || (gd.cond ?? '') !== (d.cond ?? '') || run.noDisabled.has(key + '|' + k))
            continue;

        if (gF!.src.indexOf(gd.text) < 0 || gF!.src.indexOf(gd.text) !== gF!.src.lastIndexOf(gd.text))
            continue;

        const r = disabledLines(gd.text, d.text);

        for (const x of r.left)
            notes.disabledLeft.push({ def: labelOf(gd), line: x.line, why: x.why, name: x.name });

        if (!r.lines.length)
            continue;

        disabledEdits.push({ from: gd.text, to: r.text });
        notes.disabled.push({ def: labelOf(gd), key: k, lines: r.lines });

        // (nothing else of the mod's change is left: the definition is the mod's now)
        if (sameCode(r.text, d.text) && ![...lostDefs].some((x) => x !== d && labelOf(x) === labelOf(d)))
            notes.lost.splice(notes.lost.indexOf(labelOf(d)), 1);
    }

    // 5. what is written, in the mod's order: top-level blocks, code for both stages, the stage blocks, the effects
    type Group = { samplers: string[]; code: string[]; mains: string[]; };
    const stage: Record<'vs' | 'ps', Group> = { vs: { samplers: [], code: [], mains: [] }, ps: { samplers: [], code: [], mains: [] } };
    const bothCode: string[] = [];
    const top: string[] = [];
    const effects: string[] = [];

    // (the stages a carried definition is written for; none: the engine sees it twice (the check of the merged files found it, by the
    // definition's name or a member's), or the game's side has it)
    const writeStages = (p: Pooled, st: Set<string>): ('vs' | 'ps')[] =>
    {
        const d = p.d;

        if (run.skip.size && [d.name, ...(hasMembers(d) ? [...d.text.matchAll(FIELD_NAMES)].map((m) => m[1]) : [])].some((n) => n && run.skip.has(key + '|' + n)))
            return [];

        if (aliases.has(p))
            return ['vs', 'ps'];

        if (d.kind === 'effect' || d.kind === 'cbuffer' || d.kind === 'vstruct')
            return covered(d, 'ps') ? [] : stagesOf(d.stage);

        return stagesOf(d.stage).filter((s) => !covered(d, s) && (st.has('both') || st.has(s) || d.stage !== 'both'));
    };
    const sorted = [...final].sort((a, b) => a[0].order - b[0].order).map(([p, st]) => ({ p, st, stages: writeStages(p, st) }));
    // code for both stages goes into one block before the stage blocks, unless it uses code written in a stage block (the game's side
    // has that in the other stage only): then it is written in each stage block, after what it uses
    const sameGuards = (d: FxDef, stages: ('vs' | 'ps')[]): boolean => d.stage === 'both' && stages.length === 2 && guardOf(d, 'vs').join('\n') === guardOf(d, 'ps').join('\n');
    const inBoth = new Set(sorted.filter((x) => x.p.d.kind.startsWith('c-') && sameGuards(x.p.d, x.stages)).map((x) => x.p));
    const perStageNames = (): Set<string> => new Set(sorted.filter((x) => x.p.d.kind.startsWith('c-') && x.stages.length && !inBoth.has(x.p) && x.p.d.name).map((x) => x.p.d.name));

    for (let names = perStageNames(), moved = true; moved; names = perStageNames())
    {
        moved = false;

        for (const p of [...inBoth])
            if (refsOf(p.d).some((r) => names.has(r.name) && r.name !== p.d.name))
            {
                inBoth.delete(p);
                moved = true;
            }
    }

    for (const { p, stages } of sorted)
    {
        const d = p.d;

        if (!stages.length)
            continue;

        notes.carried.push(d.key + (stages.length === 1 && d.stage === 'both' ? ' -> ' + stages[0] : ''));

        if (d.kind.startsWith('c-'))
        {
            // (where the game has the definition in some builds only, the mod's is written for the others: another condition in front;
            // stages with different conditions get their own copy. A function the overlay block declares has its default values there:
            // HLSL takes them in the first declaration only)
            const guards = stages.map((s) => guardOf(d, s));
            const w = d.kind === 'c-function' && written.some((x) => x.protos.includes(d)) ? { ...d, text: withoutDefaults(d.text) } : d;

            if (inBoth.has(p))
                bothCode.push(withConditions(w, guards[0]));
            else
                stages.forEach((s, i) => stage[s].code.push(withConditions(w, guards[i])));
        }
        else if (d.kind === 'sampler')
        {
            const moved = rebound.get(p);

            for (const s of stages)
                stage[s].samplers.push(moved === undefined ? d.text : d.text.replace(/(\bIndex\s*=\s*)-?\d+/, `$1${moved}`));
        }
        else if (d.kind === 'main')
        {
            for (const s of stages)
                stage[s].mains.push(d.text);
        }
        else if (d.kind === 'effect')
            effects.push(d.text);
        else
            top.push(d.text);
    }

    // the includes the carried code needs and the game's file lacks
    const raw = (k: string): string => mFiles.flatMap((f) => f.file.includes).find((i) => fxKey(i) === k) ?? k;
    notes.includes = [...addIncludes].filter((i) => !gKeys.has(i));
    let gSrc = gF!.src;

    for (const e of [...valueEdits, ...disabledEdits])
        gSrc = gSrc.replace(e.from, () => e.to);

    for (const e of flagEdits)
        gSrc = gSrc.split(e.from).join(e.to);

    let out = gSrc;

    if (notes.includes.length)
    {
        const inc = scanFx(gSrc).find((x) => x.kind === 'Includes');
        const lines = notes.includes.map((i) => `\t"${raw(i)}"`).join(eol);

        out = inc ?
            gSrc.slice(0, inc.end - 1).replace(/\s*$/, '') + eol + '\t# MOD-MERGE: a file the mod\'s definitions below use' + eol + lines + eol + gSrc.slice(inc.end - 1) :
            `Includes = {${eol}${lines}${eol}}${eol}${eol}` + gSrc;
    }

    // the overlay macros (4a): an early block right after the Includes (before every stage block's code, after the declarations of
    // the names (constant buffers come first in what the engine builds), with the prototypes of the functions they name; a stage of
    // its own when the stages differ (the engine defines PIXEL_SHADER for the pixel stage, the game's own files test it)
    if (written.length)
    {
        const items = (s: 'vs' | 'ps'): { levels: string[]; line: string; }[] =>
        {
            const list = written.filter((w) => w.stage === s);
            const res: { levels: string[]; line: string; }[] = [];
            const protos = new Set<string>();

            for (const w of list)
                for (const f of w.protos)
                    if (!protos.has(f.key))
                    {
                        protos.add(f.key);
                        const head = f.text.slice(0, f.text.indexOf('{')).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
                        res.push({ levels: [...levelsOf(w.m.cond), ...levelsOf(f.cond)], line: head + ';' });
                    }

            const defined = new Set<string>();

            for (const w of list)
            {
                const levels = levelsOf(w.m.cond);

                // (a name defined before (in the block, or a hook the game defines) is undefined first)
                if (defined.has(w.m.name) || vis.has('def:' + w.m.name))
                    res.push({ levels, line: '#undef ' + w.m.name });

                defined.add(w.m.name);
                res.push({ levels, line: w.m.line });
            }

            return res;
        };
        const vs = items('vs');
        const ps = items('ps');
        const same = JSON.stringify(vs) === JSON.stringify(ps);
        const body = same ? writeLevels(vs, '\t', eol) : writeLevels([...vs.map((x) => ({ ...x, levels: ['ifndef PIXEL_SHADER', ...x.levels] })), ...ps.map((x) => ({ ...x, levels: ['ifdef PIXEL_SHADER', ...x.levels] }))], '\t', eol);
        const head = `# MOD-MERGE: the macros of the mod's ${notes.overlays.join(', ')} over the game's names; the functions they name are carried below (the include itself is not added)`;
        const early = head + eol + 'Code' + eol + '[[' + eol + body.replace(/\r?\n/g, eol) + eol + ']]';
        const inc = scanFx(out).find((x) => x.kind === 'Includes');
        out = inc ? out.slice(0, inc.end) + eol + eol + early + out.slice(inc.end) : early + eol + eol + out;
    }

    const codeBlock = (items: string[]): string => 'Code' + eol + '[[' + eol + items.join(eol + eol) + eol + ']]';
    const block = (name: string, g: Group): string =>
    {
        const parts = [...g.samplers, ...(g.code.length ? [codeBlock(g.code)] : []), ...g.mains];
        return parts.length ? name + ' =' + eol + '{' + eol + parts.map((q) => '\t' + q).join(eol + eol) + eol + '}' + eol + eol : '';
    };
    let tail = '';

    if (top.length || bothCode.length || effects.length || stage.vs.code.length + stage.vs.samplers.length + stage.vs.mains.length || stage.ps.code.length + stage.ps.samplers.length + stage.ps.mains.length)
    {
        tail += eol + '# MOD-MERGE: definitions of the mod\'s copy that the game\'s file lacks' + eol;

        if (top.length)
            tail += top.join(eol + eol) + eol + eol;

        if (bothCode.length)
            tail += codeBlock(bothCode) + eol + eol;

        tail += block('VertexShader', stage.vs) + block('PixelShader', stage.ps);

        if (effects.length)
            tail += effects.join(eol + eol) + eol;
    }

    // (every text in the game file's line ends)
    return { out: { key, text: out + tail.replace(/\r?\n/g, eol), game: gameText, notes }, unwritten: [] };
}

/**
 * The macros of the includes of the mod's copy of a file that overlay the game's names: an include only the mod has (no game file
 * of that path), which the game's copy of the file does not list, and which (or a file only the mod has that it includes) defines
 * (under a condition, or replacing a hook the game offers: `#ifndef NAME` / `#define NAME …` in the game's code) a macro named
 * like a name the game's side declares (a constant buffer member, a define, a function) whose body names a function of the mod's
 * own files (AGOT's `cw/agot_camera.fxh`: `#define CameraPosition Camera_Position_Mod()` under `PORTRAIT_WIDGET`, the portrait
 * camera moved back by marker decals; its `agot_vic3_fog_of_war.fxh`: `#define ApplyFogOfWar GameApplyFogOfWar`). Carrying only
 * the functions the mod's effects name would leave the game's code (which spells the names) as it is. The include itself cannot
 * join the game's list: what it includes declares the game's names again (AGOT: the portrait decal samplers). So the macros are
 * written into an early block of the game's file and the functions they name are carried (`mergeOnce`, 4a).
 */
function overlayMacros(src: FxSources, mod: FxLayers, key: string): OverlayMacro[]
{
    const modFile = mod.base(key);
    const gameSrc = src.game(key);

    if (!modFile || gameSrc === undefined)
        return [];

    const gameFile = parseLayer(key, gameSrc);
    const have = new Set(gameFile.includes);
    // the names the game's own file and its includes declare, and the hooks among its defines
    const names = new Set<string>();
    const hooks = new Set<string>();
    // (the game's defines by name and body: a define of the mod's that the game's side has as it is changes nothing; a merged file
    // merged again has the mod's own defines carried in it. Such a define stays among the macros found, though: it is the one its stage
    // sees over an earlier one of the name (the pixel stage's redefinition), and 4a skips it as present)
    const defined = new Set<string>();
    const seen = new Set<string>();
    const collect = (k: string, f: Layer | undefined): void =>
    {
        if (!f || seen.has(k))
            return;

        seen.add(k);

        for (const list of f.file.defs.values())
            for (const d of list)
            {
                if (d.name)
                    names.add(d.name);

                if (d.kind === 'c-define')
                    defined.add(d.name + ' ' + defineBody(d.text));

                if (d.kind === 'c-define' && levelsOf(d.cond).some((l) => /^ifndef\s+(\w+)$/.exec(l.trim())?.[1] === d.name))
                    hooks.add(d.name);

                if (hasMembers(d))
                    for (const m of d.text.matchAll(FIELD_NAMES))
                        names.add(m[1]);
            }

        for (const i of f.includes)
        {
            const t = src.game(i);
            collect(i, t === undefined ? undefined : parseLayer(i, t));
        }
    };
    collect(key, gameFile);

    // the functions of the mod's own files the mod's copy reaches
    const fns = new Set<string>();

    for (const l of mod.ordered(key))
        if (src.game(l.key) === undefined)
            for (const list of l.file.defs.values())
                for (const d of list)
                    if (d.kind === 'c-function')
                        fns.add(d.name);

    const out: OverlayMacro[] = [];

    for (const raw of modFile.file.includes)
    {
        const k = fxKey(raw);

        if (have.has(k) || src.game(k) !== undefined || src.mod(k) === undefined)
            continue;

        // (the include and what it includes that only the mod has)
        const keys: string[] = [k];
        const layers: Layer[] = [parseLayer(k, src.mod(k)!)];

        for (let n = 0; n < keys.length; n++)
            for (const i of layers[n].includes)
                if (src.game(i) === undefined && src.mod(i) !== undefined && !keys.includes(i))
                {
                    keys.push(i);
                    layers.push(parseLayer(i, src.mod(i)!));
                }

        const found: OverlayMacro[] = [];

        for (const l of layers)
            for (const list of l.file.defs.values())
                for (const d of list)
                {
                    if (d.kind !== 'c-define' || !names.has(d.name) || !(d.cond || hooks.has(d.name)) || out.some((o) => o.file === l.key))
                        continue;

                    const line = d.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '').replace(/[ \t]+$/gm, '').trim();
                    const body = line.replace(/^#\s*define\s+\w+(\([^)]*\))?/, '').trim();
                    found.push({ path: raw, file: l.key, name: d.name, body, line, stage: d.stage, cond: d.cond, ...(hooks.has(d.name) ? { hook: true } : {}) });
                }

        // (an overlay: one of its macros names a function of the mod's. The engine puts the code of the top level before the stage
        // blocks' code: per file, the top level's macros come first)
        if (found.some((m) => [...m.body.matchAll(/[A-Za-z_]\w*/g)].some((x) => fns.has(x[0]))) && found.some((m) => !defined.has(m.name + ' ' + defineBody(m.line))))
            out.push(...found.map((m, i) => ({ m, i })).sort((a, b) => keys.indexOf(a.m.file) - keys.indexOf(b.m.file) || (a.m.stage === 'both' ? 0 : 1) - (b.m.stage === 'both' ? 0 : 1) || a.i - b.i).map((x) => x.m));
    }

    return out;
}

/**
 * A restored file the game's border renderer draws with (`FxMergeOptions.borders`): the game's text, and in the notes what the mod's
 * copy would have brought (the overlay macros found for it, the mod's effects and other definitions the game's file lacks) and the
 * definitions the mod changed (`lost`, as in a merge). Only the plain statements the mod's copy adds to a vertex main are carried
 * (`vertexAdditions`; not where the check found the game's effects failing with them: `noAdditions`).
 */
function untouchedFile(key: string, mod: FxLayers, game: FxLayers, macros: OverlayMacro[], noAdditions: Set<string>): FxMerged
{
    const src = game.base(key)!.src;
    let text = src;
    const notes = emptyNotes();
    const gDefs = game.base(key)!.file.defs;
    const mDefs = mod.base(key)!.file.defs;
    const effects: string[] = [];
    let others = 0;
    const lost = new Set<FxDef>();

    for (const [k, list] of mDefs)
    {
        const g = gDefs.get(k);

        for (const d of list)
        {
            if (!g)
            {
                if (d.kind === 'effect')
                    effects.push(d.name);
                else
                    others++;
            }
            else if (!g.some((x) => x.norm === d.norm))
            {
                lost.add(d);

                if (!notes.lost.includes(labelOf(d)))
                    notes.lost.push(labelOf(d));
            }
        }
    }

    // the game's side as the vertex stage sees it: the members of its constant buffers, the fields of its structs, the definitions by key
    const tree = game.ordered(key);
    const members = new Set<string>();
    const fields = new Set<string>();
    const gameNames = new Set<string>();
    const gameNorms = new Map<string, Set<string>>();

    for (const f of tree)
        for (const list of f.file.defs.values())
            for (const d of list)
            {
                (gameNorms.get(keyNoStage(d)) ?? gameNorms.set(keyNoStage(d), new Set()).get(keyNoStage(d))!).add(d.norm);

                if (d.name)
                    gameNames.add(d.name);

                if (hasMembers(d))
                    for (const x of d.text.matchAll(FIELD_NAMES))
                    {
                        fields.add(x[1]);
                        gameNames.add(x[1]);

                        if (d.kind === 'cbuffer')
                            members.add(x[1]);
                    }
            }

    // (the names the mod's copy gives a meaning of its own: its overlay macros, and a name of the game's side that the copy or an include
    // only the mod has defines again, with another body; a name only the mod has is one the game's vertex stage does not see)
    const own = new Set(macros.map((x) => x.name));

    for (const f of mod.ordered(key))
    {
        if (f.key !== key && game.base(f.key))
            continue;

        for (const list of f.file.defs.values())
            for (const d of list)
                if (d.name && d.kind.startsWith('c-') && gameNames.has(d.name) && !gameNorms.get(keyNoStage(d))?.has(d.norm))
                    own.add(d.name);
    }

    const scope: VertexScope = { sees: (n) => members.has(n), field: (n) => fields.has(n), own: (n) => own.has(n) };

    for (const [k, list] of mDefs)
    {
        const d = list[0];
        const glist = gDefs.get(k) ?? [];
        const gd = glist[0];

        if (!k.startsWith('main:vs:') || list.length !== 1 || !lost.has(d) || glist.length !== 1 || (gd.cond ?? '') !== (d.cond ?? '') || noAdditions.has(key + '|' + k))
            continue;

        if (text.indexOf(gd.text) < 0 || text.indexOf(gd.text) !== text.lastIndexOf(gd.text))
            continue;

        const r = vertexAdditions(gd.text, d.text, scope);

        for (const x of r.left)
            notes.vertexLeft.push({ def: labelOf(gd), ...x });

        if (!r.lines.length)
            continue;

        text = text.replace(gd.text, () => r.text);
        notes.vertexLines.push({ def: labelOf(gd), key: k, lines: r.lines });

        // (nothing else of the mod's change is left: the definition is the mod's now)
        if (sameCode(r.text, d.text))
            notes.lost.splice(notes.lost.indexOf(labelOf(d)), 1);
    }

    // (the macros over a name the game's code of the file and its includes spells: the others would not have been written anyway)
    const code = tree.flatMap((f) => [...f.file.defs.values()].flat()).filter((d) => d.kind.startsWith('c-') || d.kind === 'main');
    const spelled = macros.filter((m) => code.some((d) => d.name !== m.name && refsOf(d).some((r) => r.name === m.name)));
    notes.border = { macros: [...new Set(spelled.map((m) => m.name))], overlays: [...new Set(spelled.map((m) => m.path))], effects, others };
    return { key, text, game: src, notes };
}

/** At most this many passes (a pass repeats while the files demand more of each other). */
const MAX_PASSES = 8;

/**
 * The merge of the mod's copies of game effect files (`restore`: their keys) over the game's: per file the game's text and
 * what the mod's copy adds. A file's includes are merged before it (the mod's other includes are read from the mod).
 *
 * `own`: the keys of the mod's own effect files (no game counterpart). They stay as they are, but the patch mod's merged
 * includes are what they include after it: what their effects need from the mod's copy of such an include is demanded of
 * that include like what an effect in another restored file needs, and an effect that still lacks something is reported.
 */
export function mergeShaders(src: FxSources, restore: string[], own: string[] = [], opts: FxMergeOptions = {}): FxMergeResult
{
    const mod = new FxLayers((key) => src.mod(key) ?? src.game(key));
    const kept = new Set(opts.keep ?? []);
    // (what a kept copy includes that only the mod has is part of the game's side as the engine loads it)
    const viaKept = new Set<string>();

    for (const stack = [...kept]; stack.length;)
        for (const i of mod.base(stack.pop()!)?.includes ?? [])
            if (!viaKept.has(i) && src.game(i) === undefined && src.mod(i) !== undefined)
            {
                viaKept.add(i);
                stack.push(i);
            }

    // (a file the game's border renderer draws with keeps the game's text: `untouchedFile`)
    const borders = new Set([...(opts.borders ?? [])].filter((k) => !kept.has(k)));
    // (the overlay macros: see `overlayMacros`; a file the check found failing with them goes without, and a border file: its macros
    // are only told)
    const overlays = new Map<string, OverlayMacro[]>();
    const borderMacros = new Map<string, OverlayMacro[]>();

    for (const key of restore.filter((k) => !kept.has(k) && !opts.noOverlay?.has(k)))
    {
        const found = overlayMacros(src, mod, key);

        if (found.length)
            (borders.has(key) ? borderMacros : overlays).set(key, found);
    }

    const game = new FxLayers((key) => src.game(key) ?? (viaKept.has(key) ? src.mod(key) : undefined));
    // (a file is merged when the game has one to start from)
    const files = restore.filter((key) => game.base(key) && mod.base(key));
    const restored = new Set(files);
    // (only `.shader` files are effect files the engine loads by themselves: an `.fxh` with effects in it (AGOT's agot_pdxmesh.fxh)
    // is part of the file that includes it, and the effects name mains that file defines. Those the restored files include
    // are carried by their merge)
    const ownFiles = own.filter((key) => /\.shader$/i.test(key) && !restored.has(key) && !game.base(key) && !!mod.base(key));
    const demands = new Set<string>();
    // (the files written from the game's text, and the declarations asked to be renamed in them: they repeat the passes like demands,
    // not a border file, whose text stays the game's)
    const written = new Set(files.filter((k) => !kept.has(k) && !borders.has(k)));
    const renames = new Set<string>();
    // (the structs a function of the game's takes as `out` or `inout`: the game's mains do not write a field of the mod's)
    const outStructs = new Set<string>();
    {
        const seen = new Set<string>();

        for (const key of files)
            for (const f of game.ordered(key, seen))
                for (const list of f.file.defs.values())
                    for (const d of list)
                        if (d.kind === 'c-function')
                            for (const m of d.text.matchAll(/\b(?:out|inout)\s+([A-Za-z_]\w*)\s+\w+/g))
                                outStructs.add(m[1]);
    }

    const skip = opts.skip ?? new Set<string>();
    const leave = opts.leave ?? new Map<string, DropReason>();
    const noDisabled = opts.noDisabled ?? new Set<string>();
    const noAdditions = opts.noAdditions ?? new Set<string>();
    let done = new Map<string, FxMerged>();
    let unserved: FxUnserved[] = [];

    for (let pass = 1; pass <= MAX_PASSES; pass++)
    {
        const before = demands.size + renames.size;
        game.clearOverrides();
        done = new Map();
        unserved = [];

        const visit = (key: string, stack: string[]): void =>
        {
            if (done.has(key) || stack.includes(key))
                return;

            const includes = new Set([...(game.file(key)?.includes ?? []), ...(mod.file(key)?.includes ?? [])]);

            for (const i of includes)
                if (restored.has(i))
                    visit(i, [...stack, key]);

            // (a kept copy is the engine's file as it stands: the others are merged against it)
            if (kept.has(key))
            {
                game.override(key, mod.base(key)!.src);
                done.set(key, { key, text: mod.base(key)!.src, game: game.base(key)!.src, notes: emptyNotes() });
                return;
            }

            // (a file the game's border renderer draws with: the game's text, nothing of the mod's)
            if (borders.has(key))
            {
                done.set(key, untouchedFile(key, mod, game, borderMacros.get(key) ?? [], noAdditions));
                return;
            }

            const merged = mergeFile(key, { mod, game, demands, outStructs, skip, leave, overlays, written, renames, noDisabled });
            done.set(key, merged);
            game.override(key, merged.text);
        };

        for (const key of files)
            visit(key, []);

        // (after all the restored files: they are the includes of the own files as the patch mod writes them)
        for (const key of ownFiles)
            unserved.push(...mergeFile(key, { mod, game, demands, outStructs, skip, leave, overlays, written, renames, noDisabled }, true));

        if (demands.size + renames.size === before)
            break;
    }

    return { files: done, unserved };
}
