/**
 * Main's entry (docs/localization.md): the app's language read from the settings and put into the environment before
 * the app's modules load: they translate texts as they load (shared/i18n.ts), and the workers they start inherit it.
 * Then the app itself (index.ts).
 */
import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// (the same user data folder index.ts uses; test runs keep their own)
const userData = process.env.CRUSADERPOPE_USER_DATA || app.getPath('userData');

try
{
    const s = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { appLanguage?: string; };

    if (s.appLanguage && !process.env.CRUSADERPOPE_LOCALE)
        process.env.CRUSADERPOPE_LOCALE = s.appLanguage;
}
catch
{
    // (no settings yet: English)
}

// (the built entry index.js beside this file, loaded at run time: an `import('./index.ts')` made the bundler copy the
// app into a chunk of its own once more modules were shared, whose __dirname is out/main/chunks, so the workers and
// the window's files were not found, 2026-11-13)
require(join(__dirname, 'index.js'));
