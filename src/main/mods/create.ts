/**
 * New entries the statement picker's result needs (docs/picker.md, "New entries"), made in the active mod before the
 * statement is written:
 * - a new opinion modifier: appended to the mod's `common/opinion_modifiers/<mod>_opinion_modifiers.txt` (created
 *   with a byte order mark and a header), its name in the mod's `localization/<lang>/<mod>_l_<lang>.yml` (the key is
 *   the modifier's key, as the game names opinion modifiers);
 * - a new doctrine parameter: `<key> = yes` in the `parameters` of the doctrine that turns it on — the doctrine is
 *   overridden in the mod first when it is not the mod's already (its whole group, "Override in"), a missing
 *   `parameters` block is created — and its sentence as `doctrine_parameter_<key>` in the loc file.
 * - without the picker (the faith cards' placeholders, docs/readable-view.md): a localization text (`loc`); a new faith
 *   in a religion of the mod (`faith`: `<key> = { }` into its `faiths`, the block made when missing; its name); a
 *   doctrine put into a doctrine group (`doctrine_group_member`: into the group's `doctrine_types` — the group
 *   overridden in the mod first when it is the game's); a term of a faith or religion of the mod (`term`:
 *   `HighGodName = <owner>_high_god_name` into its `localization`, the block made when missing, and the text).
 * Also a brand-new entry of a type (the explorer's type list: right click → "New <type>…"): a template definition in
 * the mod's `<folder>/<mod>_<folder>.txt` (events: with their namespace line) and its localization.
 * Plain Node (scripts use it too).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DuplicateEntryRequest, DuplicateRequest, EntityDetail, EntryCreate, NewEntryPlan, NewEntryRequest, NewEntryResult } from '../../shared/api.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { descriptionCandidates, displayNameCandidates } from '../indexer/schema.ts';
import { eolOf, type OverrideSource } from '../indexer/override.ts';
import { activeMod, applyOverride, fileTag, hiddenProblem, lineAfter, modPath, write, type Active } from './edit.ts';
import { applyEdit } from './scriptEdit.ts';
import type { ModsHost } from './manager.ts';
import { change, describeChange } from './undo.ts';

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** A text file of the mod: its text without byte order mark (null when missing). */
function readText(file: string): { text: string; bom: boolean; } | null
{
    if (!existsSync(file))
        return null;

    const all = readFileSync(file, 'utf8');
    const bom = all.charCodeAt(0) === 0xfeff;
    return { text: bom ? all.slice(1) : all, bom };
}

/** Appends a block to a file of the mod (made when missing: BOM, header comment). */
function appendDefinition(host: ModsHost, a: Active, rel: string, block: string, header: string): string
{
    const abs = modPath(a, rel);

    if (!abs)
        throw new Error(`${rel} is not a path inside the mod folder.`);

    const cur = readText(abs);
    const eol = cur ? eolOf(cur.text) : '\n';
    const body = cur ? cur.text.replace(/\s*$/, '') + eol + eol : `# ${header}` + eol + eol;
    write(host, abs, '﻿' + body + block.replace(/\n/g, eol) + eol);
    return abs;
}

/** Adds (or replaces) localization keys in the mod's loc file of the language. */
function writeLoc(host: ModsHost, a: Active, lang: string, entries: [string, string][]): string | undefined
{
    if (!entries.length)
        return undefined;

    const rel = `localization/${lang}/${fileTag(a)}_l_${lang}.yml`;
    const abs = modPath(a, rel);

    if (!abs)
        throw new Error(`${rel} is not a path inside the mod folder.`);

    const cur = readText(abs);
    const eol = cur ? eolOf(cur.text) : '\n';
    let lines = cur ? cur.text.split(/\r?\n/) : [`l_${lang}:`];

    while (lines.length && !lines[lines.length - 1].trim())
        lines.pop();

    for (const [key, text] of entries)
    {
        const line = ` ${key}:0 "${text.replace(/"/g, "'")}"`;
        const i = lines.findIndex((l) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(l));

        if (i >= 0)
            lines[i] = line;
        else
            lines = [...lines, line];
    }

    write(host, abs, '﻿' + lines.join(eol) + eol);
    return abs;
}

const humanize = (key: string): string =>
{
    const t = key.replace(/_opinion$/, '')
        .replace(/_/g, ' ')
        .trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
};

/** The doctrine's node in a parsed file: `group = { <doctrine> = { … } }` (or at the top). */
function findDoctrine(nodes: PNode[], name: string): PNode | undefined
{
    for (const n of nodes)
    {
        if (!Array.isArray(n.v))
            continue;

        if (n.k === name)
            return n;

        const inner = n.v.find((c) => c.k === name && Array.isArray(c.v));

        if (inner)
            return inner;
    }

    return undefined;
}

