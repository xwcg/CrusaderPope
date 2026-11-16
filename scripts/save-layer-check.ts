// Checks a game save as the top layer of the index (docs/saves.md, "The save as a layer of the index"): the game (and
// AGOT from the Workshop folder when AGOT=1, read only), plus a save copied to %TEMP%: the save's characters as the
// type savegame/characters (group Savegame), marked as the save's, their cards like game data, links between them.
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=12000 scripts/save-layer-check.ts <save.ck3> [id]
// The index: scripts/fast-index.ts on parse threads, never from its cache (a save's index is built each time, as in the app).
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ModInfo } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { typeGroup } from '../src/main/indexer/schema.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { parseDescriptor } from '../src/main/mods/descriptor.ts';
import { readSave } from '../src/main/saves/envelope.ts';
import { Gamestate } from '../src/main/saves/gamestate.ts';
import { saveLayer, T_SAVE_CHARACTER } from '../src/main/saves/project.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { readFileSync } from 'node:fs';
import { defaultInstall, workshopFolder } from './ck3-install.ts';
import { fastIndex } from './fast-index.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

const file = process.argv[2];
const gameDir = resolveGameDir(defaultInstall())!;
const mods: ModInfo[] = [];

// The mods the save was played with (its metadata's mods = { "mod/ugc_<workshop id>.mod" … }) that sit in the Workshop folder are
// loaded, in the save's order: the titles, faiths, houses and cultures a modded save carries are overridden entries only with
// the mod that defines them (AGOT=1 asks for AGOT, for a save whose list is missing or not complete). A mod of the save that
// is not in the Workshop folder (a local one) is not loaded, and the cases that need its entries are left out, not failed.
const saveMods = [...(/\bmods\s*=\s*\{([^}]*)\}/.exec(readSave(file).meta.toString('utf8'))?.[1] ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]);
const workshopIds = saveMods.map((m) => /^mod\/ugc_(\d+)\.mod$/.exec(m)?.[1]).filter((x): x is string => !!x);

if (process.env.AGOT && !workshopIds.includes('2962333032'))
    workshopIds.push('2962333032');

for (const wid of workshopIds)
{
    const root = join(workshopFolder(), wid);

    if (!existsSync(join(root, 'descriptor.mod')))
    {
        console.log(`note: the save's mod ${wid} is not in the Workshop folder, not loaded`);
        continue;
    }

    const d = parseDescriptor(readFileSync(join(root, 'descriptor.mod'), 'utf8'));
    mods.push({ id: `mod/ugc_${wid}.mod`, name: d.name ?? wid, root, status: 'ok', replacePaths: d.replacePaths ?? [], source: 'steam', editable: false } as unknown as ModInfo);
}

console.log(`mods of the save: ${saveMods.join(', ') || 'none'}; loaded: ${mods.map((m) => m.name).join(', ') || 'none'}`);

let t = performance.now();
const g = new Gamestate(readSave(file).gamestate);
const layer = saveLayer(file, statSync(file).mtimeMs, g, 'Savegame');
console.log(`save read and projected: ${(performance.now() - t).toFixed(0)} ms, ${[...layer.files.values()].reduce((s, b) => s + b.length, 0) / 1e6} MB of files`);
t = performance.now();
const idx = await fastIndex(new GameFiles(gameDir, mods, layer));
console.log(`index built: ${(performance.now() - t).toFixed(0)} ms, ${idx.stats.entities} entries`);

const chars = idx.names(T_SAVE_CHARACTER);
check(chars.length === g.characters().size, `savegame/characters: ${chars.length} entries (the save has ${g.characters().size})`);
check(typeGroup(T_SAVE_CHARACTER) === 'Savegame' && idx.types().some((x) => x.id === T_SAVE_CHARACTER && x.group === 'Savegame'), 'the type is in the group Savegame');

const players = g.section('currently_played_characters');
const id = process.argv[3] ?? (players?.block ? g.buf.subarray(players.vs + 1, players.ve - 1).toString('latin1').trim().split(/\s+/)[0] : chars[0]);
const e = idx.get(T_SAVE_CHARACTER, id)!;
const touch = idx.modTouch(e);
check(e && touch?.state === 'added' && touch.mods.at(-1) === layer.id, `${id}: marked as the save's (${JSON.stringify(touch)})`);
console.log(`     display: ${idx.displayName(e)}`);
const card = new StoryBuilder(idx).card(e);
const flat = (segs: unknown): string => (Array.isArray(segs) ? segs.map((s) => (typeof s === 'string' ? s : (s as { text?: string; }).text ?? '')).join('') : String(segs ?? ''));
console.log('     facts: ' + card.facts.map(flat).join(' | '));

for (const s of card.sections)
    console.log(`     [${s.title}] ` + s.lines.slice(0, 6).map((l) => flat(l.text)).join(' | '));

