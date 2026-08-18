import fs from 'node:fs';
import path from 'node:path';

/**
 * Turning a command name into something Node can actually spawn.
 *
 * On Windows, an npm-installed CLI is not an executable. `npm i -g` writes three
 * shims — `foo`, `foo.cmd`, `foo.ps1` — and Node cannot start any of them
 * without a shell: the extensionless one is ENOENT, and `.cmd` is EINVAL,
 * because Node refuses to spawn batch files directly since the argument
 * injection fix in CVE-2024-27980.
 *
 * That is not a Gemini problem, it is every npm-installed CLI. Claude Code,
 * Codex and Grok happen to ship native installers on this machine, which is the
 * only reason the studio ever worked here. Install any of them from npm instead
 * and every turn would have died before the process started.
 *
 * The obvious fix — `shell: true` — is not available. With a shell, Node joins
 * the arguments and hands the string to cmd.exe unescaped, and one of those
 * arguments is the turn prompt: arbitrary text written by agents and by the
 * human, routinely containing `&`, `|`, `>` and quotes. That is a command
 * injection vector aimed directly at the machine the studio runs on.
 *
 * So the shim is read instead. npm's `.cmd` shim names the real entrypoint on
 * its last line, and that entrypoint is a plain `.js` file, so the studio can
 * spawn `node <entrypoint>` — no shell, nothing interpreted, arguments passed
 * as an array exactly as before.
 */

const isWindows = process.platform === 'win32';

/** Extensions Windows will execute, in the order it tries them. */
function pathExts() {
  return (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/** Every candidate file a bare command name could refer to. */
function* candidates(command) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const hasDir = command.includes('/') || command.includes('\\');
  const bases = hasDir ? [path.resolve(command)] : dirs.map((d) => path.join(d, command));
  for (const base of bases) {
    if (path.extname(base)) {
      yield base;
      continue;
    }
    // Extensions first, bare name last. npm installs three shims side by side —
    // `foo` (a sh script), `foo.cmd` and `foo.ps1` — and on Windows the
    // extensionless one is the only one that is not runnable at all. Yielding it
    // first found it first, and the resolver confidently returned a bash script
    // for Node to fail on.
    for (const ext of pathExts()) yield base + ext;
    yield base;
  }
}

function findOnPath(command) {
  for (const c of candidates(command)) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The JavaScript entrypoint an npm `.cmd` shim actually runs.
 *
 * The shim ends with a line naming it relative to the shim's own directory:
 *
 *   "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*
 *
 * Returns null rather than guessing if the file does not look like that, so an
 * unrecognised shim produces a clear refusal instead of a wrong command.
 */
export function entrypointOfShim(shimPath) {
  let text;
  try {
    text = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/%dp0%\\?([^"%]+\.(?:js|mjs|cjs))/i);
  if (!m) return null;
  // The shim is a Windows file, so it always separates with backslashes — but
  // this parser is pure and the suite exercises it everywhere. On POSIX,
  // path.join does not treat `\` as a separator, so joining the captured
  // `node_modules\pkg\bin\cli.js` produced one long filename that never
  // existed and the function returned null. Split on either separator and let
  // path.join put the platform's own back.
  const parts = m[1].split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  const abs = path.join(path.dirname(shimPath), ...parts);
  return fs.existsSync(abs) ? abs : null;
}

/**
 * How to spawn `command`.
 *
 * Returns `{ command, prefixArgs }` to place in front of the adapter's own
 * arguments, or `{ error }` when there is nothing runnable. Never returns
 * something that needs a shell.
 */
export function resolveLaunch(command) {
  if (!isWindows) return { command, prefixArgs: [] };

  const found = findOnPath(command);
  if (!found) {
    // Let spawn produce its own ENOENT: the command may be resolvable in a way
    // this function does not model, and inventing a failure here would be worse
    // than letting the real one happen.
    return { command, prefixArgs: [] };
  }

  const ext = path.extname(found).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { command: found, prefixArgs: [] };

  const entry = entrypointOfShim(found);
  if (entry) return { command: process.execPath, prefixArgs: [entry], via: found };

  return {
    error: `"${command}" resolves to ${found}, which Node cannot start directly, and its `
      + 'entrypoint could not be read from the shim. Install the tool with a native '
      + 'installer, or set an explicit `command` for this agent in the config.',
  };
}
