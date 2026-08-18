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

  // Project-supplied adapter modules.
  //
  // This used to be dropped on the floor: defaultConfig() has no `adapters` key
  // and nothing copied it across, so `CONFIG.adapters` was always undefined, the
  // `if (CONFIG.adapters?.length)` guard in the launcher never fired, and
  // loadUserAdapters() was correct code that nothing ever called. Every config
  // naming a custom provider therefore failed with "no adapter for provider X"
  // and the studio refused to start — including the example printed in the
  // README. The whole pluggable-provider feature was dead on arrival.
  if (legacy.adapters !== undefined) {
    if (!Array.isArray(legacy.adapters) || legacy.adapters.some((a) => typeof a !== 'string' || !a.trim())) {
      throw new Error('studio: `adapters` must be a list of module paths or package names');
    }
    cfg.adapters = legacy.adapters.map((a) => a.trim());
  }

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

// ---------------------------------------------------------- editing over HTTP

/**
 * Fields the settings panel may write, and nothing else.
 *
 * This allowlist is a security boundary, not a convenience.
 *
 * The config decides which executable the studio spawns (`command`), what
 * arguments it gets (`extraArgs`), what environment it runs in (`env`), and
 * which JavaScript files get imported at boot (`adapters`). Any of those,
 * writable over HTTP, is remote code execution wearing a settings form — and
 * the server sets `Access-Control-Allow-Origin: *`, so "over HTTP" includes any
 * website the human happens to have open in another tab.
 *
 * So the panel can change how much freedom the agents have. It cannot change
 * what program runs. Those fields stay editable only by someone who can already
 * write files on the machine, which is a person who does not need this API.
 */
export const AGENT_EDITABLE = ['id', 'provider', 'label', 'persona'];
export const AGENT_EDITABLE_OPTIONS = ['model', 'sandbox', 'permissionMode', 'disableMcp'];
export const AGENT_PROTECTED_OPTIONS = ['command', 'extraArgs', 'env'];
export const RUNNER_EDITABLE = [
  'maxTurns', 'turnTimeoutMs', 'cooldownMs', 'staggerMs', 'commandLineBudget', 'idleBackoffMs',
];
export const PROJECT_EDITABLE = ['name', 'goal', 'brief'];

/**
 * Which edits take effect immediately and which need a restart.
 *
 * The runner re-reads its own settings every loop iteration, so turn budgets and
 * timings genuinely apply live. The roster does not work that way: `AGENT_IDS`
 * is resolved once at import and baked into the store's projection, the server's
 * validation and the runner's agent map. Pretending otherwise would show the
 * human a team that is not the team that is running.
 */
export const LIVE_FIELDS = ['runner', 'project.name', 'project.goal'];

/** Numeric bounds, so a typo cannot wedge the studio into a spin or a stall. */
const NUMERIC_BOUNDS = {
  maxTurns: [0, 100_000],
  turnTimeoutMs: [10_000, 24 * 60 * 60 * 1000],
  cooldownMs: [0, 10 * 60 * 1000],
  staggerMs: [0, 10 * 60 * 1000],
  commandLineBudget: [2_000, 120_000],
};

const SANDBOXES = ['read-only', 'workspace-write', 'full'];
const PERMISSION_MODES = ['default', 'auto', 'acceptEdits'];

/** Read the config file as written, with no defaults applied. */
export function readRawConfig(file = CONFIG_FILE) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`studio: ${file} is not valid JSON — ${e.message}`);
  }
}

/**
 * Merge an edit from the settings panel into the config as written on disk.
 *
 * Deliberately patches the *raw* file rather than writing back a normalised
 * config. Writing the normalised form would bake every default into the file and
 * silently drop the fields this API refuses to manage — so saving the roster
 * from the UI would delete a hand-written `adapters` list or a per-agent
 * `command`. Unmanaged fields are carried across per agent, matched by id.
 *
 * Returns the new raw config and the problems found. Never writes anything.
 */
