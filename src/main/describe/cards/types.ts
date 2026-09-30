/**
 * Per-type card builders (docs/readable-view.md, "Cards of other types"): StoryBuilder.card looks the entity's type
 * up in TYPE_CARDS (cards/index.ts) before its generic sections. Each group of types lives in a module of its own.
 */
import type { PNode } from '../../indexer/parser.ts';
import type { Entity } from '../../indexer/gameIndex.ts';
import type { EntityCard, SectionSource } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';

export interface CardInput
{
    e: Entity;
    /** the winning definition's node, and its block's statements */
    node: PNode;
    body: PNode[];
    /** filled in place: facts, sections, description (already set from the loc when there is one) */
    card: EntityCard;
    /** reads the definition's own text: lines made with it carry anchors for editing in place */
    ctx: Ctx;
    /** the definition's own block as a section's place */
    own: (kind: SectionSource['kind'], fields?: string) => SectionSource | undefined;
}

/**
 * Fills the card of one type. Returns true when the card is complete; otherwise the generic sections follow
 * (StoryBuilder.genericSections: modifiers, trigger / effect blocks, cost) — skip keys already shown with `skip`.
 */
export type CardFn = (b: StoryBuilder, x: CardInput) => boolean | void;
