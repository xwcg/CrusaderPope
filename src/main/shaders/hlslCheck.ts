/**
 * Checks of the HLSL a layered FX tree gives (hlsl.ts) without running a shader compiler, and the link to the Direct3D
 * compiler (d3d.ts) that turns a compile error into a finding with the files on both sides.
 *
 * A mod's effect files can break a game effect that the mod never touched: the merge adds an include, a constant buffer,
 * a sampler or a struct field to a file, and every effect that includes the file now holds it. The game's own checks
 * (the engine's HLSL builder, then the D3D compiler) say so only when the game runs; the static checks below are
 * properties of the declarations and need no compiler (all platforms):
 *
 * - `X3003` a constant buffer member declared in two buffers (HLSL members are global names; the same buffer name opened
 *   twice is fine as long as the members are different),
 * - a sampler or buffer texture declared twice in one stage (file-scope declarations count in both stages) and two
 *   samplers on one texture id (`binding`; the engine's rule is `textureId`),
 * - a struct, function or variable defined twice outside `#if` alternatives,
 * - `X3508` a field of a struct that a function takes as `out` / `inout` and no code writes.
 *
 * docs/shaders.md, "Offline verification".
 */
import { tr } from '../../shared/i18n.ts';
import { codeItems, COND_SEPARATOR } from '../mods/fxBlocks.ts';
import { compileHlsl, type D3dError, type D3dOptions, type D3dVerdict } from './d3d.ts';
import type { FxField, FxSampler, FxStruct } from './effect.ts';
import { prop, type HlslUnit } from './hlsl.ts';
import { fileSlotCount, isFileSlot, TEXTURE_ID_LIMIT, TEXTURE_IDS_1_20, textureIdOf, type TextureIdTable } from './textureIds.ts';

export { TEXTURE_ID_LIMIT, TEXTURE_IDS_1_20, type TextureIdTable };

export type FindingKind = 'cbuffer-member' | 'duplicate-declaration' | 'binding' | 'duplicate-definition' | 'unwritten-field' | 'compile';

export interface HlslFinding
{
    kind: FindingKind;
    /** the compiler's code for the same fault: `X3003`, `X3508`; `builder` for what the engine's HLSL builder says before the compiler */
    code: string;
    /** the name the fault is about (a member, a sampler, a function, a field) */
    name: string;
    message: string;
    /** the effect file that holds the faulty declaration */
    file: string;
    /** the other side: the file that declares the same name */
    partner?: string;
    /** a texture id clash: the other sampler's name */
    partnerName?: string;
    /** a texture id clash: the id the engine prints (`Ref Index: 101`) */
    id?: number;
}

/** names of the defines of a source (`NUM_SAMPLES 4` is NUM_SAMPLES) */
const defineNames = (defines: string[]): Set<string> => new Set(defines.map((d) => d.split(/\s+/)[0]));

/** whether the `@ifdef` conditions around a field hold under the defines */
const active = (f: FxField, defs: Set<string>): boolean => (f.cond ?? []).every((c) => defs.has(c.define) !== c.negate);

const where = (s: { file: string; }): string => s.file;

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Constant buffer members declared in two buffers (or twice in one). The D3D compiler: `X3003 redefinition of 'name'`.
 * A buffer may be written twice under one name (the engine glues them: `cbuffer pdx_hlsl_cb41` twice) as long as its
 * members differ.
 */
export function cbufferMembers(unit: HlslUnit): HlslFinding[]
{
    const defs = defineNames(unit.defines);
    const owners = new Map<string, FxStruct[]>();

    for (const cb of unit.cbuffers)
        for (const f of cb.fields)
            if (active(f, defs))
            {
                const list = owners.get(f.name) ?? [];
                list.push(cb);
                owners.set(f.name, list);
            }

    const out: HlslFinding[] = [];

    for (const [name, list] of owners)
    {
        if (list.length < 2)
            continue;

        const [first, second] = [list[0], list[1]];
        out.push({
            kind: 'cbuffer-member',
            code: 'X3003',
            name,
            message: tr('{name} is a member of two constant buffers: ConstantBuffer( {a} ) in {fileA} and ConstantBuffer( {b} ) in {fileB} (a member name is global in HLSL)', {
                name, a: first.name, b: second.name, fileA: where(first), fileB: where(second)
            }),
            file: where(second),
            partner: where(first)
        });
    }

    return out;
}

