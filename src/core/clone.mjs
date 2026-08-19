import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { USER_DIR } from './paths.mjs';

/**
 * Getting a repository onto the machine the studio runs on.
 *
 * The studio already works on any directory and can be pointed at another one
 * without stopping. What it could not do was acquire one, which on a cloud box
 * meant an ssh session and a `git clone` every time you wanted to try the team
 * on something new. This closes that: a URL goes in, a project comes out, and
 * the existing switch takes it from there.
 *
 * The whole of the care here is in what is allowed to reach `git`.
 *
 * `git clone` takes its options as positional arguments, and several of them
 * name a program to run: `--upload-pack`, `--config core.sshCommand=…`,
 * `--exec`. A URL that arrives over HTTP and is passed to git unchecked is
 * therefore remote code execution wearing a URL's clothes, and "it starts with
 * https://" is not a check — `--upload-pack=x https://…` starts with neither.
 * So the remote is parsed and rebuilt rather than inspected, nothing is ever
 * handed to a shell, and `--` separates options from operands regardless.
 */

/**
 * Where repositories are kept. One directory holding many projects.
 *
 * The default was the project's parent, which is defensible for `/workspace/repo`
 * and catastrophic for `C:\studio-floor`: the parent is the root of the C
 * drive, so the panel offered Windows, Program Files and $Recycle.Bin as
 * projects to work in. A default that is sometimes the right directory and
 * sometimes the whole machine is not a default.
 *
 * So it is a directory of the studio's own unless the operator names one.
 * Containers name one; a laptop gets somewhere predictable that is never the
 * root of anything.
 */
export const WORKSPACE_DIR = process.env.STUDIO_WORKSPACE
  ? path.resolve(process.env.STUDIO_WORKSPACE)
  : path.join(USER_DIR, 'workspace');

const HTTPS = /^https:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?\/([\w.~-]+(?:\/[\w.~-]+)+?)(?:\.git)?\/?$/i;
const SSH = /^(?:ssh:\/\/)?git@([a-z0-9.-]+\.[a-z]{2,}):([\w.~-]+(?:\/[\w.~-]+)+?)(?:\.git)?\/?$/i;

/**
 * Understand a remote, or refuse it.
 *
 * Returns `{ ok, url, host, repo, name }` with `url` rebuilt from the parts
 * that matched — so whatever reaches git is something this file constructed,
 * not something a caller supplied.
 *
 * `allowLocal` is for a human at a shell, who can already clone anything they
 * like without asking the studio. It is never set by the HTTP route.
 */
export function parseRemote(input, { allowLocal = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'no repository given' };
  if (raw.length > 512) return { ok: false, error: 'that does not look like a repository URL' };

  // Before anything else. A leading dash is git asking to be told what to run.
  if (raw.startsWith('-')) {
    return { ok: false, error: 'a repository URL cannot start with "-" — that is a git option, not a remote' };
  }
  if (/\s/.test(raw)) return { ok: false, error: 'a repository URL cannot contain spaces' };

  const https = raw.match(HTTPS);
  if (https) {
    const repo = https[2].replace(/\.git$/i, '');
    return {
      ok: true, kind: 'https', host: https[1], repo, url: `https://${https[1]}/${repo}.git`, name: leaf(repo),
    };
  }

  const ssh = raw.match(SSH);
  if (ssh) {
    const repo = ssh[2].replace(/\.git$/i, '');
    return {
      ok: true, kind: 'ssh', host: ssh[1], repo, url: `git@${ssh[1]}:${repo}.git`, name: leaf(repo),
    };
  }

  if (allowLocal && (raw.startsWith('file://') || path.isAbsolute(raw) || raw.startsWith('.'))) {
    const local = raw.startsWith('file://') ? fileUrlToPath(raw) : path.resolve(raw);
    return { ok: true, kind: 'local', host: null, repo: local, url: local, name: leaf(local) };
  }

  return {
    ok: false,
    error: 'only https:// and git@host:owner/repo remotes are accepted'
      + `${allowLocal ? ', or a path to a local repository' : ''}`,
  };
}

const leaf = (p) => path.basename(String(p).replace(/[\\/]+$/, '')).replace(/\.git$/i, '') || 'repo';

function fileUrlToPath(u) {
  const rest = u.slice('file://'.length).replace(/^localhost/, '');
  const decoded = decodeURIComponent(rest);
  // file:///C:/x on Windows, file:///home/x elsewhere.
  return path.resolve(/^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded);
}

/**
 * A directory name that is a name and not an instruction.
 *
 * The clone's destination is also a positional argument to git, and it becomes
 * a path the studio later switches to, so it may not climb out of the
 * workspace, hide itself, or be a dash.
 */
export function checkName(name) {
  const n = String(name ?? '').trim();
  if (!n) return 'a directory name is required';
  if (n.startsWith('-')) return 'a directory name cannot start with "-"';
  if (n.startsWith('.')) return 'a directory name cannot start with "."';
  if (/[\\/]/.test(n)) return 'a directory name cannot contain a path separator';
  if (n === '..' || n.includes('\0')) return 'that is not a usable directory name';
  if (n.length > 100) return 'that directory name is too long';
  return null;
}

/**
 * Clone `url` into `into/name`.
 *
 * Arguments are an array and there is no shell, so nothing in a URL is ever
 * interpreted. `--` ends the options, which makes the remote a remote even if
 * one of the checks above is ever loosened by mistake.
 */
export function cloneRepo({
  url, into = WORKSPACE_DIR, name, depth = 0, timeoutMs = 300_000, env = process.env,
}) {
  const dest = path.join(into, name);
  const args = ['clone'];
  if (depth > 0) args.push('--depth', String(depth));
  args.push('--', url, dest);

  return new Promise((resolve) => {
    fs.mkdirSync(into, { recursive: true });
    const child = spawn('git', args, {
      cwd: into,
      // Never a shell, and never an interactive prompt: a clone that stops to
      // ask for a password on a headless box hangs until the timeout with no
      // way to answer it, which reads as "the studio froze".
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, path: dest, error: `the clone took longer than ${Math.round(timeoutMs / 1000)}s and was stopped` });
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, path: dest, error: `git could not be started — ${e.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true, path: dest, output: `${out}${err}`.trim() });
      return resolve({ ok: false, path: dest, code, error: gitProblem(err), output: `${out}${err}`.trim() });
    });
  });
}

/**
 * Git's failures, said the way the person who typed the URL needs to hear them.
 *
 * The raw text is kept alongside this, but "Authentication failed" on its own
 * does not tell a human on a headless box that the fix is a token in the
 * environment rather than a password they cannot be asked for.
 */
function gitProblem(stderr) {
  const s = String(stderr || '');
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(s)) {
    return 'the repository needs credentials — set STUDIO_GIT_TOKEN for a private repo, '
      + 'or check the URL if it should be public';
  }
  if (/Repository not found|not found|does not exist/i.test(s)) {
    return 'no repository at that URL — check it, and check the token can see it if it is private';
  }
  if (/already exists and is not an empty directory/i.test(s)) {
    return 'there is already a directory of that name in the workspace';
  }
  if (/Permission denied \(publickey\)/i.test(s)) {
    return 'the host refused the SSH key — this box has no key it accepts, so use an https:// URL and a token';
  }
  if (/Could not resolve host/i.test(s)) return 'that host could not be resolved from this machine';
  const line = s.trim().split('\n').filter(Boolean).pop();
  return line ? line.replace(/^fatal:\s*/i, '') : 'the clone failed';
}
