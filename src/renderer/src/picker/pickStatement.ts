/**
 * The statement picker: builds an effect or trigger for the active mod's script (docs/picker.md, docs/mods.md
 * "Editing in place"). One entry point for every "Add …" in the app; resolves with the script to insert (unindented,
 * nested lines indented with tabs) and its readable sentence, or null when cancelled.
 *
 * Works from any view: the menus render into a layer of their own on document.body (one React root, created on
 * first use and kept). A second request while one is open cancels the first.
 */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PickRequest, PickResult } from '../../../shared/api';
import { prefetch } from './data';
import { Picker } from './Picker';
import { viewTargets } from './targets';

let root: Root | null = null;
/** resolves the open picker's promise */
let current: ((r: PickResult | null) => void) | null = null;
let seq = 0;

function ensureRoot(): Root
{
    if (!root)
    {
        const host = document.createElement('div');
        host.className = 'picker-host';
        document.body.append(host);
        root = createRoot(host);
    }

    return root;
}

/**
 * Renders the picker once, hidden, when the app is idle: the first real opening then costs what every later one
 * does (a few ms instead of ~70: code compiled, styles resolved).
 */
function warmUp(): void
{
    const run = (): void =>
    {
        if (current)
            return;

        ensureRoot().render(
            createElement(Picker, {
                key: ++seq,
                req: { kind: 'effect' },
                t0: 0,
                warm: true,
                onDone: () =>
                {
                    if (!current)
                        root?.render(null);
                }
            })
        );
    };

    if (typeof requestIdleCallback === 'function')
        requestIdleCallback(run, { timeout: 5000 });
    else
        setTimeout(run, 2000);
}
warmUp();

export function pickStatement(req: PickRequest): Promise<PickResult | null>
{
    const t0 = performance.now();

    // (the event shown: its scopes are targets too)
    if (!req.targets)
        req = { ...req, targets: viewTargets() };

    current?.(null);
    // lists, flags and the "Other…" keys: loaded while the first menus are chosen
    prefetch();
    ensureRoot();
    // (the picker takes the keyboard; focus goes back where it was)
    const focused = document.activeElement as HTMLElement | null;
    return new Promise((resolve) =>
    {
        const done = (r: PickResult | null): void =>
        {
            if (current !== done)
                return;

            current = null;
            root?.render(null);

            if (focused?.isConnected)
                focused.focus?.();

            resolve(r);
        };
        current = done;
        root!.render(createElement(Picker, { key: ++seq, req, t0, onDone: done }));
    });
}

declare global
{
    interface Window
    {
        /** test hook: drivers open the picker with it (docs/picker.md) */
        __pickStatement?: typeof pickStatement;
    }
}
window.__pickStatement = pickStatement;
