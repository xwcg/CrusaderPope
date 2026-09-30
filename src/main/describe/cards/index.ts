/** Every per-type card builder, by index type (cards/types.ts). */
import type { CardFn } from './types.ts';
import { REALM_CARDS } from './realm.ts';
import { CULTURE_CARDS } from './culture.ts';
import { SCRIPTED_CARDS } from './scripted.ts';
import { LIFE_CARDS } from './life.ts';
import { PRESENTATION_CARDS } from './presentation.ts';

export const TYPE_CARDS: Record<string, CardFn> = { ...REALM_CARDS, ...CULTURE_CARDS, ...SCRIPTED_CARDS, ...LIFE_CARDS, ...PRESENTATION_CARDS };
