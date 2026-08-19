import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, PROJECT_ROOT } from './paths.mjs';
import { AUTH_MODES } from './auth.mjs';

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
  /**
   * Team-wide budgets. Zero means no limit, which is the default because a
   * studio someone is watching does not need one.
   *
   * They exist for the studio nobody is watching. `maxTurns` bounds how much
   * work an agent does, but not how long it takes or what it costs, and those
   * are the two questions a human leaving one running overnight is actually
   * asking. Both are checked before a turn starts and stop the whole team, not
   * one agent: a budget is a statement about the run, not about a member of it.
   */
  maxWallMs: 0,
  /**
   * Dollars. Read from the usage ledger, which prefers the provider's own
   * figure and falls back to the rates in `prices`. A provider that reports
   * neither contributes nothing, so this cap can undercount — the stop reason
   * and the panel both say so rather than implying a number they cannot know.
   */
  maxSpendUsd: 0,
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
  /**
   * The directory the /preview pane serves — the thing being built, not the
   * studio's own UI. Relative to the project root, or absolute.
   *
   * Null means serve nothing. It does NOT mean detect: src/core/preview.mjs
   * ranks the directories that could be previewed and offers them in the pane,
   * and a human picks one. A path that is set and wrong is reported as wrong;
   * it is never quietly replaced by a plausible-looking neighbour, because
   * serving a different directory than the human named is the exact class of
   * quiet substitution this project keeps finding in itself.
   */
  preview: null,
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

/**
 * Backends that speak an existing adapter's protocol.
 *
 * Kimi, GLM and several others publish Anthropic-compatible endpoints so that
 * Claude Code can talk to them, and xAI publishes an OpenAI-shaped one that the
 * Codex CLI can speak. Either way a separate adapter would be an existing one
 * with a different URL, which is a bad way to carry knowledge that is really
 * just two strings. A preset is those two strings, plus which CLI does the
 * talking.
 *
 * Only the endpoint is recorded here. Model names move faster than this file
 * can, and a stale default silently routing to a retired model is worse than
 * asking for one; the key is always the human's to supply.
 */
export const PRESETS = {
  kimi: {
    provider: 'claude',
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    note: 'Moonshot Kimi, over its Anthropic-compatible endpoint. Set a model, '
      + 'and put your key in MOONSHOT_API_KEY.',
  },
  glm: {
    provider: 'claude',
    label: 'GLM',
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKeyEnv: 'ZAI_API_KEY',
    note: 'Zhipu GLM, over its Anthropic-compatible endpoint. Set a model, and '
      + 'put your key in ZAI_API_KEY.',
  },
  // Grok, without Grok's CLI.
  //
  // The Grok CLI is a native binary rather than an npm package, so a container
  // that installs its tools from npm cannot have one — and the studio drives
  // CLIs, not APIs, so "just use the API" needs some CLI to be the harness.
  // Codex is that harness here: it is already in the image, it can be pointed
  // at any provider, and xAI's OpenAI-shaped endpoint is one it can speak.
  //
  // Deliberately NOT xAI's Anthropic-compatible endpoint via Claude Code, which
  // would have been the smaller change. xAI has deprecated that compatibility
  // layer, and a preset built on it would work now and fail later in a way that
  // reads as an adapter bug rather than a vendor removal.
  grok: {
    provider: 'codex',
    label: 'Grok',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    note: 'Grok through the Codex CLI, pointed at the xAI API. For a machine '
      + 'with no grok CLI on it — a container, usually. Set a model (grok-4 and '
      + 'similar), and put your key in XAI_API_KEY.',
  },
};

/**
 * Expand `preset: "kimi"` into the fields it stands for.
 *
 * Anything the agent states itself wins, so a preset is a starting point rather
 * than something that overrides what the human wrote.
 */
export function applyPreset(agent) {
  const p = PRESETS[agent.preset];
  if (!p) return agent;
  const { note, ...fields } = p;
  return { ...fields, ...agent, provider: agent.provider || p.provider };
}