// ---------------------------------------------------------------------------------------------------------------------

/** the engine's texture id of a sampler (textureIds.ts): `Index = n` is the slot of `Ref = PdxTexture<n>`, `Ref = Name<k>` a range of the engine's named textures */
export function textureId(s: FxSampler, table: TextureIdTable = TEXTURE_IDS_1_20): number | undefined
{
    return textureIdOf(prop(s, 'Index'), prop(s, 'Ref'), table);
}

/** a sampler's binding as the engine's log shows it */
const binding = (s: FxSampler): string => (prop(s, 'Index') !== undefined ? 'Index ' + prop(s, 'Index') : 'Ref ' + (prop(s, 'Ref') ?? ''));

/**
 * Samplers and buffer textures of one stage declared twice, two samplers on one texture id, an `Index` that no id exists
 * for, and a texture file on an `Index` past the engine's file slots (textureIds.ts `fileSlotCount`). The first one of a pair is the stage's file-scope declaration (both stages), the second one is named, as the engine does.
 */
export function samplerBindings(unit: HlslUnit, table: TextureIdTable = TEXTURE_IDS_1_20): HlslFinding[]
{
    const out: HlslFinding[] = [];
    const byId = new Map<number, FxSampler>();
    const names = new Map<string, FxSampler>();

    for (const s of unit.declared)
    {
        if (/BufferTexture$/.test(s.kind))
        {
            const prev = names.get(s.name);

            if (prev)
                out.push({
                    kind: 'duplicate-declaration',
                    code: 'builder',
                    name: s.name,
                    message: tr('{name} is declared twice in one stage: in {fileA} and in {fileB}', { name: s.name, fileA: where(prev), fileB: where(s) }),
                    file: where(s),
                    partner: where(prev)
                });
            else
                names.set(s.name, s);

            continue;
        }

        const id = textureId(s, table);
        const index = prop(s, 'Index');

        if (index !== undefined && /^-?\d+$/.test(index) && id === undefined)
        {
            out.push({
                kind: 'binding',
                code: 'builder',
                name: s.name,
                message: tr('{name} is on Index {index}, which is no texture id of the engine (it has room for Index 0 to {last})', { name: s.name, index, last: TEXTURE_ID_LIMIT - 1 - table.PdxTexture[0] }),
                file: where(s)
            });
            continue;
        }

        // (a texture file on an Index past the engine's file slots: an id of another range, the file does not reach the stage)
        if (index !== undefined && id !== undefined && prop(s, 'File') !== undefined && !isFileSlot(index, table))
            out.push({
                kind: 'binding',
                code: 'builder',
                name: s.name,
                message: tr('{name} binds a texture file on Index {index}, past the engine’s {slots} slots for files (Index 0 to {last})', { name: s.name, index, slots: fileSlotCount(table), last: fileSlotCount(table) - 1 }),
                file: where(s)
            });

        if (id === undefined)
            continue;

        const prev = byId.get(id);

        if (!prev)
        {
            byId.set(id, s);
            continue;
        }

        const same = prev.name === s.name;
        out.push({
            kind: same ? 'duplicate-declaration' : 'binding',
            code: 'builder',
            name: s.name,
            message: same
                ? tr('{name} is declared twice in one stage: in {fileA} and in {fileB} (Texture Samplers have same binding index, texture id {id})', { name: s.name, fileA: where(prev), fileB: where(s), id })
                : tr('{name} ({key}) and {other} ({otherKey}) have the same texture id {id} (Texture Samplers have same binding index)', {
                    name: s.name, key: binding(s), other: prev.name, otherKey: binding(prev), id
                }),
            file: where(s),
            partner: where(prev),
            partnerName: prev.name,
            id
        });
    }

    return out;
}

