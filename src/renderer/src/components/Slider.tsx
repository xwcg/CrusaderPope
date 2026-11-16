import { tr } from '../../../shared/i18n';

/**
 * Every slider of the app (docs/app-architecture.md, "Sliders"): a range input with its default marked by a pip under
 * the track, and a double click going back to it. `defaultValue` is where the pip sits; `onReset` (when the default is
 * not a plain value: a zoom that fits the stage) does the going back, else `onChange(defaultValue)`.
 */
export function Slider(props: {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (v: number) => void;
    defaultValue?: number;
    onReset?: () => void;
    /** how the default reads in the tooltip ("1066", "fit") */
    defaultLabel?: string;
    className?: string;
    inputClassName?: string;
    title?: string;
    'aria-label'?: string;
    disabled?: boolean;
}): React.JSX.Element
{
    const d = props.defaultValue;
    const has = d !== undefined && Number.isFinite(d) && props.max > props.min;
    const frac = has ? Math.max(0, Math.min(1, (d - props.min) / (props.max - props.min))) : 0;
    const back = has || props.onReset ? tr('Double-click: back to {defaultLabel}', { defaultLabel: props.defaultLabel ?? String(d) }) : undefined;
    const title = [props.title, back].filter(Boolean).join('\n') || undefined;
    const reset = (): void =>
    {
        if (props.disabled)
            return;

        if (props.onReset)
            props.onReset();
        else if (has && d !== props.value)
            props.onChange(d);
    };
    return (
        <span className={'slider' + (props.className ? ' ' + props.className : '')} title={title}>
            <input
                type="range"
                className={props.inputClassName}
                min={props.min}
                max={props.max}
                step={props.step}
                value={props.value}
                disabled={props.disabled}
                aria-label={props['aria-label']}
                onChange={(e) => props.onChange(Number(e.target.value))}
                onDoubleClick={reset}
            />
            {/* (the thumb is 14px wide: its centre runs from 7px to the width less 7px) */}
            {has && <span className={'slider-pip' + (d === props.value ? ' at' : '')} style={{ left: `calc(7px + (100% - 14px) * ${frac})` }} aria-hidden />}
        </span>
    );
}
