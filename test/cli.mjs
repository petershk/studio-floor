/**
 * The CLI is the common agent channel. Exercise the executable itself against
 * an isolated real server: testing handleAction alone cannot catch argument
 * parsing, identity propagation, exit codes, or information the CLI drops.
 *
 * The CLI process loads AGENT_IDS from the project it is pointed at. If that
 * is the live repo, a human editing the roster (removing `codex`, adding a
 * fourth agent) turns this file red. The isolated server already has its own
 * temp project; the CLI child must be pointed at the same fixture, or the
 * two sides of the test disagree about who exists.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStudioServer, studioUrl, STUDIO_DIR } from './harness.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const boot = `
import { Store } from ${JSON.stringify(studioUrl('core/store.mjs'))};
import { createHttpServer } from ${JSON.stringify(studioUrl('server/server.mjs'))};
const store = new Store();
studioTestReady(store, createHttpServer(store, null));
`;

// Names that are not this studio's live team, so a roster edit cannot make
// the suite red and a forgotten STUDIO_PROJECT_ROOT fails loudly.
const ME = 'alpha';
const OTHER = 'beta';
const THIRD = 'gamma';
const LIVE_LOOKING = new Set(['codex', 'claude', 'grok', 'grok-imp']);
if ([ME, OTHER, THIRD].some((id) => LIVE_LOOKING.has(id))) {
  throw new Error('cli fixture ids must not match a live roster name — that is how a forgotten STUDIO_PROJECT_ROOT goes green against the real studio');
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-'));
const fixtureConfigPath = path.join(fixtureRoot, 'studio_floor', 'config.json');
fs.mkdirSync(path.dirname(fixtureConfigPath), { recursive: true });
fs.writeFileSync(fixtureConfigPath, JSON.stringify({
  project: { name: 'CLI fixture', brief: 'PROJECT.md' },
  agents: [
    { id: ME, provider: 'codex', persona: 'implementer' },
    { id: OTHER, provider: 'claude', persona: 'architect' },
    { id: THIRD, provider: 'grok', persona: 'adversary' },
  ],
}, null, 2));

const server = await startStudioServer({
  boot,
  root: fixtureRoot,
  prefix: 'studio-cli-',
  env: { STUDIO_CONFIG: fixtureConfigPath },
});
const cliPath = path.join(STUDIO_DIR, 'cli', 'studio.mjs');

function cli(args, agent = ME) {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      STUDIO_URL: server.base,
      STUDIO_AGENT: agent,
      STUDIO_PROJECT_ROOT: fixtureRoot,
      STUDIO_CONFIG: fixtureConfigPath,
    },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    output: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

function succeeds(name, args, agent = ME) {
  const r = cli(args, agent);
  check(name, r.code === 0, `exit ${r.code}: ${r.output.trim()}`);
  return r;
}

try {
  console.log('studio CLI');

  succeeds('join registers the invoking identity', [
    'join', '--strengths', 'integration,invariants', '--intro', 'CLI test',
  ]);
  const brief = succeeds('brief renders current shared state', ['brief']);
  check('brief names the invoking agent', brief.stdout.includes(`(you are: ${ME})`), brief.stdout.slice(0, 100));

  succeeds('say accepts targeting and a message kind', [
    'say', 'challenge from CLI', '--to', `${OTHER},${THIRD}`, '--kind', 'challenge',
  ]);
  const ask = succeeds('ask reports the created question id', ['ask', 'Does the CLI round-trip?']);
  check('ask prints Q id', /ok Q-\d+/.test(ask.stdout), ask.stdout.trim());
  succeeds('answer closes the question by id', ['answer', 'Q-01', 'yes']);

  const task = succeeds('task new reports the created task id', [
    'task', 'new', '--title', 'CLI task', '--objective', 'exercise the channel',
    '--owner', ME, '--reviewer', OTHER,
  ]);
  check('task new prints TASK id', /ok TASK-\d+/.test(task.stdout), task.stdout.trim());
  succeeds('tasks filters by owner', ['tasks', '--owner', ME]);
  succeeds('task show renders one task', ['task', 'show', 'TASK-01']);
  succeeds('task set updates lifecycle state', ['task', 'set', 'TASK-01', '--state', 'active', '--note', 'started']);
  succeeds('state links agent work to the task', ['state', 'working', '--task', 'TASK-01', '--note', 'CLI sweep']);

  const debate = succeeds('debate open reports its id', [
    'debate', 'open', '--question', 'Does the CLI serialize debates?', '--task', 'TASK-01',
  ]);
  check('debate open prints DEB id', /ok DEB-\d+/.test(debate.stdout), debate.stdout.trim());
  succeeds('debate say records a position', [
    'debate', 'say', 'DEB-01', '--stance', 'yes', '--because', 'the event is visible',
  ]);
  const decision = succeeds('decide reports its id', [
    'decide', '--question', 'CLI decision?', '--chosen', 'yes', '--why', 'observed',
    '--alternatives', 'yes|no', '--participants', `${ME},${OTHER}`, '--task', 'TASK-01',
  ]);
  check('decide prints DEC id', /ok DEC-\d+/.test(decision.stdout), decision.stdout.trim());
  succeeds('debate close links the recorded decision', [
    'debate', 'close', 'DEB-01', '--outcome', 'yes', '--decision', 'DEC-01',
  ]);

  const attention = succeeds('attention raises the human-facing item', [
    'attention', '--kind', 'review', '--text', 'Review the CLI task', '--ref', 'TASK-01',
  ]);
  check(
    'attention prints the ATT id required by withdraw',
    /ok ATT-\d+/.test(attention.stdout),
    `printed ${JSON.stringify(attention.stdout.trim())}`,
  );

  succeeds('files records changed paths', [
    'files', '--action', 'changed', '--files', 'src/cli/studio.mjs', '--task', 'TASK-01',
  ]);
  succeeds('validate preserves an observed pass', [
    'validate', '--name', 'CLI test', '--command', 'node test', '--ok', '--output', 'passed', '--task', 'TASK-01',
  ]);
  succeeds('discover records durable shared knowledge', [
    'discover', 'the CLI executable reached the isolated server',
  ]);
  succeeds('log renders recent event metadata', ['log', '--limit', '5']);

  const badIdentity = cli(['say', 'phantom'], 'not-an-agent');
  check('an invalid CLI identity exits nonzero', badIdentity.code !== 0, badIdentity.output.trim());
  check('the identity error tells the caller how to recover', badIdentity.stderr.includes('STUDIO_AGENT'), badIdentity.stderr.trim());

  const badTarget = cli(['say', 'lost', '--to', 'nobody']);
  check('a server refusal makes the CLI exit nonzero', badTarget.code !== 0, badTarget.output.trim());
  check('the CLI preserves the server refusal reason', badTarget.stderr.includes('unknown recipient'), badTarget.stderr.trim());

  const state = await server.get('/api/state');
  check(
    'say targeting and text survived CLI serialization',
    state.messages.some((m) =>
      m.from === ME
      && m.kind === 'challenge'
      && m.text === 'challenge from CLI'
      && m.to.join(',') === `${OTHER},${THIRD}`),
    JSON.stringify(state.messages),
  );
  check('no phantom agent was projected', !state.agents['not-an-agent'], JSON.stringify(Object.keys(state.agents)));
} finally {
  server.stop();
  // Retries, for the same reason smoke.mjs spells out: a Store holds an open
  // append handle on events.jsonl, Windows refuses to remove a directory
  // containing an open file, and the error is ENOTEMPTY — which does not
  // sound like "a handle is still open". Node 22's rmSync retries internally
  // and Linux does not care, so without this the failure appears on exactly
  // one leg of the matrix, intermittently. It did: windows-latest / node 20.
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log(failures ? `\n${failures} FAILED` : '\nall CLI checks passed');
process.exitCode = failures ? 1 : 0;
