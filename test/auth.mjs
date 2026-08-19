#!/usr/bin/env node
/**
 * Where an agent's credentials come from, and whether it has any.
 *
 * On a laptop this question never arises: every CLI holds a login from when its
 * human signed in, so the studio spawns it and it authenticates itself. In a
 * container none of that exists, and the same roster fails on every turn.
 *
 * It failed silently, which is the part these assertions are about. `studio
 * doctor` reported `ok claude → claude (2.1.235)` on a box where claude
 * answered every turn with "Not logged in · Please run /login" — because doctor
 * asked whether the binary existed, and it did. Installed and authenticated are
 * two facts, and everything below exists to keep them separately answerable.
 *
 *   node test/auth.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-auth-'));
process.env.STUDIO_STATE_DIR = path.join(tmp, 'state');

const {
  putSecret, getSecret, listSecrets, removeSecret, secretNameFor, secretKey, NO_KEY,
} = await import('../src/core/secrets.mjs');
const { resolveAuth, AUTH_MODES } = await import('../src/core/auth.mjs');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\ncredentials\n');
console.log(' the secret store');

const file = path.join(tmp, 'secrets.json');
const withKey = { STUDIO_SECRET_KEY: 'a-passphrase-of-some-length' };

check('a passphrase is read from the environment', secretKey(withKey) === 'a-passphrase-of-some-length');
check('and an empty one is no passphrase', secretKey({ STUDIO_SECRET_KEY: '   ' }) === null);

// n8n ships a default encryption key for instances that set none, which is why
// every hardening guide for it opens by telling you to change it. Refusing is
// the version of that decision that cannot be got wrong by not reading the docs.
let refused = null;
try { putSecret('x', 'y', { file, env: {} }); } catch (e) { refused = e.message; }
check('storing without a passphrase is refused, not done in the clear', refused === NO_KEY, refused || 'stored anyway');
check('and the refusal says how to fix it', /STUDIO_SECRET_KEY/.test(refused || '') && /environment variable/.test(refused || ''));

putSecret('agent:claude:apiKey', 'sk-ant-secret', { file, env: withKey });
check('a stored secret comes back', getSecret('agent:claude:apiKey', { file, env: withKey }) === 'sk-ant-secret');

const onDisk = fs.readFileSync(file, 'utf8');
check('and is not on disk in the clear', !onDisk.includes('sk-ant-secret'), onDisk.slice(0, 120));

if (process.platform !== 'win32') {
  check('the file is readable only by its owner', (fs.statSync(file).mode & 0o777) === 0o600);
} else {
  check('the file is readable only by its owner', true, 'skipped: POSIX modes are not enforced on Windows');
}

// A studio restarted with a different passphrase holds entries it cannot read.
// Saying so is the difference between "your key is wrong" and an agent that
// mysteriously stops being able to authenticate.
const wrongKey = { STUDIO_SECRET_KEY: 'not-the-same-passphrase' };
check('a wrong passphrase reads as absent rather than throwing',
  getSecret('agent:claude:apiKey', { file, env: wrongKey }) === null);
check('and the listing admits the entry is unreadable',
  listSecrets({ file, env: wrongKey })['agent:claude:apiKey'].readable === false);
check('while the right one says it is readable',
  listSecrets({ file, env: withKey })['agent:claude:apiKey'].readable === true);

const listed = JSON.stringify(listSecrets({ file, env: withKey }));
check('a listing never carries a value', !listed.includes('sk-ant-secret'), listed);

check('a secret can be removed', (removeSecret('agent:claude:apiKey', { file }),
  getSecret('agent:claude:apiKey', { file, env: withKey }) === null));

fs.writeFileSync(path.join(tmp, 'torn.json'), '{"entries":');
check('a torn file reads as empty rather than stopping the studio',
  getSecret('anything', { file: path.join(tmp, 'torn.json'), env: withKey }) === null);

check('the name for an agent is stable and namespaced',
  secretNameFor('claude') === 'agent:claude:apiKey');

console.log('\n which mode an agent is in');

const claude = { id: 'claude', apiKeyVar: 'ANTHROPIC_API_KEY', loginHint: 'claude /login' };
// The Grok CLI publishes no key variable and authenticates with `grok login`,
// so an adapter that claimed one would produce an agent that looks configured
// and fails anyway.
const grok = { id: 'grok', loginHint: 'grok login' };
const agent = (id, options = {}) => ({ id, options });

const auto = resolveAuth(agent('claude'), claude, { env: {} });
check('with nothing configured an agent falls back to the CLI login', auto.mode === 'auto' && auto.source === 'login');
check('which is not an error, because on a laptop it is the working case', auto.ok === true);
check('and it names where that login lives', auto.detail.includes('claude /login'), auto.detail);

const inherited = resolveAuth(agent('claude'), claude, { env: { ANTHROPIC_API_KEY: 'sk-env' } });
check('a key in the environment is found and named', inherited.source === 'environment' && inherited.detail.includes('ANTHROPIC_API_KEY'));
check('and is not re-injected, since it is already there', Object.keys(inherited.env).length === 0);

process.env.STUDIO_SECRET_KEY = 'a-passphrase-of-some-length';
const { SECRETS_FILE } = await import('../src/core/paths.mjs');
putSecret(secretNameFor('claude'), 'sk-stored', { file: SECRETS_FILE, env: process.env });

const stored = resolveAuth(agent('claude'), claude, { env: { STUDIO_SECRET_KEY: process.env.STUDIO_SECRET_KEY } });
check('a key stored in the studio is injected into the variable the CLI reads',
  stored.env.ANTHROPIC_API_KEY === 'sk-stored', JSON.stringify(stored));

// The environment must win. A deployment injects keys that way, and a value the
// operator put in the container cannot be silently overridden by something
// typed into a browser months earlier.
const both = resolveAuth(agent('claude'), claude, {
  env: { STUDIO_SECRET_KEY: process.env.STUDIO_SECRET_KEY, ANTHROPIC_API_KEY: 'sk-env' },
});
check('the environment beats the studio store', both.source === 'environment' && !both.env.ANTHROPIC_API_KEY);

console.log('\n when the mode is a choice rather than a description');

const login = resolveAuth(agent('claude', { auth: 'login' }), claude, { env: { ANTHROPIC_API_KEY: 'sk-env' } });
check('asking for the CLI login clears the key variables', login.unset.includes('ANTHROPIC_API_KEY'));
check('so an inherited key cannot quietly win instead', Object.keys(login.env).length === 0 && login.source === 'login');

const wantsKey = resolveAuth(agent('claude', { auth: 'key' }), claude, { env: {} });
check('asking for a key with no key is a failure, before a turn is spent', wantsKey.ok === false);
check('and it says exactly what is missing', /ANTHROPIC_API_KEY/.test(wantsKey.detail) && /not set/.test(wantsKey.detail), wantsKey.detail);

const noVar = resolveAuth(agent('grok', { auth: 'key' }), grok, { env: {} });
check('a provider with no key variable says so rather than inventing one', noVar.ok === false);
check('and points at what would work instead', /apiKeyEnv/.test(noVar.detail) || /own login/.test(noVar.detail), noVar.detail);

const named = resolveAuth(agent('claude', { auth: 'key', apiKeyEnv: 'MY_OWN_KEY' }), claude, { env: { MY_OWN_KEY: 'sk-mine' } });
check('a named variable overrides the adapter default', named.ok && named.detail.includes('MY_OWN_KEY'));

const pointed = resolveAuth(agent('grok', { baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY' }), grok, { env: { XAI_API_KEY: 'k' } });
check('an agent pointed at another backend is left to its adapter', pointed.mode === 'backend' && Object.keys(pointed.env).length === 0);
check('and is reported as unauthenticated when that key is missing',
  resolveAuth(agent('grok', { baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY' }), grok, { env: {} }).ok === false);

check('an unknown mode falls back to auto rather than refusing to run',
  resolveAuth(agent('claude', { auth: 'nonsense' }), claude, { env: {} }).mode === 'auto');
check('the modes offered are the modes understood', AUTH_MODES.join(',') === 'auto,key,login');

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover tmp */ }

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
