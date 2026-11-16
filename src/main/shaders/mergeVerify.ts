/**
 * The check of merged effect files (mods/shaderRule.ts, docs/shaders.md "Verifying a merge"): every Effect of every top-level
 * effect file the merge touched, both stages, is built as the engine builds it (hlsl.ts) and checked: the static rules of
 * hlslCheck.ts on every machine, the Direct3D compiler (d3d.ts) where there is one.
 *
 * The candidate is a layering of text by file key (the written files over the mod's own over the game's); the baseline is the
 * game alone. A failure is the merge's only when the game's own unit passes: the same Effect and stage built from the game's
 * files with the same findings is `inherited` (the GUI shaders need engine defines this check does not model, the tools'
 * effects the same) and not reported. A mod's effect has no baseline, so what fails is reported, except a failure that
 * disappears when the defines the failing name is guarded by are set: the dragons' decal and particle effects rely on
 * `additional_shader_defines` of their `.asset` (`undecided`; they are not an error of the merge, and not decidable here).
 */
import { codeItems } from '../mods/fxBlocks.ts';
import { GameFiles } from '../mods/gamefiles.ts';
import { ShaderLibrary } from './compile.ts';
import { compileHlsl, type D3dError, type D3dOptions } from './d3d.ts';
import type { Stage } from './effect.ts';
import { generateHlsl, type HlslUnit } from './hlsl.ts';
import { explainCompileErrors, staticFindings, type HlslFinding } from './hlslCheck.ts';

/** The key of an effect file: its path below `gfx/FX`, in lower case. */
const keyOf = (rel: string): string => rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^gfx\/FX\//i, '').toLowerCase();

/** A shader library over text by file key: no game folder, the layering is the caller's. */
export class LayerLibrary extends ShaderLibrary
{
    private readonly reader: (key: string) => string | undefined;

    constructor(reader: (key: string) => string | undefined)
    {
        // (a game folder that does not exist: the reader answers for every file)
        super(new GameFiles('\0no-game-folder'));
        this.reader = reader;
    }

    override text(rel: string): string | undefined
    {
        return this.reader(keyOf(rel));
    }
}

export interface UnitIssue
{
    /** the top-level effect file (key) */
    file: string;
    effect: string;
    stage: Stage;
    findings: HlslFinding[];
    /** defines the failing code is guarded by, which only an `.asset` can set: the unit compiles with them */
    needs?: string[];
    /** the defines the unit was built with */
    defines?: string[];
    /** a variant build: the flags toggled against the effect's own `Defines` (`+FLAG` set, `-FLAG` taken out) */
    variant?: string[];
}

export interface VerifyReport
{
    roots: number;
    /** units checked (effect x stage) */
    units: number;
    /** units that fail and pass in no game-only build */
    issues: UnitIssue[];
    /** units that fail only because defines an `.asset` supplies are missing */
    undecided: UnitIssue[];
    /** units that fail the same way in the game alone (not the merge's) */
    inherited: number;
    /** which: `file: effect (stage)` */
    inheritedUnits: string[];
    /** the Direct3D compiler ran (the static rules always do) */
    compiled: boolean;
    /** units the compiler gave no verdict for although it ran (a batch it did not finish): they passed the static rules only */
    unchecked: number;
    /** variant builds (`VerifyOptions.variants`): how many, and those that fail (not the merge's to repair: the game builds the effects as they are) */
    variantUnits: number;
    variantIssues: UnitIssue[];
}

export interface VerifyOptions
{
    /** the files as the engine loads them with the merge written: by key */
    read: (key: string) => string | undefined;
    /** the game alone */
    baseline: (key: string) => string | undefined;
    /** the top-level effect files to check (keys) */
    roots: string[];
    /** the keys whose text is not the game's: a root is checked when its include closure holds one */
    changed: ReadonlySet<string>;
    /** run the Direct3D compiler where there is one (default true) */
    compile?: boolean;
    d3d?: D3dOptions;
    /** lets the caller yield to its event loop between slices */
    tick?: () => Promise<void>;
    /**
     * by file key: flags a file's code tests that the effects set in their `Defines` (the merge's overlay macros are written under
     * them): every Effect of a root whose include closure holds the file is built a second time with the flags toggled (set when its
     * `Defines` lack them, taken out when they have them), so the code under the flag is compiled in every effect and the code
     * without it too
     */
    variants?: Record<string, string[]>;
}

const tickOf = (o: VerifyOptions): (() => Promise<void>) => o.tick ?? (() => new Promise((r) => setImmediate(r)));

interface Built
{
    root: string;
    effect: string;
    stage: Stage;
    unit?: HlslUnit;
    error?: string;
    /** a variant build (`VerifyOptions.variants`): the flags toggled */
    variant?: string[];
}

/** A unit's key: root, effect, stage and the variant. */
const keyOfBuilt = (b: { root: string; effect: string; stage: Stage; variant?: string[]; }): string => `${b.root}|${b.effect}|${b.stage}|${(b.variant ?? []).join(' ')}`;

