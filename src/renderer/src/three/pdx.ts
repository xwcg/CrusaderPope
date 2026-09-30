/**
 * three.js rendering of CK3 meshes, shared by the portrait viewer and the model preview: the game's tone mapping,
 * portrait light rig and environment, and materials for the PDX texture conventions (palette masks, "RRxG" normals,
 * properties maps, clothes colour patterns). See docs/portraits.md.
 */
import * as THREE from 'three';
import { reportShaderError } from './shaderErrors';
import type { PortraitPart } from '../../../shared/api';
import { imgUrl } from '../img';
import { anisotropy, graphics, viewerPixelRatio } from '../graphics';

const loader = new THREE.TextureLoader();
loader.setCrossOrigin('anonymous');

// ---------------------------------------------------------------------------
// The game's portrait look (gfx/portraits/jomini_environment.txt, environments/portrait_environments.txt)
// ---------------------------------------------------------------------------

/** Uncharted 2 (Hable) curve with the game's parameters, fixed exposure 1.5, value scale 1.05. */
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
    'vec3 CustomToneMapping( vec3 color ) { return color; }',
    `vec3 hableCurve( vec3 x ) {
  const float A = 0.22; const float B = 0.3; const float C = 0.1; const float D = 0.2; const float E = 0.01; const float F = 0.3;
  return ( ( x * ( A * x + C * B ) + D * E ) / ( x * ( A * x + B ) + D * F ) ) - E / F;
}
vec3 CustomToneMapping( vec3 color ) {
  return clamp( hableCurve( color * toneMappingExposure ) / hableCurve( vec3( 11.2 ) ) * 1.05, 0.0, 1.0 );
}`
);

/** environment_standard: cubemap (ambient + reflections) at intensity 0.4 */
const ENVIRONMENT = 'gfx/portraits/environments/castle_interior_01_fire.dds';
const ENVIRONMENT_INTENSITY = 0.4;

/** The game's fixed exposure 1.5 plus a threshold-0 bloom (scale 0.5) that lifts the whole image, approximated by exposure. */
export const EXPOSURE = 1.5 * 1.85;

/** HSV (as the game scripts light colours) → linear RGB colour and intensity (value). */
export function hsvLight(h: number, s: number, v: number): { color: THREE.Color; intensity: number; }
{
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = 1 - s;
    const q = 1 - f * s;
    const t = 1 - (1 - f) * s;
    const [r, g, b] = [
        [1, t, p],
        [q, 1, p],
        [p, 1, t],
        [p, q, 1],
        [t, p, 1],
        [1, p, q]
    ][((i % 6) + 6) % 6];
    // the game's lights have no 1/π in their diffuse term, three.js' Lambert does: scale by π
    return { color: new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace), intensity: v * Math.PI };
}

/** Game light layout: cylindrical { radius height angle } around the chest; key front-left, rims behind-right. */
export const LIGHTS = [
    { name: 'key', hsv: [0.1, 0.45, 1.5], radius: 160, height: 260, angle: 30, lookAt: 0, shadow: 2048 },
    { name: 'right rim', hsv: [0.05, 0.8, 0.3], radius: 160, height: 200, angle: -120, lookAt: -35, shadow: 0 },
    { name: 'left rim', hsv: [0.6, 0.3, 1.6], radius: 200, height: 100, angle: -160, lookAt: 18, shadow: 1024 }
] as const;

/**
 * The portrait light rig around `center`, distances scaled by `k` (1 = a human figure). `shadowSize` is the half
 * width of the shadow cameras.
 */
export function addGameLights(scene: THREE.Object3D, center: THREE.Vector3, k: number, shadowSize: number): void
{
    for (const l of LIGHTS)
    {
        const { color, intensity } = hsvLight(l.hsv[0], l.hsv[1], l.hsv[2]);
        const light = new THREE.DirectionalLight(color, intensity);
        const a = (-l.angle * Math.PI) / 180; // positive angles to the viewer's left
        light.position.set(center.x + Math.sin(a) * l.radius * k, center.y + l.height * k, center.z + Math.cos(a) * l.radius * k);
        light.target.position.set(center.x, center.y + l.lookAt * k, center.z);

        if (l.shadow)
        {
            light.castShadow = true;
            light.shadow.mapSize.set(l.shadow, l.shadow);
            const s = shadowSize;
            Object.assign(light.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: k, far: 1200 * k });
            light.shadow.bias = -0.0004;
            light.shadow.normalBias = 0.06 * k;
            light.shadow.radius = 3;
        }

        scene.add(light, light.target);
    }

    // a neutral sky/ground fill: stands in for the game's bloom and SSAO-free bounce, keeps colours readable
    scene.add(new THREE.HemisphereLight(0xfff6ee, 0x2a241e, 0.8));
}

