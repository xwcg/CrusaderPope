/**
 * Builds a 3D portrait (body, head, hair, clothes) for a character from game data — see docs/portraits.md.
 *
 * DNA (bookmark portrait, dna_data, or generated from the culture's ethnicity) → genes → attributes (common/genes)
 * → blend shapes and additive bone animations of each entity → body posed with its idle animation, head attached to
 * the body's spine, accessories (eyes, hair, clothes, headgear, …) on the head or body skeleton → CPU skinning →
 * geometry for three.js, plus palette colours for skin, eyes and hair. Historical characters are dressed by the
 * game's portrait modifiers evaluated against their history (modifiers.ts).
 */
import type { PNode } from '../indexer/parser.ts';
import type { Entity, GameIndex } from '../indexer/gameIndex.ts';
import { compose, decompose, invert, m4, mul, qinv, qmul, sampleJoint, type AnimFile, type Bone, type M4, type MeshPart, type Quat, type V3 } from './mesh.ts';
import { AssetLibrary, field, kids, scalar, splitTags, tagsMatch, type AssetInfo, type EntityDecl, type MeshDecl, type MeshSettings, type PortraitKind, type Range } from './assets.ts';
import type { PortraitData, PortraitDecal, PortraitEntityReport, PortraitPart, PortraitReport, PortraitVariation } from '../../shared/api.ts';
import { bakeDecals, dataMip, transparentDecal, type Baked, type BlendMode, type DecalLayer } from './decals.ts';
import type { Decoded } from '../images/dds.ts';
import { BOOKMARK_DATE, freshRun, History, PortraitModifiers, type CharacterFacts, type GeneState, type GeneValue, type ScriptRun, type TraitEntry } from './modifiers.ts';
import { defaultEffectFile } from '../../shared/shaders.ts';
import { GameStart } from './gameStart.ts';

type Gender = 'male' | 'female';

export interface PortraitOptions
{
    blendShapes?: boolean;
    boneMorphs?: boolean;
    accessories?: boolean;
    decals?: boolean;
    /** undressed as the game shows naked characters (with nudity enabled) */
    naked?: boolean;
    /** undressed adults wear the game's fig leaf (default); false leaves it off */
    figLeaf?: boolean;
}

/** Triggers the portrait modifiers use to undress a character (00_clothing_triggers.txt; should_show_nudity is the game setting). */
const NAKED_TRIGGERS = ['should_be_naked_trigger', 'should_be_fully_naked_portrait_trigger', 'should_show_nudity'];
/** Accessory genes nobody wears undressed (the clothes gene becomes the fig leaf) */
const NAKED_REMOVED = ['legwear', 'special_legwear', 'cloaks', 'clothes_hoods', 'headgear', 'additive_headgear', 'special_headgear_face_mask'];

const PALETTES = {
    skin: 'gfx/portraits/skin_palette.dds',
    hair: 'gfx/portraits/hair_palette.dds',
    eye: 'gfx/portraits/eye_palette.dds'
};

/** Accessory genes shown, in drawing order; the first three have a fixed default template when the DNA has none. */
const ACCESSORY_GENES = [
    'eye_accessory',
    'teeth_accessory',
    'eyelashes_accessory',
    'hairstyles',
    'beards',
    'legwear',
    'special_legwear',
    'clothes',
    'cloaks',
    'clothes_hoods',
    'headgear',
    'additive_headgear',
    'special_headgear_face_mask',
    'special_headgear_spectacles'
];
const ACCESSORY_DEFAULTS: Record<string, string> = { eye_accessory: 'normal_eyes', teeth_accessory: 'normal_teeth', eyelashes_accessory: 'normal_eyelashes' };

