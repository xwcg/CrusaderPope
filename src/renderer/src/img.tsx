import { useState } from 'react';
import { fileVersion, useRevision } from './revision';

/**
 * ck3:// URL of a game image (DDS/PNG, decoded in the main process). `w` = max size of the longer side; `ch` shows one
 * channel ('r' 'g' 'b' 'a' as grey) or 'rgb' without alpha. A file an index update changed carries `v` (the revision):
 * a new URL, not the renderer's cached copy. `removed`: the picture a mod's replace_path hid (the former file).
 */
export function imgUrl(path: string, w?: number, ch?: string, removed?: boolean): string
{
    const v = fileVersion(path);
    const q = [w ? `w=${w}` : '', ch ? `ch=${ch}` : '', v ? `v=${v}` : '', removed ? 'removed=1' : ''].filter(Boolean).join('&');
    return 'ck3://img/' + path.split('/')
        .map(encodeURIComponent)
        .join('/') +
        (q ? '?' + q : '');
}

/** Game image that disappears when it can't be loaded (and tries again once an index update brings a new version). */
export function GameImg(props: { path?: string; size?: number; className?: string; alt?: string; title?: string; style?: React.CSSProperties; ch?: string; removed?: boolean; }): React.JSX.Element | null
{
    const [failed, setFailed] = useState<string | null>(null);
    // (re-rendered by every index revision: the URL of a changed file changes)
    useRevision();
    const px = props.size ? Math.min(1024, Math.ceil(props.size * (window.devicePixelRatio || 1))) : undefined;
    const src = props.path ? imgUrl(props.path, px, props.ch, props.removed) : '';

    if (!props.path || failed === src)
        return null;

    return (
        <img
            src={src}
            className={props.className}
            alt={props.alt ?? ''}
            title={props.title}
            style={props.style}
            loading="lazy"
            draggable={false}
            onError={() => setFailed(src)}
        />
    );
}
