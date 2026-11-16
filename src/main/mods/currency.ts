/**
 * Whether a mod's copy of a game file is the new version's file already (migrate.ts `fileRules`: `restore`, `mergefx`). A
 * mod labelled for an older game can carry copies its author updated by hand, or ship the game's own file unchanged; the
 * rules that take the game's file for an older copy must leave those alone: what the copy adds to the game's file would be
 * lost for nothing.
 *
 * No version is known of a copy, only its text: it is **current** when it holds the game's file's lines. A copy of an older
 * version lacks what the new version added or changed, so it lacks lines; a copy that only adds to the new file or changes a
 * handful of its lines (the mod's own edits) does not. `CARRIES_TOLERANCE` is the share of the game's lines a copy may lack
 * (the mod's changed lines): the game's 1.20 `cooltip.gui` has 9,149 lines, Elder Kings 2's copy lacks 4 of them, A Game of
 * Thrones's 1.19 copy 277.
 */
import { FIELD_NAMES, fxDefinitions } from './fxBlocks.ts';
import { fxKey } from './shaderMerge.ts';

/** the share of the game's lines (without comments, a repeated one counted each time) that a copy of the new version may lack */
export const CARRIES_TOLERANCE = 0.001;

/** an effect file's preprocessor lines are code, not comments */
const DIRECTIVE = /^#\s*(?:define|undef|if|ifdef|ifndef|elif|else|endif|include|pragma|error|line)\b/;

/** The lines of a text, trimmed, without blank ones and comments. */
function linesOf(text: string): string[]
{
    const out: string[] = [];

    for (const raw of text.replace(/^﻿/, '').split(/\r?\n/))
    {
        const line = raw.trim();

        if (line && !line.startsWith('//') && !(line.startsWith('#') && !DIRECTIVE.test(line)))
            out.push(line);
    }

    return out;
}

/**
 * Whether the mod's copy holds the game's lines, all but the tolerance (its own changed lines). A line that repeats counts
 * each time (the game's tooltips file has 9,149 lines, 2,071 of them different; a copy lacking a whole block of widgets lacks
 * mostly lines that exist elsewhere in the file, `}` and `layoutpolicy_horizontal = expanding` among them). A game file with
 * no lines gives nothing to compare: only the file itself, byte for byte, is current (`copyState`).
 */
export function carriesGame(gameText: string, modText: string): boolean
{
    const game = linesOf(gameText);

    if (!game.length)
        return false;

    const have = new Map<string, number>();

    for (const line of linesOf(modText))
        have.set(line, (have.get(line) ?? 0) + 1);

    let missing = 0;

    for (const line of game)
    {
        const n = have.get(line) ?? 0;

        if (n > 0)
            have.set(line, n - 1);
        else
            missing++;
    }

    return missing <= Math.floor(game.length * CARRIES_TOLERANCE);
}

/**
 * Whether the mod's copy of an effect file declares everything the game's does: every definition (kind, name, parameter types,
 * stage, not the body) of the game's file is in it. A copy of an older version lacks what the new one added.
 */
export function declaresGame(gameText: string, modText: string): boolean
{
    const mod = fxDefinitions(modText.replace(/^﻿/, '')).defs;

    for (const key of fxDefinitions(gameText.replace(/^﻿/, '')).defs.keys())
        if (!mod.has(key))
            return false;

    return true;
}

/**
 * What the mod's copy of an effect file declares that the game's file does not: an `Includes` entry, a `TextureSampler` or
 * `BufferTexture`, a `ConstantBuffer`, a `VertexStruct`, a field of a `VertexStruct` the game's has (each as a short text for
 * (kind and name). A game file that includes one of those declares them for every effect of every file that includes it: the
 * game's constant buffer members are global names and a texture slot is the stage's, so a mod's declaration in a game include
 * collides with the game's own (AGOT: a portrait light rig buffer pulled into court_scene.shader's closure through an include
 * added to `jomini_mapobject.fxh`, the same `Light_Position_Radius` as the game's `SceneLightConstants`). Functions, defines
 * and effects do not matter here: code only counts when an effect reaches it, and the merge carries what it reaches.
 */
export function addedDeclarations(gameText: string, modText: string): { kind: 'include' | 'sampler' | 'cbuffer' | 'vstruct' | 'field'; name: string; }[]
{
    const game = fxDefinitions(gameText.replace(/^﻿/, ''));
    const mod = fxDefinitions(modText.replace(/^﻿/, ''));
    const out: { kind: 'include' | 'sampler' | 'cbuffer' | 'vstruct' | 'field'; name: string; }[] = [];
    const have = new Set(game.includes.map(fxKey));

    for (const i of mod.includes)
        if (!have.has(fxKey(i)))
            out.push({ kind: 'include', name: i });

    for (const [key, list] of mod.defs)
    {
        const d = list[0];

        if (d.kind !== 'sampler' && d.kind !== 'cbuffer' && d.kind !== 'vstruct')
            continue;

        const g = game.defs.get(key);

        if (!g)
        {
            out.push({ kind: d.kind === 'cbuffer' ? 'cbuffer' : d.kind === 'vstruct' ? 'vstruct' : 'sampler', name: d.name });
            continue;
        }

        if (d.kind === 'vstruct')
        {
            const names = new Set(g.flatMap((x) => [...x.text.matchAll(FIELD_NAMES)].map((m) => m[1])));

            for (const x of list)
                for (const m of x.text.matchAll(FIELD_NAMES))
                    if (!names.has(m[1]) && !out.some((x) => x.kind === 'field' && x.name === `${d.name}.${m[1]}`))
                        out.push({ kind: 'field', name: `${d.name}.${m[1]}` });
        }
    }

    return out;
}

/**
 * Whether the mod's copy of an effect file can stay as it is (the game's file with the mod's changes to code): it declares
 * every definition of the game's file (`declaresGame`) and adds no declaration to it (`addedDeclarations`). A copy that
 * adds some is merged like the others: the game's file and, behind it, what the mod's effects need.
 */
export function isDeclarationNeutral(gameText: string, modText: string): boolean
{
    return declaresGame(gameText, modText) && !addedDeclarations(gameText, modText).length;
}

/**
 * The current effect files that must be merged after all: each copy is judged alone, but a copy of the new version that
 * includes a file the mod's author added to it (the game's file has no such include) is written against the mod's copy of that
 * file: its sampler slots, its defines. When that copy is replaced or merged (the mod's changed definitions stay the game's),
 * the pair would no longer agree (two samplers in one slot, a define that is gone), so the including copy is merged too, as it
 * was before copies of the new version were left alone. A copy that is merged this way pulls in the copies that include it.
 * `current`: by the mod's path, the mod's text and the game's; `replaced`: the mod's paths of the copies that are not current.
 */
export function pairedWithReplaced(current: Map<string, { mod: string; game: string; }>, replaced: Iterable<string>): Set<string>
{
    const gone = new Set([...replaced].map(fxKey));
    const added = new Map<string, string[]>();

    for (const [rel, t] of current)
    {
        const own = new Set(fxDefinitions(t.game.replace(/^﻿/, '')).includes.map(fxKey));
        added.set(rel, fxDefinitions(t.mod.replace(/^﻿/, '')).includes.map(fxKey).filter((k) => !own.has(k)));
    }

    const out = new Set<string>();

    for (let more = true; more;)
    {
        more = false;

        for (const [rel, list] of added)
        {
            if (!out.has(rel) && list.some((k) => gone.has(k)))
            {
                out.add(rel);
                gone.add(fxKey(rel));
                more = true;
            }
        }
    }

    return out;
}
