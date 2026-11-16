/**
 * Remembers what a candidate resolved to (GameIndex.resolveCandidates): a build has 13M candidates (AGOT) but only 1M
 * different ones (the same token under the same keys). Open addressing over four integers (typed arrays: the table
 * holds a million entries and stays out of the heap the process's threads share); the values are the caller's lists,
 * most of them the same empty one.
 */
export class ResolveMemo<T>
{
    private cap = 1 << 16;
    private n = 0;
    private a = new Int32Array(this.cap).fill(-1);
    private b = new Int32Array(this.cap);
    private c = new Int32Array(this.cap);
    private d = new Int32Array(this.cap);
    private vals: (T | undefined)[] = new Array(this.cap);

    /** The slot of a key: the one holding it, or the free one where it goes (`a` is never -1 in a key). */
    private slot(a: number, b: number, c: number, d: number): number
    {
        let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b) ^ Math.imul(c + 1, 0xc2b2ae35) ^ Math.imul(d + 1, 0x27d4eb2f);
        h ^= h >>> 15;
        h = Math.imul(h, 0x2c1b3c6d);
        h ^= h >>> 12;
        const mask = this.cap - 1;
        let i = h & mask;

        while (this.a[i] !== -1 && (this.a[i] !== a || this.b[i] !== b || this.c[i] !== c || this.d[i] !== d))
            i = (i + 1) & mask;

        return i;
    }

    get(a: number, b: number, c: number, d: number): T | undefined
    {
        const i = this.slot(a, b, c, d);
        return this.a[i] === -1 ? undefined : this.vals[i];
    }

    set(a: number, b: number, c: number, d: number, v: T): void
    {
        if (this.n * 2 >= this.cap)
            this.grow();

        const i = this.slot(a, b, c, d);

        if (this.a[i] === -1)
        {
            this.n++;
            this.a[i] = a;
            this.b[i] = b;
            this.c[i] = c;
            this.d[i] = d;
        }

        this.vals[i] = v;
    }

    private grow(): void
    {
        const { a, b, c, d, vals, cap } = this;
        this.cap = cap * 2;
        this.a = new Int32Array(this.cap).fill(-1);
        this.b = new Int32Array(this.cap);
        this.c = new Int32Array(this.cap);
        this.d = new Int32Array(this.cap);
        this.vals = new Array(this.cap);

        for (let i = 0; i < cap; i++)
        {
            if (a[i] === -1)
                continue;

            const j = this.slot(a[i], b[i], c[i], d[i]);
            this.a[j] = a[i];
            this.b[j] = b[i];
            this.c[j] = c[i];
            this.d[j] = d[i];
            this.vals[j] = vals[i];
        }
    }
}