/**
 * The list a human actually chooses from: companies.
 *
 * The config has two fields for this — `provider`, meaning which CLI, and
 * `preset`, meaning which endpoint that CLI is pointed at — and both are
 * accurate and neither is the question anyone is asking. They are asking for
 * Anthropic, or xAI. Worse, the two are not independent: xAI is reachable
 * either by its own CLI or through Codex against its API, which as two
 * dropdowns is a puzzle rather than a choice.
 *
 * So the panel asks for a company, and how it should authenticate. Those two
 * answers decide the CLI between them:
 *
 *   xAI + this machine's login  →  the Grok CLI, which signs in and takes no key
 *   xAI + an API key            →  the Codex CLI, pointed at the xAI API
 *
 * Nobody has to know that, which is the point.
 *
 * `models` are suggestions, not truth. This file has always refused to record a
 * default model, because names move faster than a release does and a stale one
 * silently routing to a retired model is worse than an empty box. An empty box
 * is worse for somebody who has never used the vendor, though, so these are
 * offered as completions over a field that still takes anything.
 */
export const VENDORS = {
  anthropic: {
    label: 'Anthropic',
    login: { provider: 'claude' },
    key: { provider: 'claude', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    keysAt: 'console.anthropic.com',
    modelsApi: { url: 'https://api.anthropic.com/v1/models?limit=100', auth: 'x-api-key' },
  },
  openai: {
    label: 'OpenAI',
    login: { provider: 'codex' },
    key: { provider: 'codex', apiKeyEnv: 'OPENAI_API_KEY' },
    models: ['gpt-5.2-codex', 'gpt-5.2', 'o4-mini'],
    keysAt: 'platform.openai.com',
    modelsApi: { url: 'https://api.openai.com/v1/models', auth: 'bearer' },
  },
  google: {
    label: 'Google',
    login: { provider: 'gemini' },
    key: { provider: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' },
    models: ['gemini-3-pro', 'gemini-3-flash'],
    keysAt: 'aistudio.google.com',
    modelsApi: { url: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'query' },
  },
  xai: {
    label: 'xAI',
    // Two different CLIs, chosen by how you authenticate rather than by asking.
    login: { provider: 'grok' },
    key: { provider: 'codex', preset: 'grok', baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY' },
    models: ['grok-4', 'grok-4-fast'],
    keysAt: 'console.x.ai',
    modelsApi: { url: 'https://api.x.ai/v1/models', auth: 'bearer' },
  },
  moonshot: {
    label: 'Moonshot',
    key: { provider: 'claude', preset: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', apiKeyEnv: 'MOONSHOT_API_KEY' },
    models: ['kimi-k2-turbo-preview'],
    keysAt: 'platform.moonshot.ai',
    modelsApi: { url: 'https://api.moonshot.ai/v1/models', auth: 'bearer' },
  },
  zhipu: {
    label: 'Zhipu',
    key: { provider: 'claude', preset: 'glm', baseUrl: 'https://api.z.ai/api/anthropic', apiKeyEnv: 'ZAI_API_KEY' },
    models: ['glm-4.6'],
    keysAt: 'z.ai',
  },
};

/**
 * Which company an agent is currently set to, worked out backwards from the
 * fields the config actually stores. Anything unrecognised is "other" rather
 * than being quietly relabelled as the first vendor in the list.
 */
export function vendorOf(agent = {}) {
  if (agent.preset) {
    const byPreset = Object.entries(VENDORS).find(([, v]) => v.key?.preset === agent.preset);
    if (byPreset) return byPreset[0];
  }
  if (agent.baseUrl) {
    const byUrl = Object.entries(VENDORS).find(([, v]) => v.key?.baseUrl === agent.baseUrl);
    if (byUrl) return byUrl[0];
    return 'other';
  }
  const byCli = Object.entries(VENDORS).find(([, v]) => v.login?.provider === agent.provider);
  return byCli ? byCli[0] : 'other';
}

/**
 * What a company plus an auth mode means in config terms.
 *
 * `auto` resolves like `login` where the vendor has its own CLI, because that
 * is what "whatever this machine has" means for a vendor whose CLI can sign in.
 * For a company reachable only by key, there is nothing to be ambiguous about.
 */
export function vendorConfig(vendorId, authMode = 'auto') {
  const v = VENDORS[vendorId];
  if (!v) return null;
  const wantsKey = authMode === 'key' || !v.login;
  const chosen = wantsKey ? v.key : (v.login || v.key);
  if (!chosen) return null;
  return {
    provider: chosen.provider,
    preset: chosen.preset || '',
    baseUrl: chosen.baseUrl || '',
    apiKeyEnv: chosen.apiKeyEnv || '',
  };
}

/** The companies worth offering, given which adapters this studio has. */
export function vendorList(knownProviders = []) {
  const out = [];
  for (const [id, v] of Object.entries(VENDORS)) {
    const reachable = [v.login?.provider, v.key?.provider].filter(Boolean)
      .some((p) => knownProviders.includes(p));
    if (!reachable) continue;
    out.push({
      id,
      label: v.label,
      models: v.models || [],
      keysAt: v.keysAt || '',
      // Whether this company can be used without a key at all, which decides
      // whether "this machine's login" is even offered for it.
      canLogin: Boolean(v.login && knownProviders.includes(v.login.provider)),
      canKey: Boolean(v.key && knownProviders.includes(v.key.provider)),
      loginCli: v.login?.provider || '',
      keyCli: v.key?.provider || '',
      // So the panel can work out which company an agent already is, from the
      // fields the config stores, without a second source of truth.
      keyPreset: v.key?.preset || '',
      keyBaseUrl: v.key?.baseUrl || '',
      keyVar: v.key?.apiKeyEnv || '',
      // Whether this company will tell us what it currently serves, given a
      // key. Zhipu is absent on purpose: its endpoint was not verified, and a
      // list that silently fails is worse than one that was never offered.
      canListModels: Boolean(v.modelsApi),
    });
  }
  out.push({
    id: 'other',
    label: 'Other',
    models: [],
    keysAt: '',
    canLogin: true,
    canKey: true,
    loginCli: '',
    keyCli: '',
    keyPreset: '',
    keyBaseUrl: '',
    keyVar: '',
  });
  return out;
}

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
  gemini: { permissionMode: 'auto', model: '' },
};

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function defaultConfig() {
  return {
    project: {
      name: path.basename(PROJECT_ROOT),
      brief: 'PROJECT.md',
      goal: '',
      // Empty means the whole project, which is what a studio pointed at a
      // repository wants. Set it when the thing being built is one directory
      // inside something larger — see workDir handling below.
      workDir: '',
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

  // Start from what the file said, not from a blank slate.
  //
  // This used to build a fresh defaultConfig() and copy across only the four
  // keys it knew about, so every other top-level key was silently discarded.
  // That killed `adapters` — the whole pluggable-provider feature was dead on
  // arrival because CONFIG.adapters was always undefined — and then killed
  // `prices` the same way the moment token costing was added. Whitelisting the
  // next key would only postpone the third occurrence. Unknown keys now survive,
  // and the sections below overwrite the ones this module actually owns.
  const cfg = { ...legacy, ...defaultConfig() };

  cfg.project = { ...cfg.project, ...(legacy.project || {}) };
  cfg.runner = { ...cfg.runner, ...(legacy.runner || {}) };
  cfg.server = { ...cfg.server, ...(legacy.server || {}) };

  const list = Array.isArray(legacy.agents) && legacy.agents.length
    ? legacy.agents
    : DEFAULT_AGENTS;

  const seen = new Set();
  cfg.agents = list.map((entry, i) => {
    const a = applyPreset(typeof entry === 'string' ? { id: entry } : { ...entry });
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
      ...(a.preset ? { preset: a.preset } : {}),
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
  for (const k of [
    'model', 'sandbox', 'permissionMode', 'disableMcp',
    'baseUrl', 'apiKeyEnv', 'apiKey', 'auth', 'wireApi',
    'command', 'extraArgs', 'env',
  ]) {
    if (a[k] !== undefined) out[k] = a[k];
  }
  return out;
}

function resolvePersona(persona, provider) {
  if (!persona) {
    const fallback = { codex: 'implementer', claude: 'architect', grok: 'adversary', gemini: 'researcher' }[provider];
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
export const AGENT_EDITABLE = ['id', 'provider', 'label', 'persona', 'preset'];
export const AGENT_EDITABLE_OPTIONS = [
  'model', 'sandbox', 'permissionMode', 'disableMcp',
  // Where to send the requests, and how to authenticate.
  //
  // Unlike `env` these are safe for the settings panel: they are data an
  // adapter turns into the two variables its CLI reads, not arbitrary
  // environment. `NODE_OPTIONS` changes what code runs; a base URL does not.
  'baseUrl', 'apiKeyEnv',
  // Which of those an agent actually uses. Declared rather than inferred: an
  // agent set to `login` has its key variables cleared before the CLI starts,
  // so the mode is a choice instead of a label over whatever happened to be in
  // the environment.
  'auth',
];
export const AGENT_PROTECTED_OPTIONS = ['command', 'extraArgs', 'env'];

/**
 * Refused for a different reason than the list above.
 *
 * `apiKey` does not decide what program runs — it is a secret, and accepting it
 * here writes the literal key into `studio_floor/config.json`, a file the layout
 * treats as the roster and worth committing. Committing a key is how keys leak.
 *
 * `apiKeyEnv` does the same job by naming an environment variable, so nothing
 * is lost by refusing this one, and the settings panel never sends it anyway.
 * A key already written into the file by hand keeps working and is carried
 * across saves untouched — this refuses a new one arriving over HTTP.
 */
export const AGENT_SECRET_OPTIONS = ['apiKey'];
export const RUNNER_EDITABLE = [
  'maxTurns', 'maxWallMs', 'maxSpendUsd',
  'turnTimeoutMs', 'cooldownMs', 'staggerMs', 'commandLineBudget', 'idleBackoffMs',
];
export const PROJECT_EDITABLE = ['name', 'goal', 'brief', 'workDir'];

/**
 * The directory the agents actually run in.
 *
 * Every vendor CLI scopes its sandbox to its working directory — codex's
 * `workspace-write`, Claude Code's edit permissions, grok's sandbox — so this
 * is the one lever that decides what a team can touch, and it was always the
 * whole project.
 *
 * That is wrong whenever the project contains the studio as well as the thing
 * being built. Studio Floor's own team builds in `test_project/` inside the
 * studio's repository, and with no work directory their sandbox included the
 * tool they were running on: agents editing the runner mid-turn, which is
 * exactly as confusing as it sounds.
 *
 * Resolved here rather than at each call site so that "inside the project" is
 * enforced once. A work directory that escapes is refused rather than clamped,
 * because silently working somewhere other than where you were told to is the
 * failure this whole file keeps guarding against.
 */
export function resolveWorkDir(workDir, projectRoot = PROJECT_ROOT) {
  const want = typeof workDir === 'string' ? workDir.trim() : '';
  if (!want) return { path: projectRoot, relative: '', scoped: false };

  const resolved = path.resolve(projectRoot, want);
  const inside = resolved === projectRoot
    || resolved.startsWith(projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep);
  if (!inside) {
    return {
      path: projectRoot,
      relative: '',
      scoped: false,
      problem: `project.workDir "${want}" resolves outside the project, so it is being ignored`,
    };
  }
  return {
    path: resolved,
    // Reported with forward slashes whatever the platform: this string goes
    // into prompts and a Windows path with backslashes in one reads as escapes.
    relative: path.relative(projectRoot, resolved).split(path.sep).join('/'),
    scoped: resolved !== projectRoot,
    exists: fs.existsSync(resolved),
  };
}

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
  maxWallMs: [0, 30 * 24 * 60 * 60 * 1000],
  maxSpendUsd: [0, 100_000],
  turnTimeoutMs: [10_000, 24 * 60 * 60 * 1000],
  cooldownMs: [0, 10 * 60 * 1000],
  staggerMs: [0, 10 * 60 * 1000],
  commandLineBudget: [2_000, 120_000],
};

const SANDBOXES = ['read-only', 'workspace-write', 'full'];
/**
 * What to do when the CLI wants approval for something.
 *
 * The first three all ask, in different amounts, and an agent running
 * non-interactively cannot be answered — it waits, gives up, and retries next
 * turn forever. That is not theoretical: this project's own studio sat in it
 * for ten turns with `auto`, unable even to report the problem, because the
 * studio CLI call it would have used was itself awaiting approval.
 *
 * So the two that never ask are offered as well. They are more dangerous and
 * they are the only ones that work unattended, which is a real trade and one
 * the human should get to make.
 */
const PERMISSION_MODES = ['default', 'auto', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan'];

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
      if (k === 'workDir' && v && (v.includes('..') || path.isAbsolute(v))) {
        // Same reasoning as the brief, with more teeth: this one decides where
        // the agents' sandbox is rooted, so a path that climbs out of the
        // project would hand them the rest of the disk.
        errors.push('project.workDir must be a directory inside the project');
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
        for (const k of [...AGENT_PROTECTED_OPTIONS, ...AGENT_SECRET_OPTIONS]) {
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
            if (k === 'baseUrl' && v) {
              // A base URL is where credentials get sent. An http:// endpoint
              // would put the key on the wire in clear, and a non-URL would
              // fail later inside the vendor CLI with a worse message.
              let u;
              try { u = new URL(String(v)); } catch { u = null; }
              if (!u) { errors.push(`agent #${i + 1}: baseUrl must be a URL`); continue; }
              if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
                errors.push(`agent #${i + 1}: baseUrl must be https (or localhost) — an API key must not travel in clear`);
                continue;
              }
            }
            if (k === 'apiKeyEnv' && v && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(v))) {
              errors.push(`agent #${i + 1}: apiKeyEnv must be an environment variable name`);
              continue;
            }
            if (k === 'auth' && v && !AUTH_MODES.includes(String(v))) {
              errors.push(`agent #${i + 1}: auth must be one of ${AUTH_MODES.join(', ')}`);
              continue;
            }
            if (v !== '' && v !== undefined && v !== null) agent[k] = v;
          } else if (AGENT_PROTECTED_OPTIONS.includes(k)) {
            errors.push(
              `agent #${i + 1}: "${k}" cannot be set from the settings panel — `
              + 'it decides what program runs, so it is editable only in the config file',
            );
          } else if (AGENT_SECRET_OPTIONS.includes(k)) {
            errors.push(
              `agent #${i + 1}: "${k}" cannot be set over HTTP — it would write the literal key `
              + 'into the config file. Use "apiKeyEnv" to name an environment variable instead',
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
export function configSchema({ knownProviders = [] } = {}) {
  return {
    // Companies, because that is what a human is choosing. Which CLI runs
    // falls out of the company plus how it authenticates.
    vendors: vendorList(knownProviders),
    authModes: AUTH_MODES,
    presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, {
      label: v.label, provider: v.provider, baseUrl: v.baseUrl, apiKeyEnv: v.apiKeyEnv, note: v.note,
    }])),
    personas: Object.keys(PERSONAS),
    sandboxes: SANDBOXES,
    permissionModes: PERMISSION_MODES,
    agentFields: [...AGENT_EDITABLE, ...AGENT_EDITABLE_OPTIONS],
    protectedFields: [...AGENT_PROTECTED_OPTIONS, ...AGENT_SECRET_OPTIONS],
    runnerFields: RUNNER_EDITABLE,
    projectFields: PROJECT_EDITABLE,
    liveFields: LIVE_FIELDS,
    bounds: NUMERIC_BOUNDS,
  };
}
