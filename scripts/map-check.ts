// The map's history and realms against known facts (docs/map.md, "History and realms"): builds the index, the
// province raster and MapData in plain Node, reads the map at dates (its static and dated parts composed as the
// renderer does shared/mapCompose.ts) and checks realms, holders, names and de jure lieges; prints a short report with
// timings and sizes and exits non-zero when a check fails.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=6000 scripts/map-check.ts
//   AGOT=1                  layered over A Game of Thrones (the Steam Workshop copy)
//   MODS=<playset>          the mods of a launcher playset (the real user folder, read only)
//   SETTINGS=<settings.json> the mod list of an app settings file (userDir + modList: a test environment)
//   SHOW=<title keys>       also print these titles at every checked date
// The game's (and the playset's) index: scripts/fast-index.ts (parse threads, cached in %TEMP%/ckp-index-cache; FRESH=1 builds
// it anew); the temp mod's index near the end is built anew, threaded.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { serialize } from 'node:v8';
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { discoverMods } from '../src/main/mods/discover.ts';
import { MapData } from '../src/main/map/mapData.ts';
import { buildRaster } from '../src/main/map/raster.ts';
import { readTitleTree } from '../src/main/map/titles.ts';
import { TitleNamer } from '../src/main/map/titles-names.ts';
import { parse } from '../src/main/indexer/parser.ts';
import { faithHasDoctrine, faithTable, riteHistory } from '../src/main/indexer/layouts.ts';
import { CoaFacts } from '../src/main/coa/facts.ts';
import { CoaTriggers } from '../src/main/coa/triggers.ts';
import { coatOfArms } from '../src/main/coa/coa.ts';
import { History } from '../src/main/portraits/modifiers.ts';
import { CharacterTable } from '../src/main/history/characters.ts';
import { mapCharacters } from '../src/main/map/edit-characters.ts';
import { composeMapInfo } from '../src/shared/mapCompose.ts';
import type { MapInfo, ModInfo } from '../src/shared/api.ts';
import { defaultInstall } from './ck3-install.ts';
import { fastIndex, parseIndex } from './fast-index.ts';

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

let files = new GameFiles(gameDir);
const agot = !!process.env.AGOT;

if (agot)
{
    const mod = discoverMods(join(homedir(), 'no-user-folder'), gameDir, null).find((m) => m.remoteId === '2962333032');

    if (!mod)
        throw new Error('A Game of Thrones (Workshop 2962333032) is not installed');

    files = new GameFiles(gameDir, [mod]);
}
else if (process.env.MODS || process.env.SETTINGS)
{
    // (the launcher database needs node:sqlite: --experimental-sqlite)
    const { readModsState, modsOfList } = await import('../src/main/mods/manager.ts');
    const settings = process.env.SETTINGS ? JSON.parse(readFileSync(process.env.SETTINGS, 'utf8')) : { gameDir: install, language: 'english' };
    const state = await readModsState(settings, gameDir, join(homedir(), 'Documents'));
    const ref = process.env.SETTINGS ? settings.modList : state.lists.find((l) => l.name === process.env.MODS || l.ref === process.env.MODS)?.ref;

    if (!ref)
        throw new Error(`No mod list "${process.env.MODS}": ${state.lists.map((l) => l.name).join(', ')}`);

    files = new GameFiles(gameDir, modsOfList(state, ref));
}

if (files.sources.length > 1)
    console.log('mods:', files.sources.map((s) => s.name).join(' → '));

let t = performance.now();
const idx = await fastIndex(files, { cache: true });
console.log(`index ${Math.round(performance.now() - t)} ms`);
const md = new MapData(idx);
const mf = md.mapFiles();
t = performance.now();
const { meta } = buildRaster(files.read(mf.provinces)!, files.readText(mf.definitions)!, 'check');
console.log(`raster ${Math.round(performance.now() - t)} ms: ${meta.width} × ${meta.height}, ${meta.count} provinces`);

/** A fact at a date: the realm of a county (its first barony's province), its holder, names, de jure lieges. */
interface Check
{
    date: string;
    what: string;
    test: (m: MapInfo, title: (key: string) => number, county: (key: string) => number) => string | true;
}

