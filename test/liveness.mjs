#!/usr/bin/env node
/**
 * Liveness — the studio leaves proof it was alive, and says so when it was not.
 *
 * This studio died and stayed dead for 87 minutes with nobody the wiser. The
 * gap was never that the failure was subtle; it was that nothing outside the
 * process could be asked. A dead studio cannot answer an HTTP request or push
 * an event, so the only thing that survives it is a file, and the only useful
 * question about that file is what it means once the process is gone.
 *
 * So most of this exercises `describeBeat`, which is pure: a beat can be aged
 * by an hour, or declared orphaned, without waiting an hour or killing anything.
 * The rest proves the writer actually writes, and that `studio status` reports
 * a stopped studio as stopped — with an exit code, so a shell can ask too.
 *
 *   node test/liveness.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  startHeartbeat, readBeat, describeBeat, processAlive, since, STALE_AFTER_MS,
} from '../src/core/heartbeat.mjs';
import {
  livenessState, livenessTitle, studioStatus, QUIET_AFTER_MS, DOWN_GRACE_MS,
} from '../src/web/liveness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'bin', 'studio.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-liveness-'));
const file = path.join(tmp, 'runtime.json');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\nliveness — what a dead studio still tells you\n');

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const MINUTE = 60_000;

/** A beat as it would look from a studio that is up and beating. */
const healthy = {
  pid: process.pid,
  startedAt: at(90 * MINUTE),
  beatAt: at(2_000),
  movedAt: at(30_000),
  seq: 18_554,
  project: tmp,
  url: 'http://127.0.0.1:4173',
  agents: { claude: 'working', grok: 'thinking' },
};

console.log(' what the beat means');

check('a fresh beat from a live process reads as running',
  describeBeat(healthy, { now: NOW, alive: true }).state === 'running');

// THE 87 MINUTES. The file says nothing about stopping, and the process it
// names is gone: that is a death, not a shutdown, and it has to read as one.
const died = describeBeat(healthy, { now: NOW + 87 * MINUTE, alive: false });
check('a beat whose process is gone reads as died', died.state === 'died');
check('and it says roughly how long, rather than only that it is down',
  died.headline.includes('1h 27m'), died.headline);

// The opposite failure, and the reason a bare pid check is not enough: the
// process is there and has stopped doing anything at all.
const wedged = describeBeat(healthy, { now: NOW + 5 * MINUTE, alive: true });
check('a live process that stopped beating reads as wedged', wedged.state === 'wedged');
check('a beat inside the stale window is still just running',
  describeBeat(healthy, { now: NOW + STALE_AFTER_MS - 5_000, alive: true }).state === 'running');

check('a studio that was shut down reads as stopped, not as a failure',
  describeBeat({ ...healthy, stoppedAt: at(0), stopReason: 'shut down', exitCode: 0 },
    { now: NOW, alive: false }).state === 'stopped');

// An uncaught throw still runs the process's exit handlers, so a crash gets
// stamped too. Reporting that as "shut down" would be the same comforting lie
// the 87 minutes were made of.
const crashed = describeBeat({ ...healthy, stoppedAt: at(MINUTE), stopReason: 'exited with code 1', exitCode: 1 },
  { now: NOW, alive: false });
check('a studio that exited badly does not read as a clean shutdown', crashed.state === 'crashed');
check('and the exit code is in the headline', crashed.headline.includes('code 1'), crashed.headline);

check('no beat at all is its own answer, not a crash',
  describeBeat(null, { now: NOW }).state === 'unknown');
check('and it prints as label/value pairs like every other case',
  describeBeat(null, { now: NOW }).detail.every((d) => Array.isArray(d)));

check('a pid of zero is never alive', !processAlive(0) && !processAlive(-1) && !processAlive(null));
check('this process is alive', processAlive(process.pid));

console.log('\n durations');
check('under a minute is seconds', since(45_000) === '45s');
check('one minute is singular', since(MINUTE) === '1 minute');
check('past an hour it says hours and minutes', since(87 * MINUTE) === '1h 27m');
check('past a day it says days', since(50 * 60 * MINUTE) === '2d 2h');
check('a duration it cannot compute says so', since(NaN) === 'unknown');

