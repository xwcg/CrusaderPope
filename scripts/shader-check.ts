// The shader compiler's rewrite passes (src/main/shaders: compile.ts, prune.ts, effect.ts) on small HLSL snippets, each
// on its own: input -> expected text (whitespace ignored) or "compiles" through glslang. The sweeps (shader-sweep.ts)
// only exercise them as far as the game's and the mods' shaders happen to need; this says what each pass promises, so
// a change to one fails here with its case named. With the game installed, three real Effects are compiled as well.
// Usage: node --experimental-strip-types --no-warnings scripts/shader-check.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    fixHlslisms,
    glslToEs,
    hlslArrayCasts,
    hlslAttributes,
    hlslCasts,
    hlslImplicitInts,
    glslangType,
    hlslMatrixInitializers,
    hlslMatrixRows,
    hlslPasses,
    loadCrossShader,
    rewriteCalls,
    rewriteComparison,
    ShaderLibrary
} from '../src/main/shaders/compile.ts';
import { parseEffectFile } from '../src/main/shaders/effect.ts';
import { preprocessConditionals, pruneUnreachable } from '../src/main/shaders/prune.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { viewerShaderRequest } from '../src/shared/shaders.ts';
import { defaultInstall } from './ck3-install.ts';

let bad = 0;
let count = 0;
const norm = (s: string): string => s.replace(/\s+/g, ' ').replace(/\s*([(),;{}])\s*/g, '$1').trim();
const report = (ok: boolean, name: string, detail = ''): void =>
{
    count++;

    if (!ok)
    {
        bad++;
        console.log(`FAIL ${name}${detail ? '\n' + detail : ''}`);
    }
};
/** A pass on a text: the result equals (whitespace ignored) `expected`. */
const same = (name: string, got: string, expected: string): void => report(norm(got) === norm(expected), name, `  expected: ${norm(expected)}\n  got:      ${norm(got)}`);

// ---------------------------------------------------------------------------------------------------------------------
// Source passes (hlslPasses runs them in this order)
// ---------------------------------------------------------------------------------------------------------------------

// integer declarations: HLSL converts float to int on its own
same('ints: float expression into int', hlslImplicitInts('int Index = UV.x * 255.0;'), 'int Index = int( UV.x * 255.0 );');
same('ints: uint vector', hlslImplicitInts('uint2 Cell = Pos / 4.0;'), 'uint2 Cell = uint2( Pos / 4.0 );');
same('ints: floats stay', hlslImplicitInts('float Index = UV.x * 255.0;'), 'float Index = UV.x * 255.0;');
same('ints: a declaration inside a for', hlslImplicitInts('for ( int i = 0; i < 4; i++ ) {}'), 'for ( int i = int( 0 ); i < 4; i++ ) {}');

// C-style casts
same('cast: member', hlslCasts('int i = (int)Data._Channel;'), 'int i = int( Data._Channel );');
same('cast: parenthesized', hlslCasts('float f = (float)(a + b) * 2.0;'), 'float f = float( (a + b) ) * 2.0;');
same('cast: call and index', hlslCasts('uint u = (uint)Floor( x )[2];'), 'uint u = uint( Floor( x )[2] );');
same('cast: vector', hlslCasts('float3 v = (float3)Color;'), 'float3 v = float3( Color );');
same('cast: negative operand', hlslCasts('int i = (int)-x;'), 'int i = int( -x );');
same('cast: a call is no cast', hlslCasts('float f = foo(int)3;'), 'float f = foo(int)3;');
same('cast: after return', hlslCasts('return (float)Index;'), 'return float( Index );');
same('cast: after else', hlslCasts('if ( a ) b = 1; else (int)x;'), 'if ( a ) b = 1; else int( x );');
same('cast: of a negation', hlslCasts('float f = (float)!b + (uint)~m;'), 'float f = float( !b ) + uint( ~m );');
same('cast: exponent literal', hlslCasts('float f = (float)3.0e-2 * 2;'), 'float f = float( 3.0e-2 ) * 2;');

// casts of arrays
same('array cast: float4 array to float2', hlslArrayCasts('uniform float4 P[2]; static const float2 X[4] = (float2[4])P; float2 f( int i ) { return X[i]; }'), 'uniform float4 P[2]; float2 X_ArrayCast( int i ) { return float2( P[ i / 2 ][ ( i % 2 ) * 2 ], P[ i / 2 ][ ( i % 2 ) * 2 + 1 ] ); } float2 f( int i ) { return X_ArrayCast( int( i ) ); }');
same('array cast: float2 array to float4', hlslArrayCasts('uniform float2 Q[4]; static const float4 Y[2] = (float4[2])Q; float4 g = Y[ 1 ];'), 'uniform float2 Q[4]; float4 Y_ArrayCast( int i ) { return float4( Q[ i * 2 ], Q[ i * 2 + 1 ] ); } float4 g = Y_ArrayCast( int( 1 ) );');
same('array cast: the source declared in GLSL names (a constant buffer field)', hlslArrayCasts('uniform vec4 P[PDX_MAX/2]; static const float2 X[PDX_MAX] = (float2[PDX_MAX])P; float2 a = X[ Index ];'), 'uniform vec4 P[PDX_MAX/2]; float2 X_ArrayCast( int i ) { return float2( P[ i / 2 ][ ( i % 2 ) * 2 ], P[ i / 2 ][ ( i % 2 ) * 2 + 1 ] ); } float2 a = X_ArrayCast( int( Index ) );');
same('array cast: used as a whole stays', hlslArrayCasts('uniform float4 P[2]; static const float2 X[4] = (float2[4])P; float2 a = Sum( X );'), 'uniform float4 P[2]; static const float2 X[4] = (float2[4])P; float2 a = Sum( X );');
same('array cast: another element type stays', hlslArrayCasts('uniform int4 P[2]; static const float2 X[4] = (float2[4])P; float2 a = X[0];'), 'uniform int4 P[2]; static const float2 X[4] = (float2[4])P; float2 a = X[0];');
same('array cast: a source not declared here stays', hlslArrayCasts('static const float2 X[4] = (float2[4])P; float2 a = X[0];'), 'static const float2 X[4] = (float2[4])P; float2 a = X[0];');

