import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from '../../core/paths.mjs';
import codex from './codex.mjs';
import claude from './claude.mjs';
import grok from './grok.mjs';

/**
 * The adapter registry.
 *
 * An adapter is the whole of what the studio needs to know about a vendor CLI:
 * how to launch it for a fresh turn, how to resume the session it opened last
 * turn, and how to read its stdout. Everything else — turns, inboxes, tasks,
 * debates, the log, the UI — is provider-agnostic and stays that way.
 *
 * Adding a provider is one file and one line in `studio.config.json`. It is
 * never a change to core.
 */

/** @typedef {object} Adapter
 * @property {string}  id          provider name, referenced by `agent.provider`
 * @property {string}  label       display name
 * @property {string}  command     executable to spawn
 * @property {string[]} [versionArgs] args that make it print a version, for `studio doctor`
 * @property {() => (string|null)} [newSession] mint a session id, or null if the CLI assigns one
 * @property {(ctx: {prompt: string, sessionId: string|null, fresh: boolean, agent: object}) => string[]} args
 * @property {(line: object) => Array<{kind: string, data: object}>} parse
 */

const REGISTRY = new Map();

/** Register an adapter. Later registrations of the same id win, so a project can override a built-in. */
export function register(adapter) {
  const problems = validate(adapter);
  if (problems.length) {
    throw new Error(`studio: invalid adapter ${JSON.stringify(adapter?.id)} — ${problems.join('; ')}`);
  }
  REGISTRY.set(adapter.id, adapter);
  return adapter;
}

export function validate(a) {
  const p = [];
  if (!a || typeof a !== 'object') return ['not an object'];
  if (typeof a.id !== 'string' || !a.id) p.push('missing id');
  if (typeof a.command !== 'string' || !a.command) p.push('missing command');
  if (typeof a.args !== 'function') p.push('args must be a function');
  if (typeof a.parse !== 'function') p.push('parse must be a function');
  if (a.newSession !== undefined && typeof a.newSession !== 'function') p.push('newSession must be a function');
  return p;
}

export function getAdapter(provider) {
  return REGISTRY.get(provider) || null;
}

export function providers() {
  return [...REGISTRY.keys()];
}

/**
 * Load adapters named in the config.
 *
 * Entries are resolved against the project directory, so a project can keep
 * `adapters/gemini.mjs` next to its own code. A bare package name is resolved
 * as a normal import, so an adapter can also ship on npm.
 */
export async function loadUserAdapters(specs = []) {
  const loaded = [];
  for (const spec of specs) {
    const url = spec.startsWith('.') || path.isAbsolute(spec)
      ? pathToFileURL(path.resolve(PROJECT_ROOT, spec)).href
      : spec;
    let mod;
    try {
      mod = await import(url);
    } catch (e) {
      throw new Error(`studio: could not load adapter "${spec}" — ${e.message}`);
    }
    const candidates = [mod.default, ...Object.values(mod)].filter(
      (v) => v && typeof v === 'object' && typeof v.args === 'function',
    );
    if (!candidates.length) {
      throw new Error(`studio: adapter "${spec}" exports nothing that looks like an adapter`);
    }
    loaded.push(register(candidates[0]));
  }
  return loaded;
}

for (const a of [codex, claude, grok]) register(a);

/**
 * The built-in adapters as a plain object, keyed by provider.
 * Kept as a live view of the registry so a late `register()` is visible here.
 */
export const ADAPTERS = new Proxy({}, {
  get: (_, k) => REGISTRY.get(k),
  has: (_, k) => REGISTRY.has(k),
  ownKeys: () => [...REGISTRY.keys()],
  getOwnPropertyDescriptor: (_, k) => (REGISTRY.has(k)
    ? { value: REGISTRY.get(k), enumerable: true, configurable: true }
    : undefined),
});
