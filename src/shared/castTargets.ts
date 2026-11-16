/**
 * An event's Who's who as the picker's targets (docs/picker.md, "Scopes in reach"): shared by the renderer (the view's
 * scopes, picker/targets.ts) and the main side (a scripted effect's callers, StoryBuilder.callerTargets).
 */
import type { EventCast, PickTarget, Rich } from './api.ts';
import { tr } from './i18n.ts';

const richToText = (r: Rich): string => r.map((s) => (typeof s === 'string' ? s : s.text)).join('');

const label = (n: string): string =>
{
    const t = n.replace(/_/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * An event's scopes as targets: the ones it is given, the ones it names (the temporary ones marked: they exist only
 * until the end of the part of the script that saves them), the ones it uses without either. Values ("true if a
 * known bastard") are left out. A named one keeps where it is in reach (CastMember.reach).
 */
export function castTargets(c: EventCast | undefined): PickTarget[]
{
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

        const about = m.from ? tr('{who} — given by {from}', { who, from: m.from }) : m.temporary ? tr('{who} — saved with save_temporary_scope_as: only until the end of the part of the script it is saved in', { who }) : who;
        add({ key: `scope:${m.name}`, label: label(m.name) + (m.temporary ? tr(' (for a moment)') : ''), about, type: m.type, ...(m.reach ? { reach: m.reach } : {}) });
    }

    for (const u of c.unknown)
        add({ key: `scope:${u}`, label: label(u), about: tr('used by the event, given by what fires it') });

    return out;
}