// flow control attributes
same('attribute: unroll', hlslAttributes('[unroll] for ( int i = 0; i < 4; i++ ) {}'), ' for ( int i = 0; i < 4; i++ ) {}');
same('attribute: loop with a number', hlslAttributes('x = 1; [loop] while ( a ) {}'), 'x = 1;  while ( a ) {}');
same('attribute: branch', hlslAttributes('{ [branch] if ( a ) b = 1; }'), '{  if ( a ) b = 1; }');
same('attribute: an index stays', hlslAttributes('x = Values[unroll] ;'), 'x = Values[unroll] ;');

// matrix initializers
same('matrix init: 16 flat values', hlslMatrixInitializers('const float4x4 M = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };'), 'const float4x4 M = float4x4( 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 );');
same('matrix init: 9 flat values, trailing comma', hlslMatrixInitializers('float3x3 M = { 1, 2, 3, 4, 5, 6, 7, 8, 9, };'), 'float3x3 M = float3x3( 1, 2, 3, 4, 5, 6, 7, 8, 9 );');
same('matrix init: values with calls', hlslMatrixInitializers('float2x2 M = { min( a, b ), Table[ 1 ], sqrt( x ), 4 };'), 'float2x2 M = float2x2( min( a, b ), Table[ 1 ], sqrt( x ), 4 );');
same('matrix init: a comma inside brackets', hlslMatrixInitializers('float2x2 M = { Foo[ f( 1, 2 ) ], Bar[ int2( 1, 2 ).x ], 3, 4 };'), 'float2x2 M = float2x2( Foo[ f( 1, 2 ) ], Bar[ int2( 1, 2 ).x ], 3, 4 );');
same('matrix init: rows in braces', hlslMatrixInitializers('float3x3 M = { { 1, 2, 3 }, { 4, 5, 6 }, { 7, 8, 9 } };'), 'float3x3 M = float3x3( 1, 2, 3, 4, 5, 6, 7, 8, 9 );');
same('matrix init: row vectors', hlslMatrixInitializers('float3x3 M = { float3( 1, 2, 3 ), float3( 4, 5, 6 ), float3( 7, 8, 9 ) };'), 'float3x3 M = float3x3( ( float3( 1, 2, 3 ) ).x, ( float3( 1, 2, 3 ) ).y, ( float3( 1, 2, 3 ) ).z, ( float3( 4, 5, 6 ) ).x, ( float3( 4, 5, 6 ) ).y, ( float3( 4, 5, 6 ) ).z, ( float3( 7, 8, 9 ) ).x, ( float3( 7, 8, 9 ) ).y, ( float3( 7, 8, 9 ) ).z );');
same('matrix init: array of matrices', hlslMatrixInitializers('static const float2x2 M[2] = { { 1, 2, 3, 4 }, { { 5, 6 }, { 7, 8 } } };'), 'static const float2x2 M[2] = float2x2[2]( float2x2( 1, 2, 3, 4 ), float2x2( 5, 6, 7, 8 ) );');
same('matrix init: wrong count stays', hlslMatrixInitializers('float2x2 M = { 1, 2, 3 };'), 'float2x2 M = { 1, 2, 3 };');
same('matrix init: other braces stay', hlslMatrixInitializers('float4 V[2] = { float4( 0 ), float4( 1 ) }; float4x4 M = Create4x4( a, b, c, d );'), 'float4 V[2] = { float4( 0 ), float4( 1 ) }; float4x4 M = Create4x4( a, b, c, d );');
same('matrix init: two declarations', hlslMatrixInitializers('float2x2 A = { 1, 2, 3, 4 }; float2x2 B = { 5, 6, 7, 8 };'), 'float2x2 A = float2x2( 1, 2, 3, 4 ); float2x2 B = float2x2( 5, 6, 7, 8 );');
same('matrix init: array as one flat list', hlslMatrixInitializers('static const float2x2 M[2] = { 1,2,3,4,5,6,7,8 };'), 'static const float2x2 M[2] = float2x2[2]( float2x2( 1, 2, 3, 4 ), float2x2( 5, 6, 7, 8 ) );');
same('matrix init: scalars are no row vectors', hlslMatrixInitializers('float2x2 M = { 1, 2 };'), 'float2x2 M = { 1, 2 };');
same('matrix init: second declarator stays', hlslMatrixInitializers('float2x2 M = { 1, 2, 3, 4 }, N = { 1, 2, 3, 4 };'), 'float2x2 M = { 1, 2, 3, 4 }, N = { 1, 2, 3, 4 };');
same('glslang type: vector', JSON.stringify(glslangType(' temp 4-component vector of float')), '{"n":4,"base":"float"}');
same('glslang type: scalar', JSON.stringify(glslangType(' temp int')), '{"n":1,"base":"int"}');
same('glslang type: a matrix is none', String(glslangType(' temp 3X3 matrix of float')), 'undefined');

