#!/usr/bin/env node
/**
 * Token accounting.
 *
 * The whole reason this module exists is that the obvious implementation is
 * badly wrong. Three providers report usage in three different shapes:
 *
 *   Claude / Grok  one authoritative total per turn, on the `result` event,
 *                  with the provider's own cost — plus ten or more partial
 *                  per-message reports whose cache figures are running values.
 *   Codex          a cumulative total for the whole thread, climbing across a
 *                  resumed session and resetting when a new one starts.
 *
 * Adding every usage event together overstated Codex by 10.7x when measured
 * against a real 24,000-event run. These assertions encode the shapes that
 * caused that, using payloads copied from that log.
 *
 *   node test/usage.mjs
 */
import { accumulate, normaliseTokens, estimateCost, inferScope, UsageLedger } from '../src/core/usage.mjs';

let n = 0;
const ok = (name, cond, detail = '') => {
  n++;
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1; }
};

console.log('\nusage — three providers, three shapes, one number\n');

let seq = 0;
const turnStart = (agent, turn, sessionId) => ({ seq: ++seq, ts: '2026-01-01T00:00:00.000Z', kind: 'raw.turn.start', agent, data: { turn, sessionId } });
const usage = (agent, data) => ({ seq: ++seq, ts: '2026-01-01T00:00:00.000Z', kind: 'raw.usage', agent, data });

// ------------------------------------------------------- field vocabularies

{
  // Real payloads, copied from the log.
  const claude = normaliseTokens({ input_tokens: 2, cache_creation_input_tokens: 16033, cache_read_input_tokens: 20938, output_tokens: 1 });
  ok('claude fields are read', claude.input === 2 && claude.cacheRead === 20938 && claude.cacheWrite === 16033);

  const codex = normaliseTokens({ input_tokens: 1669479, cached_input_tokens: 1570048, cache_write_input_tokens: 0, output_tokens: 10991, reasoning_output_tokens: 5446 });
  ok('codex spells cached input differently and is still read', codex.cacheRead === 1570048, String(codex.cacheRead));
  ok('reasoning tokens are surfaced', codex.reasoning === 5446);
  ok('and not double-counted into output', codex.output === 10991);

  ok('missing fields are zero, not NaN', normaliseTokens({}).input === 0);
  ok('garbage is zero, not NaN', normaliseTokens({ input_tokens: 'lots' }).input === 0);
}

// ------------------------------------------------------- per-message events

{
  // One claude turn: many partial reports, then the real total with the cost.
  const evs = [turnStart('claude', 1, 's1')];
  for (let i = 0; i < 12; i++) {
    evs.push(usage('claude', { scope: 'message', usage: { input_tokens: 2, cache_read_input_tokens: 50000 + i, output_tokens: 3 } }));
  }
  evs.push(usage('claude', { scope: 'turn', costUsd: 3.32, durationMs: 1000, usage: { input_tokens: 6780, cache_read_input_tokens: 3471161, cache_creation_input_tokens: 86449, output_tokens: 27204 } }));

  const { byAgent, turns } = accumulate(evs);
  const t = byAgent.claude;
  ok('per-message reports are excluded from the total', t.input === 6780, `input=${t.input}`);
  ok('the turn total is the result event', t.output === 27204 && t.cacheRead === 3471161);
  ok('one billed turn, not thirteen', t.turns === 1, `turns=${t.turns}`);
  ok('the reported cost is used verbatim', Math.abs(t.costReported - 3.32) < 1e-9);
  ok('and is marked as reported', t.reportsCost === true);
  ok('the ledger records one turn row', turns.length === 1);
}

// ------------------------------------------------- cumulative session events

{
  // Codex: rising cumulative totals inside one session.
  const evs = [
    turnStart('codex', 1, 'A'),
    usage('codex', { scope: 'session', usage: { input_tokens: 1000, output_tokens: 100 } }),
    turnStart('codex', 2, 'A'),
    usage('codex', { scope: 'session', usage: { input_tokens: 2500, output_tokens: 260 } }),
    turnStart('codex', 3, 'A'),
    usage('codex', { scope: 'session', usage: { input_tokens: 4000, output_tokens: 400 } }),
  ];
  const { byAgent, turns } = accumulate(evs);
  ok('a cumulative counter is differenced, not summed', byAgent.codex.input === 4000, `input=${byAgent.codex.input}`);
  ok('naive summing would have said 7500', 1000 + 2500 + 4000 === 7500);
  ok('each turn gets its own delta', turns[1].input === 1500 && turns[2].input === 1500,
    turns.map((t) => t.input).join(','));
  ok('the first report of a session counts in full', turns[0].input === 1000);
}
{
  // A new session restarts the counter, and the studio sees the id change.
  const evs = [
    turnStart('codex', 1, 'A'),
    usage('codex', { scope: 'session', usage: { input_tokens: 5000, output_tokens: 500 } }),
    turnStart('codex', 2, 'B'),
    usage('codex', { scope: 'session', usage: { input_tokens: 800, output_tokens: 80 } }),
  ];
  ok('a new session starts a new baseline', accumulate(evs).byAgent.codex.input === 5800,
    String(accumulate(evs).byAgent.codex.input));
}
{
  // The counter drops without the session id changing — the provider restarted
  // its thread underneath us. Clamping at zero would lose the new thread whole.
  const evs = [
    turnStart('codex', 1, 'A'),
    usage('codex', { scope: 'session', usage: { input_tokens: 5000, output_tokens: 500 } }),
    turnStart('codex', 2, 'A'),
    usage('codex', { scope: 'session', usage: { input_tokens: 900, output_tokens: 90 } }),
  ];
  const t = accumulate(evs).byAgent.codex;
  ok('a counter that goes down is treated as a reset, not as zero', t.input === 5900, `input=${t.input}`);
  ok('so no tokens are silently lost', t.output === 590, `output=${t.output}`);
}

