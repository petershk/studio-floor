#!/usr/bin/env node
/**
 * The studio's front door.
 *
 *   studio init [--project DIR]        write a starter config and PROJECT.md
 *   studio start [--project DIR]       run the server and the agents
 *   studio doctor                      check that the configured CLIs exist
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

const TEMPLATE_BRIEF = `# {{name}}

<!--
  This file is the authority on what the team builds. Every agent reads it in
  full on its first turn, and it outranks anything else it is told.

  Write it for a competent colleague who has never seen the project. Be specific
  about what "done" looks like, and explicit about the decisions you have already
  made so the team does not spend a debate rediscovering them.
-->

## Goal

Describe what you want built, and why.

## What done looks like

- A concrete, checkable outcome.
- Another one.

## Constraints

- Languages, frameworks, or services that are required or forbidden.
- Anything the agents must not touch.

## Decisions already made

- Things that are settled. The team should not reopen these without new information.

## Open questions

- Things you genuinely have not decided. The team should debate these and
  escalate to you rather than guessing.
`;

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
    studio agent <cmd>          the in-turn CLI agents use to talk to the studio

  Options

    --project DIR, -C DIR       operate on DIR instead of the current directory

  Environment

    STUDIO_PROJECT_ROOT   the project the agents work in
    STUDIO_CONFIG         path to studio.config.json
    STUDIO_STATE_DIR      where the event log lives (default <project>/.studio)
    STUDIO_PORT           default 4173
    STUDIO_HOST           default 127.0.0.1; set 0.0.0.0 to expose it
    STUDIO_TOKEN          required by every API route when set
`);
}

async function init() {
  const fs = await import('node:fs');
  const { PROJECT_ROOT, CONFIG_FILE } = await load(SRC, 'core', 'paths.mjs');
  const { defaultConfig, writeConfig } = await load(SRC, 'core', 'config.mjs');

  const cfg = defaultConfig();
  const { written, file } = writeConfig(CONFIG_FILE, cfg);
  console.log(written ? `  created  ${file}` : `  kept     ${file} (already exists)`);

  const briefPath = path.join(PROJECT_ROOT, cfg.project.brief);
  if (!fs.existsSync(briefPath)) {
    fs.writeFileSync(briefPath, TEMPLATE_BRIEF.replace('{{name}}', cfg.project.name));
    console.log(`  created  ${briefPath}`);
  } else {
    console.log(`  kept     ${briefPath} (already exists)`);
  }

  console.log(`
  Next:
    1. Write what you actually want built into ${cfg.project.brief}.
       The agents read it first and it is the authority on the project.
    2. Edit studio.config.json to set your roster.
    3. studio doctor
    4. studio start
`);
}

async function doctor() {
  const { spawnSync } = await import('node:child_process');
  const { CONFIG, AGENTS } = await load(SRC, 'core', 'roster.mjs');
  const { getAdapter, loadUserAdapters, providers } = await load(SRC, 'agents', 'adapters', 'index.mjs');
  const { resolveLaunch } = await load(SRC, 'agents', 'launch.mjs');
  const { CONFIG_FILE, PROJECT_ROOT } = await load(SRC, 'core', 'paths.mjs');
  const { isUntouchedBrief } = await load(SRC, 'core', 'projects.mjs');
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

  if (!fs.existsSync(brief)) {
    fail(`no project brief at ${brief} — agents will not know what to build`, 'brief');
  } else if (isUntouchedBrief(fs.readFileSync(brief, 'utf8'))) {
    fail(`project brief ${brief} is still the studio init template — write what you actually want built`, 'brief');
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
  }

  if (!problems) {
    console.log('\n  ready\n');
  } else {
    const bits = [];
    if (briefProblems) bits.push('the team has no written brief');
    if (agentProblems) bits.push('those agents cannot run');
    console.log(`\n  ${problems} problem(s). The studio will start, but ${bits.join(', and ')}.\n`);
  }
  process.exitCode = problems ? 1 : 0;
}
