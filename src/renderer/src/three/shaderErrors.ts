/**
 * WebGL shader errors of the game-shader materials → the shader log (main process, logs/shaders.log). Hooked into
 * every renderer (three's `debug.onShaderError`); the effect is read from the marker comment gameMaterial puts in
 * front of each program's source.
 */
import { api } from '../api';

/** First line of a program's sources: which Effect it is (see gameMaterial). */
export function effectMarker(file: string, effect: string, defines: string[]): string
{
    return `// effect ${file} · ${effect}${defines.length ? ' · ' + defines.join(' ') : ''}\n`;
}

/** The source lines an info log points at ("ERROR: 0:123: …"), two lines around each. */
function context(src: string, info: string): string
{
    const lines = src.split('\n');
    const nums = [...new Set([...info.matchAll(/(?:ERROR|WARNING): *\d+:(\d+):/g)].map((m) => Number(m[1])))].slice(0, 10);
    const out: string[] = [];

    for (const n of nums)
    {
        for (let i = Math.max(1, n - 2); i <= Math.min(lines.length, n + 2); i++)
            out.push(`${i === n ? '>' : ' '}${String(i).padStart(5)} | ${lines[i - 1]}`);

        out.push('');
    }

    return out.join('\n');
}

export function reportShaderError(gl: WebGLRenderingContext, program: WebGLProgram, vs: WebGLShader, fs: WebGLShader): void
{
    let effect = 'program without effect marker (viewer material)';
    const parts: string[] = [];

    for (
        const [stage, sh] of [
            ['vertex', vs],
            ['fragment', fs]
        ] as const
    )
    {
        const src = gl.getShaderSource(sh) ?? '';
        const m = /^\/\/ effect (.+)$/m.exec(src);

        if (m)
            effect = m[1];

        if (gl.getShaderParameter(sh, gl.COMPILE_STATUS))
            continue;

        const info = (gl.getShaderInfoLog(sh) ?? '').trim();
        parts.push(`${stage} shader failed:\n${info}\n${context(src, info)}`);
    }

    const link = (gl.getProgramInfoLog(program) ?? '').trim();

    if (link)
        parts.push('program: ' + link);

    void api.logShader({ kind: 'WEBGL', title: effect, detail: parts.join('\n') }).catch(() =>
    {});
    console.error(`Shader error in ${effect} — details in logs/shaders.log`);
}
