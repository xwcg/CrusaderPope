// Prints an event's "Who's who" (EventStory.cast) as text: root notes, given, named, unknown, portraits.
// Usage: node --experimental-strip-types scripts/cast-check.ts <event> [<event> …]
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import type { Line, Rich } from '../src/shared/api.ts';
import { defaultInstall } from './ck3-install.ts';

const idx = new GameIndex(resolveGameDir(defaultInstall())!, 'english');
idx.build();
const sb = new StoryBuilder(idx);
const r = (x: Rich): string => x.map((s) => (typeof s === 'string' ? s : s.text)).join('');
const conds = (ls: Line[] | undefined): string => (ls?.length ? ` [who fits: ${ls.map((l) => r(l.text)).join('; ')}]` : '');

for (const name of process.argv.slice(2))
{
    const e = idx.get('events', name);
    const s = e && sb.eventStory(e);

    if (!s?.cast)
    {
        console.log(name, '— no story');
        continue;
    }

    const c = s.cast;
    console.log(`== ${name}`);
    console.log('  You (root): the character who gets the event');

    for (const n of c.rootNotes)
        console.log(`    ${n.from}: ${n.who}${n.of ? ` — “they”: ${n.of}` : ''}${conds(n.conditions)}`);

    for (const m of c.given)
        console.log(`  given  scope:${m.name} — ${r(m.who)} (${m.from})${conds(m.conditions)}`);

    for (const m of c.named)
        console.log(`  named  scope:${m.name} — ${r(m.who)}${m.temporary ? ' (temporary)' : ''}${conds(m.conditions)}`);

    if (c.unknown.length)
        console.log(`  unknown: ${c.unknown.join(', ')}`);

    for (const p of c.portraits)
        console.log(`  portrait ${p.pos}: ${p.scope}${p.animation ? ` (${p.animation})` : ''}`);
}