/**
 * Light rig for model previews that moves with the camera: warm key from the viewer's upper left, cool rim from
 * behind on the right, weak fill from the lower right. The portrait rig stays fixed around the figure like in the game,
 * so seen from behind only the shoulder tops caught its high key light (blown out) and the rims hit the back head-on.
 */
export function addViewLights(scene: THREE.Scene, camera: THREE.Camera, target: THREE.Vector3, dist: number, shadowSize: number): void
{
    const aim = new THREE.Object3D();
    aim.position.copy(target);
    scene.add(aim);
    // camera space: x right, y up, the model at z = -dist
    const rig = [
        { hsv: [0.1, 0.3, 1.25], at: [-0.7, 0.8, 0.6], shadow: 2048 },
        { hsv: [0.6, 0.25, 0.8], at: [0.9, 0.5, -2.2], shadow: 0 },
        { hsv: [0.08, 0.2, 0.3], at: [0.9, -0.3, 0.4], shadow: 0 }
    ] as const;

    for (const l of rig)
    {
        const { color, intensity } = hsvLight(l.hsv[0], l.hsv[1], l.hsv[2]);
        const light = new THREE.DirectionalLight(color, intensity);
        light.position.set(l.at[0] * dist, l.at[1] * dist, l.at[2] * dist);
        light.target = aim;

        if (l.shadow)
        {
            light.castShadow = true;
            light.shadow.mapSize.set(l.shadow, l.shadow);
            const s = shadowSize;
            Object.assign(light.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: dist * 0.01, far: dist * 5 });
            light.shadow.bias = -0.0004;
            light.shadow.normalBias = shadowSize * 0.0008;
            light.shadow.radius = 3;
        }

        camera.add(light);
    }

    scene.add(camera);
    scene.add(new THREE.HemisphereLight(0xfff6ee, 0x2a241e, 0.6));
}

let maxAnisotropy = 8;

/** Call once a renderer exists: textures use its best anisotropic filtering. */
export function setMaxAnisotropy(n: number): void
{
    maxAnisotropy = n;
}

/** textures and uniforms whose pixels are still on their way (`loaded`): a new portrait waits for them before it shows */
const loading = new WeakMap<object, Promise<void>>();

/** Marks a texture (or a uniform whose texture is replaced later) as loading until `done` settles. */
export function markLoading(o: object, done: Promise<unknown>): void
{
    loading.set(
        o,
        done.then(
            () => undefined,
            () => undefined
        )
    );
}

/** Settles when the texture's (uniform's) pixels are there — at once for anything not loading. */
export function loaded(o: object): Promise<void>
{
    return loading.get(o) ?? Promise.resolve();
}

/** A texture from a URL, marked loading until its image is decoded (or failed). */
export function loadTracked(url: string): THREE.Texture
{
    let settle!: () => void;
    const done = new Promise<void>((r) => (settle = r));
    const t = loader.load(url, settle, undefined, settle);
    markLoading(t, done);
    return t;
}

export function texture(path: string | undefined, color: boolean, mipmaps = true, repeat = false): THREE.Texture | null
{
    if (!path)
        return null;

    // baked textures (decals) arrive as data URLs, game textures through the ck3:// protocol
    const t = loadTracked(path.startsWith('data:') ? path : imgUrl(path));
    t.flipY = false; // DirectX UVs: (0,0) is the top-left texel
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = maxAnisotropy;

    if (repeat)
        t.wrapS = t.wrapT = THREE.RepeatWrapping;

    if (!mipmaps)
    {
        // hair strands live in the alpha channel: averaged mips would make them vanish at portrait size
        t.generateMipmaps = false;
        t.minFilter = THREE.LinearFilter;
    }

    return t;
}

