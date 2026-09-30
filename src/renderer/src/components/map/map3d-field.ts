/**
 * How far each point of the 3D map is from its group's border (docs/map.md, "3D map"): per cell of CELL map pixels
 * the chamfer distance (3-4, two passes) to the nearest cell of another region — water is one, rivers are none (a
 * realm goes on across them) — as map pixels × 4 in an R8 texture (up to ~64 px). The terrain shader lays the mode's
 * colours by it the way the game's gradient borders do (hollow near, filled far).
 */
export const FIELD_CELL = 4;
/** region of river provinces: never a border */
export const RIVER_REGION = 0xfffffffe;

/** The field of a mode: `region` per province id (water 0xffffffff, rivers RIVER_REGION). */
export function groupField(ids: Uint16Array, width: number, height: number, region: Uint32Array): { data: Uint8Array; w: number; h: number; }
{
    const k = FIELD_CELL;
    const w = Math.ceil(width / k);
    const h = Math.ceil(height / k);
    const reg = new Uint32Array(w * h);

    for (let y = 0; y < h; y++)
    {
        const row = Math.min(height - 1, y * k + (k >> 1)) * width;

        for (let x = 0; x < w; x++)
            reg[y * w + x] = region[ids[row + Math.min(width - 1, x * k + (k >> 1))]] ?? 0;
    }

    const differs = (o: number, r: number): boolean => o !== r && o !== RIVER_REGION;
    // (thirds of a cell: a border cell is a third away from the border)
    const d = new Uint16Array(w * h).fill(60000);

    for (let y = 0; y < h; y++)
    {
        for (let x = 0; x < w; x++)
        {
            const i = y * w + x;
            const r = reg[i];

            if (r === RIVER_REGION)
                continue;

            if ((x > 0 && differs(reg[i - 1], r)) || (x < w - 1 && differs(reg[i + 1], r)) || (y > 0 && differs(reg[i - w], r)) || (y < h - 1 && differs(reg[i + w], r)))
                d[i] = 1;
        }
    }

    for (let y = 0; y < h; y++)
    {
        for (let x = 0; x < w; x++)
        {
            const i = y * w + x;
            let v = d[i];

            if (x > 0)
                v = Math.min(v, d[i - 1] + 3);

            if (y > 0)
            {
                v = Math.min(v, d[i - w] + 3);

                if (x > 0)
                    v = Math.min(v, d[i - w - 1] + 4);

                if (x < w - 1)
                    v = Math.min(v, d[i - w + 1] + 4);
            }

            d[i] = v;
        }
    }

    for (let y = h - 1; y >= 0; y--)
    {
        for (let x = w - 1; x >= 0; x--)
        {
            const i = y * w + x;
            let v = d[i];

            if (x < w - 1)
                v = Math.min(v, d[i + 1] + 3);

            if (y < h - 1)
            {
                v = Math.min(v, d[i + w] + 3);

                if (x < w - 1)
                    v = Math.min(v, d[i + w + 1] + 4);

                if (x > 0)
                    v = Math.min(v, d[i + w - 1] + 4);
            }

            d[i] = v;
        }
    }

    const data = new Uint8Array(w * h);

    for (let i = 0; i < data.length; i++)
        data[i] = Math.min(255, Math.round(((d[i] * k) / 3) * 4));

    return { data, w, h };
}
