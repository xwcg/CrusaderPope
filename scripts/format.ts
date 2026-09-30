// Formats the sources the way scripts/card-survey.ts shows it (docs/dev-gotchas.md, "Code style"): dprint
// (dprint.json — 4 spaces, semicolons, braces on a line of their own, else / catch on the next line, a single
// statement's body on the next line) after two passes it has no option for: a blank line around control statements
// (if, for, while, do, switch, try) and a call per line in chains of three calls or more.
// Usage: node --experimental-strip-types --no-warnings scripts/format.ts [--check] [file …]   (default: every source)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const given = args.filter((a) => a !== '--check');
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;

const files = given.length
    ? given
    : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts', '*.ts', '*.mjs', '*.cjs'], { cwd: ROOT, encoding: 'utf8' })
        .split(/\r?\n/)
        .filter((f) => SOURCE.test(f));

const CONTROL = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.SwitchStatement,
    ts.SyntaxKind.TryStatement
]);

interface Edit
{
    at: number;
    text: string;
}

/** A blank line before and after every control statement of a statement list (not at the list's ends). */
function blankLines(sf: ts.SourceFile, text: string, eol: string, edits: Edit[]): void
{
    const visit = (n: ts.Node): void =>
    {
        const list = ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) ? n.statements : undefined;

        if (list)
        {
            for (let i = 1; i < list.length; i++)
            {
                const a = list[i - 1];
                const b = list[i];

                if (!CONTROL.has(a.kind) && !CONTROL.has(b.kind))
                    continue;

                const start = b.getStart(sf);

                // (a blank line there already; or both on one line)
                if (/\n[ \t]*\r?\n/.test(text.slice(a.end, start)))
                    continue;

                const nl = text.indexOf('\n', a.end);

                if (nl >= 0 && nl < start)
                    edits.push({ at: nl + 1, text: eol });
            }
        }

        ts.forEachChild(n, visit);
    };
    visit(sf);
}

/** `this.idx`, `Object`, `a.b` — a chain's start its first call stays on (else every call gets a line of its own). */
function simple(e: ts.Expression): boolean
{
    if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword || e.kind === ts.SyntaxKind.SuperKeyword)
        return true;

    return ts.isPropertyAccessExpression(e) && simple(e.expression);
}

/** A line per call in chains of three calls or more (`[...a].sort(…).slice(…).map(…)`), not inside template literals. */
function chains(sf: ts.SourceFile, text: string, eol: string, edits: Edit[]): void
{
    const seen = new Set<ts.Node>();
    const visit = (n: ts.Node): void =>
    {
        if (ts.isTemplateSpan(n))
            return;

        if (ts.isCallExpression(n) && !seen.has(n))
        {
            // the called members, from the chain's start (through members not called, non-null assertions)
            const links: ts.PropertyAccessExpression[] = [];
            let e: ts.Expression = n;

            for (;;)
            {
                if (ts.isCallExpression(e))
                {
                    seen.add(e);

                    if (ts.isPropertyAccessExpression(e.expression))
                    {
                        links.unshift(e.expression);
                        e = e.expression.expression;
                    }
                    else
                        break;
                }
                else if (ts.isNonNullExpression(e) || ts.isPropertyAccessExpression(e))
                    e = e.expression;
                else
                    break;
            }

            if (links.length >= 3)
            {
                for (const link of links.slice(simple(links[0].expression) ? 1 : 0))
                {
                    // (before `.name`, or before `?.name`)
                    let dot = link.name.getStart(sf) - 1;

                    while (dot > 0 && /\s/.test(text[dot]))
                        dot--;

                    if (link.questionDotToken)
                        dot = link.questionDotToken.getStart(sf);

                    if (!text.slice(link.expression.end, dot).includes('\n'))
                        edits.push({ at: dot, text: eol });
                }
            }
        }

        ts.forEachChild(n, visit);
    };
    visit(sf);
}

let changed = 0;

for (const rel of files)
{
    const file = join(ROOT, rel);
    const text = readFileSync(file, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
    const edits: Edit[] = [];
    blankLines(sf, text, eol, edits);
    chains(sf, text, eol, edits);

    if (!edits.length)
        continue;

    changed++;

    if (check)
    {
        console.log(`${rel}: ${edits.length} line breaks to add`);
        continue;
    }

    // (from the end: the earlier positions stay valid)
    edits.sort((a, b) => b.at - a.at);
    let out = text;

    for (const ed of edits)
        out = out.slice(0, ed.at) + ed.text + out.slice(ed.at);

    writeFileSync(file, out);
}

console.log(`${changed} of ${files.length} files ${check ? 'need' : 'got'} blank lines or chain breaks`);
// then dprint: indentation, braces, semicolons, bodies (it reports the files it changed)
execFileSync(join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'dprint.cmd' : 'dprint'), [check ? 'check' : 'fmt', ...given], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