// ---------------------------------------------------------------------------------------------------------------------

/** two conditions that can both hold: no condition, the same, or one nested in the other */
function together(a: string, b: string): boolean
{
    if (!a || !b || a === b)
        return true;

    const x = a.split(COND_SEPARATOR);
    const y = b.split(COND_SEPARATOR);
    const n = Math.min(x.length, y.length);
    return x.slice(0, n).every((l, i) => l === y[i]);
}

/**
 * A function, struct or variable defined twice in one stage outside `#if` alternatives. The D3D compiler: `redefinition`
 * (X3004 for a function, X3003 for a variable). Functions are the same by name and parameter types.
 */
export function duplicateDefinitions(unit: HlslUnit): HlslFinding[]
{
    const seen = new Map<string, { file: string; cond: string; }[]>();
    const out: HlslFinding[] = [];
    const reported = new Set<string>();

    for (const c of unit.codes)
    {
        for (const it of codeItems(c.code))
        {
            if (it.kind !== 'function' && it.kind !== 'struct' && it.kind !== 'var')
                continue;

            const list = seen.get(it.key) ?? [];
            const clash = list.find((x) => together(x.cond, it.cond));

            if (clash && !reported.has(it.key))
            {
                reported.add(it.key);
                const what = it.kind === 'function' ? tr('function') : it.kind === 'struct' ? tr('struct') : tr('variable');
                out.push({
                    kind: 'duplicate-definition',
                    code: it.kind === 'function' ? 'X3004' : 'X3003',
                    name: it.name,
                    message: tr('{what} {name} is defined twice: in {fileA} and in {fileB}', { what, name: it.name, fileA: clash.file, fileB: c.file }),
                    file: c.file,
                    partner: clash.file
                });
            }

            list.push({ file: c.file, cond: it.cond });
            seen.set(it.key, list);
        }
    }

    return out;
}

// ---------------------------------------------------------------------------------------------------------------------

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/**
 * A field of a struct that a function takes as `out` / `inout` and no code writes. fxc follows the writes through the
 * inlined calls and refuses (`X3508 output parameter not completely initialized`) when a field is never written; GLSL has
 * no such analysis. Typical cause: a mod's field appended to a game struct whose game code never sets it. Only the code the
 * main reaches counts (fxc compiles what is called, not everything declared), a write anywhere in it counts, and a struct
 * that is ever made whole (`(S)0` or `= { }`) is skipped.
 */
export function unwrittenFields(unit: HlslUnit): HlslFinding[]
{
    const defs = defineNames(unit.defines);
    // the callable things of the stage by name: functions (all overloads) and macros
    const byName = new Map<string, { text: string; fn?: boolean; }[]>();

    for (const c of unit.codes)
        for (const it of codeItems(stripComments(c.code)))
            if (it.kind === 'function' || it.kind === 'define')
            {
                const list = byName.get(it.name) ?? [];
                list.push({ text: it.text, fn: it.kind === 'function' });
                byName.set(it.name, list);
            }

    // what the main reaches
    const mainCode = stripComments(unit.main.code);
    const reached = new Set<string>();
    const queue = [mainCode];
    const texts = [mainCode];
    const takes = new Map<string, string>();

    while (queue.length)
        for (const m of queue.pop()!.matchAll(/\b([A-Za-z_]\w*)\b/g))
        {
            const defs2 = byName.get(m[1]);

            if (!defs2 || reached.has(m[1]))
                continue;

            reached.add(m[1]);

            for (const d of defs2)
            {
                queue.push(d.text);
                texts.push(d.text);

                if (d.fn)
                    for (const t of d.text.slice(0, Math.max(0, d.text.indexOf('{'))).matchAll(/\b(?:out|inout)\s+(\w+)\s+\w+/g))
                        takes.set(t[1], m[1]);
            }
        }

    const text = texts.join('\n');

    // the struct as the stage declares it (a later definition replaces an earlier one; a struct of the other stage's block is no struct here)
    const structs = new Map<string, FxStruct>();

    for (const pick of ['both', unit.stage])
        for (const f of unit.files)
            for (const st of f.structs)
                if ((st.stage ?? 'both') === pick)
                    structs.set(st.name, st);

    const out: HlslFinding[] = [];

    for (const [typeName, fn] of takes)
    {
        const st = structs.get(typeName);

        if (!st || new RegExp(`\\(\\s*${typeName}\\s*\\)\\s*0|\\b${typeName}\\s+\\w+\\s*=\\s*\\{`).test(text))
            continue;

        for (const f of st.fields)
        {
            if (!active(f, defs))
                continue;

            const written = new RegExp(`\\.${f.name}\\b(?:\\s*(?:\\.[xyzwrgba]{1,4}|\\[[^\\]]*\\]))*\\s*(?:=(?!=)|[-+*/%&|^]=|<<=|>>=|\\+\\+|--)`).test(text)
                || new RegExp(`(?:\\+\\+|--)\\s*\\w+\\.${f.name}\\b`).test(text);

            if (!written)
                out.push({
                    kind: 'unwritten-field',
                    code: 'X3508',
                    name: f.name,
                    message: tr('{field} of {struct} is written by no code, and {fn} takes {struct} as out or inout (output parameter not completely initialized)', { field: f.name, struct: typeName, fn }),
                    file: where(st)
                });
        }
    }

    return out;
}

