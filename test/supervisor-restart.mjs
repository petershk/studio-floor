#!/usr/bin/env node
/**
 * The supervisor brings the studio back.
 *
 * An always-on team is worth nothing if a crash at 2am is found at 9am, and the
 * supervisor is the only process still standing at the moment the studio stops.
 * But an unbounded restart is its own failure — a studio that cannot bind its
 * port would spin forever, burying the one message the human needs to read.
 *
 * The studio under test is a stand-in that dies on command, because the only
 * other way to test a studio that dies is to break the real one. The delays are
 * turned down to milliseconds for the same reason a real one is a minute: this
 * has to be a test, not a wait.
 *
 *   node test/supervisor-restart.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXIT_REFUSED } from '../src/core/paths.mjs';
import { describe } from '../src/core/events.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.resolve(HERE, '..', 'src', 'bin', 'supervise.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-super-'));

fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# Supervisor fixture\n\nProve the studio comes back.\n');
fs.mkdirSync(path.join(tmp, 'studio_floor'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'studio_floor', 'config.json'), JSON.stringify({
  project: { name: 'Supervisor fixture', brief: 'PROJECT.md' },
  agents: [{ id: 'alpha', provider: 'grok' }],
}, null, 2));

/**
 * A studio that does what the case needs.
 *
 * Each run appends what it saw to runs.jsonl — the exit code it was told to
 * use, and whatever the supervisor handed it about the previous death — then
 * exits with the next code in EXITS. Running out means staying up, which is
 * what a recovered studio looks like.
 */
const STANDIN = path.join(tmp, 'standin.mjs');
fs.writeFileSync(STANDIN, `
import fs from 'node:fs';
const runs = process.env.STANDIN_RUNS;
const exits = JSON.parse(process.env.STANDIN_EXITS || '[]');
const seen = fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(runs, JSON.stringify({
  run: seen + 1,
  recovered: process.env.STUDIO_RECOVERED ? JSON.parse(process.env.STUDIO_RECOVERED) : null,
  restarted: process.env.STUDIO_RESTARTED || null,
  argv: process.argv.slice(2),
  root: process.env.STUDIO_PROJECT_ROOT || null,
  stateDir: process.env.STUDIO_STATE_DIR || null,
}) + '\\n');
const code = exits[seen];
// Asking the supervisor to move us, the way the server's switch route does.
if (code === 75 && process.env.STANDIN_SWITCH_TO) {
  fs.mkdirSync(process.env.STUDIO_USER_DIR, { recursive: true });
  fs.writeFileSync(
    process.env.STUDIO_USER_DIR + '/switch.json',
    JSON.stringify({ path: process.env.STANDIN_SWITCH_TO, reset: false, reason: 'test' }),
  );
}
if (code === undefined) setInterval(() => {}, 1000);  // stay up
else process.exit(code);
`);

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\nthe supervisor brings the studio back\n');

let caseNo = 0;
/** Run the supervisor over a stand-in with the given exit sequence. */
function supervise(exits, extraEnv = {}) {
  const runs = path.join(tmp, `runs-${++caseNo}.jsonl`);
  fs.writeFileSync(runs, '');
  const r = spawnSync(process.execPath, [SUPERVISOR, '--no-agents', '--no-open'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      STUDIO_PROJECT_ROOT: tmp,
      STUDIO_USER_DIR: path.join(tmp, 'user'),
      STUDIO_SERVER_ENTRY: STANDIN,
      STUDIO_RESTART_DELAYS_MS: '10,10,10,10,10',
      STANDIN_RUNS: runs,
      STANDIN_EXITS: JSON.stringify(exits),
      ...extraEnv,
    },
  });
  const lines = fs.readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...r, runs: lines, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// A studio that finishes on purpose is finished. Restarting it would make
// `studio start` impossible to stop.
const clean = supervise([0]);
check('a clean exit is passed straight through', clean.status === 0, `exit ${clean.status}`);
check('and nothing is restarted', clean.runs.length === 1, `${clean.runs.length} runs`);

// THE 87 MINUTES. The studio dies, and the team is working again seconds later
// instead of whenever someone happens to look.
const crashed = supervise([1, 1, 0]);
check('a crash brings the studio back', crashed.runs.length === 3, `${crashed.runs.length} runs`);
check('and stops only when the studio itself does', crashed.status === 0, `exit ${crashed.status}`);
check('each restart says what happened and which attempt it is',
  /exited with code 1/.test(crashed.out) && /attempt 1 of 5/.test(crashed.out) && /attempt 2 of 5/.test(crashed.out),
  crashed.out.trim().split('\n').slice(-3).join(' | '));