const realmIs = (date: string, county: string, realm: string, extra?: { holder?: string; name?: string | RegExp; }): Check => ({
    date,
    what: `${county} in ${realm}${extra?.holder ? ` held by ${extra.holder}` : ''}${extra?.name ? ` named ${extra.name}` : ''}`,
    test: (m, title, prov) =>
    {
        const p = prov(county);
        const r = m.province.realm[p];
        const got = m.titles[r];

        if (!got)
            return `no realm (province ${p})`;

        if (got.key !== realm)
            return `realm ${got.key} (${got.name})`;

        if (extra?.holder && got.holder?.id !== extra.holder)
            return `holder ${got.holder?.id} (${got.holder?.name})`;

        if (extra?.name && !(typeof extra.name === 'string' ? got.name === extra.name : extra.name.test(got.name)))
            return `name "${got.name}"`;

        return true;
    }
});
const titleIs = (date: string, key: string, what: string, test: (x: MapInfo['titles'][number], m: MapInfo) => boolean): Check => ({
    date,
    what: `${key} ${what}`,
    test: (m, title) =>
    {
        const x = m.titles[title(key)];

        if (!x)
            return 'no such title';

        return test(x, m) || `got: ${JSON.stringify({ ...x, parent: m.titles[x.parent]?.key, liege: x.liege === undefined ? undefined : m.titles[x.liege]?.key, primary: x.primary === undefined ? undefined : m.titles[x.primary]?.key })}`;
    }
});

const checks: Check[] = agot
    ? [
        realmIs('8082.1.1', 'c_kings_landing', 'h_the_iron_throne', { holder: 'Targaryen_35' }),
        realmIs('8282.9.15', 'c_kings_landing', 'h_the_iron_throne'),
        titleIs('8282.9.15', 'h_the_iron_throne', 'held by Aerys II', (x) => /Aerys/.test(x.holder?.name ?? '')),
        // (Robert's Rebellion: history/titles `liege = 0` on 8282.9.15, back under the throne on 8282.12.31)
        realmIs('8282.9.15', 'c_winterfell', 'e_the_north', { holder: 'Stark_3' }),
        realmIs('8283.1.1', 'c_winterfell', 'h_the_iron_throne'),
        realmIs('8282.9.15', 'c_braavos', 'k_braavos'),
        // (Dorne joined the realm in 187 AC)
        realmIs('8082.1.1', 'c_sunspear', 'e_dorne')
    ]
    : [
        realmIs('867.1.1', 'c_ile_de_france', 'k_france', { name: 'West Francia' }),
        realmIs('1066.9.15', 'c_ile_de_france', 'k_france', { name: 'France' }),
        realmIs('1066.9.15', 'c_byzantion', 'e_byzantium'),
        realmIs('1066.9.15', 'c_cologne', 'e_hre'),
        realmIs('1066.9.15', 'c_roma', 'k_papal_state'),
        // (Ludwig holds k_bavaria longer, but history sets k_east_francia as his primary title)
        realmIs('867.1.1', 'c_regensburg', 'k_east_francia', { holder: '90107', name: 'East Francia' }),
        titleIs('867.1.1', 'k_east_francia', 'de jure under e_germany', (x, m) => m.titles[x.parent]?.key === 'e_germany'),
        titleIs('1066.9.15', 'k_east_francia', 'de jure under e_hre, named Germany', (x, m) => m.titles[x.parent]?.key === 'e_hre' && x.name === 'Germany'),
        titleIs('867.1.1', 'd_bavaria', 'held under Ludwig', (x, m) => x.liege !== undefined && m.titles[x.liege]?.key === 'k_east_francia'),
        // (a clan ruler of Arabic heritage: flavorization's empire tier is "Empire": the files name no "Caliphate" for it)
        titleIs('867.1.1', 'e_arabia', 'named Abbasid Empire (the house and the tier name)', (x) => x.name === 'Abbasid Empire' && x.baseName === 'Arabian Empire'),
        // (Béla III holds k_croatia first, k_hungary's ai_primary_priority prefers a Hungarian)
        realmIs('1178.10.1', 'c_esztergom', 'k_hungary'),
        // (history writes `867.1.1. = {` (a dot after) and `1066.1 = {`: the game reads them as dates)
        titleIs('867.1.1', 'c_ca_mau', 'held (date `867.1.1.`)', (x) => !!x.holder),
        titleIs('1066.9.15', 'c_nf_abo', 'not held (`1066.1 = { holder = 0 }`)', (x) => !x.holder),
        titleIs('657.1.1', 'd_sunni', 'held by Ali (holder_ignore_head_of_faith_requirement)', (x) => x.holder?.id === '33911'),
        // (nomads: the head of the culture's realm is named after the culture, a house head's after house and culture)
        titleIs('867.1.1', 'd_pecheneg', 'named Pechenegs (nomad culture head)', (x) => x.name === 'Pechenegs' && x.baseName === 'Pecheneg'),
        titleIs('1066.9.15', 'c_ladyzyn', 'named after house and culture (nomad house head)', (x) => / Pechenegs$/.test(x.name) && x.name !== 'Pechenegs'),
        titleIs('1066.9.15', 'k_france', 'held by a Capetian aged 14', (x) => /Cap/.test(x.holder?.house ?? '') && x.holder?.age === 14),
        titleIs('1066.9.15', 'k_england', 'held by Harold', (x) => /Harold/.test(x.holder?.name ?? '')),
        titleIs('889.1.1', 'k_funan', 'named Angkor', (x) => /Angkor/i.test(x.name)),
        titleIs('889.1.1', 'k_scotland', 'named Alba (cultural name, Gaelic holder)', (x) => x.name === 'Alba'),
        titleIs('1066.9.15', 'k_scotland', 'named Scotland (Scots holder)', (x) => x.name === 'Scotland'),
        titleIs('1066.9.15', 'h_china', 'named Song (set_title_name in an effect)', (x) => x.name === 'Song'),
        titleIs('1066.9.15', 'k_hungary', 'culture and faith of its holder', (x) => !!x.holder?.culture && !!x.holder?.faith)
    ];

