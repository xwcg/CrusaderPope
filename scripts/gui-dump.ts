// A .gui definition: its source, or expanded as the game builds it (templates, types, block overrides; src/main/gui/expand.ts).
// Usage: node --experimental-strip-types --no-warnings scripts/gui-dump.ts [source|expand|widgets|layout] <kind> <name>
// layout: the boxes as the layout engine places them (src/main/gui/layout.ts) on a 2560x1440 screen.
// widgets: the expanded tree without properties. `all` as the kind: expand every window and root, print what went unresolved.
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { GuiLibrary, type GuiKind } from '../src/main/gui/library.ts';
import { GuiExpander, xtext } from '../src/main/gui/expand.ts';
import { GuiLayout, ltext } from '../src/main/gui/layout.ts';
import { defaultInstall } from './ck3-install.ts';

const [mode, kind, name] = process.argv.slice(2);
const lib = new GuiLibrary(new GameFiles(resolveGameDir(defaultInstall())!));
const x = new GuiExpander(lib);

if (kind === 'all')
{
    const t0 = performance.now();
    let nodes = 0;
    const count = (n: { children?: unknown[]; }): void =>
    {
        nodes++;

        for (const c of (n.children ?? []) as { children?: unknown[]; }[])
            count(c);
    };

    for (const e of [...lib.entries('window'), ...lib.entries('root')])
        count(x.expand(e)!);

    console.log(`${lib.entries('window').length + lib.entries('root').length} windows and roots expanded in ${(performance.now() - t0).toFixed(0)} ms, ${nodes} nodes`);
    console.log(
        [...x.missing]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 30)
            .map(([k, n]) => `  ${k}  ${n}`)
            .join('\n') || '  nothing unresolved'
    );
    process.exit(0);
}

for (const e of lib.defs(kind as GuiKind, name))
{
    console.log(`// ${e.file.rel}:${e.line}`);

    if (mode === 'layout')
        console.log(ltext(new GuiLayout({ screen: { w: 2560, h: 1440 } }).layout(x.expand(e)!)).join('\n'));
    else
        console.log(mode === 'source' ? lib.source(e) : xtext(x.expand(e)!, mode !== 'widgets').join('\n'));
}