export function applyConfigPatch(raw, patch = {}, { knownProviders = null } = {}) {
  const errors = [];
  const warnings = [];
  const next = JSON.parse(JSON.stringify(raw || {}));

  if (patch.project && typeof patch.project === 'object') {
    next.project = { ...(next.project || {}) };
    for (const [k, v] of Object.entries(patch.project)) {
      if (!PROJECT_EDITABLE.includes(k)) {
        errors.push(`project.${k} is not editable here`);
        continue;
      }
      if (typeof v !== 'string') {
        errors.push(`project.${k} must be text`);
        continue;
      }
      if (k === 'brief' && (v.includes('..') || path.isAbsolute(v))) {
        // The brief is read from disk and pasted into every first-turn prompt.
        // A path that escapes the project would turn the settings form into a
        // file-read primitive.
        errors.push('project.brief must be a path inside the project');
        continue;
      }
      next.project[k] = v;
    }
  }

  if (patch.runner && typeof patch.runner === 'object') {
    next.runner = { ...(next.runner || {}) };
    for (const [k, v] of Object.entries(patch.runner)) {
      if (!RUNNER_EDITABLE.includes(k)) {
        errors.push(`runner.${k} is not editable here`);
        continue;
      }
      if (k === 'idleBackoffMs') {
        const list = Array.isArray(v) ? v.map(Number) : [];
        if (!list.length || list.some((n) => !Number.isFinite(n) || n < 0 || n > 3_600_000)) {
          errors.push('runner.idleBackoffMs must be a list of delays between 0 and 3600000 ms');
          continue;
        }
        next.runner[k] = list;
        continue;
      }
      const n = Number(v);
      const [lo, hi] = NUMERIC_BOUNDS[k] || [0, Number.MAX_SAFE_INTEGER];
      if (!Number.isFinite(n) || n < lo || n > hi) {
        errors.push(`runner.${k} must be a number between ${lo} and ${hi}`);
        continue;
      }
      next.runner[k] = n;
    }
  }

  if (patch.agents !== undefined) {
    if (!Array.isArray(patch.agents) || !patch.agents.length) {
      errors.push('the roster must have at least one agent');
    } else {
      // Unmanaged per-agent fields survive an edit, matched by id.
      const previous = new Map(
        (Array.isArray(raw?.agents) ? raw.agents : [])
          .filter((a) => a && typeof a === 'object')
          .map((a) => [a.id, a]),
      );
      next.agents = patch.agents.map((incoming, i) => {
        const kept = previous.get(incoming?.id) || {};
        const agent = {};
        for (const k of AGENT_PROTECTED_OPTIONS) {
          if (kept[k] !== undefined) agent[k] = kept[k];
        }
        if (kept.options) agent.options = kept.options;
        for (const [k, v] of Object.entries(incoming || {})) {
          if (AGENT_EDITABLE.includes(k)) {
            agent[k] = typeof v === 'string' ? v.trim() : v;
          } else if (AGENT_EDITABLE_OPTIONS.includes(k)) {
            if (k === 'sandbox' && v && !SANDBOXES.includes(v)) {
              errors.push(`agent #${i + 1}: sandbox must be one of ${SANDBOXES.join(', ')}`);
              continue;
            }
            if (k === 'permissionMode' && v && !PERMISSION_MODES.includes(v)) {
              errors.push(`agent #${i + 1}: permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
              continue;
            }
            if (v !== '' && v !== undefined && v !== null) agent[k] = v;
          } else if (AGENT_PROTECTED_OPTIONS.includes(k)) {
            errors.push(
              `agent #${i + 1}: "${k}" cannot be set from the settings panel — `
              + 'it decides what program runs, so it is editable only in the config file',
            );
          } else {
            errors.push(`agent #${i + 1}: "${k}" is not a known field`);
          }
        }
        return agent;
      });
    }
  }

  // Everything above is field-level. This is the whole-config check: unusable
  // ids and duplicates. Reuse the loader rather than reimplementing its rules,
  // so the panel cannot accept a config the launcher would then reject.
  if (!errors.length) {
    try {
      const resolved = normaliseConfig(next);

      // A provider with no adapter is fatal at startup — the Runner refuses to
      // construct — so accepting one here writes a config that cannot boot. The
      // panel bricked a studio exactly this way before the check existed.
      // normaliseConfig cannot do it: adapters are a separate registry that this
      // module deliberately does not import, so the caller supplies the list.
      if (knownProviders) {
        // Distinguish breakage this save would introduce from breakage that was
        // already sitting in the file.
        //
        // Blocking on both makes the panel unusable in a state you can actually
        // reach: `--only` skips an agent whose adapter is missing, so the studio
        // starts, and then every save — even one that touches nothing but
        // maxTurns — was refused because of an agent the human never edited.
        // Holding unrelated edits hostage to pre-existing breakage is the
        // opposite of what a settings form is for.
        const before = new Map(
          (Array.isArray(raw?.agents) ? raw.agents : [])
            .filter((a) => a && typeof a === 'object')
            .map((a) => [a.id, a.provider || a.id]),
        );
        for (const a of resolved.agents) {
          if (knownProviders.includes(a.provider)) continue;
          const where = `agent "${a.id}": there is no adapter for provider "${a.provider}" `
            + `(this studio has ${knownProviders.join(', ')})`;
          if (before.get(a.id) === a.provider) {
            warnings.push(
              `${where}. It was already in the config and this save left it alone, but the `
              + 'studio will refuse to start until you add the adapter or change the provider.',
            );
          } else {
            errors.push(`${where}. The studio would fail to start.`);
          }
        }
      }
    } catch (e) {
      errors.push(String(e.message).replace(/^studio: /, ''));
    }
  }

  return { config: next, errors, warnings };
}

/** Which of these changes need a restart before they mean anything. */
export function restartRequiredFor(before, after) {
  const reasons = [];
  const roster = (c) => JSON.stringify((c.agents || []).map((a) => [a.id, a.provider, a.persona, a.label, a.model, a.sandbox, a.permissionMode, a.disableMcp]));
  if (roster(before) !== roster(after)) reasons.push('the roster changed');
  if (JSON.stringify(before.server || {}) !== JSON.stringify(after.server || {})) reasons.push('server settings changed');
  if ((before.project?.brief || '') !== (after.project?.brief || '')) reasons.push('the project brief path changed');
  return reasons;
}

/** Write the config, atomically enough that a crash cannot leave a half file. */
export function saveRawConfig(file, raw) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** Everything the settings panel needs to render itself, so the UI hardcodes nothing. */
export function configSchema() {
  return {
    personas: Object.keys(PERSONAS),
    sandboxes: SANDBOXES,
    permissionModes: PERMISSION_MODES,
    agentFields: [...AGENT_EDITABLE, ...AGENT_EDITABLE_OPTIONS],
    protectedFields: AGENT_PROTECTED_OPTIONS,
    runnerFields: RUNNER_EDITABLE,
    projectFields: PROJECT_EDITABLE,
    liveFields: LIVE_FIELDS,
    bounds: NUMERIC_BOUNDS,
  };
}