console.log('\n the writer');

let seq = 10;
const stop = startHeartbeat({ file, intervalMs: 20, snapshot: () => ({ seq, project: tmp }) });
check('it writes a beat immediately, not one interval late', !!readBeat(file));

const first = readBeat(file);
check('the beat names the process that wrote it', first.pid === process.pid);
check('and where it is', first.project === tmp);

await new Promise((r) => { setTimeout(r, 80); });
const second = readBeat(file);
check('it keeps beating', Date.parse(second.beatAt) > Date.parse(first.beatAt));
check('a log that has not moved keeps its movedAt', second.movedAt === first.movedAt);

seq = 11;
await new Promise((r) => { setTimeout(r, 60); });
const moved = readBeat(file);
check('a log that moved updates movedAt', Date.parse(moved.movedAt) > Date.parse(first.movedAt));

stop('shut down', 0);
const stopped = readBeat(file);
check('stopping stamps the file with a reason', stopped.stopReason === 'shut down' && !!stopped.stoppedAt);

// The signal handler and the process's own exit both want to stamp this, and
// the first to arrive knows the most about why. A second stamp would overwrite
// "shut down" with something vaguer.
stop('exited with code 1', 1);
check('a second stop does not overwrite the first reason',
  readBeat(file).stopReason === 'shut down', readBeat(file).stopReason);

check('a torn or missing file reads as no beat, not as an exception',
  readBeat(path.join(tmp, 'nope.json')) === null
  && (fs.writeFileSync(path.join(tmp, 'half.json'), '{"pid":'), readBeat(path.join(tmp, 'half.json')) === null));

console.log('\n the page');

// The page cannot read the heartbeat — it may not be able to reach the machine
// at all — so it judges from what does and does not arrive. Same question,
// different evidence.
const page = (o) => livenessState({ connected: true, downSince: null, lastEventAt: NOW, now: NOW, running: 2, ...o });

check('a connected studio with recent events shows nothing at all',
  page({}).level === 'ok');

check('a one-second blip is not an outage',
  page({ connected: false, downSince: NOW - (DOWN_GRACE_MS - 500) }).level === 'ok');

const down = page({ connected: false, downSince: NOW - 4 * MINUTE, lastEventAt: NOW - 5 * MINUTE, attempts: 14 });
check('a connection that stays down is called out', down.level === 'down');
check('it says how long and how many attempts',
  down.detail.includes('4 minutes') && down.detail.includes('14 reconnect'), down.detail);
// The page genuinely cannot tell a dead studio from a closed laptop lid, and
// saying "THE STUDIO IS NOT RUNNING" would be a guess presented as a fact.
check('it claims only what a browser can know, and points at what can settle it',
  down.headline.includes('NOTHING IS REACHING THIS PAGE') && down.detail.includes('studio status'),
  `${down.headline} / ${down.detail}`);

// THE SILENCE NO CONNECTION CHECK FINDS: the studio answers every request and
// the team has not moved in an hour.
const quiet = page({ lastEventAt: NOW - 61 * MINUTE });
check('a studio that is up while nothing happens is called out too', quiet.level === 'quiet');
check('and it says for how long', quiet.headline.includes('1H 1M'), quiet.headline);
check('inside the quiet window it stays silent',
  page({ lastEventAt: NOW - (QUIET_AFTER_MS - MINUTE) }).level === 'ok');

// A silence the human asked for is not a fault, and warning about it is how a
// warning becomes wallpaper.
check('a paused team is silent on purpose', page({ lastEventAt: NOW - 61 * MINUTE, paused: true }).level === 'ok');
check('a stopped team is too', page({ lastEventAt: NOW - 61 * MINUTE, running: 0 }).level === 'ok');

// The 87 minutes were 87 minutes because nobody was looking at the tab.
check('the tab title carries it into a background tab',
  livenessTitle('down', 'X').includes('no contact')
  && livenessTitle('quiet', 'X').includes('idle')
  && livenessTitle('ok', 'X') === 'X');

