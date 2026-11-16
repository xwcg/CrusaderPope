/**
 * New entries the statement picker's result needs (docs/picker.md, "New entries"), made in the active mod before the
 * statement is written:
 * - a new opinion modifier: appended to the mod's `common/opinion_modifiers/<mod>_opinion_modifiers.txt` (created
 *   with a byte order mark and a header), its name in the mod's `localization/<lang>/<mod>_l_<lang>.yml` (the key is
 *   the modifier's key, as the game names opinion modifiers);
 * - a new doctrine parameter: `<key>` (bare, as 1.20 writes a flag) in the `parameters` of the doctrine that turns it on (the doctrine is
 *   overridden in the mod first when it is not the mod's already (its whole group, "Override in"), a missing
 *   `parameters` block is created), and its sentence as `doctrine_parameter_<key>` in the loc file.
 * - without the picker (the faith cards' placeholders, docs/readable-view.md): a localization text (`loc`); a new faith
 *   in a religion of the mod (`faith`: `<key> = { }` into its `faiths`, the block made when missing; its name (1.20:
 *   a faith of its own in the mod's religion/faith_types naming the religion)); a doctrine put into a doctrine group
 *   (`doctrine_group_member`: into the group's `doctrine_types`, the group overridden in the mod first when it is the
 *   game's; 1.20: `doctrine_group_type = <group>` into the doctrine, overridden first); a term of a faith or religion
 *   of the mod (`term`:
 *   `HighGodName = <owner>_high_god_name` into its `localization`, the block made when missing, and the text).
 * Also a brand-new entry of a type (the explorer's type list: right click → "New <type>…"): a template definition in
 * the mod's `<folder>/<mod>_<folder>.txt` (events: with their namespace line) and its localization.
 * Plain Node (scripts use it too).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { CharacterPreset, DnaEditorData, DnaGene, DuplicateEntryRequest, DuplicateRequest, EntityDetail, EntryCreate, NewEntryPlan, NewEntryRequest, NewEntryResult, Relation } from '../../shared/api.ts';
import type { CharacterBasis } from '../history/newCharacter.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { descriptionCandidates, displayNameCandidates } from '../indexer/schema.ts';
import { eolOf, type OverrideSource } from '../indexer/override.ts';
import { activeMod, applyOverride, fileTag, hiddenProblem, lineAfter, modPath, write, type Active } from './edit.ts';
import { applyEdit } from './scriptEdit.ts';
import { modsState, type ModsHost } from './manager.ts';
import { change, describeChange } from './undo.ts';
import { modernize, useParser } from './modernize.ts';
import { splitZipPath } from './zipEntry.ts';
import { ZipArchive } from './zip.ts';
import { decodeText, readTextFile } from './textCodec.ts';
import type { BookmarkFacts } from '../map/mapData.ts';

import { defaultEntryName } from '../../shared/entryName.ts';
import { tr } from '../../shared/i18n.ts';
import { DEFAULT_RELATIVE_AGES, yearsFrom } from '../../shared/characterPresets.ts';
import { genesBlock } from './dna.ts';
const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** A text file of the mod: its text without byte order mark (null when missing). */
function readText(file: string): { text: string; bom: boolean; } | null
{
    if (!existsSync(file))
        return null;

    const all = readTextFile(file);
    const bom = all.charCodeAt(0) === 0xfeff;
    return { text: bom ? all.slice(1) : all, bom };
}

/** A text file inside a packed mod (`archive.zip › entry`, as GameFiles.where names it). */
function readZipText(where: string): { text: string; bom: boolean; } | null
{
    const z = splitZipPath(where);

    if (!z)
        return null;

    const zip = new ZipArchive(z.archive);

    try
    {
        const data = zip.readEntry(z.entry);

        if (!data)
            return null;

        const all = decodeText(data);
        const bom = all.charCodeAt(0) === 0xfeff;
        return { text: bom ? all.slice(1) : all, bom };
    }
    finally
    {
        zip.close();
    }
}

/** Appends a block to a file of the mod (made when missing: BOM, header comment). */
function appendDefinition(host: ModsHost, a: Active, rel: string, block: string, header: string): string
{
    const abs = modPath(a, rel);

    if (!abs)
        throw new Error(tr('{rel} is not a path inside the mod folder.', { rel }));

    const cur = readText(abs);
    const eol = cur ? eolOf(cur.text) : '\n';
    const body = cur ? cur.text.replace(/\s*$/, '') + eol + eol : `# ${header}` + eol + eol;
    write(host, abs, '﻿' + body + block.replace(/\n/g, eol) + eol);
    return abs;
}

/**
 * Adds (or replaces) localization keys in the mod's loc file of the language, or in `into` (a mod-relative loc file: the
 * file a key of the mod's own is in, or its replace file for an override of a key the game or another mod has).
 */
function writeLoc(host: ModsHost, a: Active, lang: string, entries: [string, string][], into?: string): string | undefined
{
    if (!entries.length)
        return undefined;

    const rel = into ?? `localization/${lang}/${fileTag(a)}_l_${lang}.yml`;
    const abs = modPath(a, rel);

    if (!abs)
        throw new Error(tr('{rel} is not a path inside the mod folder.', { rel }));

    // (a later mod's replace_path over the language folder: the texts would not load)
    const hidden = hiddenProblem(a, rel.replace(/\/[^/]*$/, ''));

    if (hidden)
        throw new Error(hidden);

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

/** The mod's copy of a doctrine (overridden into the mod first when it is not the mod's): its file, text and node. */
async function modDoctrine(host: ModsHost, doctrine: string): Promise<{ r: { file: string; rel: string; }; cur: { text: string; bom: boolean; }; node: PNode & { v: PNode[]; }; }>
{
    const r = await applyOverride(host, { type: 'religion/doctrine_types', name: doctrine, mode: 'copy' });
    const cur = readText(r.file);

    if (!cur)
        throw new Error(tr('{rel} could not be read.', { rel: r.rel }));

    const node = findDoctrine(parse(cur.text), doctrine);

    if (!node || !Array.isArray(node.v))
        throw new Error(tr('The doctrine “{doctrine}” was not found in {rel}.', { doctrine, rel: r.rel }));

    return { r, cur, node: node as PNode & { v: PNode[]; } };
}

/** `<key> = yes` into the doctrine's `parameters` (the block made when missing). */
async function addDoctrineParameter(host: ModsHost, a: Active, key: string, doctrine: string): Promise<string>
{
    const { r, cur, node } = await modDoctrine(host, doctrine);

    const params = node.v.find((c) => c.k === 'parameters' && Array.isArray(c.v));

    // (there already: `key = …`, or the name alone)
    if (params && Array.isArray(params.v) && params.v.some((c) => c.k === key || (!c.k && c.v === key)))
        return r.file;

    const block = params ?? node;
    const at = { file: r.file, rel: r.rel, line: block.line, s: block.s, e: block.e, inner: [block.vs + 1, block.e - 1] as [number, number], kind: 'other' as const, hash: '' };
    // (the flag written bare, as 1.20's own files and _doctrine_types.info write it)
    const out = applyEdit(cur.text, { op: 'insert', at, where: 'inside', text: params ? key : `parameters = {\n\t${key}\n}` });
    write(host, r.file, (cur.bom ? '﻿' : '') + out.text);
    return r.file;
}

/** A node spanning exactly [s, e) of a parsed file (a definition; a faith nested in its religion too). */
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
        throw new Error(tr('{name} is not written in {name2}.', { name, name2: a.mod.name }));

    const cur = readText(src.file);

    if (!cur)
        throw new Error(tr('{rel} could not be read.', { rel: src.rel }));

    const node = nodeAt(parse(cur.text), src.s, src.e);

    if (!node || !Array.isArray(node.v))
        throw new Error(tr('{name} was not found in {rel} — changed since the explorer read it?', { name, rel: src.rel }));

    return { file: src.file, rel: src.rel, text: cur.text, bom: cur.bom, node };
}

