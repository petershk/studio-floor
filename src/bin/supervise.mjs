#!/usr/bin/env node
/**
 * The supervisor.
 *
 * `studio start` runs this, and this runs the actual studio in a child process.
 * The indirection buys exactly one thing, and it is the thing that makes
 * switching projects possible: `PROJECT_ROOT` is resolved when the studio's
 * modules are imported, and the store replays one project's event log on the way
 * up. A running studio therefore cannot be re-pointed — it can only be replaced.
 *
 * So the child exits with EXIT_SWITCH, the supervisor reads where to go, and
 * starts a fresh child there. The old process is fully gone before the new one
 * binds, which means no port race and no chance of two studios writing to one
 * log.
 *
 * It also brings the studio back when it dies. An always-on team is worth
 * nothing if a crash at 2am is discovered at 9am, and this process is the only
 * one still standing at the moment the studio stops. Restarts are bounded and
 * backed off, because a studio that cannot bind its port would otherwise spin
 * forever, and the reason is handed to the new child so the feed can show the
 * gap rather than swallowing it.
 *
 * A clean exit and a Ctrl-C are passed straight through, exactly as before.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SRC_DIR, EXIT_SWITCH, EXIT_REFUSED, HOME_DIR_NAME, ensureUserDir,
} from '../core/paths.mjs';
import { takeSwitch, rememberProject, resetProjectState, inspect, problemsWith } from '../core/projects.mjs';

/**
 * The studio to run.
 *
 * Overridable so this file's own behaviour can be tested. Proving that a dead
 * studio comes back requires a studio that dies on command, and the only other
 * way to get one is to break the real one.
 */
const SERVER = process.env.STUDIO_SERVER_ENTRY
  ? path.resolve(process.env.STUDIO_SERVER_ENTRY)
  : path.join(SRC_DIR, 'bin', 'serve.mjs');

/**
 * How long to wait before each successive restart, and how many there are.
 *
 * The first is nearly immediate because most crashes are transient and the
 * team should lose seconds, not minutes. The last is long because by then the
 * cause is clearly not transient, and hammering a broken machine helps nobody.
 */
const RESTART_DELAYS_MS = (process.env.STUDIO_RESTART_DELAYS_MS || '1000,2000,5000,15000,30000')
  .split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n >= 0);

/** A studio that ran this long before dying was not in a crash loop. */
const HEALTHY_AFTER_MS = Number(process.env.STUDIO_HEALTHY_AFTER_MS || 60_000);

const argv = process.argv.slice(2);

let projectRoot = path.resolve(process.env.STUDIO_PROJECT_ROOT || process.cwd());
let child = null;
let shuttingDown = false;
let started = false;

ensureUserDir();

const problems = problemsWith(inspect(projectRoot));
if (problems.length) {
  console.error(`studio: cannot use ${projectRoot} — ${problems.join('; ')}`);
  process.exit(1);
}

run();

