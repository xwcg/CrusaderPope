// Counts which trigger / effect keys are used most in events, decisions and interactions.
// Used to decide which script keys get hand-written phrasing in src/main/describe/phrases.ts.
// Usage: node --experimental-strip-types scripts/key-frequency.ts [gameDir] [top]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type PNode } from '../src/main/indexer/parser.ts';
import { defaultInstall } from './ck3-install.ts';

const GAME = process.argv[2] ?? defaultInstall() + '/game';
const TOP = Number(process.argv[3] ?? 150);
const TRIGGER_BLOCKS = new Set(['trigger', 'limit', 'potential', 'is_shown', 'is_valid', 'is_valid_showing_failures_only', 'can_send', 'allow', 'is_highlighted', 'can_be_picked', 'ai_potential']);
const EFFECT_BLOCKS = new Set(['immediate', 'option', 'after', 'effect', 'on_accept', 'on_decline', 'on_send', 'on_auto_accept', 'hidden_effect']);

function walk(d: string, out: string[] = []): string[]
{
    for (const e of readdirSync(d, { withFileTypes: true }))
    {
        const p = join(d, e.name);

        if (e.isDirectory())
            walk(p, out);
        else if (e.name.endsWith('.txt'))
            out.push(p);
    }

    return out;
}

const trig = new Map<string, number>();
const eff = new Map<string, number>();
const visit = (nodes: PNode[], ctx: 't' | 'e' | null): void =>
{
    for (const n of nodes)
    {
        let c = ctx;

        if (n.k && TRIGGER_BLOCKS.has(n.k))
            c = 't';
        else if (n.k && EFFECT_BLOCKS.has(n.k))
            c = 'e';
        else if (n.k && ctx && !/^\d/.test(n.k))
        {
            const k = n.k.replace(/^(scope|var|global_var|local_var):.*/, '<$1>');
            const m = ctx === 't' ? trig : eff;
            m.set(k, (m.get(k) ?? 0) + 1);
        }

        if (Array.isArray(n.v))
            visit(n.v, c);
    }
};

for (const dir of ['events', 'common/decisions', 'common/character_interactions', 'common/scripted_effects', 'common/scripted_triggers'])
{
    for (const f of walk(join(GAME, dir)))
        visit(parse(readFileSync(f, 'utf8')), dir.includes('scripted_effects') ? 'e' : dir.includes('scripted_triggers') ? 't' : null);
}

const top = (m: Map<string, number>): string =>
    [...m]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP)
        .map(([k, n]) => `${k}:${n}`)
        .join('  ');
console.log('TRIGGERS\n' + top(trig) + '\n\nEFFECTS\n' + top(eff));
