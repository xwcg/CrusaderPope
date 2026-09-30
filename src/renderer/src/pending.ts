/**
 * Work in flight, for the test API's "loaded" (testApi.ts): every IPC call (api.ts counts them), the fetches of
 * ck3://map files and the pictures loaded in code (not the page's <img>s: the test API looks at those itself).
 */
let count = 0;

/** Counts a promise while it is unsettled; returns it as it is. */
export function track<T>(p: Promise<T>): Promise<T>
{
    count++;
    const done = (): void =>
    {
        count--;
    };
    p.then(done, done);
    return p;
}

/** Calls and loads not settled yet. */
export function pending(): number
{
    return count;
}
