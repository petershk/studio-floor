import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT, STATE_DIR, CONFIG_FILE, PACKAGE_ROOT } from './paths.mjs';

/**
 * Making "agents work only in their directory" true rather than instructed.
 *
 * Until here the boundary was three soft things: the process starts in the work
 * directory, the prompt says not to leave it, and each vendor CLI sandboxes its
 * own file tools. None of them stop `cat ../../studio_floor/state/events.jsonl`
 * from a shell, because the agent runs as the same operating-system user as the
 * studio and that user owns everything.
 *
 * So the operating system enforces it instead. Agent turns run as their own
 * unprivileged user. The work directory belongs to that user; the event log,
 * the config, the stored keys and every other project do not, and are not
 * readable by it. What stops an agent reading the studio's own memory is then a
 * permission it does not have, rather than an instruction it was given.
 *
 * Two deliberate limits:
 *
 * - **This is POSIX only.** Windows has no equivalent of spawning as another
 *   uid from Node, so a studio there cannot confine and says so.
 * - **It needs root**, because only root may become another user. In the
 *   container that is normal; on a laptop it is not, which is why an
 *   unconfined studio is allowed when nobody but you can reach it.
 */

/** What a studio does when it cannot confine its agents. */
export const CONFINE_MODES = ['auto', 'require', 'off'];

const isPosix = (platform = process.platform) => platform !== 'win32';

/**
 * Is this studio shared?
 *
 * A token or a non-loopback bind address both mean somebody other than the
 * person at this keyboard can reach it — a team studio, which is exactly where
 * an unenforced boundary stops being a private risk and starts being a promise
 * to other people. A loopback studio with no token is one person on one laptop.
 */
export function isShared({ host, token } = {}) {
  const bound = host || '127.0.0.1';
  const loopback = bound === '127.0.0.1' || bound === 'localhost' || bound === '::1';
  return Boolean(token) || !loopback;
}

/**
 * Look up the unprivileged user agents run as.
 *
 * By name, through the system's own resolver rather than by parsing
 * /etc/passwd: a container may use another name service, and a wrong uid here
 * would be a studio that either fails to launch anything or confines to the
 * wrong account.
 */
