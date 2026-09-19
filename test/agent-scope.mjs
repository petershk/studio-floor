#!/usr/bin/env node
/**
 * An agent gets its own credential, and it opens very little.
 *
 * Every agent used to be spawned with the studio's whole environment, which
 * included STUDIO_TOKEN — the human's own API credential. An agent holding it
 * could POST /api/config to widen its sandbox or rename the roster, speak as
 * the human through /api/human/say, stop its colleagues, and read the secrets
 * route. It also held every other agent's provider key. None of that is agent
 * work; all of it was one fetch away.
 *
 * So the environment is an allowlist and the credential is scoped. This holds
 * both halves: what a turn's process is handed, and what that token may do.
 *
 *   node test/agent-scope.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStudioServer, studioUrl } from './harness.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\nagent-scope — what an agent is handed, and what it may do\n');

// ------------------------------------------------- what the process inherits

const { agentEnv } = await import('../src/agents/child-env.mjs');

const base = {
  PATH: '/usr/bin',
  HOME: '/home/studio',
  STUDIO_TOKEN: 'the-humans-token',
  STUDIO_GIT_TOKEN: 'ghp_pushes_to_your_repos',
  TUNNEL_TOKEN: 'ey-tunnel',
  ANTHROPIC_API_KEY: 'sk-belongs-to-another-agent',
  XAI_API_KEY: 'xai-also-not-yours',
  AWS_SECRET_ACCESS_KEY: 'not-even-ours',
};
const env = agentEnv({
  base,
  studio: { STUDIO_AGENT: 'builder', STUDIO_AGENT_TOKEN: 'builders-own' },
  secrets: { ANTHROPIC_AUTH_TOKEN: 'the-one-key-this-agent-may-use' },
});

check('the CLI can still find its binaries and its home', env.PATH === '/usr/bin' && env.HOME === '/home/studio');
check('the human\'s token is withheld', env.STUDIO_TOKEN === undefined);
check('the git token is withheld', env.STUDIO_GIT_TOKEN === undefined);
check('the tunnel token is withheld', env.TUNNEL_TOKEN === undefined);
check('another agent\'s key is withheld', env.ANTHROPIC_API_KEY === undefined && env.XAI_API_KEY === undefined);
check('an unrelated cloud credential is withheld', env.AWS_SECRET_ACCESS_KEY === undefined);
check('its own key is passed explicitly', env.ANTHROPIC_AUTH_TOKEN === 'the-one-key-this-agent-may-use');
check('it is told who it is and how to speak', env.STUDIO_AGENT === 'builder' && env.STUDIO_AGENT_TOKEN === 'builders-own');
check('nothing else leaked in', Object.keys(env).sort().join(',')
  === 'ANTHROPIC_AUTH_TOKEN,HOME,PATH,STUDIO_AGENT,STUDIO_AGENT_TOKEN', Object.keys(env).join(','));

const cleared = agentEnv({
  base: { PATH: '/usr/bin' },
  secrets: { ANTHROPIC_API_KEY: 'sk-1' },
  unset: ['ANTHROPIC_API_KEY'],
});
check('auth: login still clears the key it is told to clear', cleared.ANTHROPIC_API_KEY === undefined);

// A key the operator set in the studio's environment must still reach the one
// agent entitled to it — withholding it wholesale would break every deployment
// that injects keys that way.
const { resolveAuth } = await import('../src/core/auth.mjs');
const claude = (await import('../src/agents/adapters/claude.mjs')).default;
const fromEnv = resolveAuth(
  { id: 'builder', provider: 'claude', options: {} },
  claude,
  { env: { ANTHROPIC_API_KEY: 'sk-operator' } },
);
check('a key set in the studio\'s environment is carried to its own agent',
  fromEnv.env.ANTHROPIC_API_KEY === 'sk-operator', JSON.stringify(fromEnv.env));

// ------------------------------------------------------- what the token opens

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agent-scope-'));
fs.mkdirSync(path.join(root, 'studio_floor'), { recursive: true });
fs.writeFileSync(path.join(root, 'PROJECT.md'), '# Scope fixture\n\nProve the token is narrow.\n');
fs.writeFileSync(path.join(root, 'studio_floor', 'config.json'), JSON.stringify({
  project: { name: 'Scope fixture', brief: 'PROJECT.md', workDir: '.' },
  agents: [{ id: 'builder', provider: 'claude' }, { id: 'breaker', provider: 'claude' }],
}, null, 2));

const tokenFile = path.join(root, 'agent-token.txt');
const boot = `
import fs from 'node:fs';
import { Store } from ${JSON.stringify(studioUrl('core/store.mjs'))};
import { createHttpServer } from ${JSON.stringify(studioUrl('server/server.mjs'))};
import { Runner, loadConfig } from ${JSON.stringify(studioUrl('agents/runner.mjs'))};
const s = new Store();
const runner = new Runner(s, loadConfig());
// The runner mints these and never logs them, so the test is handed one the
// same way an agent is: out of band, for this run only.
fs.writeFileSync(${JSON.stringify(tokenFile)}, runner.agentForToken ? [...runner.agents].map(([id, a]) => id + ' ' + a.token).join('\\n') : '');
studioTestReady(s, createHttpServer(s, runner));
`;

const server = await startStudioServer({
  boot,
  root,
  prefix: 'studio-agent-scope-',
  env: { STUDIO_TOKEN: 'the-humans-token', STUDIO_CONFIG: path.join(root, 'studio_floor', 'config.json') },
});

const tokens = Object.fromEntries(
  fs.readFileSync(tokenFile, 'utf8').trim().split('\n').map((l) => l.split(' ')),
);
check('the runner minted a token per agent', Boolean(tokens.builder && tokens.breaker)
  && tokens.builder !== tokens.breaker);

const call = async (pathname, token, payload = null, method = payload ? 'POST' : 'GET') => {
  const res = await fetch(`${server.base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  let parsed = null;
  try { parsed = JSON.parse(await res.text()); } catch { /* status is the assertion */ }
  return { status: res.status, body: parsed };
};

