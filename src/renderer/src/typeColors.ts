const FIXED: Record<string, string> = {
    events: '#d4a94f',
    on_action: '#e08a3c',
    scripted_effects: '#5fb0d8',
    scripted_triggers: '#8a93e0',
    script_values: '#6cc59a',
    scripted_modifiers: '#9ccf6a',
    traits: '#cf7dc0',
    modifiers: '#d9735a',
    opinion_modifiers: '#e0927a',
    decisions: '#e6c85c',
    character_interactions: '#58c7c0',
    story_cycles: '#c9b07a',
    localization: '#8b8b8b',
    flag: '#b8b44e',
    variable: '#4fb3a0',
    characters: '#b39ddb',
    faith: '#f0e0a0',
    landed_titles: '#a0c060',
    'culture/cultures': '#e0a0a0',
    customizable_localization: '#a0a0c8'
};

const cache = new Map<string, string>();

/** Stable color per type: fixed palette for the common ones, hashed hue for the rest. */
export function typeColor(type: string): string
{
    const fixed = FIXED[type];

    if (fixed)
        return fixed;

    let c = cache.get(type);

    if (!c)
    {
        let h = 0;

        for (let i = 0; i < type.length; i++)
            h = (h * 31 + type.charCodeAt(i)) >>> 0;

        c = `hsl(${h % 360}, 45%, 62%)`;
        cache.set(type, c);
    }

    return c;
}