// --------------------------------------------------------------- legacy logs

{
  // Events written before scopes existed carry none. Defaulting them all to
  // 'turn' would reproduce the exact overcount, and only for codex — whose
  // payload is recognisable.
  ok('an unscoped codex payload is inferred cumulative',
    inferScope({ usage: { input_tokens: 1, cached_input_tokens: 1 } }) === 'session');
  ok('an unscoped payload with a cost is a turn total',
    inferScope({ usage: { input_tokens: 1 }, costUsd: 0.1 }) === 'turn');
  ok('an explicit scope always wins',
    inferScope({ scope: 'message', usage: { cached_input_tokens: 1 } }) === 'message');
}

// ------------------------------------------------------------------- pricing

{
  const rate = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const cost = estimateCost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }, rate);
  ok('a rate card prices a million of each', Math.abs(cost - (3 + 15 + 0.3 + 3.75)) < 1e-9, String(cost));
  ok('no rate card means no estimate, not zero', estimateCost({ input: 1e6 }, undefined) === null);
  ok('an empty rate card means no estimate', estimateCost({ input: 1e6 }, {}) === null);
  ok('cached input falls back to the input rate when unpriced',
    Math.abs(estimateCost({ input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0 }, { input: 3, output: 15 }) - 3) < 1e-9);
}
{
  // A provider that reports its own cost must never be second-guessed by a
  // rate card, or the two would be added together.
  const evs = [
    turnStart('claude', 1, 's'),
    usage('claude', { scope: 'turn', costUsd: 1.5, usage: { input_tokens: 1e6, output_tokens: 1e6 } }),
  ];
  const { byAgent } = accumulate(evs, { prices: { claude: { input: 3, output: 15 } }, providerOf: () => 'claude' });
  ok('a reported cost is not also estimated', Math.abs(byAgent.claude.costUsd - 1.5) < 1e-9,
    String(byAgent.claude.costUsd));
  ok('and nothing lands in the estimated column', byAgent.claude.costEstimated === 0);
}
{
  const evs = [
    turnStart('codex', 1, 'A'),
    usage('codex', { scope: 'session', usage: { input_tokens: 1e6, output_tokens: 1e6 } }),
  ];
  const { byAgent } = accumulate(evs, { prices: { codex: { input: 2, output: 8 } }, providerOf: () => 'codex' });
  ok('a provider with no reported cost is estimated', Math.abs(byAgent.codex.costEstimated - 10) < 1e-9,
    String(byAgent.codex.costEstimated));
  ok('and is not claimed as reported', byAgent.codex.reportsCost === false);
}
{
  const evs = [turnStart('codex', 1, 'A'), usage('codex', { scope: 'session', usage: { input_tokens: 1e6 } })];
  const { byAgent } = accumulate(evs);
  ok('with no prices at all, tokens are counted and cost stays zero',
    byAgent.codex.input === 1e6 && byAgent.codex.costUsd === 0);
  ok('and the agent is flagged as not reporting cost', byAgent.codex.reportsCost === false);
}

// ------------------------------------------------------- the ledger is bounded

{
  const ledger = new UsageLedger({ keepTurns: 10 });
  ledger.observe(turnStart('claude', 1, 's'));
  for (let i = 0; i < 50; i++) ledger.observe(usage('claude', { scope: 'turn', usage: { output_tokens: 1 } }));
  const snap = ledger.snapshot();
  ok('the per-turn ledger is capped', snap.turns.length === 10, String(snap.turns.length));
  ok('but the totals still count every turn', snap.byAgent.claude.output === 50, String(snap.byAgent.claude.output));
}

console.log(process.exitCode ? '\nusage checks FAILED\n' : `\nall ${n} usage checks passed\n`);
