#!/usr/bin/env node
/**
 * One studio: the event log, the server the human watches, and the agents.
 *
 * Started by src/bin/supervise.mjs rather than directly, because this process is
 * bound to one project — PROJECT_ROOT is resolved at import and the store
 * replays that project's log on the way up. Switching projects means replacing
 * this process, which is the supervisor's job.
 *
 *   studio start                    server + every configured agent
 *   studio start --no-agents        server only; start agents from the UI
 *   studio start --only claude      server + one agent
 *   studio start --project ../game  operate on a different directory
 */
import * as childProcess from 'node:child_process';
import { Store } from '../core/store.mjs';
import { createHttpServer } from '../server/server.mjs';
import { Runner, loadConfig } from '../agents/runner.mjs';
import { loadUserAdapters, providers } from '../agents/adapters/index.mjs';
import { PORT, HOST, PROJECT_ROOT, STATE_DIR, CONFIG_FILE, IS_LEGACY_LAYOUT } from '../core/paths.mjs';
import { AGENT_IDS, AGENTS, CONFIG, PROJECT } from '../core/roster.mjs';

const argv = process.argv.slice(2);
const noAgents = argv.includes('--no-agents');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx > -1 ? argv[onlyIdx + 1] : null;

// Adapters the project supplies must be registered before the Runner resolves
// providers, or a perfectly valid config would be rejected as unknown.
if (Array.isArray(CONFIG.adapters) && CONFIG.adapters.length) {
  await loadUserAdapters(CONFIG.adapters);
}

const config = loadConfig();
if (only) {
  const wanted = only.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !AGENT_IDS.includes(id));
  if (unknown.length) {
    console.error(
      `studio: --only names ${unknown.join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not in the roster.\n`
      + `        This studio is ${AGENT_IDS.join(', ')} (from ${CONFIG_FILE}).`,
    );
    process.exit(1);
  }
  config.agents = wanted;
}

const token = process.env.STUDIO_TOKEN || CONFIG.server.token || null;
const TOKEN_HINT = token
  ? '     (this studio needs its token: append ?token=… to that URL)\n'
  : '';

const store = new Store();
const runner = new Runner(store, config);
createHttpServer(store, runner);

// Presence is runtime-derived. A prior hard stop may have left the final
// persisted state as working/waiting even though no process survived.
for (const id of AGENT_IDS) {
  if (store.state.agents[id]?.state !== 'offline') {
    store.append('agent.stopped', id, { reason: 'studio restarted; no supervised worker is running yet' });
  }
}

store.append('studio.started', null, {
  projectRoot: PROJECT_ROOT,
  project: PROJECT.name,
  agents: config.agents,
  agentsAutoStarted: !noAgents,
});

const watchHost = HOST === '0.0.0.0' ? '<this-host>' : HOST;
const watchUrl = `http://${watchHost}:${PORT}`;

console.log(`
  Studio Floor — ${PROJECT.name || 'untitled project'}
  ${'-'.repeat(Math.max(14, (PROJECT.name || 'untitled project').length + 15))}
  project    ${PROJECT_ROOT}
  config     ${CONFIG_FILE}${IS_LEGACY_LAYOUT ? '   (legacy layout)' : ''}
  state      ${STATE_DIR}
  providers  ${providers().join(', ')}
  roster     ${AGENTS.map((a) => `${a.id}(${a.provider})`).join(', ')}
  running    ${noAgents ? '(none — start them from the web UI)' : config.agents.join(', ')}

  ▸  Open ${watchUrl}
${TOKEN_HINT}     Ctrl-C to stop. Nothing is lost — the studio rebuilds from its log.
`);

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !(process.env.STUDIO_TOKEN || CONFIG.server.token)) {
  console.warn(
    '  WARNING: this studio is bound to a non-loopback address with no token.\n'
    + '  Anyone who can reach it can direct agents that run shell commands as you.\n'
    + '  Set STUDIO_TOKEN before exposing it.\n',
  );
}

// Open a browser, unless told not to and unless this is the supervisor putting
// us back after a project switch or an update — those already have a tab open,
// and stacking a new one on every restart would be a nuisture rather than a
// convenience.
if (!argv.includes('--no-open') && !process.env.STUDIO_RESTARTED && HOST !== '0.0.0.0') {
  console.log('     opening your browser… (studio start --no-open to skip)');
  openInBrowser(token ? `${watchUrl}/?token=${encodeURIComponent(token)}` : watchUrl);
} else if (process.env.STUDIO_RESTARTED) {
  console.log('     your existing browser tab will reconnect on its own.');
}

if (!noAgents) runner.startAll();

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log('\n  stopping agents…');
    await runner.stopAll('studio shut down');
    setTimeout(() => {
      // Every append already fsyncs, so nothing is at risk here — this is the
      // same handle discipline the tests need, kept in one place so the log is
      // never left open by a process that has finished with it.
      store.close();
      process.exit(0);
    }, 500);
  });
}

/**
 * Open the studio in the default browser.
 *
 * Best-effort and deliberately silent on failure: over SSH, in a container, or
 * on a headless box there is no browser to open, and that is not a reason to
 * make the studio look like it went wrong. The URL is printed either way, which
 * is the part that actually matters.
 */
function openInBrowser(url) {
  const { spawn } = childProcess;
  try {
    const [cmd, args] = process.platform === 'win32'
      // `start` is a cmd builtin, and its first quoted argument is the window
      // title — omitting the empty one makes cmd treat the URL as the title and
      // open nothing.
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => { /* no browser here; the printed URL stands */ });
    child.unref();
  } catch { /* same */ }
}
