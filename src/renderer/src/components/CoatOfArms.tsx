import { useEffect, useRef, useState } from 'react';
import type { CoaInfo, CoaKind } from '../../../shared/api';
import { useRevision } from '../revision';
import { coaInfo, coaPicture, coaSignature, setCoaRevision } from './coa-draw';
import '../styles/coa.css';

/**
 * A landed title's, dynasty's or house's coat of arms (`name`: its key; dynasties by id) as the game's interface shows
 * it, in its frame, `size` CSS pixels square (the frame included; kind `coa` has none). Nothing when there are none.
 * `date` (y.m.d): the history date a title's arms are shown at (the map's: a game started then — holders' house arms,
 * dynamic definitions); none: the first bookmark's. A new date only redraws when the arms differ.
 */
export function CoatOfArms(props: { kind: CoaKind; name: string; size: number; className?: string; date?: string; }): React.JSX.Element | null
{
    const { kind, name, size, date } = props;
    const revision = useRevision();
    const ref = useRef<HTMLCanvasElement>(null);
    const [info, setInfo] = useState<{ id: string; info: CoaInfo | null; } | null>(null);
    const box = Math.round(size * (window.devicePixelRatio || 1));
    const id = `${kind}:${name}`;
    const shown = info?.id === id ? info.info : undefined;

    useEffect(() =>
    {
        let live = true;
        setCoaRevision(revision);
        void coaInfo(kind, name, date).then((i) => live && setInfo((old) => (old?.id === id && old.info === i ? old : { id, info: i })));
        return () =>
        {
            live = false;
        };
    }, [kind, name, id, date, revision]);

    useEffect(() =>
    {
        if (!shown)
            return;

        // (the canvas remembers what it shows: the same arms at another date are not drawn again)
        const what = `${revision}|${box}|${coaSignature(shown)}`;

        if (ref.current?.dataset.coa === what)
            return;

        let live = true;
        void coaPicture(shown, box).then((pic) =>
        {
            const c = ref.current;

            if (!live || !c || !pic)
                return;

            c.width = box;
            c.height = box;
            const g = c.getContext('2d')!;
            g.clearRect(0, 0, box, box);
            g.drawImage(pic, 0, 0);
            c.dataset.coa = what;
        });
        return () =>
        {
            live = false;
        };
    }, [shown, box, revision]);

    if (shown === null)
        return null;

    return <canvas ref={ref} className={'coa' + (props.className ? ' ' + props.className : '')} style={{ width: size, height: size }} title={shown?.note} />;
}
