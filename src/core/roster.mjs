import { loadConfig, resolveWorkDir, agentReadiness } from './config.mjs';
import { confinement, confinementPlan, isShared } from './confine.mjs';

/**
 * The resolved team, loaded once per process.
 *
 * Every module that used to import the `AGENT_IDS` constant reads this instead.
 * It is deliberately import-time and synchronous: the roster is a fact about
 * this studio that cannot change while it is running, and making it async would
 * push a `await getRoster()` into the store constructor, the event describer and
 * the CLI argument parser for no gain.
 *
 * `--only` and per-agent stop/start narrow which agents the *runner supervises*.
 * They do not narrow the roster: the store still projects every configured
 * agent, and the server still accepts messages addressed to one that is not
 * currently running. An agent that is stopped should look stopped, not vanish.
 */
export const CONFIG = loadConfig();

/** The full roster, in configured order. */
export const AGENTS = CONFIG.agents;

/** Ids only — the shape the rest of the studio historically expected. */
export const AGENT_IDS = AGENTS.map((a) => a.id);

const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));

export function getAgent(id) {
  return BY_ID.get(id) || null;
}

export function isAgent(id) {
  return BY_ID.has(id);
}

/** Runner settings, already merged with defaults. */
export const RUNNER = CONFIG.runner;

/** Server settings, already merged with defaults. */
export const SERVER = CONFIG.server;

/** What the team is here to do. */
export const PROJECT = CONFIG.project;

/**
 * Where the agents actually run.
 *
 * Resolved once, beside the roster, because the runner, the prompts, doctor and
 * the panel must all agree about it — and because "the directory the team can
 * write in" is not a thing to work out twice.
 */
export const WORK_DIR = resolveWorkDir(CONFIG.project?.workDir);

/**
 * Whether the operating system, not just the prompt, keeps agents inside that
 * directory — and on a shared studio, whether they may run without it.
 */
export const CONFINEMENT = confinement({
  mode: CONFIG.security?.confineAgents,
  userName: CONFIG.security?.agentUser,
  workDir: WORK_DIR.path,
  shared: isShared({
    host: process.env.STUDIO_HOST || CONFIG.server?.host,
    token: process.env.STUDIO_TOKEN || CONFIG.server?.token,
  }),
});

/** What confinement will change on disk, for the banner, doctor and the panel. */
export const CONFINEMENT_PLAN = CONFINEMENT.confined
  ? confinementPlan({ user: CONFINEMENT.user, workDir: WORK_DIR.path })
  : [];

/**
 * Whether agents may run at all, and if not, why. `ready: false` holds every
 * agent idle: the server still runs, so the human can fix what is wrong.
 *
 * Two gates, one answer. A work directory nobody chose holds the team; so does
 * a shared studio that cannot make that directory a boundary.
 */
export const AGENTS_READY = (() => {
  const dir = agentReadiness(WORK_DIR);
  if (!dir.ready) return dir;
  if (!CONFINEMENT.ready) return { ready: false, reason: CONFINEMENT.held };
  return dir;
})();
