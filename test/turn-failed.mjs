#!/usr/bin/env node
/**
 * A turn that keeps failing must stop and say so, like a launch that keeps failing.
 *
 * On 2026-08-26 codex ran 42 consecutive failed turns in seven minutes. Its own
 * thread store had the session locked — "thread/resume failed: thread <id>
 * already has an active writer" — and two things went wrong at once:
 *
 *   1. The stderr match that decides a session is unusable listed four vendor
 *      phrasings, and codex's was none of them. So the runner resumed the same
 *      locked thread every ten seconds and never started a fresh one.
 *   2. Nothing counted the failures. quietTurns cannot: a failed turn appends an
 *      agent.state and a studio.note owned by that agent, so the streak resets on
 *      every failure. The one mechanism that could have slept the agent is
 *      structurally blind to failure — it only sees silence.
 *
 * The result was 42 wasted turns, an inbox redelivered 42 times, and not one
 * event telling the human. A missing binary was already protected by a
 * three-strike breaker; a failing turn had nothing.
 *
 * Two agents here. `mimic` fails with codex's exact wording, and proves the
 * match now recognises it. `mute` fails with wording nobody has ever seen, and
 * proves the breaker does not depend on recognising anyone's prose.
 *
 *   node test/turn-failed.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-turn-failed-'));
fs.mkdirSync(path.join(tmp, 'studio_floor'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# Turn-failed fixture\n\nProve the breaker fires.\n');

// A provider that launches cleanly and then dies. That distinction is the whole
// point: a launch failure is already handled, a turn failure was not.
const FIXTURE = path.join(tmp, 'failing-provider.mjs');
fs.writeFileSync(FIXTURE, [
  'const mode = process.argv[2];',
  'if (mode === "codex") {',
  '  process.stderr.write("ERROR codex_core::session: failed to initialize thread persistence: "',
  '    + "thread-store conflict: thread 01a04035-c8a8-7c10-934f-914ae3974d80 already has an active writer\\n");',
  '  process.stderr.write("Error: thread/resume: thread/resume failed: thread "',
  '    + "01a04035-c8a8-7c10-934f-914ae3974d80 already has an active writer (code -32600)\\n");',
  '} else {',
  '  process.stderr.write("kaputt: the provider declined to explain itself\\n");',
  '}',
  'process.exit(1);',
].join('\n'));

process.env.STUDIO_PROJECT_ROOT = tmp;

const { Store } = await import('../src/core/store.mjs');
const { Runner } = await import('../src/agents/runner.mjs');
const { register } = await import('../src/agents/adapters/index.mjs');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('');
console.log('turn-failed — a turn that keeps failing stops and tells the human');
console.log('');

for (const [id, mode] of [['mimic', 'codex'], ['mute', 'silent']]) {
  register({
    id: `fake-${id}`,
    label: `Fake ${id}`,
    command: process.execPath,
    newSession: () => randomUUID(),
    args: () => [FIXTURE, mode],
    parse: () => [],
  });
}

const store = new Store();
const runner = new Runner(store, {
  maxTurns: 20,
  cooldownMs: 0,
  staggerMs: 0,
  idleBackoffMs: [0],
  // The production default is 5s per consecutive failure, which would make this
  // test 30 seconds of sleeping to observe four turns.
  failureBackoffMs: 0,
  turnTimeoutMs: 15_000,
  commandLineBudget: 28_000,
  project: { name: 'Turn-failed fixture', brief: 'PROJECT.md' },
  agents: ['mimic', 'mute'],
  roster: [
    { id: 'mimic', provider: 'fake-mimic', label: 'Mimic', persona: '', options: {} },
    { id: 'mute', provider: 'fake-mute', label: 'Mute', persona: '', options: {} },
  ],
});

// Eight process spawns across two agents, and a cold Windows runner is far
// slower at that than a developer machine: at 30s this timed out on
// windows/node20 only, and every assertion below then measured a run that had
// been cut off rather than one that had finished. The deadline is a backstop for
// a hang, not a pace to keep up with, so it is generous and it says plainly when
// it fires instead of leaving the count checks to imply it.
const deadline = Date.now() + 180_000;
const stopped = new Set();
await new Promise((resolve) => {
  store.on('event', (ev) => {
    if (ev.kind === 'agent.stopped' && /turns in a row failed/.test(ev.data?.reason || '')) {
      stopped.add(ev.agent);
    }
    if (stopped.size === 2) resolve();
  });
  runner.start('mimic');
  runner.start('mute');
  const tick = setInterval(() => {
    if (stopped.size === 2 || Date.now() > deadline) {
      clearInterval(tick);
      resolve();
    }
  }, 50);
});
check('both agents reached the breaker before the deadline', stopped.size === 2,
  `stopped: ${[...stopped].join(', ') || 'neither'} — everything below measures a run that was cut short`);
await runner.stopAll('test finished');

const of = (agent, kind) => store.events.filter((e) => e.kind === kind && e.agent === agent);
const noteText = (agent) => of(agent, 'studio.note').map((e) => e.data.text || '').join(' | ');

// --- bug 1: the vendor's actual words ---------------------------------------
check("codex's wording is recognised as a session that cannot be resumed",
  /could not be resumed/.test(noteText('mimic')), noteText('mimic') || '(no notes)');
check('...on the first failure, before any counting',
  /could not be resumed/.test(of('mimic', 'studio.note')[0]?.data.text || ''),
  of('mimic', 'studio.note')[0]?.data.text || '(none)');

// --- bug 2: and a backstop that needs no wording at all ----------------------
check('an unrecognised failure still gets a fresh session, on the second try',
  /two turns in a row failed/.test(noteText('mute')), noteText('mute') || '(no notes)');

// --- the breaker -------------------------------------------------------------
for (const id of ['mimic', 'mute']) {
  const ends = of(id, 'raw.turn.end');
  const att = of(id, 'attention.raised')[0];
  const stop = of(id, 'agent.stopped')[0];
  check(`${id}: stops at the limit instead of retrying forever`, ends.length === 4, `${ends.length} turns`);
  check(`${id}: raises attention for the human`, Boolean(att), 'no attention.raised');
  check(`${id}: the attention names a turn failure, not a launch failure`,
    /failed 4 turns in a row/.test(att?.data?.text || ''), att?.data?.text || '');
  check(`${id}: the agent is stopped, and the reason says why`,
    /4 turns in a row failed/.test(stop?.data?.reason || ''), stop?.data?.reason || '');
}

// --- what the old code did instead ------------------------------------------
//
// quietTurns is what should have caught this and cannot. Asserted rather than
// described, because it is the reason the breaker has to exist at all.
const produced = store.events.filter(
  (e) => e.agent === 'mimic' && !e.kind.startsWith('raw.') && e.kind !== 'agent.stopped',
).length;
check('a failed turn is not silent, which is why the idle detector never fires',
  produced > 0, `${produced} non-raw events from an agent that did nothing but fail`);

// Retried AND caught, like launch-failed.mjs — the other test that drives a real
// Runner. Eight turns leave eight transcript files, and on Windows a handle can
// outlive stopAll long enough for rmdir to return ENOTEMPTY; node 22 retries
// internally and Linux does not care, so it lands on exactly one leg of the
// matrix. It did, twice: windows-latest / node 20, with every check passing and
// the run failing in teardown. A temp directory left in the OS temp dir is not a
// test result, and reporting it as one buries the ones that are.
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
} catch { /* leftover tmp — the assertions above already ran */ }
console.log('');
console.log(failures ? `${failures} FAILED` : 'turn-failed ok');
process.exitCode = failures ? 1 : 0;
