#!/usr/bin/env node
/**
 * A provider that cannot start must not burn the turn budget in silence.
 *
 * On Windows a missing CLI used to spawn, emit 'error', then 'close' without
 * launchFailed. The 3-strike breaker never saw a launch failure, so Codex
 * retried until maxTurns. This drives the real Runner against a command that
 * cannot exist and asserts the breaker fires.
 *
 *   node test/launch-failed.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MISSING = 'definitely-not-a-studio-cmd-xyz';
const AGENT = 'ghost';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-launch-failed-'));
const cfgPath = path.join(tmp, 'studio_floor', 'config.json');
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# Launch-failed fixture\n\nProve the breaker fires.\n');
fs.writeFileSync(cfgPath, JSON.stringify({
  project: { name: 'Launch-failed fixture', brief: 'PROJECT.md' },
  agents: [{ id: AGENT, provider: 'grok', persona: 'adversary', command: MISSING }],
  runner: { maxTurns: 10, cooldownMs: 0, staggerMs: 0, idleBackoffMs: [0], turnTimeoutMs: 15_000 },
}, null, 2));

process.env.STUDIO_PROJECT_ROOT = tmp;
process.env.STUDIO_CONFIG = cfgPath;

const { Store } = await import('../src/core/store.mjs');
const { Runner } = await import('../src/agents/runner.mjs');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\nlaunch-failed — a missing command stops after three strikes\n');

const store = new Store();
const runner = new Runner(store, {
  maxTurns: 10,
  cooldownMs: 0,
  staggerMs: 0,
  idleBackoffMs: [0],
  turnTimeoutMs: 15_000,
  commandLineBudget: 28_000,
  project: { name: 'Launch-failed fixture', brief: 'PROJECT.md' },
  agents: [AGENT],
  roster: [{
    id: AGENT,
    provider: 'grok',
    label: 'Ghost',
    persona: '',
    options: { command: MISSING },
  }],
});

const deadline = Date.now() + 25_000;
const saw = await new Promise((resolve) => {
  const hit = { attention: null, stopped: null };
  const done = () => {
    if (hit.attention && hit.stopped) resolve(hit);
  };
  store.on('event', (ev) => {
    if (ev.kind === 'attention.raised' && ev.agent === AGENT) hit.attention = ev;
    if (ev.kind === 'agent.stopped' && ev.agent === AGENT && /failed to launch/i.test(ev.data?.reason || '')) {
      hit.stopped = ev;
    }
    done();
  });
  runner.start(AGENT);
  const tick = setInterval(() => {
    if (Date.now() > deadline) {
      clearInterval(tick);
      resolve(hit);
    }
    if (hit.attention && hit.stopped) clearInterval(tick);
  }, 50);
});

await runner.stopAll('test finished');

const ends = store.events.filter((e) => e.kind === 'raw.turn.end' && e.agent === AGENT);
const launchErrors = store.events.filter((e) =>
  e.kind === 'raw.error' && e.agent === AGENT && /could not launch/i.test(e.data?.text || ''));

check('the runner attempted at least three turns', ends.length >= 3, `ends=${ends.length}`);
check('each attempt failed to start the process', launchErrors.length >= 3, `errors=${launchErrors.length}`);
check('the third strike raises attention for the human', Boolean(saw.attention), 'no attention.raised');
check(
  'the attention names a launch failure, not a turn failure',
  /cannot be launched/i.test(saw.attention?.data?.text || ''),
  saw.attention?.data?.text || '',
);
check('the agent is stopped', Boolean(saw.stopped), 'no agent.stopped');
check(
  'the stop reason is the 3-strike, not the turn budget',
  /failed to launch 3 times/i.test(saw.stopped?.data?.reason || ''),
  saw.stopped?.data?.reason || '',
);
check(
  'it did not keep retrying after the stop',
  ends.length === 3,
  `ends=${ends.length}`,
);

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover tmp */ }

console.log(failures ? `\n${failures} launch-failed check(s) failed\n` : '\nall launch-failed checks passed\n');
process.exit(failures ? 1 : 0);