// matrix constructors: HLSL fills rows, the engine's GLSL columns
same('matrix rows: three vectors', hlslMatrixRows('float3x3 M = float3x3( T, B, N );'), 'float3x3 M = transpose( float3x3( T, B, N ) );');
same('matrix rows: one value per element is reordered', hlslMatrixRows('float2x2 M = float2x2( 1, 2, 3, 4 );'), 'float2x2 M = float2x2( 1, 3, 2, 4 );');
same('matrix rows: the Create helpers are left alone', hlslMatrixRows('float2x2 Create2x2( in float2 x, in float2 y ) { return float2x2( x, y ); }'), 'float2x2 Create2x2( in float2 x, in float2 y ) { return float2x2( x, y ); }');
same('matrix rows: a conversion has one argument', hlslMatrixRows('float3x3 M = float3x3( Other );'), 'float3x3 M = float3x3( Other );');
same('passes: flat initializer ends up reordered', hlslPasses('const float2x2 M = { 1, 2, 3, 4 };'), 'const float2x2 M = float2x2( 1, 3, 2, 4 );');
same('passes: array of matrices ends up reordered', hlslPasses('const float2x2 M[2] = { { 1, 2, 3, 4 }, { 5, 6, 7, 8 } };'), 'const float2x2 M[2] = float2x2[2]( float2x2( 1, 3, 2, 4 ), float2x2( 5, 7, 6, 8 ) );');

// the helpers the patches are built from
same('rewriteCalls: only the named function', rewriteCalls('x = f( a, g( b, c ) ) + h( d );', 'g', (args) => `G( ${args.join(' | ')} )`), 'x = f( a, G( b | c ) ) + h( d );');
same('rewriteComparison: operands of a comparison', rewriteComparison('if ( abs( a - b ) <= t ) x = 1;', '<=', (a, b) => `le( ${a}, ${b} )`), 'if ( le( abs( a - b ), t ) ) x = 1;');

// ---------------------------------------------------------------------------------------------------------------------
// The preprocessor and the pruning of unreachable code
// ---------------------------------------------------------------------------------------------------------------------

same('preprocess: #ifdef / #else', preprocessConditionals('#define A 1\n#ifdef A\nint a;\n#else\nint b;\n#endif\n'), '#define A 1\nint a;\n');
same('preprocess: CRLF files', preprocessConditionals('#define A\r\n#ifndef A\r\nint a;\r\n#endif\r\nint c;\r\n'), '#define A\nint c;\n');
same('preprocess: #if defined and #elif', preprocessConditionals('#define B\n#if defined( A )\nint a;\n#elif defined( B ) && !defined( A )\nint b;\n#else\nint c;\n#endif\n'), '#define B\nint b;\n');
same('preprocess: nested, inactive outer', preprocessConditionals('#ifdef X\n#ifndef Y\nint a;\n#endif\n#endif\nint z;\n'), 'int z;\n');
same('preprocess: values compared', preprocessConditionals('#define LEVEL 2\n#if LEVEL >= 2\nint hi;\n#else\nint lo;\n#endif\n'), '#define LEVEL 2\nint hi;\n');

const pruned = pruneUnreachable(`
float Used( float x ) { return x * 2.0; }
float Unused( float x ) { return x * ddx( x ); }
float Indirect( float x ) { return Used( x ); }
static const float kUsed = 1.0;
static const float kUnused = 2.0;
uniform float uUsed;
uniform float uUnused;
void main()
{
    float y = Indirect( uUsed ) + kUsed;
}
`);
report(/\bUsed\b/.test(pruned) && /\bIndirect\b/.test(pruned) && /kUsed/.test(pruned) && /uUsed/.test(pruned), 'prune: what main reaches stays', pruned);
report(!/Unused|kUnused|uUnused/.test(pruned), 'prune: what main does not reach goes', pruned);
same('prune: a default parameter becomes an overload', pruneUnreachable('float Fn( float a, float b = 2.0 ) { return a * b; }\nvoid main() { float y = Fn( 1.0 ); }'), 'float Fn( float a, float b ) { return a * b; } float Fn( float a ) { return Fn( a, 2.0 ); } void main() { float y = Fn( 1.0 ); }');

// ---------------------------------------------------------------------------------------------------------------------
// The effect file parser
// ---------------------------------------------------------------------------------------------------------------------