// The supervisor cannot write the log — the studio owns it, and the studio was
// dead at the moment worth recording. So the story is handed to the process it
// starts, and the gap in the feed arrives with its own explanation.
const handoff = crashed.runs[1]?.recovered;
check('the new studio is told why it is running', !!handoff, JSON.stringify(crashed.runs[1]));
check('with the exit code, the attempt and how long it was down',
  handoff?.code === 1 && handoff?.attempt === 1 && typeof handoff?.downMs === 'number',
  JSON.stringify(handoff));
check('and the studio that started clean was told nothing',
  crashed.runs[0]?.recovered === null);

// A studio that logged "recovered" every morning because a variable stuck
// around would teach the human to ignore the word.
const settled = supervise([1, 0]);
check('the hand-off does not leak into later starts', settled.runs[1]?.recovered !== null
  && settled.runs.length === 2, JSON.stringify(settled.runs.map((r) => !!r.recovered)));

// Bounded, or a studio that cannot start would spin until someone noticed —
// which is the failure this whole feature exists to end.
const doomed = supervise([1, 1, 1, 1, 1, 1, 1, 1]);
check('a studio that will not stay up is given up on', doomed.runs.length === 6,
  `${doomed.runs.length} runs`);
check('and the supervisor exits rather than spinning', doomed.status === 1, `exit ${doomed.status}`);
check('saying plainly that it stopped trying, and that nothing is lost',
  /not restarting again/.test(doomed.out) && /nothing is lost/i.test(doomed.out),
  doomed.out.trim().split('\n').slice(-4).join(' | '));

// A roster typo and a taken port fail identically every time. Spending the
// restart budget on them buries the message the human actually needs.
const refused = supervise([EXIT_REFUSED]);
check('a studio that refuses to start is not restarted', refused.runs.length === 1,
  `${refused.runs.length} runs`);
check('and its exit code is passed through', refused.status === EXIT_REFUSED, `exit ${refused.status}`);

// Long-lived and then dead is not a crash loop, and must not inherit the
// budget of one.
const recovered = supervise([1, 1, 1, 1, 1, 1, 0], { STUDIO_HEALTHY_AFTER_MS: '0' });
check('a studio that ran healthily gets the full budget again',
  recovered.runs.length === 7, `${recovered.runs.length} runs`);

// An operator who sets STUDIO_STATE_DIR — the Dockerfile does, and the CLI's
// own help documents it — must have it honoured by the studio they started. It
// was being deleted from every child's environment rather than only the ones
// that follow a switch, so the event log quietly went somewhere else.
const elsewhere = path.join(tmp, 'state-elsewhere');
const kept = supervise([0], { STUDIO_STATE_DIR: elsewhere });
check('an explicit state directory reaches the studio that was started',
  kept.runs[0]?.stateDir === elsewhere, kept.runs[0]?.stateDir || 'not set');

// It must not follow the studio to a different project, or every project after
// the first would quietly share one event log.
const second = fs.mkdtempSync(path.join(tmp, 'other-'));
fs.writeFileSync(path.join(second, 'PROJECT.md'), '# Elsewhere');
const switched = supervise([75, 0], { STUDIO_STATE_DIR: elsewhere, STANDIN_SWITCH_TO: second });
check('a switch lands in the new project', switched.runs[1]?.root === second,
  switched.runs[1]?.root || 'no second run');
check('and does not carry the old state directory with it',
  switched.runs[1]?.stateDir === null, switched.runs[1]?.stateDir || 'null');

// Restarting in place goes through the switch path — it is a switch to the
// project already open — and must not be treated as a move. Dropping the
// operator's overrides there would put the event log somewhere new, which in a
// container means the team's memory quietly leaves the mounted volume.
const inPlace = supervise([75, 0], { STUDIO_STATE_DIR: elsewhere, STANDIN_SWITCH_TO: tmp });
check('a restart in place still lands in the same project',
  inPlace.runs[1]?.root === tmp, inPlace.runs[1]?.root || 'no second run');
check('and keeps the state directory it was given',
  inPlace.runs[1]?.stateDir === elsewhere, inPlace.runs[1]?.stateDir || 'dropped');

console.log('\n what the feed shows');
const line = describe({
  kind: 'studio.recovered',
  data: { code: 1, signal: null, ranMs: 4_000, attempt: 1, downMs: 1_200 },
});
check('the recovery reads as a sentence in the timeline',
  line.includes('restarted') && line.includes('code 1') && line.includes('down for'), line);
check('a signal is named rather than reported as a null exit code',
  describe({ kind: 'studio.recovered', data: { signal: 'SIGKILL', downMs: 1_000 } }).includes('SIGKILL'));

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover tmp */ }

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
