/**
 * Read access to the portrait asset data — see docs/portraits.md.
 *
 * `.asset` files (pdxmesh / entity / animation declarations), the entity → asset file lookup, accessory definitions
 * (gfx/portraits/accessories: tags + entity variants) and portrait types (common/portrait_types: head and torso entity
 * per sex and age). Binary meshes, animations and palette textures are loaded and cached here too.
 *
 * Every file is read through the layering of the loaded mods (docs/mods.md): a mod's file of the same path replaces
 * the game's, folders list the files the game loads, packed mods are read from their zip.
 */
import { join } from 'node:path';
import { parse, type PNode } from '../indexer/parser.ts';
import { loadAnim, loadMesh, type AnimFile, type MeshFile } from './mesh.ts';
import { decodeDds, type Decoded } from '../images/dds.ts';
import { GameFiles, type GameFile } from '../mods/gamefiles.ts';
import { shaderDefinesOf } from '../../shared/shaders.ts';

/** Map with least-recently-used eviction (meshes and blend shapes of hundreds of accessories add up). */
class Lru<K, V>
{
    private map = new Map<K, V>();
    private max: number;

    constructor(max: number)
    {
        this.max = max;
    }

    get(k: K): V | undefined
    {
        const v = this.map.get(k);

        if (v !== undefined)
        {
            this.map.delete(k);
            this.map.set(k, v);
        }

        return v;
    }

    set(k: K, v: V): void
    {
        this.map.delete(k);
        this.map.set(k, v);

        if (this.map.size > this.max)
            this.map.delete(this.map.keys().next().value!);
    }
}

export interface AttrDecl
{
    blendShape?: string;
    additive?: string;
    def: number;
}

export interface MeshSettings
{
    /** mesh shape name inside the .mesh file (e.g. "male_bodyShape") */
    name: string;
    diffuse?: string;
    normal?: string;
    properties?: string;
    shader?: string;
    /** effect file of the shader (`shader_file`) */
    shaderFile?: string;
    /** `additional_shader_defines` */
    defines?: string[];
    /** `texture = { file index }` entries by index (SSAO colour maps, unique maps …) */
    extra?: Record<number, string>;
}

export interface MeshDecl
{
    name: string;
    file: string;
    settings: MeshSettings[];
    blendShapes: Map<string, string>;
}

export interface EntityDecl
{
    name: string;
    pdxmesh: string;
    attributes: Map<string, AttrDecl>;
    /** state name → animation id (first declaration) */
    states: Map<string, string>;
    defaultState?: string;
    /** clothes: pattern mask texture + accessory variation name (colour patterns) */
    patternMask?: string;
    variation?: string;
    /** `locator = { name position rotation scale parent }`: attachment points (AGOT's body has `dragon_origin`) */
    locators: Map<string, { position: [number, number, number]; rotation: [number, number, number]; scale: number; parent?: string; }>;
    /** `get_state_from_parent = yes`: an attached entity plays the state its parent is in */
    stateFromParent: boolean;
}

export interface AssetInfo
{
    rel: string;
    meshes: Map<string, MeshDecl>;
    additive: Map<string, string>;
    animations: Map<string, string>;
    entities: Map<string, EntityDecl>;
}

export interface AccessoryVariant
{
    /** `required_tags` ("" = always) */
    required: string;
    /** entity to show; absent = show nothing while the tags match */
    entity?: string;
    /** skeleton the entity follows: head or torso */
    pose: string;
    /** attached at a locator or bone of the body instead (`node = "dragon_origin"`), with its own skeleton */
    node?: string;
}

export interface AccessoryDef
{
    name: string;
    setTags: string[];
    variants: AccessoryVariant[];
}

export type PortraitKind = 'male' | 'female' | 'boy' | 'girl';

/** Range from `x = 0.1` or `x = { min max }`. */
export type Range = [number, number];

export interface PatternLayout
{
    scale: Range;
    /** degrees */
    rotation: Range;
    offset: [Range, Range];
}

/** gfx/portraits/accessory_variations: patterns per pattern-mask channel and colour palettes. */
export interface VariationDef
{
    name: string;
    patterns: { weight: number; channels: ({ textures: string; layouts: string[]; } | null)[]; }[];
    palettes: { weight: number; texture: string; }[];
}

export interface PortraitType
{
    head: string;
    torso: string;
    /** parent joint on the torso → child joint on the head */
    attach: [string, string][];
}

export function scalar(n: PNode | undefined): string | undefined
{
    return n && typeof n.v === 'string' ? n.v : undefined;
}