const fx = parseEffectFile('test.shader', `
Includes = {
    "cw/pdxmesh.fxh"
}
ConstantBuffer( Cam ) { float4x4 View; float3 Pos; }
VertexStruct VS_OUT
{
    float4 Position : PDX_POSITION;
    float2 UV # trailing comment
        : TEXCOORD0;
@ifdef WITH_COLOR
    float4 Color : COLOR;
@endif
};
VertexShader =
{
    TextureSampler Tex { Index = 3 File = "a.dds" SamplerType = "Compare" }
    MainCode VS { Input = "VS_IN" Output = "VS_OUT" Code [[ PDX_MAIN { } ]] }
}
BlendState alpha { SourceBlend = "src_alpha" }
DepthStencilState alpha { DepthEnable = no }
Effect Test { VertexShader = "VS" PixelShader = "PS" BlendState = "alpha" Defines = { "A" "B 2" } }
`);
report(fx.includes.length === 1 && fx.includes[0] === 'cw/pdxmesh.fxh', 'effect file: includes', JSON.stringify(fx.includes));
report(fx.cbuffers[0]?.name === 'Cam' && fx.cbuffers[0].fields.length === 2, 'effect file: constant buffer fields');
report(fx.structs[0]?.fields.length === 3 && fx.structs[0].fields[2].cond?.[0]?.define === 'WITH_COLOR', 'effect file: struct fields, @ifdef condition, # comment', JSON.stringify(fx.structs[0]));
report(fx.samplers[0]?.name === 'Tex' && fx.mains[0]?.name === 'VS', 'effect file: sampler and MainCode');
report(fx.effects[0]?.name === 'Test' && fx.effects[0].defines.join('|') === 'A|B 2', 'effect file: Effect with Defines', JSON.stringify(fx.effects));
const nested = parseEffectFile('nested.shader', 'VertexShader = { MainCode VS { VertexStruct VS_INPUT { float2 Pos : POSITION; float4 Color : COLOR; } Input = "VS_INPUT" Output = "VS_INPUT" Code [[ PDX_MAIN { } ]] } }\nEffect Nested { VertexShader = "VS" PixelShader = "VS" }');
report(nested.structs[0]?.name === 'VS_INPUT' && nested.structs[0].fields.length === 2 && nested.mains[0]?.input === 'VS_INPUT' && nested.effects[0]?.name === 'Nested', 'effect file: a VertexStruct declared inside a MainCode', JSON.stringify(nested.structs));
report(fx.states.has('BlendState:alpha') && fx.states.has('DepthStencilState:alpha'), 'effect file: states of different kinds share a name');

// ---------------------------------------------------------------------------------------------------------------------
// What glslang rejects, patched line by line (fixHlslisms): each snippet compiles and its patched source says how
// ---------------------------------------------------------------------------------------------------------------------

const xs = await loadCrossShader();
const HEAD = '#version 450\nlayout(location=0) out vec4 O;\nuniform vec4 U4; uniform vec3 U3; uniform vec2 U2; uniform float U1; uniform int I1; uniform ivec3 I3; uniform uint N1; uniform sampler2D T;\n#define lerp mix\n#define PdxTex2D texture\n#define PdxTex2DLod textureLod\n';
/** Compiles a snippet; `want` (whitespace ignored) must appear in the patched source, `''` = nothing patched. */
const patches = (name: string, body: string, want: string | RegExp): void =>
{
    let last = HEAD + body + '\n';

    try
    {
        glslToEs(xs, last, 'ps', (s) => (last = s));
    }
    catch (e)
    {
        report(false, `glslang: ${name}`, '  ' + String((e as Error).message).split('\n').slice(0, 2).join('\n  '));
        return;
    }

    const got = norm(last.slice(HEAD.length));
    report(want instanceof RegExp ? want.test(got) : got.includes(norm(want)), `glslang: ${name}`, `  patched: ${got}`);
};
// the engine's mul() overloads for matching sizes (cw/defines_glsl4.fxh)
const MUL = 'uniform mat4 M4; uniform mat3 M3;\nvec3 mul( mat3 Matrix, vec3 Vector ) { return Matrix * Vector; }\nvec3 mul( vec3 Vector, mat3 Matrix ) { return Vector * Matrix; }\nvec4 mul( mat4 Matrix, vec4 Vector ) { return Matrix * Vector; }\n';
/** A snippet glslang refuses and nothing here can patch: it must still fail (no silent wrong guess). */
const refused = (name: string, body: string): void =>
{
    try
    {
        glslToEs(xs, HEAD + body + '\n', 'ps');
        report(false, `glslang: ${name} should fail`);
    }
    catch
    {
        report(true, name);
    }
};

// no patch needed
patches('plain code is left alone', 'void main() { O = vec4( U3, U1 ); }', 'O = vec4( U3, U1 );');

// float -> int / uint, scalar -> vector in assignments
patches('float into int', 'void main() { int i = 0; i = U1 * 2.0; O = vec4( i ); }', 'i = int( U1 * 2.0 );');
patches('scalar into vector', 'void main() { vec3 c = vec3( 0.0 ); c = U1; O = vec4( c, 1.0 ); }', 'c = vec3( U1 );');
patches('float array index', 'void main() { float a[4] = float[4]( 1.0, 2.0, 3.0, 4.0 ); O = vec4( a[ U1 * 3.0 ] ); }', 'a[int( U1 * 3.0 )]');
patches('bool in arithmetic', 'void main() { O = vec4( ( U1 > 0.5 ) * 2.0 ); }', 'float( U1 > 0.5 )');
patches('float modulo', 'void main() { O = vec4( U1 % 2.0 ); }', /trunc/);
patches('pow of a vector with a scalar exponent', 'void main() { O = vec4( pow( U3, U1 ), 1.0 ); }', /pow\(U3,U1 \+ 0\.0 \*\(U3\)\)/);

// vector comparisons are per component in HLSL
patches('vector <=', 'void main() { O = vec4( all( abs( U3 - U3 ) <= 0.1 ) ? 1.0 : 0.0 ); }', 'lessThanEqual( abs( U3 - U3 ), vec3( 0.1 ) )');
patches('all( a == b )', 'void main() { O = vec4( all( U3 == U3 ) ? 1.0 : 0.0 ); }', 'all( equal( U3, U3 ) )');

