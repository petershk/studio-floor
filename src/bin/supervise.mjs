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
 * Every other exit code is passed straight through, so `Ctrl-C`, a crash and a
 * clean shutdown all behave exactly as they did before this existed.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SRC_DIR, EXIT_SWITCH, HOME_DIR_NAME, ensureUserDir,
} from '../core/paths.mjs';
import { takeSwitch, rememberProject, resetProjectState, inspect, problemsWith } from '../core/projects.mjs';

const SERVER = path.join(SRC_DIR, 'bin', 'serve.mjs');
const argv = process.argv.slice(2);

let projectRoot = path.resolve(process.env.STUDIO_PROJECT_ROOT || process.cwd());
let child = null;
let shuttingDown = false;

ensureUserDir();

const problems = problemsWith(inspect(projectRoot));
if (problems.length) {
  console.error(`studio: cannot use ${projectRoot} — ${problems.join('; ')}`);
  process.exit(1);
}

run();

async function run() {
  for (;;) {
    rememberProject(projectRoot, new Date().toISOString());
    const code = await once(projectRoot);

    if (code !== EXIT_SWITCH) {
      process.exit(code ?? 0);
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

function once(root) {
  return new Promise((resolve) => {
    const env = { ...process.env, STUDIO_PROJECT_ROOT: root };
    // A switch must not inherit the previous project's overrides, or every
    // project after the first would quietly share one config and one event log.
    delete env.STUDIO_CONFIG;
    delete env.STUDIO_STATE_DIR;

    child = spawn(process.execPath, [SERVER, ...argv], { env, stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      child = null;
      // A child killed by a signal reports null; treat that as the signal's exit.
      resolve(signal && code === null ? 0 : code);
    });
    child.on('error', (err) => {
      console.error(`studio: could not start the studio process — ${err.message}`);
      child = null;
      resolve(1);
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

export { SERVER, HOME_DIR_NAME, fileURLToPath, fs };