export function kids(n: PNode | undefined): PNode[]
{
    return n && Array.isArray(n.v) ? n.v : [];
}

export function field(list: PNode[], key: string): PNode | undefined
{
    return list.find((c) => c.k === key);
}

export function splitTags(s: string | undefined): string[]
{
    return (s ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
}

/** `required_tags = "hat,not(hood_on)"`: every term must hold. */
export function tagsMatch(req: string | undefined, active: Set<string>): boolean
{
    return splitTags(req).every((t) =>
    {
        const not = /^not\((.+)\)$/.exec(t);
        return not ? !active.has(not[1]) : active.has(t);
    });
}

export class AssetLibrary
{
    /** the game's files with the loaded mods */
    readonly vfs: GameFiles;
    private meshCache = new Lru<string, MeshFile | null>(400);
    private animCache = new Lru<string, AnimFile | null>(200);
    private assetCache = new Map<string, AssetInfo>();
    /** palettes and decals (1024² decals are 4 MB decoded) */
    private textureCache = new Lru<string, Promise<Decoded | null>>(48);
    private entityFiles: Map<string, string> | null = null;
    private meshFiles: Map<string, string> | null = null;
    private accessories: Map<string, AccessoryDef> | null = null;
    private accessoryByEntity: Map<string, string[]> | null = null;
    private types: Map<PortraitKind, PortraitType> | null = null;
    private variations: { defs: Map<string, VariationDef>; textures: Map<string, { colormask?: string; normal?: string; properties?: string; }>; layouts: Map<string, PatternLayout>; } | null = null;

    /** fast lookup of gfx files (the index's listing of images and models); other paths ask the file layering */
    private lookup?: (rel: string) => GameFile | undefined;

    /** @param files the layered game files, or the `game` folder alone (no mods) */
    constructor(files: GameFiles | string, lookup?: (rel: string) => GameFile | undefined)
    {
        this.vfs = typeof files === 'string' ? new GameFiles(files) : files;
        this.lookup = lookup;
    }

    /** The file the game loads for a game path: the last mod having it, else the game (gfx: with its engine layers). */
    file(rel: string): GameFile | undefined
    {
        const r = rel.replace(/\\/g, '/');
        return this.lookup?.(r) ?? this.vfs.get(r, { engine: /^gfx\//i.test(r) });
    }

    read(rel: string): Buffer | undefined
    {
        const f = this.file(rel);
        return f ? this.vfs.read(f) : undefined;
    }

    readText(rel: string): string | undefined
    {
        const f = this.file(rel);
        return f ? this.vfs.readText(f) : undefined;
    }

    /** Where a game path's file is, for display and reveal: the disk path, or `archive.zip › entry` in a packed mod. */
    where(rel: string): string
    {
        const f = this.file(rel);
        return f ? this.vfs.where(f) : join(this.vfs.gameDir, rel);
    }

    /** The .txt files the game loads directly in a folder, in load order (a later definition of a name wins). */
    private dataFiles(dir: string): { file: GameFile; text: string; }[]
    {
        return this.vfs
            .list(dir, { ext: /\.txt$/i, shallow: true, engine: /^gfx\//i.test(dir) })
            .map((file) => ({ file, text: this.vfs.readText(file) ?? '' }));
    }

    mesh(rel: string): MeshFile | undefined
    {
        let m = this.meshCache.get(rel);

        if (m === undefined)
        {
            const buf = this.read(rel);
            m = buf ? loadMesh(buf) : null;
            this.meshCache.set(rel, m);
        }

        return m ?? undefined;
    }

    anim(rel: string): AnimFile | undefined
    {
        let a = this.animCache.get(rel);

        if (a === undefined)
        {
            const buf = this.read(rel);
            a = buf ? loadAnim(buf) : null;
            this.animCache.set(rel, a);
        }

        return a ?? undefined;
    }

    /**
     * Decoded texture for work on the CPU (palettes, decal baking), at the mip level closest to `maxSize` (0 = full);
     * async because BC7 goes through WebAssembly.
     */
    async texture(rel: string, maxSize = 0): Promise<Decoded | undefined>
    {
        const key = rel + '@' + maxSize;
        let t = this.textureCache.get(key);

        if (t === undefined)
        {
            const buf = this.read(rel);
            t = buf ? decodeDds(buf, maxSize).catch(() => null) : Promise.resolve(null);
            this.textureCache.set(key, t);
        }

        return (await t) ?? undefined;
    }

    /** Parses pdxmesh, entity, animation and blend shape declarations of a .asset file (paths made game-relative). */
    asset(rel: string): AssetInfo
    {
        const hit = this.assetCache.get(rel);

        if (hit)
            return hit;

        const dir = rel.slice(0, rel.lastIndexOf('/') + 1);
        const info: AssetInfo = { rel, meshes: new Map(), additive: new Map(), animations: new Map(), entities: new Map() };
        // paths inside assets are relative to the asset's folder; a few are already game-relative
        const path = (v: string | undefined): string | undefined => (!v ? undefined : /^gfx\//i.test(v) ? v : dir + v);
        const visit = (list: PNode[]): void =>
        {
            for (const n of list)
            {
                if (!Array.isArray(n.v))
                    continue;

                if (n.k === 'pdxmesh')
                {
                    const decl: MeshDecl = { name: scalar(field(n.v, 'name')) ?? '', file: path(scalar(field(n.v, 'file'))) ?? '', settings: [], blendShapes: new Map() };

                    for (const c of n.v)
                    {
                        if (!Array.isArray(c.v))
                            continue;

                        if (c.k === 'meshsettings')
                        {
                            const extra: Record<number, string> = {};

                            for (const x of c.v.filter((y) => y.k === 'texture' && Array.isArray(y.v)))
                            {
                                const file = path(scalar(field(kids(x), 'file')));
                                const index = parseInt(scalar(field(kids(x), 'index')) ?? '', 10);

                                if (file && Number.isFinite(index))
                                    extra[index] = file;
                            }

                            decl.settings.push({
                                name: scalar(field(c.v, 'name')) ?? '',
                                diffuse: path(scalar(field(c.v, 'texture_diffuse'))),
                                normal: path(scalar(field(c.v, 'texture_normal'))),
                                properties: path(scalar(field(c.v, 'texture_specular'))),
                                shader: scalar(field(c.v, 'shader')),
                                shaderFile: scalar(field(c.v, 'shader_file')),
                                defines: shaderDefinesOf(kids(field(c.v, 'additional_shader_defines')).map(scalar)),
                                extra
                            });
                        }
                        else if (c.k === 'blend_shape')
                        {
                            const id = scalar(field(c.v, 'id'));
                            const type = scalar(field(c.v, 'type'));

                            if (id && type)
                                decl.blendShapes.set(id, path(type)!);
                        }
                    }

                    info.meshes.set(decl.name, decl);
                }
                else if (n.k === 'entity')
                {
                    const ent: EntityDecl = {
                        name: scalar(field(n.v, 'name')) ?? '',
                        pdxmesh: scalar(field(n.v, 'pdxmesh')) ?? '',
                        attributes: new Map(),
                        states: new Map(),
                        locators: new Map(),
                        stateFromParent: scalar(field(n.v, 'get_state_from_parent')) === 'yes'
                    };
                    ent.defaultState = scalar(field(n.v, 'default_state'));
                    const xyz = (b: PNode | undefined): [number, number, number] =>
                    {
                        const v = kids(b).map((x) => parseFloat(String(x.v)) || 0);
                        return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
                    };

                    for (const l of n.v.filter((c) => c.k === 'locator' && Array.isArray(c.v)))
                    {
                        const name = scalar(field(kids(l), 'name'));

                        if (name)
                            ent.locators.set(name, {
                                position: xyz(field(kids(l), 'position')),
                                rotation: xyz(field(kids(l), 'rotation')),
                                scale: parseFloat(scalar(field(kids(l), 'scale')) ?? '1') || 1,
                                parent: scalar(field(kids(l), 'parent'))
                            });
                    }

                    for (const c of n.v)
                    {
                        if (!Array.isArray(c.v))
                            continue;

                        if (c.k === 'attribute')
                        {
                            const name = scalar(field(c.v, 'name'));

                            if (name)
                                ent.attributes.set(name, {
                                    blendShape: scalar(field(c.v, 'blend_shape')),
                                    additive: scalar(field(c.v, 'additive_animation')),
                                    def: parseFloat(scalar(field(c.v, 'default')) ?? '0') || 0
                                });
                        }
                        else if (c.k === 'state')
                        {
                            const name = scalar(field(c.v, 'name'));
                            const anim = scalar(field(c.v, 'animation'));

                            if (name && anim && !ent.states.has(name))
                                ent.states.set(name, anim);
                        }
                    }

                    const acc = kids(field(kids(field(kids(field(n.v, 'game_data')), 'portrait_entity_user_data')), 'portrait_accessory'));
                    ent.patternMask = path(scalar(field(acc, 'pattern_mask')));
                    ent.variation = scalar(field(acc, 'variation'));

                    if (ent.name)
                        info.entities.set(ent.name, ent);

                    continue;
                }
                else if (n.k === 'additive_animation' || n.k === 'animation')
                {
                    const id = scalar(field(n.v, 'id'));
                    const type = scalar(field(n.v, 'type'));

                    if (id && type)
                        (n.k === 'animation' ? info.animations : info.additive).set(id, path(type)!);

                    continue;
                }

                visit(n.v);
            }
        };
        const text = this.readText(rel);

        if (text !== undefined)
            visit(parse(text));

        this.assetCache.set(rel, info);
        return info;
    }

    /**
     * Entity by name, from any .asset file under gfx/models (scanned once; the game registers the entities of all of
     * gfx/models — accessories use props of gfx/models/artifacts, pets …: 329 of the game's accessory variants, 403
     * with AGOT). Declarations in comments don't count (AGOT keeps a commented-out copy of an entity in another file).
     * The first declaration of a name in path order wins — no name is declared twice in the game or AGOT (docs/portraits.md,
     * "Mods"). Its pdxmesh may be declared in another asset file (variants of a garment share one mesh).
     */
    entity(name: string): { asset: AssetInfo; entity: EntityDecl; mesh: MeshDecl; } | undefined
    {
        if (!this.entityFiles)
        {
            const entities = (this.entityFiles = new Map<string, string>());
            const meshes = (this.meshFiles = new Map<string, string>());

            for (const f of this.vfs.list('gfx/models', { ext: /\.asset$/i, engine: true }))
            {
                // (comments out, strings kept: a `#` inside a quoted name is no comment)
                const text = (this.vfs.readText(f) ?? '').replace(/"[^"\n]*"|#[^\n]*/g, (s) => (s[0] === '#' ? '' : s));
                const re = /(entity|pdxmesh)\s*=\s*\{[^{}]*?name\s*=\s*"([^"]+)"/g;

                for (let m = re.exec(text); m; m = re.exec(text))
                {
                    const map = m[1] === 'entity' ? entities : meshes;

                    if (!map.has(m[2]))
                        map.set(m[2], f.rel);
                }
            }
        }

        const file = this.entityFiles.get(name);

        if (!file)
            return undefined;

        const asset = this.asset(file);
        const entity = asset.entities.get(name);

        if (!entity)
            return undefined;

        const meshFile = this.meshFiles?.get(entity.pdxmesh);
        const mesh = asset.meshes.get(entity.pdxmesh) ?? (meshFile ? this.asset(meshFile).meshes.get(entity.pdxmesh) : undefined);
        return mesh ? { asset, entity, mesh } : undefined;
    }

    /** Accessory definition (gfx/portraits/accessories/*.txt). */
    accessory(name: string): AccessoryDef | undefined
    {
        if (!this.accessories)
        {
            this.accessories = new Map();

            for (const { text } of this.dataFiles('gfx/portraits/accessories'))
            {
                for (const acc of parse(text))
                {
                    if (!acc.k || !Array.isArray(acc.v))
                        continue;

                    this.accessories.set(acc.k, {
                        name: acc.k,
                        setTags: splitTags(scalar(field(acc.v, 'set_tags'))),
                        variants: acc.v
                            .filter((c) => c.k === 'entity' && Array.isArray(c.v))
                            .map((c) =>
                            {
                                const v = c.v as PNode[];
                                return {
                                    required: scalar(field(v, 'required_tags')) ?? '',
                                    entity: scalar(field(v, 'entity')),
                                    pose: scalar(field(v, 'shared_pose_entity')) ?? 'head',
                                    node: scalar(field(v, 'node'))
                                };
                            })
                    });
                }
            }
        }

        return this.accessories.get(name);
    }

    /** Accessories with a variant showing this entity. */
    accessoriesUsing(entity: string): string[]
    {
        this.accessory(''); // loads all definitions

        if (!this.accessoryByEntity)
        {
            this.accessoryByEntity = new Map();

            for (const def of this.accessories!.values())
            {
                for (const v of def.variants)
                {
                    if (!v.entity)
                        continue;

                    const l = this.accessoryByEntity.get(v.entity);

                    if (!l)
                        this.accessoryByEntity.set(v.entity, [def.name]);
                    else if (!l.includes(def.name))
                        l.push(def.name);
                }
            }
        }

        return this.accessoryByEntity.get(entity) ?? [];
    }

    /** Accessory variations with their pattern texture sets and layouts (names are global across files). */
    variation(name: string):
        | { def: VariationDef; texture: (n: string) => { colormask?: string; normal?: string; properties?: string; } | undefined; layout: (n: string) => PatternLayout | undefined; }
        | undefined
    {
        if (!this.variations)
        {
            const v = (this.variations = { defs: new Map(), textures: new Map(), layouts: new Map() } as NonNullable<AssetLibrary['variations']>);
            const range = (n: PNode | undefined): Range =>
            {
                if (n && typeof n.v === 'string')
                    return [parseFloat(n.v) || 0, parseFloat(n.v) || 0];

                const b = kids(n);
                const lo = parseFloat(scalar(field(b, 'min')) ?? '0') || 0;
                return [lo, parseFloat(scalar(field(b, 'max')) ?? String(lo)) || lo];
            };

            for (const { text } of this.dataFiles('gfx/portraits/accessory_variations'))
            {
                for (const n of parse(text))
                {
                    if (!Array.isArray(n.v))
                        continue;

                    const name = scalar(field(n.v, 'name'));

                    if (!name)
                        continue;

                    if (n.k === 'pattern_textures')
                    {
                        v.textures.set(name, { colormask: scalar(field(n.v, 'colormask')), normal: scalar(field(n.v, 'normal')), properties: scalar(field(n.v, 'properties')) });
                    }
                    else if (n.k === 'pattern_layout')
                    {
                        const off = kids(field(n.v, 'offset'));
                        v.layouts.set(name, { scale: range(field(n.v, 'scale')), rotation: range(field(n.v, 'rotation')), offset: [range(field(off, 'x')), range(field(off, 'y'))] });
                    }
                    else if (n.k === 'variation')
                    {
                        const def: VariationDef = { name, patterns: [], palettes: [] };

                        for (const c of n.v)
                        {
                            if (!Array.isArray(c.v))
                                continue;

                            const weight = parseFloat(scalar(field(c.v, 'weight')) ?? '1') || 0;

                            if (c.k === 'pattern')
                            {
                                def.patterns.push({
                                    weight,
                                    // pattern mask channels, then the second colour mask (SECOND_COLOR_MASK meshes: properties red,
                                    // normal map blue)
                                    channels: ['r', 'g', 'b', 'a', 'properties_r', 'normal_b'].map((ch) =>
                                    {
                                        const b = kids(field(c.v as PNode[], ch));
                                        const textures = scalar(field(b, 'textures'));
                                        return textures ? { textures, layouts: b.filter((x) => x.k === 'layout' && typeof x.v === 'string').map((x) => x.v as string) } : null;
                                    })
                                });
                            }
                            else if (c.k === 'color_palette')
                            {
                                const texture = scalar(field(c.v, 'texture'));

                                if (texture)
                                    def.palettes.push({ weight, texture });
                            }
                        }

                        v.defs.set(name, def);
                    }
                }
            }
        }

        const v = this.variations;
        const def = v.defs.get(name);
        return def ? { def, texture: (n) => v.textures.get(n), layout: (n) => v.layouts.get(n) } : undefined;
    }

    /** Head/torso entities per portrait type (common/portrait_types, "human"). */
    portraitType(kind: PortraitKind): PortraitType
    {
        if (!this.types)
        {
            this.types = new Map();

            for (const { text } of this.dataFiles('common/portrait_types'))
            {
                for (const t of parse(text))
                {
                    if (t.k !== 'human' || !Array.isArray(t.v))
                        continue;

                    const attach: [string, string][] = [];

                    for (const j of kids(field(t.v, 'attach')))
                    {
                        if (j.k === 'joint_attachment')
                            attach.push([scalar(field(kids(j), 'parent_joint')) ?? '', scalar(field(kids(j), 'child_joint')) ?? '']);
                    }

                    for (const k of ['male', 'female', 'boy', 'girl'] as PortraitKind[])
                    {
                        const b = kids(field(t.v, k));
                        const head = scalar(field(b, 'head'));
                        const torso = scalar(field(b, 'torso'));

                        if (head && torso)
                            this.types.set(k, { head, torso, attach });
                    }
                }
            }
        }

        const fallback: PortraitType = {
            head: kind === 'female' || kind === 'girl' ? 'head_basic_entity_female' : 'head_basic_entity_male',
            torso: `${kind}_body_entity`,
            attach: [['bn_sp_thoracic', 'head_root']]
        };
        return this.types.get(kind) ?? fallback;
    }
}