/** `<key> = yes` into the doctrine's `parameters` (the block made when missing). */
async function addDoctrineParameter(host: ModsHost, a: Active, key: string, doctrine: string): Promise<string>
{
    const r = await applyOverride(host, { type: 'religion/doctrine_types', name: doctrine, mode: 'copy' });
    const cur = readText(r.file);

    if (!cur)
        throw new Error(`${r.rel} could not be read.`);

    const node = findDoctrine(parse(cur.text), doctrine);

    if (!node || !Array.isArray(node.v))
        throw new Error(`The doctrine “${doctrine}” was not found in ${r.rel}.`);

    const params = node.v.find((c) => c.k === 'parameters' && Array.isArray(c.v));

    if (params && Array.isArray(params.v) && params.v.some((c) => c.k === key))
        return r.file;

    const block = params ?? node;
    const at = { file: r.file, rel: r.rel, line: block.line, s: block.s, e: block.e, inner: [block.vs + 1, block.e - 1] as [number, number], kind: 'other' as const, hash: '' };
    const out = applyEdit(cur.text, { op: 'insert', at, where: 'inside', text: params ? `${key} = yes` : `parameters = {\n\t${key} = yes\n}` });
    write(host, r.file, (cur.bom ? '﻿' : '') + out.text);
    return r.file;
}

/** A node spanning exactly [s, e) of a parsed file (a definition — a faith nested in its religion too). */
function nodeAt(nodes: PNode[], s: number, e: number): PNode | undefined
{
    for (const n of nodes)
    {
        if (n.s === s && n.e === e)
            return n;

        if (Array.isArray(n.v) && n.s <= s && e <= n.e)
        {
            const hit = nodeAt(n.v, s, e);

            if (hit)
                return hit;
        }
    }

    return undefined;
}

interface ModDef
{
    file: string;
    rel: string;
    text: string;
    bom: boolean;
    node: PNode;
}

/** The active mod's definition of an entry (its winning one): its file, text and node. */
async function modDefinition(host: ModsHost, a: Active, type: string, name: string): Promise<ModDef>
{
    const detail = await host.query<EntityDetail | null>?.('detail', type, name);
    const src = detail && [...detail.defs].reverse().find((d) => !d.origin?.hiddenBy)?.src;

    if (!src || src.mod?.toLowerCase() !== a.mod.id.toLowerCase())
        throw new Error(`${name} is not written in ${a.mod.name}.`);

    const cur = readText(src.file);

    if (!cur)
        throw new Error(`${src.rel} could not be read.`);

    const node = nodeAt(parse(cur.text), src.s, src.e);

    if (!node || !Array.isArray(node.v))
        throw new Error(`${name} was not found in ${src.rel} — changed since the explorer read it?`);

    return { file: src.file, rel: src.rel, text: cur.text, bom: cur.bom, node };
}

/** Writes `text` into a block of the definition's file: at its end, or right before `before` (a statement in it). */
function insertInto(host: ModsHost, def: ModDef, block: PNode, text: string, before?: PNode): void
{
    const n = before ?? block;
    const at = { file: def.file, rel: def.rel, line: n.line, s: n.s, e: n.e, inner: [block.vs + 1, block.e - 1] as [number, number], kind: 'other' as const, hash: '' };
    const out = applyEdit(def.text, before ? { op: 'insert', at, where: 'before', text } : { op: 'insert', at, where: 'inside', text });
    write(host, def.file, (def.bom ? '﻿' : '') + out.text);
}

/** `HighGodName` → `high_god_name` */
const snake = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Makes the entries (see the file comment) and hands the files to the index — one undo step, all or nothing: a batch that
 * fails takes back what it wrote (undo.ts `rollback`). Inside a statement's edit (ScriptEditRequest.creates) its entries
 * join the statement's step.
 */
export function createEntries(host: ModsHost, creates: EntryCreate[]): Promise<{ files: string[]; notes: string[]; step?: number; }>
{
    return change(host, `New ${creates.map((c) => c.key).join(', ')}`, 'create', () => makeEntries(host, creates), { rollback: true });
}