// ---------------------------------------------------------------------------------------------------------------------

/** every static check on one source */
export function staticFindings(unit: HlslUnit): HlslFinding[]
{
    return [...cbufferMembers(unit), ...samplerBindings(unit), ...duplicateDefinitions(unit), ...unwrittenFields(unit)];
}

/** A compile error as a finding: the file of the faulty line, and for a redefinition the file that has the name first. */
export function explainCompileErrors(unit: HlslUnit, errors: D3dError[]): HlslFinding[]
{
    const src = unit.source.split('\n');
    const out: HlslFinding[] = [];
    const seen = new Set<string>();

    for (const e of errors)
    {
        const dedupe = `${e.code} ${e.msg}`;

        if (seen.has(dedupe))
            continue;

        seen.add(dedupe);
        const span = unit.spans.find((s) => e.line >= s.from && e.line <= s.to);
        const name = /'(\w+)'/.exec(e.msg)?.[1] ?? '';
        let partner: string | undefined;

        if (/redefinition/.test(e.msg) && name)
        {
            const re = new RegExp(`\\b${name}\\b`);
            partner = unit.spans.find((s) => s !== span && /^(ConstantBuffer|struct)/.test(s.block) && src.slice(s.from - 1, s.to).some((l) => re.test(l)))?.file;
        }

        out.push({
            kind: 'compile',
            code: e.code,
            name,
            message: `${e.code}: ${e.msg}`,
            file: span?.file ?? '',
            ...(partner ? { partner } : {})
        });
    }

    return out;
}

export interface UnitReport
{
    unit: HlslUnit;
    /** the static findings and, when a compiler ran, its errors */
    findings: HlslFinding[];
    /** null: no compiler here (static checks only) */
    compile: D3dVerdict;
}

/**
 * The static checks and, where this machine has the Direct3D compiler, the compile of every unit (once per distinct
 * source). A unit is clean when `findings` is empty and `compile.ok !== false`.
 */
export async function verifyUnits(units: HlslUnit[], opts: D3dOptions = {}): Promise<UnitReport[]>
{
    const distinct = new Map<string, number>();
    const batch: HlslUnit[] = [];

    for (const u of units)
        if (!distinct.has(u.sig))
        {
            distinct.set(u.sig, batch.length);
            batch.push(u);
        }

    const verdicts = await compileHlsl(batch.map((u) => ({ source: u.source, stage: u.stage })), opts);
    return units.map((unit) =>
    {
        const compile = verdicts[distinct.get(unit.sig)!];
        return { unit, compile, findings: [...staticFindings(unit), ...(compile.ok === false ? explainCompileErrors(unit, compile.errors) : [])] };
    });
}
