/**
 * The 3D map's camera (docs/map.md, "3D map"): free — it orbits a point on the map, turned all the way round and tilted
 * from straight down to just above the horizon, at any distance (no zoom steps with fixed tilts as in the game).
 * Dragging pans (the grabbed point stays under the pointer), the wheel zooms smoothly towards the pointer, right /
 * middle dragging turns and tilts, `focus` flies to a box, `resetNorth` turns back to north up. `zoom` is the game's
 * zoom step (NCamera ZOOM_STEPS) for the eye's height: what the map shows at a height (names, trees, border bands)
 * follows the game's steps.
 */
import * as THREE from 'three';
import type { MapTerrainInfo } from '../../../../shared/api';

/** A list's value at a fractional index (linear between entries, clamped). */
function at(list: number[], i: number): number
{
    const k = Math.max(0, Math.min(list.length - 1, i));
    const a = Math.floor(k);
    const b = Math.min(list.length - 1, a + 1);
    return list[a] + (list[b] - list[a]) * (k - a);
}

/** The fractional index at which a rising list reaches a value (clamped to the list). */
function indexOf(list: number[], v: number): number
{
    if (!list.length || v <= list[0])
        return 0;

    for (let i = 1; i < list.length; i++)
        if (v <= list[i])
            return i - 1 + (v - list[i - 1]) / (list[i] - list[i - 1] || 1);

    return list.length - 1;
}

const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const RAD = Math.PI / 180;

/** the tilt's range (degrees above the horizon): just above flat … straight down */
const PITCH_MIN = 2;
const PITCH_MAX = 90;
/** the nearest the eye comes to the point it looks at (map pixels) */
const DIST_MIN = 1.5;

export class MapCamera
{
    readonly camera = new THREE.PerspectiveCamera();
    /** the point looked at (map pixels) */
    x: number;
    z: number;
    /** the eye's distance from the point looked at, and where the wheel is taking it */
    private dist: number;
    private distTo: number;
    /** turned (radians; 0: north up — any angle) and tilted (degrees above the horizon) */
    private yaw = 0;
    private pitch: number;
    /** the tilt of the overview (the game's farthest step's) */
    private basePitch: number;
    /** the ground's height under the point looked at (followed smoothly) */
    private ground: number;
    /** the wheel's point on the canvas (zooming keeps the ground under it) */
    private anchor: [number, number] | null = null;
    private flight: { from: [number, number, number]; to: [number, number, number]; t: number; } | null = null;
    private turn: { from: [number, number]; to: [number, number]; t: number; } | null = null;
    private w = 1;
    private h = 1;
    private cfg: MapTerrainInfo['camera'];
    private size: [number, number];
    /** the surface's height (terrain or water) at a map point */
    private surface: (x: number, z: number) => number;

