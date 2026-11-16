/**
 * One script file's part of a build, without the index (docs/indexer.md, "Parallel parsing"): its definitions and its
 * reference candidates as plain data, made on a parse thread (parseWorker.ts), applied by GameIndex in file order
 * (applyScriptExtract), which then numbers entities, contexts and references exactly as a build on one thread does.
 * The same steps as GameIndex.indexScriptFile: definitions name their entity by their place in `defs`, candidates
 * their owner and target the same way. The candidates are typed columns (transferred, not copied) with their strings
 * once each in `strs` (a column holds a string's place, -1 for none): copying millions of small strings between
 * threads cost more than the parsing saved.
 */
import { parse, type PNode } from './parser.ts';
import { extractDefs, type DefEmit } from './schema.ts';
import { CandidateTable, collectCandidates, extractMeta, Interner, leadingComment } from './gameIndex.ts';

export interface ScriptExtract
{
    defs: {
        type: string[];
        name: string[];
        line: number[];
        start: number[];
        end: number[];
        doc: (string | undefined)[];
        local: number[];
        meta: (Record<string, string> | undefined)[];
    };
    /** the candidates in the order a build collects them */
    cands: {
        size: number;
        /** places in `strs` (-1: null); of a direct reference (flag bit 2) `tok` is the target's def place */
        tok: Int32Array;
        k1: Int32Array;
        k0: Int32Array;
        /** bit 0: isKey, bit 1: quoted, bit 2: a direct reference */
        flags: Uint8Array;
        /** the def place of the owner */
        from: Int32Array;
        line: Int32Array;
        off: Int32Array;
        len: Int32Array;
        /** the context: a place in `strs` */
        ctx: Int32Array;
    };
    strs: string[];
}

/** `hidden`: a file a mod hid: only its definitions count (the game never reads its references). */
export function extractScript(src: string, area: string, type: string, hidden: boolean, fileIdx: number, rel: string): ScriptExtract
{
    const ast = parse(src);
    const consts = new Map<string, string>();

    for (const n of ast)
        if (n.k && n.k.charCodeAt(0) === 64 && typeof n.v === 'string')
            consts.set(n.k.slice(1), n.v);

    const defs: ScriptExtract['defs'] = { type: [], name: [], line: [], start: [], end: [], doc: [], local: [], meta: [] };
    const found: { d: DefEmit; i: number; }[] = [];
    const defNodes = new Set<PNode>();
    const nodeToDef = new Map<PNode, number>();

    extractDefs(area, type, ast, rel, (d) =>
    {
        if (d.name.includes('$'))
            return;

        defNodes.add(d.node);
        const i = defs.type.length;
        nodeToDef.set(d.node, i);
        found.push({ d, i });
        const startNode = d.startNode ?? d.node;
        defs.type.push(d.type);
        defs.name.push(d.name);
        defs.line.push(startNode.line);
        defs.start.push(startNode.s);
        defs.end.push(d.node.e);
        defs.doc.push(leadingComment(src, startNode.s));
        defs.local.push(d.local ? 1 : 0);
        defs.meta.push(extractMeta(d.type, d.node, consts));
    });

    const cands = new CandidateTable();
    const ctx = new Interner();

    if (!hidden)
    {
        for (const { d, i } of found)
        {
            if (d.parent)
            {
                const parent = nodeToDef.get(d.parent);

                if (parent !== undefined)
                    cands.addDirect(i, parent, fileIdx, d.node.line, d.node.s, d.node.kl, ctx.id('(parent)'));
            }

            if (Array.isArray(d.node.v))
                collectCandidates(d.node.v, i, fileIdx, [], defNodes, cands, ctx, consts);
            else if (typeof d.node.v === 'string' && d.node.v)
                cands.add(d.node.v, d.node.k, null, false, i, fileIdx, d.node.line, d.node.vs, d.node.e - d.node.vs, ctx.id(d.node.k ?? ''));
        }
    }

    // the columns in one typed array each (the table's blocks joined), the strings once each, the contexts among them
    const strs = cands.strs;
    const n = cands.size;
    const out: ScriptExtract['cands'] = {
        size: n,
        tok: new Int32Array(n),
        k1: new Int32Array(n),
        k0: new Int32Array(n),
        flags: new Uint8Array(n),
        from: new Int32Array(n),
        line: new Int32Array(n),
        off: new Int32Array(n),
        len: new Int32Array(n),
        ctx: new Int32Array(n)
    };

    for (const ch of cands.chunks)
    {
        out.tok.set(ch.tok.subarray(0, ch.n), ch.base);
        out.k1.set(ch.k1.subarray(0, ch.n), ch.base);
        out.k0.set(ch.k0.subarray(0, ch.n), ch.base);
        out.flags.set(ch.flags.subarray(0, ch.n), ch.base);
        out.from.set(ch.from.subarray(0, ch.n), ch.base);
        out.line.set(ch.line.subarray(0, ch.n), ch.base);
        out.off.set(ch.off.subarray(0, ch.n), ch.base);
        out.len.set(ch.len.subarray(0, ch.n), ch.base);

        for (let k = 0; k < ch.n; k++)
            out.ctx[ch.base + k] = strs.id(ctx.list[ch.ctx[k]]);
    }

    return { defs, cands: out, strs: strs.list };
}

/** The buffers of an extract (moved to the receiving thread, not copied). */
export function extractBuffers(ex: ScriptExtract): ArrayBuffer[]
{
    const c = ex.cands;
    return [c.tok, c.k1, c.k0, c.flags, c.from, c.line, c.off, c.len, c.ctx].map((a) => a.buffer as ArrayBuffer);
}
