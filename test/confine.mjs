#!/usr/bin/env node
/**
 * The work directory as a wall, not a request.
 *
 * A prompt that says "stay in your directory" is worth something between
 * colleagues and nothing against a shell command. The studio therefore runs
 * agent turns as their own unprivileged user, owns the work directory to that
 * user, and takes every other-user permission off its own state. What stops an
 * agent reading the event log is then a permission it lacks.
 *
 * Confinement needs root and a POSIX host, which a test runner is not. So this
 * asserts the decision and the plan — when confinement is demanded, when a
 * studio is allowed to run without it, and exactly which paths change — and
 * applies a plan against a fake filesystem to prove the order and the modes.
 * The real chown is exercised by running the container, not here.
 *
 *   node test/confine.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  confinement, confinementPlan, applyConfinement, isShared, lookupUser,
} = await import('../src/core/confine.mjs');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\nconfine — agents run as their own user, or say why not\n');

// ------------------------------------------------------ what "shared" means

check('a loopback studio with no token is private', isShared({ host: '127.0.0.1', token: null }) === false);
check('a token means somebody else can reach it', isShared({ host: '127.0.0.1', token: 'abc' }) === true);
check('binding off loopback means the same', isShared({ host: '0.0.0.0', token: null }) === true);

// --------------------------------------------------------------- the verdict

const asRoot = () => 0;
const asUser = () => 1000;
const found = (name) => ({ name, uid: 4242, gid: 4242, home: `/home/${name}` });
const noUser = () => null;

const confined = confinement({
  mode: 'auto', userName: 'studio-agent', workDir: '/workspace/game', shared: true,
  platform: 'linux', getuid: asRoot, lookup: found,
});
check('root on linux with the user present confines', confined.confined && confined.ready);
check('and names the user it drops to', /studio-agent/.test(confined.why) && confined.user.uid === 4242, confined.why);

const windows = confinement({
  mode: 'auto', shared: false, platform: 'win32', getuid: asRoot, lookup: found,
});
check('windows cannot confine', windows.confined === false);
check('but a private studio still runs there', windows.ready === true);
check('and says plainly that the boundary is not enforced', /cannot be confined on Windows/.test(windows.why), windows.why);

const sharedWindows = confinement({
  mode: 'auto', shared: true, platform: 'win32', getuid: asRoot, lookup: found,
});
check('a shared studio that cannot confine holds its agents', sharedWindows.ready === false);
check('and the reason says how to fix it',
  /container|confineAgents/.test(sharedWindows.held), sharedWindows.held);

const notRoot = confinement({
  mode: 'auto', shared: true, platform: 'linux', getuid: asUser, lookup: found,
});
check('without root it cannot confine', notRoot.confined === false && notRoot.ready === false);
check('and says why', /root/.test(notRoot.why), notRoot.why);

const missing = confinement({
  mode: 'require', userName: 'nobody-here', shared: false, platform: 'linux', getuid: asRoot, lookup: noUser,
});
check('require holds even a private studio when the user is missing', missing.ready === false);
check('and names the account it looked for', /nobody-here/.test(missing.why), missing.why);

const rootUser = confinement({
  mode: 'require', shared: true, platform: 'linux', getuid: asRoot, lookup: () => ({ name: 'root', uid: 0, gid: 0, home: '/root' }),
});
check('dropping to root would confine nothing, and is refused', rootUser.ready === false);

const off = confinement({ mode: 'off', shared: true, platform: 'linux', getuid: asRoot, lookup: found });
check('off is an operator decision, and is honoured', off.ready === true && off.confined === false);
check('but it is stated rather than implied', /switched off/.test(off.why), off.why);

const nonsense = confinement({ mode: 'sideways', shared: false, platform: 'linux', getuid: asUser, lookup: found });
check('an unknown mode falls back to auto', nonsense.mode === 'auto');

// ------------------------------------------------------------------ the plan

const plan = confinementPlan({
  user: found('studio-agent'),
  workDir: '/workspace/game',
  stateDir: '/workspace/game/studio_floor/state',
  configFile: '/workspace/game/studio_floor/config.json',
  homeDir: '/workspace/game/studio_floor',
});
const step = (action, target) => plan.find((s) => s.action === action && s.target === target);

check('the work directory is handed to the agent user',
  step('own', '/workspace/game')?.uid === 4242, JSON.stringify(plan[0]));
check('the event log is sealed to the studio',
  step('seal', '/workspace/game/studio_floor/state')?.mode === 0o700);
check('so is the config that decides what agents may do',
  step('seal', '/workspace/game/studio_floor/config.json')?.mode === 0o600);
check('the path down to the work directory stays enterable but not listable',
  plan.filter((s) => s.action === 'traverse').every((s) => s.mode === 0o711)
  && plan.some((s) => s.action === 'traverse'), JSON.stringify(plan.filter((s) => s.action === 'traverse')));
check("the studio's own folder is sealed whole, not just its contents",
  step('seal', '/workspace/game/studio_floor')?.mode === 0o700);
check('every step says why it is there', plan.every((s) => Boolean(s.why)));

// The case that matters in practice. `workDir: "."` puts studio_floor/ *inside*
// the directory being handed to the agent, so the ownership walk has to step
// around it. It did not, and a real run of confine-root.mjs found it: the agent
// owned the event log, and a file you own you can unseal.
const own = plan.find((s) => s.action === 'own');
check("the ownership walk is told to skip the studio's own paths",
  (own.exclude || []).some((p) => p.endsWith(`${path.sep}studio_floor`)), JSON.stringify(own.exclude));
check('including the event log and the config',
  (own.exclude || []).length >= 3, JSON.stringify(own.exclude));

// ----------------------------------------------------------------- applying

const calls = [];
const fake = {
  existsSync: () => true,
  chmodSync: (t, m) => calls.push(['chmod', t, m]),
  chownSync: (t, u) => calls.push(['chown', t, u]),
  lchownSync: () => {},
  readdirSync: () => [],
};
const okRun = applyConfinement(plan, { fsImpl: fake });
check('applying a plan touches every step', okRun.ok && okRun.applied.length === plan.length,
  `${okRun.applied.length} of ${plan.length}`);
check("a sealed path is taken back into the studio's ownership as well as its mode",
  calls.some(([what, target, arg]) => what === 'chown' && target === '/workspace/game/studio_floor' && arg === 0),
  JSON.stringify(calls));

// The walk, against a tree that contains the studio's own folder.
const walked = [];
const tree = {
  existsSync: () => true,
  chmodSync: () => {},
  chownSync: (t) => walked.push(t),
  lchownSync: () => {},
  readdirSync: (dir) => (dir === '/workspace/game'
    ? [
      { name: 'main.js', isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'studio_floor', isDirectory: () => true, isSymbolicLink: () => false },
    ]
    : []),
};
applyConfinement([plan.find((s) => s.action === 'own')], { fsImpl: tree });
check('the agent is given the work directory', walked.includes('/workspace/game'));
check('and the file in it', walked.some((t) => t.endsWith('main.js')));
check("but never the studio's own folder",
  !walked.some((t) => t.includes('studio_floor')), walked.join(', '));

const boom = {
  ...fake,
  chmodSync: (t) => { throw new Error(`read-only file system: ${t}`); },
};
const failed = applyConfinement(plan, { fsImpl: boom });
check('a failure stops rather than half-applying', failed.ok === false);
check('and names the step that failed', /read-only file system/.test(failed.error), failed.error);
check('a half-applied plan is never reported as confined', failed.applied.length < plan.length);

// A missing target is skipped, not fatal: a studio whose work directory has no
// studio_floor yet is a first run, not a failure.
const gone = { ...fake, existsSync: () => false };
check('absent paths are skipped', applyConfinement(plan, { fsImpl: gone }).ok === true);

// --------------------------------------------------------- the real lookup

// Not a root test: it only proves we ask the system rather than guess, and that
// an account that does not exist comes back as absent instead of as uid 0.
check('an account that does not exist resolves to nothing',
  lookupUser('definitely-not-a-user-9fj3') === null);
if (process.platform !== 'win32') {
  const me = lookupUser(os.userInfo().username);
  check('an account that does exist resolves to its uid',
    me === null || me.uid === os.userInfo().uid, JSON.stringify(me));
}

// A sanity check that the module's own paths exist as written.
check('the module is where the runner expects it',
  fs.existsSync(path.join(process.cwd(), 'src', 'core', 'confine.mjs')));

console.log(failures ? `\n${failures} confine check(s) failed\n` : '\nall confine checks passed\n');
process.exitCode = failures ? 1 : 0;