const AGENT = tokens.builder;
const HUMAN = 'the-humans-token';

// What an agent is for.
const said = await call('/api/action', AGENT, { verb: 'say', agent: 'builder', to: ['breaker'], text: 'starting on the parser' });
check('an agent can speak to the team', said.status === 200 && said.body?.ok !== false, JSON.stringify(said.body));

const state = await call('/api/state', AGENT);
check('an agent can read shared state', state.status === 200);

const inbox = await call('/api/inbox?agent=builder', AGENT);
check('an agent can read its inbox', inbox.status === 200);

// What it is not for.
const widen = await call('/api/config', AGENT, { project: { workDir: '..' } });
check('an agent cannot rewrite the config', widen.status === 403, `status ${widen.status}`);
check('and is told to raise it instead', /attention/.test(widen.body?.error || ''), widen.body?.error || '');

const asHuman = await call('/api/human/say', AGENT, { text: 'the director says ship it' });
check('an agent cannot speak as the human', (await call('/api/human/say', AGENT, { text: 'x' })).status === 403
  && asHuman.status === 403, `status ${asHuman.status}`);

const stopThem = await call('/api/runner/stop', AGENT, { agent: 'breaker' });
check('an agent cannot stop its colleagues', stopThem.status === 403, `status ${stopThem.status}`);

const secrets = await call('/api/secrets', AGENT, { agent: 'breaker', key: 'sk-steal' });
check('an agent cannot reach the secrets route', secrets.status === 403, `status ${secrets.status}`);

const switched = await call('/api/projects', AGENT, { path: '/tmp' });
check('an agent cannot switch the project', switched.status === 403, `status ${switched.status}`);

// Nor may it wear another agent's name.
const impersonate = await call('/api/action', AGENT, { verb: 'say', agent: 'breaker', to: ['builder'], text: 'looks good to me' });
check('an agent cannot act as another agent', impersonate.status === 403, JSON.stringify(impersonate.body));

const ackOther = await call('/api/inbox/ack', AGENT, { agent: 'breaker', through: 1 });
check('nor acknowledge another agent\'s inbox', ackOther.status === 403, `status ${ackOther.status}`);

// An agent that names nobody is itself: the CLI sends the id, but a turn that
// forgot to must not become an anonymous write.
const implicit = await call('/api/action', AGENT, { verb: 'state', state: 'working', note: 'on it' });
check('an agent that names nobody is itself', implicit.status === 200, JSON.stringify(implicit.body));
const after = await call('/api/state', HUMAN);
check('and the event is recorded against it', after.body?.agents?.builder?.state === 'working',
  JSON.stringify(after.body?.agents?.builder));

// The human's token still opens everything.
const humanSaid = await call('/api/human/say', HUMAN, { text: 'use the parser you proposed' });
check('the human is unaffected', humanSaid.status === 200, JSON.stringify(humanSaid.body));

// And a stranger still gets nothing.
const stranger = await call('/api/state', 'not-a-token');
check('an unknown token is still refused', stranger.status === 401, `status ${stranger.status}`);

server.stop();
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover tmp */ }

console.log(failures ? `\n${failures} agent-scope check(s) failed\n` : '\nall agent-scope checks passed\n');
process.exitCode = failures ? 1 : 0;
