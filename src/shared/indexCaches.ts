/**
 * Settings "Index caches kept" (Settings.indexCachesKept): how many mod lists' index caches the app keeps (one per
 * layering, docs/indexer.md "One per mod list"), the least recently used dropped first.
 */
export const INDEX_CACHES_MIN = 1;
export const INDEX_CACHES_MAX = 8;
export const INDEX_CACHES_DEFAULT = 3;

/** The count in effect: absent or not a number = the default, else a whole number within 1 to 8. */
export function indexCachesKept(setting: number | undefined): number
{
    if (typeof setting !== 'number' || !Number.isFinite(setting))
        return INDEX_CACHES_DEFAULT;

    return Math.min(INDEX_CACHES_MAX, Math.max(INDEX_CACHES_MIN, Math.round(setting)));
}
