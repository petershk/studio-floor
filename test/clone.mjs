#!/usr/bin/env node
/**
 * Acquiring a repository, which is the one thing the studio could not do.
 *
 * Most of this is about what reaches `git`. `git clone` takes its options as
 * positional arguments and several of them name a program to run — the classic
 * is `--upload-pack=`, and `--config core.sshCommand=` is the same shape — so a
 * URL that arrives over HTTP and is handed to git unchecked is remote code
 * execution in a URL's clothes. "It starts with https://" is not a check:
 * `--upload-pack=x https://…` starts with neither.
 *
 * So the remote is parsed and rebuilt, never merely inspected, and the tests
 * below are mostly attempts to get something through that is not a remote.
 *
 *   node test/clone.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseRemote, checkName, cloneRepo } from '../src/core/clone.mjs';
import {
  credentialLine, credentialHosts, gitToken, workBranch, ensureGitIdentity, DEFAULT_NAME,
} from '../src/core/git.mjs';
import { startStudioServer, studioUrl } from './harness.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-clone-'));

console.log('\ncloning a repository\n');
console.log(' what is allowed to reach git');

// THE ONE THAT MATTERS. Each of these is a way to make git run a program.
for (const attack of [
  '--upload-pack=touch /tmp/pwned',
  '-u touch /tmp/pwned',
  '--config=core.sshCommand=touch /tmp/pwned',
  '--exec=sh',
  '-c protocol.ext.allow=always ext::sh -c touch',
]) {
  const r = parseRemote(attack);
  check(`refused: ${attack.slice(0, 34)}`, !r.ok, JSON.stringify(r));
}

check('an option hidden behind a real URL is still refused',
  !parseRemote('--upload-pack=sh https://github.com/o/r.git').ok);
check('a URL with whitespace in it is refused',
  !parseRemote('https://github.com/o/r.git --upload-pack=sh').ok);
check('nothing is not a URL', !parseRemote('').ok && !parseRemote(null).ok && !parseRemote('   ').ok);
check('an enormous string is refused before anything parses it',
  !parseRemote(`https://github.com/o/${'r'.repeat(600)}`).ok);

// Local paths are how a remote caller reaches the rest of the disk, so they are
// off unless the caller says otherwise — which only the CLI does.
check('a local path is refused by default', !parseRemote('/etc').ok);
check('and so is file://', !parseRemote('file:///etc/passwd').ok);
check('but a human at a shell may use one', parseRemote(tmp, { allowLocal: true }).ok);

check('git:// and other protocols are refused', !parseRemote('git://github.com/o/r.git').ok
  && !parseRemote('ssh://root@box/etc').ok
  && !parseRemote('http://github.com/o/r.git').ok);

console.log('\n what a remote parses to');

const gh = parseRemote('https://github.com/owner/repo');
check('https without .git is understood', gh.ok && gh.host === 'github.com' && gh.repo === 'owner/repo');
check('and is rebuilt canonically rather than passed through',
  gh.url === 'https://github.com/owner/repo.git', gh.url);
check('a trailing slash and a .git are the same URL',
  parseRemote('https://github.com/owner/repo.git/').url === gh.url);
check('the directory name is the repository, not the owner', gh.name === 'repo', gh.name);

const ssh = parseRemote('git@github.com:owner/repo.git');
check('an ssh remote is understood', ssh.ok && ssh.url === 'git@github.com:owner/repo.git', ssh.url);
check('a nested group is kept whole',
  parseRemote('https://gitlab.com/group/sub/repo').repo === 'group/sub/repo');
check('a host without a repository path is refused', !parseRemote('https://github.com/owner').ok);

console.log('\n where it is allowed to land');
check('a name may not climb out of the workspace',
  !!checkName('../../etc') && !!checkName('a/b') && !!checkName('a\\b'));
check('a name may not be an option or hidden', !!checkName('-rf') && !!checkName('.ssh'));
check('an empty name is refused', !!checkName('') && !!checkName('   '));
check('an ordinary name is fine', checkName('my-repo.2') === null);

console.log('\n the clone itself');

// A real repository, in a directory whose name would break anything that went
// near a shell.
const originParent = path.join(tmp, 'a dir & more');
fs.mkdirSync(originParent, { recursive: true });
const origin = path.join(originParent, 'origin');
fs.mkdirSync(origin);
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
git(['init', '-q', '-b', 'main', '.'], origin);
git(['config', 'user.email', 'fixture@example.invalid'], origin);
git(['config', 'user.name', 'Fixture'], origin);
fs.writeFileSync(path.join(origin, 'README.md'), '# fixture\n');
git(['add', '-A'], origin);
git(['commit', '-qm', 'init'], origin);

const into = path.join(tmp, 'workspace');
const ok = await cloneRepo({ url: origin, into, name: 'demo' });
check('a repository is cloned', ok.ok, ok.error || '');
check('and the files are there', fs.existsSync(path.join(into, 'demo', 'README.md')));
check('a path with spaces and an ampersand survives, because no shell sees it',
  ok.ok && fs.existsSync(path.join(into, 'demo', '.git')));

const missing = await cloneRepo({ url: path.join(tmp, 'no-such-repo'), into, name: 'nope' });
check('a clone that fails says so rather than half-succeeding', !missing.ok);
check('and the reason is readable', typeof missing.error === 'string' && missing.error.length > 0,
  missing.error);

const twice = await cloneRepo({ url: origin, into, name: 'demo' });
check('cloning over an existing directory is refused by git and reported plainly',
  !twice.ok && /already/i.test(twice.error), twice.error);

console.log('\n credentials, which must never be in a URL');

check('a token is read from the environment, in order',
  gitToken({ STUDIO_GIT_TOKEN: 'a', GH_TOKEN: 'b' }).from === 'STUDIO_GIT_TOKEN'
  && gitToken({ GH_TOKEN: 'b' }).from === 'GH_TOKEN'
  && gitToken({}).token === null);
check('an empty variable is not a token', gitToken({ STUDIO_GIT_TOKEN: '  ' }).token === null);

const line = credentialLine('github.com', 'ghp_/we+rd@token');
check('a token with URL characters in it is encoded, not smuggled',
  line.endsWith('@github.com') && line.includes('ghp_%2Fwe%2Brd%40token'), line);
check('extra hosts can be named', credentialHosts({ STUDIO_GIT_HOSTS: 'git.example.com' })
  .join(',') === 'github.com,git.example.com');

// This writes git config, so it is pointed at a throwaway global config file.
// A test that reconfigured the machine it runs on would be a bug worse than any
// it could catch.
const gitconfig = path.join(tmp, 'gitconfig');
const credFile = path.join(tmp, 'creds');
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: gitconfig,
  STUDIO_GIT_TOKEN: 'secret-token-value',
  GH_TOKEN: '',
  GITHUB_TOKEN: '',
  STUDIO_GIT_NAME: '',
  STUDIO_GIT_EMAIL: '',
};
const summary = ensureGitIdentity({ env, file: credFile });
check('the credential file is written when a token is set', summary.wroteCredentials && fs.existsSync(credFile));
check('it contains the token', fs.readFileSync(credFile, 'utf8').includes('secret-token-value'));
if (process.platform !== 'win32') {
  const mode = fs.statSync(credFile).mode & 0o777;
  check('and nobody else can read it', mode === 0o600, mode.toString(8));
} else {
  check('and nobody else can read it', true, 'skipped: POSIX modes are not enforced on Windows');
}
check('the summary carries no secret', !JSON.stringify(summary).includes('secret-token-value'),
  JSON.stringify(summary));
check('an identity is set where the machine has none',
  fs.readFileSync(gitconfig, 'utf8').includes(DEFAULT_NAME), fs.readFileSync(gitconfig, 'utf8'));

// An identity a human chose must survive, or this would rewrite the author of
// every commit on a developer's laptop.
const keep = path.join(tmp, 'gitconfig-existing');
fs.writeFileSync(keep, '[user]\n\tname = A Human\n\temail = human@example.invalid\n');
ensureGitIdentity({ env: { ...process.env, GIT_CONFIG_GLOBAL: keep, STUDIO_GIT_TOKEN: '' }, file: credFile });
check('an identity the machine already had is left alone',
  fs.readFileSync(keep, 'utf8').includes('A Human'), fs.readFileSync(keep, 'utf8'));
check('and with no token, nothing is written at all',
  !fs.readFileSync(keep, 'utf8').includes('credential'));

console.log('\n branch names');
check('a task id becomes a branch', workBranch('TASK-01') === 'studio/task-01');
check('anything unusable is scrubbed rather than escaped',
  workBranch('TASK 01; rm -rf /') === 'studio/task-01-rm-rf', workBranch('TASK 01; rm -rf /'));
check('and a truncated name never ends in punctuation',
  !workBranch('x'.repeat(58) + ' y').endsWith('-'), workBranch('x'.repeat(58) + ' y'));
check('an empty id still produces a usable branch', workBranch('') === 'studio/work');

console.log('\n over HTTP');

const boot = [
  `import { Store } from ${JSON.stringify(studioUrl('core/store.mjs'))};`,
  `import { createHttpServer } from ${JSON.stringify(studioUrl('server/server.mjs'))};`,
  'const store = new Store();',
  'studioTestReady(store, createHttpServer(store, null));',
].join('\n');
const server = await startStudioServer({ boot, prefix: 'studio-clone-http-' });

const refuses = async (name, body, mentions) => {
  const before = (await server.get('/api/events?limit=1000')).events.length;
  const r = await server.post('/api/projects/clone', body);
  const after = (await server.get('/api/events?limit=1000')).events.length;
  const said = String(r.error || '');
  check(name, !r.ok && mentions.every((m) => said.includes(m)), said || JSON.stringify(r));
  check(`${name}, and nothing is recorded`, after === before, `${before} -> ${after}`);
};

// The CLI accepts a local path. The HTTP route must not, or the studio hands
// anyone who reaches it a way to read the rest of the disk into the workspace.
await refuses('a local path over HTTP is refused', { url: '/srv/private' }, ['only https://']);
await refuses('and file:// with it', { url: 'file:///etc/passwd' }, ['only https://']);
await refuses('an option is refused with the reason spelled out',
  { url: '--upload-pack=sh' }, ['cannot start with']);
await refuses('a destination that climbs out of the workspace is refused',
  { url: 'https://github.com/o/r', name: '../escape' }, ['cannot start with']);
await refuses('and one that contains a path at all',
  { url: 'https://github.com/o/r', name: 'sub/dir' }, ['path separator']);

await server.stop();

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover tmp */ }

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
