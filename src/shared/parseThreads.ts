/**
 * Parse threads of a build (Settings.parseThreads; docs/indexer.md "Parallel parsing"): the settings dialog shows the
 * automatic number, the index worker uses it.
 */

/** Settings.parseThreads: parse on the index worker's own thread, no parse threads */
export const PARSE_THREADS_OFF = -1;
/** the most the dialog offers (each thread takes ~110 MB of the heap all threads of the main process share, 4 GB) */
export const PARSE_THREADS_MAX = 8;

/**
 * automatic: the cores but two (the index worker applies the results, the shader pool compiles), up to 4, measured
 * (docs/indexer.md "Parallel parsing"): AGOT builds in 22 s with 2 threads, ~16 s with 3, ~15 s with 4 to 9; the index
 * worker's applying bounds a build from there, and each thread more costs ~100 MB of the process
 */
export function autoParseThreads(cores: number): number
{
    return Math.max(1, Math.min(4, cores - 2));
}

/** The threads a setting gives: 0 = none (parse on the index worker), else the number. Absent / 0 = automatic. */
export function parseThreadCount(setting: number | undefined, cores: number): number
{
    if (setting === PARSE_THREADS_OFF)
        return 0;

    if (setting && setting > 0)
        return Math.min(PARSE_THREADS_MAX, Math.round(setting));

    return autoParseThreads(cores);
}
