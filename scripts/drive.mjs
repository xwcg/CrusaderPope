// Launches the built app (out/) with Playwright, runs a list of steps and saves screenshots.
// Usage: npm run build && node scripts/drive.mjs [screenshotDir]
//
// Steps are defined in STEPS below: { open: 'query' } searches via Ctrl+K and opens the first hit,
// { tab: 'Source' } switches detail tabs, { shot: 'name' } saves a PNG, { wait: ms } sleeps.
// { node: 'js' } runs code in this (Node) process — `fs`, `path` and `env` are in scope, `return` a value to print
// (e.g. change a file of a test mod); { waitIndex: true } waits for a re-index started by the step before;
// { until: 'js expression', timeout? } waits until it is truthy in the page (default up to 60 s).
// { goto: 'target', settle?, timeout? } goes straight to a page and view and waits until it has loaded (the test API,
// src/renderer/src/testApi.ts: 'events:court.8190#source', '@map?dim=3d&mode=culture&camera=1495,1385,12,0,38',
// '@mods?list=@all', '@settings' …); CRUSADERPOPE_START=<target> opens one at start.
// The launched app runs with its window hidden (CRUSADERPOPE_HIDDEN=1): screenshots still work; SHOW=1 shows it.
// ATTACH=<port> (e.g. ATTACH=9333) drives the app `npm run dev` already runs (its remote-debugging port) instead of
// launching the built one: no start, no index wait, the app stays open afterwards (CRUSADERPOPE_* env vars are the
// running app's — start `npm run dev` with them).
// Test hooks of the app: CRUSADERPOPE_USER_DATA (own settings and caches), CRUSADERPOPE_OPEN_LOG=<file> (opening /
// revealing files is logged there instead of starting VS Code or Explorer), CRUSADERPOPE_DIALOG_PATHS=<json file>
// ({ "save": path, "open": path } answer the Blender export/import dialogs instead of opening them).
import { _electron as electron, chromium } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const APP_DIR = resolve(import.meta.dirname, '..');
const SHOT_DIR = process.argv[2] ?? join(APP_DIR, 'out', 'shots');
mkdirSync(SHOT_DIR, { recursive: true });
const electronBin = createRequire(import.meta.url)('electron');

const STEPS = JSON.parse(process.env.STEPS ?? 'null') ?? [
    { open: 'brave', type: 'traits' },
    { shot: '01-trait-brave' },
    { open: 'court.8190', type: 'events' },
    { shot: '02-event-overview' },
    { tab: 'Source' },
    { shot: '03-event-source' },
    { tab: 'Graph' },
    { wait: 1500 },
    { shot: '04-event-graph' }
];

// Processes spawned from VS Code's extension host inherit ELECTRON_RUN_AS_NODE=1, which turns
// Electron into plain Node (no `app`, no window). Strip it.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// the window stays hidden (nothing pops up, no stray clicks into a run); SHOW=1 shows it
if (!process.env.SHOW)
    env.CRUSADERPOPE_HIDDEN = '1';

const attached = process.env.ATTACH ? await chromium.connectOverCDP(`http://127.0.0.1:${process.env.ATTACH}`) : null;
const app = attached ? null : await electron.launch({ executablePath: electronBin, args: [APP_DIR], env, timeout: 60_000 });

// LOG_MAIN=1 prints the main process's own output (worker threads log there)
if (app && process.env.LOG_MAIN)
{
    const p = app.process();
    p.stdout?.on('data', (d) => process.stdout.write('[main] ' + d));
    p.stderr?.on('data', (d) => process.stdout.write('[main stderr] ' + d));
}

// (attached: the app's main window — DevTools pages and the like left out)
const page = attached ?
    attached
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => !p.url().startsWith('devtools:')) :
    await app.firstWindow();

if (!page)
    throw new Error('No app window at port ' + process.env.ATTACH + ' — is `npm run dev` running?');