async function makeEntries(host: ModsHost, creates: EntryCreate[]): Promise<{ files: string[]; notes: string[]; }>
{
    const a = await activeMod(host);

    if (typeof a === 'string')
        throw new Error(a);

    const lang = host.settings().language || 'english';
    const files = new Set<string>();
    const loc: [string, string][] = [];
    const notes: string[] = [];

    for (const c of creates)
    {
        if (!KEY.test(c.key))
            throw new Error(`“${c.key}” is no valid key (letters, digits and _ only).`);

        const field = (k: string): string | undefined => c.fields.find(([x]) => x === k)?.[1];

        // a new entry of any type (the picker's "＋ New trait…"): its template, as "New <type>…" writes it
        if (c.what === 'entry')
        {
            const type = field('type');

            if (!type)
                throw new Error(`Which type is the new “${c.key}”?`);

            const r = await createEntry(host, { type, key: c.key, name: c.loc || undefined }, { files });
            notes.push(`New ${r.type.replace(/^.*\//, '').replace(/s$/, '').replace(/_/g, ' ')} “${c.key}” in ${r.rel}`);
            continue;
        }

        if (c.what === 'loc')
        {
            loc.push([c.key, c.loc ?? '']);
            continue;
        }

        if (c.what === 'faith')
        {
            const religion = field('religion');

            if (!religion)
                throw new Error(`The new faith “${c.key}” needs its religion.`);

            if (await host.query?.('detail', 'faith', c.key))
                throw new Error(`A faith “${c.key}” exists already.`);

            const def = await modDefinition(host, a, 'religion/religion_types', religion);
            const faiths = (def.node.v as PNode[]).find((x) => x.k === 'faiths' && Array.isArray(x.v));

            // (empty: the faith's card shows what it needs — colour, icon, tenets, doctrines, holy sites — to fill in)
            if (faiths)
                insertInto(host, def, faiths, `${c.key} = {\n}`);
            else
                insertInto(host, def, def.node, `faiths = {\n\t${c.key} = {\n\t}\n}`);

            files.add(def.file);
            loc.push([c.key, c.loc || humanize(c.key)]);
            notes.push(`New faith “${c.key}” in ${religion}`);
            continue;
        }

        if (c.what === 'doctrine_group_member')
        {
            const group = field('group');

            if (!group)
                throw new Error(`Which group should “${c.key}” go into?`);

            const r = await applyOverride(host, { type: 'religion/doctrine_group_types', name: group, mode: 'copy' });
            const cur = readText(r.file);

            if (!cur)
                throw new Error(`${r.rel} could not be read.`);

            const node = parse(cur.text).find((n) => n.k === group && Array.isArray(n.v));

            if (!node)
                throw new Error(`The doctrine group “${group}” was not found in ${r.rel}.`);

            const list = (node.v as PNode[]).find((x) => x.k === 'doctrine_types' && Array.isArray(x.v));
            const def = { file: r.file, rel: r.rel, text: cur.text, bom: cur.bom, node };

            if (!list || !(list.v as PNode[]).some((x) => x.v === c.key))
                insertInto(host, def, list ?? node, list ? c.key : `doctrine_types = {\n\t${c.key}\n}`);

            files.add(r.file);
            notes.push(`${c.key} is now in the doctrine group ${group}`);
            continue;
        }

        if (c.what === 'term')
        {
            const type = field('type');
            const owner = field('owner');

            if (!type || !owner || !/^[A-Za-z]\w*$/.test(c.key))
                throw new Error('Which term, of what?');

            const def = await modDefinition(host, a, type, owner);
            const body = def.node.v as PNode[];
            const block = body.find((x) => x.k === 'localization' && Array.isArray(x.v));
            const written = block && (block.v as PNode[]).find((x) => x.k === c.key);
            // (a key of its own: another faith's text is never changed)
            const own = typeof written?.v === 'string' && written.v.startsWith(owner + '_') ? written.v : `${owner}_${snake(c.key)}`;

            if (!written)
            {
                if (block)
                    insertInto(host, def, block, `${c.key} = ${own}`);
                else
                {
                    // (a religion: before its faiths, like the game's)
                    const faiths = type === 'religion/religion_types' ? body.find((x) => x.k === 'faiths') : undefined;
                    insertInto(host, def, def.node, `localization = {\n\t${c.key} = ${own}\n}`, faiths);
                }
            }
            else if (written.v !== own)
            {
                const at = { file: def.file, rel: def.rel, line: written.line, s: written.s, e: written.e, kind: 'other' as const, hash: '' };
                const out = applyEdit(def.text, { op: 'replace', at, text: `${c.key} = ${own}` });
                write(host, def.file, (def.bom ? '﻿' : '') + out.text);
            }

            files.add(def.file);
            loc.push([own, c.loc ?? '']);
            notes.push(`${c.key} of ${owner}: ${own}`);
            continue;
        }

        if (c.what === 'opinion_modifiers')
        {
            if (await host.query?.('detail', 'opinion_modifiers', c.key))
                throw new Error(`An opinion modifier “${c.key}” exists already.`);

            const block = [`${c.key} = {`, ...c.fields.map(([k, v]) => `\t${k} = ${v}`), '}'].join('\n');
            files.add(appendDefinition(host, a, `common/opinion_modifiers/${fileTag(a)}_opinion_modifiers.txt`, block, `${a.mod.name}: new opinion modifiers (written by CrusaderPope)`));
            loc.push([c.key, c.loc || humanize(c.key)]);
            notes.push(`New opinion modifier “${c.key}”`);
        }
        else
        {
            const doctrine = c.fields.find(([k]) => k === 'doctrine')?.[1];

            if (!doctrine)
                throw new Error(`The new parameter “${c.key}” needs a doctrine that sets it.`);

            files.add(await addDoctrineParameter(host, a, c.key, doctrine));
            loc.push([`doctrine_parameter_${c.key}`, c.loc || humanize(c.key)]);
            notes.push(`New doctrine parameter “${c.key}”, set by ${doctrine}`);
        }
    }

    const locFile = writeLoc(host, a, lang, loc);

    if (locFile)
        files.add(locFile);

    if (host.refreshFiles)
        await host.refreshFiles([...files]);
    else
        host.reindex();

    return { files: [...files], notes };
}

// ---------------------------------------------------------------------------
// A brand-new entry of a type (the explorer's type list: right click → "New <type>…")
// ---------------------------------------------------------------------------