// the shader's own functions: arguments and return values convert implicitly
patches('own function: int literal for a bool', 'void F( bool b ) { if ( b ) {} }\nvoid main() { F( 1 ); O = vec4( 0.0 ); }', 'F( bool( 1 ) )');
patches('own function: vec4 for a vec3 parameter', 'vec3 F( vec3 x )\n{\n    return x;\n}\nvoid main() { O = vec4( F( U4 ), 1.0 ); }', 'F( vec3( U4 ) )');
patches('own function: return value truncated', 'vec3 F()\n{\n    return U4;\n}\nvoid main() { O = vec4( F(), 1.0 ); }', 'return vec3( U4 );');
patches('own function: return value float for an int', 'int F()\n{\n    return U1;\n}\nvoid main() { O = vec4( F() ); }', 'return int( U1 );');

// vector truncation (HLSL cuts a larger vector to the smaller size)
patches('truncation: declaration', 'void main()\n{\n    vec3 c = U4;\n    O = vec4( c, 1.0 );\n}', 'vec3 c = vec3( U4 );');
patches('truncation: declaration to a scalar', 'void main()\n{\n    float c = U3;\n    O = vec4( c );\n}', 'float c = float( U3 );');
patches('truncation: assignment to a swizzle', 'void main()\n{\n    vec4 a = vec4( 0.0 );\n    a.rgb = U4;\n    O = a;\n}', 'a.rgb = vec3( U4 );');
patches('truncation: compound assignment', 'void main()\n{\n    vec4 a = vec4( 1.0 );\n    a.rgb *= U4;\n    a.rg += U3;\n    O = a;\n}', /a\.rgb \*= vec3\(U4\);a\.rg \+= vec2\(U3\);/);
patches('truncation: the declaration is not the culprit', 'void main()\n{\n    vec4 a = vec4( 1.0 ); a.xy = U3; O = a;\n}', 'a.xy = vec2( U3 );');
patches('truncation: operands of different sizes', 'void main()\n{\n    vec3 b = U4 * U3;\n    O = vec4( b, 1.0 );\n}', 'vec3( U4 ) * U3');
patches('truncation: the larger operand on the right', 'void main()\n{\n    vec3 b = U3 + U4;\n    O = vec4( b, 1.0 );\n}', 'U3 + vec3( U4 )');
patches('truncation: a chain, the wrong operator first', 'void main()\n{\n    vec3 b = U3 * 2.0 + U3 * U4;\n    O = vec4( b, 1.0 );\n}', 'U3 * vec3( U4 )');
patches('truncation: a negated operand', 'void main()\n{\n    vec3 b = U3 * -U4;\n    O = vec4( b, 1.0 );\n}', 'U3 * -vec3( U4 )');
patches('truncation: a call as the operand', 'void main()\n{\n    vec3 b = U3 - normalize( U4 );\n    O = vec4( b, 1.0 );\n}', 'U3 - vec3( normalize( U4 ) )');
patches('truncation: mix( vec4, vec3, float )', 'void main()\n{\n    vec4 a = vec4( 1.0 );\n    a.rgb = mix( U4, U3, U1 );\n    O = a;\n}', 'mix( vec3( U4 ), vec3( U3 ), vec3( U1 ) )');
patches('truncation: lerp, spelled as in HLSL', 'void main()\n{\n    vec4 a = vec4( 1.0 );\n    a.rgb = lerp( U4 * U4.a, U3, 0.5 );\n    O = a;\n}', 'lerp( vec3( U4 * U4.a )');
patches('truncation: lerp as a function argument', 'vec3 F( vec3 x )\n{\n    return x;\n}\nvoid main()\n{\n    O = vec4( F( mix( U4, U3, 0.5 ) ), 1.0 );\n}', 'mix( vec3( U4 ), vec3( U3 ), vec3( 0.5 ) )');
patches('truncation: max( vec4, vec3 ) inside a longer expression', 'void main()\n{\n    vec3 b = mix( U4, U3, U1 ) * U4 + max( U4, U3 );\n    O = vec4( b, 1.0 );\n}', 'max( vec3( U4 ), vec3( U3 ) )');
patches('truncation: distance( float, vec3 ) broadcasts', 'void main()\n{\n    float d = distance( U1, U3 );\n    O = vec4( d );\n}', 'distance( vec3( U1 ), vec3( U3 ) )');
patches('truncation: dot( vec3, vec4 )', 'void main()\n{\n    float d = dot( U3, U4 );\n    O = vec4( d );\n}', 'dot( vec3( U3 ), vec3( U4 ) )');
patches('truncation: cross( vec4, vec3 )', 'void main()\n{\n    vec3 d = cross( U4, U3 );\n    O = vec4( d, 1.0 );\n}', 'cross( vec3( U4 ), vec3( U3 ) )');
patches('truncation: the smallest size wins ( vec2 with vec4 )', 'void main()\n{\n    vec2 d = max( U4, U2 );\n    O = vec4( d, 0.0, 1.0 );\n}', 'max( vec2( U4 ), vec2( U2 ) )');
patches('truncation: two calls on a line, the second is the culprit', 'void main()\n{\n    vec3 d = max( U3, U3 ) + min( U4, U3 );\n    O = vec4( d, 1.0 );\n}', 'min( vec3( U4 ), vec3( U3 ) )');

