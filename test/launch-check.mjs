#!/usr/bin/env node
/**
 * Launch check — the turn prompt must always fit in a command line.
 *
 * This exists because it did not. The brief grew with the studio's history, the
 * prompt embeds the brief, the prompt is passed to the provider as one argv
 * element, and Windows refuses a command line over 32767 characters. At about
 * 47000 characters every agent began failing with ENAMETOOLONG before its
 * process started, so the whole team stopped at once and no agent could report
 * why. This asserts against the real live studio state, not a fixture.
 *
 *   node test/launch-check.mjs
 */
import { ADAPTERS } from '../src/agents/adapters/index.mjs';
import { loadConfig } from '../src/agents/runner.mjs';
import { BASE_URL } from '../src/core/paths.mjs';

const OS_LIMIT = 32_767;
const config = loadConfig();
let failures = 0;

function check(name, cond, detail = '') {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

let state;
try {
  state = await (await fetch(`${BASE_URL}/api/state`)).json();
} catch {
  console.log('\nlaunch check: the studio server is not running, nothing to measure against\n');
  process.exit(0);
}

console.log(`\nlaunch check  (live studio, seq ${state.seq})\n`);

const { firstTurnPrompt, turnPrompt } = await import('../src/agents/prompts.mjs');
const { renderBrief, buildLaunchableArgs, BRIEF_LIMITS } = await import('../src/agents/runner.mjs');

const brief = renderBrief('claude', state);
check('the brief is bounded', brief.length <= BRIEF_LIMITS.total + 200, `${brief.length} chars`);

// Measure the real thing, through the same path the runner uses.
const inbox = await (await fetch(`${BASE_URL}/api/inbox?agent=claude`)).json();
const silentStore = { append() {} };

for (const [id, adapter] of Object.entries(ADAPTERS)) {
  for (const [label, prompt] of [
    ['first turn', firstTurnPrompt(id, brief, { inbox: inbox.items })],
    ['later turn', turnPrompt(id, { turn: 999, reason: 'launch check', inbox: inbox.items, brief })],
  ]) {
    const params = { prompt, sessionId: 'x'.repeat(36), fresh: label === 'first turn', config };
    const raw = adapter.args(params);
    const rawLen = adapter.command.length + raw.reduce((n, a) => n + String(a).length + 3, 0);
    const args = buildLaunchableArgs(silentStore, id, adapter, params);
    const len = adapter.command.length + args.reduce((n, a) => n + String(a).length + 3, 0);
    check(`${id} ${label} fits in a command line`, len < OS_LIMIT, `${len} chars vs ${OS_LIMIT} limit`);
    if (rawLen !== len) console.log(`        (shortened from ${rawLen} to ${len})`);
  }
}

// The guard itself must work even when the brief is pathological.
const huge = 'x'.repeat(200_000);
for (const [id, adapter] of Object.entries(ADAPTERS)) {
  const args = buildLaunchableArgs(silentStore, id, adapter, { prompt: huge, sessionId: 'x'.repeat(36), fresh: false, config });
  const len = adapter.command.length + args.reduce((n, a) => n + String(a).length + 3, 0);
  check(`${id} survives a 200k prompt`, len < OS_LIMIT, `${len} chars`);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nevery provider can be launched from the current studio state\n');
// Set the code and let node close its own handles. Calling process.exit() here
// races the keep-alive sockets fetch leaves open and trips a libuv assertion on
// Windows — which reported a non-zero exit for a run where nothing failed.
process.exitCode = failures ? 1 : 0;