/**
 * A definition of another mod (`from`: a fixes patch mod's original, docs/mods.md "Migrating a mod") taken into the
 * active mod: its whole file copied under the same path (it replaces the original's), or, copied already in this run,
 * read from the copy.
 */
async function copiedDefinition(host: ModsHost, a: Active, from: string, type: string, name: string, files: Set<string>): Promise<ModDef>
{
    const detail = await host.query<EntityDetail | null>?.('detail', type, name);
    const src = detail && [...detail.defs].reverse().find((d) => !d.origin?.hiddenBy)?.src;

    if (!src || src.mod?.toLowerCase() !== from.toLowerCase())
        throw new Error(tr('{name} is not written in {name2}.', { name, name2: a.mod.name }));

    const target = modPath(a, src.rel);

    if (!target)
        throw new Error(tr('{rel} is not a path inside the mod folder.', { rel: src.rel }));

    let cur = readText(target);

    if (!cur)
    {
        const orig = readText(src.file) ?? readZipText(src.file);

        if (!orig)
            throw new Error(tr('{rel} could not be read.', { rel: src.rel }));

        write(host, target, (orig.bom ? '﻿' : '') + orig.text);
        files.add(target);
        cur = orig;
    }

    const node = parse(cur.text).find((n) => n.k === name && Array.isArray(n.v));

    if (!node)
        throw new Error(tr('{name} was not found in {rel} — changed since the explorer read it?', { name, rel: src.rel }));

    return { file: target, rel: src.rel, text: cur.text, bom: cur.bom, node };
}

/** Writes `text` into a block of the definition's file: at its end, or right before `before` (a statement in it). */
function insertInto(host: ModsHost, def: ModDef, block: PNode, text: string, before?: PNode): void
{
    const n = before ?? block;
    const at = { file: def.file, rel: def.rel, line: n.line, s: n.s, e: n.e, inner: [block.vs + 1, block.e - 1] as [number, number], kind: 'other' as const, hash: '' };
    const out = applyEdit(def.text, before ? { op: 'insert', at, where: 'before', text } : { op: 'insert', at, where: 'inside', text });
    write(host, def.file, (def.bom ? '﻿' : '') + out.text);
}

const DATE = /^\d+\.\d+\.\d+$/;

/**
 * A historical character's definition in the active mod, copied into it first when it is the game's (or another
 * mod's): the override joins the running step.
 */
async function characterInMod(host: ModsHost, a: Active, id: string): Promise<ModDef>
{
    // (one batch writes some characters several times: the block found again in the file as it is now; the index's
    // offsets are from before, and a character copied in this batch is not indexed yet)
    const batch = batchChars.getStore();
    const known = batch?.get(id);

    if (known)
    {
        const cur = readText(known.file);
        const node = cur && parse(cur.text).filter((n) => n.k === id && Array.isArray(n.v)).pop();

        if (cur && node)
            return { ...known, text: cur.text, bom: cur.bom, node };
    }

    const d = await characterInModFirst(host, a, id);
    batch?.set(id, d);
    return d;
}

/**
 * The characters a batch found or copied into the mod: one map per makeEntries run, carried by its async flow (two
 * batches at once, or one inside a statement's edit, never see each other's).
 */
const batchChars = new AsyncLocalStorage<Map<string, ModDef>>();

async function characterInModFirst(host: ModsHost, a: Active, id: string): Promise<ModDef>
{
    try
    {
        return await modDefinition(host, a, 'characters', id);
    }
    catch
    {
        const r = await applyOverride(host, { type: 'characters', name: id, mode: 'copy' });
        const cur = readText(r.file);
        // (the copy is not indexed yet: its block found in the file, the last of that key, at its line if it says)
        const nodes = cur ? parse(cur.text) : [];
        const hits = nodes.filter((n) => n.k === id && Array.isArray(n.v));
        const node = hits.find((n) => n.line === r.line) ?? hits[hits.length - 1];

        if (!cur || !node)
            throw new Error(tr('{id} could not be copied into {name}.', { id, name: a.mod.name }));

        return { file: r.file, rel: r.rel, text: cur.text, bom: cur.bom, node };
    }
}

/** Sets `key = value` in a character's block: the written statement replaced, else added. */
function setInCharacter(host: ModsHost, def: ModDef, key: string, value: string): void
{
    const old = (def.node.v as PNode[]).find((x) => x.k === key && typeof x.v === 'string');

    if (old)
        write(host, def.file, (def.bom ? '﻿' : '') + def.text.slice(0, old.s) + `${key} = ${value}` + def.text.slice(old.e));
    else
        insertInto(host, def, def.node, `${key} = ${value}`);
}

/**
 * A new historical character (EntryCreate `character`): from the preset, born on `birth`, of the relative's family
 * (a parent written on them, a sibling's parents, a twin's trait on both), written to the mod's characters file.
 */
