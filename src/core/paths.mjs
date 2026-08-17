import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** src/ — where the studio's own code lives. */
export const SRC_DIR = path.resolve(here, '..');

/** Kept under the old name because the runner and tests both import it. */
export const STUDIO_DIR = SRC_DIR;

/** The installed package root — the repo root when running from a clone. */
export const PACKAGE_ROOT = path.resolve(SRC_DIR, '..');

/**
 * The project the agents actually work in.
 *
 * This is the one thing that makes the studio a tool rather than a fixture. It
 * used to be "the directory above studio/", which meant the orchestrator only
 * worked when it was vendored inside the project it was orchestrating. Now it
 * is the working directory, or whatever `--project` / `STUDIO_PROJECT_ROOT`
 * says, and the studio can be installed once and pointed anywhere.
 */
export const PROJECT_ROOT = path.resolve(process.env.STUDIO_PROJECT_ROOT || process.cwd());

/**
 * Runtime state. Deleting it resets the studio without touching project files.
 * Separable from the project so a cloud deployment can mount it on a volume.
 */
export const STATE_DIR = process.env.STUDIO_STATE_DIR
  ? path.resolve(process.env.STUDIO_STATE_DIR)
  : path.join(PROJECT_ROOT, '.studio');

export const EVENT_LOG = path.join(STATE_DIR, 'events.jsonl');
export const RUNTIME_FILE = path.join(STATE_DIR, 'runtime.json');
export const TRANSCRIPT_DIR = path.join(STATE_DIR, 'transcripts');

export const WEB_DIR = path.join(SRC_DIR, 'web');

/** Where the roster and runner settings are read from. */
export const CONFIG_FILE = process.env.STUDIO_CONFIG
  ? path.resolve(process.env.STUDIO_CONFIG)
  : path.join(PROJECT_ROOT, 'studio.config.json');

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
  const gitignore = path.join(STATE_DIR, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n');
}
