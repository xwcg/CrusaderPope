// Checks what the Settings dialog sends on Save (src/shared/settingsPatch.ts): only the keys it changed, compared by
// value, so settings changed elsewhere meanwhile are not overwritten. A nested object that was edited goes whole.
// Usage: node --experimental-strip-types --no-warnings scripts/settings-patch-check.ts
import { changedKeys } from '../src/shared/settingsPatch.ts';

let bad = 0;
const eq = (name: string, got: unknown, want: unknown): void =>
{
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
    bad += ok ? 0 : 1;
};

const was: Record<string, unknown> = { gameDir: 'a', userDir: 'u', graphics: { quality: 1, shadows: true }, modList: ['x', 'y'] };

eq('nothing changed: empty patch', changedKeys(JSON.parse(JSON.stringify(was)) as Record<string, unknown>, was), {});
eq('one key', changedKeys({ ...was, gameDir: 'b' }, was), { gameDir: 'b' });
eq('equal copy of a nested object is not a change', changedKeys({ ...was, graphics: { quality: 1, shadows: true } }, was), {});
eq('one field of a nested object sends the whole object', changedKeys({ ...was, graphics: { quality: 2, shadows: true } }, was), { graphics: { quality: 2, shadows: true } });
eq('a list edited', changedKeys({ ...was, modList: ['x'] }, was), { modList: ['x'] });
eq('a new key', changedKeys({ ...was, extra: 1 }, was), { extra: 1 });
console.log(bad ? `${bad} failed` : 'all ok');
process.exit(bad ? 1 : 0);
