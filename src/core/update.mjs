import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from './paths.mjs';

/**
 * Updating the studio from inside the studio.
 *
 * This runs git against the installation itself, so it is deliberately narrow:
 * fetch, inspect, and fast-forward. It will not merge, will not rebase, will not
 * touch a remote other than the configured upstream, and will not proceed over
 * local work. Anything it refuses is something a human should look at in a
 * terminal, where they can see what is going on.
 *
 * The restart afterwards is the supervisor's, unchanged from a project switch —
 * a running studio cannot swap its own code any more than it can swap its own
 * project root.
 */

const GIT_TIMEOUT = 60_000;

function git(args, { timeout = GIT_TIMEOUT } = {}) {
  const r = spawnSync('git', args, {
    cwd: PACKAGE_ROOT, encoding: 'utf8', timeout, windowsHide: true,
  });
  return {
    ok: r.status === 0,
    code: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
  };
}

/**
 * Is the working tree carrying real local work?
 *
 * `git status --porcelain` is the obvious check and it is wrong here. With
 * core.autocrlf on Windows a checked-out file can report as modified while its
 * content is byte-identical to HEAD once line endings are normalised — this
 * repository does exactly that, and an update that refused on it would refuse
 * on a clean machine for no reason. `git diff --quiet` applies the same
 * normalisation git itself would, so it sees through the flapping.
 */
function hasLocalWork() {
  const unstaged = git(['diff', '--quiet']);
  const staged = git(['diff', '--cached', '--quiet']);
  return { dirty: !unstaged.ok || !staged.ok };
}

/** Where the studio is installed from, and whether it can be updated at all. */
export function updateStatus({ fetch = false } = {}) {
  const root = PACKAGE_ROOT;
  const base = { root, isGitRepo: false, canUpdate: false, reasons: [] };

  if (!fs.existsSync(path.join(root, '.git'))) {
    return { ...base, reasons: ['the studio was not installed from a git clone'] };
  }
  const version = git(['--version']);
  if (!version.ok) return { ...base, isGitRepo: true, reasons: ['git is not available on PATH'] };

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const head = git(['rev-parse', '--short', 'HEAD']).out;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const remoteUrl = git(['remote', 'get-url', 'origin']).out;

  const info = {
    ...base,
    isGitRepo: true,
    branch,
    head,
    remote: remoteUrl,
    upstream: upstream.ok ? upstream.out : null,
    behind: 0,
    ahead: 0,
    fetched: false,
    commits: [],
  };

  const reasons = [];
  if (branch === 'HEAD') reasons.push('the clone is in detached HEAD, not on a branch');
  if (!upstream.ok) reasons.push('this branch is not tracking a remote');

  const { dirty } = hasLocalWork();
  info.dirty = dirty;
  if (dirty) reasons.push('the clone has uncommitted changes');

  // Only touch the network when asked. A settings page that silently phoned home
  // on every render would be both slow and rude.
  if (fetch && upstream.ok) {
    const f = git(['fetch', '--quiet', 'origin']);
    info.fetched = f.ok;
    if (!f.ok) reasons.push(`could not reach the remote: ${firstLine(f.err) || 'fetch failed'}`);
  }

  if (upstream.ok) {
    const counts = git(['rev-list', '--left-right', '--count', `HEAD...${info.upstream}`]);
    if (counts.ok) {
      const [ahead, behind] = counts.out.split(/\s+/).map(Number);
      info.ahead = ahead || 0;
      info.behind = behind || 0;
    }
    if (info.ahead > 0) reasons.push(`the clone has ${info.ahead} local commit(s) not on the remote`);
    if (info.behind > 0) {
      const log = git(['log', '--oneline', '--no-decorate', `HEAD..${info.upstream}`, '-20']);
      if (log.ok && log.out) info.commits = log.out.split('\n');
    }
  }

  info.reasons = reasons;
  info.canUpdate = reasons.length === 0 && info.behind > 0;
  info.upToDate = reasons.length === 0 && info.behind === 0;
  return info;
}

/**
 * Fast-forward the installation.
 *
 * `--ff-only` is the whole safety model: if the update would need a merge, git
 * refuses and nothing has changed. The caller restarts only when this reports a
 * move.
 */
export function pullUpdate() {
  const before = updateStatus({ fetch: true });
  if (before.reasons.length) return { ok: false, errors: before.reasons, status: before };
  if (before.behind === 0) return { ok: true, changed: false, status: before };

  const pull = git(['merge', '--ff-only', before.upstream], { timeout: 120_000 });
  if (!pull.ok) {
    return {
      ok: false,
      errors: [`git could not fast-forward: ${firstLine(pull.err) || firstLine(pull.out) || 'unknown error'}`],
      status: before,
    };
  }

  const after = updateStatus();
  return {
    ok: true,
    changed: after.head !== before.head,
    from: before.head,
    to: after.head,
    commits: before.commits,
    status: after,
  };
}

function firstLine(s) {
  return String(s || '').split('\n').find((l) => l.trim()) || '';
}
