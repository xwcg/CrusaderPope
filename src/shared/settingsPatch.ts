/** The settings that differ between two sets of them (compared by value): what Settings sends on Save. */
export function changedKeys<T extends object>(now: T, was: T): Partial<T>
{
    const out: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(now))
    {
        if (JSON.stringify(v) !== JSON.stringify((was as Record<string, unknown>)[k]))
            out[k] = v;
    }

    return out as Partial<T>;
}