/** The units of the roots: every Effect with its stages, as the engine builds them (and with the variants' flags toggled). */
function build(lib: LayerLibrary, roots: string[], only?: Set<string>, variants: Record<string, string[]> = {}): Built[]
{
    const out: Built[] = [];

    for (const root of roots)
    {
        const flags = [...new Set(lib.ordered(root).flatMap((f) => variants[f.path] ?? []))];

        for (const name of lib.effectsWithIncludes(root))
        {
            const found = lib.effect(root, name, false);

            if (!found)
                continue;

            const own = found.effect.defines;
            const has = (fl: string): boolean => own.some((d) => d.split(/\s+/)[0] === fl);
            const toggled = flags.length ? [...own.filter((d) => !flags.includes(d.split(/\s+/)[0])), ...flags.filter((fl) => !has(fl))] : undefined;
            const variant = flags.map((fl) => (has(fl) ? '-' : '+') + fl);

            for (const stage of ['vs', 'ps'] as Stage[])
            {
                // (a compute effect, a stage-less one: nothing the engine builds as HLSL)
                if (!(stage === 'vs' ? found.effect.vs : found.effect.ps))
                    continue;

                if (!only || only.has(keyOfBuilt({ root, effect: name, stage })))
                {
                    const r = generateHlsl({ lib, file: root, effect: name, stage, salt: root });
                    out.push('error' in r ? { root, effect: name, stage, error: r.error } : { root, effect: name, stage, unit: r });
                }

                if (toggled && (!only || only.has(keyOfBuilt({ root, effect: name, stage, variant }))))
                {
                    const r = generateHlsl({ lib, file: root, effect: name, stage, defines: toggled, salt: root });
                    out.push('error' in r ? { root, effect: name, stage, error: r.error, variant } : { root, effect: name, stage, unit: r, variant });
                }
            }
        }
    }

    return out;
}

/** Names between quotes in compiler messages. */
const quoted = (errors: D3dError[]): string[] => [...new Set(errors.flatMap((e) => [...e.msg.matchAll(/'(\w+)'/g)].map((m) => m[1])))];

/**
 * The macros the definition of a name is guarded by in a unit's code (`#ifdef X`, `#if A && B`) and struct fields (`@ifdef X`)
 * that the unit does not define, as defines with a value (`NAME 1`): what an `.asset`'s `additional_shader_defines` or the engine
 * could supply.
 */
function guardsOf(unit: HlslUnit, names: string[]): string[]
{
    const set = new Set(unit.defines.map((d) => d.split(/\s+/)[0]));
    const out = new Set<string>();

    for (const f of unit.files)
        for (const s of [...f.structs, ...f.cbuffers])
            for (const field of s.fields)
                if (names.includes(field.name))
                    for (const c of field.cond ?? [])
                        if (!c.negate && !set.has(c.define))
                            out.add(c.define);

    for (const code of unit.codes)
    {
        for (const item of codeItems(code.code))
        {
            if (!item.cond || !(names.includes(item.name) || names.some((n) => new RegExp(`\\b${n}\\b`).test(item.text.split('{')[0]))))
                continue;

            for (const level of item.cond.split('~~COND~~'))
            {
                const m = /^(ifdef|if) (.*)$/s.exec(level);

                if (m)
                    for (const id of m[2].match(/[A-Za-z_]\w*/g) ?? [])
                        if (id !== 'defined' && !set.has(id) && /^[A-Z][A-Z0-9_]+$/.test(id))
                            out.add(id);
            }
        }
    }

    // (a macro the code names that nothing defines (the engine's own: PDX_GUI_MAX_NUM_SPRITES), as a value the code can take)
    for (const n of names)
        if (/^[A-Z][A-Z0-9_]{3,}$/.test(n) && !set.has(n))
            out.add(n);

    return [...out].map((n) => `${n} 1`);
}

/**
 * Checks the candidate layering. Slow parts yield to the event loop between slices (`opts.tick`): the caller is the app's main
 * process.
 */