/**
 * Clothes colour patterns (jomini portrait_accessory_variation.fxh): each pattern-mask channel (UV0) selects a pattern
 * whose colour mask is tiled over UV1 (rotated/scaled/offset around 0.5); the colour mask's channels pick colours
 * 4·channel + 0..3 from the palette row; the result multiplies the diffuse. Under a pattern its property map replaces
 * the base properties (fabric roughness, AO in red).
 */
function variationShader(part: PortraitPart, shader: THREE.WebGLProgramParametersWithUniforms, decls: string[]): string
{
    const v = part.variation!;
    shader.uniforms.uPatternMask = { value: texture(v.mask, false) };
    shader.uniforms.uPal = { value: v.palette.map((c) => new THREE.Vector3(...c)) };
    decls.push('uniform sampler2D uPatternMask;', `uniform vec3 uPal[${v.palette.length}];`, 'varying vec2 vPatternUv;');
    const blocks: string[] = [];
    // the pattern mask's four channels (the second colour mask is left to the game shaders)
    v.patterns.slice(0, 4).forEach((p, i) =>
    {
        if (!p)
            return;

        shader.uniforms[`uCM${i}`] = { value: texture(p.colormask, false, true, true) };
        shader.uniforms[`uXf${i}`] = { value: new THREE.Vector4(p.scale, p.rotation, p.offset[0], p.offset[1]) };
        decls.push(`uniform sampler2D uCM${i};`, `uniform vec4 uXf${i};`);

        if (p.properties)
        {
            shader.uniforms[`uPP${i}`] = { value: texture(p.properties, false, true, true) };
            decls.push(`uniform sampler2D uPP${i};`);
        }

        const ch = 'rgba'[i];
        const col = (j: number): string => `uPal[${Math.min(i * 4 + j, v.palette.length - 1)}]`;
        const props = p.properties ? `\n    texelProps = mix( texelProps, texture2D( uPP${i}, puv ), pw );` : '';
        blocks.push(`
  if ( pmask.${ch} > 0.0 ) {
    vec2 puv = patternUv( uXf${i} );
    vec4 cm = texture2D( uCM${i}, puv );
    vec3 pc = vec3( 1.0 );
    pc = mix( pc, ${col(0)}, cm.r );
    pc = mix( pc, ${col(1)}, cm.g );
    pc = mix( pc, ${col(2)}, cm.b );
    pc = mix( pc, ${col(3)}, cm.a );
    float pw = pmask.${ch} * min( cm.r + cm.g + cm.b + cm.a, 1.0 );
    patternDiffuse = mix( patternDiffuse, pc, pw );${props}
  }`);
    });
    decls.push(`vec2 patternUv( vec4 xf ) {
  vec2 uv = vPatternUv - 0.5;
  uv = vec2( uv.x * cos( xf.y ) - uv.y * sin( xf.y ), uv.x * sin( xf.y ) + uv.y * cos( xf.y ) );
  return uv / xf.x + 0.5 + xf.zw;
}`);
    shader.vertexShader = shader.vertexShader.replace('void main() {', 'attribute vec2 patternUv;\nvarying vec2 vPatternUv;\nvoid main() {\n  vPatternUv = patternUv;');
    return `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  vec4 pmask = texture2D( uPatternMask, vMapUv );
  vec3 patternDiffuse = vec3( 1.0 );
  texelProps.r = 1.0;${blocks.join('')}
  // pattern AO sits in the properties' red channel
  diffuseColor.rgb *= sampledDiffuseColor.rgb * patternDiffuse * texelProps.r;
  ${part.cutout ? 'diffuseColor.a *= sampledDiffuseColor.a;' : ''}
#endif`;
}

/**
 * Skin translucency like the game's SKIN_SCATTERING/TRANSLUCENCY (jomini translucency.fxh): per light
 * (VdotH^2 with the half vector distorted by 0.3·N, plus NdotL wrapped by 0.2) × light × thickness (properties red)
 * × diffuse × saturated skin colour — thin parts (ears, nostrils) glow when lit from behind.
 */