/** A new definition's text and its localization, per type (the rest: an empty block, its name as `<key>`). */
const TEMPLATES: Record<string, (key: string, name: string) => { text: string; loc: [string, string][]; }> = {
    traits: (k, n) => ({ text: `${k} = {\n\tcategory = personality\n}`, loc: [[`trait_${k}`, n], [`trait_${k}_desc`, '']] }),
    opinion_modifiers: (k, n) => ({ text: `${k} = {\n\topinion = 10\n}`, loc: [[k, n]] }),
    modifiers: (k, n) => ({ text: `${k} = {\n}`, loc: [[k, n], [`${k}_desc`, '']] }),
    events: (k, n) => ({
        text: `${k} = {\n\ttype = character_event\n\ttitle = ${k}.t\n\tdesc = ${k}.desc\n\ttheme = default\n\tleft_portrait = root\n\n\toption = {\n\t\tname = ${k}.a\n\t}\n}`,
        loc: [[`${k}.t`, n], [`${k}.desc`, ''], [`${k}.a`, 'OK']]
    }),
    decisions: (k, n) => ({
        text: `${k} = {\n\tpicture = {\n\t\treference = "gfx/interface/illustrations/decisions/decision_misc.dds"\n\t}\n\tdesc = ${k}_desc\n\tselection_tooltip = ${k}_tooltip\n\n\tis_shown = {\n\t}\n\tis_valid = {\n\t}\n\teffect = {\n\t}\n\tai_check_interval = 0\n}`,
        loc: [[k, n], [`${k}_desc`, ''], [`${k}_tooltip`, ''], [`${k}_confirm`, n]]
    }),
    character_interactions: (k, n) => ({
        text: `${k} = {\n\tcategory = interaction_category_friendly\n\tdesc = ${k}_desc\n\n\tis_shown = {\n\t}\n\ton_accept = {\n\t}\n\tauto_accept = yes\n}`,
        loc: [[k, n], [`${k}_desc`, '']]
    }),
    scripted_effects: (k) => ({ text: `${k} = {\n}`, loc: [] }),
    scripted_triggers: (k) => ({ text: `${k} = {\n\talways = yes\n}`, loc: [] }),
    script_values: (k) => ({ text: `${k} = {\n\tvalue = 0\n}`, loc: [] }),
    scripted_modifiers: (k) => ({ text: `${k} = {\n}`, loc: [] }),
    on_action: (k) => ({ text: `${k} = {\n\teffect = {\n\t}\n}`, loc: [] }),
    // (a doctrine's name and description are `<key>_name` / `_desc`; it still needs a doctrine group — its card says so)
    'religion/doctrine_types': (k, n) => ({ text: `${k} = {\n}`, loc: [[`${k}_name`, n], [`${k}_desc`, '']] }),
    // (its card shows the rest to fill in: family, faiths, names …)
    'religion/religion_types': (k, n) => ({ text: `${k} = {\n}`, loc: [[k, n]] })
};

const templateOf = (type: string): (key: string, name: string) => { text: string; loc: [string, string][]; } => TEMPLATES[type] ?? ((k, n) => ({ text: `${k} = {\n}`, loc: n ? [[k, n]] : [] }));

/** Types a name in game makes no sense for (script only). */
const NAMELESS = new Set(['scripted_effects', 'scripted_triggers', 'script_values', 'scripted_modifiers', 'on_action']);

interface EntryInfo
{
    folder?: string;
    nested: boolean;
    label: string;
    count: number;
    freeId?: string;
    example?: { name: string; holder: string; holderType?: string; holderLabel?: string; within: string[]; rel: string; line: number; };
}

/** Where a new entry of the type would go in the active mod, or why it can't be made. */
/** "Law Groups" → "law group". */
function singularOf(label: string): string
{
    const l = label.toLowerCase();
    return l.endsWith('ies') ? l.slice(0, -3) + 'y' : l.replace(/s$/, '');
}

export async function newEntryPlan(host: ModsHost, type: string): Promise<NewEntryPlan>
{
    const a = await activeMod(host);
    const info = await host.query<EntryInfo | null>?.('newEntryInfo', type, typeof a === 'string' ? undefined : fileTag(a));
    const label = info?.label ?? type;

    if (typeof a === 'string')
        return { type, label, problem: a, name: false };

    if (!info?.folder)
        return { type, label, problem: `New ${label.toLowerCase()} can't be made here (they are no script definitions of their own).`, name: false };

    // (written inside other definitions: the wizard — which holder, or a new one — when the holder's type is known)
    if (info.nested && info.example?.holderType)
    {
        const x = info.example;
        const hinfo = await host.query<EntryInfo | null>?.('newEntryInfo', x.holderType);
        return {
            type,
            label,
            mod: a.mod.name,
            name: !NAMELESS.has(type),
            nested: { holderType: x.holderType!, holderLabel: x.holderLabel ?? x.holderType!, within: x.within, newHolder: !!hinfo?.folder && !hinfo.nested }
        };
    }

    if (info.nested)
    {
        // (said with a real one: where it sits, and how to add one there)
        const x = info.example;
        const holder = x?.holderLabel ? singularOf(x.holderLabel) : 'the definition holding it';
        const where = x ? ` — e.g. ${x.name} is a block inside ${x.holderLabel ? `the ${holder} ` : ''}${x.holder} (${x.rel}, line ${x.line})` : '';
        return {
            type,
            label,
            problem: `${label} are not written on their own: each is a block inside another definition${where}, so there is no file to add a new one to by itself. To make one: open that ${holder}, override it into ${a.mod.name} (“Override” ▾) and add the new block inside it on its Source tab (“✎ Edit”).`,
            name: false
        };
    }

    const rel = `${info.folder}/${fileTag(a)}_${basename(info.folder)}.txt`;
    // (a later mod's replace_path over the folder: the new file would not load)
    const hidden = hiddenProblem(a, info.folder);

    if (hidden)
        return { type, label, problem: hidden, name: false };

    return { type, label, mod: a.mod.name, rel, key: type === 'events' ? info.freeId : undefined, name: !NAMELESS.has(type) };
}

/**
 * Writes a new entry into the active mod (the plan's file; events: its namespace line), with its localization — one undo
 * step (joined by a batch: createEntries). `files`: a batch collects the files written (it hands them to the index itself).
 */
