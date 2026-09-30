/**
 * "Try the statement picker" (top bar): opens the picker without the editor — for an effect or a condition — and
 * shows what it built as a notice with the script to copy.
 */
import { useEffect, useRef, useState } from 'react';
import { pushNotice } from '../notices';
import { pickStatement } from './pickStatement';
import '../styles/picker.css';

export function TryPicker(): React.JSX.Element
{
    const [menu, setMenu] = useState<{ right: number; top: number; } | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);

    useEffect(() =>
    {
        if (!menu)
            return;

        const onDown = (e: MouseEvent): void =>
        {
            if (!ref.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node))
                setMenu(null);
        };
        const onKey = (e: KeyboardEvent): void =>
        {
            const k = e.key.toLowerCase();

            if (k === 'escape')
                setMenu(null);
            else if (k === 'e' || k === 'c')
            {
                e.preventDefault();
                run(k === 'e' ? 'effect' : 'trigger');
            }
        };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        return () =>
        {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [menu]);

    const run = (kind: 'effect' | 'trigger'): void =>
    {
        setMenu(null);
        void pickStatement({ kind, title: kind === 'effect' ? 'Try the picker (effect)' : 'Try the picker (condition)' }).then((r) =>
        {
            if (!r)
                return;

            pushNotice({
                kind: 'ok',
                title: `Built ${kind === 'effect' ? 'an effect' : 'a condition'} with the statement picker`,
                text: r.summary ?? '',
                details: r.text.split('\n').map((l) => l.replace(/\t/g, '    ')),
                actions: [{ label: 'Copy script', run: () => void navigator.clipboard.writeText(r.text) }]
            });
        });
    };

    return (
        <>
            <button
                ref={button}
                className="ghost picker-try"
                title="Try the statement picker — build an effect or condition from menus"
                onClick={(e) =>
                {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu(menu ? null : { right: window.innerWidth - r.right, top: r.bottom + 4 });
                }}
            >
                ✚
            </button>
            {menu && (
                <div className="popover picker-try-menu" ref={ref} style={{ right: menu.right, top: menu.top }}>
                    <div className="item" onClick={() => run('effect')}>
                        <span className="pk-key">E</span> Try the statement picker: an effect
                    </div>
                    <div className="item" onClick={() => run('trigger')}>
                        <span className="pk-key">C</span> Try the statement picker: a condition
                    </div>
                </div>
            )}
        </>
    );
}
