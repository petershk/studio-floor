#!/usr/bin/env node
/**
 * Adapter check — proves the studio can actually launch each vendor CLI and
 * understand what comes back out of it.
 *
 * It runs one trivial, tool-free prompt per agent in a throwaway directory and
 * asserts that the adapter recovers the agent's text and its session id. This
 * is the part of the studio that talks to software we do not control, so it is
 * worth checking against the real binaries rather than against a fixture.
 *
 *   node test/adapter-check.mjs              all three
 *   node test/adapter-check.mjs codex grok   just those
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADAPTERS } from '../src/agents/adapters/index.mjs';

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ADAPTERS);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-adapter-'));
const PROMPT = 'Reply with exactly this and nothing else: STUDIO-OK. Do not use any tools.';

const config = {
  codexSandbox: 'read-only',
  claudePermissionMode: process.env.STUDIO_CLAUDE_MODE || 'default',
  grokPermissionMode: process.env.STUDIO_GROK_MODE || 'default',
  disableMcp: true,
};

let failures = 0;
console.log(`\nadapter check  (cwd: ${cwd})\n`);

for (const id of want) {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    console.log(`  SKIP  ${id} — no adapter`);
    continue;
  }
  const sessionId = adapter.newSession ? adapter.newSession() : null;
  const args = adapter.args({ prompt: PROMPT, sessionId, fresh: true, config });
  const started = Date.now();
  const result = await run(adapter, args, cwd);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const text = result.items.filter((i) => i.kind === 'raw.text').map((i) => i.data.text).join(' ');
  const session = result.items.find((i) => i.kind === 'session')?.data.sessionId;
  const unparsed = result.items.filter((i) => i.kind === 'raw.native' && i.data.summary === 'unparsed').length;

  report(`${id}: process exits cleanly`, result.code === 0, `exit ${result.code}`);
  report(`${id}: adapter recovers the agent's words`, /STUDIO-OK/.test(text), JSON.stringify(text.slice(0, 120)));
  report(`${id}: adapter captures a session id to resume`, !!session, String(session));
  report(`${id}: adapter understood the stream`, result.lines > 0 && unparsed === 0, `${result.lines} json lines`);
  console.log(`        ${result.lines} stream lines, ${result.items.length} studio events, ${secs}s\n`);
}

fs.rmSync(cwd, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED\n` : 'all adapters working\n');
process.exit(failures ? 1 : 0);

function report(name, cond, detail) {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function run(adapter, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(adapter.command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const items = [];
    let buf = '';
    let lines = 0;
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 240_000);

    child.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        lines++;
        try {
          items.push(...adapter.parse(JSON.parse(line)));
        } catch {
          items.push({ kind: 'raw.native', data: { summary: 'unparsed' } });
        }
      }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { stderr += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && stderr.trim()) console.log(`        stderr: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
      resolve({ code, items, lines });
    });
  });
}
