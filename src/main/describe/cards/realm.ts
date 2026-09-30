/** Cards: Realm and law — laws, governments, succession, titles, holdings, contracts, men-at-arms, game rules. */
import type { CardFn } from './types.ts';
import { LAW_CARDS } from './realm-law.ts';
import { TITLE_CARDS } from './realm-titles.ts';
import { CONTRACT_CARDS } from './realm-contracts.ts';
import { WAR_CARDS } from './realm-war.ts';
import { RULE_CARDS } from './realm-rules.ts';

export const REALM_CARDS: Record<string, CardFn> = { ...LAW_CARDS, ...TITLE_CARDS, ...CONTRACT_CARDS, ...WAR_CARDS, ...RULE_CARDS };