console.log('\n one word for what it is doing');

const agentsIn = (...states) => ({
  agents: Object.fromEntries(states.map((st, i) => [`a${i}`, typeof st === 'string' ? { state: st } : st])),
});
const status = (o) => studioStatus({
  connected: true, downSince: null, lastEventAt: NOW, now: NOW, state: agentsIn('idle'), ...o,
});

check('an agent doing something is RUNNING',
  status({ state: agentsIn('working', 'idle') }).label === 'RUNNING');
check('a team with nothing to do is IDLE, not stopped',
  status({ state: agentsIn('idle', 'idle') }).label === 'IDLE');

// Ordered by what a human needs to know first. A team you switched off is not
// a fault, so paused and stopped both outrank a warning about one agent.
check('a paused team says PAUSED even with an agent in error',
  status({ state: { ...agentsIn('error', 'idle'), paused: true } }).label === 'PAUSED');
check('every agent offline is STOPPED',
  status({ state: agentsIn('offline', 'offline') }).label === 'STOPPED');
check('and it says how many stopped on an error',
  status({ state: agentsIn({ state: 'error' }, 'offline') }).detail.includes('error'),
  status({ state: agentsIn({ state: 'error' }, 'offline') }).detail);
check('an agent in error while others run is a WARNING',
  status({ state: agentsIn('error', 'working') }).label === 'WARNING');
check('things waiting on the human say so when nothing is broken',
  status({ attention: 2, state: agentsIn('idle') }).label === 'NEEDS YOU');

// Not being able to see the studio beats anything the studio might be doing.
check('a dropped connection outranks everything the state says',
  status({ connected: false, downSince: NOW - 10_000, state: agentsIn('working') }).label === 'NO CONTACT');
check('but a blink does not', status({ connected: false, downSince: NOW - 500 }).label !== 'NO CONTACT');
check('a refused token outranks even that',
  status({ locked: true, connected: false, downSince: NOW - 10_000 }).label === 'LOCKED');

check('a studio with no agents configured says so rather than claiming to be stopped',
  status({ state: { agents: {} } }).label === 'NO TEAM');

console.log('\n studio status');

const run = (env) => spawnSync(process.execPath, [CLI, 'status'], {
  encoding: 'utf8',
  env: { ...process.env, STUDIO_PROJECT_ROOT: tmp, STUDIO_STATE_DIR: path.join(tmp, 'state'), ...env },
});

const none = run();
check('with no studio ever run, status says so', none.stdout.includes('NO STUDIO HAS RUN HERE'), none.stdout.trim());
check('and exits non-zero, so a shell can ask', none.status === 1, `exit ${none.status}`);

// A pid that has certainly exited, rather than a large number hoped to be
// free: pid_max is in the millions on Linux and a hardcoded 999999 would be
// somebody else's process on a busy CI box one day.
const gone = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' }).pid;
fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'state', 'runtime.json'), JSON.stringify({
  ...healthy, pid: gone, beatAt: new Date(Date.now() - 87 * MINUTE).toISOString(),
}));
const dead = run();
check('a studio that died is reported as not running', dead.stdout.includes('NOT RUNNING'), dead.stdout.trim());
check('with how long it has been silent', /8[67] minutes|1h 2[678]m/.test(dead.stdout), dead.stdout.trim());
check('and it exits non-zero', dead.status === 1, `exit ${dead.status}`);

// A studio that is up must not be reported as down by a status command that
// only knows how to be pessimistic.
fs.writeFileSync(path.join(tmp, 'state', 'runtime.json'), JSON.stringify({
  ...healthy, pid: process.pid, beatAt: new Date().toISOString(),
}));
const up = run();
check('a running studio is reported as running', up.stdout.includes('RUNNING'), up.stdout.trim());
check('and exits zero', up.status === 0, `exit ${up.status}`);

// status must not need the log: it has to answer when the studio is dead, and
// be cheap enough to put in a cron line.
check('status never opens the event log',
  !fs.existsSync(path.join(tmp, 'state', 'events.jsonl')));

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover tmp */ }

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
