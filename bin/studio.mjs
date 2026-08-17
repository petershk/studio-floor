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
    await load(SRC, 'bin', 'start.mjs');
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

    studio init                 set up the current directory as a studio project
    studio start                run the server and the configured agents
    studio start --no-agents    run the server only
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
  const { CONFIG_FILE, PROJECT_ROOT } = await load(SRC, 'core', 'paths.mjs');
  const fs = await import('node:fs');

  if (Array.isArray(CONFIG.adapters) && CONFIG.adapters.length) {
    await loadUserAdapters(CONFIG.adapters);
  }

  let problems = 0;
  const fail = (msg) => { problems++; console.log(`  FAIL  ${msg}`); };
  const ok = (msg) => console.log(`  ok    ${msg}`);

  console.log(`\n  studio doctor — ${PROJECT_ROOT}\n`);
  console.log(`  config     ${fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : `${CONFIG_FILE} (absent — using defaults)`}`);
  console.log(`  providers  ${providers().join(', ')}\n`);

  const brief = path.resolve(PROJECT_ROOT, CONFIG.project.brief || 'PROJECT.md');
  if (fs.existsSync(brief)) ok(`project brief ${CONFIG.project.brief}`);
  else fail(`no project brief at ${CONFIG.project.brief} — agents will not know what to build`);

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
      // One string, not an args array: on Windows these CLIs are .cmd shims
      // that need a shell, and shell + args array concatenates unescaped
      // (DEP0190). The command is quoted so a path with spaces still works.
      const line = [`"${cmd}"`, ...(adapter.versionArgs || ['--version'])].join(' ');
      const probe = spawnSync(line, { encoding: 'utf8', shell: true, timeout: 15_000 });
      const found = probe.status === 0;
      seen.set(cmd, { found, version: (probe.stdout || probe.stderr || '').trim().split('\n')[0] });
    }
    const r = seen.get(cmd);
    if (r.found) ok(`${a.id} → ${a.provider} (${cmd}${r.version ? ` — ${r.version}` : ''})`);
    else fail(`${a.id} → ${a.provider}: "${cmd}" is not installed or not on PATH`);
  }

  console.log(problems
    ? `\n  ${problems} problem(s). The studio will start, but those agents cannot run.\n`
    : '\n  ready\n');
  process.exitCode = problems ? 1 : 0;
}
