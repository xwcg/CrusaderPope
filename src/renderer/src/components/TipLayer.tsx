/**
 * The app's own tooltips in place of the browser's (docs/app-architecture.md, "Tooltips"): any element with a `title`
 * (React's or set by plain DOM code) has it moved to `data-tip` when the mouse reaches it (the browser then shows
 * nothing) and gets a small card in the hover cards' look, next to the mouse. Elements linking a game entry
 * (`data-ref-type`) show their entry's hover card instead (HoverCardLayer, rich.tsx). Line breaks in a title stay line
 * breaks. Like a hover card, a middle click pins the tip shown: it stays (its text can be selected and copied) until ×,
 * Esc or a click outside it. A modifier key alone (Shift, Ctrl, Alt, the Windows key: a screenshot's shortcut) leaves
 * the tip where it is, and so does the window losing the focus (a screenshot tool takes it); any other key, a click and
 * the wheel hide the tip that follows the mouse.
 */
import { useEffect, useRef, useState } from 'react';
import { tr } from '../../../shared/i18n';

const DELAY = 450;

/** Keys that only modify another (and the screenshot keys): pressing them keeps the tip. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'CapsLock', 'Fn', 'PrintScreen']);

type Shown = { text: string; x: number; y: number; pinned: boolean; };

/** The element whose tip to show for a mouse target: the nearest with a title (moved to data-tip) or data-tip. */
function tipOwner(target: Element | null): HTMLElement | SVGElement | null
{
    // (an entry link nearer than any tip: its hover card, no tip; the titles above it are moved all the same, or the
    // browser shows the nearest one beside the card (a line's raw script) when the mouse went straight onto the link)
    let link = false;

    for (let el: Element | null = target; el && el !== document.body; el = el.parentElement)
    {
        if (el.hasAttribute('data-ref-type'))
            link = true;

        // (a pinned tip itself: no tip of its own)
        if (el.classList.contains('tipcard'))
            return null;

        const title = el.getAttribute('title');

        if (title !== null)
        {
            el.removeAttribute('title');

            if (title)
                el.setAttribute('data-tip', title);
            else
                el.removeAttribute('data-tip');
        }

        if (!link && el.getAttribute('data-tip'))
            return el as HTMLElement;
    }

    return null;
}

export function TipLayer(): React.JSX.Element | null
{
    const [shown, setShown] = useState<Shown | null>(null);
    const [pinned, setPinned] = useState<Shown | null>(null);
    const shownRef = useRef<Shown | null>(null);
    shownRef.current = shown;
    const timer = useRef<number | undefined>(undefined);
    const current = useRef<Element | null>(null);
    const mouse = useRef({ x: 0, y: 0 });

    // (the element of the tip shown taken out of the page under a mouse that does not move (a dialog closed, another
    // page): no mouseover follows, so the tip would stay; it goes with its element)
    useEffect(() =>
    {
        if (!shown)
            return;

        const t = window.setInterval(() =>
        {
            if (!current.current?.isConnected)
            {
                current.current = null;
                setShown(null);
            }
        }, 300);
        return () => window.clearInterval(t);
    }, [shown]);

    useEffect(() =>
    {
        const hide = (): void =>
        {
            window.clearTimeout(timer.current);
            current.current = null;
            setShown(null);
        };
        const move = (e: MouseEvent): void =>
        {
            mouse.current = { x: e.clientX, y: e.clientY };
        };
        const over = (e: MouseEvent): void =>
        {
            mouse.current = { x: e.clientX, y: e.clientY };
            const el = tipOwner(e.target as Element);

            if (el === current.current)
                return;

            hide();

            if (!el)
                return;

            current.current = el;
            timer.current = window.setTimeout(() =>
            {
                const text = el.getAttribute('data-tip');

                if (!text || current.current !== el || !el.isConnected)
                    return;

                setShown({ text, x: mouse.current.x, y: mouse.current.y, pinned: false });
            }, DELAY);
        };
        const down = (e: MouseEvent): void =>
        {
            const tip = shownRef.current;

            // (the middle button while a tip shows: pin it, not the browser's auto-scroll)
            if (e.button === 1 && tip)
            {
                e.preventDefault();
                setPinned({ ...tip, pinned: true });
                hide();
                return;
            }

            // (a click outside the pinned tip closes it)
            if (e.button === 0 && !(e.target as Element | null)?.closest?.('.tipcard.pinned'))
                setPinned(null);

            hide();
        };
        const key = (e: KeyboardEvent): void =>
        {
            if (MODIFIER_KEYS.has(e.key))
                return;

            if (e.key === 'Escape')
                setPinned(null);

            hide();
        };
        document.addEventListener('mouseover', over, true);
        document.addEventListener('mousemove', move, { capture: true, passive: true });
        document.addEventListener('mousedown', down, true);
        document.addEventListener('wheel', hide, { capture: true, passive: true });
        document.addEventListener('keydown', key, true);
        return () =>
        {
            window.clearTimeout(timer.current);
            document.removeEventListener('mouseover', over, true);
            document.removeEventListener('mousemove', move, { capture: true });
            document.removeEventListener('mousedown', down, true);
            document.removeEventListener('wheel', hide, { capture: true });
            document.removeEventListener('keydown', key, true);
        };
    }, []);

    return (
        <>
            {pinned && <TipCard shown={pinned} onClose={() => setPinned(null)} />}
            {shown && <TipCard shown={shown} />}
        </>
    );
}

/** The card: next to the mouse (below and to the right), kept inside the window (above it when there's no room below). */
function TipCard(props: { shown: Shown; onClose?: () => void; }): React.JSX.Element
{
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ left: number; top: number; } | null>(null);

    useEffect(() =>
    {
        const el = ref.current;

        if (!el)
            return;

        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const { x, y } = props.shown;
        const left = Math.max(6, Math.min(x + 12, window.innerWidth - w - 6));
        const below = y + 20;
        setPos({ left, top: below + h > window.innerHeight - 6 ? Math.max(6, y - h - 10) : below });
    }, [props.shown]);

    return (
        <div ref={ref} className={'tipcard' + (props.shown.pinned ? ' pinned' : '')} style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}>
            {props.shown.pinned && (
                <button className="hc-close" title={tr('Close (Esc)')} onClick={props.onClose}>
                    ×
                </button>
            )}
            {props.shown.text}
        </div>
    );
}