    constructor(cfg: MapTerrainInfo['camera'], size: [number, number], surface: (x: number, z: number) => number)
    {
        this.cfg = cfg;
        this.size = size;
        this.surface = surface;
        this.x = size[0] / 2;
        this.z = size[1] / 2;
        this.basePitch = this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, at(cfg.tilts, cfg.tilts.length - 1)));
        this.dist = this.distTo = this.maxDist();
        this.ground = surface(this.x, this.z);
    }

    /** The canvas's size (CSS pixels). */
    setSize(w: number, h: number): void
    {
        this.w = Math.max(1, w);
        this.h = Math.max(1, h);
    }

    /** the farthest the eye goes: the whole map in view from above, with room around */
    private maxDist(): number
    {
        return (Math.max(this.size[0], this.size[1]) * 1.2) / Math.tan(((this.cfg.fov || 40) * RAD) / 2);
    }

    /** The game's zoom step (fractional; 0 nearest) for the eye's height above the point looked at. */
    get zoom(): number
    {
        return indexOf(this.cfg.heights, this.camera.position.y - this.ground);
    }

    /** The turn (radians, 0: north up) — the compass. */
    get heading(): number
    {
        return this.yaw;
    }

    /** Where it looks from (the test API, testApi.ts): the point looked at, the eye's distance, turn and tilt in degrees. */
    get pose(): { x: number; z: number; dist: number; yaw: number; pitch: number; }
    {
        return { x: this.x, z: this.z, dist: this.dist, yaw: this.yaw / RAD, pitch: this.pitch };
    }

    /** Looks from a pose at once (no flight; the tilt still rises where the eye would be under the ground). */
    setPose(p: { x: number; z: number; dist: number; yaw: number; pitch: number; }): void
    {
        this.x = p.x;
        this.z = p.z;
        this.clamp();
        this.dist = this.distTo = Math.max(DIST_MIN, Math.min(this.maxDist(), p.dist));
        this.yaw = p.yaw * RAD;
        this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, p.pitch));
        this.flight = this.turn = this.anchor = null;
        this.ground = this.groundNear();
        this.apply();
    }

    /** A flight, turn or zoom under way, or the ground still being followed. */
    get moving(): boolean
    {
        return !!this.flight || !!this.turn || Math.abs(Math.log(this.distTo / this.dist)) > 1e-3 || Math.abs(this.groundNear() - this.ground) > 0.02;
    }

    /** the ground under the point looked at: a few samples around it */
    private groundNear(): number
    {
        const r = this.dist * 0.1;
        return (this.surface(this.x, this.z) + this.surface(this.x - r, this.z) + this.surface(this.x + r, this.z) + this.surface(this.x, this.z - r) + this.surface(this.x, this.z + r)) / 5;
    }

    /** the eye for a tilt */
    private eyeAt(pitch: number, out = new THREE.Vector3()): THREE.Vector3
    {
        const back = this.dist * Math.cos(pitch * RAD);
        return out.set(this.x + Math.sin(this.yaw) * back, this.ground + this.dist * Math.sin(pitch * RAD), this.z + Math.cos(this.yaw) * back);
    }

    /** Places the three.js camera. */
    apply(): void
    {
        const c = this.camera;
        // (never under the ground: tilted up as far as it takes)
        const eye = this.eyeAt(this.pitch);
        const clear = Math.max(0.3, this.dist * 0.02);

        for (let i = 0; i < 90 && this.pitch < PITCH_MAX && eye.y < this.surface(eye.x, eye.z) + clear; i++)
            this.eyeAt(this.pitch = Math.min(PITCH_MAX, this.pitch + 1), eye);

        c.position.copy(eye);
        c.rotation.set(-this.pitch * RAD, this.yaw, 0, 'YXZ');
        c.fov = this.cfg.fov;
        c.aspect = this.w / this.h;
        c.near = Math.max(0.05, Math.min(this.dist * 0.02, (eye.y - this.ground) * 0.05));
        c.far = this.dist * 8 + 20000;
        c.updateProjectionMatrix();
        c.updateMatrixWorld();
    }

    /** where fog starts and is complete (distance from the eye) */
    fogRange(): [number, number]
    {
        return [this.dist * 2.2 + 1000, this.dist * 7 + 6000];
    }

    /** The ray through a canvas point (CSS pixels). */
    ray(sx: number, sy: number): THREE.Ray
    {
        const r = new THREE.Raycaster();
        r.setFromCamera(new THREE.Vector2((sx / this.w) * 2 - 1, 1 - (sy / this.h) * 2), this.camera);
        return r.ray;
    }

    /** Where a canvas point's ray meets the level `y`, or null (looking above it). */
    onLevel(sx: number, sy: number, y: number): THREE.Vector3 | null
    {
        return this.ray(sx, sy).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
    }

    private clamp(): void
    {
        this.x = Math.max(0, Math.min(this.size[0], this.x));
        this.z = Math.max(0, Math.min(this.size[1], this.z));
    }

    /**
     * Pans so that the ground point under `from` comes under `to` (canvas pixels); towards the horizon (where a pixel is
     * far away on the ground, or the pointer is above the horizon) by the screen's axes at the point looked at.
     */
    pan(from: [number, number], to: [number, number]): void
    {
        const a = this.onLevel(from[0], from[1], this.ground);
        const b = this.onLevel(to[0], to[1], this.ground);
        const near = (p: THREE.Vector3 | null): p is THREE.Vector3 => !!p && Math.hypot(p.x - this.x, p.z - this.z) < this.dist * 3;

        if (near(a) && near(b))
        {
            this.x += a.x - b.x;
            this.z += a.z - b.z;
        }
        else
        {
            const k = (2 * this.dist * Math.tan((this.camera.fov * RAD) / 2)) / this.h;
            const dx = (to[0] - from[0]) * k;
            const dy = (to[1] - from[1]) * k;
            const [s, c] = [Math.sin(this.yaw), Math.cos(this.yaw)];
            // (right on the ground: (cos, −sin); ahead: (−sin, −cos))
            this.x += -c * dx - s * dy;
            this.z += s * dx - c * dy;
        }

        this.flight = null;
        this.clamp();
        this.apply();
    }

    /** Turns (horizontal pixels: all the way round) and tilts (vertical pixels: from straight down to the horizon). */
    rotate(dx: number, dy: number): void
    {
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch + dy * 0.25));
        this.turn = null;
        this.apply();
    }

    /** The wheel: smooth, about a quarter nearer or farther per notch (deltaY 100), towards the pointer. */
    wheel(deltaY: number, sx: number, sy: number): void
    {
        this.distTo = Math.max(DIST_MIN, Math.min(this.maxDist(), this.distTo * Math.exp(deltaY * 0.0022)));
        this.anchor = [sx, sy];
        this.flight = null;
    }

    /** The distance from which a box of map pixels, looked at from its centre, is wholly in view (turn and tilt kept). */
    private distFor(box: [number, number, number, number]): number
    {
        const [x0, z0, x1, z1] = box;
        const keep = [this.x, this.z, this.dist, this.ground, this.pitch] as const;
        this.x = (x0 + x1) / 2;
        this.z = (z0 + z1) / 2;
        this.ground = this.surface(this.x, this.z);
        const v = new THREE.Vector3();
        const fits = (d: number): boolean =>
        {
            this.dist = d;
            this.pitch = keep[4];
            this.apply();

            for (
                const [x, z] of [
                    [x0, z0],
                    [x1, z0],
                    [x0, z1],
                    [x1, z1]
                ]
            )
            {
                v.set(x, this.ground, z).project(this.camera);

                if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1)
                    return false;
            }

            return true;
        };
        // (on a log scale: near and far distances equally fine)
        let lo = Math.log(DIST_MIN);
        let hi = Math.log(this.maxDist());

        if (fits(Math.exp(lo)))
            hi = lo;
        else if (fits(Math.exp(hi)))
        {
            for (let i = 0; i < 24; i++)
            {
                const m = (lo + hi) / 2;

                if (fits(Math.exp(m)))
                    hi = m;
                else
                    lo = m;
            }
        }

        [this.x, this.z, this.dist, this.ground, this.pitch] = keep;
        this.apply();
        return Math.exp(hi);
    }

    /** Flies to a box of map pixels (x0 y0 x1 y1) with a margin around it (`pad` times its size). */
    focus(box: [number, number, number, number], now = false, pad = 1.3): void
    {
        const [x0, y0, x1, y1] = box;
        const mx = ((x1 - x0 + 1) * (pad - 1)) / 2;
        const my = ((y1 - y0 + 1) * (pad - 1)) / 2;
        const to: [number, number, number] = [(x0 + x1) / 2, (y0 + y1) / 2, this.distFor([x0 - mx, y0 - my, x1 + mx, y1 + my])];
        this.anchor = null;

        if (now)
        {
            [this.x, this.z, this.dist] = to;
            this.distTo = this.dist;
            this.ground = this.surface(this.x, this.z);
            this.flight = null;
        }
        else
            this.flight = { from: [this.x, this.z, this.dist], to, t: 0 };
    }

    /** The whole map in view, north up, tilted as the game's farthest step. */
    overview(): void
    {
        this.yaw = 0;
        this.pitch = this.basePitch;
        this.turn = null;
        this.focus([0, 0, this.size[0] - 1, this.size[1] - 1], true, 1.02);
    }

    /** Turns back to north up (the nearest way round) and the overview's tilt, where it is. */
    resetNorth(): void
    {
        const full = Math.PI * 2;
        const to = Math.round(this.yaw / full) * full;
        this.turn = { from: [this.yaw, this.pitch], to: [to, this.basePitch], t: 0 };
    }

    /** Advances the animations by `dt` seconds; true while something still moves. */
    step(dt: number): boolean
    {
        let moving = false;

        if (this.turn)
        {
            const tr = this.turn;
            tr.t = Math.min(1, tr.t + dt / 0.6);
            const k = ease(tr.t);
            this.yaw = tr.from[0] + (tr.to[0] - tr.from[0]) * k;
            this.pitch = tr.from[1] + (tr.to[1] - tr.from[1]) * k;

            if (tr.t >= 1)
                this.turn = null;

            moving = true;
        }

        if (this.flight)
        {
            const f = this.flight;
            f.t = Math.min(1, f.t + dt / 0.8);
            const k = ease(f.t);
            this.x = f.from[0] + (f.to[0] - f.from[0]) * k;
            this.z = f.from[1] + (f.to[1] - f.from[1]) * k;
            // (out and in again on long flights: the distance arcs over the way)
            const way = Math.hypot(f.to[0] - f.from[0], f.to[1] - f.from[1]);
            const lift = 1 + Math.min(3, way / Math.max(f.from[2], f.to[2], 1)) * Math.sin(Math.PI * k);
            this.dist = this.distTo = Math.min(this.maxDist(), Math.exp(Math.log(f.from[2]) + (Math.log(f.to[2]) - Math.log(f.from[2])) * k) * lift);

            if (f.t >= 1)
                this.flight = null;

            moving = true;
        }
        else if (Math.abs(Math.log(this.distTo / this.dist)) > 1e-3)
        {
            const before = this.anchor && this.onLevel(this.anchor[0], this.anchor[1], this.ground);
            this.dist *= Math.exp(Math.log(this.distTo / this.dist) * (1 - Math.exp(-dt * 12)));

            if (Math.abs(Math.log(this.distTo / this.dist)) <= 1e-3)
                this.dist = this.distTo;

            this.apply();
            const after = this.anchor && this.onLevel(this.anchor[0], this.anchor[1], this.ground);

            // (the pointer's ground point stays under it — unless it is far off towards the horizon)
            if (before && after && Math.hypot(before.x - this.x, before.z - this.z) < this.dist * 3)
            {
                this.x += before.x - after.x;
                this.z += before.z - after.z;
                this.clamp();
            }

            moving = true;
        }

        // the ground under the point looked at, followed smoothly
        const g = this.groundNear();

        if (Math.abs(g - this.ground) > 0.02)
        {
            this.ground += (g - this.ground) * (1 - Math.exp(-dt * 8));
            moving = true;
        }

        this.apply();
        return moving;
    }
}
