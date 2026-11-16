// The text edits of the GUI tab's property grid (src/main/mods/guiEdit.ts applyGuiEdit): set where written, added after
// the last property (a list counts as one), removed with its line, refused where the widget doesn't write it.
// Usage: node --experimental-strip-types --no-warnings scripts/gui-edit-check.ts
import { applyGuiEdit } from '../src/main/mods/guiEdit.ts';

const src = 'window = {\n\tname = "w"\n\tsize = { 630 940 }\n\n\tvbox = {\n\t\tusing = Window_Margins\n\t\ttext_single = {\n\t\t\ttext = "A"\n\t\t}\n\t}\n}\n';
const at = { rel: 'gui/x.gui', where: '', line: 1, key: 'window' };
let bad = 0;

function check(what: string, got: () => { text: string; line: number; }, want: string, line: number): void
{
    let r: { text: string; line: number; } | undefined;
    let err = '';

    try
    {
        r = got();
    }
    catch (e)
    {
        err = (e as Error).message;
    }

    const ok = !!r && r.text === want && r.line === line;

    if (!ok)
        bad++;

    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `\n  got (line ${r?.line}): ${JSON.stringify(r?.text ?? err)}\n  want (line ${line}): ${JSON.stringify(want)}`}`);
}

check('set a list where written', () => applyGuiEdit(src, { at, set: { key: 'size', value: '{ 500 800 }' } }), src.replace('{ 630 940 }', '{ 500 800 }'), 3);
check('add after the last property', () => applyGuiEdit(src, { at, set: { key: 'parentanchor', value: 'top|right' } }), src.replace('\tsize = { 630 940 }\n', '\tsize = { 630 940 }\n\tparentanchor = top|right\n'), 4);
check('add in a nested widget', () => applyGuiEdit(src, { at: { ...at, line: 5, key: 'vbox' }, set: { key: 'spacing', value: '5' } }), src.replace('\t\tusing = Window_Margins\n', '\t\tusing = Window_Margins\n\t\tspacing = 5\n'), 7);
check('a value with spaces is quoted', () => applyGuiEdit(src, { at: { ...at, line: 7, key: 'text_single' }, set: { key: 'text', value: 'Hello world' } }), src.replace('"A"', '"Hello world"'), 8);
check('insert a widget as the last child', () => applyGuiEdit(src, { at: { ...at, line: 5, key: 'vbox' }, insert: 'icon = {\n\tsize = { 48 48 }\n}' }), src.replace('\t\t\ttext = "A"\n\t\t}\n', '\t\t\ttext = "A"\n\t\t}\n\n\t\ticon = {\n\t\t\tsize = { 48 48 }\n\t\t}\n'), 11);
check('insert into an empty widget', () => applyGuiEdit('a = {\n\tb = {}\n}\n', { at: { ...at, line: 2, key: 'b' }, insert: 'expand = {}' }), 'a = {\n\tb = {\n\t\texpand = {}\n\t}\n}\n', 3);
const tree = 'w = {\n\tsize = { 1 1 }\n\ta = {\n\t\tx = 1\n\t}\n\tspacing = 2\n\tb = {\n\t\ty = 2\n\t}\n}\n';
const tat = { rel: 'gui/x.gui', where: '', line: 3, key: 'a' };
check('delete a widget with its lines', () => applyGuiEdit(tree, { at: tat, delete: true }), 'w = {\n\tsize = { 1 1 }\n\tspacing = 2\n\tb = {\n\t\ty = 2\n\t}\n}\n', 3);
check('down: swapped with the next widget (a property between stays)', () => applyGuiEdit(tree, { at: tat, shift: 1 }), 'w = {\n\tsize = { 1 1 }\n\tb = {\n\t\ty = 2\n\t}\n\tspacing = 2\n\ta = {\n\t\tx = 1\n\t}\n}\n', 7);
check('up: swapped with the widget before', () => applyGuiEdit(tree, { at: { ...tat, line: 7, key: 'b' }, shift: -1 }), 'w = {\n\tsize = { 1 1 }\n\tb = {\n\t\ty = 2\n\t}\n\tspacing = 2\n\ta = {\n\t\tx = 1\n\t}\n}\n', 3);
check('move into another widget', () => applyGuiEdit(tree, { at: tat, moveInto: { line: 7, key: 'b' } }), 'w = {\n\tsize = { 1 1 }\n\tspacing = 2\n\tb = {\n\t\ty = 2\n\n\t\ta = {\n\t\t\tx = 1\n\t\t}\n\t}\n}\n', 7);

try
{
    applyGuiEdit(tree, { at: tat, shift: -1 });
    bad++;
    console.log('FAIL the first widget moved up');
}
catch
{
    console.log("ok   the first widget can't go up");
}

const crlf = src.replace(/\n/g, '\r\n');
check('add keeps CRLF line ends', () => applyGuiEdit(crlf, { at, set: { key: 'parentanchor', value: 'center' } }), crlf.replace('\tsize = { 630 940 }\r\n', '\tsize = { 630 940 }\r\n\tparentanchor = center\r\n'), 4);
check('remove with its line', () => applyGuiEdit(src, { at, remove: 'size' }), src.replace('\tsize = { 630 940 }\n', ''), 3);

try
{
    applyGuiEdit(src, { at, remove: 'margin' });
    bad++;
    console.log('FAIL removing a property the widget does not write was not refused');
}
catch
{
    console.log('ok   removing a property the widget does not write is refused');
}

try
{
    applyGuiEdit(src, { at: { ...at, line: 2 }, set: { key: 'size', value: '1' } });
    bad++;
    console.log('FAIL a widget that is not at the line was not refused');
}
catch
{
    console.log('ok   a widget that is not at the line is refused');
}

console.log(bad ? `${bad} failed` : 'all passed');
process.exit(bad ? 1 : 0);