async function run() {
  let crashes = 0;
  let recovery = null;

  for (;;) {
    rememberProject(projectRoot, new Date().toISOString());
    const startedAt = Date.now();
    const { code, signal } = await once(projectRoot, recovery);
    const ranMs = Date.now() - startedAt;
    recovery = null;

    if (code !== EXIT_SWITCH) {
      // Ctrl-C, or the studio deciding it was done: pass it through untouched.
      // A signal we did not send is a death, not a shutdown — an OOM kill and a
      // `kill -9` both arrive this way, and both are exactly what this exists
      // for. Note the child reports `code: null` when a signal took it.
      // EXIT_REFUSED is the studio saying starting it again changes nothing —
      // a roster typo, a port already taken. Restarting those spends the whole
      // budget printing the same error five more times over the one the human
      // needs to read.
      if (shuttingDown || code === EXIT_REFUSED || (code === 0 && !signal)) process.exit(code ?? 0);

      // A studio that ran for hours before dying is not in a crash loop, so it
      // gets the full budget of restarts again rather than the tail of the last
      // failure's.
      if (ranMs > HEALTHY_AFTER_MS) crashes = 0;

      const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
      if (crashes >= RESTART_DELAYS_MS.length) {
        console.error(`\nstudio: the studio ${how} after ${human(ranMs)}.`);
        console.error(`studio: that is ${crashes + 1} deaths in a row — not restarting again.`);
        console.error('studio: nothing is lost. The event log is intact and `studio start` replays it;');
        console.error('        `studio status` shows what it recorded, and the output above says why.\n');
        process.exit(code ?? 1);
      }

      const waitMs = RESTART_DELAYS_MS[crashes];
      crashes += 1;
      console.error(`\nstudio: the studio ${how} after ${human(ranMs)}.`);
      console.error(`studio: restarting in ${Math.round(waitMs / 1000)}s `
        + `(attempt ${crashes} of ${RESTART_DELAYS_MS.length})\n`);
      const downFrom = Date.now();
      await sleep(waitMs);
      if (shuttingDown) process.exit(code ?? 1);
      // Handed to the child, which is the only process that may write the log.
      recovery = {
        code: code ?? null, signal: signal || null, ranMs, attempt: crashes, downMs: Date.now() - downFrom,
      };
      continue;
    }

    const req = takeSwitch();
    if (!req) {
      console.error('studio: a switch was requested but no destination was recorded; stopping.');
      process.exit(1);
    }

    const info = inspect(req.path);
    const bad = problemsWith(info);
    if (bad.length) {
      // Refuse the move rather than leaving the human with nothing running.
      console.error(`studio: cannot switch to ${req.path} — ${bad.join('; ')}`);
      console.error(`studio: staying on ${projectRoot}`);
    } else {
      if (req.reset) {
        const { removed, path: p } = resetProjectState(req.path);
        console.log(removed ? `\n  reset — removed ${p}` : `\n  reset — nothing to remove at ${p}`);
      }
      projectRoot = path.resolve(req.path);
      console.log(`\n  switching to ${projectRoot}\n`);
    }
  }
}

function once(root, recovery = null) {
  return new Promise((resolve) => {
    const env = { ...process.env, STUDIO_PROJECT_ROOT: root };
    // Only ever set on the start that follows a death, and never inherited by
    // the one after that — a studio that logged "recovered" every morning
    // because the variable stuck around would teach the human to ignore it.
    if (recovery) env.STUDIO_RECOVERED = JSON.stringify(recovery);
    else delete env.STUDIO_RECOVERED;
    // Only the first child opens a browser. A project switch or a self-update
    // comes back into a tab that is already sitting there waiting to reconnect,
    // so opening another one on every restart would pile them up.
    if (started) env.STUDIO_RESTARTED = '1';
    started = true;
    // A switch must not inherit the previous project's overrides, or every
    // project after the first would quietly share one config and one event log.
    delete env.STUDIO_CONFIG;
    delete env.STUDIO_STATE_DIR;

    child = spawn(process.execPath, [SERVER, ...argv], { env, stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      child = null;
      // A child killed by a signal reports a null code. The signal used to be
      // flattened to a clean exit 0 here, which was harmless when nothing acted
      // on the answer and is not now: an OOM-killed studio would have read as a
      // tidy shutdown and never come back. Both are reported and the caller
      // decides, since only it knows whether we asked for the signal.
      resolve({ code, signal: signal || null });
    });
    child.on('error', (err) => {
      console.error(`studio: could not start the studio process — ${err.message}`);
      child = null;
      resolve({ code: 1, signal: null });
    });
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    // The child prints its own shutdown line and stops its agents; wait for it
    // rather than racing it, or agents get orphaned mid-turn.
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** "4s", "3m", "2h 5m" — how long the studio managed before it died. */
function human(ms) {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export { SERVER, HOME_DIR_NAME, fileURLToPath, fs };
