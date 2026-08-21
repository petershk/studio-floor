#!/usr/bin/env node
/**
 * The studio's front door.
 *
 *   studio init [--project DIR]        write a starter config and PROJECT.md
 *   studio start [--project DIR]       run the server and the agents
 *   studio doctor                      check that the configured CLIs exist
 *   studio status                      is a studio running here, and since when
 *   studio clone <url>                 clone a repository into the workspace
 *   studio agent <command> ...         the in-turn agent CLI (agents use this)
 *
 * `--project` is handled here, before anything from src/core is imported,
 * because the path module resolves the project root at import time. Parsing it
 * later would leave half the process pointing at the wrong directory — the kind
 * of split-brain failure that is very hard to see and very easy to cause.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

/**
 * Dynamic import of an absolute path.
 *
 * On Windows `import('C:\...')` is rejected outright — node reads the drive
 * letter as a URL scheme — so every internal import here goes through a file://
 * URL. Nothing about this is optional on the platform most of these agents run
 * on.
 */
const load = (...segments) => import(pathToFileURL(path.join(...segments)).href);


const argv = process.argv.slice(2);
const projectIdx = argv.findIndex((a) => a === '--project' || a === '-C');
if (projectIdx > -1) {
  const dir = argv[projectIdx + 1];
  if (!dir) {
    console.error('studio: --project needs a directory');
    process.exit(1);
  }
  process.env.STUDIO_PROJECT_ROOT = path.resolve(dir);
  argv.splice(projectIdx, 2);
}

const command = argv[0] || 'help';
process.argv = [process.argv[0], process.argv[1], ...argv.slice(1)];

switch (command) {
  case 'start':
    process.argv = [process.argv[0], process.argv[1], ...argv.slice(1)];
    await load(SRC, 'bin', 'supervise.mjs');
    break;

  case 'init':
    await init();
    break;

  case 'doctor':
    await doctor();
    break;

  case 'status':
    await status();
    break;

  case 'clone':
    await clone();
    break;

  case 'agent':
    await load(SRC, 'cli', 'studio.mjs');
    break;

  case 'help':
  case '--help':
  case '-h':
    usage();
    break;

  case 'version':
  case '--version':
  case '-v': {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
    console.log(pkg.version);
    break;
  }

  default:
    console.error(`studio: unknown command "${command}"\n`);
    usage();
    process.exit(1);
}

function usage() {
  console.log(`
  Studio Floor — several AI coding agents working as a team on one project,
  with a human watching and directing through a browser.

    studio init                 write a starter brief and config here (optional —
                                the studio can also discover an existing project)
    studio start                run the server and the configured agents
    studio start --no-agents    run the server only
    studio start --no-open      do not open a browser
    studio start --only claude  run one agent
    studio doctor               check the configured provider CLIs are installed
    studio status               is a studio running here — and if not, when it stopped
    studio clone <url>          clone a repository into the workspace and work on it
    studio agent <cmd>          the in-turn CLI agents use to talk to the studio

  Options

    --project DIR, -C DIR       operate on DIR instead of the current directory

  Environment

    STUDIO_PROJECT_ROOT   the project the agents work in
    STUDIO_CONFIG         path to studio.config.json
    STUDIO_STATE_DIR      where the event log lives (default <project>/.studio)
    STUDIO_WORKSPACE      where "studio clone" puts repositories
    STUDIO_GIT_TOKEN      credentials for cloning and pushing private repositories
    STUDIO_PORT           default 4173
    STUDIO_HOST           default 127.0.0.1; set 0.0.0.0 to expose it
    STUDIO_TOKEN          required by every API route when set
`);
}

async function init() {
  const { PROJECT_ROOT } = await load(SRC, 'core', 'paths.mjs');
  const { initProject } = await load(SRC, 'core', 'scaffold.mjs');
  const { defaultConfig } = await load(SRC, 'core', 'config.mjs');

  const cfg = defaultConfig();
  const r = initProject(PROJECT_ROOT, { name: cfg.project.name });
  if (!r.ok) {
    console.error(`studio: ${r.error}`);
    process.exit(1);
  }
  for (const f of r.created) console.log(`  created  ${f}`);
  if (!r.created.length) console.log('  kept     everything that was already here');

  console.log(`
  Next:
    1. Write what you actually want built into ${cfg.project.brief}.
       The agents read it first and it is the authority on the project.
    2. Edit studio.config.json to set your roster.
    3. studio doctor
    4. studio start
`);
}