async function newCharacter(host: ModsHost, a: Active, c: EntryCreate): Promise<{ id: string; file: string; also: string[]; notes: string[]; }>
{
    const field = (k: string): string | undefined => c.fields.find(([x]) => x === k)?.[1];
    const preset = JSON.parse(field('preset') ?? '{}') as CharacterPreset;
    const relation = field('relation') as Relation | undefined;
    const relId = field('relative');
    const birth = field('birth');

    if (!birth || !DATE.test(birth))
        throw new Error(tr('“{birth}” is no date (year.month.day).', { birth: birth ?? '' }));

    const basis = (id: string | undefined): Promise<CharacterBasis | null> => (id ? host.query!<CharacterBasis | null>('characterBasis', id) : Promise.resolve(null));
    const rel = await basis(relId);

    if (relId && !rel)
        throw new Error(tr('There is no character {relId} in the loaded game files.', { relId }));

    // siblings are siblings by their parents: the one they share (a different mother: the father; a different father:
    // the mother; else either) made first when the relative has none (the default preset, `parent_years` before the
    // elder's birth; written on the relative too). A twin shares both.
    const pre: { also: string[]; notes: string[]; } = { also: [], notes: [] };
    const sib = relation === 'twin' ? 'same' : (field('siblings') ?? 'same') as 'same' | 'mother' | 'father';

    if ((relation === 'sibling' || relation === 'twin') && rel)
    {
        const shared = sib === 'mother' ? 'father' : sib === 'father' ? 'mother' : rel.father || !rel.mother ? 'father' : 'mother';

        if (!rel[shared] && !(sib === 'same' && (rel.father || rel.mother)))
        {
            const made = await sharedParent(host, a, rel, birth, shared, field('parent_years'));
            rel[shared] = made.id;
            pre.also.push(made.file, ...made.also);
            pre.notes.push(...made.notes, tr('{relId} had no {relation}: the siblings share {id}', { relId: rel.id, relation: shared, id: made.id }));
        }
    }

    // "Between…" (a new character not tied to anyone): the parents chosen, written as father / mother when `link`, else
    // only where family, culture and faith come from
    const chosenFather = await basis(field('father') || undefined);
    const chosenMother = await basis(field('mother') || undefined);
    // which of them are written as the parents (`known`: both / father / mother / none; the map's `link = yes`: both)
    const known = field('known') ?? (field('link') === 'yes' ? 'both' : 'none');
    let realFather: string | undefined;

    // a man or a woman: a parent by the relation, else the preset's (either: by chance)
    const identical = relation === 'twin' && field('twin') === 'identical';
    const female = relation === 'father' ? false : relation === 'mother' ? true : identical && rel ? rel.female : preset.sex === 'female' ? true : preset.sex === 'male' ? false : Math.random() < 0.5;
    // the family: a father's, sibling's, twin's, child's house is the relative's (a mother's only by a dynasty key);
    // a child "With…" / "Between…" the known father's, else the known mother's, else none (the real parents unknown
    // give only their genes); "Between…" on the map the chosen parents'; a map holder's the title holder's
    const mix = field('father_mode') !== undefined;
    const knownFatherBasis = mix ? await basis((field('father_mode') === 'known' ? chosenFather?.id : field('father_mode') === 'hidden' ? field('known_father') : undefined) || undefined) : null;
    const knownMother = mix && field('mother_known') === 'yes' ? chosenMother : null;
    const family = preset.dynasty === 'relative' || preset.dynasty === undefined ?
        relation === 'mother' ? null :
        mix ? (knownFatherBasis ?? knownMother) :
        (rel ?? chosenFather ?? chosenMother ?? (await basis(field('house_of')))) :
        null;
    const culture = preset.culture || rel?.culture || chosenFather?.culture || chosenMother?.culture || field('culture');
    const faith = preset.faith || rel?.faith || chosenFather?.faith || chosenMother?.faith || field('faith');
    const seed = Math.floor(Math.random() * 1e9);
    const name = preset.name || (await host.query!<string | undefined>('cultureName', culture, female, seed)) || (female ? 'Anna' : 'Hugo');
    // the id: the mod's tag and a number not taken (the index, and this file as made in this batch)
    const rel2 = `history/characters/${fileTag(a)}_characters.txt`;
    const abs = modPath(a, rel2);
    const inFile = new Set((abs && readText(abs)?.text.match(/^\s*([\w.-]+)\s*=\s*\{/gm)?.map((m) => m.replace(/[\s={]/g, ''))) ?? []);
    let id = '';

    for (let n = 1; !id || inFile.has(id) || (await host.query?.('detail', 'characters', id)); n++)
        id = `${fileTag(a)}_${n}`;

    const lines: string[] = [`name = "${name}"`];

    if (female)
        lines.push('female = yes');

    if (preset.dynasty && preset.dynasty !== 'relative' && preset.dynasty !== 'none')
        lines.push(`dynasty = ${preset.dynasty}`);
    else if (family?.house)
        lines.push(`dynasty_house = ${family.house}`);
    else if (family?.dynasty)
        lines.push(`dynasty = ${family.dynasty}`);

    if (culture)
        lines.push(`culture = ${culture}`);

    if (faith)
        lines.push(`religion = ${faith}`);

    // parents: a sibling's the relative's (or one of them and the other chosen: `other_parent`, '' for none), a twin's
    // both of the relative's; a child's the relative; "With…" / "Between…" (no relation) the chosen two as known
    if ((relation === 'sibling' || relation === 'twin') && rel)
    {
        const other = field('other_parent') || undefined;
        const father = sib === 'father' ? other : rel.father;
        const mother = sib === 'mother' ? other : rel.mother;

        if (father)
            lines.push(`father = ${father}`);

        if (mother)
            lines.push(`mother = ${mother}`);
    }
    else if (relation === 'child' && rel)
        lines.push(`${rel.female ? 'mother' : 'father'} = ${rel.id}`);
    else if (!relation)
    {
        // (a child "With…" / "Between…": the mother known or not; the father known, hidden (the real father set by an
        // effect at the birth, someone else or nobody known) or no parent; the map's `known`: both / father / mother)
        const mode = field('father_mode') ?? (known === 'both' || known === 'father' ? 'known' : 'none');
        const motherKnown = field('mother_known') ? field('mother_known') === 'yes' : known === 'both' || known === 'mother';
        const knownFather = mode === 'hidden' ? field('known_father') : mode === 'known' ? chosenFather?.id : undefined;

        if (knownFather)
            lines.push(`father = ${knownFather}`);

        if (chosenMother && motherKnown)
            lines.push(`mother = ${chosenMother.id}`);

        if (mode === 'hidden' && chosenFather)
            realFather = chosenFather.id;
    }

    // "With…" / "Between…": the face a mix of the two parents' DNA (known as parents or not), kept as a DNA entry
    if (!relation && field('mix') === 'yes' && chosenFather && chosenMother)
    {
        const dna = await mixedDna(host, a, chosenFather.id, chosenMother.id, id);
        lines.push(`dna = ${dna.key}`);
        pre.also.push(dna.file);
        pre.notes.push(tr('A face mixed from {father} and {mother}: the DNA {key}', { father: chosenFather.id, mother: chosenMother.id, key: dna.key }));
    }

    // an identical twin wears the relative's DNA (made from the face shown when the relative has none)
    if (identical && rel)
    {
        const dna = await twinDna(host, a, rel.id, id);
        lines.push(`dna = ${dna.key}`);
        pre.also.push(...dna.files);
        pre.notes.push(...dna.notes);
    }

    for (const t of [...(preset.traits ?? []), ...(relation === 'twin' ? ['twin'] : [])])
        lines.push(`trait = ${t}`);

    for (const [k, v] of Object.entries(preset.skills ?? {}))
        if (v !== undefined)
            lines.push(`${k} = ${v}`);

    // (the real father of a hidden one: an effect in the birth block, as AGOT writes its 75 secret bastards, Aegon IV's
    // among them; he is alive then)
    lines.push(realFather ? `${birth} = {\n\tbirth = yes\n\teffect = {\n\t\tset_real_father = character:${realFather}\n\t}\n}` : `${birth} = {\n\tbirth = yes\n}`);
    const block = `${id} = {\n${lines.map((l) => '\t' + l.replace(/\n/g, '\n\t')).join('\n')}\n}`;
    const file = appendDefinition(host, a, rel2, block, tr('{name}: characters (written by CrusaderPope)', { name: a.mod.name }));
    const also: string[] = [...pre.also];
    const notes = [...pre.notes, tr('New character {name} ({id}){value}, born {birth}, in {rel2}', { name, id, value: relation && rel ? `, ${relation} of ${rel.id}` : '', birth, rel2 })];

    // the relative's side: a parent written on them, a twin's trait
    if (relId && (relation === 'father' || relation === 'mother' || (relation === 'twin' && !rel!.traits.includes('twin'))))
    {
        const def = await characterInMod(host, a, relId);

        if (relation === 'twin')
            insertInto(host, def, def.node, 'trait = twin');
        else
            setInCharacter(host, def, relation!, id);

        also.push(def.file);
        notes.push(relation === 'twin' ? tr('{relId} has the trait twin too', { relId }) : tr('{relId}’s {relation} is {id} now', { relId, relation: relation!, id }));
    }

    return { id, file, also, notes };
}

/**
 * A child's DNA from two parents, as the game passes genes on: per gene one of the father's two pairs and one of the
 * mother's (either one shown, by chance), a gene only one of them has taken from them alone; written as `<child>_dna`.
 */
async function mixedDna(host: ModsHost, a: Active, father: string, mother: string, child: string): Promise<{ key: string; file: string; }>
{
    const [f, m] = await Promise.all([father, mother].map((id) => host.query!<DnaEditorData | null>('dnaEditor', 'characters', id)));

    if (!f || !m)
        throw new Error(tr('{id} has no face to pass on.', { id: !f ? father : mother }));

    const pick = <T>(x: T, y: T): T => (Math.random() < 0.5 ? x : y);
    // one pair of a gene: the first or the second
    const pair = (g: DnaGene, second: boolean): DnaGene =>
        g.xy ? { gene: g.gene, value: 0, xy: second ? (g.xy2 ?? g.xy) : g.xy } : { gene: g.gene, template: second ? (g.template2 ?? g.template) : g.template, value: second ? (g.value2 ?? g.value) : g.value };
    const byF = new Map(f.genes.map((g) => [g.gene, g]));
    const byM = new Map(m.genes.map((g) => [g.gene, g]));
    const genes: DnaGene[] = [];

    for (const name of new Set([...byF.keys(), ...byM.keys()]))
    {
        const gf = byF.get(name) ?? byM.get(name)!;
        const gm = byM.get(name) ?? byF.get(name)!;
        // (a pair without a variant, an ethnicity option with no name: the other parent's; neither: the gene left
        // out, the game rolls it)
        const ok = (p: DnaGene): boolean => !!p.xy || (!!p.template && KEY.test(p.template));
        let fromF = pair(gf, Math.random() < 0.5);
        let fromM = pair(gm, Math.random() < 0.5);

        if (!ok(fromF))
            fromF = [pair(gf, false), pair(gf, true), fromM].find(ok) ?? fromF;

        if (!ok(fromM))
            fromM = [pair(gm, false), pair(gm, true), fromF].find(ok) ?? fromM;

        if (!ok(fromF) || !ok(fromM))
            continue;

        const [shown, other] = pick([fromF, fromM], [fromM, fromF]);
        genes.push(shown.xy ? { gene: name, value: 0, xy: shown.xy, xy2: other.xy ?? shown.xy } : { gene: name, template: shown.template, value: shown.value, template2: other.template ?? shown.template, value2: other.value ?? shown.value });
    }

    let key = `${child}_dna`;

    for (let n = 2; await host.query?.('detail', 'dna_data', key); n++)
        key = `${child}_dna_${n}`;

    const body = genesBlock(genes).split('\n').map((l) => '\t\t' + l).join('\n');
    const file = appendDefinition(host, a, `common/dna_data/${fileTag(a)}_dna.txt`, `${key} = {\n\tportrait_info = {\n${body}\n\t}\n}`, tr('{name}: DNA (written by CrusaderPope)', { name: a.mod.name }));
    return { key, file };
}

/** A new father or mother for siblings who had none (the default preset; `parent_years` before the elder's birth). */
function sharedParent(host: ModsHost, a: Active, rel: CharacterBasis, birth: string, which: 'father' | 'mother', parentYears: string | undefined): Promise<{ id: string; file: string; also: string[]; notes: string[]; }>
{
    const elder = rel.birth && dateValue(rel.birth) < dateValue(birth) ? rel.birth : birth;
    const years = Number(parentYears ?? DEFAULT_RELATIVE_AGES[which]);
    return newCharacter(host, a, {
        what: 'character',
        key: '',
        fields: [['preset', JSON.stringify({ id: 'parent', name: '', sex: which === 'father' ? 'male' : 'female' })], ['birth', yearsFrom(elder, Number.isFinite(years) ? years : -18)], ['relation', which], ['relative', rel.id]]
    });
}

/**
 * An identical twin's DNA: the same genes as the character's, in an entry of its own (`<twin>_dna`, as AGOT writes its
 * identical twins: separate entries, the same genes). A character without `dna` gets one first (`<id>_dna`, from the
 * face the app shows; the game would roll a different face), written on them (copied into the mod when the game's).
 */
async function twinDna(host: ModsHost, a: Active, id: string, twin: string): Promise<{ key: string; files: string[]; notes: string[]; }>
{
    const d = await host.query!<DnaEditorData | null>('dnaEditor', 'characters', id);

    if (!d)
        throw new Error(tr('{id} has no face to share.', { id }));

    const entry = (key: string, genes: DnaGene[]): string => `${key} = {\n\tportrait_info = {\n${genesBlock(genes).split('\n').map((l) => '\t\t' + l).join('\n')}\n\t}\n}`;
    const free = async (base: string): Promise<string> =>
    {
        let key = base;

        for (let n = 2; await host.query?.('detail', 'dna_data', key); n++)
            key = `${base}_${n}`;

        return key;
    };
    const dnaFile = `common/dna_data/${fileTag(a)}_dna.txt`;
    const header = tr('{name}: DNA (written by CrusaderPope)', { name: a.mod.name });
    const files: string[] = [];
    const notes: string[] = [];

    // (the character's face kept as DNA when it is generated or a bookmark dump's)
    if (d.target.type !== 'dna_data' || d.target.create)
    {
        const own = await free(`${id}_dna`);
        files.push(appendDefinition(host, a, dnaFile, entry(own, d.genes), header));
        const def = await characterInMod(host, a, id);
        setInCharacter(host, def, 'dna', own);
        files.push(def.file);
        notes.push(tr('{id}’s face kept as the DNA {key}', { id, key: own }));
    }

    const key = await free(`${twin}_dna`);
    files.push(appendDefinition(host, a, dnaFile, entry(key, d.genes), header));
    notes.push(tr('The twin’s DNA {key}: the same genes as {id}’s', { key, id }));
    return { key, files, notes };
}

/**
 * An existing character as a relative of another (EntryCreate `relative`: key = the character, fields `relation`,
 * `other`, `parent_years`): a father / mother written on the character, a child gets the character as father or
 * mother, a sibling or twin the character's parents (none: a new father for both first, as for a new sibling), a twin
 * the trait twin on both. Either is copied into the mod first when it is the game's.
 */
async function linkRelative(host: ModsHost, a: Active, c: EntryCreate): Promise<{ files: string[]; notes: string[]; }>
{
    const field = (k: string): string | undefined => c.fields.find(([x]) => x === k)?.[1];
    const relation = field('relation') as Relation | undefined;
    const otherId = field('other');
    const basis = (id: string | undefined): Promise<CharacterBasis | null> => (id ? host.query!<CharacterBasis | null>('characterBasis', id) : Promise.resolve(null));
    const [rel, other] = await Promise.all([basis(c.key), basis(otherId)]);

    if (!rel)
        throw new Error(tr('There is no character {relId} in the loaded game files.', { relId: c.key }));

    if (!other || !relation)
        throw new Error(tr('There is no character {relId} in the loaded game files.', { relId: otherId ?? '' }));

    if (other.id === rel.id)
        throw new Error(tr('{id} cannot be their own relative.', { id: rel.id }));

    const files = new Set<string>();
    const notes: string[] = [];
    const set = async (id: string, key: string, value: string): Promise<void> =>
    {
        const def = await characterInMod(host, a, id);
        setInCharacter(host, def, key, value);
        files.add(def.file);
        notes.push(tr('{id}: {key} = {value}', { id, key, value }));
    };

    if (relation === 'father' || relation === 'mother')
        await set(rel.id, relation, other.id);
    else if (relation === 'child')
        await set(other.id, rel.female ? 'mother' : 'father', rel.id);
    else
    {
        let { father, mother } = rel;
        const sib = relation === 'twin' ? 'same' : (field('siblings') ?? 'same');
        // (siblings are siblings by their parents: the one they share made first when the character has none)
        const shared = sib === 'mother' ? 'father' : sib === 'father' ? 'mother' : father || !mother ? 'father' : 'mother';

        if (sib === 'same' ? !father && !mother : !rel[shared])
        {
            const elder = [rel.birth, other.birth].filter((b): b is string => !!b && DATE.test(b)).sort((x, y) => dateValue(x) - dateValue(y))[0] ?? '1000.1.1';
            const made = await sharedParent(host, a, rel, elder, shared, field('parent_years'));
            files.add(made.file);
            made.also.forEach((f) => files.add(f));
            notes.push(...made.notes);

            if (shared === 'father')
                father = made.id;
            else
                mother = made.id;
        }

        // (a different mother or father: the other parent chosen, '' for none)
        if (sib === 'mother')
            mother = field('other_parent') || undefined;
        else if (sib === 'father')
            father = field('other_parent') || undefined;

        if (father)
            await set(other.id, 'father', father);

        if (mother)
            await set(other.id, 'mother', mother);

        if (relation === 'twin')
        {
            for (const p of [rel, other])
            {
                if (p.traits.includes('twin'))
                    continue;

                const def = await characterInMod(host, a, p.id);
                insertInto(host, def, def.node, 'trait = twin');
                files.add(def.file);
                notes.push(tr('{relId} has the trait twin too', { relId: p.id }));
            }
        }
    }

    return { files: [...files], notes };
}

/** y.m.d as one comparable number */
const dateValue = (d: string): number =>
{
    const [y, m, day] = d.split('.').map(Number);
    return y * 10000 + (m || 1) * 100 + (day || 1);
};

/** `HighGodName` → `high_god_name` */
const snake = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Makes the entries (see the file comment) and hands the files to the index: one undo step, all or nothing: a batch that
 * fails takes back what it wrote (undo.ts `rollback`). Inside a statement's edit (ScriptEditRequest.creates) its entries
 * join the statement's step.
 */
export function createEntries(host: ModsHost, creates: EntryCreate[]): Promise<{ files: string[]; notes: string[]; step?: number; keys?: string[]; }>
{
    const label = creates
        .map((c) =>
            c.what === 'bookmark_character' ? tr('{value} in the bookmark {key}', { value: c.fields.find(([k]) => k === 'history_id')?.[1], key: c.key }) :
            c.what === 'character' ? tr('character') :
            c.what === 'birth' ? tr('birth of {key}', { key: c.key }) :
            c.what === 'relative' ? tr('relative of {key}', { key: c.key }) :
            c.what === 'life_event' ? tr('life event of {key}', { key: c.key }) :
            c.key
        )
        .join(', ');
    return change(host, tr('New {label}', { label }), 'create', () => batchChars.run(new Map(), () => makeEntries(host, creates)), { rollback: true });
}

async function makeEntries(host: ModsHost, creates: EntryCreate[]): Promise<{ files: string[]; notes: string[]; keys?: string[]; }>
{
    const a = await activeMod(host);

    if (typeof a === 'string')
        throw new Error(a);

    const lang = host.settings().language || 'english';
    const files = new Set<string>();
    const loc: [string, string][] = [];
    // (texts of keys that exist, by the file they go into: the mod's own file of the key, or its replace file)
    const locAt = new Map<string, [string, string][]>();
    const notes: string[] = [];
    // (keys made here: a new character's id)
    const keys: string[] = [];
    // (the new holders this batch made, `<holder type>:<key>` → their file and line: a second entry naming the same new
    // holder goes into it; createNested)
    const madeHolders: MadeHolders = new Map();

    for (const c of creates)
    {
        // a new historical character from a preset (docs/mods.md, "New characters")
        // an existing character made a relative (father, mother, sibling, twin, child) of another
        if (c.what === 'relative')
        {
            const r = await linkRelative(host, a, c);
            r.files.forEach((f) => files.add(f));
            notes.push(...r.notes);
            continue;
        }

        if (c.what === 'character')
        {
            const r = await newCharacter(host, a, c);
            files.add(r.file);

            for (const f of r.also)
                files.add(f);

            keys.push(r.id);
            notes.push(...r.notes);
            continue;
        }

        if (!KEY.test(c.key))
            throw new Error(tr('“{key}” is no valid key (letters, digits, _, . and - only).', { key: c.key }));

        const field = (k: string): string | undefined => c.fields.find(([x]) => x === k)?.[1];

        // a new entry of any type (the picker's "＋ New trait…"): its template, as "New <type>…" writes it
        if (c.what === 'entry')
        {
            const type = field('type');

            if (!type)
                throw new Error(tr('Which type is the new “{key}”?', { key: c.key }));

            // (its other fields go to the template: a bookmark's start_date and group when made from the map)
            const rest = Object.fromEntries(c.fields.filter(([k]) => k !== 'type' && k !== 'holder' && k !== 'newHolder' && k !== 'newHolderName'));

            if (type === 'bookmarks/bookmarks' && rest.start_date && !rest.group)
            {
                const g = await host.query<string | null>?.('bookmarkGroupFor', rest.start_date);

                if (g)
                    rest.group = g;
            }

            // (a type written inside other definitions: the holder it goes in, or a new one, travels as fields)
            const holder = field('holder');
            const newHolder = field('newHolder');
            const req: NewEntryRequest = { type, key: c.key, name: c.loc || undefined };

            if (holder)
                req.holder = holder;
            else if (newHolder)
                req.newHolder = { key: newHolder, name: field('newHolderName') || undefined };

            const r = await newEntry(host, req, { files, fields: rest, madeHolders });
            describeChange({ line: r.line });
            notes.push(tr('New {replace} “{key}” in {rel}', { replace: r.type.replace(/^.*\//, '').replace(/s$/, '').replace(/_/g, ' '), key: c.key, rel: r.rel }));
            continue;
        }

        if (c.what === 'loc')
        {
            // (a key that exists: the mod's own line changed where it is; the game's or another mod's overridden in the
            // mod's replace folder, which wins over every other loc file; a line beside it would be a duplicate key)
            const e = await host.query<{ rel?: string; mod?: string; } | null>?.('locEntry', c.key);

            if (!e?.rel)
                loc.push([c.key, c.loc ?? '']);
            else
            {
                const own = !!e.mod && e.mod.toLowerCase() === a.mod.id.toLowerCase();
                const rel = own ? e.rel : `localization/${lang}/replace/${fileTag(a)}_l_${lang}.yml`;
                const at = locAt.get(rel) ?? [];
                locAt.set(rel, [...at, [c.key, c.loc ?? '']]);

                if (!own)
                    notes.push(tr('The game\'s text is overridden in {rel} (the replace folder wins).', { rel }));
            }

            continue;
        }

        if (c.what === 'faith')
        {
            const religion = field('religion');

            if (!religion)
                throw new Error(tr('The new faith “{key}” needs its religion.', { key: c.key }));

            if (await host.query?.('detail', 'faith', c.key))
                throw new Error(tr('A faith “{key}” exists already.', { key: c.key }));

            // (1.20: faiths of their own, naming their religion; docs/game-structure.md, "Layouts that changed")
            const info = await host.query<EntryInfo | null>?.('newEntryInfo', 'faith');

            if (info?.folder && !info.nested)
            {
                const r = await newEntry(host, { type: 'faith', key: c.key, name: c.loc || humanize(c.key) }, { files, fields: { religion } });
                notes.push(tr('New faith “{key}” of {religion} in {rel}', { key: c.key, religion, rel: r.rel }));
                continue;
            }

            const def = await modDefinition(host, a, 'religion/religion_types', religion);
            const faiths = (def.node.v as PNode[]).find((x) => x.k === 'faiths' && Array.isArray(x.v));

            // (empty: the faith's card shows what it needs (colour, icon, tenets, doctrines, holy sites) to fill in)
            if (faiths)
                insertInto(host, def, faiths, `${c.key} = {\n}`);
            else
                insertInto(host, def, def.node, `faiths = {\n\t${c.key} = {\n\t}\n}`);

            files.add(def.file);
            loc.push([c.key, c.loc || humanize(c.key)]);
            notes.push(tr('New faith “{key}” in {religion}', { key: c.key, religion }));
            continue;
        }

        // a bookmark's character (docs/map.md, "Open items"): a historical character as the bookmark starts them, with their
        // primary title, government, family, culture and faith at the bookmark's date (the map's history); `under`: the
        // main character an alternative one goes beside (with its `relation`)
        if (c.what === 'bookmark_character')
        {
            const id = field('history_id');
            const under = field('under');

            if (!id)
                throw new Error(tr('Which historical character?'));

            const def = await modDefinition(host, a, 'bookmarks/bookmarks', c.key);
            const body = def.node.v as PNode[];
            const date = body.find((x) => x.k === 'start_date' && typeof x.v === 'string')?.v as string | undefined;

            if (!date)
                throw new Error(tr('{key} has no start_date — set it first.', { key: c.key }));

            const facts = await host.query<BookmarkFacts | null>?.('bookmarkFacts', join(host.dataDir?.() ?? '.', 'map-cache'), id, date);

            if (!facts)
                throw new Error(tr('The map history is not ready yet — try again in a moment.'));

            const nameKey = `bookmark_${c.key}_${id}`.replace(/[^\w]/g, '_').toLowerCase();
            const lines: string[] = [`name = "${nameKey}"`];

            if (facts.house)
                lines.push(`dynasty_house = ${facts.house}`);
            else if (facts.dynasty)
                lines.push(`dynasty = ${facts.dynasty}`);

            lines.push(`type = ${facts.female ? 'female' : 'male'}`);

            if (facts.birth)
                lines.push(`birth = ${facts.birth}`);

            // (a main character: what they rule and how hard; an alternative one: how they are related)
            if (!under)
            {
                if (facts.title)
                    lines.push(`title = ${facts.title}`);

                if (facts.government)
                    lines.push(`government = ${facts.government}`);
            }

            if (facts.culture)
                lines.push(`culture = ${facts.culture}`);

            if (facts.faith)
                lines.push(`religion = ${facts.faith}`);

            if (under)
                lines.push(`relation = "${field('relation') ?? 'BOOKMARK_RELATION_SON'}"`);
            else
                lines.push('difficulty = "BOOKMARK_CHARACTER_DIFFICULTY_MEDIUM"');

            lines.push(`history_id = ${id}`);

            if (!under)
                lines.push('position = { 900 500 }');

            lines.push(`animation = ${under ? 'personality_bold' : 'idle'}`);
            const text = `character = {\n${lines.map((l) => '\t' + l).join('\n')}\n}`;
            // (into the main character `under` names, else the bookmark itself)
            let into: PNode = def.node;

            if (under)
            {
                const hit = body.find((x) => x.k === 'character' && Array.isArray(x.v) && (x.v as PNode[]).some((y) => y.k === 'name' && typeof y.v === 'string' && y.v.replace(/"/g, '') === under));

                if (!hit)
                    throw new Error(tr('{key} has no character “{under}”.', { key: c.key, under }));

                into = hit;
            }

            insertInto(host, def, into, text);
            files.add(def.file);
            loc.push([nameKey, c.loc || facts.name]);
            notes.push(tr('{name} ({id}) {value}{value2} — their portrait on the bookmark screen is common/bookmark_portraits/{nameKey}.txt (made in the game: dump_bookmark_portraits)', { name: facts.name, id, value: under ? 'beside ' + under : 'in ' + c.key, value2: facts.title ? ', ruling ' + facts.title : tr(', holding no title then'), nameKey }));
            continue;
        }

        // a historical character's birth date: their `<date> = { birth = yes }` moved, or written
        // a life event: `text` into the character's block for `date`, that date's block when it has one, else a new one
        // in date order (the character copied into the mod first when it is the game's)
        if (c.what === 'life_event')
        {
            const date = field('date');
            const text = field('text');

            if (!date || !DATE.test(date))
                throw new Error(tr('“{date}” is no date (year.month.day).', { date: date ?? '' }));

            if (!text?.trim())
                throw new Error(tr('What happens?'));

            const def = await characterInMod(host, a, c.key);
            const kids = (def.node.v as PNode[]).filter((x) => x.k && DATE.test(x.k) && Array.isArray(x.v));
            const same = kids.find((x) => dateValue(x.k!) === dateValue(date));
            const later = kids.find((x) => dateValue(x.k!) > dateValue(date));

            if (same)
                insertInto(host, def, same, text);
            else
                insertInto(host, def, def.node, `${date} = {\n${text.split('\n').map((l) => '\t' + l).join('\n')}\n}`, later);

            files.add(def.file);
            notes.push(tr('{key}: {date} — {text}', { key: c.key, date, text: text.split('\n')[0] }));
            continue;
        }

        if (c.what === 'birth')
        {
            const date = c.fields.find(([k]) => k === 'date')?.[1];

            if (!date || !DATE.test(date))
                throw new Error(tr('“{date}” is no date (year.month.day).', { date: date ?? '' }));

            const def = await characterInMod(host, a, c.key);
            const born = (def.node.v as PNode[]).find((x) => x.k && DATE.test(x.k) && Array.isArray(x.v) && x.v.some((y) => y.k === 'birth'));

            if (born)
                write(host, def.file, (def.bom ? '\ufeff' : '') + def.text.slice(0, born.s) + date + def.text.slice(born.s + born.k!.length));
            else
                insertInto(host, def, def.node, `${date} = {\n\tbirth = yes\n}`);

            files.add(def.file);
            notes.push(born ? tr('{key} born on {date} (was {was})', { key: c.key, date, was: born.k }) : tr('{key} born on {date}', { key: c.key, date }));
            continue;
        }

        // "Update for 1.20": an old-layout definition of the mod rewritten (modernize.ts)
        if (c.what === 'modernize')
        {
            const type = field('type');
            const fix = field('fix');
            const lay = await host.query<{ tenets: string[]; tenetDoctrines: string[]; } | null>?.('layouts');

            if (!type || !fix || !lay)
                throw new Error(tr('What should be updated?'));

            useParser(parse);
            // (outside a migration the statement rules run on what a fix writes; inside, its file rules do, on every file
            // together; imported here, not above: migrate.ts imports this file)
            const gameDir = host.gameDir();
            const convert = !field('from') && gameDir ?
                await (await import('./migrate.ts')).statementConverter(host, a.mod, gameDir, (await modsState(host)).gameVersion, [...lay.tenets, ...lay.tenetDoctrines]) :
                undefined;
            await modernize(
                {
                    def: (t, n) => modDefinition(host, a, t, n).catch((e) => (field('from') ? copiedDefinition(host, a, field('from')!, t, n, files) : Promise.reject(e))),
                    read: readText,
                    write: (f, t, bom) => void write(host, f, (bom ? '﻿' : '') + t),
                    path: (rel) =>
                    {
                        const p = modPath(a, rel);

                        if (!p)
                            throw new Error(tr('{rel} is not a path inside the mod folder.', { rel }));

                        return p;
                    },
                    tag: fileTag(a),
                    tenets: new Set([...lay.tenets, ...lay.tenetDoctrines]),
                    tenetDoctrines: new Set(lay.tenetDoctrines),
                    absent: async (refs) => (await host.query<string[] | null>?.('migrationNames', refs)) ?? [],
                    convert,
                    files,
                    notes
                },
                fix,
                c.key
            );
            continue;
        }

        if (c.what === 'doctrine_group_member')
        {
            const group = field('group');

            if (!group)
                throw new Error(tr('Which group should “{key}” go into?', { key: c.key }));

            // (1.20: the doctrine names its group)
            if ((await host.query<{ doctrinesNameTheirGroup: boolean; } | null>?.('layouts'))?.doctrinesNameTheirGroup)
            {
                const { r, cur, node } = await modDoctrine(host, c.key);
                const def = { file: r.file, rel: r.rel, text: cur.text, bom: cur.bom, node };
                const now = node.v.find((x) => x.k === 'doctrine_group_type');

                if (now)
                {
                    const at = { file: r.file, rel: r.rel, line: now.line, s: now.s, e: now.e, kind: 'other' as const, hash: '' };
                    write(host, r.file, (cur.bom ? '﻿' : '') + applyEdit(cur.text, { op: 'replace', at, text: `doctrine_group_type = ${group}` }).text);
                }
                else
                    insertInto(host, def, node, `doctrine_group_type = ${group}`, node.v[0]);

                files.add(r.file);
                notes.push(tr('{key} is now in the doctrine group {group}', { key: c.key, group }));
                continue;
            }

            const r = await applyOverride(host, { type: 'religion/doctrine_group_types', name: group, mode: 'copy' });
            const cur = readText(r.file);

            if (!cur)
                throw new Error(tr('{rel} could not be read.', { rel: r.rel }));

            const node = parse(cur.text).find((n) => n.k === group && Array.isArray(n.v));

            if (!node)
                throw new Error(tr('The doctrine group “{group}” was not found in {rel}.', { group, rel: r.rel }));

            const list = (node.v as PNode[]).find((x) => x.k === 'doctrine_types' && Array.isArray(x.v));
            const def = { file: r.file, rel: r.rel, text: cur.text, bom: cur.bom, node };

            if (!list || !(list.v as PNode[]).some((x) => x.v === c.key))
                insertInto(host, def, list ?? node, list ? c.key : `doctrine_types = {\n\t${c.key}\n}`);

            files.add(r.file);
            notes.push(tr('{key} is now in the doctrine group {group}', { key: c.key, group }));
            continue;
        }

        if (c.what === 'term')
        {
            const type = field('type');
            const owner = field('owner');

            if (!type || !owner || !/^[A-Za-z]\w*$/.test(c.key))
                throw new Error(tr('Which term, of what?'));

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
            notes.push(tr('{key} of {owner}: {own}', { key: c.key, owner, own }));
            continue;
        }

        if (c.what === 'opinion_modifiers')
        {
            if (await host.query?.('detail', 'opinion_modifiers', c.key))
                throw new Error(tr('An opinion modifier “{key}” exists already.', { key: c.key }));

            const block = [`${c.key} = {`, ...c.fields.map(([k, v]) => `\t${k} = ${v}`), '}'].join('\n');
            files.add(appendDefinition(host, a, `common/opinion_modifiers/${fileTag(a)}_opinion_modifiers.txt`, block, tr('{name}: new opinion modifiers (written by CrusaderPope)', { name: a.mod.name })));
            loc.push([c.key, c.loc || humanize(c.key)]);
            notes.push(tr('New opinion modifier “{key}”', { key: c.key }));
        }
        else
        {
            const doctrine = c.fields.find(([k]) => k === 'doctrine')?.[1];

            if (!doctrine)
                throw new Error(tr('The new parameter “{key}” needs a doctrine that sets it.', { key: c.key }));

            files.add(await addDoctrineParameter(host, a, c.key, doctrine));
            loc.push([`doctrine_parameter_${c.key}`, c.loc || humanize(c.key)]);
            notes.push(tr('New doctrine parameter “{key}”, set by {doctrine}', { key: c.key, doctrine }));
        }
    }

    const locFile = writeLoc(host, a, lang, loc);

    if (locFile)
        files.add(locFile);

    for (const [rel, entries] of locAt)
        files.add(writeLoc(host, a, lang, entries, rel)!);

    // (a batch of nested entries only: createNested has had the index take its files in itself, `files` is empty: the empty
    // refresh is skipped here, and main's queueRefresh([]) now resolves an empty call at once when nothing is queued (11422c9);
    // before that it waited until another refresh with files flushed the queue: in a hidden run the call was still waiting
    // after 240 s)
    if (!files.size)
        return { files: [], notes, ...(keys.length ? { keys } : {}) };

    if (host.refreshFiles)
        await host.refreshFiles([...files]);
    else
        host.reindex();

    return { files: [...files], notes, ...(keys.length ? { keys } : {}) };
}

// ---------------------------------------------------------------------------
// A brand-new entry of a type (the explorer's type list: right click → "New <type>…")
// ---------------------------------------------------------------------------

/** A new definition's text and its localization, per type (the rest: an empty block, its name as `<key>`). */
const TEMPLATES: Record<string, (key: string, name: string, fields?: Record<string, string>) => { text: string; loc: [string, string][]; }> = {
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
    // (a doctrine's name and description are `<key>_name` / `_desc`; it still needs a doctrine group, and its card says so)
    'religion/doctrine_types': (k, n) => ({ text: `${k} = {\n}`, loc: [[`${k}_name`, n], [`${k}_desc`, '']] }),
    // (its card shows the rest to fill in: family, faiths, names …)
    'religion/religion_types': (k, n) => ({ text: `${k} = {\n}`, loc: [[k, n]] }),
    // a bookmark (docs/map.md, "Open items"): its start date (the map's date when made from the map), playable, a group
    // (the card's settings change it), weight 0 (not the default start); characters are added on its card
    'bookmarks/bookmarks': (k, n, f) => ({
        text: `${k} = {\n\tstart_date = ${f?.start_date ?? '1066.9.15'}\n\tis_playable = yes\n\tgroup = ${f?.group ?? 'bm_group_1066'}\n\n\tweight = {\n\t\tvalue = 0\n\t}\n}`,
        loc: [[k, n], [`${k}_desc`, '']]
    }),
    // (1.20, a faith of its own: its religion in `faith_details`; the card shows the rest to fill in)
    faith: (k, n, f) => ({ text: `${k} = {\n\tfaith_details = {\n${f?.religion ? `\t\treligion = ${f.religion}\n` : ''}\t}\n}`, loc: [[k, n]] })
};

type Template = (key: string, name: string, fields?: Record<string, string>) => { text: string; loc: [string, string][]; };
const templateOf = (type: string): Template => TEMPLATES[type] ?? ((k, n) => ({ text: `${k} = {\n}`, loc: n ? [[k, n]] : [] }));

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
        return { type, label, problem: tr('New {toLowerCase} can\'t be made here (they are no script definitions of their own).', { toLowerCase: label.toLowerCase() }), name: false };

    // (written inside other definitions: the wizard (which holder, or a new one) when the holder's type is known)
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
        const holder = x?.holderLabel ? singularOf(x.holderLabel) : tr('the definition holding it');
        const where = x ? tr(' — e.g. {name} is a block inside {value}{holder} ({rel}, line {line})', { name: x.name, value: x.holderLabel ? `the ${holder} ` : '', holder: x.holder, rel: x.rel, line: x.line }) : '';
        return {
            type,
            label,
            problem: tr('{label} are not written on their own: each is a block inside another definition{where}, so there is no file to add a new one to by itself. To make one: open that {holder}, override it into {name} (“Override” ▾) and add the new block inside it on its Source tab (“✎ Edit”).', { label, where, holder, name: a.mod.name }),
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
 * Writes a new entry into the active mod (the plan's file; events: its namespace line), with its localization: one undo
 * step (joined by a batch: createEntries). `files`: a batch collects the files written (it hands them to the index itself).
 */
export function createEntry(host: ModsHost, req: NewEntryRequest, opts: { files?: Set<string>; } = {}): Promise<NewEntryResult>
{
    return change(host, tr('New {trim}', { trim: req.key.trim() }), 'create', async () =>
    {
        const r = await newEntry(host, req, opts);
        describeChange({ line: r.line });
        return r;
    });
}

async function newEntry(host: ModsHost, req: NewEntryRequest, opts: { files?: Set<string>; fields?: Record<string, string>; madeHolders?: MadeHolders; }): Promise<NewEntryResult>
{
    const a = await activeMod(host);

    if (typeof a === 'string')
        throw new Error(a);

    const plan = await newEntryPlan(host, req.type);

    if (plan.nested && !plan.problem)
        return createNested(host, a, req.type, plan.nested, req, opts.madeHolders);

    if (plan.problem || !plan.rel)
        throw new Error(plan.problem ?? tr('Nothing to make.'));

    const key = req.key.trim();

    if (!(req.type === 'events' ? /^[A-Za-z_][\w-]*\.\d+$/ : KEY).test(key))
        throw new Error(req.type === 'events' ? tr('“{key}” is no event id (namespace.number, e.g. {fileTag}.0001).', { key, fileTag: fileTag(a) }) : tr('“{key}” is no valid key (letters, digits, _, . and - only).', { key }));

    if (await host.query?.('detail', req.type, key))
        throw new Error(tr('A {replace} “{key}” exists already.', { replace: plan.label.toLowerCase().replace(/s$/, ''), key }));

    const t = templateOf(req.type)(key, req.name?.trim() || defaultEntryName(req.type, key), opts.fields);
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

        // (a folder a later mod's replace_path hides: its files don't load; not a place for a new event)
        if (hiddenProblem(a, relative(a.root, dir).split(sep).join('/')))
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
 * written, with every mention of its id renamed (its own texts' keys (`court.8190.t` → `<new>.t`), self-references),
 * and those texts copied under the new keys into the mod's loc file (`title`: the copy's title instead); the file-local
 * scripted triggers / effects and @constants it uses go along when the file lacks them. It goes into the mod's events
 * file declaring the new id's namespace, else the mod's events file (the namespace line added).
 */
export function duplicateEvent(host: ModsHost, req: DuplicateRequest): Promise<NewEntryResult>
{
    return change(host, tr('{source} duplicated as {trim}', { source: req.source, trim: req.key.trim() }), 'create', async () =>
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
        throw new Error(tr('“{key}” is no event id (namespace.number, e.g. {fileTag}.0001).', { key, fileTag: fileTag(a) }));

    if (key === req.source || (await host.query?.('detail', 'events', key)))
        throw new Error(tr('An event “{key}” exists already.', { key }));

    const src = await host.query<OverrideSource | null>?.('overrideSource', 'events', req.source, a.mod.id);

    if (!src?.copy)
        throw new Error(src?.copyProblem ?? tr('{source} has no definition to copy.', { source: req.source }));

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
            throw new Error(plan.problem ?? tr('The mod has no events file to write into.'));

        abs = modPath(a, plan.rel);
    }

    if (!abs)
        throw new Error(tr('The mod has no events folder to write into.'));

    const cur = readText(abs);
    const eol = cur ? eolOf(cur.text) : '\n';
    let body = cur ? cur.text.replace(/\s*$/, '') : `# ${a.mod.name}: events (written by CrusaderPope)`;

    if (!new RegExp(`^\\s*namespace\\s*=\\s*${ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(body))
        body += eol + eol + `namespace = ${ns}`;

    // (what the event uses from its file: @constants, file-local scripted triggers / effects, when this file lacks them)
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
 * with its key renamed and every value that names the entry itself (`has_trait = <it>`); other keys holding the name
 * stay. Its texts go along under new keys: the display-name and description keys the game looks up for the type
 * (displayNameCandidates, descriptionCandidates) and the keys it names in its text, each with the entry's name
 * replaced by the new key (`trait_brave_desc` → `trait_bold_desc`); the name in game replaced when one is given. The
 * copy is appended to the file new entries of the type go to (newEntryPlan: types written inside other definitions
 * are refused), with the file-local @constants and scripted triggers / effects it uses.
 */
export function duplicateEntry(host: ModsHost, req: DuplicateEntryRequest): Promise<NewEntryResult>
{
    if (req.type === 'events')
        return duplicateEvent(host, { source: req.source, key: req.key, title: req.name });

    return change(host, tr('{source} duplicated as {trim}', { source: req.source, trim: req.key.trim() }), 'create', async () =>
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

    // (a nested type has no file of its own: its copy goes into the holder, below)
    if (plan.problem || (!plan.rel && !plan.nested))
        throw new Error(plan.problem ?? tr('Nothing to make.'));

    const key = req.key.trim();

    if (!KEY.test(key))
        throw new Error(tr('“{key}” is no valid key (letters, digits, _, . and - only).', { key }));

    if (key === req.source || (await host.query?.('detail', req.type, key)))
        throw new Error(tr('A {replace} “{key}” exists already.', { replace: plan.label.toLowerCase().replace(/s$/, ''), key }));

    const src = await host.query<OverrideSource | null>?.('overrideSource', req.type, req.source, a.mod.id);

    if (!src?.copy)
        throw new Error(src?.copyProblem ?? tr('{source} has no definition to copy.', { source: req.source }));

    // (written inside another definition: a copy next to it, in the holder, copied into the mod when needed; a landed
    // title: its own block, without its vassals, inside empty blocks of its lieges, below)
    if (src.container && !src.path)
    {
        if (!plan.nested)
            throw new Error(tr('{source} is written inside {name}: it is not copied alone.', { source: req.source, name: src.container.name }));

        return createNested(host, a, req.type, { ...plan.nested, holderType: src.container.type }, { type: req.type, key, name: req.name, holder: src.container.name, from: req.source });
    }

    if (!plan.rel)
        throw new Error(tr('Nothing to make.'));

    const copy = src.copy;
    // (a landed title in its lieges: its own block; the lieges' empty blocks are written around the renamed one)
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
        throw new Error(tr('{file} could not be read.', { file }));

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
        throw new Error(tr('{key} was not found in {file}.', { key, file }));

    return { file, rel: file.slice(a.root.length + 1).replace(/\\/g, '/'), text: cur.text, bom: cur.bom, node: found };
}

/**
 * The holder's definition in the active mod: its own when it has one, else a copy of the winning one written into its
 * overrides file first ("Override in": the copy replaces the game's, whose entries it keeps).
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
        throw new Error(tr('{name} could not be copied into {name2}.', { name, name2: a.mod.name }));

    return definitionIn(a, r.file, name, r.line);
}

/** The new holders a batch made (makeEntries, createNested): `<holder type>:<key>` → the file and the 1-based line it starts on. */
type MadeHolders = Map<string, { file: string; line: number; }>;

/**
 * A new entry of a type written inside other definitions (docs/mods.md, "New entries inside a holder"): into an
 * existing holder (copied into the mod first when the mod does not write it yet) or a new one (from the holder type's
 * template, in its new-entries file), inside the blocks between (a faith: `faiths = { }`, made when missing); empty, or
 * a copy of one of the holder's entries (`from`: its text under the new key, its description texts under keys
 * following the new one). Its name in game under the type's first name key. `madeHolders` (a batch: makeEntries): the
 * new holders made earlier in it, `<holder type>:<key>` → their file and line; a new holder named again goes into the one
 * made (each entry of the batch carries the holder's full fields, so whichever comes first makes it).
 */
async function createNested(host: ModsHost, a: Active, type: string, nested: NonNullable<NewEntryPlan['nested']>, req: NewEntryRequest, madeHolders?: MadeHolders): Promise<NewEntryResult>
{
    const key = req.key.trim();

    if (!KEY.test(key))
        throw new Error(tr('“{key}” is no valid key (letters, digits, _, . and - only).', { key }));

    if (await host.query?.('detail', type, key))
        throw new Error(tr('“{key}” exists already.', { key }));

    const files = new Set<string>();
    const loc: [string, string][] = [];
    let def: ModDef;

    if (req.newHolder)
    {
        const hk = req.newHolder.key.trim();

        if (!KEY.test(hk))
            throw new Error(tr('“{hk}” is no valid key for the new {toLowerCase}.', { hk, toLowerCase: nested.holderLabel.toLowerCase() }));

        // (made by an earlier entry of this batch: this one goes into it, read from the file it was written to, so it does
        // not depend on the index having taken that file in yet; by its line, which entries written inside it or after it
        // do not move: a block of the same name inside it (a rule `foo` whose first option is `foo`) is not it)
        const made = `${nested.holderType}:${hk}`;
        const madeIn = madeHolders?.get(made);

        if (madeIn)
            def = definitionIn(a, madeIn.file, hk, madeIn.line);
        else
        {
            if (await host.query?.('detail', nested.holderType, hk))
                throw new Error(tr('“{hk}” exists already.', { hk }));

            const hplan = await newEntryPlan(host, nested.holderType);

            if (hplan.problem || !hplan.rel)
                throw new Error(hplan.problem ?? tr('No new {toLowerCase} can be made.', { toLowerCase: nested.holderLabel.toLowerCase() }));

            const t = templateOf(nested.holderType)(hk, req.newHolder.name?.trim() || defaultEntryName(nested.holderType, hk));
            const abs = modPath(a, hplan.rel)!;
            const cur = readText(abs);
            const eol = cur ? eolOf(cur.text) : '\n';
            const body = cur ? cur.text.replace(/\s*$/, '') : `# ${a.mod.name}: new ${hplan.label.toLowerCase()} (written by CrusaderPope)`;
            write(host, abs, '﻿' + body + eol + eol + t.text.replace(/\n/g, eol) + eol);
            loc.push(...t.loc);
            files.add(abs);
            def = definitionIn(a, abs, hk);
            madeHolders?.set(made, { file: abs, line: def.node.line });
        }
    }
    else
    {
        if (!req.holder)
            throw new Error(tr('Choose the {toLowerCase} it goes in.', { toLowerCase: nested.holderLabel.toLowerCase() }));

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
            throw new Error(tr('{from} is not in {k} (in {rel}).', { from: req.from, k: def.node.k, rel: def.rel }));

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
    loc.push([displayNameCandidates(type, key)[0], req.name?.trim() || defaultEntryName(type, key)]);
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