patches('truncation: branches of a conditional expression', 'void main()\n{\n    vec3 a = U1 > 0.5 ? U4 : U3;\n    O = vec4( a, 1.0 );\n}', 'U1 > 0.5 ? vec3( U4 ) : U3');
patches('truncation: the larger branch last', 'void main()\n{\n    vec3 a = U3;\n    a.xy = U1 > 0.5 ? U4.xy : U3;\n    O = vec4( a, 1.0 );\n}', 'U4.xy : vec2( U3 )');
patches('truncation: a 4x4 matrix times a vec3 (the matrix is cut)', MUL + 'void main()\n{\n    vec3 p = mul( M4, U3 );\n    O = vec4( p, 1.0 );\n}', 'mul(mat3(M4),U3)');
patches('truncation: a vec3 times a 4x4 matrix', MUL + 'void main()\n{\n    vec3 p = mul( U3, M4 );\n    O = vec4( p, 1.0 );\n}', 'mul(U3,mat3(M4))');
patches('truncation: a vec4 times a 3x3 matrix (the vector is cut)', MUL + 'void main()\n{\n    vec3 p = mul( M3, U4 );\n    O = vec4( p, 1.0 );\n}', 'mul(M3,vec3(U4))');
patches('truncation: a texture coordinate with too many components', 'void main()\n{\n    O = PdxTex2D( T, U3 );\n}', 'PdxTex2D( T, vec2( U3 ) )');
patches('truncation: a lod coordinate, two calls on the line', 'void main()\n{\n    O = PdxTex2D( T, U2 ) + PdxTex2DLod( T, U4, 0.0 );\n}', 'PdxTex2DLod( T, vec2( U4 ), 0.0 )');

// an int or float in a place that wants a bool (HLSL: non-zero is true)
patches('bool: ! of an int', 'void main()\n{\n    int i = I1;\n    if ( !i ) O = vec4( 1.0 ); else O = vec4( 0.0 );\n}', '!bool(i)');
patches('bool: && with an int on the left', 'void main()\n{\n    int i = I1;\n    if ( i && U1 > 0.5 ) O = vec4( 1.0 ); else O = vec4( 0.0 );\n}', 'bool(i) && U1 > 0.5');
patches('bool: || with a float on the left and arithmetic around', 'void main()\n{\n    float f = U1;\n    bool b = f * 2.0 || I1 > 2;\n    O = vec4( b );\n}', 'bool(f * 2.0) || I1 > 2');
patches('bool: an int condition', 'void main()\n{\n    int i = I1;\n    if ( i ) O = vec4( 1.0 ); else O = vec4( 0.0 );\n}', 'if(bool(i))');
patches('bool: a float loop condition', 'void main()\n{\n    float f = U1;\n    while ( f ) { f -= 1.0; }\n    O = vec4( f );\n}', 'while(bool(f))');
patches('bool: the condition of ?:', 'void main()\n{\n    float f = U1;\n    O = vec4( f ? 1.0 : 0.0 );\n}', 'bool(f)? 1.0 : 0.0');

// a conditional expression with a scalar branch: HLSL broadcasts it
patches('truncation: scalar branch of ?: (right)', 'void main()\n{\n    vec3 a = I1 > 0 ? U3 : 0.0;\n    O = vec4( a, 1.0 );\n}', 'I1 > 0 ? U3 : vec3( 0.0 )');
patches('truncation: scalar branch of ?: (left)', 'void main()\n{\n    vec3 a = I1 > 0 ? 1.0 : U3;\n    O = vec4( a, 1.0 );\n}', 'I1 > 0 ? vec3( 1.0 ) : U3');
patches('truncation: scalar branch of ?: next to a vec4', 'void main()\n{\n    vec4 a = I1 > 0 ? U4 : 1.0;\n    O = a;\n}', 'I1 > 0 ? U4 : vec4( 1.0 )');

// the place of a conversion is the one that clears the error, not the first that changes it
patches('truncation: an int declaration before the culprit', 'void main()\n{\n    vec3 a = U3; for ( int i = 0; i < I1; i++ ) { a += U4; } O = vec4( a, 1.0 );\n}', 'a += vec3( U4 )');
patches('truncation: a float declaration on the line', 'void main()\n{\n    float k = 1.0; vec3 a = U3; a = U4; O = vec4( a, k );\n}', 'a = vec3( U4 )');
patches('truncation: an int declaration on the line, a swizzle target', 'void main()\n{\n    vec2 a; int j = 0; a.xy = U3; O = vec4( a, j, 1.0 );\n}', 'a.xy = vec2( U3 )');
patches('truncation: two places on one line', 'void main()\n{\n    vec3 a = U4; vec2 b = U3; O = vec4( a, b.x );\n}', 'vec3 a = vec3( U4 ); vec2 b = vec2( U3 );');

// a statement over several lines
patches('truncation: a declaration over two lines', 'void main()\n{\n    vec3 a =\n        U4 * U1;\n    O = vec4( a, 1.0 );\n}', 'vec3 a = vec3( U4 * U1 );');
patches('truncation: a call over three lines', 'void main()\n{\n    vec3 a = mix(\n        U4,\n        U3, U1 );\n    O = vec4( a, 1.0 );\n}', 'mix( vec3( U4 ), vec3( U3 ), vec3( U1 ) )');