export async function verifyLayering(opts: VerifyOptions): Promise<VerifyReport>
{
    const tick = tickOf(opts);
    const lib = new LayerLibrary(opts.read);
    const base = new LayerLibrary(opts.baseline);
    const affected = opts.roots.filter((root) => lib.ordered(root).some((f) => opts.changed.has(f.path)));
    const built = build(lib, affected, undefined, opts.variants);
    const report: VerifyReport = { roots: affected.length, units: built.filter((b) => !b.variant).length, issues: [], undecided: [], inherited: 0, inheritedUnits: [], compiled: false, unchecked: 0, variantUnits: built.filter((b) => b.variant).length, variantIssues: [] };
    const failing = new Map<Built, HlslFinding[]>();

    // 1. the static rules
    for (const [i, b] of built.entries())
    {
        if (i % 40 === 0)
            await tick();

        if (b.error)
            failing.set(b, [{ kind: 'compile', code: 'builder', name: b.effect, message: b.error, file: 'gfx/FX/' + b.root }]);
        else
        {
            const f = staticFindings(b.unit!);

            if (f.length)
                failing.set(b, f);
        }
    }

    // 2. the compiler
    if (opts.compile !== false)
    {
        const todo = built.filter((b) => b.unit && !failing.has(b));
        const verdicts: Awaited<ReturnType<typeof compileHlsl>> = [];
        const slice = 120;

        for (let i = 0; i < todo.length; i += slice)
        {
            await tick();
            verdicts.push(...await compileHlsl(todo.slice(i, i + slice).map((b) => ({ source: b.unit!.source, stage: b.stage })), opts.d3d));
        }

        report.compiled = verdicts.some((v) => v.ok !== null);
        report.unchecked = report.compiled ? verdicts.filter((v) => v.ok === null).length : 0;

        for (const [i, v] of verdicts.entries())
            if (v.ok === false)
                failing.set(todo[i], explainCompileErrors(todo[i].unit!, v.errors));
    }

    // 3. what the game alone does with the same unit (the failures that are not the merge's), and the defines an asset could supply
    const baseBuilt = build(base, [...new Set([...failing.keys()].map((b) => b.root))], new Set([...failing.keys()].map(keyOfBuilt)), opts.variants);
    const baseline = new Map(baseBuilt.map((b) => [keyOfBuilt(b), b]));
    const baseFail = new Map<string, Set<string>>();
    const baseTodo: Built[] = [];

    for (const b of baseBuilt)
    {
        const found = b.error ? [b.error] : b.unit ? staticFindings(b.unit).map((f) => f.code + f.name) : [];

        if (found.length)
            baseFail.set(keyOfBuilt(b), new Set(found));
        else if (b.unit)
            baseTodo.push(b);
    }

    if (opts.compile !== false && report.compiled && baseTodo.length)
    {
        const verdicts = await compileHlsl(baseTodo.map((b) => ({ source: b.unit!.source, stage: b.stage })), opts.d3d);

        for (const [i, v] of verdicts.entries())
            if (v.ok === false)
                baseFail.set(keyOfBuilt(baseTodo[i]), new Set(explainCompileErrors(baseTodo[i].unit!, v.errors).map((f) => f.code + f.name)));
    }

    const retry: { b: Built; findings: HlslFinding[]; guards: string[]; }[] = [];

    for (const [b, findings] of failing)
    {
        const key = keyOfBuilt(b);
        const theirs = baseFail.get(key);

        // (the game's own unit fails the same way)
        if (theirs && findings.every((f) => theirs.has(f.code + f.name) || b.error !== undefined))
        {
            if (!b.variant)
            {
                report.inherited++;
                report.inheritedUnits.push(`${b.root}: ${b.effect} (${b.stage})`);
            }

            continue;
        }

        const issue: UnitIssue = { file: b.root, effect: b.effect, stage: b.stage, findings, defines: b.unit?.defines, ...(b.variant ? { variant: b.variant } : {}) };
        const compileErrors = findings.filter((f) => f.kind === 'compile');
        const guards = b.unit && compileErrors.length === findings.length ? guardsOf(b.unit, quoted(compileErrors.map((f) => ({ line: 0, col: '', code: f.code, msg: f.message })))) : [];

        if (guards.length && !baseline.has(key))
            retry.push({ b, findings, guards });
        else
            (b.variant ? report.variantIssues : report.issues).push(issue);
    }

    // 4. a failure that goes with the guarding defines set is not decidable here
    if (retry.length)
    {
        const again = retry.map((r) =>
        {
            const g = generateHlsl({ lib, file: r.b.root, effect: r.b.effect, stage: r.b.stage, defines: [...r.b.unit!.defines, ...r.guards], salt: r.b.root + '+' });
            return 'error' in g ? undefined : g;
        });
        const todo = again.flatMap((u, i) => (u ? [i] : []));
        const verdicts = await compileHlsl(todo.map((i) => ({ source: again[i]!.source, stage: retry[i].b.stage })), opts.d3d);
        const ok = new Set(todo.filter((_, k) => verdicts[k].ok === true));

        for (const [i, r] of retry.entries())
        {
            const issue: UnitIssue = { file: r.b.root, effect: r.b.effect, stage: r.b.stage, findings: r.findings, needs: r.guards, defines: r.b.unit?.defines, ...(r.b.variant ? { variant: r.b.variant } : {}) };

            // (a variant that compiles with the asset's defines is as undecided as the effect itself: told once, by the effect)
            if (ok.has(i))
            {
                if (!r.b.variant)
                    report.undecided.push(issue);
            }
            else
                (r.b.variant ? report.variantIssues : report.issues).push({ ...issue, needs: undefined });
        }
    }

    return report;
}