/**
 * Is a studio running here?
 *
 * Deliberately does not open the event log or the store: this has to work when
 * the studio is dead, has to be cheap enough for a cron line, and replaying a
 * 18,000-event log to answer "is it up" would be its own reason not to run it.
 * Everything it prints comes from the heartbeat file the studio leaves behind.
 *
 * Exits 0 when a studio is running and 1 when it is not, so a shell can ask.
 */
async function status() {
  const { readBeat, describeBeat } = await load(SRC, 'core', 'heartbeat.mjs');
  const { RUNTIME_FILE, STATE_DIR, PROJECT_ROOT } = await load(SRC, 'core', 'paths.mjs');

  const beat = readBeat(RUNTIME_FILE);
  const { state, headline, detail } = describeBeat(beat);
  const width = Math.max(0, ...detail.map(([label]) => label.length));

  console.log(`\n  ${headline}\n`);
  for (const [label, value] of detail) console.log(`  ${label.padEnd(width)}   ${value}`);
  if (!beat) {
    console.log(`  project    ${PROJECT_ROOT}`);
    console.log(`  state      ${STATE_DIR}`);
    console.log('\n  studio start   to run one here');
  } else if (state !== 'running') {
    console.log('\n  studio start   to bring it back. Nothing is lost — it rebuilds from its log.');
  }
  console.log('');
  process.exit(state === 'running' ? 0 : 1);
}

/**
 * Put a repository on this machine and tell the human what to do with it.
 *
 * Deliberately does not start or switch anything. A studio already running is
 * a process bound to one project, and reaching in from a second process to
 * re-point it is the supervisor's job, not this one's — the UI's Clone button
 * goes through the API for exactly that reason. From a shell, the useful
 * answer is the path and the one command that opens it.
 */
async function clone() {
  const { parseRemote, checkName, cloneRepo, WORKSPACE_DIR } = await load(SRC, 'core', 'clone.mjs');
  const { inspect } = await load(SRC, 'core', 'projects.mjs');
  const { ensureGitIdentity } = await load(SRC, 'core', 'git.mjs');

  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };
  const url = args.find((a) => !a.startsWith('--') && a !== flag('into') && a !== flag('name') && a !== flag('depth'));

  if (!url) {
    console.error('studio: which repository?\n\n  studio clone <url> [--into DIR] [--name NAME] [--depth 1]\n');
    process.exit(1);
  }

  // A human at a shell can already clone anything they like, so a local path is
  // allowed here. The HTTP route does not pass this.
  const remote = parseRemote(url, { allowLocal: true });
  if (!remote.ok) {
    console.error(`studio: ${remote.error}\n`);
    process.exit(1);
  }

  const into = flag('into') ? path.resolve(flag('into')) : WORKSPACE_DIR;
  const name = flag('name') || remote.name;
  const nameProblem = checkName(name);
  if (nameProblem) {
    console.error(`studio: ${nameProblem}\n`);
    process.exit(1);
  }

  const credentials = ensureGitIdentity();
  console.log(`\n  cloning ${remote.url}`);
  console.log(`     into ${path.join(into, name)}`);
  if (credentials.token) console.log(`    using ${credentials.tokenFrom}`);
  console.log('');

  const res = await cloneRepo({ url: remote.url, into, name, depth: Number(flag('depth')) || 0 });
  if (!res.ok) {
    console.error(`  studio: ${res.error}\n`);
    process.exit(1);
  }

  const info = inspect(res.path);
  console.log(`  cloned  ${res.path}`);
  console.log(`          ${info.entries} item(s)${info.hasBrief ? ', has a brief' : ', no brief — the team will read it and draft one'}`);
  console.log(`\n  studio start --project ${res.path}\n`);
}

