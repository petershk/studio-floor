#!/usr/bin/env node
/**
 * Updating the studio from inside the studio.
 *
 * This runs git against the installation, so the interesting assertions are the
 * refusals: it must decline anything that would need judgement rather than
 * guessing, because the alternative is a button that quietly rewrites someone's
 * clone.
 *
 * Built against a real local origin and a real clone. Mocking git here would
 * test the mock — the behaviours that matter (what counts as dirty, what
 * fast-forward refuses) are git's, not ours.
 *
 *   node test/update.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-update-'));
const origin = path.join(tmp, 'origin.git');
const clone = path.join(tmp, 'clone');

let n = 0;
const ok = (name, cond, detail = '') => {
  n++;
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1; }
};
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

console.log('\nupdate — fast-forwarding the studio, and refusing when it should\n');

if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.log('  skip  git is not available\n');
  process.exit(0);
}

// A real origin with two commits, and a clone sitting on the first.
fs.mkdirSync(origin, { recursive: true });
git(origin, 'init', '--bare', '-q', '--initial-branch=main');
const seed = path.join(tmp, 'seed');
fs.mkdirSync(seed);
git(seed, 'init', '-q', '--initial-branch=main');
git(seed, 'config', 'user.email', 'test@example.com');
git(seed, 'config', 'user.name', 'Test');
fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'first');
git(seed, 'remote', 'add', 'origin', origin);
git(seed, 'push', '-q', 'origin', 'main');
git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');

git(tmp, 'clone', '-q', origin, clone);
git(clone, 'config', 'user.email', 'test@example.com');
git(clone, 'config', 'user.name', 'Test');

/** Load update.mjs with PACKAGE_ROOT pointed at a directory of our choosing. */
async function loadFor(root) {
  // paths.mjs derives PACKAGE_ROOT from its own location, so the module is
  // imported fresh with a cache-busting query and a stubbed root instead.
  const src = fs.readFileSync(new URL('../src/core/update.mjs', import.meta.url), 'utf8')
    .replace("import { PACKAGE_ROOT } from './paths.mjs';",
      `const PACKAGE_ROOT = ${JSON.stringify(root)};`);
  const f = path.join(tmp, `update-${Math.abs(hash(root))}-${loadFor.n = (loadFor.n || 0) + 1}.mjs`);
  fs.writeFileSync(f, src);
  return import(pathToFileURL(f).href);
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

// ------------------------------------------------------------- up to date

{
  const { updateStatus } = await loadFor(clone);
  const st = updateStatus({ fetch: true });
  ok('a clean clone is a git repo', st.isGitRepo === true);
  ok('it finds the branch', st.branch === 'main', st.branch);
  ok('it finds the upstream', /origin\/main/.test(st.upstream || ''), String(st.upstream));
  ok('nothing blocks it', st.reasons.length === 0, st.reasons.join('; '));
  ok('it is up to date', st.upToDate === true && st.behind === 0);
  ok('and offers no update', st.canUpdate === false);
}

// ------------------------------------------------------------ behind origin

git(seed, 'pull', '-q', 'origin', 'main');
fs.writeFileSync(path.join(seed, 'a.txt'), 'two\n');
git(seed, 'commit', '-aqm', 'second commit');
fs.writeFileSync(path.join(seed, 'b.txt'), 'new\n');
git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'third commit');
git(seed, 'push', '-q', 'origin', 'main');

{
  const { updateStatus } = await loadFor(clone);
  const st = updateStatus({ fetch: true });
  ok('it notices it is behind', st.behind === 2, `behind=${st.behind}`);
  ok('it offers the update', st.canUpdate === true);
  ok('and lists what is coming', st.commits.length === 2, st.commits.join(' | '));
  ok('the newest commit is named', st.commits.join(' ').includes('third commit'));
}

// ---------------------------------------------------------------- applying

{
  const { pullUpdate, updateStatus } = await loadFor(clone);
  const before = updateStatus().head;
  const r = pullUpdate();
  ok('the update applies', r.ok === true, (r.errors || []).join('; '));
  ok('and reports that something changed', r.changed === true);
  ok('the clone moved', r.to !== before, `${r.from} -> ${r.to}`);
  ok('the new file arrived', fs.existsSync(path.join(clone, 'b.txt')));
  ok('the changed file is updated', fs.readFileSync(path.join(clone, 'a.txt'), 'utf8').trim() === 'two');

  const after = updateStatus({ fetch: true });
  ok('and it is now up to date', after.behind === 0 && after.upToDate === true);
  ok('updating again is a no-op, not an error', pullUpdate().changed === false);
}

// ----------------------------------------------------------- the refusals

{
  // Local work must never be steamrollered.
  fs.writeFileSync(path.join(clone, 'a.txt'), 'my local edit\n');
  const { updateStatus, pullUpdate } = await loadFor(clone);
  const st = updateStatus();
  ok('a dirty tree is detected', st.dirty === true);
  ok('and blocks the update', st.canUpdate === false && st.reasons.some((r) => /uncommitted/.test(r)));
  const r = pullUpdate();
  ok('applying is refused outright', r.ok === false);
  ok('the local edit survives the refusal',
    fs.readFileSync(path.join(clone, 'a.txt'), 'utf8').trim() === 'my local edit');
  git(clone, 'checkout', '--', 'a.txt');
}
{
  // A clone with its own commits would need a merge; that is a human's call.
  fs.writeFileSync(path.join(clone, 'local.txt'), 'mine\n');
  git(clone, 'add', '-A'); git(clone, 'commit', '-qm', 'local work');
  const { updateStatus } = await loadFor(clone);
  const st = updateStatus();
  ok('local commits are detected', st.ahead === 1, `ahead=${st.ahead}`);
  ok('and block the update', st.reasons.some((r) => /local commit/.test(r)));
  git(clone, 'reset', '-q', '--hard', 'HEAD~1');
}
{
  // Detached HEAD is a state a human put the clone in deliberately.
  const head = git(clone, 'rev-parse', 'HEAD').stdout.trim();
  git(clone, 'checkout', '-q', head);
  const { updateStatus } = await loadFor(clone);
  const st = updateStatus();
  ok('detached HEAD blocks the update', st.reasons.some((r) => /detached/.test(r)), st.reasons.join('; '));
  git(clone, 'checkout', '-q', 'main');
}
{
  // Installed by copy or by npm pack rather than cloned.
  const plain = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(plain);
  const { updateStatus } = await loadFor(plain);
  const st = updateStatus();
  ok('a non-git install says so plainly', st.isGitRepo === false);
  ok('and cannot update', st.canUpdate === false);
  ok('with a reason a human can act on', st.reasons.some((r) => /git clone/.test(r)));
}
{
  // A branch tracking nothing has nowhere to pull from.
  git(clone, 'checkout', '-q', '-b', 'orphan');
  const { updateStatus } = await loadFor(clone);
  const st = updateStatus();
  ok('an untracked branch blocks the update', st.reasons.some((r) => /not tracking/.test(r)));
  git(clone, 'checkout', '-q', 'main');
}

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
console.log(process.exitCode ? '\nupdate checks FAILED\n' : `\nall ${n} update checks passed\n`);
