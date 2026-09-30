import type { RendererApi } from '../../shared/api';
import { track } from './pending';

declare global
{
    interface Window
    {
        api: RendererApi;
    }
}

/** The preload's API; a call that returns a promise is counted while in flight (pending.ts — the test API waits). */
export const api: RendererApi = Object.fromEntries(
    Object.entries(window.api).map(([k, f]) => [
        k,
        typeof f === 'function'
            ? (...args: unknown[]): unknown =>
            {
                const r: unknown = f(...args);
                // (a promise from across the context bridge: any thenable)
                return r !== null && typeof r === 'object' && typeof (r as PromiseLike<unknown>).then === 'function' ? track(Promise.resolve(r)) : r;
            }
            : f
    ])
) as unknown as RendererApi;
