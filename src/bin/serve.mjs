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
import {
  PORT, HOST, PROJECT_ROOT, STATE_DIR, CONFIG_FILE, IS_LEGACY_LAYOUT, EXIT_SWITCH, EXIT_REFUSED,
} from '../core/paths.mjs';
import { startHeartbeat } from '../core/heartbeat.mjs';
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
    // Refused rather than failed: the supervisor must not spend its restart
    // budget on a typo that will read exactly the same way next time.
    process.exit(EXIT_REFUSED);
  }
  config.agents = wanted;
}

const token = process.env.STUDIO_TOKEN || CONFIG.server.token || null;
const TOKEN_HINT = token
  ? '     (this studio needs its token: append ?token=… to that URL)\n'
  : '';

const store = new Store();
const runner = new Runner(store, config);
await bound(createHttpServer(store, runner));

// Presence is runtime-derived. A prior hard stop may have left the final
// persisted state as working/waiting even though no process survived.
for (const id of AGENT_IDS) {
  if (store.state.agents[id]?.state !== 'offline') {
    store.append('agent.stopped', id, { reason: 'studio restarted; no supervised worker is running yet' });
  }
}

// The supervisor cannot write to the log — the studio owns it, and the studio
// was dead at the moment worth recording. So it hands the story to the process
// it starts instead, and the gap in the feed comes with its own explanation.
if (process.env.STUDIO_RECOVERED) {
  try {
    store.append('studio.recovered', null, JSON.parse(process.env.STUDIO_RECOVERED));
  } catch { /* a malformed hand-off must not stop the studio coming back */ }
}

store.append('studio.started', null, {
  projectRoot: PROJECT_ROOT,
  project: PROJECT.name,
  agents: config.agents,
  agentsAutoStarted: !noAgents,
});

const watchHost = HOST === '0.0.0.0' ? '<this-host>' : HOST;
const watchUrl = `http://${watchHost}:${PORT}`;

/**
 * Leave proof of life somewhere that outlives this process.
 *
 * `studio status` reads it, the supervisor reads it, and neither of them can
 * ask a dead studio how it is. The exit handler runs on every way out this
 * process has — Ctrl-C, a project switch, an uncaught throw — so the mark is
 * stamped with which one it was, and only a SIGKILL leaves it merely stale.
 */
const stopHeartbeat = startHeartbeat({
  snapshot: () => ({
    project: PROJECT_ROOT,
    url: watchUrl,
    seq: store.seq,
    agents: Object.fromEntries(AGENT_IDS.map((id) => [id, store.state.agents[id]?.state || 'offline'])),
  }),
});
process.on('exit', (code) => {
  if (code === EXIT_SWITCH) stopHeartbeat('switching project', null);
  else if (code) stopHeartbeat(`exited with code ${code}`, code);
  else stopHeartbeat('shut down', 0);
});

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
 * Wait until the port is actually ours.
 *
 * `listen` reports failure asynchronously, so without this the studio printed
 * its banner, opened a browser tab and only then died on an unhandled 'error'
 * event — a raw Node stack under a message that had just said "Open
 * http://…:4173". The human saw a confident launch and a tab that sat on
 * "connecting…" forever, with the reason scrolled off under the banner.
 *
 * Nothing below this line runs until the socket is bound, so the banner is a
 * statement of fact rather than an intention.
 */
function bound(server) {
  return new Promise((resolve) => {
    server.once('listening', resolve);
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `\n  studio: ${HOST}:${PORT} is already in use.\n\n`
          + '          Another studio is probably still running — open the URL to check,\n'
          + '          or stop it and start again. A studio that was just stopped can hold\n'
          + '          the port for a moment longer than it holds the terminal.\n\n'
          + '          STUDIO_PORT=4174 studio start   runs a second one alongside it.\n',
        );
      } else if (err.code === 'EACCES') {
        console.error(`\n  studio: not allowed to bind ${HOST}:${PORT} — try a port above 1024.\n`);
      } else {
        console.error(`\n  studio: could not start the server — ${err.message}\n`);
        process.exit(1);
      }
      // A taken port and a forbidden one are both settled facts. Restarting
      // into them would bury the message above under five more copies of
      // itself, which is the opposite of what the restart is for.
      process.exit(EXIT_REFUSED);
    });
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
