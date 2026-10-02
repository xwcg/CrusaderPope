/**
 * The barbershop's save (docs/portraits.md, "Barbershop"): a DNA written into the active mod as one undo step. A
 * dna_data entry or bookmark portrait is overridden into the mod (or edited there) and its `genes` block replaced; a
 * character without a DNA entry gets a new dna_data entry in the mod's own file and `dna = <key>` in its history
 * (the character overridden into the mod first).
 */
import { existsSync } from 'node:fs';
import type { DnaGene, DnaSaveRequest, ScriptEditResult } from '../../shared/api.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { applyOverride, fileTag, formatted, modPath, planOverride, write } from './edit.ts';
import { active, anchorIn, applyEdit, layoutOf, lineAt, readScript, refresh, relIn, scriptProblems } from './scriptEdit.ts';
import { change, describeChange } from './undo.ts';
import type { ModsHost } from './manager.ts';

const KEY = /^[\w.-]+$/;

/** `gene={ "template" 12 "template2" 34 }`, colours `gene={ x y x2 y2 }` (values rounded into 0..255). */
function geneLine(g: DnaGene): string
{
    const n = (v: number | undefined, or: number): number => Math.max(0, Math.min(255, Math.round(v ?? or)));

    if (g.xy)
        return `${g.gene}={ ${n(g.xy[0], 0)} ${n(g.xy[1], 0)} ${n(g.xy2?.[0], g.xy[0])} ${n(g.xy2?.[1], g.xy[1])} }`;

    return `${g.gene}={ "${g.template}" ${n(g.value, 0)} "${g.template2 ?? g.template}" ${n(g.value2, g.value)} }`;
}

function genesBlock(genes: DnaGene[]): string
{
    for (const g of genes)
        if (!KEY.test(g.gene) || (!g.xy && !(g.template && KEY.test(g.template) && (!g.template2 || KEY.test(g.template2)))))
            throw new Error(`The gene ${g.gene} has no valid template.`);

    return ['genes = {', ...genes.map((g) => '\t' + geneLine(g)), '}'].join('\n');
}

const block = (nodes: PNode[], key: string): PNode | undefined => nodes.find((n) => n.k === key && Array.isArray(n.v));

/** Writes a changed script file of the active mod (formatted, checked) and hands it to the index. */
async function put(host: ModsHost, file: string, before: string, bom: boolean, text: string, at: number): Promise<number>
{
    if (scriptProblems(text).length > scriptProblems(before).length)
        throw new Error(`The file would not read right: ${scriptProblems(text)[0]}`);

    const done = formatted(host, file, text);
    write(host, file, (bom ? '﻿' : '') + done);
    const line = lineAt(text, at);
    describeChange({ line });
    await refresh(host, file);
    return line;
}

export function saveDna(host: ModsHost, req: DnaSaveRequest): Promise<ScriptEditResult>
{
    const t = req.target;
    return change(host, `DNA of ${t.character ?? t.name}`, 'edit', async () =>
    {
        const a = await active(host);
        const mod = { id: a.mod.id, name: a.mod.name };
        const genes = genesBlock(req.genes);

        if (!KEY.test(t.name) || (t.character && !KEY.test(t.character)))
            throw new Error('No DNA entry to write.');

        if (t.create)
        {
            if (!t.character)
                throw new Error('No character to give the DNA.');

            // the new dna_data entry, in the mod's own file
            const file = modPath(a, `common/dna_data/${fileTag(a)}_dna.txt`);

            if (!file)
                throw new Error('The mod has no folder to write into.');

            const { text, bom } = existsSync(file) ? readScript(file) : { text: '', bom: true };

            if (block(parse(text), t.name))
                throw new Error(`${t.name} is in ${relIn(a, file)} already.`);

            const { eol } = layoutOf(text || '\n');
            const head = text.trim() ? text.replace(/\s*$/, '') + eol + eol : `# ${a.mod.name}: DNA made in the barbershop (written by CrusaderPope)${eol}${eol}`;
            const entry = [`${t.name} = {`, '\tportrait_info = {', ...genes.split('\n').map((l) => '\t\t' + l), '\t}', '}'].join(eol) + eol;
            await put(host, file, text, bom, head + entry, head.length);

            // the character wears it: `dna = key` in its history — history characters don't override one by one (a copy
            // is a duplicate id), so the mod gets the character's whole file unless it has the character already
            const plan = await planOverride(host, 'characters', t.character);
            const o = await applyOverride(host, { type: 'characters', name: t.character, mode: plan.copy.open ? 'copy' : 'file' });

            if (o.action === 'exists')
                throw new Error(`The mod has a different ${o.rel} already — the character can't be added to it here.`);

            const c = readScript(o.file);
            const cn = block(parse(c.text), t.character);

            if (!cn)
                throw new Error(`${t.character} was not found in ${o.rel}.`);

            const kids = cn.v as PNode[];
            const dna = kids.find((k) => k.k === 'dna');
            const name = kids.find((k) => k.k === 'name');
            const out = dna
                ? applyEdit(c.text, { op: 'replace', at: anchorIn(o.file, o.rel, c.text, dna), text: `dna = ${t.name}` })
                : applyEdit(c.text, { op: 'insert', at: anchorIn(o.file, o.rel, c.text, name ?? cn), where: name ? 'after' : 'inside', text: `dna = ${t.name}` });
            const line = await put(host, o.file, c.text, c.bom, out.text, out.at);
            const whole = o.action === 'replaced' ? [`${o.rel} was copied into the mod whole (history characters can't be overridden one by one).`] : [];
            return { mod, file: o.file, rel: o.rel, line, undo: 0, notes: [`New DNA entry ${t.name} in ${relIn(a, file)}.`, ...whole] };
        }

        // an entry: overridden into the mod (or found there), its genes replaced
        const o = await applyOverride(host, { type: t.type, name: t.name, mode: 'copy' });
        const { text, bom } = readScript(o.file);
        const n = block(parse(text), t.name);
        const body = n ? (t.type === 'dna_data' ? block(block(n.v as PNode[], 'portrait_info')?.v as PNode[] ?? [], 'genes') : block(n.v as PNode[], 'genes')) : undefined;

        if (!body)
            throw new Error(`No genes block of ${t.name} in ${o.rel}.`);

        const out = applyEdit(text, { op: 'replace', at: anchorIn(o.file, o.rel, text, body), text: genes });
        const line = await put(host, o.file, text, bom, out.text, out.at);
        return { mod, file: o.file, rel: o.rel, line, undo: 0, notes: o.action === 'copied' ? [`${t.name} was copied into the mod.`] : [] };
    });
}
