import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, PROJECT_ROOT } from './paths.mjs';

/**
 * The roster and the runner's settings.
 *
 * The studio used to hardcode exactly three agents whose ids were also their
 * provider names, which made "run two Claudes with different jobs" impossible
 * and "add a fourth provider" a code change in six files. Here an agent is a
 * record: an id the team knows it by, a provider that says which CLI to launch,
 * and a persona that says what it is for. Everything downstream reads the
 * resolved roster instead of a constant.
 */

export const DEFAULT_RUNNER = {
  /** Per-agent turn budget. The agent stops when it is reached. */
  maxTurns: 200,
  /** A turn is killed if it runs longer than this. */
  turnTimeoutMs: 20 * 60 * 1000,
  /** Pause between an agent's turns, so it cannot spin. */
  cooldownMs: 4000,
  /** Delay between agent starts so they do not all boot into the same second. */
  staggerMs: 10_000,
  /** Escalating wait when an agent has nothing to do. */
  idleBackoffMs: [15_000, 30_000, 60_000, 120_000],
  /**
   * Windows refuses a command line over 32767 characters and the failure comes
   * from spawn itself, so the provider never runs and cannot report it.
   */
  commandLineBudget: 28_000,
};

export const DEFAULT_SERVER = {
  port: 4173,
  host: '127.0.0.1',
  /** Bearer token required by write routes. Null means an open local server. */
  token: null,
};

/**
 * Archetypes, not job descriptions.
 *
 * Each is written to be declined: an agent that thinks it is better at
 * something else is supposed to say so on its first turn. A team of three
 * agents all told "you are a strong implementer" produces three implementers
 * who agree with each other, which is the failure mode this whole project
 * exists to avoid.
 */
export const PERSONAS = {
  implementer: 'You are in this studio as a strong implementer: precise code, careful '
    + 'refactors, systematic execution, disciplined verification.',
  architect: 'You are in this studio as a strong systems thinker: architecture, interfaces, '
    + "reviewing other people's work, and writing things down so they stay true.",
  adversary: 'You are in this studio as a strong adversarial thinker: finding the exploit, '
    + 'the degenerate case, the assumption nobody checked, and saying the uncomfortable '
    + 'thing early.',
  researcher: 'You are in this studio as a strong researcher: finding out what is actually '
    + 'true before the team commits to it, reading the source rather than guessing, and '
    + 'reporting what you found including the parts that are inconvenient.',
  integrator: 'You are in this studio as a strong integrator: making the pieces other agents '
    + 'built actually work together, running the whole thing end to end, and owning the '
    + 'seams nobody else wants.',
};

const PERSONA_SUFFIX = ' You are not obliged to accept that framing — tell the team what you '
  + 'actually think you are best at.';

/** The roster you get if you never write a config. */
export const DEFAULT_AGENTS = [
  { id: 'codex', provider: 'codex', label: 'Codex', persona: 'implementer' },
  { id: 'claude', provider: 'claude', label: 'Claude', persona: 'architect' },
  { id: 'grok', provider: 'grok', label: 'Grok', persona: 'adversary' },
];

/** Provider option defaults, applied per agent. */
const PROVIDER_DEFAULTS = {
  codex: { sandbox: 'workspace-write', model: '' },
  claude: { permissionMode: 'auto', model: '', disableMcp: true },
  grok: { permissionMode: 'auto', model: '' },
};

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function defaultConfig() {
  return {
    project: {
      name: path.basename(PROJECT_ROOT),
      brief: 'PROJECT.md',
      goal: '',
    },
    agents: DEFAULT_AGENTS.map((a) => ({ ...a })),
    runner: { ...DEFAULT_RUNNER },
    server: { ...DEFAULT_SERVER },
  };
}

/**
 * Read and normalise the config.
 *
 * Never throws on a missing file — a studio with no config is a valid studio
 * with the default roster. It does throw on a config that is present and wrong,
 * because silently running a different team than the one you wrote down is
 * exactly the class of quiet failure this codebase refuses.
 */
export function loadConfig(file = CONFIG_FILE) {
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`studio: ${file} is not valid JSON — ${e.message}`);
    }
  }
  return normaliseConfig(raw);
}

