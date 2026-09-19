#!/usr/bin/env node
/**
 * No agent starts until a human has said where the team works.
 *
 * The work directory used to default to wherever the studio was launched. From
 * inside the studio's own clone — or a container's /workspace, a folder of
 * repositories — that handed the agents a directory nobody chose, and the most
 * likely one was the studio itself. This holds the rule: an unset work
 * directory keeps every agent idle, one that is or contains the studio's own
 * code is refused however it was set, and neither spawns a single process.
 *
 *   node test/workdir-gate.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MISSING = 'definitely-not-a-studio-cmd-gate';
const AGENT = 'held';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-workdir-gate-'));
const cfgPath = path.join(tmp, 'studio_floor', 'config.json');
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# Gate fixture\n\nProve nothing starts unpointed.\n');
// Deliberately no project.workDir: this is the studio nobody has pointed yet.
fs.writeFileSync(cfgPath, JSON.stringify({
  project: { name: 'Gate fixture', brief: 'PROJECT.md' },
  agents: [{ id: AGENT, provider: 'grok', command: MISSING }],
}, null, 2));

process.env.STUDIO_PROJECT_ROOT = tmp;
process.env.STUDIO_CONFIG = cfgPath;

const { resolveWorkDir, agentReadiness } = await import('../src/core/config.mjs');
const { PACKAGE_ROOT } = await import('../src/core/paths.mjs');
const { initProject } = await import('../src/core/scaffold.mjs');
const { AGENTS_READY } = await import('../src/core/roster.mjs');
const { Store } = await import('../src/core/store.mjs');
const { Runner } = await import('../src/agents/runner.mjs');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\nworkdir-gate — agents stay idle until a work directory is chosen\n');

// ---------------------------------------------------------------- the rule

const verdict = (workDir, root = tmp) => agentReadiness(resolveWorkDir(workDir, root));

const unset = verdict('');
check('an unset work directory holds the agents', !unset.ready);
check('and says how to set it', /project\.workDir/.test(unset.reason), unset.reason);

check('"." — the whole project, chosen explicitly — is allowed', verdict('.').ready, verdict('.').reason);

fs.mkdirSync(path.join(tmp, 'game'));
check('a subdirectory that exists is allowed', verdict('game').ready, verdict('game').reason);
check('one that does not exist is held', !verdict('nope').ready);
check('one that escapes the project is held', !verdict('../elsewhere').ready);

const own = verdict('.', PACKAGE_ROOT);
check('the studio\'s own clone is refused even when set', !own.ready);
check('and the reason names the studio', /studio's own code/.test(own.reason), own.reason);
check('a directory containing the studio is refused', !verdict('.', path.dirname(PACKAGE_ROOT)).ready);
check('the studio\'s src/ is refused', !verdict('src', PACKAGE_ROOT).ready);
check('scratch beside it, where the studio dogfoods itself, is not',
  agentReadiness({ ...resolveWorkDir('test_project', PACKAGE_ROOT), exists: true }).ready);

// ---------------------------------------------------------------- init

const fresh = path.join(tmp, 'fresh');
const made = initProject(fresh, { name: 'fresh' });
const written = JSON.parse(fs.readFileSync(path.join(fresh, 'studio_floor', 'config.json'), 'utf8'));
check('studio init is a choice, so it points the team at the project', written.project.workDir === '.',
  JSON.stringify(written.project));
check('and reports nothing held', made.held === '', made.held);

// ---------------------------------------------------------------- the runner

check('this studio resolved as held', !AGENTS_READY.ready, AGENTS_READY.reason);

const store = new Store();
const runner = new Runner(store, {
  maxTurns: 5,
  cooldownMs: 0,
  staggerMs: 0,
  idleBackoffMs: [0],
  turnTimeoutMs: 5_000,
  commandLineBudget: 28_000,
  project: { name: 'Gate fixture', brief: 'PROJECT.md' },
  agents: [AGENT],
  roster: [{ id: AGENT, provider: 'grok', label: 'Held', persona: '', options: { command: MISSING } }],
});

const seen = [];
store.on('event', (ev) => { if (ev.agent === AGENT) seen.push(ev); });

await runner.startAll();
await runner.start(AGENT);
// Long enough for a loop that had started to reach its first launch attempt.
await new Promise((r) => setTimeout(r, 1500));

const note = seen.find((ev) => ev.kind === 'agent.state' && /not started/.test(ev.data?.note || ''));
check('starting an agent by hand is refused with the reason', Boolean(note), JSON.stringify(seen.map((e) => e.kind)));
check('the agent is left offline, not starting', note?.data?.state === 'offline', note?.data?.state);
check('nothing was launched', !seen.some((ev) => ev.kind === 'raw.error' || ev.kind === 'raw.turn.end' || ev.kind === 'raw.turn.start'),
  seen.map((e) => e.kind).join(', '));
check('the runner is not supervising it', !runner.status().agents?.[AGENT]?.running,
  JSON.stringify(runner.status().agents?.[AGENT]));

await runner.stopAll('test finished');
store.close?.();
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover tmp */ }

console.log(failures ? `\n${failures} workdir-gate check(s) failed\n` : '\nall workdir-gate checks passed\n');
process.exitCode = failures ? 1 : 0;
