// Makes a release commit on the `release` branch — the only branch pushed to GitHub (docs: README.md "Releases").
// It holds major milestones only, one commit each, made at the owner's say so: master's tree without the notes written
// for the AI assistant (CLAUDE.md, docs/, .claude/). Nothing is checked out or pushed; master and the working tree stay
// as they are.
//
// Usage:
//   node scripts/release.mjs --draft                 prints the changes since the last release (master's commit
//                                                    subjects) to write the summary from
//   node scripts/release.mjs <summary file> [ref]    commits master (or ref) on `release`, the file's text as message
//
// The release commit ends with "Source: <master sha>", which the next --draft starts from.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Paths left out of a release (notes for the AI assistant, its settings). */
const EXCLUDE = ['CLAUDE.md', 'docs', '.claude'];
const BRANCH = 'release';

const git = (args, env) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
const tryGit = (args) =>
{
    try
    {
        return git(args);
    }
    catch
    {
        return null;
    }
};

const head = tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]);
// (the master commit the last release was made from)
const last = head ? /^Source: ([0-9a-f]{40})$/m.exec(git(['log', '-1', '--format=%B', head]))?.[1] : undefined;
const [arg, ref = 'master'] = process.argv.slice(2);

if (!arg || arg === '--draft')
{
    const range = last ? `${last}..${ref}` : ref;
    const subjects = git(['log', '--reverse', '--no-merges', '--format=- %s', range]);
    console.log(last ? `Changes since the last release (${last.slice(0, 7)}):\n` : 'Changes (first release):\n');
    console.log(subjects || '(none)');
    process.exit(0);
}

const summary = readFileSync(arg, 'utf8').trim();

if (!summary)
    throw new Error('The summary is empty.');

const source = git(['rev-parse', ref]);

if (source === last)
    throw new Error(`${ref} is what the last release was made from — nothing new.`);

// master's tree without the excluded paths, through an index of its own (the real index is not touched)
const dir = mkdtempSync(join(tmpdir(), 'ckp-release-'));
const env = { GIT_INDEX_FILE: join(dir, 'index') };

try
{
    git(['read-tree', source], env);
    git(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...EXCLUDE], env);
    const tree = git(['write-tree'], env);
    const message = `${summary}\n\nSource: ${source}\n`;
    const commit = execFileSync('git', ['commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'], { encoding: 'utf8', input: message }).trim();
    git(['update-ref', `refs/heads/${BRANCH}`, commit, ...(head ? [head] : [])]);
    console.log(`${BRANCH} → ${commit.slice(0, 7)} (from ${ref} ${source.slice(0, 7)}; left out: ${EXCLUDE.join(', ')})`);
}
finally
{
    rmSync(dir, { recursive: true, force: true });
}