async function doctor() {
  const { spawnSync } = await import('node:child_process');
  const { CONFIG, AGENTS } = await load(SRC, 'core', 'roster.mjs');
  const { getAdapter, loadUserAdapters, providers } = await load(SRC, 'agents', 'adapters', 'index.mjs');
  const { resolveLaunch } = await load(SRC, 'agents', 'launch.mjs');
  const { resolveAuth } = await load(SRC, 'core', 'auth.mjs');
  const { CONFIG_FILE, PROJECT_ROOT } = await load(SRC, 'core', 'paths.mjs');
  const { isUntouchedBrief, isInferredBrief } = await load(SRC, 'core', 'projects.mjs');
  const fs = await import('node:fs');

  if (Array.isArray(CONFIG.adapters) && CONFIG.adapters.length) {
    await loadUserAdapters(CONFIG.adapters);
  }

  let problems = 0;
  let briefProblems = 0;
  let agentProblems = 0;
  const fail = (msg, kind = 'agent') => {
    problems++;
    if (kind === 'brief') briefProblems++;
    else agentProblems++;
    console.log(`  FAIL  ${msg}`);
  };
  const ok = (msg) => console.log(`  ok    ${msg}`);

  console.log(`\n  studio doctor — ${PROJECT_ROOT}\n`);
  console.log(`  config     ${fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : `${CONFIG_FILE} (absent — using defaults)`}`);

  const brief = path.resolve(PROJECT_ROOT, CONFIG.project.brief || 'PROJECT.md');
  console.log(`  brief      ${fs.existsSync(brief) ? brief : `${brief} (missing)`}`);
  // A second PROJECT.md next door is how this session lost the human's spec:
  // the editor wrote test_project/PROJECT.md while doctor and the runner
  // read ./PROJECT.md and called that the brief.
  const siblings = [];
  try {
    for (const ent of fs.readdirSync(PROJECT_ROOT, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'studio_floor') continue;
      const other = path.resolve(PROJECT_ROOT, ent.name, 'PROJECT.md');
      if (other !== brief && fs.existsSync(other)) siblings.push(other);
    }
  } catch { /* unreadable root is reported by the brief check below */ }
  if (siblings.length) {
    console.log(`  also saw   ${siblings.join(', ')} — not the brief this session will read`);
  }

  console.log(`  providers  ${providers().join(', ')}\n`);

  let inferredBrief = false;
  if (!fs.existsSync(brief)) {
    fail(`no project brief at ${brief} — agents will not know what to build`, 'brief');
  } else if (isUntouchedBrief(fs.readFileSync(brief, 'utf8'))) {
    fail(`project brief ${brief} is still the studio init template — write what you actually want built`, 'brief');
  } else if (isInferredBrief(fs.readFileSync(brief, 'utf8'))) {
    inferredBrief = true;
    ok(`project brief ${brief}`);
    console.log(`  note   ${brief} is marked inferred/draft — not a human spec`);
  } else {
    ok(`project brief ${brief}`);
  }

  // One probe per distinct executable, not per agent: five Claude agents share
  // one binary and five identical "not found" lines help nobody.
  const seen = new Map();
  for (const a of AGENTS) {
    const adapter = getAdapter(a.provider);
    if (!adapter) {
      fail(`agent ${a.id}: no adapter for provider "${a.provider}"`);
      continue;
    }
    const cmd = a.options?.command || adapter.command;
    if (!seen.has(cmd)) {
      // Probe exactly the way the runner launches, or doctor reports healthy for
      // an agent that cannot start. This used to shell out, which papered over the
      // .cmd problem the runner then hit for real.
      const r = resolveLaunch(cmd);
      if (r.error) {
        seen.set(cmd, { found: false, version: '', why: r.error });
      } else {
        const probe = spawnSync(r.command,
          [...(r.prefixArgs || []), ...(adapter.versionArgs || ['--version'])],
          { encoding: 'utf8', timeout: 20_000, windowsHide: true });
        seen.set(cmd, {
          found: probe.status === 0,
          version: (probe.stdout || probe.stderr || '').trim().split('\n')[0],
          via: r.via ? 'npm shim' : null,
        });
      }
    }
    const r = seen.get(cmd);
    if (r.found) ok(`${a.id} → ${a.provider} (${cmd}${r.version ? ` — ${r.version}` : ''})`);
    else fail(`${a.id} → ${a.provider}: "${cmd}" is not installed or not on PATH`);

    // Installed is not the same as able to run, and reporting only the first
    // has actively misled: on a fresh cloud box this said `ok claude` while
    // that agent answered every turn with "Not logged in · Please run /login".
    if (!r.found) continue;
    const auth = resolveAuth(a, adapter);
    if (auth.ok) console.log(`        auth: ${auth.detail}`);
    else fail(`${a.id} cannot authenticate — ${auth.detail}`);
    // The one case doctor genuinely cannot answer from here. A stored login is
    // a file this process is not going to open and a session that may have
    // expired, so it says which it is relying on rather than pretending to
    // have checked.
    if (auth.ok && auth.source === 'login') {
      console.log('        (not verified — only the CLI itself knows whether that login is still good)');
    }
  }

  if (!problems) {
    if (inferredBrief) {
      console.log('\n  ready — brief is an agent-inferred draft, not a human spec\n');
    } else {
      console.log('\n  ready\n');
    }
  } else {
    const bits = [];
    if (briefProblems) bits.push('the team has no written brief');
    if (agentProblems) bits.push('those agents cannot run');
    console.log(`\n  ${problems} problem(s). The studio will start, but ${bits.join(', and ')}.\n`);
  }
  process.exitCode = problems ? 1 : 0;
}
