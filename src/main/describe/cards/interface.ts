/** The interface side of a card (docs/gui-designer.md): the `.gui` definitions that call a scripted GUI. */
import type { Entity } from '../../indexer/gameIndex.ts';
import type { CardSection, EntityCard, GuiKind, Line } from '../../../shared/api.ts';
import { rich } from '../text.ts';
import type { StoryBuilder } from '../stories.ts';

import { tr } from '../../../shared/i18n.ts';
const KIND: Record<GuiKind, string> = { window: 'window', root: 'widget', type: 'type', template: 'template' };

/** "In the interface": the windows, widgets, types and templates of the `.gui` files calling it, linked to the GUI tab. */
export function interfaceSection(b: StoryBuilder, e: Entity, card: EntityCard): void
{
    const users = b.guiUsers?.(e.name) ?? [];

    if (!users.length)
        return;

    const lines = users.map((u): Line => ({
        text: rich({ text: u.name, kind: 'entity', ref: { type: '@gui', name: `${u.kind}:${u.name}` }, tip: `${u.file}:${u.line}` }, tr(' ({KIND} in {replace})', { KIND: KIND[u.kind], replace: u.file.replace(/^gui\//, '') })),
        icon: 'note'
    }));
    const section: CardSection = { title: tr('In the interface'), lines, noAdd: true };
    card.sections.push(section);
}