const SKIN_TRANSLUCENCY = `
#if NUM_DIR_LIGHTS > 0
  {
    vec3 toCamera = normalize( vViewPosition );
    vec3 trans = vec3( 0.0 );
    for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
      vec3 toLight = directionalLights[ i ].direction;
      vec3 h = normalize( toLight + normal * 0.3 );
      float ndl = max( 0.0, ( dot( normal, toLight ) + 0.2 ) / 1.2 );
      float vdh = pow( clamp( dot( toCamera, -h ), 0.0, 1.0 ), 2.0 );
      trans += ( vdh + ndl ) * directionalLights[ i ].color;
    }
    vec3 saturatedSkin = diffuseColor.rgb / max( max( diffuseColor.r, diffuseColor.g ), max( diffuseColor.b, 1e-4 ) );
    outgoingLight += trans * texelProps.r * diffuseColor.rgb * saturatedSkin * diffuseColor.rgb * RECIPROCAL_PI;
  }
#endif
`;

/** Physical material + CK3 specifics: palette colour blended by a mask, "RRxG" packed normals, properties texture. */
export function material(part: PortraitPart): THREE.Material
{
    // the engine multiplies the raw (gamma-space) palette value into the linear diffuse
    const palette = new THREE.Vector3(...(part.color ?? [1, 1, 1]));
    const hair = part.kind === 'hair';
    const skin = part.kind === 'skin';
    const eye = part.kind === 'eye';
    const cloth = part.kind === 'cloth';
    const cutout = !!part.cutout;
    const mat = new THREE.MeshPhysicalMaterial({
        // decal-coloured parts (creatures) come with a bake of what their game shader computes
        map: texture(part.diffuse, true, !cutout),
        normalMap: texture(part.normal, false, !cutout),
        roughness: eye ? 0.2 : hair ? 0.5 : cloth ? 0.78 : 0.6,
        metalness: 0,
        specularIntensity: hair ? 0.6 : skin ? 0.7 : 1,
        // wet eyes: a sharp clear coat over the iris and sclera
        clearcoat: eye ? 1 : 0,
        clearcoatRoughness: 0.04,
        // woven fabric scatters light at grazing angles
        sheen: cloth ? 0.35 : 0,
        sheenRoughness: 0.75,
        sheenColor: new THREE.Color(0.55, 0.52, 0.5),
        // the game renders hair, fur and lace with alpha-to-coverage (MSAA) and without backface culling
        alphaToCoverage: cutout,
        alphaTest: cutout ? 0.25 : 0,
        side: cutout || cloth ? THREE.DoubleSide : THREE.FrontSide,
        shadowSide: cutout || cloth ? THREE.DoubleSide : THREE.FrontSide
    });
    const paletted = skin || eye || hair;
    // properties texture: r = SSS/AO mask, g = specular, b = metalness, a = roughness (lighting_util GetMaterialProperties)
    const props = (cloth || skin || part.kind === 'prop') && part.diffuse ? texture(part.properties, false, !cutout) : null;
    const patterns = !!(part.variation && part.uvs2 && props && cloth);
    // three.js caches programs by onBeforeCompile's source text, identical for every part: key the variants explicitly
    const patternKey = patterns ? part.variation!.patterns.map((p) => (p ? (p.properties ? 2 : 1) : 0)).join('') + part.variation!.palette.length : '';
    mat.customProgramCacheKey = () => `ck3:${part.kind}:${paletted}:${cutout}:${!!props}:${patternKey}:${!!part.bakedNormal}`;
    mat.onBeforeCompile = (shader) =>
    {
        shader.uniforms.uPalette = { value: palette };
        const decls = ['uniform vec3 uPalette;'];

        if (props)
        {
            shader.uniforms.uProps = { value: props };
            decls.push('uniform sampler2D uProps;');
        }

        let mapChunk = patterns
            ? variationShader(part, shader, decls)
            : hair
            ? `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  #ifdef USE_NORMALMAP
    float colorMask = texture2D( normalMap, vNormalMapUv ).b; // hair colour mask lives in the normal map's blue channel
  #else
    float colorMask = 1.0;
  #endif
  diffuseColor.rgb *= mix( sampledDiffuseColor.rgb, sampledDiffuseColor.rgb * uPalette, colorMask );
  diffuseColor.a *= sampledDiffuseColor.a;
#endif`
            : paletted
            ? `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  diffuseColor.rgb *= mix( sampledDiffuseColor.rgb, sampledDiffuseColor.rgb * uPalette, sampledDiffuseColor.a );
#endif`
            : `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  diffuseColor.rgb *= sampledDiffuseColor.rgb;
  ${cutout ? 'diffuseColor.a *= sampledDiffuseColor.a;' : ''}
#endif`;

        // base properties are read before the diffuse so patterns can override them
        if (props)
            mapChunk = 'vec4 texelProps = texture2D( uProps, vMapUv );\n' + mapChunk;

        shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', decls.join('\n') + '\nvoid main() {')
            .replace('#include <map_fragment>', mapChunk)
            .replace(
                'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
                `vec4 nS = texture2D( normalMap, vNormalMapUv );
  vec3 mapN = ${part.bakedNormal ? 'vec3( nS.r * 2.0 - 1.0, nS.g * 2.0 - 1.0, 0.0 )' : 'vec3( nS.g * 2.0 - 1.0, nS.a * 2.0 - 1.0, 0.0 )'};
  mapN.z = sqrt( max( 0.0, 1.0 - dot( mapN.xy, mapN.xy ) ) );`
            );

        if (props && skin)
        {
            // skin: the texture's roughness, kept off the glossy end (no SSS blur to soften highlights here)
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix( roughness, clamp( texelProps.a, 0.35, 1.0 ), 0.6 );')
                .replace('#include <opaque_fragment>', SKIN_TRANSLUCENCY + '#include <opaque_fragment>');
        }
        else if (props)
        {
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp( texelProps.a, 0.08, 1.0 );')
                .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = texelProps.b;');
        }
    };
    return mat;
}

/** Game space (Y up, left-handed) → three.js (Y up, right-handed): mirror Z and flip the winding. */
export function geometry(part: PortraitPart): THREE.BufferGeometry
{
    const pos = Float32Array.from(part.positions);
    const nrm = Float32Array.from(part.normals);

    for (let i = 2; i < pos.length; i += 3)
    {
        pos[i] = -pos[i];
        nrm[i] = -nrm[i];
    }

    const idx = Uint32Array.from(part.indices);

    for (let i = 0; i < idx.length; i += 3)
    {
        const t = idx[i + 1];
        idx[i + 1] = idx[i + 2];
        idx[i + 2] = t;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(part.uvs), 2));

    if (part.uvs2)
        g.setAttribute('patternUv', new THREE.BufferAttribute(Float32Array.from(part.uvs2), 2));

    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
}

