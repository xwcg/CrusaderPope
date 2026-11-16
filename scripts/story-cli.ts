// Prints the readable story/card of entities as indented text (to tune the describer without the UI).
// Usage: node --experimental-strip-types scripts/story-cli.ts <type> <name> [<type> <name> …]
// The index: scripts/fast-index.ts (parse threads, cached in %TEMP%/ckp-index-cache; FRESH=1 builds it anew).
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { GuiLibrary } from '../src/main/gui/library.ts';
import { guiFind, guiItem } from '../src/main/gui/detail.ts';
import type { DescNode, FollowUp, Line, Rich } from '../src/shared/api.ts';
import { defaultInstall } from './ck3-install.ts';
import { fastIndex } from './fast-index.ts';

const idx = await fastIndex(resolveGameDir(defaultInstall())!, { cache: true });
const sb = new StoryBuilder(idx);
let gui: GuiLibrary | undefined;
sb.guiUsers = (name) => (gui ??= new GuiLibrary(idx.vfs)).usedBy('scriptedGui', name).map(guiItem);
sb.d.guiFind = (name) => guiFind(gui ??= new GuiLibrary(idx.vfs), name);
const showHidden = process.env.HIDDEN === '1';

const r = (x: Rich): string => x.map((s) => (typeof s === 'string' ? s : s.kind === 'entity' ? `‹${s.text}›` : s.kind === 'scope' ? `[${s.text}]` : s.text)).join('');
const lines = (ls: Line[], ind = '  '): void =>
{
    for (const l of ls)
    {
        if (l.hidden && !showHidden)
            continue;

        console.log(`${ind}${l.hidden ? '(hidden) ' : ''}${l.tone === 'bad' ? '−' : l.tone === 'good' ? '+' : '•'} ${r(l.text)}${l.collapsed ? ' ▸' : ''}`);

        if (l.conditions)
            lines(l.conditions, ind + '    ? ');

        if (l.children)
            lines(l.children, ind + '    ');
    }
};
const fu = (f: FollowUp[], ind = '  '): void =>
{
    for (const x of f)
        console.log(`${ind}↳ ${x.label} [${x.target.name}] ${x.delay ?? ''} ${x.when.map(r).join(' / ')} ${x.who ? 'for ' + x.who : ''}${x.hidden ? ' (hidden)' : ''}`);
};

const args = process.argv.slice(2);

for (let i = 0; i < args.length; i += 2)
{
    const e = idx.get(args[i], args[i + 1]);

    if (!e)
    {
        console.log('not found', args[i], args[i + 1]);
        continue;
    }

    const c = sb.card(e);
    console.log(`\n===== ${c.typeLabel}: ${c.title}`);

    if (c.description)
        console.log(r(c.description));

    for (const f of c.facts)
        console.log('  fact: ' + r(f));

    if (c.event)
    {
        const ev = c.event;
        console.log(`[${ev.kindLabel}] ${r(ev.title)}  theme=${ev.theme} cooldown=${ev.cooldown}`);
        console.log('origins: ' + ev.origins.map((o) => `${o.label} (${o.typeLabel}${o.when ? ', ' + o.when : ''})`).join('; '));

        // the description tree: parts, versions (first / random), conditions, texts (with their paths)
        const desc = (n: DescNode | undefined, depth: number): void =>
        {
            if (!n)
                return;

            const head = '  '.repeat(depth) + (n.when ? '[' + r(n.when) + '] ' : n.otherwise ? '[Otherwise] ' : '') + `(${(n.path ?? []).join('.')}) `;

            if (n.kind === 'text')
                console.log('DESC ' + head + r(n.text ?? []).slice(0, 90));
            else
            {
                console.log('DESC ' + head + n.kind.toUpperCase());

                for (const k of n.kids ?? [])
                    desc(k, depth + 1);
            }
        };
        desc(ev.desc, 0);

        console.log('CONDITIONS:');
        lines(ev.conditions);

        if (ev.weight?.length)
        {
            console.log('WEIGHT:');
            lines(ev.weight);
        }

        console.log('IMMEDIATE:');
        lines(ev.immediate);
        fu(ev.immediateFollowUps);
        ev.options.forEach((o, i) =>
        {
            console.log(`OPTION ${i + 1}: ${r(o.text)}`);

            if (o.conditions.length)
            {
                console.log('  requires:');
                lines(o.conditions, '    ');
            }

            lines(o.effects);
            fu(o.followUps);
        });
        console.log('AFTER:');
        lines(ev.after);
        fu(ev.afterFollowUps);
    }

    if (c.onAction)
    {
        const oa = c.onAction;
        console.log('doc: ' + oa.doc);
        lines(oa.conditions);
        console.log('events:'), fu(oa.events);
        console.log('random:'), fu(oa.randomEvents);
        console.log('first_valid:'), fu(oa.firstValid);
        console.log('notes: ' + (oa.notes ?? []).join(' · '));

        for (const [key, l] of Object.entries(oa.lists ?? {}))
        {
            if (l.lines.length || l.plural?.length)
                console.log(`${key} rows: ${l.lines.map((x) => x.text.map((p) => (typeof p === 'string' ? p : p.text)).join('')).join(' | ')}${l.plural?.length ? ` (written random_on_actions: ${l.plural.join(', ')})` : ''}`);
        }
        console.log('on_actions:'), fu(oa.onActions);
        console.log('random_on_action:'), fu(oa.randomOnActions);
        console.log('first_valid_on_action:'), fu(oa.firstValidOnActions);
        console.log('fallbacks:'), fu(oa.fallbacks);
        lines(oa.effects);
        console.log('origins: ' + oa.origins.map((o) => o.label).join('; '));
    }

    for (const s of c.sections)
    {
        console.log(`-- ${s.title}`);
        lines(s.lines);

        if (s.followUps)
            fu(s.followUps);
    }

    console.log('usage: ' + c.usage.map((u) => `${u.typeLabel} ${u.count}`).join(', '));
}
