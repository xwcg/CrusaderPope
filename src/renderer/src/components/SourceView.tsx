import { useMemo, useState, type ReactNode } from 'react';
import type { DefSiteView, EntityKey, LinkSpan } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { TargetMenu, openTitle, revealTitle } from './common';
import { HiddenNote, OriginTag } from './ModChip';
import { OverrideButton } from './OverrideMenu';
import { SourceEditor } from './InPlaceEdit';
import { useActiveMod } from '../modStore';

const MAX_LINES = 2500;

/** @param entity the entry the definitions belong to: its winning definition offers "Override in the active mod" */
export function SourceView(props: { defs: DefSiteView[]; navigate: Navigate; entity?: EntityKey; }): React.JSX.Element
{
    // the winning definition: the last one outside files a mod hid (a landed title written only as the way to one inside
    // it changes nothing — the one before it, unless that is all there is)
    let win = -1;
    let path = -1;
    props.defs.forEach((d, i) =>
    {
        if (d.origin?.hiddenBy)
            return;

        if (d.path)
            path = i;
        else
            win = i;
    });

    if (win < 0)
        win = path;

    // newest (winning) definition first; definitions in files a mod hid come first in the list, so they end up last
    const defs = props.defs.map((d, i) => ({ d, i })).reverse();
    return (
        <>
            {defs.map(({ d, i }) => <DefSite key={d.file + ':' + d.line + ':' + i} def={d} navigate={props.navigate} entity={i === win ? props.entity : undefined} />)}
        </>
    );
}