const show = (process.env.SHOW ?? '').split(',').filter(Boolean);
const dates = [...new Set(checks.map((c) => c.date))];
let failed = 0;
let extras = 0;
t = performance.now();
const stat = md.static(meta);
console.log(`
static part ${Math.round(performance.now() - t)} ms (the first date's map with it), ${(serialize(stat).length / 1e6).toFixed(1)} MB`);

for (const date of dates)
{
    t = performance.now();
    const dated = md.dated(meta, date);
    const ms = Math.round(performance.now() - t);
    t = performance.now();
    const m = composeMapInfo(stat, dated);
    const composed = Math.round(performance.now() - t);
    const byKey = new Map(m.titles.map((x, i) => [x.key, i]));
    const title = (key: string): number => byKey.get(key) ?? -1;
    const county = (key: string): number =>
    {
        let c = title(key);
        const b = m.titles.findIndex((x) => x.parent === c && x.tier === 'b');
        const p = m.province.barony.indexOf(b);

        if (c < 0 || p < 0)
            throw new Error(`no province of ${key}`);

        return p;
    };
    const realms = new Set(m.province.realm.filter((r) => r >= 0)).size;
    console.log(`
${date}: ${ms} ms (composed: ${composed} ms), dated part ${Math.round(serialize(dated).length / 1e3)} kB, ${realms} realms, range ${m.range.from}–${m.range.to}`);

    for (const k of show)
    {
        const x = m.titles[title(k)];

        if (x)
        {
            const holder = x.holder ? `${x.holder.name} ${x.holder.house ?? ''} ${x.holder.age ?? ''} ${x.holder.culture?.name ?? ''} ${x.holder.faith?.name ?? ''}` : 'none';
            console.log(`  ${k}: "${x.name}"${x.baseName ? ` (${x.baseName})` : ''} de jure ${m.titles[x.parent]?.key}, holder ${holder}, primary ${m.titles[x.primary ?? -1]?.key}, liege ${m.titles[x.liege ?? -1]?.key}`);
        }
    }

    for (const c of checks.filter((x) => x.date === date))
    {
        let r: string | true;

        try
        {
            r = c.test(m, title, county);
        }
        catch (e)
        {
            r = (e as Error).message;
        }

        if (r !== true)
            failed++;

        console.log(`  ${r === true ? 'ok  ' : 'FAIL'} ${c.what}${r === true ? '' : ': ' + r}`);
    }
}

