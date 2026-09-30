/** Province kinds of the map (map_data/default.map lists — docs/map.md). */
import { parse } from '../indexer/parser.ts';
import type { MapKind } from '../../shared/api.ts';

export const MAP_KINDS: MapKind[] = ['none', 'land', 'sea', 'lake', 'river', 'impassable', 'impassable_sea'];

/** default.map lists → province kind */
const KIND_LISTS: Record<string, MapKind> = {
    sea_zones: 'sea',
    lakes: 'lake',
    river_provinces: 'river',
    impassable_mountains: 'impassable',
    impassable_seas: 'impassable_sea'
};

/**
 * Per province: an index into MAP_KINDS — land when definition.csv names it, then what default.map's lists say
 * (`= RANGE { from to }` or `= LIST { ids }`).
 */
export function readKinds(defaultMap: string, defined: boolean[]): number[]
{
    const kinds: number[] = defined.map((d) => (d ? 1 : 0));

    for (const n of parse(defaultMap))
    {
        const kind = n.k && KIND_LISTS[n.k];

        if (!kind || !Array.isArray(n.v))
            continue;

        const nums = n.v.filter((c) => !c.k).map((c) => parseInt(c.v as string, 10));
        const ids = n.tag === 'RANGE' && nums.length >= 2 ? Array.from({ length: Math.max(0, nums[1] - nums[0] + 1) }, (_, i) => nums[0] + i) : nums;

        for (const p of ids)
            if (p > 0 && p < kinds.length)
                kinds[p] = MAP_KINDS.indexOf(kind);
    }

    return kinds;
}