/** Small deterministic PRNG so generated faces stay the same between runs. */
function rng(seedText: string): () => number
{
    let h = 1779033703 ^ seedText.length;

    for (let i = 0; i < seedText.length; i++)
    {
        h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }

    let a = h >>> 0;
    return () =>
    {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Who is portrayed and with which genes. */
interface Subject
{
    label: string;
    gender: Gender;
    age: number;
    genes: Map<string, GeneValue>;
    /** accessory genes are final (bookmark portraits are dumps of rendered characters) */
    exact: boolean;
    culture?: string;
    /** history facts (culture, rank, government, …) for the portrait modifier triggers */
    facts?: CharacterFacts;
    seed: string;
    source: string;
}

interface Posed
{
    /** world matrix per bone name */
    bones: Map<string, M4>;
    /** skinning matrix (posed world · inverse bind of the owning mesh) per bone name, shared with attachments */
    skin: Map<string, M4>;
    /** skinning matrix for bones the owner lacks and for unskinned meshes (the attach point for heads) */
    root: M4;
}

type EntityRef = { asset: AssetInfo; entity: EntityDecl; mesh: MeshDecl; };

const boneName = (n: string): string => n.slice(n.lastIndexOf(':') + 1);

/** Viewer shading for a portrait shader (non-portrait models: see models.ts). */
export function partKind(shader: string | undefined): PortraitPart['kind']
{
    if (!shader)
        return 'cloth';

    if (shader.startsWith('portrait_skin'))
        return 'skin';

    if (shader === 'portrait_eye')
        return 'eye';

    if (shader.startsWith('portrait_hair'))
        return 'hair';

    if (shader === 'portrait_teeth')
        return 'teeth';

    return 'cloth';
}

export class PortraitBuilder
{
    private idx: GameIndex;
    /** shared with the model browser (same mesh and texture caches) */
    readonly lib: AssetLibrary;
    private modifiers: PortraitModifiers;
    private bookmarkByCharacter: Map<string, string> | null = null;
    /** baked decal textures (toggling features/proportions rebuilds the portrait with the same skin) */
    private bakeCache = new Map<string, Baked>();
    /** the game start's script state (gameStart.ts) */
    private gameStart: GameStart;
    /** meshes creatures show → the traits that show them (creatureMeshes) */
    private creatureMeshList: Map<string, Set<string>> | null = null;
    /** textures whose small mip carries values (carriesData) */
    private dataMips = new Map<string, boolean>();

    /** @param lib an asset library to keep (after an index update that changed no gfx file: its caches stay valid) */
    constructor(idx: GameIndex, history = new History(idx), lib?: AssetLibrary)
    {
        this.idx = idx;
        // the index's layering of game and mods; its gfx listing finds meshes and textures without touching the disk
        this.lib = lib ?? new AssetLibrary(idx.vfs, (rel) => idx.gfxFile(rel));
        this.modifiers = new PortraitModifiers(idx, history);
        this.gameStart = new GameStart(idx, this.modifiers.eval);
    }

    /** All textures of a material by role for the game shaders (diffuse/normal/properties may be replaced by bakes). */
    private partTextures(settings: MeshSettings | undefined): Record<string, string>
    {
        const out: Record<string, string> = {};

        for (
            const [role, rel] of [
                ['diffuse', settings?.diffuse],
                ['normal', settings?.normal],
                ['properties', settings?.properties]
            ] as const
        )
        {
            const t = this.texture(rel);

            if (t)
                out[role] = t;
        }

        for (const [index, rel] of Object.entries(settings?.extra ?? {}))
        {
            const t = this.texture(rel);

            if (t)
                out[`texture ${index}`] = t;
        }

        return out;
    }

    /** Texture path as declared, or the same file name elsewhere (eyelashes reuse the female textures). */
    private texture(rel: string | undefined): string | undefined
    {
        if (!rel)
            return undefined;

        return this.idx.resolveImagePath(rel, 'portraits')?.name;
    }

    private async sample(rel: string, xy: [number, number]): Promise<[number, number, number]>
    {
        const p = await this.lib.texture(rel);

        if (!p)
            return [1, 1, 1];

        const x = Math.round(Math.min(1, Math.max(0, xy[0])) * (p.width - 1));
        const y = Math.round(Math.min(1, Math.max(0, xy[1])) * (p.height - 1));
        const o = (y * p.width + x) * 4;
        return [p.rgba[o] / 255, p.rgba[o + 1] / 255, p.rgba[o + 2] / 255];
    }

    // -------------------------------------------------------------------------
    // Subjects and DNA
    // -------------------------------------------------------------------------

    /** `gene = { "template" 123 "template" 45 }`, colours `{ x y x y }` (0–255); the first pair is the active one. */
    private parseGenes(list: PNode[]): Map<string, GeneValue>
    {
        const out = new Map<string, GeneValue>();

        for (const g of list)
        {
            if (!g.k || !Array.isArray(g.v))
                continue;

            const vals = g.v.filter((x) => x.k === null && typeof x.v === 'string').map((x) => x.v as string);

            if (/_color$/.test(g.k) && vals.length >= 2)
                out.set(g.k, { value: 0, xy: [parseFloat(vals[0]) / 255, parseFloat(vals[1]) / 255] });
            else if (vals.length >= 2 && vals[0])
                out.set(g.k, { template: vals[0], value: parseFloat(vals[1]) / 255 });
        }

        return out;
    }

    private dnaGenes(dna: Entity): Map<string, GeneValue>
    {
        const d = this.idx.defNode(dna);
        return d ? this.parseGenes(kids(field(kids(field(kids(d.node), 'portrait_info')), 'genes'))) : new Map();
    }

    /** History character id → bookmark portrait (from the dump comment "# History database id:NNN"). */
    private bookmarkFor(characterId: string): Entity | undefined
    {
        if (!this.bookmarkByCharacter)
        {
            this.bookmarkByCharacter = new Map();
            const vfs = this.idx.vfs;
            const files = vfs.list('common/bookmark_portraits', { ext: /\.txt$/i, shallow: true }).map((f) => ({ f, name: f.rel.slice(f.rel.lastIndexOf('/') + 1) }));
            // prefer the main portrait over "_alt_" variants and animation tests
            files.sort((a, b) => Number(/_alt_|animation_test/.test(a.name)) - Number(/_alt_|animation_test/.test(b.name)) || a.name.localeCompare(b.name));

            for (const { f } of files)
            {
                const text = vfs.readText(f) ?? '';
                const re = /#\s*History database id:\s*(\d+)\s*\r?\n\s*([\w.-]+)\s*=/g;

                for (let m = re.exec(text); m; m = re.exec(text))
                    if (!this.bookmarkByCharacter.has(m[1]))
                        this.bookmarkByCharacter.set(m[1], m[2]);
            }
        }

        const name = this.bookmarkByCharacter.get(characterId);
        return name ? this.idx.get('bookmark_portraits', name) : undefined;
    }

    private bookmarkSubject(bm: Entity, label: string): Subject | undefined
    {
        const d = this.idx.defNode(bm);

        if (!d)
            return undefined;

        const body = kids(d.node);
        const type = scalar(field(body, 'type')) ?? 'male';
        const age = Math.round((parseFloat(scalar(field(body, 'age')) ?? '0.35') || 0.35) * 100);
        return {
            label,
            gender: type === 'female' || type === 'girl' ? 'female' : 'male',
            age,
            genes: this.parseGenes(kids(field(body, 'genes'))),
            exact: true,
            seed: bm.name,
            source: `Bookmark portrait "${bm.name}"`
        };
    }

    private subject(e: Entity): Subject | undefined
    {
        if (e.type === 'bookmark_portraits')
            return this.bookmarkSubject(e, e.name);

        if (e.type === 'dna_data')
        {
            const genes = this.dnaGenes(e);
            // dress it like the historical character using this DNA; else guess the sex from the gene templates
            const user = this.idx.incomingSources(e).find((x) => x.entity.type === 'characters')?.entity;
            const facts = user ? (this.modifiers.eval.history.facts(user.name) ?? undefined) : undefined;
            const female = facts ? facts.female : [...genes.values()].some((g) => g.template?.includes('female'));
            const age = facts ? Math.max(2, Math.min(90, facts.age)) : 35;
            const source = `DNA "${e.name}"` + (user ? ` (worn by character ${user.name})` : '');
            return { label: e.name, gender: female ? 'female' : 'male', age, genes, exact: false, culture: facts?.culture, facts, seed: user?.name ?? e.name, source };
        }

        if (e.type !== 'characters')
            return undefined;

        const d = this.idx.defNode(e);

        if (!d)
            return undefined;

        const body = kids(d.node);
        const rawName = scalar(field(body, 'name'));
        const label = rawName ? (this.idx.plainLoc(rawName) ?? rawName) : e.name;
        const facts = this.modifiers.eval.history.facts(e.name) ?? undefined;
        const gender: Gender = facts?.female ? 'female' : 'male';
        const culture = facts?.culture;
        const age = Math.max(2, Math.min(90, facts?.age ?? 35));
        // the face comes from the DNA entry, else from a bookmark dump of this character; clothes always come from the
        // portrait modifiers (dumps carry accessory values from older game versions whose accessory lists were shorter)
        const dnaKey = scalar(field(body, 'dna'));
        const dna = dnaKey ? this.idx.get('dna_data', dnaKey) : undefined;

        if (dna)
            return { label, gender, age, genes: this.dnaGenes(dna), exact: false, culture, facts, seed: e.name, source: `DNA "${dna.name}"` };

        const bm = this.bookmarkFor(e.name);
        const fromBookmark = bm && this.bookmarkSubject(bm, label);

        if (fromBookmark)
            return { ...fromBookmark, gender, age, exact: false, culture, facts, seed: e.name };

        const eth = this.cultureEthnicity(culture, e.name);
        return {
            label,
            gender,
            age,
            genes: this.ethnicityDna(eth ?? 'ethnicity_template', e.name),
            exact: false,
            culture,
            facts,
            seed: e.name,
            source: eth ? `Generated from ethnicity "${eth}"` : 'Generated from the default ethnicity'
        };
    }

    /** Gene option blocks of an ethnicity, following `template` and `using` inheritance. */
    private ethnicityGenes(name: string, depth = 0): Map<string, PNode>
    {
        const out = new Map<string, PNode>();
        const e = this.idx.get('ethnicities', name);

        if (!e || depth > 6)
            return out;

        const d = this.idx.defNode(e);

        if (!d)
            return out;

        const body = kids(d.node);

        for (const base of [scalar(field(body, 'template')), scalar(field(body, 'using'))])
        {
            if (base)
            {
                for (const [k, v] of this.ethnicityGenes(base, depth + 1))
                    out.set(k, v);
            }
        }

        for (const c of body)
            if (c.k && Array.isArray(c.v))
                out.set(c.k, c);

        return out;
    }

    private resolveNum(v: string | undefined, consts: Map<string, string>): number
    {
        if (v === undefined)
            return 0;

        if (v.startsWith('@'))
            v = consts.get(v.slice(1)) ?? '0';

        return parseFloat(v) || 0;
    }

    /** Generates genes from weighted ethnicity options (deterministic per character). */
    private ethnicityDna(ethnicity: string, seed: string): Map<string, GeneValue>
    {
        const rand = rng(seed);
        const out = new Map<string, GeneValue>();
        const e = this.idx.get('ethnicities', ethnicity);
        const consts = e ? this.idx.fileConstants(e) : new Map<string, string>();
        const tmpl = this.idx.get('ethnicities', 'ethnicity_template');
        const tconsts = tmpl ? this.idx.fileConstants(tmpl) : new Map<string, string>();
        const num = (v: string | undefined): number => (v?.startsWith('@') ? this.resolveNum(v, consts.has(v.slice(1)) ? consts : tconsts) : parseFloat(v ?? '0') || 0);

        for (const [gene, node] of this.ethnicityGenes(ethnicity))
        {
            const options = kids(node).filter((c) => c.k !== null && /^\d+(\.\d+)?$/.test(c.k) && Array.isArray(c.v));
            const chosen = weighted(options, (o) => parseFloat(o.k!), rand);

            if (!chosen)
                continue;

            const body = chosen.v as PNode[];

            if (/_color$/.test(gene))
            {
                const nums = body.filter((x) => x.k === null).map((x) => num(x.v as string));

                if (nums.length >= 4)
                    out.set(gene, { value: 0, xy: [nums[0] + rand() * (nums[2] - nums[0]), nums[1] + rand() * (nums[3] - nums[1])] });
            }
            else
            {
                const range = kids(field(body, 'range')).map((x) => num(x.v as string));
                const lo = range[0] ?? 0.5;
                const hi = range[1] ?? lo;
                out.set(gene, { template: scalar(field(body, 'name')), value: lo + rand() * (hi - lo) });
            }
        }

        return out;
    }

    private cultureEthnicity(culture: string | undefined, seed: string): string | undefined
    {
        const c = culture ? this.idx.get('culture/cultures', culture) : undefined;
        const d = c && this.idx.defNode(c);

        if (!d)
            return undefined;

        const options = kids(field(kids(d.node), 'ethnicities')).filter((x) => x.k && typeof x.v === 'string');
        return weighted(options, (o) => parseFloat(o.k!) || 0, rng(seed + ':ethnicity'))?.v as string | undefined;
    }

    // -------------------------------------------------------------------------
    // Genes → accessories, tags, attributes
    // -------------------------------------------------------------------------

    /** A gene template block (`common/genes`: gene = { template = { index male female boy girl set_tags } }). */
    private geneTemplate(gene: string, template: string): PNode[] | undefined
    {
        const e = this.idx.get('genes', gene);
        const d = e && this.idx.defNode(e);
        const t = d ? kids(d.node).find((c) => c.k === template && Array.isArray(c.v)) : undefined;
        return t ? (t.v as PNode[]) : undefined;
    }

    /** The block for a portrait type; `boy = male` style references are followed. */
    private typeBlock(tmpl: PNode[], kind: PortraitKind): PNode[]
    {
        let b = field(tmpl, kind);

        for (let i = 0; i < 3 && b && typeof b.v === 'string'; i++)
            b = field(tmpl, b.v);

        return kids(b);
    }

    /** Accessory picked by an accessory gene: the value (0..1) walks the cumulative weights of the template's list. */
    private accessoryFromGene(gene: string, g: GeneValue, kind: PortraitKind): string[]
    {
        const tmpl = g.template ? this.geneTemplate(gene, g.template) : undefined;

        if (!tmpl)
            return [];

        // `N = accessory` or `N = { clothes hood }` (several accessories worn together)
        const items = this.typeBlock(tmpl, kind).filter((c) => c.k && /^\d+(\.\d+)?$/.test(c.k));
        const total = items.reduce((s, c) => s + (parseFloat(c.k!) || 0), 0);

        if (!items.length || total <= 0)
            return [];

        let r = Math.min(0.9999, Math.max(0, g.value)) * total;
        const chosen = items.find((c) => (r -= parseFloat(c.k!) || 0) < 0) ?? items[items.length - 1];
        return typeof chosen.v === 'string' ? [chosen.v] : kids(chosen).map((x) => String(x.v));
    }

    private curveCache = new Map<string, { mode: string; points: [number, number][]; } | null>();

    /** An age preset from common/genes (`mode = multiply|add`, `curve = { { age/100 value } … }`). */
    private agePreset(name: string): { mode: string; points: [number, number][]; } | null
    {
        let p = this.curveCache.get(name);

        if (p !== undefined)
            return p;

        p = null;
        const e = this.idx.get('genes', name);
        const d = e && this.idx.defNode(e);

        if (d)
            p = { mode: scalar(field(kids(d.node), 'mode')) ?? 'multiply', points: curvePoints(field(kids(d.node), 'curve')) };

        this.curveCache.set(name, p);
        return p;
    }

    /** Every `age = preset` or inline `age = { mode curve }` of a setting/decal, applied in order (x = age/100). */
    private applyAge(list: PNode[], v: number, age01: number): number
    {
        for (const a of list)
        {
            if (a.k !== 'age')
                continue;

            const preset = typeof a.v === 'string' ? this.agePreset(a.v) : Array.isArray(a.v) ? { mode: scalar(field(a.v, 'mode')) ?? 'multiply', points: curvePoints(field(a.v, 'curve')) } : null;

            if (!preset?.points.length)
                continue;

            const f = interpolate(preset.points, age01);
            v = preset.mode === 'add' ? v + f : v * f;
        }

        return v;
    }

    /** Attribute values produced by the genes (settings of the portrait type's block), honouring `required_tags`. */
    private attributes(genes: Iterable<[string, GeneValue]>, kind: PortraitKind, age: number, tags: Set<string>): Map<string, number>
    {
        const out = new Map<string, number>();
        const age01 = age / 100;

        for (const [geneKey, g] of genes)
        {
            if (!g.template)
                continue;

            const tmpl = this.geneTemplate(geneKey, g.template);

            if (!tmpl)
                continue;

            const e = this.idx.get('genes', geneKey)!;
            const consts = this.idx.fileConstants(e);

            for (const s of this.typeBlock(tmpl, kind))
            {
                if (s.k !== 'setting' || !Array.isArray(s.v))
                    continue;

                const attr = scalar(field(s.v, 'attribute'));

                if (!attr)
                    continue;

                // `required_tags = "hat,not(hood_on)"`: only while wearing matching accessories
                if (!tagsMatch(scalar(field(s.v, 'required_tags')), tags))
                    continue;

                // gene strength → attribute value: linear `value = { min max }`, fixed `value = 1` or piecewise `curve`
                const valueNode = field(s.v, 'value');
                const curve = curvePoints(field(s.v, 'curve'));
                let v: number;

                if (valueNode && typeof valueNode.v === 'string')
                    v = this.resolveNum(valueNode.v, consts);
                else if (valueNode)
                {
                    const min = this.resolveNum(scalar(field(kids(valueNode), 'min')), consts);
                    const max = this.resolveNum(scalar(field(kids(valueNode), 'max')), consts);
                    v = min + (max - min) * g.value;
                }
                else if (curve.length)
                    v = interpolate(curve, g.value);
                else
                    continue;

                // age presets scale (multiply) or offset (add) the value by the character's age; several may apply
                v = this.applyAge(s.v, v, age01);
                out.set(attr, (out.get(attr) ?? 0) + v);
            }
        }

        return out;
    }

    /**
     * Decal layers per body part from the genes: `decal = { body_part textures alpha_curve blend_modes priority age
     * decal_apply_order uv_tiling required_tags }` in a template's type block; strength = alpha_curve(gene value)
     * (linear when absent) through the age presets.
     */
    private decalLayers(genes: Iterable<[string, GeneValue]>, kind: PortraitKind, age: number, tags: Set<string>, withProperties = false): Map<string, DecalLayer[]>
    {
        const out = new Map<string, DecalLayer[]>();
        const modes = new Set(['overlay', 'replace', 'hard_light', 'multiply']);

        for (const [geneKey, g] of genes)
        {
            const tmpl = g.template ? this.geneTemplate(geneKey, g.template) : undefined;

            if (!tmpl)
                continue;

            for (const d of this.typeBlock(tmpl, kind))
            {
                if (d.k !== 'decal' || !Array.isArray(d.v))
                    continue;

                if (!tagsMatch(scalar(field(d.v, 'required_tags')), tags))
                    continue;

                const curve = curvePoints(field(d.v, 'alpha_curve'));
                let weight = curve.length ? interpolate(curve, g.value) : g.value;
                weight = Math.min(1, Math.max(0, this.applyAge(d.v, weight, age / 100)));

                if (weight <= 0.002)
                    continue;

                const tex = kids(field(d.v, 'textures'));
                const bm = kids(field(d.v, 'blend_modes'));
                const mode = (k: string): BlendMode =>
                {
                    const m = scalar(field(bm, k));
                    return (m && modes.has(m) ? m : 'overlay') as BlendMode;
                };
                const tiling = kids(field(d.v, 'uv_tiling')).map((x) => parseFloat(String(x.v)) || 1);
                const layer: DecalLayer = {
                    diffuse: this.texture(scalar(field(tex, 'diffuse'))),
                    normal: this.texture(scalar(field(tex, 'normal'))),
                    properties: this.texture(scalar(field(tex, 'properties'))),
                    modes: { diffuse: mode('diffuse'), normal: mode('normal'), properties: mode('properties') },
                    weight,
                    priority: parseFloat(scalar(field(d.v, 'priority')) ?? '0') || 0,
                    post: scalar(field(d.v, 'decal_apply_order')) === 'post_skin_color',
                    tiling: tiling.length >= 2 ? [tiling[0], tiling[1]] : undefined
                };

                // properties-only decals (AGOT's metallic dragon scales) only matter to shaders reading the whole list
                if (!layer.diffuse && !layer.normal && !(withProperties && layer.properties))
                    continue;

                const part = scalar(field(d.v, 'body_part')) ?? 'head';
                (out.get(part) ?? out.set(part, []).get(part)!).push(layer);
            }
        }

        return out;
    }

    // -------------------------------------------------------------------------
    // Skeletons and meshes
    // -------------------------------------------------------------------------

    /**
     * Additive animations driven by an entity's attributes (u = default + value) — only attributes some gene setting
     * drives: `body_hunchbacked`, `body_no_left_arm` and `body_clubfooted` default to 0.5 but are neutral (bind pose) at
     * u = 0, so applied from their default they bent every spine and shrank every left arm to 63 %; their genes add
     * 0..1 on top for carriers. Women's `body_prop` (default 1) is driven by gene_retargeting_fix. `active` marks the
     * ones a gene moved away from the default.
     */
    private additives(ref: EntityRef, attrs: Map<string, number>, rec?: PortraitEntityReport): { anim: AnimFile; u: number; active: boolean; }[]
    {
        const out: { anim: AnimFile; u: number; active: boolean; }[] = [];

        for (const [attr, decl] of ref.entity.attributes)
        {
            if (!decl.additive || !attrs.has(attr))
                continue;

            const file = ref.asset.additive.get(decl.additive);
            const anim = file ? this.lib.anim(file) : undefined;

            if (!anim)
                continue;

            const u = Math.min(1, Math.max(0, decl.def + (attrs.get(attr) ?? 0)));
            const active = Math.abs(u - decl.def) > 0.002;
            out.push({ anim, u, active });

            if (active)
                rec?.boneMorphs.push({ attribute: attr, animation: file!, u });
        }

        return out;
    }

    /** Report entry for an entity (Expert tab); filled while its geometry is built. */
    private entityReport(ref: EntityRef, role: string, pose: PortraitEntityReport['pose'], accessory?: string): PortraitEntityReport
    {
        const mesh = this.lib.mesh(ref.mesh.file);
        const idleId = ref.entity.states.get(ref.entity.defaultState ?? 'none');
        return {
            role,
            accessory,
            entity: ref.entity.name,
            asset: ref.asset.rel,
            assetAbs: this.lib.where(ref.asset.rel),
            mesh: ref.mesh.file,
            meshAbs: this.lib.where(ref.mesh.file),
            pose,
            bones: mesh?.bones.length ?? 0,
            idle: idleId ? ref.asset.animations.get(idleId) : undefined,
            parts: [],
            blendShapes: [],
            boneMorphs: []
        };
    }

    /** The entity's resting animation (default state, e.g. body_idle_1). */
    private idleAnim(ref: EntityRef): AnimFile | undefined
    {
        const id = ref.entity.states.get(ref.entity.defaultState ?? 'none');
        const file = id ? ref.asset.animations.get(id) : undefined;
        return file ? this.lib.anim(file) : undefined;
    }

    /**
     * World matrices per bone name: local transforms from the base animation's first frame (else the bind pose),
     * additive animation deltas on top, and `attach` joints pinned to world transforms of another skeleton.
     * Additive deltas are measured from the bind pose: height or infant proportions are neutral mid-animation, fat,
     * dwarf, cloak and prop at the start — measuring every one from u = 0.5 turned "no dwarfism" into an inverted
     * dwarf morph (wide, heavy torsos, most visible on small children).
     */
    private pose(bones: Bone[], additive: { anim: AnimFile; u: number; }[], base?: AnimFile, attach?: Map<string, M4>, origin?: M4): Posed
    {
        const world0 = bones.map((b) => invert(b.invBind));
        const bindLocal = new Map(bones.map((b, i) => [boneName(b.name), decompose(b.parent >= 0 ? mul(invert(world0[b.parent]), world0[i]) : world0[i])]));
        const deltas = new Map<string, { t: V3; q: Quat; s: V3; }>();

        for (const { anim, u } of additive)
        {
            for (const j of anim.joints)
            {
                const ref = bindLocal.get(j.name);

                if (!j.channels || !ref)
                    continue;

                const cur = sampleJoint(j, anim.frames, u);
                let d = deltas.get(j.name);

                if (!d)
                    deltas.set(j.name, d = { t: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });

                // only the animated channels: static ones may differ from the bind pose without meaning anything
                if (j.channels.includes('t'))
                    d.t = [d.t[0] + cur.t[0] - ref.t[0], d.t[1] + cur.t[1] - ref.t[1], d.t[2] + cur.t[2] - ref.t[2]];

                if (j.channels.includes('q'))
                    d.q = qmul(d.q, qmul(qinv(ref.q), cur.q));

                if (j.channels.includes('s'))
                    d.s = [d.s[0] * (cur.s[0] / (ref.s[0] || 1)), d.s[1] * (cur.s[1] / (ref.s[1] || 1)), d.s[2] * (cur.s[2] / (ref.s[2] || 1))];
            }
        }

        const baseJoints = new Map((base?.joints ?? []).map((j) => [j.name, j]));
        const world: M4[] = [];
        const out = new Map<string, M4>();
        const skinMats = new Map<string, M4>();

        for (let i = 0; i < bones.length; i++)
        {
            const b = bones[i];
            const name = boneName(b.name);
            const bj = baseJoints.get(name);
            const local0 = bj ? sampleJoint(bj, base!.frames, 0) : decompose(b.parent >= 0 ? mul(invert(world0[b.parent]), world0[i]) : world0[i]);
            const d = deltas.get(name);
            const lt: V3 = d ? [local0.t[0] + d.t[0], local0.t[1] + d.t[1], local0.t[2] + d.t[2]] : local0.t;
            const lq: Quat = d ? qmul(local0.q, d.q) : local0.q;
            const ls: V3 = d ? [local0.s[0] * d.s[0], local0.s[1] * d.s[1], local0.s[2] * d.s[2]] : local0.s;
            const parent = b.parent >= 0 ? world[b.parent] : undefined;
            const pinned = attach?.get(name);

            if (pinned)
                world[i] = pinned;
            else if (parent && attach?.has(boneName(bones[b.parent].name)))
            {
                // below an attachment joint the body's scale places the child but does not size it (scale compensation):
                // the head keeps its own proportions (head_infant_proportions, head_body_height) — inheriting the body's
                // scale gave children tiny heads on seemingly huge bodies
                const p = decompose(parent);
                world[i] = mul(compose(p.t, p.q, [1, 1, 1]), compose([lt[0] * p.s[0], lt[1] * p.s[1], lt[2] * p.s[2]], lq, ls));
            }
            else
            {
                const local = compose(lt, lq, ls);
                // a creature's root sits at the body locator it is attached to
                world[i] = parent ? mul(parent, local) : origin ? mul(origin, local) : local;
            }

            out.set(name, world[i]);
            skinMats.set(name, mul(world[i], b.invBind));
        }

        return { bones: out, skin: skinMats, root: (bones[0] && skinMats.get(boneName(bones[0].name))) ?? m4() };
    }

    /**
     * Skinning matrices for a mesh skeleton. Attachments share the owner's palette by bone name (their own bind
     * matrices may live in another space, e.g. teeth bound in full-body space); a bone the owner lacks keeps its bind
     * pose relative to its parent, which means it inherits the parent's skinning matrix.
     */
    private skinMatrices(bones: Bone[], posed: Posed): M4[]
    {
        const mats: M4[] = [];
        bones.forEach((b, i) =>
        {
            mats[i] = posed.skin.get(boneName(b.name)) ?? (b.parent >= 0 && mats[b.parent] ? mats[b.parent] : posed.root);
        });
        return mats;
    }

    /**
     * Geometry of an entity: blend shapes from its attributes, then skinned with the given pose. `rigidFix` removes the
     * rigid offset some human targets were exported with; creature targets move whole wings, so theirs stay.
     */
    private async entityParts(
        ref: EntityRef,
        attrs: Map<string, number>,
        posed: Posed,
        shapes: boolean,
        seed: string,
        group?: string,
        rec?: PortraitEntityReport,
        rigidFix = true
    ): Promise<PortraitPart[]>
    {
        const file = this.lib.mesh(ref.mesh.file);

        if (!file)
            return [];

        const mats = file.bones.length ? this.skinMatrices(file.bones, posed) : [];
        const out: PortraitPart[] = [];

        for (let pi = 0; pi < file.parts.length; pi++)
        {
            const part = file.parts[pi];
            const settings = ref.mesh.settings.find((s) => s.name === part.shape) ?? ref.mesh.settings[pi] ?? ref.mesh.settings[0];
            const pos = Float32Array.from(part.positions);
            const nrm = Float32Array.from(part.normals);
            const tan = part.tangents ? Float32Array.from(part.tangents) : undefined;

            if (shapes)
                this.applyBlendShapes(ref, attrs, part, pi, pos, nrm, pi === 0 ? rec?.blendShapes : undefined, rigidFix);

            skin(pos, nrm, part, mats, posed.root, tan);
            const shader = settings?.shader ?? part.material.shader;
            const kind = partKind(shader);

            if (rec)
            {
                const min: [number, number, number] = [Infinity, Infinity, Infinity];
                const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

                for (let i = 0; i < pos.length; i++)
                {
                    if (pos[i] < min[i % 3])
                        min[i % 3] = pos[i];

                    if (pos[i] > max[i % 3])
                        max[i % 3] = pos[i];
                }

                rec.parts.push({ shape: part.shape, vertices: pos.length / 3, triangles: part.indices.length / 3, shader, diffuse: settings?.diffuse, min, max });
            }

            out.push({
                name: part.shape,
                kind,
                group,
                cutout: /alpha_to_coverage|^portrait_hair/.test(shader ?? ''),
                positions: pos,
                normals: nrm,
                uvs: part.uvs,
                uvs2: part.uvs2,
                tangents: tan,
                indices: part.indices,
                shader,
                shaderFile: settings?.shaderFile ?? defaultEffectFile(shader),
                shaderDefines: settings?.defines,
                textures: this.partTextures(settings),
                diffuse: this.texture(settings?.diffuse),
                normal: this.texture(settings?.normal),
                properties: this.texture(settings?.properties),
                variation: kind === 'cloth' && /pattern|variations/.test(shader ?? '') ? await this.variationFor(ref.entity, seed) : undefined
            });
        }

        return out;
    }

    /**
     * Colour patterns of a clothing entity (accessory variation): one weighted pattern set and palette, a palette row
     * and layout values picked per character, like the game's per-instance random number.
     */
    private async variationFor(ent: EntityDecl, seed: string): Promise<PortraitVariation | undefined>
    {
        const v = ent.patternMask && ent.variation ? this.lib.variation(ent.variation) : undefined;
        const mask = this.texture(ent.patternMask);

        if (!v || !mask)
            return undefined;

        const rand = rng(seed + ':' + ent.variation);
        const pattern = weighted(v.def.patterns, (p) => p.weight, rand);
        const pal = weighted(v.def.palettes, (p) => p.weight, rand);
        const palTex = pal && (await this.lib.texture(pal.texture));

        if (!pattern || !palTex)
            return undefined;

        const row = Math.min(palTex.height - 1, Math.floor(rand() * palTex.height));
        const palette: [number, number, number][] = [];

        for (let x = 0; x < palTex.width; x++)
        {
            const o = (row * palTex.width + x) * 4;
            palette.push([palTex.rgba[o] / 255, palTex.rgba[o + 1] / 255, palTex.rgba[o + 2] / 255]);
        }

        const pick = (r: Range): number => r[0] + rand() * (r[1] - r[0]);
        const patterns = pattern.channels.map((ch) =>
        {
            const set = ch ? v.texture(ch.textures) : undefined;
            const colormask = this.texture(set?.colormask);

            if (!ch || !colormask)
                return null;

            const layoutName = ch.layouts[Math.floor(rand() * ch.layouts.length)];
            const lay = layoutName ? v.layout(layoutName) : undefined;
            return {
                colormask,
                properties: this.texture(set?.properties),
                normal: this.texture(set?.normal),
                scale: (lay && pick(lay.scale)) || 1,
                rotation: lay ? (pick(lay.rotation) * Math.PI) / 180 : 0,
                offset: (lay ? [pick(lay.offset[0]), pick(lay.offset[1])] : [0, 0]) as [number, number]
            };
        });
        return { mask, patterns, palette };
    }

    private applyBlendShapes(
        ref: EntityRef,
        attrs: Map<string, number>,
        part: MeshPart,
        pi: number,
        pos: Float32Array,
        nrm: Float32Array,
        rec?: PortraitEntityReport['blendShapes'],
        rigidFix = true
    ): void
    {
        for (const [attr, decl] of ref.entity.attributes)
        {
            if (!decl.blendShape)
                continue;

            const w = attrs.get(attr) ?? 0;
            const active = Math.abs(w) >= 0.001;

            if (!active && !rec)
                continue;

            const file = ref.mesh.blendShapes.get(decl.blendShape);
            const target = file ? this.lib.mesh(file)?.parts[pi] : undefined;
            const note = (status: 'applied' | 'zero' | 'missing' | 'topology', detail?: string): void =>
            {
                rec?.push({ attribute: attr, target: file ?? decl.blendShape!, weight: w, status, detail });
            };

            if (!target)
            {
                note('missing', file ? 'file not found' : `blend shape "${decl.blendShape}" not declared on the pdxmesh`);
                continue;
            }

            // some legacy "nBs" targets have another topology
            if (target.positions.length !== pos.length)
            {
                note('topology', `${target.positions.length / 3} vertices, mesh has ${pos.length / 3}`);
                continue;
            }

            if (!active)
            {
                note('zero');
                continue;
            }

            // a few targets were exported with a rigid offset (e.g. +115 in Y): keep only the shape change
            const off = [0, 0, 0];

            if (rigidFix)
            {
                for (let i = 0; i < pos.length; i++)
                    off[i % 3] += target.positions[i] - part.positions[i];
            }

            const n = pos.length / 3;
            const shifted = Math.hypot(off[0] / n, off[1] / n, off[2] / n) > 2;
            note('applied', shifted ? 'rigid offset removed' : undefined);

            for (let i = 0; i < pos.length; i++)
            {
                pos[i] += w * (target.positions[i] - part.positions[i] - (shifted ? off[i % 3] / n : 0));
                nrm[i] += w * (target.normals[i] - part.normals[i]);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Entry point
    // -------------------------------------------------------------------------

    /** Portrait for a historical character, a dna_data entry or a bookmark portrait. */
    /** Expert report: the same build, geometry dropped, decals listed but not baked. */
    async report(e: Entity, opts: PortraitOptions = {}): Promise<PortraitReport | null>
    {
        const sink: PortraitReport = { label: '', gender: 'male', age: 0, kind: '', source: '', entities: [], decals: [], tags: [], modifiers: [] };
        const data = await this.build(e, { ...opts, decals: false }, sink);

        if (!data)
            return null;

        return { ...sink, label: data.label, gender: data.gender, age: data.age, source: data.source, tags: data.tags, modifiers: data.modifiers };
    }

    async build(e: Entity, opts: PortraitOptions = {}, report?: PortraitReport): Promise<PortraitData | null>
    {
        const subj = this.subject(e);

        if (!subj)
            return null;

        const kind: PortraitKind = subj.age < 18 ? (subj.gender === 'female' ? 'girl' : 'boy') : subj.gender;

        if (report)
            report.kind = kind;

        // creatures: trait portrait modifiers put a creature entity on the portrait instead of the human
        const run = this.scriptRun(subj.facts?.date ?? BOOKMARK_DATE);
        const creature = subj.facts && !subj.exact ? this.creatureOf(subj.facts, kind, run) : undefined;

        if (creature)
            return this.buildCreature(subj, kind, creature, run, opts, report);

        // portrait modifiers dress the character and add special genes; bookmark dumps already contain their result.
        // Undressed: the game's own naked outfit logic (should_be_naked_trigger & co. forced, nudity shown)
        const state: GeneState = { genes: new Map([...subj.genes].map(([k, g]) => [k, { ...g }])), extra: [] };
        const forced = opts.naked ? new Map(NAKED_TRIGGERS.map((t) => [t, true])) : undefined;
        const modifiers = subj.exact ? [] : this.modifiers.apply(state, subj.facts ?? genericFacts(subj), subj.seed, rng, forced, run);
        const genes = state.genes;

        if (opts.naked)
        {
            // also for exact subjects: clothes → `no_clothes` (fig leaf), nothing else worn
            for (const gene of NAKED_REMOVED)
                genes.delete(gene);

            genes.set('clothes', { template: 'no_clothes', value: 0 });

            if (opts.figLeaf === false)
                genes.delete('clothes');
        }

        const allGenes: [string, GeneValue][] = [...genes, ...state.extra.map((x): [string, GeneValue] => [x.gene, x.g])];

        // accessories and the tags they set (tags switch body/hair blend shapes and accessory variants)
        const worn: { gene: string; accessory: string; }[] = [];

        if (opts.accessories !== false)
        {
            for (const gene of ACCESSORY_GENES)
            {
                let g = genes.get(gene);

                if (!g?.template && !g?.accessory && ACCESSORY_DEFAULTS[gene])
                    g = { template: ACCESSORY_DEFAULTS[gene], value: 0 };

                const accs = g?.accessory ? [g.accessory] : g?.template ? this.accessoryFromGene(gene, g, kind) : [];

                for (const acc of accs)
                    if (this.lib.accessory(acc))
                        worn.push({ gene, accessory: acc });
            }
        }

        const tags = new Set<string>();

        for (const [gene, g] of allGenes)
            if (g.template)
            {
                for (const t of splitTags(scalar(field(this.geneTemplate(gene, g.template) ?? [], 'set_tags'))))
                    tags.add(t);
            }

        for (const w of worn)
            for (const t of this.lib.accessory(w.accessory)!.setTags)
                tags.add(t);

        const attrs = this.attributes(allGenes, kind, subj.age, tags);
        const ptype = this.lib.portraitType(kind);
        const torso = this.lib.entity(ptype.torso);
        const head = this.lib.entity(ptype.head);
        const bodyMesh = torso && this.lib.mesh(torso.mesh.file);
        const headMesh = head && this.lib.mesh(head.mesh.file);

        if (!head || !headMesh)
            return null;

        const morphs = opts.boneMorphs !== false;

        // body in its idle pose, head pinned to the spine (head_root ← bn_sp_thoracic, clavicles alike)
        const torsoRec = report && torso ? this.entityReport(torso, 'torso', 'torso') : undefined;
        const headRec = report ? this.entityReport(head, 'head', 'head') : undefined;

        if (torsoRec)
            report!.entities.push(torsoRec);

        if (headRec)
            report!.entities.push(headRec);

        const bodyAdd = torso && morphs ? this.additives(torso, attrs, torsoRec) : [];
        const bodyPose: Posed = torso && bodyMesh ? this.pose(bodyMesh.bones, bodyAdd, this.idleAnim(torso)) : { bones: new Map(), skin: new Map(), root: m4() };
        // pinned joints take the body joint as it is (the shoulder flaps must match the body); see pose() for the head
        const attach = new Map<string, M4>();

        for (const [parent, child] of ptype.attach)
        {
            const m = bodyPose.bones.get(parent);

            if (m)
                attach.set(child, m);
        }

        const headAdd = morphs ? this.additives(head, attrs, headRec) : [];
        const headPose = this.pose(headMesh.bones, headAdd, this.idleAnim(head), attach);

        const colors = {
            skin: await this.sample(PALETTES.skin, genes.get('skin_color')?.xy ?? [0.3, 0.3]),
            hair: await this.sample(PALETTES.hair, genes.get('hair_color')?.xy ?? [0.5, 0.5]),
            eyes: await this.sample(PALETTES.eye, genes.get('eye_color')?.xy ?? [0.3, 0.6])
        };
        const color = (k: PortraitPart['kind']): [number, number, number] | undefined => (k === 'skin' ? colors.skin : k === 'eye' ? colors.eyes : k === 'hair' ? colors.hair : undefined);
        const shapes = opts.blendShapes !== false;
        const parts: PortraitPart[] = [];
        const bakedColor = new Set<PortraitPart>();
        const add = (list: PortraitPart[]): void =>
        {
            for (const p of list)
                parts.push({ ...p, color: bakedColor.has(p) ? undefined : color(p.kind) });
        };
        const torsoParts = torso ? await this.entityParts(torso, attrs, bodyPose, shapes, subj.seed, undefined, torsoRec) : [];
        const headParts = await this.entityParts(head, attrs, headPose, shapes, subj.seed, undefined, headRec);

        if (report)
        {
            for (const [bodyPart, list] of this.decalLayers(allGenes, kind, subj.age, tags))
            {
                for (const l of list)
                    report.decals.push({ bodyPart, texture: (l.diffuse ?? l.normal)!, weight: l.weight, post: l.post });
            }
        }

        // decals (eyebrows, stubble, complexion, wrinkles, baldness …) baked into the skin textures
        const dataDecals: NonNullable<PortraitData['dataDecals']> = [];

        if (opts.decals !== false)
        {
            const layers = this.decalLayers(allGenes, kind, subj.age, tags);
            // decals that change no texel are no work for the bake, and decals whose small mips are painted over carry
            // values for shaders, not a picture (docs/shaders.md, "Data decals"): out of the bake; shaders read them
            // through the decal list — kept in the engine's order, pre-skin then post-skin by priority
            const data: (DecalLayer & { diffuse: string; })[] = [];
            const values = new Set<DecalLayer>();

            for (const [bodyPart, list] of layers)
            {
                for (const l of list)
                {
                    if (await this.carriesData(l))
                        values.add(l);
                    else if (l.diffuse && !l.normal && !l.properties)
                    {
                        const img = await this.lib.texture(l.diffuse, bodyPart === 'head' ? 512 : 256);

                        if (!img || !transparentDecal(img))
                            continue;
                    }
                    else
                        continue;

                    if (l.diffuse)
                        data.push(l as DecalLayer & { diffuse: string; });
                }
            }

            data.sort((a, b) => Number(a.post) - Number(b.post) || a.priority - b.priority);

            for (const l of data)
                dataDecals.push({ diffuse: l.diffuse, weight: l.weight, post: l.post, blend: l.modes.diffuse });

            for (const [bodyPart, list] of [['torso', torsoParts], ['head', headParts]] as const)
            {
                const skinPart = list.find((p) => p.kind === 'skin');
                const decals = layers.get(bodyPart)?.filter((l) => !values.has(l));

                if (!skinPart?.diffuse || !decals?.length)
                    continue;

                const size = bodyPart === 'head' ? 1024 : 512;
                const key = JSON.stringify([skinPart.diffuse, skinPart.normal, size, colors.skin, decals]);
                let baked = this.bakeCache.get(key);

                if (!baked)
                {
                    baked = await bakeDecals((rel) => this.lib.texture(rel, size), (rel) => this.lib.texture(rel, size / 2), skinPart.diffuse, skinPart.normal, decals, colors.skin);
                    this.bakeCache.set(key, baked);

                    if (this.bakeCache.size > 24)
                        this.bakeCache.delete(this.bakeCache.keys().next().value!);
                }

                if (!baked.diffuse)
                    continue;

                skinPart.diffuse = baked.diffuse;
                bakedColor.add(skinPart);

                if (baked.normal)
                {
                    skinPart.normal = baked.normal;
                    skinPart.bakedNormal = true;
                }
            }
        }

        add(torsoParts);
        add(headParts);
        const accessories: PortraitData['accessories'] = [];

        for (const w of worn)
        {
            const def = this.lib.accessory(w.accessory)!;
            const variant = def.variants.find((v) => tagsMatch(v.required, tags));
            const ref = variant?.entity ? this.lib.entity(variant.entity) : undefined;

            if (!ref)
                continue;

            const pose = variant!.pose === 'torso' ? 'torso' : 'head';
            const rec = report ? this.entityReport(ref, w.gene, pose, w.accessory) : undefined;

            if (rec)
                report!.entities.push(rec);

            add(await this.entityParts(ref, attrs, pose === 'torso' ? bodyPose : headPose, shapes, subj.seed + ':' + w.accessory, w.gene, rec));
            accessories.push(w);
        }

        const shapeAttrs = new Set([...(torso ? torso.entity.attributes : new Map()), ...head.entity.attributes].filter(([, d]) => d.blendShape).map(([a]) => a));
        return {
            label: subj.label,
            gender: subj.gender,
            age: subj.age,
            source: subj.source,
            colors,
            parts,
            accessories,
            tags: [...tags].sort(),
            modifiers,
            applied: { blendShapes: [...attrs.keys()].filter((k) => shapeAttrs.has(k)).length, boneMorphs: [...bodyAdd, ...headAdd].filter((a) => a.active).length, genes: allGenes.length },
            ...(dataDecals.length ? { dataDecals } : {})
        };
    }

    // -------------------------------------------------------------------------
    // Creatures — docs/portraits.md, "Creatures"
    // -------------------------------------------------------------------------

    /** The script state a portrait's triggers and values read: the game start's at its date, made when first read. */
    private scriptRun(date: number): ScriptRun & { read?: boolean; }
    {
        const run: ScriptRun & { read?: boolean; } = freshRun(() =>
        {
            run.read = true;
            return this.gameStart.stateAt(date);
        });
        return run;
    }

    /**
     * A creature: a trait portrait modifier that applies to the character puts on an accessory whose entity is
     * attached at a node of the body (a locator or bone: `entity = { node = "…" entity = "…" }`). Returns those entries
     * and the accessory genes that show creatures. Trait portrait modifiers are applied to creatures only (humans' —
     * dwarfism, blindness … — would change their portraits; not done yet).
     */
    private creatureOf(facts: CharacterFacts, kind: PortraitKind, run: ScriptRun): { entries: TraitEntry[]; genes: string[]; } | undefined
    {
        const entries = this.modifiers.traitEntries(facts, run);
        const genes: string[] = [];

        for (const en of entries)
        {
            for (const m of en.dna.get(PORTRAIT_TYPE) ?? [])
            {
                if (m.k !== 'accessory' || !Array.isArray(m.v))
                    continue;

                const gene = scalar(field(m.v, 'gene'));
                const template = scalar(field(m.v, 'template'));

                if (!gene || !template || genes.includes(gene))
                    continue;

                const accs = this.accessoryFromGene(gene, { template, value: 1 }, kind);

                if (accs.some((a) => this.lib.accessory(a)?.variants.some((v) => v.node && v.entity)))
                    genes.push(gene);
            }
        }

        return genes.length ? { entries, genes } : undefined;
    }

    /** World matrix of a body attachment point: a locator of the torso entity (on a bone if it names one), else a bone. */
    private attachPoint(torso: EntityRef | undefined, pose: Posed, node: string): M4
    {
        const loc = torso?.entity.locators.get(node);

        if (!loc)
            return pose.bones.get(node) ?? m4();

        const local = compose(loc.position, eulerDegrees(loc.rotation), [loc.scale, loc.scale, loc.scale]);
        const parent = loc.parent ? pose.bones.get(loc.parent) : undefined;
        return parent ? mul(parent, local) : local;
    }

    /** Whether one of a decal's textures has a small mip painted over with values (decals.ts `dataMip`). */
    private async carriesData(l: DecalLayer): Promise<boolean>
    {
        for (const rel of [l.diffuse, l.normal, l.properties])
        {
            if (!rel)
                continue;

            let hit = this.dataMips.get(rel);

            if (hit === undefined)
            {
                const [small, large] = await Promise.all([this.lib.texture(rel, 16), this.lib.texture(rel, 32)]);
                this.dataMips.set(rel, hit = !!small && !!large && dataMip(small, large));
            }

            if (hit)
                return true;
        }

        return false;
    }

    /**
     * The decal list as the engine hands it to the shaders: every decal the genes produce (both body parts), pre-skin
     * then post-skin, by priority. Shaders that take their colours from it pick what they read themselves.
     */
    private decalList(genes: [string, GeneValue][], kind: PortraitKind, age: number, tags: Set<string>): PortraitDecal[]
    {
        const layers = [...this.decalLayers(genes, kind, age, tags, true).values()].flat();
        layers.sort((a, b) => Number(a.post) - Number(b.post) || a.priority - b.priority);
        return layers.map((l) => ({ diffuse: l.diffuse, normal: l.normal, properties: l.properties, weight: l.weight, post: l.post, blend: { ...l.modes }, tiling: l.tiling }));
    }

    /** A creature's genes: the portrait modifiers and its trait portrait modifiers run with the script state. */
    private creatureGenes(subj: Subject, kind: PortraitKind, creature: { entries: TraitEntry[]; }, run: ScriptRun): {
        genes: Map<string, GeneValue>;
        allGenes: [string, GeneValue][];
        tags: Set<string>;
        modifiers: string[];
    }
    {
        const facts = subj.facts!;
        const state: GeneState = { genes: new Map([...subj.genes].map(([k, g]) => [k, { ...g }])), extra: [] };
        const modifiers = this.modifiers.apply(state, facts, subj.seed, rng, undefined, run);
        modifiers.push(...this.modifiers.applyTraits(state, facts, creature.entries, PORTRAIT_TYPE, subj.seed, rng, run));
        const allGenes: [string, GeneValue][] = [...state.genes, ...state.extra.map((x): [string, GeneValue] => [x.gene, x.g])];
        const tags = new Set<string>();

        for (const [gene, g] of allGenes)
            if (g.template)
            {
                for (const t of splitTags(scalar(field(this.geneTemplate(gene, g.template) ?? [], 'set_tags'))))
                    tags.add(t);
            }

        return { genes: state.genes, allGenes, tags, modifiers };
    }

    /**
     * Meshes creatures show (the entities of accessories attached at a node that trait portrait modifiers put on) →
     * the traits of those modifiers.
     */
    private creatureMeshes(): Map<string, Set<string>>
    {
        if (this.creatureMeshList)
            return this.creatureMeshList;

        const out = new Map<string, Set<string>>();

        for (const en of this.modifiers.traitEntryList())
        {
            for (const m of en.dna.get(PORTRAIT_TYPE) ?? [])
            {
                const gene = Array.isArray(m.v) && m.k === 'accessory' ? scalar(field(m.v, 'gene')) : undefined;
                const template = gene && scalar(field(m.v as PNode[], 'template'));

                if (!gene || !template)
                    continue;

                for (const kind of ['male', 'female', 'boy', 'girl'] as PortraitKind[])
                {
                    for (const acc of this.accessoryFromGene(gene, { template, value: 1 }, kind))
                    {
                        for (const v of this.lib.accessory(acc)?.variants ?? [])
                        {
                            const file = v.node && v.entity ? this.lib.entity(v.entity)?.mesh.file : undefined;

                            if (file)
                            {
                                for (const t of en.traits)
                                    (out.get(file) ?? out.set(file, new Set()).get(file)!).add(t);
                            }
                        }
                    }
                }
            }
        }

        return (this.creatureMeshList = out);
    }

    /**
     * For a model preview of a mesh creatures show: the decal list of the first character whose portrait shows it —
     * their shaders may take colours from it (a mesh without it can render blank).
     */
    async previewDecals(mesh: string): Promise<{ decals: PortraitDecal[]; from: string; } | undefined>
    {
        const traits = this.creatureMeshes().get(mesh);

        for (const t of traits ?? [])
        {
            const te = this.idx.get('traits', t);

            for (const src of te ? this.idx.incomingSources(te) : [])
            {
                if (src.entity.type !== 'characters')
                    continue;

                const subj = this.subject(src.entity);

                if (!subj?.facts || subj.exact)
                    continue;

                const kind: PortraitKind = subj.age < 18 ? (subj.gender === 'female' ? 'girl' : 'boy') : subj.gender;
                const run = this.scriptRun(subj.facts.date);
                const creature = this.creatureOf(subj.facts, kind, run);

                if (!creature)
                    continue;

                const g = this.creatureGenes(subj, kind, creature, run);
                const decals = this.decalList(g.allGenes, kind, subj.age, g.tags);

                if (decals.length)
                    return { decals, from: subj.label };
            }
        }

        return undefined;
    }

    /**
     * A creature portrait: the portrait modifiers and the trait portrait modifiers run (with the script state, which
     * can hold the creature's appearance — gameStart.ts); the human stays hidden (the modifiers collapse it, its
     * accessories are not built) and only the creature entities are — each with its own skeleton at the body locator
     * it is attached to, posed in the torso state the portrait animations pick, its genes driving blend shapes and
     * additive animations. Its shaders get the whole decal list.
     */
    private async buildCreature(
        subj: Subject,
        kind: PortraitKind,
        creature: { entries: TraitEntry[]; genes: string[]; },
        run: ScriptRun & { read?: boolean; },
        opts: PortraitOptions,
        report?: PortraitReport
    ): Promise<PortraitData | null>
    {
        const facts = subj.facts!;
        const { genes, allGenes, tags, modifiers } = this.creatureGenes(subj, kind, creature, run);
        const attrs = this.attributes(allGenes, kind, subj.age, tags);
        const morphs = opts.boneMorphs !== false;
        // the hidden body carries the locators creatures are attached at
        const torso = this.lib.entity(this.lib.portraitType(kind).torso);
        const bodyMesh = torso && this.lib.mesh(torso.mesh.file);
        const bodyPose: Posed = torso && bodyMesh ? this.pose(bodyMesh.bones, this.additives(torso, attrs), this.idleAnim(torso)) : { bones: new Map(), skin: new Map(), root: m4() };
        const parts: PortraitPart[] = [];
        const accessories: PortraitData['accessories'] = [];
        const added: { active: boolean; }[] = [];
        const shapeAttrs = new Set<string>();
        let shown: { entity: string; state?: string; } | undefined;

        for (const gene of creature.genes)
        {
            const g = genes.get(gene);
            const accs = g?.accessory ? [g.accessory] : g?.template ? this.accessoryFromGene(gene, g, kind) : [];

            for (const acc of accs)
            {
                const variant = this.lib.accessory(acc)?.variants.find((v) => v.node && tagsMatch(v.required, tags));
                const ref = variant?.entity ? this.lib.entity(variant.entity) : undefined;
                const mesh = ref && this.lib.mesh(ref.mesh.file);

                if (!ref || !mesh)
                    continue;

                // an entity taking its state from the body plays the torso state the portrait animations choose; others
                // their default state
                const stateName = ref.entity.stateFromParent ? this.modifiers.creatureState(facts, kind, (s) => ref.entity.states.has(s), subj.seed, rng, run) : ref.entity.defaultState;
                const animId = stateName ? ref.entity.states.get(stateName) : undefined;
                const animFile = animId ? ref.asset.animations.get(animId) : undefined;
                const rec = report ? { ...this.entityReport(ref, gene, 'creature', acc), idle: animFile } : undefined;
                const add = morphs ? this.additives(ref, attrs, rec) : [];
                const posed = this.pose(mesh.bones, add, animFile ? this.lib.anim(animFile) : undefined, undefined, this.attachPoint(torso, bodyPose, variant!.node!));
                const list = await this.entityParts(ref, attrs, posed, opts.blendShapes !== false, subj.seed + ':' + acc, gene, rec, false);

                if (!list.length)
                    continue;

                if (rec)
                    report!.entities.push(rec);

                parts.push(...list);
                added.push(...add);

                for (const [a, d] of ref.entity.attributes)
                    if (d.blendShape)
                        shapeAttrs.add(a);

                accessories.push({ gene, accessory: acc });
                shown ??= { entity: ref.entity.name, state: stateName };
            }
        }

        if (!shown)
            return null;

        const decals = opts.decals !== false ? this.decalList(allGenes, kind, subj.age, tags) : [];

        if (report)
        {
            for (const d of decals)
                report.decals.push({ bodyPart: 'creature', texture: (d.diffuse ?? d.normal ?? d.properties)!, weight: d.weight, post: d.post });
        }

        return {
            label: subj.label,
            gender: subj.gender,
            age: subj.age,
            source: subj.source + (run.read ? '; with the game start’s script state' : ''),
            colors: {
                skin: await this.sample(PALETTES.skin, genes.get('skin_color')?.xy ?? [0.3, 0.3]),
                hair: await this.sample(PALETTES.hair, genes.get('hair_color')?.xy ?? [0.5, 0.5]),
                eyes: await this.sample(PALETTES.eye, genes.get('eye_color')?.xy ?? [0.3, 0.6])
            },
            parts,
            accessories,
            tags: [...tags].sort(),
            modifiers,
            applied: { blendShapes: [...attrs.keys()].filter((k) => shapeAttrs.has(k)).length, boneMorphs: added.filter((a) => a.active).length, genes: allGenes.length },
            creature: shown,
            decals
        };
    }
}

/** The portrait type the builder knows (common/portrait_types); trait portrait modifiers are keyed by it. */
const PORTRAIT_TYPE = 'human';

/** Quaternion of Euler angles in degrees, applied X, then Y, then Z (locator rotations — the order is assumed). */
function eulerDegrees([x, y, z]: V3): Quat
{
    const h = Math.PI / 360;
    return qmul([0, 0, Math.sin(z * h), Math.cos(z * h)], qmul([0, Math.sin(y * h), 0, Math.cos(y * h)], [Math.sin(x * h), 0, 0, Math.cos(x * h)]));
}

/**
 * The matrix normals go through: the inverse transpose of the upper 3×3 (bone morphs scale bones unevenly — an eye's
 * bones squashed turn the plain matrix's normals away from the surface: eyelash cards then faced away from every
 * light and rendered black).
 */
function normalMatrix(m: M4): M4
{
    const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    // cofactors of the 3×3 (column-major a b c | d e f | g h i): the inverse transpose up to the determinant's scale
    const out = new Float64Array(16) as M4;
    out[0] = e * i - f * h;
    out[1] = f * g - d * i;
    out[2] = d * h - e * g;
    out[4] = c * h - b * i;
    out[5] = a * i - c * g;
    out[6] = b * g - a * h;
    out[8] = b * f - c * e;
    out[9] = c * d - a * f;
    out[10] = a * e - b * d;
    // (the determinant's sign keeps the normals' side; its size doesn't matter: normals are normalised)
    const det = a * out[0] + b * out[1] + c * out[2];

    if (det < 0)
    {
        for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10])
            out[k] = -out[k];
    }

    out[15] = 1;
    return out;
}

/** CPU skinning (up to 4 weights per vertex); unskinned meshes follow the skeleton root. */
function skin(pos: Float32Array, nrm: Float32Array, part: MeshPart, mats: M4[], root: M4, tan?: Float32Array): void
{
    const n = pos.length / 3;

    if (!part.skin || !mats.length)
    {
        const nr = normalMatrix(root);

        for (let v = 0; v < n; v++)
            transformVertex(pos, nrm, v, [root], [1], [nr], tan);

        return;
    }

    const { infs, ix, w } = part.skin;
    const stride = ix.length / n;
    const nmats = mats.map((m) => (m ? normalMatrix(m) : m));
    const ms: M4[] = [];
    const ns: M4[] = [];
    const ws: number[] = [];

    for (let v = 0; v < n; v++)
    {
        ms.length = 0;
        ns.length = 0;
        ws.length = 0;

        for (let k = 0; k < infs; k++)
        {
            const bi = ix[v * stride + k];
            const bw = w[v * stride + k];

            if (bi < 0 || bw <= 0 || !mats[bi])
                continue;

            ms.push(mats[bi]);
            ns.push(nmats[bi]);
            ws.push(bw);
        }

        if (ms.length)
            transformVertex(pos, nrm, v, ms, ws, ns, tan);
    }
}

/**
 * Position, normal and (xyz of the 4-float) tangent of one vertex through blended skinning matrices; normals through
 * `ns`, the matrices' normal matrices.
 */
function transformVertex(pos: Float32Array, nrm: Float32Array, v: number, ms: M4[], ws: number[], ns: M4[], tan?: Float32Array): void
{
    const x = pos[v * 3];
    const y = pos[v * 3 + 1];
    const z = pos[v * 3 + 2];
    const nx = nrm[v * 3];
    const ny = nrm[v * 3 + 1];
    const nz = nrm[v * 3 + 2];
    let ox = 0;
    let oy = 0;
    let oz = 0;
    let onx = 0;
    let ony = 0;
    let onz = 0;
    let wsum = 0;

    for (let k = 0; k < ms.length; k++)
    {
        const m = ms[k];
        const bw = ws[k];
        ox += bw * (m[0] * x + m[4] * y + m[8] * z + m[12]);
        oy += bw * (m[1] * x + m[5] * y + m[9] * z + m[13]);
        oz += bw * (m[2] * x + m[6] * y + m[10] * z + m[14]);
        const q = ns[k];
        // (each bone's normal, weighted by its share: a normal matrix's scale is its determinant's — normalised first)
        const qx = q[0] * nx + q[4] * ny + q[8] * nz;
        const qy = q[1] * nx + q[5] * ny + q[9] * nz;
        const qz = q[2] * nx + q[6] * ny + q[10] * nz;
        const ql = Math.hypot(qx, qy, qz) || 1;
        onx += (bw * qx) / ql;
        ony += (bw * qy) / ql;
        onz += (bw * qz) / ql;
        wsum += bw;
    }

    if (wsum <= 0)
        return;

    pos[v * 3] = ox / wsum;
    pos[v * 3 + 1] = oy / wsum;
    pos[v * 3 + 2] = oz / wsum;
    const len = Math.hypot(onx, ony, onz) || 1;
    nrm[v * 3] = onx / len;
    nrm[v * 3 + 1] = ony / len;
    nrm[v * 3 + 2] = onz / len;

    if (!tan)
        return;

    const tx = tan[v * 4];
    const ty = tan[v * 4 + 1];
    const tz = tan[v * 4 + 2];
    let otx = 0;
    let oty = 0;
    let otz = 0;

    for (let k = 0; k < ms.length; k++)
    {
        const m = ms[k];
        otx += ws[k] * (m[0] * tx + m[4] * ty + m[8] * tz);
        oty += ws[k] * (m[1] * tx + m[5] * ty + m[9] * tz);
        otz += ws[k] * (m[2] * tx + m[6] * ty + m[10] * tz);
    }

    const tl = Math.hypot(otx, oty, otz) || 1;
    tan[v * 4] = otx / tl;
    tan[v * 4 + 1] = oty / tl;
    tan[v * 4 + 2] = otz / tl;
}

/** `curve = { { x y } { x y } … }` → sorted points. */
function curvePoints(n: PNode | undefined): [number, number][]
{
    const pts: [number, number][] = [];

    for (const c of kids(n))
    {
        const xy = kids(c)
            .filter((x) => x.k === null && typeof x.v === 'string')
            .map((x) => parseFloat(x.v as string));

        if (xy.length >= 2 && Number.isFinite(xy[0]) && Number.isFinite(xy[1]))
            pts.push([xy[0], xy[1]]);
    }

    return pts.sort((a, b) => a[0] - b[0]);
}

/** Piecewise linear, clamped to the end points. */
function interpolate(pts: [number, number][], x: number): number
{
    if (!pts.length)
        return 0;

    if (x <= pts[0][0])
        return pts[0][1];

    for (let i = 1; i < pts.length; i++)
    {
        if (x <= pts[i][0])
        {
            const [x0, y0] = pts[i - 1];
            const [x1, y1] = pts[i];
            return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
        }
    }

    return pts[pts.length - 1][1];
}

/** Facts for a DNA shown on its own: an adult of that sex with no culture, faith or titles. */
function genericFacts(subj: Subject): CharacterFacts
{
    return { id: '', historical: false, female: subj.gender === 'female', date: 10660915, age: subj.age, culture: subj.culture, traits: new Set(), titles: [], spouses: [], prowess: 5 };
}

function weighted<T>(items: T[], w: (x: T) => number, rand: () => number): T | undefined
{
    const total = items.reduce((s, x) => s + Math.max(0, w(x)), 0);

    if (total <= 0)
        return undefined;

    let r = rand() * total;

    for (const x of items)
    {
        r -= Math.max(0, w(x));

        if (r <= 0)
            return x;
    }

    return items[items.length - 1];
}