const out = idx.detail(T_SAVE_CHARACTER, id)!.outgoing;
const own = out.find((x) => x.type === T_SAVE_CHARACTER);
check(own && own.items.length > 0, `links to the save's own characters: ${own?.items.slice(0, 4).map((r) => JSON.stringify(r).slice(0, 80)).join(', ')}`);
check(!out.some((x) => x.type === 'characters'), 'no link to a historical character by a save id');
// a historical character the save carries (character_lookup): marked overridden by the save, linked to the save's
const carried = [...layer.overrides].find(([k]) => idx.get('characters', k.slice('characters|'.length)));
const hist = carried && idx.get('characters', carried[0].slice('characters|'.length))!;
const ht = hist && idx.modTouch(hist);
check(carried && ht?.state === 'overridden' && ht.save?.name === carried[1].name && ht.mods.at(-1) === layer.id, `${layer.overrides.size} historical characters carried by the save; ${carried?.[0]}: ${JSON.stringify(ht)}`);
// titles, faiths, houses the save has: overridden, their card's first section the save's
const sb = new StoryBuilder(idx);
const firstLines = (type: string, name: string): string =>
{
    const x = idx.get(type, name);
    const c = x && sb.card(x);
    return c && c.sections[0]?.title === 'Savegame' ? c.sections[0].lines.map((l) => flat(l.text)).join(' | ') : '';
};

for (const [type, pick] of [['landed_titles', (k: string) => k.startsWith('k_')], ['faith', () => true], ['dynasty_houses', () => true], ['culture/cultures', () => true]] as const)
{
    const key = [...layer.facts.keys()].find((k) => k.startsWith(type + '|') && pick(k.slice(type.length + 1)) && idx.get(type, k.slice(type.length + 1)));
    const name = key?.slice(type.length + 1) ?? '';
    const tt = key ? idx.modTouch(idx.get(type, name)!) : undefined;
    const lines = key ? firstLines(type, name) : '';
    // (when it fails, say what was found: how many facts of the type the save projects, how many of them the index knows, the state)
    const ofType = [...layer.facts.keys()].filter((k) => k.startsWith(type + '|'));
    const known = ofType.filter((k) => idx.get(type, k.slice(type.length + 1))).length;
    const found = key ? `touch ${JSON.stringify(tt)}, the first section of the card is not the save's` : `no ${type} fact picked`;

    // (none of the type's entries in the index and a mod of the save not loaded: the entries are that mod's, nothing to compare)
    if (ofType.length && !known && mods.length < saveMods.length)
    {
        console.log(`skip ${type}: ${ofType.length} facts, none in the index, and ${saveMods.length - mods.length} of the save's mods are not loaded`);
        continue;
    }

    check(key && tt?.state === 'overridden' && tt.mods.at(-1) === layer.id && lines, `${type} ${name}: overridden by the save: ${lines ? lines.slice(0, 160) : found} (${ofType.length} facts of the type, ${known} in the index)`);
}

const ownFaith = idx.names('savegame/faiths')[0];
const reformed = [...layer.facts.keys()].filter((k) => k.startsWith('savegame/faiths|')).length;
// (a save in which nobody reformed a faith has none: the layout checks then rest on the game faiths above)
check(reformed ? ownFaith && firstLines('savegame/faiths', ownFaith) : !ownFaith, reformed ? `the save's own faith ${ownFaith}: ${firstLines('savegame/faiths', ownFaith).slice(0, 160)}` : 'no reformed faith in this save: no faith of its own');
// characters' faith: the projected characters carry it in either layout (1.18 / 1.19 `faith`, 1.20 `rite`)
const withReligion = [...layer.files].filter(([rel]) => rel.startsWith('savegame/characters/')).reduce((n, [, b]) => n + (b.toString('utf8').match(/^\treligion = /gm) ?? []).length, 0);
const expectReligion = [...g.characters().keys()].filter((cid) => g.character(cid)!.faith?.key !== undefined).length;
check(withReligion > 0 && withReligion === expectReligion, `${withReligion} of ${chars.length} projected characters carry a religion (${expectReligion} have a faith or rite that resolves)`);
// ... counted again without faithOf / riteFaiths: the rites' `faith = n` read straight from the rites section's text, the
// characters' `faith = n` / `rite = n` lines from their blocks' text (what the game's own lines say, not the code's mapping)
const rawSection = (name: string): string => { const x = g.section(name); return x ? g.buf.subarray(x.vs, x.ve).toString('latin1') : ''; };
const rawRites = new Map([...rawSection('rites').matchAll(/(?:^|\s)(\d+)\s*=\s*\{\s*faith\s*=\s*(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]));
let rawResolved = 0;

for (const ref of g.characters().values())
{
    const text = g.buf.subarray(ref.s, ref.e).toString('latin1');
    const faith = /^\s*faith\s*=\s*(\d+)\s*$/m.exec(text)?.[1];
    const rite = /^\s*rite\s*=\s*(\d+)\s*$/m.exec(text)?.[1];
    const id = faith !== undefined && faith !== '4294967295' ? Number(faith) : rite !== undefined ? rawRites.get(Number(rite)) : undefined;

    if (id !== undefined && g.faithGameKeys().has(id))
        rawResolved++;
}

check(rawResolved === expectReligion, `an independent count of the characters' faith (${rawRites.size} rites read from the text) finds ${rawResolved}, as faithOf does (${expectReligion})`);
const faithCard = (e ? card.facts.map(flat).join(' ') : '');
check(/Faith:/.test(faithCard), `the played character's card shows a faith (${faithCard.slice(0, 120)})`);
console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
