import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECTS_FILE, SWITCH_FILE, USER_DIR, HOME_DIR_NAME, DEFAULT_BRIEF, PROJECT_ROOT, ensureUserDir,
} from './paths.mjs';

/**
 * Projects the studio has been pointed at.
 *
 * The only state that does not belong to a project. It lives under the user's
 * home rather than inside any one repository, because "which project was I
 * working on" is a fact about the person, not about the code.
 *
 * Resume needs no machinery: a project's event log lives inside the project, so
 * pointing the studio back at a directory it has seen before finds the whole
 * history sitting where it was left. Reset is the deliberate act of deleting it.
 */

/**
 * Distinctive sentences from the `studio init` scaffold. All three together
 * are the unfilled template; a written brief will not keep them.
 */
const TEMPLATE_MARKERS = [
  'Describe what you want built, and why.',
  'A concrete, checkable outcome.',
  'Things that are settled. The team should not reopen these without new information.',
];

/** True when the file is still the scaffold `studio init` writes. */
export function isUntouchedBrief(text) {
  const t = String(text ?? '');
  return TEMPLATE_MARKERS.every((m) => t.includes(m));
}

/**
 * Markers an agent is told to leave when it drafts a brief. Any one of them
 * means the file is a proposal, not a human spec. The template is not inferred:
 * it is unwritten.
 *
 * These have to be phrases a competent human would not write about their own
 * work. `STATUS: DRAFT` and `not by the human` failed that test — they are
 * ordinary spec language, and matching them is the same class of bug as
 * treating any written file as a human spec.
 */
const INFERRED_MARKERS = [
  '[inferred]',
  'agent-inferred',
];

/** True when the brief marks itself as an agent draft rather than a human spec. */
export function isInferredBrief(text) {
  if (isUntouchedBrief(text)) return false;
  const t = String(text ?? '');
  return INFERRED_MARKERS.some((m) => t.toLowerCase().includes(m.toLowerCase()));
}

/** What a directory looks like from the outside, before we commit to it. */
export function inspect(dir) {
  const root = path.resolve(dir);
  const out = {
    path: root,
    name: path.basename(root),
    exists: false,
    isDirectory: false,
    readable: false,
    writable: false,
    hasBrief: false,
    briefUntouched: false,
    briefInferred: false,
    hasConfig: false,
    hasState: false,
    isGitRepo: false,
    legacyLayout: false,
    entries: 0,
    events: 0,
  };

  try {
    const st = fs.statSync(root);
    out.exists = true;
    out.isDirectory = st.isDirectory();
  } catch {
    return out;
  }
  if (!out.isDirectory) return out;

  try {
    const entries = fs.readdirSync(root);
    out.readable = true;
    out.entries = entries.filter((e) => e !== '.git' && e !== HOME_DIR_NAME).length;
    out.isGitRepo = entries.includes('.git');
  } catch {
    return out;
  }

  try {
    fs.accessSync(root, fs.constants.W_OK);
    out.writable = true;
  } catch { /* read-only: reported, not fatal to report on */ }

  const briefPath = path.join(root, DEFAULT_BRIEF);
  out.hasBrief = fs.existsSync(briefPath);
  if (out.hasBrief) {
    try {
      const body = fs.readFileSync(briefPath, 'utf8');
      out.briefUntouched = isUntouchedBrief(body);
      out.briefInferred = isInferredBrief(body);
    } catch { /* unreadable brief still counts as present */ }
  }

  const modern = path.join(root, HOME_DIR_NAME);
  const legacyCfg = path.join(root, 'studio.config.json');
  const legacyState = path.join(root, '.studio');
  out.legacyLayout = !fs.existsSync(modern) && (fs.existsSync(legacyCfg) || fs.existsSync(legacyState));

  out.hasConfig = out.legacyLayout
    ? fs.existsSync(legacyCfg)
    : fs.existsSync(path.join(modern, 'config.json'));

  const log = out.legacyLayout
    ? path.join(legacyState, 'events.jsonl')
    : path.join(modern, 'state', 'events.jsonl');
  if (fs.existsSync(log)) {
    out.hasState = true;
    try {
      // Line count is the honest measure of "is there anything to resume".
      out.events = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    } catch { /* unreadable log still counts as state */ }
  }
  return out;
}

