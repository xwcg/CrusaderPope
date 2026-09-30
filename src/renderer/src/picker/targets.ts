/**
 * The scopes the picker offers as targets besides the links (docs/picker.md, "The event's scopes"): the event shown
 * sets its Who's who here (StoryView), every picker opened meanwhile lists them — "Child is…", "Opinion of: Child".
 */
import type { EventStory, PickTarget, Rich } from '../../../shared/api';

const richToText = (r: Rich): string => r.map((s) => (typeof s === 'string' ? s : s.text)).join('');

let current: PickTarget[] = [];

export const viewTargets = (): PickTarget[] => current;

export function setViewTargets(t: PickTarget[]): void
{
    current = t;
}

const label = (n: string): string =>
{
    const t = n.replace(/_/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * An event's scopes as targets: the ones it is given, the ones it names (the temporary ones marked: they exist only
 * while their block runs), the ones it uses without either. Values ("true if a known bastard") are left out.
 */
export function eventTargets(story: EventStory): PickTarget[]
{
    const c = story.cast;

    if (!c)
        return [];

    const out: PickTarget[] = [];
    const add = (t: PickTarget): void =>
    {
        if (!out.some((o) => o.key === t.key))
            out.push(t);
    };

    for (const m of [...c.named.filter((m) => !m.temporary), ...c.given, ...c.named.filter((m) => m.temporary)])
    {
        const who = richToText(m.who);

        if (/^(true|false)\b|\bvalue\b|\bnumber\b/i.test(who))
            continue;

        add({ key: `scope:${m.name}`, label: label(m.name) + (m.temporary ? ' (for a moment)' : ''), about: m.from ? `${who} — given by ${m.from}` : m.temporary ? `${who} — saved with save_temporary_scope_as: only in the block it is saved in` : who, type: m.type });
    }

    for (const u of c.unknown)
        add({ key: `scope:${u}`, label: label(u), about: 'used by the event, given by what fires it' });

    return out;
}
