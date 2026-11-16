// Entries with an icon are shown with it (docs/app-architecture.md, "Icons"): drives the built app (scripts/drive.mjs)
// through the places that list game entries (the entry lists of types with icons, the entry picker (pickEntry), the
// statement picker's entry values, Settings → Characters) and checks every row marked `data-entity="type:name"` whose
// entry has an icon (api.list) shows it (a ck3://img picture in the row). Prints each place's count and the rows
// without their icon; exits 1 when there are any.
// Usage: npm run build && node scripts/icon-check.mjs   (CRUSADERPOPE_USER_DATA=<dir>: own settings; SHOW=1 shows the window)
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** the in-page check: marked rows, their entries' icons from api.list (per type, once), the rows lacking theirs */
const CHECK = (place, scope) => `(async () => {
  window.__iconLists ??= {};
  const rows = [...(document.querySelector('${scope}')?.querySelectorAll('[data-entity]') ?? [])].filter((r) => r.offsetParent !== null);
  const bad = [];
  let withIcon = 0;
  for (const r of rows) {
    const v = r.getAttribute('data-entity');
    const at = v.indexOf(':');
    const type = v.slice(0, at), name = v.slice(at + 1);
    const list = (window.__iconLists[type] ??= new Map((await window.api.list(type)).map((e) => [e.name, e.icon])));
    const icon = list.get(name);
    if (!icon) continue;
    withIcon++;
    if (!r.querySelector('img[src^="ck3://img"]')) bad.push(v);
  }
  return 'ICON-CHECK ${place}: ' + rows.length + ' rows, ' + withIcon + ' with an icon, ' + bad.length + ' without it' + (bad.length ? ': ' + bad.slice(0, 12).join(', ') : '');
})()`;

const steps = [
    { viewport: [1400, 900] },
    // entry lists of types with icons
    ...['traits', 'faith', 'religion/doctrine_types', 'lifestyle_perks', 'modifiers'].flatMap((t) => [{ goto: t, timeout: 400000, settle: 2500 }, { eval: CHECK(`list ${t}`, '.entity-list') }]),
    // the entry picker (a preset's trait, culture, faith)
    ...['traits', 'faith'].flatMap((t) => [
        { eval: `(() => { void window.__pickEntry('${t}', 'icon check', { x: 300, y: 80 }); return 'opened'; })()` },
        { wait: 2500 },
        { eval: CHECK(`pickEntry ${t}`, '.pk-layer') },
        { press: 'Escape' }
    ]),
    // the statement picker's entry values (a character's trait)
    { eval: `(() => { void window.__pickStatement({ kind: 'field', type: 'character_history', field: 'trait', once: true, at: { x: 300, y: 80 } }); return 'opened'; })()` },
    { wait: 2500 },
    { eval: CHECK('statement picker: trait', '.pk-layer') },
    { press: 'Escape' },
    // Settings → Characters (a preset's traits as chips)
    { goto: '@settings', timeout: 400000, settle: 1500 },
    { eval: `(() => { [...document.querySelectorAll('button')].find((x) => x.textContent === 'Characters')?.click(); return 'ok'; })()` },
    { wait: 800 },
    { eval: `(() => { [...document.querySelectorAll('.preset-list button')].find((x) => x.textContent === 'Warrior')?.click(); return 'ok'; })()` },
    { wait: 1500 },
    { eval: CHECK('settings: preset traits', '.preset-edit') }
];

const r = spawnSync(process.execPath, [join(HERE, 'drive.mjs')], { env: { ...process.env, STEPS: JSON.stringify(steps) }, encoding: 'utf8', maxBuffer: 64 << 20 });
const lines = (r.stdout ?? '').split('\n').filter((l) => l.includes('ICON-CHECK'));
let failed = 0;

for (const l of lines)
{
    const text = JSON.parse(l.slice(l.indexOf('"')));
    console.log(text.replace('ICON-CHECK ', ''));

    if (!/ 0 without it/.test(text))
        failed++;
}

if (!lines.length)
{
    console.log(r.stdout, r.stderr);
    failed = 1;
}

console.log(failed ? `${failed} places with entries shown without their icon` : 'all entries with an icon show it');
process.exitCode = failed ? 1 : 0;
