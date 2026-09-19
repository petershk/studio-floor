#!/usr/bin/env node
/**
 * Does the boundary actually hold?
 *
 * test/confine.mjs asserts the decision and the plan against a fake filesystem,
 * which is all a CI runner can do: confinement needs root, and a claim about a
 * security boundary that has only ever been tested against a mock is a claim
 * nobody should trust. So this one does the real thing — creates an account,
 * applies the plan, spawns a process as that user, and checks what it can and
 * cannot open.
 *
 * It needs root on a POSIX host and it creates (then removes) a user account,
 * so it is not in `npm test`. Run it where the studio actually runs:
 *
 *   docker compose exec studio node /opt/studio-floor/test/confine-root.mjs
 *   sudo node test/confine-root.mjs
 *
 * It skips, rather than fails, anywhere it cannot do this honestly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const posix = process.platform !== 'win32';
const root = posix && typeof process.getuid === 'function' && process.getuid() === 0;

if (!root) {
  console.log('\nconfine-root — skipped: needs root on a POSIX host.');
  console.log('  This is the test that proves the boundary is real. Run it in the container:');
  console.log('    docker compose exec studio node /opt/studio-floor/test/confine-root.mjs\n');
  process.exit(0);
}

const { confinement, confinementPlan, applyConfinement } = await import('../src/core/confine.mjs');
const { agentEnv } = await import('../src/agents/child-env.mjs');

let failures = 0;
const firstLine = (s) => String(s || '').trim().split('\n')[0];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const USER = 'studio-confine-test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-confine-root-'));
const project = path.join(tmp, 'project');
const workDir = path.join(project, 'game');
const stateDir = path.join(project, 'studio_floor', 'state');
const configFile = path.join(project, 'studio_floor', 'config.json');
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'events.jsonl'), '{"seq":1,"kind":"studio.started"}\n');
fs.writeFileSync(configFile, '{"project":{"workDir":"game"}}\n');
fs.writeFileSync(path.join(workDir, 'main.js'), '// the thing being built\n');

console.log('\nconfine-root — the boundary, for real\n');

const existed = spawnSync('id', ['-u', USER], { encoding: 'utf8' }).status === 0;
if (!existed) {
  const made = spawnSync('useradd', ['--create-home', '--shell', '/bin/bash', USER], { encoding: 'utf8' });
  if (made.status !== 0) {
    console.log(`  cannot create a test account (${(made.stderr || '').trim()}) — skipping`);
    process.exit(0);
  }
}

try {
  const verdict = confinement({
    mode: 'require', userName: USER, workDir, shared: true, lookup: undefined,
  });
  check('a real root studio can confine', verdict.confined && verdict.ready, verdict.why || verdict.held);

  const applied = applyConfinement(confinementPlan({ user: verdict.user, workDir, stateDir, configFile }));
  check('the plan applies cleanly', applied.ok, applied.error);

  // What the agent's own process can do, run exactly as the runner runs it.
  const asAgent = (script) => spawnSync(process.execPath, ['-e', script], {
    uid: verdict.user.uid,
    gid: verdict.user.gid,
    env: agentEnv({ studio: { HOME: verdict.user.home } }),
    encoding: 'utf8',
    timeout: 20_000,
  });

  const who = asAgent('process.stdout.write(String(process.getuid()))');
  check('a turn runs as the agent user, not as the studio',
    who.stdout?.trim() === String(verdict.user.uid), `${who.stdout} ${who.stderr}`);

  const write = asAgent(`require('fs').writeFileSync(${JSON.stringify(path.join(workDir, 'built.txt'))}, 'work')`);
  check('it can write in its work directory', write.status === 0 && fs.existsSync(path.join(workDir, 'built.txt')),
    (write.stderr || '').trim());

  const readLog = asAgent(`require('fs').readFileSync(${JSON.stringify(path.join(stateDir, 'events.jsonl'))}, 'utf8')`);
  check('it cannot read the event log', readLog.status !== 0 && /EACCES|permission denied/i.test(readLog.stderr || ''),
    (readLog.stderr || '').trim().split('\n')[0]);

  const readConfig = asAgent(`require('fs').readFileSync(${JSON.stringify(configFile)}, 'utf8')`);
  check('it cannot read the config that decides what it may do',
    readConfig.status !== 0, (readConfig.stderr || '').trim().split('\n')[0]);

  const writeConfig = asAgent(`require('fs').writeFileSync(${JSON.stringify(configFile)}, '{}')`);
  check('and certainly cannot rewrite it', writeConfig.status !== 0);

  const listState = asAgent(`require('fs').readdirSync(${JSON.stringify(path.dirname(stateDir))})`);
  check('it cannot even list the studio\'s own folder', listState.status !== 0);

  // The studio keeps working: root owns nothing it needs to give up.
  check('the studio can still read its own log', fs.readFileSync(path.join(stateDir, 'events.jsonl'), 'utf8').length > 0);

  // ---------------------------------------------------------- workDir: "."
  //
  // The common case, and the one that broke: the whole project is the work
  // directory, so studio_floor/ sits *inside* what is handed to the agent. The
  // ownership walk has to step around it, or the agent owns the event log — and
  // a file you own you can chmod back open, whatever its mode says.
  const whole = path.join(tmp, 'whole');
  const wholeState = path.join(whole, 'studio_floor', 'state');
  const wholeConfig = path.join(whole, 'studio_floor', 'config.json');
  fs.mkdirSync(wholeState, { recursive: true });
  fs.writeFileSync(path.join(wholeState, 'events.jsonl'), '{"seq":1}\n');
  fs.writeFileSync(wholeConfig, '{"project":{"workDir":"."}}\n');
  fs.writeFileSync(path.join(whole, 'main.js'), '// the project itself\n');

  const wholeVerdict = confinement({ mode: 'require', userName: USER, workDir: whole, shared: true });
  const wholeApplied = applyConfinement(confinementPlan({
    user: wholeVerdict.user, workDir: whole, stateDir: wholeState, configFile: wholeConfig,
    homeDir: path.join(whole, 'studio_floor'),
  }));
  check('the plan applies when the project is the work directory', wholeApplied.ok, wholeApplied.error);

  const inWhole = (script) => spawnSync(process.execPath, ['-e', script], {
    uid: wholeVerdict.user.uid,
    gid: wholeVerdict.user.gid,
    env: agentEnv({ studio: { HOME: wholeVerdict.user.home } }),
    encoding: 'utf8',
    timeout: 20_000,
  });

  const buildsHere = inWhole(`require('fs').writeFileSync(${JSON.stringify(path.join(whole, 'out.txt'))}, 'x')`);
  check('the agent can still build in the project', buildsHere.status === 0, (buildsHere.stderr || '').trim());

  const readsLog = inWhole(`require('fs').readFileSync(${JSON.stringify(path.join(wholeState, 'events.jsonl'))}, 'utf8')`);
  check('but the event log inside it is still closed',
    readsLog.status !== 0, firstLine(readsLog.stderr));

  const lists = inWhole(`require('fs').readdirSync(${JSON.stringify(path.join(whole, 'studio_floor'))})`);
  check('and the studio folder cannot even be listed',
    lists.status !== 0, firstLine(lists.stderr));

  const unseal = inWhole(`require('fs').chmodSync(${JSON.stringify(path.join(whole, 'studio_floor'))}, 0o777)`);
  check('nor unsealed, because the agent does not own it',
    unseal.status !== 0, firstLine(unseal.stderr));

  const owner = fs.statSync(path.join(wholeState, 'events.jsonl'));
  check('the log is still owned by the studio', owner.uid === 0, `uid ${owner.uid}`);
} finally {
  if (!existed) spawnSync('userdel', ['--remove', USER], { encoding: 'utf8' });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leftover tmp */ }
}

console.log(failures ? `\n${failures} confine-root check(s) failed\n` : '\nall confine-root checks passed\n');
process.exitCode = failures ? 1 : 0;