/** Everything that stops a directory being usable as a project, in plain words. */
export function problemsWith(info) {
  const p = [];
  if (!info.exists) p.push('that directory does not exist');
  else if (!info.isDirectory) p.push('that path is a file, not a directory');
  else if (!info.readable) p.push('that directory cannot be read');
  else if (!info.writable) p.push('that directory is not writable — the studio needs to create studio_floor/ in it');
  return p;
}

export function readProjects() {
  try {
    const list = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter((p) => p && typeof p.path === 'string') : [];
  } catch {
    return [];
  }
}

/** Record that we opened this project, newest first. `at` is supplied, never generated. */
export function rememberProject(dir, at) {
  ensureUserDir();
  const root = path.resolve(dir);
  const rest = readProjects().filter((p) => path.resolve(p.path) !== root);
  const list = [{ path: root, name: path.basename(root), lastOpened: at }, ...rest].slice(0, 20);
  atomicWrite(PROJECTS_FILE, list);
  return list;
}

export function forgetProject(dir) {
  const root = path.resolve(dir);
  const list = readProjects().filter((p) => path.resolve(p.path) !== root);
  atomicWrite(PROJECTS_FILE, list);
  return list;
}

/** Recent projects, annotated with what is actually on disk right now. */
export function recentProjects() {
  return readProjects().map((p) => ({ ...p, ...inspect(p.path) }));
}

// ------------------------------------------------------------------- switching

/**
 * Ask the supervisor to relaunch pointed somewhere else.
 *
 * The server cannot change its own project root — it was resolved at import and
 * the store has already replayed one log — so the switch is a handoff: write
 * where to go, exit with EXIT_SWITCH, and let the launcher start a fresh process
 * there. A file rather than an argument because the supervisor is the parent and
 * has no other channel back from the child.
 */
export function requestSwitch(dir, { reset = false, reason = 'switch' } = {}) {
  ensureUserDir();
  atomicWrite(SWITCH_FILE, { path: path.resolve(dir), reset: Boolean(reset), reason });
}

export function takeSwitch() {
  let req = null;
  try {
    req = JSON.parse(fs.readFileSync(SWITCH_FILE, 'utf8'));
  } catch {
    return null;
  }
  // Consumed, so a crash between reading and acting cannot loop forever.
  try { fs.rmSync(SWITCH_FILE, { force: true }); } catch { /* already gone */ }
  return req && typeof req.path === 'string' ? req : null;
}

/**
 * Delete a project's studio memory. Its code and its brief are untouched.
 *
 * Deliberately narrow: it removes the state directory and nothing else, so a
 * reset cannot take the config, the brief, or anything the human wrote.
 */
export function resetProjectState(dir) {
  const root = path.resolve(dir);
  const info = inspect(root);
  const stateDir = info.legacyLayout
    ? path.join(root, '.studio')
    : path.join(root, HOME_DIR_NAME, 'state');
  if (!fs.existsSync(stateDir)) return { removed: false, path: stateDir };
  fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  return { removed: true, path: stateDir };
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export { USER_DIR };

/**
 * Whether anybody has said what this project is.
 *
 * Three answers, and only one of them is a project: a brief that is missing, a
 * brief that is still the template `studio init` writes, and a brief somebody
 * wrote. An agent-inferred draft counts as written — it is a real description
 * and the prompt already tells agents not to build on it unrecorded — because
 * refusing to run against one would strand a team that correctly did its first
 * job.
 */
export function briefState(projectRoot = PROJECT_ROOT, briefName = DEFAULT_BRIEF) {
  const file = path.resolve(projectRoot, briefName);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { written: false, why: `There is no ${briefName} in ${projectRoot}.`, file };
  }
  if (isUntouchedBrief(text)) {
    return {
      written: false,
      why: `${file} is still the template studio init writes — nobody has filled it in.`,
      file,
    };
  }
  return { written: true, why: '', file, inferred: isInferredBrief(text) };
}