export function normaliseConfig(raw = {}) {
  const legacy = liftLegacy(raw);
  const cfg = defaultConfig();

  cfg.project = { ...cfg.project, ...(legacy.project || {}) };
  cfg.runner = { ...cfg.runner, ...(legacy.runner || {}) };
  cfg.server = { ...cfg.server, ...(legacy.server || {}) };

  const list = Array.isArray(legacy.agents) && legacy.agents.length
    ? legacy.agents
    : DEFAULT_AGENTS;

  const seen = new Set();
  cfg.agents = list.map((entry, i) => {
    const a = typeof entry === 'string' ? { id: entry } : { ...entry };
    const id = String(a.id || '').trim();
    if (!ID_RE.test(id)) {
      throw new Error(
        `studio: agent #${i + 1} has an unusable id ${JSON.stringify(a.id)} — `
        + 'ids must be lowercase letters, digits and dashes, starting with a letter',
      );
    }
    if (seen.has(id)) throw new Error(`studio: duplicate agent id "${id}"`);
    seen.add(id);

    const provider = String(a.provider || id).trim();
    const persona = resolvePersona(a.persona, provider);

    return {
      id,
      provider,
      label: a.label || id.replace(/(^|-)([a-z])/g, (_, s, c) => s.replace('-', ' ') + c.toUpperCase()),
      persona,
      options: { ...(PROVIDER_DEFAULTS[provider] || {}), ...(a.options || {}), ...pickOptionKeys(a) },
    };
  });

  if (!cfg.agents.length) throw new Error('studio: the roster is empty — configure at least one agent');
  return cfg;
}

/** Option keys accepted inline on the agent record as a convenience. */
function pickOptionKeys(a) {
  const out = {};
  for (const k of ['model', 'sandbox', 'permissionMode', 'disableMcp', 'command', 'extraArgs', 'env']) {
    if (a[k] !== undefined) out[k] = a[k];
  }
  return out;
}

function resolvePersona(persona, provider) {
  if (!persona) {
    const fallback = { codex: 'implementer', claude: 'architect', grok: 'adversary' }[provider];
    return fallback ? PERSONAS[fallback] + PERSONA_SUFFIX : '';
  }
  if (PERSONAS[persona]) return PERSONAS[persona] + PERSONA_SUFFIX;
  return String(persona);
}

/**
 * Accept the old flat config shape.
 *
 * The first studio wrote `{"agents":["codex","claude","grok"],"maxTurns":200,
 * "codexSandbox":"workspace-write",...}`. Anyone upgrading has that file on
 * disk and should not have to hand-translate it to keep working.
 */
function liftLegacy(raw) {
  const isLegacy = Array.isArray(raw.agents) && raw.agents.every((a) => typeof a === 'string');
  const hasFlatKeys = ['maxTurns', 'turnTimeoutMs', 'cooldownMs', 'staggerMs', 'idleBackoffMs']
    .some((k) => raw[k] !== undefined);
  if (!isLegacy && !hasFlatKeys) return raw;

  const out = { ...raw };
  out.runner = {
    ...pick(raw, ['maxTurns', 'turnTimeoutMs', 'cooldownMs', 'staggerMs', 'idleBackoffMs']),
    ...(raw.runner || {}),
  };
  if (isLegacy) {
    out.agents = raw.agents.map((id) => {
      const a = { id, provider: id };
      const model = raw[`${id}Model`];
      if (model) a.model = model;
      if (id === 'codex' && raw.codexSandbox) a.sandbox = raw.codexSandbox;
      if (raw[`${id}PermissionMode`]) a.permissionMode = raw[`${id}PermissionMode`];
      if (id === 'claude' && raw.disableMcp !== undefined) a.disableMcp = raw.disableMcp;
      return a;
    });
  }
  return out;
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** Write a starter config next to the project. Refuses to clobber an existing one. */
export function writeConfig(file = CONFIG_FILE, cfg = defaultConfig()) {
  if (fs.existsSync(file)) return { written: false, file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return { written: true, file };
}