export function createEntry(host: ModsHost, req: NewEntryRequest, opts: { files?: Set<string>; } = {}): Promise<NewEntryResult>
{
    return change(host, `New ${req.key.trim()}`, 'create', async () =>
    {
        const r = await newEntry(host, req, opts);
        describeChange({ line: r.line });
        return r;
    });
}

async function newEntry(host: ModsHost, req: NewEntryRequest, opts: { files?: Set<string>; }): Promise<NewEntryResult>
{
    const a = await activeMod(host);

    if (typeof a === 'string')
        throw new Error(a);

    const plan = await newEntryPlan(host, req.type);

    if (plan.nested && !plan.problem)
        return createNested(host, a, req.type, plan.nested, req);

    if (plan.problem || !plan.rel)
        throw new Error(plan.problem ?? 'Nothing to make.');

    const key = req.key.trim();

    if (!(req.type === 'events' ? /^[A-Za-z_][\w-]*\.\d+$/ : KEY).test(key))
        throw new Error(req.type === 'events' ? `“${key}” is no event id (namespace.number, e.g. ${fileTag(a)}.0001).` : `“${key}” is no valid key (letters, digits and _ only).`);

    if (await host.query?.('detail', req.type, key))
        throw new Error(`A ${plan.label.toLowerCase().replace(/s$/, '')} “${key}” exists already.`);

    const t = templateOf(req.type)(key, req.name?.trim() || humanize(key.replace(/^.*\./, '')));
    const abs = modPath(a, plan.rel)!;
    let line = 1;
    {
        const cur = readText(abs);
        const eol = cur ? eolOf(cur.text) : '\n';
        let body = cur ? cur.text.replace(/\s*$/, '') : `# ${a.mod.name}: new ${plan.label.toLowerCase()} (written by CrusaderPope)`;

        // an event needs its namespace declared in its file
        if (req.type === 'events')
        {
            const ns = key.slice(0, key.lastIndexOf('.'));

            if (!new RegExp(`^\\s*namespace\\s*=\\s*${ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(body))
                body += eol + eol + `namespace = ${ns}`;
        }

        const text = body + eol + eol + t.text.replace(/\n/g, eol) + eol;
        line = lineAfter('﻿' + text, write(host, abs, '﻿' + text), text.split(/\r?\n/).length - t.text.split('\n').length);
    }
    const files = [abs];
    const locFile = writeLoc(host, a, host.settings().language || 'english', t.loc);

    if (locFile)
        files.push(locFile);

    if (opts.files)
        files.forEach((f) => opts.files!.add(f));
    else if (host.refreshFiles)
        await host.refreshFiles(files);
    else
        host.reindex();

    return { type: req.type, key, mod: a.mod.name, file: abs, rel: plan.rel, line, loaded: a.loaded };
}

/** The mod's events file declaring a namespace (`namespace = x`), if any. */
function namespaceFile(a: Active, ns: string): string | undefined
{
    const root = modPath(a, 'events');
    const re = new RegExp(`^\\s*namespace\\s*=\\s*${ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
    const walk = (dir: string): string | undefined =>
    {
        if (!existsSync(dir))
            return undefined;

        for (const d of readdirSync(dir, { withFileTypes: true }))
        {
            const p = join(dir, d.name);
            const hit = d.isDirectory() ? walk(p) : /\.txt$/i.test(d.name) && re.test(readText(p)?.text ?? '') ? p : undefined;

            if (hit)
                return hit;
        }

        return undefined;
    };
    return root ? walk(root) : undefined;
}

/**
 * Duplicates an event under a new id into the active mod (docs/mods.md, "Duplicating an event"): its definition as
 * written, with every mention of its id renamed — its own texts' keys (`court.8190.t` → `<new>.t`), self-references —
 * and those texts copied under the new keys into the mod's loc file (`title`: the copy's title instead); the file-local
 * scripted triggers / effects and @constants it uses go along when the file lacks them. It goes into the mod's events
 * file declaring the new id's namespace, else the mod's events file (the namespace line added).
 */
export function duplicateEvent(host: ModsHost, req: DuplicateRequest): Promise<NewEntryResult>
{
    return change(host, `${req.source} duplicated as ${req.key.trim()}`, 'create', async () =>
    {
        const r = await copyEvent(host, req);
        describeChange({ line: r.line });
        return r;
    });
}

async function copyEvent(host: ModsHost, req: DuplicateRequest): Promise<NewEntryResult>
{
    const a = await activeMod(host);

    if (typeof a === 'string')
        throw new Error(a);

    const key = req.key.trim();

    if (!/^[A-Za-z_][\w-]*\.\d+$/.test(key))
        throw new Error(`“${key}” is no event id (namespace.number, e.g. ${fileTag(a)}.0001).`);

    if (key === req.source || (await host.query?.('detail', 'events', key)))
        throw new Error(`An event “${key}” exists already.`);

    const src = await host.query<OverrideSource | null>?.('overrideSource', 'events', req.source, a.mod.id);

    if (!src?.copy)
        throw new Error(src?.copyProblem ?? `${req.source} has no definition to copy.`);

    const copy = src.copy;
    const esc = req.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const original = copy.text.slice(copy.at);
    // (its own texts: keys that are its id + ".something")
    const ownKeys = [...new Set([...original.matchAll(new RegExp(`(?<![\\w.])${esc}\\.[\\w.-]*\\w`, 'g'))].map((m) => m[0]))];
    const titleKey = /^\s*title\s*=\s*([\w.-]+)\s*$/m.exec(original)?.[1];
    const text = original.replace(new RegExp(`(?<![\\w.])${esc}(?![\\w-])`, 'g'), key);
    const ns = key.slice(0, key.lastIndexOf('.'));
    let abs = namespaceFile(a, ns);

    if (!abs)
    {
        const plan = await newEntryPlan(host, 'events');

        if (plan.problem || !plan.rel)
            throw new Error(plan.problem ?? 'The mod has no events file to write into.');

        abs = modPath(a, plan.rel);
    }

    if (!abs)
        throw new Error('The mod has no events folder to write into.');

    const cur = readText(abs);
    const eol = cur ? eolOf(cur.text) : '\n';
    let body = cur ? cur.text.replace(/\s*$/, '') : `# ${a.mod.name}: events (written by CrusaderPope)`;

    if (!new RegExp(`^\\s*namespace\\s*=\\s*${ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(body))
        body += eol + eol + `namespace = ${ns}`;

    // (what the event uses from its file: @constants, file-local scripted triggers / effects — when this file lacks them)
    const carried = [...copy.constants, ...copy.locals].filter((c) => !new RegExp(`^\\s*(scripted_(trigger|effect)\\s+)?@?${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'm').test(body));

    for (const c of carried)
        body += eol + eol + c.text.replace(/\r?\n/g, eol);

    body += eol + eol + `# Duplicated from ${req.source} (written by CrusaderPope)` + eol;
    const line = body.split(/\r?\n/).length;
    body += text.replace(/\r?\n/g, eol) + eol;
    const at = lineAfter('﻿' + body, write(host, abs, '﻿' + body), line);
    // its texts under the new keys
    const entries: [string, string][] = [];

    for (const k of ownKeys)
    {
        const nk = key + k.slice(req.source.length);
        const t = k === titleKey && req.title?.trim() ? req.title.trim() : ((await host.query<{ text?: string; } | null>?.('locEntry', k))?.text ?? '');
        entries.push([nk, t]);
    }

    const files = [abs];
    const locFile = writeLoc(host, a, host.settings().language || 'english', entries);

    if (locFile)
        files.push(locFile);

    if (host.refreshFiles)
        await host.refreshFiles(files);
    else
        host.reindex();

    const rel = abs.slice(a.root.length + 1).replace(/\\/g, '/');
    return { type: 'events', key, mod: a.mod.name, file: abs, rel, line: at, loaded: a.loaded };
}

/**
 * Duplicates an entry of any type under a new key into the active mod (docs/mods.md, "Duplicating an entry"); events
 * go through duplicateEvent. The winning definition is copied as written (`overrideSource`'s copy: the same refusals)
 * with its key renamed and every value that names the entry itself (`has_trait = <it>`) — other keys holding the name
 * stay. Its texts go along under new keys: the display-name and description keys the game looks up for the type
 * (displayNameCandidates, descriptionCandidates) and the keys it names in its text — each with the entry's name
 * replaced by the new key (`trait_brave_desc` → `trait_bold_desc`); the name in game replaced when one is given. The
 * copy is appended to the file new entries of the type go to (newEntryPlan: types written inside other definitions
 * are refused), with the file-local @constants and scripted triggers / effects it uses.
 */
export function duplicateEntry(host: ModsHost, req: DuplicateEntryRequest): Promise<NewEntryResult>
{
    if (req.type === 'events')
        return duplicateEvent(host, { source: req.source, key: req.key, title: req.name });

    return change(host, `${req.source} duplicated as ${req.key.trim()}`, 'create', async () =>
    {
        const r = await copyEntry(host, req);
        describeChange({ line: r.line });
        return r;
    });
}

async function copyEntry(host: ModsHost, req: DuplicateEntryRequest): Promise<NewEntryResult>
{
    const a = await activeMod(host);

    if (typeof a === 'string')
        throw new Error(a);

    const plan = await newEntryPlan(host, req.type);

    // (a nested type has no file of its own: its copy goes into the holder — below)
    if (plan.problem || (!plan.rel && !plan.nested))
        throw new Error(plan.problem ?? 'Nothing to make.');

    const key = req.key.trim();

    if (!KEY.test(key))
        throw new Error(`“${key}” is no valid key (letters, digits and _ only).`);

    if (key === req.source || (await host.query?.('detail', req.type, key)))
        throw new Error(`A ${plan.label.toLowerCase().replace(/s$/, '')} “${key}” exists already.`);

    const src = await host.query<OverrideSource | null>?.('overrideSource', req.type, req.source, a.mod.id);

    if (!src?.copy)
        throw new Error(src?.copyProblem ?? `${req.source} has no definition to copy.`);

    // (written inside another definition: a copy next to it, in the holder — copied into the mod when needed; a landed
    // title: its own block, without its vassals, inside empty blocks of its lieges — below)
    if (src.container && !src.path)
    {
        if (!plan.nested)
            throw new Error(`${req.source} is written inside ${src.container.name}: it is not copied alone.`);

        return createNested(host, a, req.type, { ...plan.nested, holderType: src.container.type }, { type: req.type, key, name: req.name, holder: src.container.name, from: req.source });
    }

    if (!plan.rel)
        throw new Error('Nothing to make.');

    const copy = src.copy;
    // (a landed title in its lieges: its own block — the lieges' empty blocks are written around the renamed one)
    const original = src.path ? copy.text.slice(copy.at, copy.end) : copy.text.slice(copy.at);
    const esc = req.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // (the name inside a key: bounded by the key's start / end or a separator)
    const inKey = new RegExp(`(^|[_.])${esc}($|[_.])`);
    const renameKey = (k: string): string => k.replace(inKey, (_m, p: string, q: string) => p + key + q);
    const locOf = async (k: string): Promise<string | undefined> =>
    {
        const e = await host.query<{ text?: string; rel?: string; } | null>?.('locEntry', k);
        return e?.rel !== undefined ? (e.text ?? '') : undefined;
    };
    // its texts: the name key the game uses for the type (the first that exists), its description keys, and keys its
    // text names that hold its name
    const nameKeys = displayNameCandidates(req.type, req.source);
    let nameKey: string | undefined;

    for (const k of nameKeys)
    {
        if ((await locOf(k)) !== undefined)
        {
            nameKey = k;
            break;
        }
    }

    const candidates = [...(nameKey ? [nameKey] : []), ...descriptionCandidates(req.type, req.source), ...[...original.matchAll(/(?<![\w.$@-])[A-Za-z_][\w.-]*\w/g)].map((m) => m[0]).filter((k) => k !== req.source && inKey.test(k))];
    const texts = new Map<string, string>();

    for (const k of new Set(candidates))
    {
        const t = await locOf(k);

        if (t !== undefined)
            texts.set(k, t);
    }

    // the definition: its key, the texts' keys it names, values naming the entry itself (the plain name as a text key
    // is its name, not a mention: its self-references are those values)
    let text = original.replace(new RegExp(`^(\\s*)${esc}(?=\\s*=)`), (_m, ws: string) => ws + key);

    for (const k of [...texts.keys()].filter((x) => x !== req.source))
        text = text.replace(new RegExp(`(?<![\\w.-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g'), renameKey(k));

    text = text.replace(new RegExp(`(=\\s*)${esc}(?![\\w.-])`, 'g'), (_m, p: string) => p + key);

    // (the game merges a title written again: the lieges' empty blocks give the new one its place)
    if (src.path)
    {
        const lieges = src.path;
        text = lieges.map((k, i) => '\t'.repeat(i) + k + ' = {\n').join('') + '\t'.repeat(lieges.length) + text + lieges.map((_k, i) => '\n' + '\t'.repeat(lieges.length - 1 - i) + '}').join('');
    }

    const abs = modPath(a, plan.rel)!;
    const cur = readText(abs);
    const eol = cur ? eolOf(cur.text) : '\n';
    let body = cur ? cur.text.replace(/\s*$/, '') : `# ${a.mod.name}: new ${plan.label.toLowerCase()} (written by CrusaderPope)`;
    const carried = [...copy.constants, ...copy.locals].filter((c) => !new RegExp(`^\\s*(scripted_(trigger|effect)\\s+)?@?${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'm').test(body));

    for (const c of carried)
        body += eol + eol + c.text.replace(/\r?\n/g, eol);

    body += eol + eol + `# Duplicated from ${req.source} (written by CrusaderPope)` + eol;
    // (its own line: after the lieges' blocks, one line each)
    const line = body.split(/\r?\n/).length + (src.path?.length ?? 0);
    body += text.replace(/\r?\n/g, eol) + eol;
    const at = lineAfter('﻿' + body, write(host, abs, '﻿' + body), line);
    const entries: [string, string][] = [...texts].map(([k, t]) => [k === req.source ? key : renameKey(k), k === nameKey && req.name?.trim() ? req.name.trim() : t]);

    // (a name in game asked for, but none written before: under the type's first key)
    if (req.name?.trim() && !nameKey)
        entries.push([renameKey(nameKeys[0]) === nameKeys[0] ? key : renameKey(nameKeys[0]), req.name.trim()]);

    const files = [abs];
    const locFile = writeLoc(host, a, host.settings().language || 'english', entries);

    if (locFile)
        files.push(locFile);

    if (host.refreshFiles)
        await host.refreshFiles(files);
    else
        host.reindex();

    return { type: req.type, key, mod: a.mod.name, file: abs, rel: plan.rel, line: at, loaded: a.loaded };
}

/** The last definition `key = { … }` in a file, at any depth (at `line` when given): the holder a new entry goes in. */
function definitionIn(a: Active, file: string, key: string, line?: number): ModDef
{
    const cur = readText(file);

    if (!cur)
        throw new Error(`${file} could not be read.`);

    let found: PNode | undefined;
    const walk = (list: PNode[]): void =>
    {
        for (const n of list)
        {
            if (!Array.isArray(n.v))
                continue;

            if (n.k === key && (line === undefined || n.line === line || !found))
                found = n;

            walk(n.v);
        }
    };
    walk(parse(cur.text));

    if (!found)
        throw new Error(`${key} was not found in ${file}.`);

    return { file, rel: file.slice(a.root.length + 1).replace(/\\/g, '/'), text: cur.text, bom: cur.bom, node: found };
}

/**
 * The holder's definition in the active mod: its own when it has one, else a copy of the winning one written into its
 * overrides file first ("Override in" — the copy replaces the game's, whose entries it keeps).
 */
async function holderInMod(host: ModsHost, a: Active, type: string, name: string): Promise<ModDef>
{
    try
    {
        return await modDefinition(host, a, type, name);
    }
    catch
    {
        // (not written in the mod yet)
    }

    const r = await applyOverride(host, { type, name, mode: 'copy' });

    if (r.action !== 'copied' && r.action !== 'opened')
        throw new Error(`${name} could not be copied into ${a.mod.name}.`);

    return definitionIn(a, r.file, name, r.line);
}

/**
 * A new entry of a type written inside other definitions (docs/mods.md, "New entries inside a holder"): into an
 * existing holder (copied into the mod first when the mod does not write it yet) or a new one (from the holder type's
 * template, in its new-entries file), inside the blocks between (a faith: `faiths = { }`, made when missing); empty, or
 * a copy of one of the holder's entries (`from`: its text under the new key, its description texts under keys
 * following the new one). Its name in game under the type's first name key.
 */
async function createNested(host: ModsHost, a: Active, type: string, nested: NonNullable<NewEntryPlan['nested']>, req: NewEntryRequest): Promise<NewEntryResult>
{
    const key = req.key.trim();

    if (!KEY.test(key))
        throw new Error(`“${key}” is no valid key (letters, digits and _ only).`);

    if (await host.query?.('detail', type, key))
        throw new Error(`“${key}” exists already.`);

    const files = new Set<string>();
    const loc: [string, string][] = [];
    let def: ModDef;

    if (req.newHolder)
    {
        const hk = req.newHolder.key.trim();

        if (!KEY.test(hk))
            throw new Error(`“${hk}” is no valid key for the new ${nested.holderLabel.toLowerCase()}.`);

        if (await host.query?.('detail', nested.holderType, hk))
            throw new Error(`“${hk}” exists already.`);

        const hplan = await newEntryPlan(host, nested.holderType);

        if (hplan.problem || !hplan.rel)
            throw new Error(hplan.problem ?? `No new ${nested.holderLabel.toLowerCase()} can be made.`);

        const t = templateOf(nested.holderType)(hk, req.newHolder.name?.trim() || humanize(hk));
        const abs = modPath(a, hplan.rel)!;
        const cur = readText(abs);
        const eol = cur ? eolOf(cur.text) : '\n';
        const body = cur ? cur.text.replace(/\s*$/, '') : `# ${a.mod.name}: new ${hplan.label.toLowerCase()} (written by CrusaderPope)`;
        write(host, abs, '﻿' + body + eol + eol + t.text.replace(/\n/g, eol) + eol);
        loc.push(...t.loc);
        files.add(abs);
        def = definitionIn(a, abs, hk);
    }
    else
    {
        if (!req.holder)
            throw new Error(`Choose the ${nested.holderLabel.toLowerCase()} it goes in.`);

        def = await holderInMod(host, a, nested.holderType, req.holder);
    }

    // the block it goes in: the holder, down the blocks between (the missing ones made around it)
    let block = def.node;
    let missing: string[] = [];

    for (let i = 0; i < nested.within.length; i++)
    {
        const next = (block.v as PNode[]).find((x) => x.k === nested.within[i] && Array.isArray(x.v));

        if (!next)
        {
            missing = nested.within.slice(i);
            break;
        }

        block = next;
    }

    let text = `${key} = {\n}`;

    if (req.from)
    {
        const sib = (block.v as PNode[]).find((x) => x.k === req.from && Array.isArray(x.v));

        if (!sib || missing.length)
            throw new Error(`${req.from} is not in ${def.node.k} (in ${def.rel}).`);

        // its text, unindented, under the new key
        const src = def.text.slice(sib.s, sib.e).replace(/\r\n/g, '\n');
        const lines = src.split('\n');
        // (the closing brace has the statement's own indentation: the least of the lines after the first)
        const indent = Math.min(
            ...lines.slice(1)
                .filter((l) => l.trim())
                .map((l) => /^\s*/.exec(l)![0].length),
            Infinity
        );
        const cut = Number.isFinite(indent) ? indent : 0;
        text = [key + lines[0].slice(req.from.length), ...lines.slice(1).map((l) => l.slice(Math.min(cut, /^\s*/.exec(l)![0].length)))].join('\n');

        // its description texts under keys following the new one
        for (const k of descriptionCandidates(type, req.from))
        {
            const e = await host.query<{ text?: string; rel?: string; } | null>?.('locEntry', k);

            if (e?.rel !== undefined)
                loc.push([k.replace(req.from, key), e.text ?? '']);
        }
    }

    for (const k of [...missing].reverse())
        text = `${k} = {\n${text.split('\n').map((l) => (l.trim() ? '\t' + l : l)).join('\n')}\n}`;

    insertInto(host, def, block, text);
    files.add(def.file);
    loc.push([displayNameCandidates(type, key)[0], req.name?.trim() || humanize(key)]);
    const locFile = writeLoc(host, a, host.settings().language || 'english', loc);

    if (locFile)
        files.add(locFile);

    if (host.refreshFiles)
        await host.refreshFiles([...files]);
    else
        host.reindex();

    const after = readText(def.file)?.text ?? '';
    const at = after.search(new RegExp(`(^|\\s)${key}\\s*=\\s*\\{`));
    const line = at < 0 ? def.node.line : after.slice(0, at + 1).split(/\r?\n/).length;
    return { type, key, mod: a.mod.name, file: def.file, rel: def.rel, line, loaded: a.loaded };
}
