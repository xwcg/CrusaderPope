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
import type { ChoiceMenu } from './model';
import { awayAt, inReach, setAwayTargets, setPlaceScopes, viewTargets, viewTargetsKnown } from './targets';

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

/**
 * Closes the open picker, if any (its promise resolves null). The test API's goto calls it so a picker a walk left open
 * does not stay over the next page, with its callback still pointing at the entry it was opened on.
 */
export function closePicker(): void
{
    current?.(null);
}

export function pickStatement(req: PickRequest): Promise<PickResult | null>
{
    const t0 = performance.now();

    // (the event shown: its scopes are targets too, the ones in reach where the statement goes; the others are only
    // warned about when typed: picker/model.ts chainType; known only inside the shown entry's own definition)
    if (!req.targets)
    {
        const all = viewTargets();
        req = { ...req, targets: inReach(all, req.place), targetsKnown: viewTargetsKnown(req.place) };
        setAwayTargets(awayAt(all, req.place));
    }
    else
        setAwayTargets([]);

    // (`prev` where the statement goes, and whether its scope is a guess: picker/model.ts prevStack, chainType)
    setPlaceScopes(req.kind === 'choice' ? {} : { prev: req.prev, scope: req.scope, guessed: req.scopeGuessed });

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

/**
 * Plain menus in the picker (its cascade, keys, filter, breadcrumb): the map's right-click menu. Resolves with the
 * chosen row's value, or null when cancelled.
 */
export async function pickChoice(menu: ChoiceMenu, opts: { at?: { x: number; y: number; }; title?: string; } = {}): Promise<string | null>
{
    const r = await pickStatement({ kind: 'choice', choice: menu, at: opts.at, title: opts.title, targets: [] });
    return r ? r.text : null;
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
