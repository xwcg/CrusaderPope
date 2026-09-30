/**
 * Editing in place (docs/mods.md, "Editing in place"): what the readable view's rows need from the editing
 * controller (components/InPlaceEdit.tsx) — kept apart so rich.tsx can use it without importing the editor.
 */
import { createContext, type ReactNode } from 'react';
import type { Line, LineAct, LineSource, SectionSource } from '../../../shared/api';

/** A row's identity: the statement's offsets in its file (unique within the view). */
export const anchorKey = (src: LineSource): string => `${src.rel}:${src.s}:${src.e}`;

export interface LineEditing
{
    /** the active mod (the one edited) */
    mod: { id: string; name: string; };
    /** the statement is written in the active mod: it can be edited here */
    can(src: LineSource | undefined): boolean;
    /** the entry shown is written in the active mod (its texts are edited in place) */
    entry: boolean;
    /** the selected row (keyboard: ↑ ↓ move it) */
    selected: string | null;
    select(key: string | null): void;
    /** hover actions of an anchored row: ✎ edit, ✕ remove, ＋ add after (and inside for blocks) */
    actions(src: LineSource, line?: Line): ReactNode;
    /**
     * a row of a scripted effect / trigger the entry calls that is not the active mod's (LineSource.owner): ✎ offers
     * to override it into the mod, then edits the line there
     */
    offer(src: LineSource, line?: Line): ReactNode;
    /** the in-place editor, when it is open under this row */
    editor(key: string): ReactNode;
    /**
     * "＋ Add …" for a section (also empty or not written yet); `template`: the script editor opens with it instead of
     * the statement picker (a new option)
     */
    sectionAdd(section: SectionSource | undefined, title: string, label: string, template?: string): ReactNode;
    /** a row's or section's own action (a placeholder's "choose", "＋ faith" …): shown when its entry is the active mod's */
    act(a: LineAct, line?: Line): ReactNode;
    /** a line's localization text (Line.locKey) with "✎ text": changed in place (LocEditable) */
    locText(key: string, children: ReactNode): ReactNode;
}

export const EditCtx = createContext<LineEditing | null>(null);

/** A section's block, or the statement it would be created in. */
export const sectionSrc = (s: SectionSource | undefined): LineSource | undefined => s?.src ?? s?.before ?? s?.parent;
