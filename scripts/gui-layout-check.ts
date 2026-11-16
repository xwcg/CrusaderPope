// The layout engine (src/main/gui/layout.ts) against measurements of the game: positions taken from the owner's screenshot
// (docs/Screenshot 2026-10-04 161044.png: decisiondetail_view at 2560x1440, UI scale 100%, the step widget hidden),
// relative to the window's top left (on screen at 981,332). A change to the layout rules that moves these fails here.
// Usage: node --experimental-strip-types --no-warnings scripts/gui-layout-check.ts
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { GuiLibrary } from '../src/main/gui/library.ts';
import { GuiExpander, type XNode } from '../src/main/gui/expand.ts';
import { GuiLayout, type LBox } from '../src/main/gui/layout.ts';
import { defaultInstall } from './ck3-install.ts';

const lib = new GuiLibrary(new GameFiles(resolveGameDir(defaultInstall())!));
const root = new GuiExpander(lib).expand(lib.defs('window', 'decisiondetail_view')[0])!;
const prop = (n: XNode, k: string): string | undefined => n.children?.findLast((c) => c.key === k && c.value !== undefined)?.value;

// as in the screenshot: the default step (Back + confirm), not the single-button step
const hidden = new Set<XNode>();
const walk = (n: XNode): void =>
{
    if (n.kind && prop(n, 'visible')?.includes('Not( DecisionDetailView.IsDefaultWidgetShown )'))
        hidden.add(n);

    n.children?.forEach(walk);
};
walk(root);

const win = new GuiLayout({ screen: { w: 2560, h: 1440 }, hidden }).layout(root);
const find = (pred: (b: LBox) => boolean, b: LBox = win): LBox | undefined => pred(b) ? b : b.children.map((c) => find(pred, c)).find((x) => x);
const named = (name: string): LBox | undefined => find((b) => b.name === name);
const key = (k: string): LBox | undefined => find((b) => b.node.key === k);

// [what, measured (relative to the window), laid out, tolerance px]
const checks: [string, number, number | undefined, number][] = [
    ['window width', 630, win.w, 0],
    ['window height', 940, win.h, 0],
    // the background's `margin = { -23 -17 }`: the dark area 582 wide (1005..1587)
    ['illustration top', 64, named('illustrations') && named('illustrations')!.y - win.y, 4],
    ['illustration height', 220, named('illustrations')?.h, 4],
    ['title centre', 375 - 332, named('header_text') && named('header_text')!.y + named('header_text')!.h / 2 - win.y, 6],
    // (the description is bound: a two-line sample, as the screenshot's text runs to two lines)
    ['Effects label centre', 718 - 332, find((b) => b.text === 'DECISION_DETAIL_EFFECTS' || b.node.key === 'text_label_center') && ((l) => l.y + l.h / 2 - win.y)(find((b) => b.node.key === 'text_label_center')!), 8],
    ['button column top', 1106 - 332, key('decision_detail_buttons') && key('decision_detail_buttons')!.y - win.y, 6],
    ['back button top', 1148 - 332, named('back') && named('back')!.y - win.y, 6],
    ['back button height', 1195 - 1148, named('back')?.h, 4],
    ['checkbox centre', 1223 - 332, named('button_checkbox') && named('button_checkbox')!.y + 15 - win.y, 6],
    ['close button centre', 1548 - 981, named('button_close') && named('button_close')!.x + named('button_close')!.w / 2 - win.x, 4]
];

let bad = 0;

for (const [what, want, got, tol] of checks)
{
    const ok = got !== undefined && Math.abs(got - want) <= tol;

    if (!ok)
        bad++;

    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what.padEnd(26)} measured ${String(want).padStart(4)}  laid out ${got === undefined ? 'none' : Math.round(got)}`);
}

console.log(bad ? `${bad} of ${checks.length} off` : `all ${checks.length} within tolerance`);
process.exit(bad ? 1 : 0);