// modulo: the operands are whole expressions
patches('modulo: a call on the left', 'void main() { O = vec4( floor( U1 ) % 2.0 ); }', 'floor( U1 ) - ( 2.0 ) * trunc( floor( U1 ) / ( 2.0 ) )');
patches('modulo: a call on the right', 'void main() { O = vec4( U1 % max( 2.0, 1.0 ) ); }', 'U1 - ( max( 2.0, 1.0 ) ) * trunc( U1 / ( max( 2.0, 1.0 ) ) )');
patches('modulo: nested parentheses', 'void main() { O = vec4( ( U1 * ( U1 + 1.0 ) ) % 2.0 ); }', '( U1 * ( U1 + 1.0 ) ) - ( 2.0 ) * trunc( ( U1 * ( U1 + 1.0 ) ) / ( 2.0 ) )');
patches('modulo: same precedence as the product before it', 'void main() { O = vec4( U1 * U1 % 2.0 ); }', 'U1 * U1 - ( 2.0 ) * trunc( U1 * U1 / ( 2.0 ) )');
patches('modulo: a signed factor stays in the product', 'void main() { O = vec4( 2.0 * -U1 % 3.0 ); }', '2.0 * -U1 - ( 3.0 ) * trunc( 2.0 * -U1 / ( 3.0 ) )');
patches('truncation: nested conditional with a scalar branch', 'void main()\n{\n    vec3 a = I1 > 0 ? U3 : I1 > 1 ? 1.0 : U3;\n    O = vec4( a, 1.0 );\n}', 'I1 > 1 ? vec3( 1.0 ) : U3');

// a comparison wrapped for arithmetic: a ?: in a group is no comparison
patches('bool in arithmetic: a vector conditional stays whole', 'void main() { vec3 r = ( U1 > 0.5 ) * U3 + ( U1 > 0.2 ? U3 * 2.0 : U3 ); O = vec4( r, 1.0 ); }', 'float( U1 > 0.5 ) * U3 + ( U1 > 0.2 ? U3 * 2.0 : U3 )');

// what cannot be patched must still fail
refused('a vector smaller than its target stays an error', 'void main()\n{\n    vec4 a = U3;\n    O = a;\n}');
refused('an undeclared name stays an error', 'void main()\n{\n    O = vec4( Missing );\n}');

// the fix is not looked for twice: a message of another kind returns null
report(fixHlslisms(HEAD + 'void main() { O = vec4( Missing ); }\n', "ERROR: 0:4: 'Missing' : undeclared identifier\n") === null, 'fixHlslisms: other errors are not patched');

// the matrix forms through glslang: the constants fold to the element HLSL means (HLSL rows, GLSL columns)
const MATRIX_HEAD = '#define float2x2 mat2\n#define float3x3 mat3\n#define float4x4 mat4\n#define float3 vec3\n#define static\nlayout(location=0) out vec4 O;\n';
const folds = (name: string, decl: string, use: string, value: string): void =>
{
    try
    {
        const out = glslToEs(xs, '#version 450\n' + hlslPasses(`${MATRIX_HEAD}${decl}\nvoid main() { O = vec4( ${use} ); }\n`), 'ps');
        report(out.includes(`O = vec4(${value});`), `matrix: ${name}`, `  expected O = vec4(${value}), got: ${out.split('\n').filter((l) => /\bO =/.test(l)).join(' ')}`);
    }
    catch (e)
    {
        report(false, `matrix: ${name}`, '  ' + String((e as Error).message).split('\n').slice(0, 2).join('\n  '));
    }
};
// element [column][row]: HLSL M[row][col] = the n-th value of the n-th row
folds('flat values', 'static const float2x2 M = { 1, 2, 3, 4 };', 'M[1][0]', '2.0');
folds('flat values, constructor form', 'static const float2x2 M = float2x2( 1, 2, 3, 4 );', 'M[1][0]', '2.0');
folds('rows in braces', 'static const float3x3 M = { { 1, 2, 3 }, { 4, 5, 6 }, { 7, 8, 9 } };', 'M[1][0]', '2.0');
folds('row vectors in a global constant', 'static const float3x3 M = { float3( 1, 2, 3 ), float3( 4, 5, 6 ), float3( 7, 8, 9 ) };', 'M[2][1]', '6.0');
folds('array of matrices', 'static const float2x2 M[2] = { { 1, 2, 3, 4 }, { { 5, 6 }, { 7, 8 } } };', 'M[1][1][0]', '6.0');

// a global array made by casting a uniform array: an accessor, through glslang
const ARRAY_HEAD = '#define float2 vec2\n#define float4 vec4\n#define static\nlayout(location=0) out vec4 O;\nuniform float4 P[2];\nuniform float2 Q[4];\n';
const compilesAfterPasses = (name: string, body: string): void =>
{
    try
    {
        glslToEs(xs, '#version 450\n' + hlslPasses(`${ARRAY_HEAD}${body}`), 'ps');
        report(true, `array cast: ${name}`);
    }
    catch (e)
    {
        report(false, `array cast: ${name}`, '  ' + String((e as Error).message).split('\n').slice(0, 2).join('\n  '));
    }
};
compilesAfterPasses('float4[2] to float2[4], indexed with an int', 'static const float2 X[4] = (float2[4])P;\nvoid main() { int i = 3; O = vec4( X[i], X[1 + i - 3] ); }');
compilesAfterPasses('float2[4] to float4[2], used in a call', 'static const float4 Y[2] = (float4[2])Q;\nfloat4 F( int i ) { return Y[i]; }\nvoid main() { O = F( 1 ); }');
compilesAfterPasses('float4[2] to float[8]', 'static const float Z[8] = (float[8])P;\nvoid main() { O = vec4( Z[5] ); }');


