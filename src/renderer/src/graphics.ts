import type { GraphicsSettings } from '../../shared/api';

/**
 * Graphics quality of the 3D views (Settings → Graphics; docs/app-architecture.md "Settings"): a preset, each value
 * overridable. Read when a view opens — a change applies to views opened afterwards. `high` is the full look (the
 * default); `low` for weaker graphics cards: no supersampling, no MSAA, no shadows, no trees and objects on the map.
 */
export const GRAPHICS_PRESETS: Record<'low' | 'medium' | 'high', Required<Omit<GraphicsSettings, 'preset'>>> = {
    low: { renderScale: 0.75, antialias: false, anisotropy: 2, mapObjects: false, shadows: false },
    medium: { renderScale: 1, antialias: true, anisotropy: 4, mapObjects: true, shadows: false },
    high: { renderScale: 2, antialias: true, anisotropy: 16, mapObjects: true, shadows: true }
};

let current: Required<Omit<GraphicsSettings, 'preset'>> = GRAPHICS_PRESETS.high;

/** The settings as the views use them: the preset's values with the overrides on top. */
export function resolveGraphics(g: GraphicsSettings | undefined): Required<Omit<GraphicsSettings, 'preset'>>
{
    const base = GRAPHICS_PRESETS[g?.preset === 'low' || g?.preset === 'medium' ? g.preset : 'high'];
    return {
        renderScale: g?.renderScale ?? base.renderScale,
        antialias: g?.antialias ?? base.antialias,
        anisotropy: g?.anisotropy ?? base.anisotropy,
        mapObjects: g?.mapObjects ?? base.mapObjects,
        shadows: g?.shadows ?? base.shadows
    };
}

/** Called with the loaded / saved settings (App). */
export function setGraphics(g: GraphicsSettings | undefined): void
{
    current = resolveGraphics(g);
}

export function graphics(): Required<Omit<GraphicsSettings, 'preset'>>
{
    return current;
}

/**
 * Pixel ratio of a model / portrait viewer: the display's times the render scale (high: 2× supersampling), capped at 3
 * and at ~9 M pixels.
 */
export function viewerPixelRatio(width = 0, height = 0): number
{
    const r = (window.devicePixelRatio || 1) * current.renderScale;
    return Math.max(0.5, Math.min(3, r, width && height ? Math.sqrt(9e6 / (width * height)) : 3));
}

/** Pixel ratio of the 3D map: the display's (at most 2) scaled down below `high` (the map is not supersampled). */
export function mapPixelRatio(): number
{
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    return Math.max(0.5, dpr * Math.min(1, current.renderScale));
}

/** Anisotropic filtering: the setting, at most what the card can. */
export function anisotropy(max: number): number
{
    return Math.max(1, Math.min(max, current.anisotropy));
}
