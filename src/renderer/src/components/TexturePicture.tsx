import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Navigate } from '../App';
import { imgUrl } from '../img';
import { useGfxRevision } from '../revision';

const CHANNELS = [
    ['', 'RGBA', 'As the game stores it, transparency shown as a checkerboard'],
    ['rgb', 'RGB', 'Colour without the alpha channel'],
    ['r', 'R', 'Red channel as grey'],
    ['g', 'G', 'Green channel as grey'],
    ['b', 'B', 'Blue channel as grey'],
    ['a', 'A', 'Alpha channel as grey (packed maps keep data here: normal Y, roughness, palette masks)']
] as const;

/** A game image at card size with channel inspection (textures pack separate data into R, G, B and A). */
export function TexturePicture(props: { path: string; size: number; }): React.JSX.Element
{
    const [ch, setCh] = useState('');
    const [failed, setFailed] = useState<string | null>(null);
    // (a changed texture has a new URL)
    useGfxRevision();
    useEffect(() => setCh(''), [props.path]);
    const px = Math.min(2048, Math.ceil(props.size * (window.devicePixelRatio || 1)));
    const src = imgUrl(props.path, px, ch || undefined);
    return (
        <div className="tex-picture">
            <div className="rpg-picture checker">
                {failed !== src && <img src={src} alt="" draggable={false} onError={() => setFailed(src)} />}
            </div>
            <div className="tex-channels">
                {CHANNELS.map(([id, label, tip]) => (
                    <button key={label} className={'chip' + (ch === id ? ' accent' : '') + (id ? ' ch-' + id : '')} title={tip} onClick={() => setCh(id)}>
                        {label}
                    </button>
                ))}
            </div>
        </div>
    );
}

/** 3D model files whose materials use this texture. */
export function TextureUsers(props: { path: string; navigate: Navigate; }): React.JSX.Element | null
{
    const [users, setUsers] = useState<{ asset: string; pdxmesh: string; role: string; }[] | null>(null);
    const gfx = useGfxRevision();
    useEffect(() => setUsers(null), [props.path]);
    useEffect(() =>
    {
        let cancelled = false;
        void api.textureUsers(props.path).then((u) => !cancelled && setUsers(u));
        return () =>
        {
            cancelled = true;
        };
    }, [props.path, gfx]);

    if (!users?.length)
        return null;

    // one row per asset file: its pdxmeshes and the roles the texture plays there
    const byAsset = new Map<string, { meshes: Set<string>; roles: Set<string>; }>();

    for (const u of users)
    {
        const e = byAsset.get(u.asset) ?? { meshes: new Set(), roles: new Set() };
        e.meshes.add(u.pdxmesh);
        e.roles.add(u.role);
        byAsset.set(u.asset, e);
    }

    const rows = [...byAsset.entries()];
    return (
        <div className="texture-users">
            <div>
                <div className="rpg-section-title">Used by 3D models ({rows.length})</div>
                <div className="tex-users">
                    {rows.slice(0, 200).map(([asset, e]) => (
                        <div key={asset} className="tex-user">
                            <span className="rt-link" data-ref-type="models" data-ref-name={asset} onClick={() => props.navigate({ type: 'models', name: asset })}>
                                {asset.slice(asset.lastIndexOf('/') + 1)}
                            </span>
                            <span className="pr-dim">
                                {' '}
                                {[...e.roles].join(', ')} · {[...e.meshes].slice(0, 3).join(', ')}
                                {e.meshes.size > 3 ? ` +${e.meshes.size - 3}` : ''}
                            </span>
                        </div>
                    ))}
                    {rows.length > 200 && <div className="pr-dim">… and {rows.length - 200} more</div>}
                </div>
            </div>
        </div>
    );
}