await page.setViewportSize({ width: 1600, height: 960 }).catch(() =>
{});
console.log('launched', page.url());
// LOG_WARN=1 also prints console warnings (WebGL errors are reported as warnings with the exact cause)
page.on('console', (m) => (m.type() === 'error' || (process.env.LOG_WARN && m.type() === 'warning')) && console.log(`[renderer ${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

// EARLY_SHOTS=2000,6000 screenshots the indexing screen at those times (ms after launch), before it is ready
const launched = Date.now();

for (
    const ms of (process.env.EARLY_SHOTS ?? '')
        .split(',')
        .filter(Boolean)
        .map(Number)
)
{
    await page.waitForTimeout(Math.max(0, ms - (Date.now() - launched)));
    const f = join(SHOT_DIR, `early-${ms}.png`);
    await page.screenshot({ path: f });
    console.log('screenshot', f, await page.evaluate(() => document.querySelector('.indexing-screen')?.textContent ?? document.querySelector('.status')?.textContent));
}

// wait for the index to be ready (search box only renders then) — or, NOWAIT=1, not (the first-run wizard holds the
// index back until its Start)
if (!process.env.NOWAIT)
{
    await page.waitForSelector('.search input', { timeout: 180_000 });
    console.log('index ready:', await page.textContent('.status'));
}

for (const step of STEPS)
{
    if (step.open)
    {
        await page.click('.search input');
        await page.fill('.search input', step.open);
        await page.waitForSelector('.search-result', { timeout: 10_000 });
        // results update asynchronously: wait (up to ~5 s) for the exact name/type, else take the first row
        let clicked;

        for (let attempt = 0; attempt < 20 && !clicked; attempt++)
        {
            await page.waitForTimeout(250);
            clicked = await page.evaluate(
                ({ name, type, last }) =>
                {
                    const rows = [...document.querySelectorAll('.search-result')];
                    const exact = rows.find((r) => r.querySelector('.name')?.textContent === name && (!type || r.querySelector('.type-chip')?.getAttribute('title') === type));
                    const row = exact ?? (last ? rows[0] : undefined);
                    row?.click();
                    return row?.textContent;
                },
                { name: step.open, type: step.type, last: attempt === 19 }
            );
        }

        console.log('opened', clicked);
        await page.waitForSelector('.detail-header', { timeout: 10_000 });
        await page.waitForTimeout(400);
    }
    else if (step.tab)
    {
        await page.evaluate((t) => [...document.querySelectorAll('.tab')].find((b) => b.textContent.startsWith(t))?.click(), step.tab);
        await page.waitForTimeout(500);
    }
    else if (step.type)
    {
        // select a type in the sidebar by its id (the row's title attribute)
        await page.evaluate((t) => document.querySelector(`.type-row[title="${t}"]`)?.click(), step.type);
        await page.waitForTimeout(600);
    }
    else if (step.click)
    {
        await page.click(step.click);
        await page.waitForTimeout(400);
    }
    else if (step.clickText)
    {
        // click the first element matching selector whose text contains the given text
        const r = await page.evaluate(({ sel, text }) =>
        {
            const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
            el?.click();
            return !!el;
        }, step.clickText);

        if (!r)
            console.log('clickText: not found', JSON.stringify(step.clickText));

        await page.waitForTimeout(700);
    }
    else if (step.eval)
    {
        console.log('eval:', JSON.stringify(await page.evaluate(step.eval)));
    }
    else if (step.goto !== undefined)
    {
        // (a target that fails — unknown mode, timeout — is reported and the run goes on)
        const r = await page.evaluate(([t, o]) => window.__app.goto(t, o).then((s) => s.target, (e) => 'FAILED ' + e.message), [step.goto, { settle: step.settle, timeout: step.timeout }]);
        console.log('goto:', r);
    }
    else if (step.until)
    {
        // { until: 'js expression', timeout? } waits until it is truthy in the page (default up to 60 s) — polled with
        // evaluate: the page's CSP refuses waitForFunction's string predicates (no 'unsafe-eval')
        const t0 = Date.now();

        while (!(await page.evaluate(step.until).catch(() => false)))
        {
            if (Date.now() - t0 > (step.timeout ?? 60_000))
            {
                console.log('until: timed out waiting for', step.until);
                break;
            }

            await page.waitForTimeout(100);
        }
    }
    else if (step.node)
    {
        const AsyncFunction = Object.getPrototypeOf(async () =>
        {}).constructor;
        console.log('node:', JSON.stringify(await new AsyncFunction('fs', 'path', 'env', step.node)(fs, path, process.env)));
    }
    else if (step.waitIndex)
    {
        // the search box goes while the index builds and comes back when it is ready
        const started = await page.waitForFunction(() => !document.querySelector('.search input'), null, { timeout: 15_000 }).then(
            () => true,
            () => false
        );
        await page.waitForSelector('.search input', { timeout: 180_000 });
        await page.waitForTimeout(800);
        console.log(started ? 're-indexed:' : 'no re-index started:', await page.textContent('.status'));
    }
    else if (step.press)
    {
        // { press: 'ArrowDown' } presses a key in the focused element (Playwright names: Enter, Delete, Control+z, Shift+A …)
        await page.keyboard.press(step.press);
        await page.waitForTimeout(step.pause ?? 400);
    }
    else if (step.hover)
    {
        // hover the first element matching the selector (e.g. an entity link) to show its hover card
        await page.hover(step.hover);
        await page.waitForTimeout(900);
    }
    else if (step.drag)
    {
        // { drag: { sel, from: [fx, fy], to: [fx, fy], button: 'right' } } drags with the real mouse (fractions of the
        // element's box) — e.g. pan a 3D view with the right button
        const box = await page.locator(step.drag.sel)
            .first()
            .boundingBox();

        if (box)
        {
            const at = ([fx, fy]) => [box.x + box.width * fx, box.y + box.height * fy];
            const [x0, y0] = at(step.drag.from);
            const [x1, y1] = at(step.drag.to);
            await page.mouse.move(x0, y0);
            await page.mouse.down({ button: step.drag.button ?? 'left' });

            for (let i = 1; i <= 10; i++)
                await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);

            await page.mouse.up({ button: step.drag.button ?? 'left' });
        }

        await page.waitForTimeout(600);
    }
    // { viewport: [w, h] } resizes the page (CSS pixels — 200 % display scaling on 1366×768 is ~683×384)
    else if (step.viewport)
    {
        await page.setViewportSize({ width: step.viewport[0], height: step.viewport[1] });
        await page.waitForTimeout(300);
    }
    else if (step.move)
    {
        // { move: { sel, at: [fx, fy] } } moves the mouse to a point of an element (fractions of its box) — hover a map
        const box = await page.locator(step.move.sel)
            .first()
            .boundingBox();

        if (box)
            await page.mouse.move(box.x + box.width * step.move.at[0], box.y + box.height * step.move.at[1], { steps: 4 });

        await page.waitForTimeout(500);
    }
    else if (step.select)
    {
        // { select: { sel, value } } picks an option of a dropdown (components/Select.tsx: its button opens a picker
        // menu whose rows carry data-value)
        await page.locator(step.select.sel)
            .first()
            .click();
        await page.locator(`.dd-menu [data-value="${step.select.value}"]`).click();
        await page.waitForTimeout(600);
    }
    else if (step.fill)
    {
        // { fill: { sel, value } } types into an input
        await page.locator(step.fill.sel)
            .first()
            .fill(step.fill.value);
        await page.waitForTimeout(600);
    }
    else if (step.wheel !== undefined)
    {
        // mouse wheel over an element (e.g. zoom the portrait: { wheel: 800, sel: '.portrait-box canvas' })
        const box = await page.locator(step.sel)
            .first()
            .boundingBox();

        if (box)
        {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, step.wheel);
            await page.waitForTimeout(800);
        }
    }
    else if (step.drag)
    {
        // { drag: { sel, dx, dy } } drags the mouse across an element (e.g. orbit a 3D view)
        const box = await page.locator(step.drag.sel)
            .first()
            .boundingBox();

        if (box)
        {
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x + (step.drag.dx ?? 0), y + (step.drag.dy ?? 0), { steps: 12 });
            await page.mouse.up();
            await page.waitForTimeout(1200);
        }
    }
    else if (step.scroll !== undefined)
    {
        // scroll the detail body to a pixel offset
        await page.evaluate((y) => document.querySelector('.detail-body')?.scrollTo(0, y), step.scroll);
        await page.waitForTimeout(400);
    }
    else if (step.wait)
    {
        await page.waitForTimeout(step.wait);
    }
    else if (step.shot)
    {
        // { shot: 'name', sel: '.portrait-box' } captures just that element
        const f = join(SHOT_DIR, step.shot + '.png');

        if (step.sel)
            await page.locator(step.sel)
                .first()
                .screenshot({ path: f });
        else if (app && env.CRUSADERPOPE_HIDDEN)
        {
            // (a hidden window paints only when something changes — Playwright would wait for a frame: Electron captures it)
            const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
            fs.writeFileSync(f, Buffer.from(png, 'base64'));
        }
        else
            await page.screenshot({ path: f });

        console.log('screenshot', f);
    }
}

// (attached: leave the running app open)
if (attached)
    await attached.close();
else
    await app.close();
