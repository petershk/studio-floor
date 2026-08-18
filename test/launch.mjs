#!/usr/bin/env node
/**
 * Turning a command name into something Node can spawn.
 *
 * This exists because the studio could not launch an npm-installed CLI on
 * Windows at all, and nothing noticed. `npm i -g` writes three shims — `foo`,
 * `foo.cmd`, `foo.ps1` — and Node will start none of them without a shell: the
 * extensionless one is ENOENT and `.cmd` is EINVAL, since Node stopped spawning
 * batch files directly after CVE-2024-27980.
 *
 * It went unseen because the three CLIs on the development machine all happened
 * to ship native installers. Installing any of them from npm instead — which
 * this project's own quickstart used to recommend — would have killed every turn
 * before the process started.
 *
 * `shell: true` is not the fix. With a shell, Node hands cmd.exe an unescaped
 * joined string, and one of those arguments is the turn prompt: arbitrary text
 * written by agents and by the human, routinely containing `&`, `|`, `>` and
 * quotes. That is command injection pointed at the machine the studio runs on.
 *
 *   node test/launch.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveLaunch, entrypointOfShim } from '../src/agents/launch.mjs';

let n = 0;
const ok = (name, cond, detail = '') => {
  n++;
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1; }
};

console.log('\nlaunch — resolving a command without a shell\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-launch-'));
const isWindows = process.platform === 'win32';

// --------------------------------------------------------- reading npm shims

{
  // A real npm shim, byte for byte in the shape npm writes.
  const dir = path.join(tmp, 'bin');
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg', 'bundle'), { recursive: true });
  const entry = path.join(dir, 'node_modules', 'pkg', 'bundle', 'cli.js');
  fs.writeFileSync(entry, 'console.log("hello from the entrypoint");\n');
  const shim = path.join(dir, 'tool.cmd');
  fs.writeFileSync(shim, [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
    'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (',
    '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  '
      + '"%dp0%\\node_modules\\pkg\\bundle\\cli.js" %*',
  ].join('\r\n'));

  const found = entrypointOfShim(shim);
  ok('the entrypoint is read out of a shim', found === entry, String(found));

  // Spawning the extracted entrypoint must actually work, with no shell.
  const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true });
  ok('and running it produces the tool', /hello from the entrypoint/.test(r.stdout || ''));
}
{
  const shim = path.join(tmp, 'weird.cmd');
  fs.writeFileSync(shim, '@echo off\r\nsome_other_program.exe %*\r\n');
  ok('a shim it cannot read returns null rather than a guess', entrypointOfShim(shim) === null);
}
{
  const shim = path.join(tmp, 'missing.cmd');
  fs.writeFileSync(shim, 'x & "%_prog%" "%dp0%\\node_modules\\gone\\cli.js" %*\r\n');
  ok('a shim pointing at a file that is not there returns null',
    entrypointOfShim(shim) === null);
}
ok('an unreadable path returns null, not a throw',
  entrypointOfShim(path.join(tmp, 'does-not-exist.cmd')) === null);

// ------------------------------------------------------------- resolution

{
  const r = resolveLaunch('definitely-not-a-real-command-xyz');
  ok('an unknown command is passed through for spawn to reject',
    r.command === 'definitely-not-a-real-command-xyz' && !r.error);
}
{
  // Never returns something needing a shell, on any platform.
  for (const cmd of ['node', 'definitely-not-a-real-command-xyz']) {
    const r = resolveLaunch(cmd);
    ok(`resolving "${cmd}" never asks for a shell`, r.shell === undefined);
  }
}
{
  const r = resolveLaunch('node');
  ok('a real executable resolves', !r.error, r.error || '');
  const probe = spawnSync(r.command, [...(r.prefixArgs || []), '-e', 'process.stdout.write("ran")'],
    { encoding: 'utf8', windowsHide: true });
  ok('and the resolution actually runs', (probe.stdout || '') === 'ran',
    probe.error ? probe.error.code : probe.stdout);
}

// ------------------------------------------------ the platform-specific part

if (isWindows) {
  // The precedence bug: npm writes `foo` (an sh script) beside `foo.cmd`, and
  // the sh script is the one Windows cannot run. Extensions must win.
  const dir = path.join(tmp, 'prec');
  fs.mkdirSync(path.join(dir, 'node_modules', 'p', 'b'), { recursive: true });
  const entry = path.join(dir, 'node_modules', 'p', 'b', 'x.js');
  fs.writeFileSync(entry, 'process.stdout.write("via-cmd");\n');
  fs.writeFileSync(path.join(dir, 'dual'), '#!/bin/sh\nexec node "$0.js" "$@"\n');
  fs.writeFileSync(path.join(dir, 'dual.cmd'),
    '@echo off\r\n"%_prog%"  "%dp0%\\node_modules\\p\\b\\x.js" %*\r\n');

  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${prevPath}`;
  try {
    const r = resolveLaunch('dual');
    ok('the .cmd is chosen over the extensionless sh script',
      (r.prefixArgs || [])[0] === entry, JSON.stringify(r).slice(0, 120));
    const probe = spawnSync(r.command, [...(r.prefixArgs || [])], { encoding: 'utf8', windowsHide: true });
    ok('and it runs with no shell', (probe.stdout || '') === 'via-cmd',
      probe.error ? probe.error.code : probe.stdout);
  } finally {
    process.env.PATH = prevPath;
  }
} else {
  ok('on this platform the command is used as given', resolveLaunch('node').command === 'node');
  ok('and no prefix args are added', (resolveLaunch('node').prefixArgs || []).length === 0);
}

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
console.log(process.exitCode ? '\nlaunch checks FAILED\n' : `\nall ${n} launch checks passed\n`);