function DefSite({ def, navigate, entity }: { def: DefSiteView; navigate: Navigate; entity?: EntityKey; }): React.JSX.Element
{
    const [showAll, setShowAll] = useState(false);
    const [menu, setMenu] = useState<{ x: number; y: number; targets: EntityKey[]; } | null>(null);
    // the winning definition written in the active mod (loaded): a plain text editor (docs/mods.md, "Editing in place")
    const active = useActiveMod();
    const [editing, setEditing] = useState(false);
    const editable = !!entity && !!def.src?.mod && !!active.mod && active.loaded && def.src.mod.toLowerCase() === active.mod.id.toLowerCase() && /\.(txt|yml)$/i.test(def.file);
    const totalLines = def.endLine - def.line + 1;

    const { source, links } = useMemo(() =>
    {
        if (showAll || totalLines <= MAX_LINES)
            return { source: def.source, links: def.links };

        let cut = 0;

        for (let i = 0; i < MAX_LINES; i++)
        {
            const nl = def.source.indexOf('\n', cut);

            if (nl < 0)
                break;

            cut = nl + 1;
        }

        return { source: def.source.slice(0, cut), links: def.links.filter((l) => l.end <= cut) };
    }, [def, showAll, totalLines]);

    const lineCount = source.split('\n').length;
    const gutter = useMemo(() =>
    {
        const out: string[] = [];

        for (let i = 0; i < lineCount; i++)
            out.push(String(def.line + i));

        return out.join('\n');
    }, [lineCount, def.line]);

    const highlighted = useMemo(() => highlight(source, links), [source, links]);

    const onClick = (e: React.MouseEvent): void =>
    {
        const el = (e.target as HTMLElement).closest('[data-link]') as HTMLElement | null;

        if (!el)
            return;

        const link = links[Number(el.dataset.link)];

        if (!link)
            return;

        if (link.targets.length === 1)
            navigate(link.targets[0]);
        else
            setMenu({ x: e.clientX, y: e.clientY, targets: link.targets });
    };

    return (
        <div className={'def-site' + (def.origin?.hiddenBy ? ' hidden-def' : '')}>
            <header>
                <OriginTag origin={def.origin} />
                <span className="path" title={def.absPath}>
                    {def.file}:{def.line}–{def.endLine}
                </span>
                <HiddenNote origin={def.origin} />
                {def.overridden && <span className="chip warn" title="A later definition with the same key replaces this one">overridden</span>}
                {def.path && (
                    <span className="chip" title="Written only as the way to a title inside it (nothing but its de jure vassals): the game adds it to the title it has, so it changes nothing here">
                        only the way in
                    </span>
                )}
                {def.local && <span className="chip">file-local</span>}
                {entity && !editable && <OverrideButton type={entity.type} name={entity.name} navigate={navigate} compact />}
                {editable && (
                    <button className={'override-btn compact' + (editing ? ' on' : '')} onClick={() => setEditing((v) => !v)} title={`Edit this definition of ${active.mod?.name} here (checked before saving; undo in the notice)`}>
                        ✎ {editing ? 'Editing' : 'Edit'}
                    </button>
                )}
                <button onClick={() => void api.openFile(def.absPath, def.line)} title={openTitle(def.absPath, `Open ${def.file}:${def.line} in VS Code`)}>
                    Open in VS Code
                </button>
                <button onClick={() => void api.revealFile(def.absPath)} title={revealTitle(def.absPath, 'Show the file in its folder')}>
                    Reveal
                </button>
            </header>
            {def.doc && <pre className="doc-comment">{def.doc}</pre>}
            {editing && def.src ? <SourceEditor src={def.src} onClose={() => setEditing(false)} /> : (
                <div className="code">
                    <pre className="gutter">{gutter}</pre>
                    <pre onClick={onClick}>{highlighted}</pre>
                </div>
            )}
            {totalLines > MAX_LINES && !showAll && !editing && (
                <div className="truncated-note">
                    Showing {MAX_LINES} of {totalLines} lines.
                    <button onClick={() => setShowAll(true)}>Show all</button>
                </div>
            )}
            {menu && (
                <TargetMenu
                    x={menu.x}
                    y={menu.y}
                    targets={menu.targets}
                    onClose={() => setMenu(null)}
                    onPick={(t) =>
                    {
                        setMenu(null);
                        navigate(t);
                    }}
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

interface Tok
{
    s: number;
    e: number;
    cls: string;
}

const WS = /\s/;
const WORD_END = /[\s{}=<>"#]/;
const TAGS = new Set(['rgb', 'hsv', 'hsv360', 'hex', 'LIST', 'list']);

function lex(src: string): Tok[]
{
    const toks: Tok[] = [];
    const n = src.length;
    let i = 0;

    while (i < n)
    {
        const c = src[i];

        if (c === '#')
        {
            let j = src.indexOf('\n', i);

            if (j < 0)
                j = n;

            toks.push({ s: i, e: j, cls: 'tok-comment' });
            i = j;
        }
        else if (c === '"')
        {
            let j = i + 1;

            while (j < n && src[j] !== '"')
                j += src[j] === '\\' ? 2 : 1;

            j = Math.min(j + 1, n);
            toks.push({ s: i, e: j, cls: 'tok-string' });
            i = j;
        }
        else if (c === '{' || c === '}')
        {
            toks.push({ s: i, e: i + 1, cls: 'tok-brace' });
            i++;
        }
        else if (c === '=' || c === '<' || c === '>' || ((c === '!' || c === '?') && src[i + 1] === '='))
        {
            const j = src[i + 1] === '=' ? i + 2 : i + 1;
            toks.push({ s: i, e: j, cls: 'tok-op' });
            i = j;
        }
        else if (WS.test(c))
        {
            let j = i + 1;

            while (j < n && WS.test(src[j]))
                j++;

            toks.push({ s: i, e: j, cls: '' });
            i = j;
        }
        else
        {
            let j = i + 1;

            if (c === '@' && src[i + 1] === '[')
            {
                j = src.indexOf(']', i);
                j = j < 0 ? n : j + 1;
            }
            else
            {
                while (j < n && !WORD_END.test(src[j]) && !((src[j] === '!' || src[j] === '?') && src[j + 1] === '='))
                    j++;
            }

            toks.push({ s: i, e: j, cls: 'word' });
            i = j;
        }
    }

    for (let k = 0; k < toks.length; k++)
    {
        const t = toks[k];

        if (t.cls !== 'word')
            continue;

        const w = src.slice(t.s, t.e);
        let m = k + 1;

        while (m < toks.length && toks[m].cls === '')
            m++;

        const next = toks[m];

        if (next && (next.cls === 'tok-op' || (next.cls === 'tok-brace' && src[next.s] === '{' && !TAGS.has(w))))
            t.cls = 'tok-key';
        else if (w === 'yes' || w === 'no')
            t.cls = 'tok-bool';
        else if (/^-?\d+(\.\d+)*%?$/.test(w))
            t.cls = 'tok-number';
        else if (w.startsWith('@'))
            t.cls = 'tok-const';
        else if (w.includes('$'))
            t.cls = 'tok-param';
        else if (/^(scope|var|local_var|global_var|flag):/.test(w) || /^(root|this|prev|from)(\.|$)/i.test(w))
            t.cls = 'tok-scope';
        else
            t.cls = '';
    }

    return toks;
}

function highlight(src: string, links: LinkSpan[]): ReactNode[]
{
    const toks = lex(src);
    const out: ReactNode[] = [];
    let li = 0;
    let plain = '';
    const flush = (): void =>
    {
        if (plain)
        {
            out.push(plain);
            plain = '';
        }
    };

    for (let k = 0; k < toks.length; k++)
    {
        const t = toks[k];

        while (li < links.length && links[li].start < t.s)
            li++;

        const text = src.slice(t.s, t.e);
        const link = li < links.length && links[li].start === t.s ? links[li] : undefined;

        if (link)
        {
            flush();
            const title = link.targets.map((x) => `${x.type}: ${x.name}`).join('\n');
            out.push(
                <span key={k} data-link={li} className={(t.cls ? t.cls + ' ' : '') + 'ref' + (link.targets.length > 1 ? ' multi' : '')} title={title}>
                    {text}
                </span>
            );
            li++;
        }
        else if (t.cls)
        {
            flush();
            out.push(
                <span key={k} className={t.cls}>
                    {text}
                </span>
            );
        }
        else
            plain += text;
    }

    flush();
    return out;
}
