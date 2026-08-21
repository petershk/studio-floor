import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getSecret } from './secrets.mjs';

/**
 * Git credentials and a git identity, for a machine that has neither.
 *
 * On a laptop this is all already true and none of it runs. On a fresh cloud
 * box it is all false in ways that surface as nonsense: a private clone fails
 * with "could not read Username" and no terminal to answer on, and the first
 * `git commit` an agent tries dies with "Please tell me who you are" — an agent
 * that then reports the task as blocked for reasons nobody can act on.
 *
 * Two rules keep this from being intrusive on a machine that already works:
 *
 *   - The token is opt-in by existing. Nothing is written unless one of the
 *     token variables is set, so a developer's own git is never touched.
 *   - The identity is only set when git does not already have one. A laptop
 *     has one; a container does not.
 *
 * The token is stored via git's own `store` helper, in its own file rather than
 * the conventional `~/.git-credentials`, so an existing one is never
 * overwritten. It is deliberately NOT embedded in any remote URL: a URL with a
 * token in it ends up in `.git/config`, in `git remote -v`, and in the first
 * error message an agent copies into the channel.
 */

/** Where the token variable might be, in the order worth preferring. */
const TOKEN_VARS = ['STUDIO_GIT_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

export const CREDENTIALS_FILE = process.env.STUDIO_GIT_CREDENTIALS
  ? path.resolve(process.env.STUDIO_GIT_CREDENTIALS)
  : path.join(os.homedir(), '.studio-git-credentials');

/** The identity commits are made under when the machine has none of its own. */
export const DEFAULT_NAME = 'Studio Floor';
export const DEFAULT_EMAIL = 'studio-floor@localhost';

/** Where a token entered through the panel is filed. */
export const GIT_SECRET = 'git:token';

/**
 * The token, from the environment or from this studio's own store.
 *
 * The environment still wins, because that is how a deployment injects one and
 * an operator's value must not be overridden by something typed into a browser
 * months earlier. The store exists for the case the environment cannot serve:
 * somebody using a studio they did not deploy, who has no shell to export a
 * variable in and would otherwise have no way to let their team push at all.
 */
export function gitToken(env = process.env) {
  for (const name of TOKEN_VARS) {
    const v = env[name];
    if (typeof v === 'string' && v.trim()) return { token: v.trim(), from: name };
  }
  const stored = getSecret(GIT_SECRET, { env });
  if (stored) return { token: stored, from: 'this studio' };
  return { token: null, from: null };
}

/**
 * One line of git's credential store format.
 *
 * Pure, because it is the only place a secret and a string template meet, and
 * because the encoding matters: a token containing `@` or `/` — fine-grained
 * GitHub tokens contain neither today, and that is not a guarantee — would
 * otherwise silently produce a line for a different host.
 */
export function credentialLine(host, token, user = 'x-access-token') {
  return `https://${encodeURIComponent(user)}:${encodeURIComponent(token)}@${host}`;
}

/** Hosts the token should be offered to. */
export function credentialHosts(env = process.env) {
  const extra = String(env.STUDIO_GIT_HOSTS || '')
    .split(',').map((h) => h.trim()).filter(Boolean);
  return [...new Set(['github.com', ...extra])];
}

const git = (args, env = process.env) => spawnSync('git', args, { encoding: 'utf8', env });

/** What git already knows, so nothing is overwritten that a human set. */
export function currentIdentity(env = process.env) {
  const read = (key) => {
    const r = git(['config', '--global', '--get', key], env);
    return r.status === 0 ? String(r.stdout || '').trim() : '';
  };
  return { name: read('user.name'), email: read('user.email') };
}

/**
 * Make this machine able to clone privately and commit.
 *
 * Returns what it did, with no secret in it — the return value ends up in CLI
 * output and in an HTTP response, and a token that leaks does so exactly once.
 */
export function ensureGitIdentity({ env = process.env, file = CREDENTIALS_FILE } = {}) {
  const summary = {
    token: false, tokenFrom: null, wroteCredentials: false, setName: false, setEmail: false, problems: [],
  };

  const probe = git(['--version'], env);
  if (probe.status !== 0) {
    summary.problems.push('git is not installed on this machine');
    return summary;
  }

  const { token, from } = gitToken(env);
  if (token) {
    summary.token = true;
    summary.tokenFrom = from;
    try {
      const lines = credentialHosts(env).map((h) => credentialLine(h, token));
      // 0600 before the write, not after: a world-readable moment is still a
      // moment, and on a shared box that is the whole vulnerability.
      fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      const helper = `store --file=${file}`;
      const existing = git(['config', '--global', '--get-all', 'credential.helper'], env);
      if (!String(existing.stdout || '').includes(file)) {
        git(['config', '--global', '--add', 'credential.helper', helper], env);
      }
      summary.wroteCredentials = true;
    } catch (e) {
      summary.problems.push(`could not write the credential file — ${e.message}`);
    }
  }

  const identity = currentIdentity(env);
  if (!identity.name) {
    git(['config', '--global', 'user.name', env.STUDIO_GIT_NAME || DEFAULT_NAME], env);
    summary.setName = true;
  }
  if (!identity.email) {
    git(['config', '--global', 'user.email', env.STUDIO_GIT_EMAIL || DEFAULT_EMAIL], env);
    summary.setEmail = true;
  }

  return summary;
}

/**
 * The branch an agent works on.
 *
 * Never the default branch, and never a name that has to be escaped. Agents
 * write these from task ids, so the shape is fixed here rather than left to
 * eight different agents' taste.
 */
export function workBranch(taskId, { prefix = 'studio' } = {}) {
  const slug = String(taskId || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    // Collapse the runs the line above creates: "TASK 01; rm -rf" would
    // otherwise become "task-01-rm--rf", which is a valid branch name and an
    // ugly one, and ugly names get retyped by hand and mistyped.
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/[-.]+$/, '');
  return `${prefix}/${slug || 'work'}`;
}