export function lookupUser(name, { run = spawnSync } = {}) {
  if (!name) return null;
  const ask = (flag) => {
    const r = run('id', [flag, name], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return null;
    const v = Number.parseInt((r.stdout || '').trim(), 10);
    return Number.isInteger(v) ? v : null;
  };
  const uid = ask('-u');
  if (uid === null) return null;
  const gid = ask('-g');
  if (gid === null) return null;
  const home = path.join('/home', name);
  return { name, uid, gid, home: fs.existsSync(home) ? home : os.tmpdir() };
}

/**
 * Can this studio confine its agents, and must it?
 *
 * Returns the whole verdict rather than a boolean, because every caller needs a
 * different part of it: the runner needs `ready`, the banner and the panel need
 * `held` and `why`, and doctor needs to explain how to fix it.
 */
export function confinement({
  mode = 'auto',
  userName = 'studio-agent',
  workDir = PROJECT_ROOT,
  stateDir = STATE_DIR,
  shared = false,
  platform = process.platform,
  getuid = process.getuid,
  lookup = lookupUser,
} = {}) {
  const wanted = CONFINE_MODES.includes(mode) ? mode : 'auto';
  const required = wanted === 'require' || (wanted === 'auto' && shared);

  const verdict = (extra) => ({
    mode: wanted, required, userName, workDir, stateDir, ...extra,
  });

  if (wanted === 'off') {
    return verdict({
      possible: false,
      confined: false,
      ready: true,
      user: null,
      why: 'confinement is switched off in the config — agents run as the studio does, '
        + 'and can read anything it can',
      held: '',
    });
  }

  const unavailable = (why) => verdict({
    possible: false,
    confined: false,
    user: null,
    why,
    // A studio nobody else can reach may run unconfined; one that is shared,
    // or that asked for confinement outright, does not get to skip it quietly.
    ready: !required,
    held: required
      ? `${why}. This studio is reachable by other people, so agents will not start until it can `
        + 'confine them. Run it in the container, or set security.confineAgents to "off" to accept the risk'
      : '',
  });

  if (!isPosix(platform)) {
    return unavailable('agents cannot be confined on Windows — there is no way to run them as another user');
  }
  if (typeof getuid !== 'function' || getuid() !== 0) {
    return unavailable('agents cannot be confined unless the studio runs as root — only root may become another user');
  }
  const user = lookup(userName);
  if (!user) {
    return unavailable(`agents cannot be confined: there is no user "${userName}" on this machine`);
  }
  if (user.uid === 0) {
    return unavailable(`"${userName}" is root, which confines nothing`);
  }

  return verdict({
    possible: true,
    confined: true,
    ready: true,
    user,
    why: `agent turns run as ${user.name} (uid ${user.uid}), which owns the work directory and nothing else`,
    held: '',
  });
}

/**
 * The permissions that make the verdict true.
 *
 * Returned as a plan rather than applied on sight so that doctor and the panel
 * can say what would change, and so the test can assert the intent without
 * needing a root to run as.
 *
 * `own` hands the work directory to the agent user — it has to write there.
 * `seal` takes every other-user permission off the studio's own state: the
 * event log, the transcripts, the config and the stored keys. `traverse` lets
 * the agent reach its own directory through a workspace it cannot list, so
 * sibling repositories stay invisible.
 */
export function confinementPlan({ user, workDir, stateDir = STATE_DIR, configFile = CONFIG_FILE } = {}) {
  if (!user) return [];
  const plan = [
    { action: 'own', target: workDir, uid: user.uid, gid: user.gid, why: 'the agents write here' },
    { action: 'seal', target: stateDir, mode: 0o700, why: 'the event log is the studio\'s memory, not an agent\'s file' },
    { action: 'seal', target: configFile, mode: 0o600, why: 'the config decides what agents may do' },
    { action: 'seal', target: PACKAGE_ROOT, mode: 0o755, why: 'the studio\'s own code stays readable but not writable' },
  ];
  // The work directory is usually inside the project; the path down to it must
  // be enterable without being listable.
  let dir = path.dirname(path.resolve(workDir));
  const stop = path.parse(dir).root;
  const seen = new Set();
  while (dir && dir !== stop && !seen.has(dir) && dir.startsWith(stop)) {
    seen.add(dir);
    plan.push({ action: 'traverse', target: dir, mode: 0o711, why: 'reachable, but its neighbours are not listable' });
    if (dir === path.resolve(PROJECT_ROOT)) break;
    dir = path.dirname(dir);
  }
  return plan;
}

/**
 * Apply the plan, or say which step failed and stop.
 *
 * Stops at the first failure on purpose: a half-applied plan is a studio that
 * believes it is confined and is not, which is worse than one that refuses to
 * start.
 */
export function applyConfinement(plan = [], { fsImpl = fs } = {}) {
  const applied = [];
  for (const step of plan) {
    try {
      if (!fsImpl.existsSync(step.target)) continue;
      if (step.action === 'own') chownTree(step.target, step.uid, step.gid, fsImpl);
      else fsImpl.chmodSync(step.target, step.mode);
      applied.push(step);
    } catch (err) {
      return { ok: false, applied, failed: step, error: `${step.action} ${step.target}: ${err.message}` };
    }
  }
  return { ok: true, applied, failed: null, error: '' };
}

function chownTree(target, uid, gid, fsImpl, depth = 0) {
  // Deep enough for any repository, shallow enough that a symlink loop or a
  // pathological tree cannot hang the studio's startup.
  if (depth > 40) return;
  fsImpl.chownSync(target, uid, gid);
  let entries = [];
  try {
    entries = fsImpl.readdirSync(target, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      try { fsImpl.lchownSync(child, uid, gid); } catch { /* a dangling link is not a failure */ }
      continue;
    }
    if (entry.isDirectory()) chownTree(child, uid, gid, fsImpl, depth + 1);
    else {
      try { fsImpl.chownSync(child, uid, gid); } catch { /* a file we cannot own is reported by the walk above */ }
    }
  }
}
