/**
 * The app's catalogs (docs/localization.md): one JSON file per language, English text → translation. English needs
 * none (the texts are English); a new language is a file here and a line in LANGUAGES.
 */
import type { Catalog } from '../i18n.ts';

/** language code → its catalog */
export const CATALOGS: Record<string, Catalog> = {
    en: {}
};

/** the languages offered in Settings: code → its name in itself */
export const LANGUAGES: Record<string, string> = {
    en: 'English'
};