/** The game's portrait cubemap as a prefiltered environment (six faces through the ck3:// protocol). */
export function loadEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene): () => void
{
    let disposed = false;
    let env: THREE.Texture | null = null;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const faces = [0, 1, 2, 3, 5, 4].map((f) => imgUrl(ENVIRONMENT) + `?face=${f}`); // game ±Z flip with our mirrored Z
    new THREE.CubeTextureLoader().setCrossOrigin('anonymous').load(faces, (cube) =>
    {
        if (disposed)
            return;

        cube.colorSpace = THREE.SRGBColorSpace;
        env = pmrem.fromCubemap(cube).texture;
        cube.dispose();
        scene.environment = env;
        scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    });
    return () =>
    {
        disposed = true;
        env?.dispose();
        pmrem.dispose();
    };
}

/** A renderer set up like the game's portraits: supersampled MSAA, Hable tone mapping, soft shadows. */
export function gameRenderer(width: number, height: number): THREE.WebGLRenderer
{
    const g = graphics();
    const renderer = new THREE.WebGLRenderer({ antialias: g.antialias, alpha: true, powerPreference: 'high-performance' });
    // supersampling on top of MSAA (graphics setting): smoother edges and more coverage samples for alpha-to-coverage hair
    renderer.setPixelRatio(viewerPixelRatio());
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.CustomToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.shadowMap.enabled = g.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    setMaxAnisotropy(anisotropy(renderer.capabilities.getMaxAnisotropy()));
    // WebGL compile/link errors go to logs/shaders.log (with the effect and the offending source lines)
    renderer.debug.onShaderError = reportShaderError;
    return renderer;
}

/** Frees meshes, their materials and textures, and shadow maps of a scene (or a part of one). */
export function disposeScene(scene: THREE.Object3D): void
{
    scene.traverse((o) =>
    {
        if (o instanceof THREE.Mesh)
        {
            o.geometry.dispose();
            const m = o.material as THREE.MeshPhysicalMaterial;
            m.map?.dispose();
            m.normalMap?.dispose();
            m.dispose();
        }

        if (o instanceof THREE.DirectionalLight)
            o.shadow.map?.dispose();
    });
}
