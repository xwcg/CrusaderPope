/**
 * Parser and writer for Paradox's binary asset container (`.mesh`, `.anim`): header `@@b@`, then a stream of
 * objects (`[` repeated depth times + zero-terminated name) and properties (`!` + name length byte + name +
 * type 'i' | 'f' | 's' + int32 count + data). An object's properties come before its children. Reference:
 * ross-g/io_pdx_mesh (pdx_data.py). Vanilla files write property names without and strings with a terminating zero
 * (one string per property); `writePdx(parsePdx(file))` gives the file back byte for byte (docs/blender.md).
 */

export type PdxValue = Int32Array | Float32Array | string[];

export interface PdxNode
{
    name: string;
    props: Record<string, PdxValue>;
    children: PdxNode[];
}

/** little-endian host: typed arrays can take the file's bytes as they are (exact, NaN payloads included) */
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function parsePdx(buf: Uint8Array): PdxNode
{
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    if (buf[0] !== 0x40 || buf[1] !== 0x40 || buf[2] !== 0x62 || buf[3] !== 0x40)
        throw new Error('Not a PDX binary file');

    const root: PdxNode = { name: 'file', props: {}, children: [] };
    const stack: PdxNode[] = [root];
    let pos = 4;
    const len = buf.length;
    const latin1 = (start: number, end: number): string =>
    {
        let s = '';

        for (let i = start; i < end; i++)
            s += String.fromCharCode(buf[i]);

        return s;
    };

    while (pos < len)
    {
        const c = buf[pos];

        if (c === 0x5b /* [ */)
        {
            let depth = 0;

            while (buf[pos] === 0x5b)
            {
                depth++;
                pos++;
            }

            const start = pos;

            while (pos < len && buf[pos] !== 0)
                pos++;

            const node: PdxNode = { name: latin1(start, pos), props: {}, children: [] };
            pos++;
            stack.length = depth; // parent is at index depth-1
            stack[depth - 1].children.push(node);
            stack.push(node);
        }
        else if (c === 0x21 /* ! */)
        {
            pos++;
            const nameLen = buf[pos];
            pos++;
            let name = latin1(pos, pos + nameLen);

            if (name.endsWith('\0'))
                name = name.slice(0, -1);

            pos += nameLen;
            const type = String.fromCharCode(buf[pos]);
            pos++;
            const count = dv.getInt32(pos, true);
            pos += 4;
            let value: PdxValue;

            if (type === 'i')
            {
                value = new Int32Array(count);

                if (LE)
                    new Uint8Array(value.buffer).set(buf.subarray(pos, pos + count * 4));
                else
                    for (let i = 0; i < count; i++)
                        value[i] = dv.getInt32(pos + i * 4, true);

                pos += count * 4;
            }
            else if (type === 'f')
            {
                value = new Float32Array(count);

                // (a copy of the bytes: reading through numbers could change NaN payloads — one vanilla mesh has NaN UVs)
                if (LE)
                    new Uint8Array(value.buffer).set(buf.subarray(pos, pos + count * 4));
                else
                    for (let i = 0; i < count; i++)
                        value[i] = dv.getFloat32(pos + i * 4, true);

                pos += count * 4;
            }
            else if (type === 's')
            {
                const strings: string[] = [];

                for (let i = 0; i < count; i++)
                {
                    const sl = dv.getInt32(pos, true);
                    pos += 4;
                    let s = latin1(pos, pos + sl);

                    if (s.endsWith('\0'))
                        s = s.slice(0, -1);

                    strings.push(s);
                    pos += sl;
                }

                value = strings;
            }
            else
            {
                throw new Error(`Unknown PDX data type '${type}' at ${pos}`);
            }

            stack[stack.length - 1].props[name] = value;
        }
        else
        {
            throw new Error(`Unexpected byte 0x${c.toString(16)} at ${pos}`);
        }
    }

    return root;
}

/**
 * The binary file of a tree as parsePdx returns it: the root's properties (`pdxasset`), then every child object at
 * depth 1, 2, … with its properties before its children. Names and strings are Latin-1.
 */
export function writePdx(root: PdxNode): Uint8Array
{
    const chunks: Uint8Array[] = [Uint8Array.of(0x40, 0x40, 0x62, 0x40)];
    let size = 4;
    const push = (b: Uint8Array): void =>
    {
        chunks.push(b);
        size += b.length;
    };
    const latin1 = (s: string, nul: boolean): Uint8Array =>
    {
        const out = new Uint8Array(s.length + (nul ? 1 : 0));

        for (let i = 0; i < s.length; i++)
            out[i] = s.charCodeAt(i) & 0xff;

        return out;
    };
    const int32 = (n: number): Uint8Array =>
    {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setInt32(0, n, true);
        return b;
    };
    const numbers = (v: Int32Array | Float32Array): Uint8Array =>
    {
        if (LE)
            return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

        const b = new Uint8Array(v.length * 4);
        const dv = new DataView(b.buffer);

        for (let i = 0; i < v.length; i++)
        {
            if (v instanceof Int32Array)
                dv.setInt32(i * 4, v[i], true);
            else
                dv.setFloat32(i * 4, v[i], true);
        }

        return b;
    };
    const props = (n: PdxNode): void =>
    {
        for (const [name, v] of Object.entries(n.props))
        {
            if (name.length > 255)
                throw new Error(`PDX property name too long: ${name}`);

            push(Uint8Array.of(0x21, name.length));
            push(latin1(name, false));

            if (Array.isArray(v))
            {
                push(Uint8Array.of(0x73));
                push(int32(v.length));

                for (const s of v)
                {
                    push(int32(s.length + 1));
                    push(latin1(s, true));
                }
            }
            else
            {
                push(Uint8Array.of(v instanceof Int32Array ? 0x69 : 0x66));
                push(int32(v.length));
                push(numbers(v));
            }
        }
    };
    const object = (n: PdxNode, depth: number): void =>
    {
        push(new Uint8Array(depth).fill(0x5b));
        push(latin1(n.name, true));
        props(n);

        for (const c of n.children)
            object(c, depth + 1);
    };
    props(root);

    for (const c of root.children)
        object(c, 1);

    const out = new Uint8Array(size);
    let pos = 0;

    for (const c of chunks)
    {
        out.set(c, pos);
        pos += c.length;
    }

    return out;
}

export function find(node: PdxNode, name: string): PdxNode | undefined
{
    return node.children.find((c) => c.name === name);
}

/** Debug helper: prints the tree with property sizes. */
export function describePdx(node: PdxNode, depth = 0, maxChildren = 12): string
{
    const pad = '  '.repeat(depth);
    const props = Object.entries(node.props)
        .map(([k, v]) => `${k}:${Array.isArray(v) ? JSON.stringify(v).slice(0, 60) : v.constructor.name.replace('Array', '') + '[' + v.length + ']'}`)
        .join(' ');
    let out = `${pad}${node.name} ${props}\n`;
    node.children.slice(0, maxChildren).forEach((c) => (out += describePdx(c, depth + 1, maxChildren)));

    if (node.children.length > maxChildren)
        out += `${pad}  … ${node.children.length - maxChildren} more\n`;

    return out;
}
