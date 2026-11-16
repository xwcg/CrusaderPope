/**
 * The top bar's pending change ("Re-index"; docs/app-architecture.md, "Changed files the index cannot take in"): the
 * loaded mods' (main's ModWatcher) together with the game's files the index found changed on disk while the app runs
 * (a Steam update; the index worker's `{stale}`, GameIndex.staleFiles). Both are taken in only by a build.
 */
import type { ModChange } from './api.ts';
import { tr } from './i18n.ts';

/** ModChange.mods' entry for the game's files (no mod id looks like it: theirs are descriptor paths) */
export const GAME_CHANGE_ID = '(game)';

/** At most this many paths of each side when both have some (the notice shows the first 12). */
const SHARE = 25;

/** The mods' pending change with the game's changed files (paths relative to the game folder) added as the last entry. */
export function withGameFiles(change: ModChange | null, files: string[], at: number): ModChange | null
{
    if (!files.length)
        return change;

    const game = { id: GAME_CHANGE_ID, name: tr('The game'), active: false };

    // (how many changed in all: the notice's "... and N more" counts beyond the sample)
    const total = (change ? (change.total ?? change.files.length) : 0) + files.length;

    if (!change)
        return { mod: GAME_CHANGE_ID, name: game.name, mods: [game], files: files.slice(0, 2 * SHARE), total, at };

    // (several owners: each path with its owner's name, as the watcher writes them for several mods)
    const own = change.mods.length > 1 ? change.files : change.files.map((f) => `${change.name}: ${f}`);
    return {
        ...change,
        mods: [...change.mods, game],
        files: [...own.slice(-SHARE), ...files.slice(0, SHARE).map((f) => `${game.name}: ${f}`)],
        total,
        at: Math.max(change.at, at)
    };
}

/**
 * Main's pending change: the watcher's and the game's, sent (`send`) whenever either changes. The game's files are
 * replaced by each `{stale}` the worker posts (an empty list at a build's start).
 */
export class PendingChange
{
    private mods: ModChange | null = null;
    private game: string[] = [];
    private gameAt = 0;
    private readonly send: (c: ModChange | null) => void;

    // (no parameter properties: scripts load this with --experimental-strip-types)
    constructor(send: (c: ModChange | null) => void)
    {
        this.send = send;
    }

    get current(): ModChange | null
    {
        return withGameFiles(this.mods, this.game, this.gameAt);
    }

    /** The watcher's change (ModWatcher's onChange). */
    setMods(c: ModChange | null): void
    {
        if (c === null && this.mods === null)
            return;

        this.mods = c;
        this.send(this.current);
    }

    /** A build starts: both sides are taken in, one null sent (none when nothing was pending). */
    clear(): void
    {
        if (this.mods === null && !this.game.length)
            return;

        this.mods = null;
        this.game = [];
        this.send(null);
    }

    /** The game's changed files as the worker lists them now (none: a build started). */
    setGame(files: string[]): void
    {
        if (files.join('\n') === this.game.join('\n'))
            return;

        this.game = [...files];

        if (files.length)
            this.gameAt = Date.now();

        this.send(this.current);
    }
}