// 1.20 faiths and rites where history, titles, coats of arms and portraits read them (docs/map.md, "Coats of arms"): the
// vanilla game's own layout (faiths in religion/faith_types, rites in rite_types, history/faiths) and a made-up 1.19 one
if (files.sources.length === 1)
{
    const extra = (what: string, ok: boolean, got?: unknown): void =>
    {
        extras++;

        if (!ok)
            failed++;

        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ': got ' + JSON.stringify(got)}`);
    };
    console.log('\nfaiths, rites, coats of arms');
    const table = faithTable(idx);
    extra('faiths of both layouts in one table (sunni: islam_religion, main rite hanafi)', table.faiths.get('sunni')?.religion === 'islam_religion' && table.faiths.get('sunni')?.mainRite === 'hanafi' && table.faiths.size > 90, [table.faiths.get('sunni'), table.faiths.size]);
    extra('the rite\'s doctrine counts as the faith\'s (sunni: muhammad_succession_sunni_doctrine)', !!table.faiths.get('sunni')?.doctrines.has('muhammad_succession_sunni_doctrine'));
    extra('religion family (islam_religion: rf_abrahamic)', table.families.get('islam_religion') === 'rf_abrahamic', table.families.get('islam_religion'));
    const tree = readTitleTree(md.texts('common/landed_titles'), meta.count);
    const namer = new TitleNamer(idx, tree, md.texts('common/flavorization'));
    extra('titles: religionOf(sunni) = islam_religion, religionOf(hellenic_pagan) = hellenism_religion', namer.religionOf('sunni') === 'islam_religion' && namer.religionOf('hellenic_pagan') === 'hellenism_religion', [namer.religionOf('sunni'), namer.religionOf('hellenic_pagan')]);
    const history = new History(idx);
    const catholic = history.faith('catholic');
    extra('portraits: History.faith(catholic) = christianity_religion, with its religion\'s and the roman rite\'s doctrines', catholic?.religion === 'christianity_religion' && catholic.doctrines.has('doctrine_monotheist') && catholic.doctrines.has('special_doctrine_is_western_christian_faith'), [catholic?.religion, catholic?.doctrines.size]);

    // faiths whose type states no main_rite: the one rite type naming them is it ("Scripted main Rite: x (all start dates)")
    const unstated = ['iconoclast', 'bogomilist', 'cathar', 'waldensian', 'lollard', 'hussite', 'joachimite', 'paulician', 'messalian', 'adoptionist', 'maitreya_faith'];
    extra('faiths without a main_rite statement have their rite (iconoclast: iconoclast_rite, maitreya_faith: maitreya)', unstated.every((f) => !!table.faiths.get(f)?.mainRite) && table.faiths.get('iconoclast')?.mainRite === 'iconoclast_rite' && table.faiths.get('maitreya_faith')?.mainRite === 'maitreya', unstated.map((f) => table.faiths.get(f)?.mainRite));
    extra('portraits: the iconoclast faith has its rite\'s eastern christian doctrine, as bogomilist and cathar (western)', history.faith('iconoclast')?.doctrines.has('special_doctrine_is_eastern_christian_faith') === true && history.faith('bogomilist')?.doctrines.has('special_doctrine_is_eastern_christian_faith') === true && history.faith('cathar')?.doctrines.has('special_doctrine_is_western_christian_faith') === true);
    extra('faithHasDoctrine: with a date the rite of the date (catholic 1066: the western doctrine; sunni: the sunni one)', faithHasDoctrine(idx, 'catholic', 'special_doctrine_is_western_christian_faith', 10660915) && faithHasDoctrine(idx, 'sunni', 'muhammad_succession_sunni_doctrine', 10660915) && !faithHasDoctrine(idx, 'sunni', 'muhammad_succession_shia_doctrine', 10660915));
    const characters = new CharacterTable(idx, history);
    extra('character list: the religion facet is not empty', characters.facets().religions.length > 5, characters.facets().religions.length);
    extra('character list: filter by islam_religion finds characters', characters.filter({ religion: 'islam_religion' }).length > 100);

    // the picker's character search folds accents and case (docs/picker.md, "Historical characters"): the first name with
    // its accents taken off (by normalize, not by fold) finds the character, as does the name as written; and the order
    // is by the first word's fit to the first name (id, whole name, its start, elsewhere), never by rank alone
    {
        characters.search('a');
        const table = (characters as unknown as { searchable?: { r: { id: string; name: string; }; first: string; }[]; }).searchable ?? [];
        const plainName = (r: { name: string; }): string => idx.plainLoc(r.name) ?? r.name;
        const stripped = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const withAccent = table.filter((e) => /[^\x00-\x7f]/.test(plainName(e.r)) && /^[a-z]{4,}$/.test(stripped(plainName(e.r))));
        const sample = withAccent.slice(0, 3);
        extra('character search: there are first names with an accent to try', sample.length > 0, withAccent.length);

        for (const e of sample)
        {
            const written = plainName(e.r);
            const ids = (q: string): string[] => characters.search(q, 5000).map((h) => h.id);
            extra(`character search: "${stripped(written)}" finds ${written} (${e.r.id}), as does "${written}"`, ids(stripped(written)).includes(e.r.id) && ids(written).includes(e.r.id), [ids(stripped(written)).length, ids(written).length]);
        }

        const fitOf = (e: { r: { id: string; }; first: string; }, term: string): number => (e.r.id === term ? 0 : e.first === term ? 1 : e.first.startsWith(term) ? 2 : 3);
        const byId = new Map(table.map((e) => [e.r.id, e]));
        const fits = characters.search('william', 400).map((h) => fitOf(byId.get(h.id)!, 'william'));
        extra('character search: "william" is ordered by the first name fit (never a worse fit before a better one)', fits.length > 20 && fits.every((f, i) => i === 0 || f >= fits[i - 1]), [fits.length, fits.slice(0, 5)]);

        // the same without accents for a house (the character list's dynasty filter, the map holder chooser's
        // mapCharacters): the first house in the index whose display name has a word with an accent (and characters in
        // it), picked from the index, not by name
        const letters = (s: string): string[] => s.split(/[^\p{L}]+/u).filter(Boolean);
        let houseWord: string | undefined;
        let houseIds: string[] = [];

        for (const type of ['dynasty_houses', 'dynasties'])
        {
            for (const name of idx.names(type))
            {
                const e = idx.get(type, name);
                const word = e && !e.dead ? letters(idx.displayName(e) ?? '').find((w) => /[^\x00-\x7f]/.test(w) && /^[a-z]{4,}$/.test(stripped(w))) : undefined;
                const ids = word ? characters.filter({ dynasty: word }) : [];

                if (word && ids.length)
                {
                    houseWord = word;
                    houseIds = ids;
                    break;
                }
            }

            if (houseWord)
                break;
        }

        extra('character list: there is a house or dynasty with an accent in its name and characters to try', !!houseWord, [houseWord, houseIds.length]);

        if (houseWord)
        {
            const plainHouse = stripped(houseWord);
            const byStripped = new Set(characters.filter({ dynasty: plainHouse }));
            extra(`character list: the dynasty filter "${plainHouse}" finds every character the filter "${houseWord}" does`, houseIds.every((id) => byStripped.has(id)), [houseIds.length, byStripped.size]);
            extra(`character search: "${plainHouse}" finds a character of the house ${houseWord}`, characters.search(plainHouse, 5000).some((h) => houseIds.includes(h.id)));
            const date = '1066.9.15';
            const mapIds = (q: string): string[] => mapCharacters(idx, characters, q, date, 5000).map((c) => c.id);
            const withAccent = mapIds(houseWord);
            const without = mapIds(plainHouse);
            extra(`map holder search: "${plainHouse}" finds a character of the house ${houseWord}, and the same ones as "${houseWord}"`, without.some((id) => houseIds.includes(id)) && withAccent.length === without.length && withAccent.every((id) => without.includes(id)), [without.length, withAccent.length]);

            for (const e of sample)
            {
                const written = plainName(e.r);
                const isIn = (q: string): boolean => mapIds(q).includes(e.r.id);
                extra(`map holder search: "${stripped(written)}" finds ${written} (${e.r.id}), as does "${written}"`, isIn(stripped(written)) && isIn(written));
            }
        }
    }

    const facts = new CoaFacts(idx);
    const triggers = new CoaTriggers(idx, facts);
    const when = 10660915;
    const holds = (text: string, faith?: string): boolean =>
    {
        const ctx = triggers.ctx(when, { t: 'none' }, faith ? [['faith', { t: 'faith', key: faith }]] : []);
        return triggers.holds(parse(text), { t: 'none' }, ctx);
    };
    const rite = (faith: string, doctrine: string): boolean => holds(`scope:faith = { main_rite = { rite_has_doctrine = ${doctrine} } }`, faith);
    extra('rite scope: sunni has muhammad_succession_sunni_doctrine, not the shia one', rite('sunni', 'muhammad_succession_sunni_doctrine') && !rite('sunni', 'muhammad_succession_shia_doctrine'));
    extra('rite scope: shia has the shia doctrine, kharijite the muhakkima one', rite('shia', 'muhammad_succession_shia_doctrine') && rite('kharijite', 'muhammad_succession_muhakkima_doctrine'));
    extra('rite scope: coa_coptic_trigger holds for miaphysitism, not for catholic', holds('coa_coptic_trigger = yes', 'miaphysitism') && !holds('coa_coptic_trigger = yes', 'catholic'));
    extra('rite scope: rite_has_tenet and rite:<key> (the hanafi rite has no aniconism)', holds('scope:faith = { main_rite = { NOT = { rite_has_tenet = tenet_aniconism } } }', 'sunni') && holds('scope:faith.main_rite = rite:hanafi', 'sunni'));
    extra('a christian faith with the roman rite gets the cross (coa_cross_trigger)', holds('coa_cross_trigger = yes', 'catholic'));
    extra('iconoclast (no main_rite statement; its rite has tenet_aniconism): no cross; its rite scope works', !holds('coa_cross_trigger = yes', 'iconoclast') && holds('scope:faith = { main_rite = { rite_has_tenet = tenet_aniconism } }', 'iconoclast') && holds('scope:faith.main_rite = rite:iconoclast_rite', 'iconoclast'));
    extra('has_doctrine on a faith with the date\'s rite (iconoclast: eastern christian)', holds('scope:faith = { has_doctrine = special_doctrine_is_eastern_christian_faith }', 'iconoclast'));
    extra('NOT with two statements holds only when none does', holds('NOT = { always = no always = no }') && !holds('NOT = { always = yes always = no }') && holds('NAND = { always = yes always = no }'));

    const crown = (title: string): string | undefined => coatOfArms(idx, 'realm', title, '1066.9.15')?.frame?.crown?.texture;
    extra('realm banner: a cardinal seat (d_cd_porto) has the cardinal decoration, a king (k_france) the tier\'s crown', /cardinal_topframe_115/.test(crown('d_cd_porto') ?? '') && /crown_strip_115/.test(crown('k_france') ?? ''), [crown('d_cd_porto'), crown('k_france')]);
    extra('cardinal seats are the titles the faith lists in clerical_elector_titles (d_cd_porto), not every landless title that dies with its holder (k_fashion)', facts.isClericalElectorSeat('d_cd_porto') && !facts.isClericalElectorSeat('k_fashion') && faithTable(idx).electors.size > 40, [faithTable(idx).electors.size, facts.titleField('k_fashion', 'landless'), facts.titleField('k_fashion', 'destroy_on_succession')]);
    const frame = coatOfArms(idx, 'dynasty', 'vanity_bochenek', '1066.9.15')?.frame;
    extra('dynasty frame: a Polish dynasty (no dynasty_coa_frame) takes the culture\'s house frame', /frames\/house_frame_21\.dds$/.test(frame?.frame ?? ''), frame?.frame);
    const akan = coatOfArms(idx, 'dynasty', 'akandyn001', '1066.9.15')?.frame;
    extra('dynasty frame: and the house offset and scale of the culture (akan: house_frame_29, scale 0.95)', /frames\/house_frame_29\.dds$/.test(akan?.frame ?? '') && akan?.scale[0] === 0.95 && akan.scale[1] === 0.95 && akan.offset[0] === 0, [akan?.frame, akan?.offset, akan?.scale]);
    const plain = coatOfArms(idx, 'dynasty', '74', '1066.9.15')?.frame;
    extra('dynasty frame: a culture without house or dynasty frame gets the default (dynasty)', plain?.frame === 'gfx/interface/coat_of_arms/frames/dynasty.dds', plain?.frame);

    // a made-up mod over the vanilla game, in a TEMP folder: a 1.19 religion with its faiths nested in it, 1.20 faiths with
    // one rite, with two rites and a dated main rite, graphic defines that override the frames; then an incremental update
    // (the index is updated in place: the faith table of its earlier state must not stay)
    const tmp = mkdtempSync(join(tmpdir(), 'ckp-map-check-'));

    try
    {
        const root = join(tmp, 'mod', 'map_test');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'descriptor.mod'), 'version="1.0"\nname="Map Test"\nsupported_version="1.*"\n');
        const mod: ModInfo = { id: 'mod/map_test.mod', name: 'Map Test', tags: [], root, source: 'local', replacePaths: [], status: 'ok', editable: true };
        const put = (rel: string, text: string): string =>
        {
            const abs = join(root, rel);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, text);
            return abs;
        };
        put('common/religion/religion_types/ckp_old.txt', 'ckp_old_religion = {\n\tfamily = rf_ckp_old\n\tdoctrine = ckp_old_religion_doctrine\n\tfaiths = {\n\t\tckp_old_faith = {\n\t\t\tcolor = { 0.1 0.2 0.3 }\n\t\t\ticon = ckp_old_icon\n\t\t\treligious_head = d_ckp_old_head\n\t\t\tdoctrine = ckp_old_faith_doctrine\n\t\t\tclerical_elector_titles = { d_ckp_old_seat }\n\t\t}\n\t}\n}\n');
        put('common/religion/religion_types/ckp_new.txt', 'ckp_new_religion = {\n\treligion_details = { family = rf_ckp_new }\n\tdoctrine = ckp_new_religion_doctrine\n}\n');
        put('common/religion/faith_types/ckp_faiths.txt', [
            'ckp_sole_faith = {\n\tfaith_details = { religion = ckp_new_religion icon = ckp_sole_icon religious_head = d_ckp_new_head }\n\tdoctrines = { ckp_sole_faith_doctrine }\n\tclerical_elector_titles = { d_ckp_new_seat }\n}\n',
            'ckp_dated_faith = {\n\tfaith_details = { religion = ckp_new_religion }\n}\n',
            'ckp_stated_faith = {\n\tmain_rite = ckp_rite_stated\n\tfaith_details = { religion = ckp_new_religion }\n}\n'
        ].join(''));
        put('common/religion/rite_types/ckp_rites.txt', [
            'ckp_sole_rite = {\n\tfaith = ckp_sole_faith\n\tdoctrines = { ckp_sole_rite_doctrine }\n}\n',
            'ckp_rite_a = {\n\tfaith = ckp_dated_faith\n\tdoctrines = { ckp_doctrine_a }\n}\n',
            'ckp_rite_b = {\n\tfaith = ckp_dated_faith\n\tdoctrines = { ckp_doctrine_b }\n}\n',
            'ckp_rite_stated = {\n\tfaith = ckp_stated_faith\n\tdoctrines = { ckp_doctrine_stated }\n}\n',
            'ckp_rite_other = {\n\tfaith = ckp_stated_faith\n}\n'
        ].join(''));
        put('history/faiths/ckp_faiths.txt', 'ckp_dated_faith = {\n\t800.1.1 = { main_rite = ckp_rite_a }\n\t1066.9.15 = { main_rite = ckp_rite_b }\n}\n');
        put('common/defines/graphic/zz_ckp_frames.txt', 'NCoatOfArms = {\n\tOVERRIDE_DYNASTY_COA_FRAME_NAME = "ckp_frame"\n\tOVERRIDE_DYNASTY_COA_FRAME_OFFSET = { 0.25 0.5 }\n\tOVERRIDE_DYNASTY_COA_FRAME_SCALE = { 0.5 0.75 }\n\tOVERRIDE_REALM_MASK_ENABLED = yes\n\tOVERRIDE_REALM_MASK_OFFSET = { 0.1 0.2 }\n\tOVERRIDE_REALM_MASK_SCALE = { 0.8 0.9 }\n}\n');
        const modIdx = new GameIndex(new GameFiles(gameDir, [mod]), 'english');
        modIdx.scan();
        modIdx.fingerprint('map-check');
        await parseIndex(modIdx);
        const made = faithTable(modIdx);
        const old = made.faiths.get('ckp_old_faith');
        extra('1.19 layout (faiths nested in their religion): religion, icon, doctrines of the religion and the faith, family, head, electors', old?.religion === 'ckp_old_religion' && old.icon === 'ckp_old_icon' && old.doctrines.has('ckp_old_religion_doctrine') && old.doctrines.has('ckp_old_faith_doctrine') && made.families.get('ckp_old_religion') === 'rf_ckp_old' && made.heads.has('d_ckp_old_head') && made.electors.has('d_ckp_old_seat'), [old, made.families.get('ckp_old_religion')]);
        const sole = made.faiths.get('ckp_sole_faith');
        extra('1.20 layout (religion_details, faith_details): the religion\'s, the faith\'s and its one rite\'s doctrines, the rite apart from the others', sole?.religion === 'ckp_new_religion' && sole.mainRite === 'ckp_sole_rite' && sole.doctrines.has('ckp_new_religion_doctrine') && sole.doctrines.has('ckp_sole_faith_doctrine') && sole.doctrines.has('ckp_sole_rite_doctrine') && !sole.own.has('ckp_sole_rite_doctrine') && made.families.get('ckp_new_religion') === 'rf_ckp_new' && made.heads.has('d_ckp_new_head') && made.electors.has('d_ckp_new_seat'), [sole, made.families.get('ckp_new_religion')]);
        extra('a faith with two rites naming it and no main_rite has none in the table; a stated main_rite wins over rites naming the faith', made.faiths.get('ckp_dated_faith')?.mainRite === undefined && made.faiths.get('ckp_stated_faith')?.mainRite === 'ckp_rite_stated', [made.faiths.get('ckp_dated_faith')?.mainRite, made.faiths.get('ckp_stated_faith')?.mainRite]);
        extra('a dated main_rite (history/faiths) gives the rite and its doctrines of the date', riteHistory(modIdx).mainRiteOf('ckp_dated_faith', 9000101) === 'ckp_rite_a' && riteHistory(modIdx).mainRiteOf('ckp_dated_faith', 10660915) === 'ckp_rite_b'
            && faithHasDoctrine(modIdx, 'ckp_dated_faith', 'ckp_doctrine_a', 9000101) && !faithHasDoctrine(modIdx, 'ckp_dated_faith', 'ckp_doctrine_b', 9000101)
            && faithHasDoctrine(modIdx, 'ckp_dated_faith', 'ckp_doctrine_b', 10660915) && !faithHasDoctrine(modIdx, 'ckp_dated_faith', 'ckp_doctrine_a', 10660915)
            && faithHasDoctrine(modIdx, 'ckp_dated_faith', 'ckp_new_religion_doctrine', 10660915) && !faithHasDoctrine(modIdx, 'ckp_dated_faith', 'ckp_doctrine_a'));
        const defines = new CoaFacts(modIdx).frameDefines();
        extra('frame defines: OVERRIDE_<KIND>_COA_FRAME_* and OVERRIDE_REALM_MASK_* are read', defines.dynasty.override?.name === 'ckp_frame' && defines.dynasty.override.offset[0] === 0.25 && defines.dynasty.override.scale[1] === 0.75 && !defines.house.override && defines.realm?.offset[1] === 0.2 && defines.realm.scale[0] === 0.8, defines);

        const before = faithTable(modIdx);
        const file = put('common/religion/faith_types/ckp_late.txt', 'ckp_late_faith = {\n\tfaith_details = { religion = ckp_new_religion }\n\tclerical_elector_titles = { d_ckp_late_seat }\n}\n');
        modIdx.refreshFiles([file]);
        const after = faithTable(modIdx);
        extra('an incremental update replaces the faith table (the index object stays): the new faith and its electors show', before !== after && !before.faiths.has('ckp_late_faith') && after.faiths.get('ckp_late_faith')?.religion === 'ckp_new_religion' && after.electors.has('d_ckp_late_seat'), [after.faiths.has('ckp_late_faith'), before === after]);
        put('history/faiths/ckp_faiths.txt', 'ckp_dated_faith = {\n\t800.1.1 = { main_rite = ckp_rite_a }\n\t1000.1.1 = { main_rite = ckp_rite_b }\n}\n');
        modIdx.refreshFiles([join(root, 'history/faiths/ckp_faiths.txt')]);
        extra('and the rite history: a changed date of a main_rite shows after the update', riteHistory(modIdx).mainRiteOf('ckp_dated_faith', 10000101) === 'ckp_rite_b' && riteHistory(modIdx).mainRiteOf('ckp_dated_faith', 9990101) === 'ckp_rite_a', riteHistory(modIdx).mainRiteOf('ckp_dated_faith', 10000101));
    }
    finally
    {
        rmSync(tmp, { recursive: true, force: true });
    }
}

// scrubbing: a year sweep over the range, twice (the second pass: holders read), the worker's part per date (the
// last dates are kept: each date is new here)
const { from, to } = stat.range;

for (const pass of [1, 2])
{
    const ms: number[] = [];

    for (let y = from; y <= to; y += Math.max(1, Math.round((to - from) / 40)))
    {
        t = performance.now();
        md.dated(meta, `${y}.1.${pass}`);
        ms.push(performance.now() - t);
    }

    console.log(`sweep ${from}–${to} (${ms.length} dates, pass ${pass}): mean ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)} ms, max ${Math.round(Math.max(...ms))} ms`);
}

console.log(`
${checks.length + extras - failed}/${checks.length + extras} checks passed`);
process.exit(failed ? 1 : 0);
