#!/usr/bin/env node
/**
 * Run the studio suite and print the tree it ran against.
 *
 * Five review round-trips were once spent arguing about results from trees that
 * had already moved: a "6/6" of a file that had grown to eight tests, a 38/40,
 * a 43/45, and two returns that described code fixed a turn earlier. None of it
 * was carelessness. It is the shape of bounded turns in a shared directory, and
 * asking each other for more discipline failed twice.
 *
 * So the report carries the tree. Every line names the file's content hash, and
 * the run ends with one digest over all of them. If two agents quote different
 * digests they know instantly that they ran different code, instead of
 * discovering it after two messages.
 *
 *   npm test                    the deterministic suite
 *   node test/run.mjs --json    machine-readable, for a report
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Deliberately explicit rather than a glob of the directory: a suite that
// silently stops covering something because a file was renamed is the failure
// this project keeps finding in other people's code.
const STUDIO_TESTS = [
  'smoke.mjs',
  'adapter-args.mjs',
  'config-panel.mjs',
  'roster.mjs',
  'cli.mjs',
  'validation.mjs',
  'stream-gap.mjs',
  'inbox-ack.mjs',
  'durability.mjs',
  'arrival.mjs',
  'attack-newline.mjs',
  'human-intervene.mjs',
  'human-write-validation.mjs',
  'human-control-atomicity.mjs',
  'human-provenance.mjs',
  'human-message-style.mjs',
  'scroll-follow.mjs',
  'attention-withdraw.mjs',
  'reassign-notice.mjs',
];

/**
 * Tests that need something this machine may not have.
 *
 * `launch-check` measures against a live studio and `adapter-check` launches the
 * real vendor CLIs. Both are worth running and neither belongs in a suite that
 * must be green on a clean clone, so they are named here rather than quietly
 * omitted.
 */
const OPT_IN = ['launch-check.mjs (needs a running studio)', 'adapter-check.mjs (spends provider tokens)'];

// The source these tests actually exercise. Hashing the tests alone would let a
// production change go unnoticed in the digest, which is the whole point of it.
const STUDIO_SOURCES = [
  'src/core/store.mjs',
  'src/core/events.mjs',
  'src/core/config.mjs',
  'src/web/settings.js',
  'src/core/roster.mjs',
  'src/core/paths.mjs',
  'src/server/server.mjs',
  'src/agents/runner.mjs',
  'src/agents/prompts.mjs',
  'src/agents/adapters/index.mjs',
  'src/agents/adapters/shared.mjs',
  'src/agents/adapters/codex.mjs',
  'src/agents/adapters/claude.mjs',
  'src/agents/adapters/grok.mjs',
  'src/cli/studio.mjs',
  'src/web/app.js',
  'src/web/style.css',
  'src/web/message-addressing.js',
  'test/harness.mjs',
];

const args = process.argv.slice(2);
const asJson = args.includes('--json');

const hash = (file) => {
  const p = path.join(ROOT, file);
  if (!existsSync(p)) return null;
  return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12).toUpperCase();
};

function run(command, cmdArgs, cwd = ROOT) {
  const r = spawnSync(command, cmdArgs, { cwd, encoding: 'utf8', shell: false });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const results = [];
const say = (s) => { if (!asJson) console.log(s); };

say('studio suite');
for (const name of STUDIO_TESTS) {
  const rel = path.posix.join('test', name);
  if (!existsSync(path.join(ROOT, rel))) {
    results.push({ file: rel, hash: null, code: -1, missing: true });
    say(`  MISSING  ${name}`);
    continue;
  }
  const { code, out } = run(process.execPath, [rel]);
  results.push({ file: rel, hash: hash(rel), code });
  say(`  ${code === 0 ? 'ok  ' : 'FAIL'}  ${name.padEnd(30)} ${hash(rel)}`);
  if (code !== 0) {
    say(out.split('\n').filter((l) => /FAIL|Error|Assertion/i.test(l)).slice(0, 6).map((l) => `        ${l}`).join('\n'));
  }
}

say(`\nnot run here: ${OPT_IN.join(', ')}`);

// The digest. Sources first, then test files: two reports carrying the same
// digest ran the same code, and that is the only claim it makes.
const tracked = [...STUDIO_SOURCES, ...STUDIO_TESTS.map((n) => path.posix.join('test', n))];
const digestInput = tracked.map((f) => `${f}:${hash(f) ?? 'absent'}`).join('\n');
const digest = createHash('sha256').update(digestInput).digest('hex').slice(0, 12).toUpperCase();
const failed = results.filter((r) => r.code !== 0);

if (asJson) {
  console.log(JSON.stringify({ digest, files: tracked.length, failed: failed.length, results }, null, 1));
} else {
  console.log(`\n${failed.length ? `${failed.length} FAILED` : 'all green'} · tree ${digest} · ${tracked.length} files`);
  console.log('Quote the tree digest when you report a result. A different digest means a different tree,');
  console.log('not a disagreement.');
}
process.exitCode = failed.length ? 1 : 0;
