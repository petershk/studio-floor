/**
 * Programmatic entry point.
 *
 * Everything the CLI does is available here, so a studio can be embedded — in a
 * cloud worker that supervises a project, in a test harness, or in a larger
 * tool that wants the collaboration loop without the launcher.
 */
export { Store } from './core/store.mjs';
export { createHttpServer } from './server/server.mjs';
export { Runner, loadConfig } from './agents/runner.mjs';
export { register, getAdapter, providers, loadUserAdapters, validate } from './agents/adapters/index.mjs';
export { parseAnthropicStream, clip, clipObj, opts } from './agents/adapters/shared.mjs';
export {
  loadConfig as loadStudioConfig,
  normaliseConfig,
  defaultConfig,
  writeConfig,
  PERSONAS,
} from './core/config.mjs';
export { CONFIG, AGENTS, AGENT_IDS, getAgent, isAgent, RUNNER, SERVER, PROJECT } from './core/roster.mjs';
export { EVENT_KINDS, AGENT_STATES, TASK_STATES, MESSAGE_KINDS, describe, isRaw, isTimeline } from './core/events.mjs';
export * as paths from './core/paths.mjs';
