import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** src/ — where the studio's own code lives. */
export const SRC_DIR = path.resolve(here, '..');

/** Kept under the old name because the runner and tests both import it. */
export const STUDIO_DIR = SRC_DIR;

/** The installed package root — the repo root when running from a clone. */
export const PACKAGE_ROOT = path.resolve(SRC_DIR, '..');

/**
 * The project the agents work in.
 *
 * Resolved once, at import. Everything below hangs off it, which is exactly why
 * switching projects relaunches the process rather than mutating this.
 */
export const PROJECT_ROOT = path.resolve(process.env.STUDIO_PROJECT_ROOT || process.cwd());

/**
 * Where the studio keeps everything it owns inside a project.
 *
 *   <project>/studio_floor/config.json     the roster — commit this
 *   <project>/studio_floor/state/          the event log — gitignored
 *   <project>/PROJECT.md                   the brief — yours, at the top level
 *
 * The brief stays at the project root on purpose: it is a document the human
 * writes and reads, not machinery. Everything the studio generates goes in one
 * folder so pointing the team at a repository adds exactly one directory to it.
 */
export const HOME_DIR_NAME = 'studio_floor';

/**
 * A studio set up before the studio_floor layout existed keeps working.
 *
 * Silently switching an existing project to the new paths would orphan its event
 * log — the team's entire memory — and present an empty studio as if nothing had
 * ever happened. So a project that already has the old layout keeps it, and only
 * new ones get the new one.
 */
const legacyState = path.join(PROJECT_ROOT, '.studio');
const legacyConfig = path.join(PROJECT_ROOT, 'studio.config.json');
const modern = path.join(PROJECT_ROOT, HOME_DIR_NAME);

export const IS_LEGACY_LAYOUT = !fs.existsSync(modern)
  && (fs.existsSync(legacyState) || fs.existsSync(legacyConfig));

/** <project>/studio_floor — absent in a legacy project. */
export const HOME_DIR = modern;

export const STATE_DIR = process.env.STUDIO_STATE_DIR
  ? path.resolve(process.env.STUDIO_STATE_DIR)
  : (IS_LEGACY_LAYOUT ? legacyState : path.join(modern, 'state'));

export const EVENT_LOG = path.join(STATE_DIR, 'events.jsonl');
export const RUNTIME_FILE = path.join(STATE_DIR, 'runtime.json');
export const TRANSCRIPT_DIR = path.join(STATE_DIR, 'transcripts');

export const CONFIG_FILE = process.env.STUDIO_CONFIG
  ? path.resolve(process.env.STUDIO_CONFIG)
  : (IS_LEGACY_LAYOUT ? legacyConfig : path.join(modern, 'config.json'));

/** The brief. Always at the project root, whatever the layout. */
export const DEFAULT_BRIEF = 'PROJECT.md';

export const WEB_DIR = path.join(SRC_DIR, 'web');

/**
 * Where the studio remembers things that are not about any one project: which
 * project it was last pointed at, and the ones it has seen before.
 */
export const USER_DIR = process.env.STUDIO_USER_DIR
  ? path.resolve(process.env.STUDIO_USER_DIR)
  : path.join(os.homedir(), '.studio-floor');

export const PROJECTS_FILE = path.join(USER_DIR, 'projects.json');

/**
 * How the supervisor is told to relaunch somewhere else. Written by the server,
 * read by the launcher, deleted once acted on.
 */
export const SWITCH_FILE = path.join(USER_DIR, 'switch.json');

/** Exit code a studio uses to ask its supervisor to restart it elsewhere. */
export const EXIT_SWITCH = 75;

/**
 * How an agent invokes the studio CLI from inside its own turn.
 *
 * Absolute, because the agent's shell starts in PROJECT_ROOT and the CLI lives
 * in the package — which after `npm i -g` is somewhere else entirely.
 */
export const STUDIO_CMD = process.env.STUDIO_CMD
  || `node "${path.join(SRC_DIR, 'cli', 'studio.mjs')}"`;

export const PORT = Number(process.env.STUDIO_PORT || 4173);
export const HOST = process.env.STUDIO_HOST || '127.0.0.1';
export const BASE_URL = process.env.STUDIO_URL
  || `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  if (IS_LEGACY_LAYOUT) {
    // The old layout put the whole directory out of git's sight.
    const gi = path.join(STATE_DIR, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
    return;
  }
  // The new one keeps config committable and ignores only the state beside it.
  const gi = path.join(HOME_DIR, '.gitignore');
  if (!fs.existsSync(gi)) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(gi, '# the team\'s memory for this project — machine-local\nstate/\n');
  }
}

export function ensureUserDir() {
  fs.mkdirSync(USER_DIR, { recursive: true });
}