// ---------------------------------------------------------------------------------------------------------------------
// Assembly of an Effect from a small game folder of its own (no engine layer: the shader is written in GLSL types)
// ---------------------------------------------------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'ckp-shader-check-'));

try
{
    mkdirSync(join(root, 'game', 'gfx', 'FX'), { recursive: true });
    writeFileSync(
        join(root, 'game', 'gfx', 'FX', 'test.shader'),
        `
VertexStruct VS_INPUT { float3 Position : POSITION; }
VertexStruct VS_OUTPUT { float4 Position : PDX_POSITION; float2 UV : TEXCOORD0; }
VertexShader =
{
    MainCode VS
    {
        Input = "VS_INPUT"
        Output = "VS_OUTPUT"
        Code [[
            PDX_MAIN
            {
                VS_OUTPUT Out;
                Out.Position = vec4( Input.Position, 1.0 );
                Out.UV = Input.Position.xy;
                return Out;
            }
        ]]
    }
}
PixelShader =
{
    TextureSampler Diffuse { Ref = PdxTexture0 }
    TextureSampler Unused { Ref = PdxTexture5 }
    TextureSampler Pasted3 { Ref = PdxTexture7 }
    MainCode PS
    {
        TextureSampler Local { Ref = PdxTexture1 }
        Input = "VS_OUTPUT"
        Output = "PDX_COLOR"
        Code [[
            PDX_MAIN
            {
                #define SAMPLE( N ) texture( Pasted##N, Input.UV )
                vec4 c = texture( DIFFUSE_TEXTURE, Input.UV );
                c.rgb += SAMPLE( 3 ).rgb;
                c.rgb = mix( c, vec3( 0.5 ), 0.5 );
                c.rgb *= texture( Local, Input.UV );
                return c;
            }
        ]]
    }
    MainCode PS_other
    {
        TextureSampler Local { Ref = PdxTexture2 }
        Input = "VS_OUTPUT"
        Output = "PDX_COLOR"
        Code [[
            PDX_MAIN
            {
                return texture( Local, Input.UV );
            }
        ]]
    }
}
Effect Test { VertexShader = "VS" PixelShader = "PS" Defines = { "DIFFUSE_TEXTURE Diffuse" } }
Effect Other { VertexShader = "VS" PixelShader = "PS_other" }
`
    );
    const lib = new ShaderLibrary(join(root, 'game'));
    const test = await lib.compile({ file: 'gfx/FX/test.shader', effect: 'Test' });
    const other = await lib.compile({ file: 'gfx/FX/test.shader', effect: 'Other' });
    report(test.samplers.map((s) => `${s.name}@${s.ref}`).join(' ') === 'Diffuse@PdxTexture0 Pasted3@PdxTexture7 Local@PdxTexture1', 'assembly: samplers named by a define, by token pasting and declared in the MainCode', test.samplers.map((s) => s.name).join(' '));
    report(other.samplers.map((s) => `${s.name}@${s.ref}`).join(' ') === 'Local@PdxTexture2', 'assembly: a sampler of another MainCode with the same name is that main\'s own', other.samplers.map((s) => `${s.name}@${s.ref}`).join(' '));
    report(!/Pasted3|Unused/.test(other.fragment), 'assembly: a sampler only a pasting could build is dropped with the code that pastes', other.fragment);
    report(/mix\(vec3\(c\.xyz\)/.test(test.fragment), 'assembly: mix( vec4, vec3, … ) into .rgb is cut to three components', test.fragment);
}
catch (e)
{
    report(false, 'assembly: Effect from a small game folder', '  ' + String((e as Error).message).split('\n').slice(0, 3).join('\n  '));
}
finally
{
    rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// With the game: real Effects that need the passes above
// ---------------------------------------------------------------------------------------------------------------------

const gameDir = resolveGameDir(defaultInstall());

if (gameDir)
{
    const lib = new ShaderLibrary(gameDir);
    // [file, effect, uv1, what it needs]
    const real: [string, string, boolean, string][] = [
        ['gfx/FX/pdxmesh.shader', 'mesh_vfx_head_halo', false, 'lerp of a vec4 and a vec3 into .rgb'],
        ['gfx/FX/jomini/portrait.shader', 'portrait_attachment_pattern_no_blend_alpha_to_coverage', true, 'a flat float4x4 initializer (the dither table)'],
        ['gfx/FX/pdxmesh.shader', 'standard_atlas', true, 'an ordinary mesh Effect']
    ];

    for (const [file, effect, uv1, what] of real)
    {
        try
        {
            await lib.compile(viewerShaderRequest(file, effect, uv1));
            report(true, effect);
        }
        catch (e)
        {
            report(false, `game: ${effect} (${what})`, '  ' + String((e as Error).message).split('\n').slice(0, 3).join('\n  '));
        }
    }
}
else
    console.log('(no game install found: the three real Effects were not compiled)');

console.log(`${count - bad} of ${count} checks passed`);
process.exit(bad ? 1 : 0);
