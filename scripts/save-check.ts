// Checks reading and writing game saves (src/main/saves/, docs/saves.md) on copies in TEMP: the header, the gamestate,
// the characters and their lookups, a write without edits (the gamestate byte for byte the same, the metadata too)
// and one with an edit (read back). Binary saves are recognised and refused for editing.
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=8000 scripts/save-check.ts <save.ck3>…
// (default: every .ck3 in %TEMP%/ck3-saves and its subfolders)
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSave, writeSave } from '../src/main/saves/envelope.ts';
import { entries, Gamestate } from '../src/main/saves/gamestate.ts';
import { projectCharacters } from '../src/main/saves/project.ts';
import { projectState } from '../src/main/saves/project-state.ts';
import { SaveSession, setField } from '../src/main/saves/session.ts';
import { T_SAVE_FAITH } from '../src/main/indexer/schema.ts';
import type { SaveFact } from '../src/main/mods/gamefiles.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

// (a `faith = n` line in a block: the stray line a 1.20 block must not get; checked on a text that has one below, so the
// pattern cannot silently stop matching)
const hasFaithLine = (text: string): boolean => /\bfaith\s*=/.test(text);

// A small gamestate in each layout (no save needed): 1.18 / 1.19 `religion.faiths` + `faith = <id>`, 1.20 `faiths.database`
// (`faith_type`, a name on every faith) + `rites.database` + `rite = <id>`. Faith 1 is a reformed one, in both.
function syntheticChecks(): void
{
    const head = 'date=1066.1.1\ntraits_lookup={ brave craven }\nculture_manager={ cultures={ 1={ name=norse } } }\n';
    const living = (field: (faith: number) => string, extra = ''): string => `living={\n7={\n first_name="Ann"\n birth=1040.1.1\n female=yes\n ${field(0)}\n culture=1\n}\n8={\n first_name="Bo"\n ${field(1)}\n}\n9={\n first_name="Cy"\n}\n${extra}}\n`;
    const old = head
        + 'religion={\n faiths={\n 0={\n template=catholic\n tag="catholic"\n fervor=50\n }\n 1={\n template=catholic\n tag="dynamic_faith_1"\n name="Reformed"\n founder=7\n doctrine=a\n doctrine=b\n }\n }\n}\n'
        + living((f) => `faith=${f}`);
    const now = head
        + 'religion={\n religions={\n 0={\n religion_type=christianity\n faiths={ 0 1 }\n }\n }\n}\n'
        + 'faiths={\n database={\n 0={\n faith_type=catholic\n religion=0\n main_rite=0\n tag="catholic"\n name="Catholicism"\n tenet=tenet_x\n }\n 1={\n faith_type=catholic\n religion=0\n main_rite=3\n tag="dynamic_faith_1"\n name="Reformed"\n tenet=tenet_y\n doctrine=a\n }\n }\n}\n'
        // (rite 3 is the reformed faith's main rite; rite 5 another rite of it, with a name of its own: a rite is a variant of
        // a faith with its own tenets and doctrines; character 10 is of that rite)
        + 'rites={\n database={\n 0={\n faith=0\n founder=4294967295\n data={\n  tag="dynamic_rite_1"\n  name="Catholic rite"\n }\n }\n 3={\n faith=1\n founder=7\n data={\n  tag="dynamic_rite_4"\n  name="Reformed rite"\n }\n }\n 5={\n faith=1\n founder=4294967295\n data={\n  tag="dynamic_rite_6"\n  name="Fisher rite"\n  tenets={ {\n   tenet=tenet_z\n  } }\n }\n }\n }\n}\n'
        + living((f) => `rite=${f === 0 ? 0 : 3}`, '10={\n first_name="Di"\n rite=5\n}\n');

    for (const [name, text, layout] of [['1.18', old, 'religion'], ['1.20', now, 'faiths']] as const)
    {
        const g = new Gamestate(Buffer.from(text, 'latin1'));
        check(g.faithLayout() === layout && !g.layoutNote(), `${name} layout: faiths read from the ${layout} layout`);
        check(g.faiths().get(0) === 'catholic' && g.faiths().get(1) === 'dynamic_faith_1', `${name}: faith keys by tag`);
        check(g.faithGameKeys().get(0) === 'catholic' && g.faithGameKeys().get(1) === 'catholic', `${name}: a reformed faith's game key is its template`);
        check(g.faithNames().size === 1 && g.faithNames().get(1) === 'Reformed', `${name}: only the reformed faith has a name of its own (${[...g.faithNames()].join(' ')})`);
        check(g.character(7)?.faith?.key === 'catholic' && g.character(8)?.faith?.id === 1 && g.character(8)?.faith?.key === 'dynamic_faith_1' && g.character(9)?.faith === undefined, `${name}: a character's faith resolves (rite or faith), none stays none`);
        check(g.faithOf(undefined, undefined) === undefined && g.faithOf('4294967295', '4294967295') === undefined && g.faithOf(undefined, '77') === undefined, `${name}: faithOf: none and a rite the save lacks name no faith`);
        const w = g.faithField(1);
        check(w?.field === (name === '1.18' ? 'faith' : 'rite') && w.value === (name === '1.18' ? '1' : '3'), `${name}: a faith is written as ${w?.field} ${w?.value}`);
        check(g.faithField(5)?.value === (name === '1.18' ? '5' : undefined), `${name}: a faith with no rite is refused where rites are written`);
        const chars = projectCharacters(g);
        const script = [...chars.values()].join('');
        // (1.20 has a fourth character, on the reformed faith's other rite)
        check((script.match(/religion = catholic/g) ?? []).length === (name === '1.20' ? 3 : 2) && /^7 = \{/m.test(script), `${name}: the projected characters carry religion = catholic (${(script.match(/religion = /g) ?? []).length})`);
        const state = projectState(g);
        check(state.facts.has('faith|catholic') && state.facts.has(`${T_SAVE_FAITH}|dynamic_faith_1`) && !state.facts.has('faith|dynamic_faith_1'), `${name}: the game faith is overridden, the reformed one an entry of its own`);
        const own = state.facts.get(`${T_SAVE_FAITH}|dynamic_faith_1`) ?? [];
        const fact = (label: string): SaveFact | undefined => own.find((x) => x.label === label);
        check(fact('Name')?.text === 'Reformed' && fact('Reformed from')?.ref?.name === 'catholic' && fact('Founder')?.ref?.name === '7', `${name}: the reformed faith's name, template and founder${name === '1.20' ? ' (from its main rite)' : ''}`);
        check(!(state.facts.get('faith|catholic') ?? []).some((x) => x.label === 'Name' || x.label === 'Reformed from'), `${name}: a game faith shows no name of its own and no 'reformed from'`);
        check(/template = catholic/.test(state.faiths) && /^dynamic_faith_1 = \{/m.test(state.faiths) && !/^catholic = \{/m.test(state.faiths), `${name}: savegame/faiths holds the reformed faith only`);
        // the write goes into the character's block as the layout has it
        const block = Buffer.from(`8={\n first_name="Bo"\n ${name === '1.18' ? 'faith=1' : 'rite=3'}\n}\n`);
        const changed = setField(block, [w!.field], g.faithField(0)!.value).toString();
        check(new RegExp(`\\b${w!.field}=0\\b`).test(changed) && (name === '1.18' || !hasFaithLine(changed)), `${name}: a change of faith edits ${w!.field} in place (no stray faith= in a 1.20 block)`);
        check(hasFaithLine('rite=0 faith = 5') && hasFaithLine('faith=5') && !hasFaithLine('rite=0 ethnicity=faithful'), `${name}: the stray-faith pattern matches a faith line`);

        // rites other than the main one (1.20): a character keeps its rite when the faith is its own, and shows it
        if (name === '1.18')
        {
            check(g.faithField(1, '5')?.field === 'faith' && g.character(8)?.rite === undefined, '1.18: no rites (a rite value changes nothing, a character has none)');
            continue;
        }

        const di = g.character(10);
        check(di?.faith?.id === 1 && di.rite?.id === 5 && di.rite.name === 'Fisher rite' && !di.rite.main && g.character(8)?.rite?.main === true && g.character(8)?.rite?.name === 'Reformed rite', `${name}: a character on a faith's other rite shows the rite (${di?.rite?.name}) and its faith (${di?.faith?.key})`);
        check(g.faithField(1, '5')?.value === '5' && g.faithField(1, '3')?.value === '3' && g.faithField(1)?.value === '3', `${name}: picking the faith a character is of keeps its rite (5 stays 5, 3 stays 3, none → main rite 3)`);
        check(g.faithField(0, '5')?.value === '0' && g.faithField(1, '0')?.value === '3' && g.faithField(1, '77')?.value === '3', `${name}: another faith gets its main rite (a rite of another faith or a rite the save lacks is not kept)`);
        check(g.riteIn(Buffer.from('10={\n first_name="Di"\n rite=5\n}\n')) === '5' && g.riteIn(Buffer.from('9={\n first_name="Cy"\n}\n')) === undefined, `${name}: the rite a block names is read`);
        const kept = setField(Buffer.from('10={\n first_name="Di"\n rite=5\n}\n'), [g.faithField(1, '5')!.field], g.faithField(1, '5')!.value).toString();
        check(/rite=5\b/.test(kept) && !hasFaithLine(kept), `${name}: a faith change to the same faith leaves rite = 5 in the block`);
        const others = state.facts.get(`${T_SAVE_FAITH}|dynamic_faith_1`)?.find((x) => x.label === 'Other rites');
        check(others?.text === 'Fisher rite' && !(state.facts.get('faith|catholic') ?? []).some((x) => x.label === 'Other rites'), `${name}: the reformed faith lists its other rite by name (${others?.text}), the main rite is not "other"`);
        check(/^\ttenets = \{ tenet_y \}$/m.test(state.faiths) && /\tdoctrine = a$/m.test(state.faiths), `${name}: the faith of its own in savegame/faiths keeps its tenets (tenets = { … }) and doctrines`);
    }

    // a save with neither layout: said
    const none = new Gamestate(Buffer.from(head + living((f) => `faith=${f}`), 'latin1'));
    check(none.faithLayout() === 'none' && !!none.layoutNote() && none.faiths().size === 0, 'a save with no faith table is told as such, not shown as empty silently');
}

syntheticChecks();

const files = process.argv.slice(2);

if (!files.length)
{
    const walk = (d: string): void =>
    {
        for (const x of readdirSync(d, { withFileTypes: true }))
            x.isDirectory() ? walk(join(d, x.name)) : x.name.endsWith('.ck3') && files.push(join(d, x.name));
    };
    walk(join(tmpdir(), 'ck3-saves'));
}

for (const file of files)
{
    console.log(`\n-- ${file} (${(statSync(file).size / 1e6).toFixed(1)} MB)`);
    let t = performance.now();
    const save = readSave(file);
    console.log(`     header: version ${save.header.version}, kind ${save.header.kind}, metadata ${save.meta.length} bytes, ${save.zipped ? 'zipped' : 'inline'}, gamestate ${(save.gamestate.length / 1e6).toFixed(1)} MB${save.others.length ? ', also ' + save.others.map((o) => o.name).join(', ') : ''} (${(performance.now() - t).toFixed(0)} ms)`);

    if (save.binary)
    {
        check(true, 'binary: recognised (not decoded)');
        continue;
    }

    t = performance.now();
    const g = new Gamestate(save.gamestate);
    const sections = g.top.length;
    const chars = g.characters();
    const places = [...chars.values()].reduce((m, c) => m.set(c.place, (m.get(c.place) ?? 0) + 1), new Map<string, number>());
    console.log(`     ${sections} top-level entries, date ${g.date()}, ${chars.size} characters (${[...places].map(([k, v]) => `${k} ${v}`).join(', ')}), ${(performance.now() - t).toFixed(0)} ms`);
    t = performance.now();
    console.log(`     lookups: ${g.traitLookup().length} traits, ${g.cultures().size} cultures, ${g.faiths().size} faiths, ${g.houses().size} houses, ${(performance.now() - t).toFixed(0)} ms`);
    check(chars.size > 0 && g.date(), 'characters and the date found');
    console.log(`     faiths: layout ${g.faithLayout()}, ${g.riteTable() ? g.riteFaiths().size + ' rites' : 'no rites'}, ${g.faithNames().size} with a name of their own`);
    check(g.faithLayout() !== 'none' && g.faiths().size > 0 && !g.layoutNote(), `the save's faiths are found (${g.faithLayout()}: ${g.faiths().size})`);
    // the rites' faiths read again from the text of the rites section (`<id> = { faith = <id>`), not through riteFaiths()
    const ritesAt = g.section('rites');
    const rawRites = ritesAt ? [...g.buf.subarray(ritesAt.vs, ritesAt.ve).toString('latin1').matchAll(/(?:^|\s)(\d+)\s*=\s*\{\s*faith\s*=\s*(\d+)/g)] : [];
    check(rawRites.length === g.riteFaiths().size && rawRites.every((m) => g.riteFaiths().get(Number(m[1])) === Number(m[2])), `${g.riteFaiths().size} rites: each one's faith is the one its text names (${rawRites.length} found in the text)${[...g.riteFaiths()].some(([r, f]) => r !== f) ? '' : '; rite id = faith id in this save'}`);
    // the characters' faith resolves (1.18 / 1.19: faith = id, 1.20: rite = id) and so does the counties'
    const sample = [...chars.values()].filter((c) => c.place === 'living').slice(0, 2000).map((c) => g.character(c.id)!);
    // (some living characters have no faith field at all (open question 3); each one that is there resolves)
    const named = sample.filter((c) => c.node.some((n) => n.k === 'faith' || n.k === 'rite'));
    check(named.length > 0 && named.every((c) => c.faith?.key !== undefined), `${named.length} of ${sample.length} living characters name a faith (faith or rite), every one resolves to a key`);

    // 1.20: in every save of the owner the rite id equals the faith id, so nothing there tells them apart. A copy of the
    // gamestate gets a rite of its own (id 99999, another rite of the faith of a character) and the character is put on it
    const onRite = g.riteTable() ? sample.find((c) => c.rite && c.faith) : undefined;

    if (onRite)
    {
        const variant = new Gamestate(save.gamestate);
        const table = variant.riteTable()!;
        const at = onRite.at.s + onRite.node.find((n) => n.k === 'rite')!.vs;
        const to = onRite.at.s + onRite.node.find((n) => n.k === 'rite')!.e;
        variant.edit({ s: table.ve - 1, e: table.ve - 1 }, ` 99999={ faith=${onRite.faith!.id} founder=4294967295 data={ name="Variant rite" } }\n`);
        variant.edit({ s: at, e: to }, '99999');
        const v = new Gamestate(variant.apply());
        const moved = v.character(onRite.id)!;
        check(v.riteFaiths().get(99999) === onRite.faith!.id && moved.rite?.id === 99999 && moved.rite.name === 'Variant rite' && !moved.rite.main && moved.faith?.id === onRite.faith!.id && moved.faith.key === onRite.faith!.key, `a rite of its own (99999, ≠ its faith ${onRite.faith!.id}): character ${onRite.id} stays of faith ${moved.faith?.key}, on the rite "${moved.rite?.name}"`);
        const keep = v.faithField(onRite.faith!.id, '99999');
        const main = v.faithField(onRite.faith!.id);
        check(keep?.field === 'rite' && keep.value === '99999' && main?.value !== '99999' && main?.field === 'rite', `picking the faith again keeps rite ${keep?.value}; with no rite it gets the main rite ${main?.value}`);
        const block = v.buf.subarray(moved.at.s, moved.at.e);
        const same = setField(Buffer.from(block), [keep!.field], keep!.value).toString();
        check(/\brite\s*=\s*99999\b/.test(same) && !hasFaithLine(same), 'the block written for the same faith still holds rite = 99999 and no faith =');
    }
    else if (g.riteTable())
        check(false, 'no living character with a rite found to try a rite of its own on');

    const counties = g.sub(g.section('county_manager'), 'counties');
    let countyFaiths = 0;
    let countyRefs = 0;

    for (const x of counties?.block ? entries(g.buf, counties.vs, counties.ve) : [])
    {
        const f = new Map([...entries(g.buf, x.vs, x.ve)].filter((e) => e.key === 'faith' || e.key === 'rite').map((e) => [e.key!, g.buf.subarray(e.vs, e.ve).toString('latin1')]));

        if (!f.size)
            continue;

        countyRefs++;
        const id = g.faithOf(f.get('faith'), f.get('rite'));

        if (id !== undefined && g.faithGameKeys().has(id))
            countyFaiths++;
    }

    check(!countyRefs || countyFaiths === countyRefs, `${countyFaiths} of ${countyRefs} counties with a faith or rite resolve to a faith`);

    // a few living characters read
    const living = [...chars.values()].filter((c) => c.place === 'living').slice(0, 3);

    for (const ref of living)
    {
        const c = g.character(ref.id)!;
        console.log(`     ${c.id}: ${c.firstName}${c.female ? ' (f)' : ''}, born ${c.birth}, house ${c.house?.key ?? c.house?.id ?? 'none'}, culture ${c.culture?.key ?? 'none'}, faith ${c.faith?.key ?? 'none'}, skills ${c.skills.join(' ')}, traits ${c.traits.map((x) => x.key ?? '#' + x.index).join(' ')}, gold ${c.gold ?? 'none'}`);
    }

    const first = g.character(living[0].id)!;
    check(first.firstName && first.traits.every((x) => x.key), 'a living character: a name, every trait index known');

    // written back without edits: the same gamestate and metadata
    const out = join(tmpdir(), 'ck3-saves-out');
    mkdirSync(out, { recursive: true });
    const copy = join(out, 'roundtrip.ck3');
    t = performance.now();
    await writeSave(copy, save, g.apply());
    const back = readSave(copy);
    check(back.gamestate.equals(save.gamestate) && back.meta.equals(save.meta) && back.header.kind === save.header.kind && back.header.random.equals(save.header.random), `written without edits and read back: the same (${(performance.now() - t).toFixed(0)} ms, ${(statSync(copy).size / 1e6).toFixed(1)} MB)`);

    // an edit: the first character's first name
    const nameNode = first.node.find((n) => n.k === 'first_name')!;
    const s = first.at.s + nameNode.vs;
    const e = first.at.s + nameNode.e;
    g.edit({ s, e }, '"Testname Ünïcode"');
    const edited = join(out, 'edited.ck3');
    await writeSave(edited, save, g.apply());
    const g2 = new Gamestate(readSave(edited).gamestate);
    const c2 = g2.character(first.id)!;
    check(c2.firstName === 'Testname Ünïcode' && c2.traits.length === first.traits.length && g2.characters().size === chars.size, `an edited first name read back: ${c2.firstName}`);

    // the session: search, changes (a field the character doesn't have added), undo, written and read back
    t = performance.now();
    const ses = new SaveSession(file);
    const hits = ses.search(first.firstName);
    console.log(`     session: opened, ${hits.length} hits for "${first.firstName}" (${(performance.now() - t).toFixed(0)} ms)`);
    check(hits.some((h) => h.id === first.id), 'the search finds the character by its first name');
    const id = first.id;
    const before = ses.character(id)!;
    const lookup = g.traitLookup();
    const extra = lookup.find((k) => k === 'brave') ?? lookup[lookup.length - 1];
    ses.edit({ id, field: 'skills', numbers: [20, 1, 2, 3, 4, 5] });
    ses.edit({ id, field: 'traits', keys: [...before.traits.map((x) => x.key!).filter((k) => k !== extra).slice(1), extra] });
    ses.edit({ id, field: 'gold', number: 1234.5 });
    ses.edit({ id, field: 'nickname', text: 'the Tested' });
    ses.edit({ id, field: 'stress', number: 0 });
    let now = ses.character(id)!;
    check(now.skills.join() === '20,1,2,3,4,5' && now.traits.some((x) => x.key === extra) && !now.traits.some((x) => x.key === before.traits[0].key && before.traits[0].key !== extra) && now.gold === 1234.5 && now.nickname === 'the Tested' && now.stress === 0, `changes read back: skills ${now.skills.join(' ')}, traits ${now.traits.map((x) => x.key).join(' ')}, gold ${now.gold}, nickname ${now.nickname}, stress ${now.stress}`);
    const otherCulture = ses.lookup('culture').find((x) => x.id !== before.culture?.id)!;
    const otherFaith = ses.lookup('faith').find((x) => x.id !== before.faith?.id)!;
    ses.edit({ id, field: 'culture', number: otherCulture.id });
    ses.edit({ id, field: 'faith', number: otherFaith.id });
    const cf = ses.character(id)!;
    check(cf.culture?.id === otherCulture.id && cf.faith?.id === otherFaith.id && cf.culture?.key === otherCulture.key, `culture and faith changed to the save's ${otherCulture.key} / ${otherFaith.name ?? otherFaith.key}`);
    // the faith is written as the save has it: `faith = id`, in a save with rites `rite = <the faith's main rite>` (and no stray faith)
    const field = g.faithField(otherFaith.id)!;
    const raw = (ses as unknown as { block(n: number): Buffer; }).block(id).toString('utf8');
    check(new RegExp(`\\b${field.field}\\s*=\\s*${field.value}\\b`).test(raw) && (field.field === 'faith' || !hasFaithLine(raw)), `the changed block holds ${field.field} = ${field.value}${field.field === 'rite' ? ' and no faith = ' : ''}`);
    let refused = false;

    try
    {
        ses.edit({ id, field: 'culture', number: 999999 });
    }
    catch
    {
        refused = true;
    }

    check(refused, 'a culture the save doesn\'t have is refused');
    ses.undo();
    now = ses.character(id)!;
    check(now.faith?.id === before.faith?.id && now.culture?.id !== before.culture?.id && now.stress === 0, `undo takes the last change back (the faith: ${now.faith?.key})`);
    const written = join(out, 'session.ck3');
    await ses.writeAs(written);
    const back2 = new SaveSession(written);
    const c3 = back2.character(id)!;
    check(c3.gold === 1234.5 && c3.nickname === 'the Tested' && c3.skills[0] === 20 && back2.search('').length > 0 && back2.g.characters().size === chars.size, 'written as a new file: the changes are in it, every character still there');
    // the rest of the gamestate as it was: only the character's block differs
    const ga = save.gamestate;
    const gb = back2.save.gamestate;
    const ref = g.characters().get(id)!;
    check(ga.subarray(0, ref.s).equals(gb.subarray(0, ref.s)) && ga.subarray(ref.e).equals(gb.subarray(gb.length - (ga.length - ref.e))), 'everything outside the changed character is byte for byte as before');
    await ses.writeAs(file).then(() => check(false, 'writing over the original is refused'), () => check(true, 'writing over the original is refused'));
    rmSync(out, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
