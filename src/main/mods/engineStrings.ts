/**
 * The strings of the game's executable (`binaries/ck3.exe`; `binaries/ck3` on other systems), read once per install: what the
 * program names by itself. guiWork.ts takes the identifiers inside them (the names the interface's data system may call),
 * shaderRule.ts the whole strings: the effect files the engine opens itself and the effect names it asks them for (docs/shaders.md
 * "Effects the game does not draw").
 */
import { readFileSync } from 'node:fs';
import { GameMemo } from './gameFacts.ts';

export interface EngineStrings
{
    /** every string (a run of printable ASCII, 3 characters or more) that is an identifier as a whole: `surroundmap`, `PdxTerrainLowSpec` */
    names: Set<string>;
    /** every string that is the path of an effect file (`.shader`, `.fxh`), in lower case: `gfx/fx/surroundmap.shader` */
    paths: Set<string>;
    /** the identifiers inside the strings that start with a capital letter, 3 to 90 characters (any byte not of an identifier ends one) */
    runs: Set<string>;
}

const memo = new GameMemo<EngineStrings | null>();

/** Whether a byte is a character of an identifier (letters, digits, `_`). */
const isId = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122);

/** Whether the bytes before `end` spell an ending, ignoring case (lower-case ASCII `tail`). */
function endsWith(buf: Buffer, end: number, tail: string): boolean
{
    if (end < tail.length)
        return false;

    for (let i = 0; i < tail.length; i++)
        if ((buf[end - tail.length + i] | 0x20) !== tail.charCodeAt(i))
            return false;

    return true;
}

/** The executable's strings of a game folder (`…/game`; the executable is in `…/binaries`); none when there is no executable to read. */
export function engineStrings(gameDir: string): EngineStrings | undefined
{
    const install = gameDir.replace(/[\\/]+$/, '').replace(/[\\/]game$/i, '');
    let v = memo.get(gameDir, install);

    if (v === undefined)
    {
        v = null;

        for (const exe of ['binaries/ck3.exe', 'binaries/ck3'])
        {
            let buf: Buffer;

            try
            {
                buf = readFileSync(install + '/' + exe);
            }
            catch
            {
                continue;
            }

            const names = new Set<string>();
            const paths = new Set<string>();
            const runs = new Set<string>();
            // (the identifier run and the printable run being read, with whether the latter is all identifier characters)
            let id = -1;
            let pr = -1;
            let allId = true;

            for (let i = 0; i <= buf.length; i++)
            {
                const c = i < buf.length ? buf[i] : 0;

                if (isId(c))
                {
                    if (id < 0)
                        id = i;
                }
                else if (id >= 0)
                {
                    if (i - id >= 3 && i - id <= 90 && buf[id] >= 65 && buf[id] <= 90)
                        runs.add(buf.toString('latin1', id, i));

                    id = -1;
                }

                if (c >= 0x20 && c <= 0x7e)
                {
                    if (pr < 0)
                    {
                        pr = i;
                        allId = true;
                    }

                    allId &&= isId(c);
                }
                else if (pr >= 0)
                {
                    if (i - pr >= 3)
                    {
                        if (allId && !(buf[pr] >= 48 && buf[pr] <= 57))
                            names.add(buf.toString('latin1', pr, i));
                        else if (endsWith(buf, i, '.shader') || endsWith(buf, i, '.fxh'))
                            paths.add(buf.toString('latin1', pr, i).toLowerCase());
                    }

                    pr = -1;
                }
            }

            v = { names, paths, runs };
            break;
        }

        memo.set(gameDir, install, v);
    }

    return v ?? undefined;
}
