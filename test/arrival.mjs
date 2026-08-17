#!/usr/bin/env node
/**
 * An agent must not lose what was said to it before it arrived.
 *
 * TASK-006 asks that agents poll human directives on arrival. They did not. The
 * runner read the inbox, built a FIRST-turn prompt that contained only the brief,
 * and then — because the turn exited cleanly — acknowledged the whole inbox. An
 * arriving agent silently consumed every message and every human directive
 * waiting for it without being shown one of them.
 *
 * The same path fires when a session cannot be resumed: the runner treats a lost
 * session as fresh, so an agent that crashed lost its accumulated inbox on the
 * way back in. That is the TASK-14 crash case reopened through a different door,
 * which is why the invariant below is the one that matters:
 *
 *   every item the runner will acknowledge must appear in the prompt it sent.
 *
 * Run: node test/arrival.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-arrival-'));
process.env.STUDIO_PROJECT_ROOT = tmp;

const { Store } = await import('../src/core/store.mjs');
const { firstTurnPrompt, turnPrompt } = await import('../src/agents/prompts.mjs');
const { ADAPTERS } = await import('../src/agents/adapters/index.mjs');
const { buildLaunchableArgs } = await import('../src/agents/runner.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log(`\narrival: nothing said before an agent joins is lost  (state dir: ${tmp})\n`);

const store = new Store();

// Everything that happens while claude is not running.
store.append('human.message', null, { from: 'human', to: ['claude'], text: 'review the reward system first' });
store.append('human.control', null, { action: 'priority', text: 'ship the core loop before anything else' });
store.append('message.sent', 'grok', { from: 'grok', to: ['claude'], kind: 'delegation', text: 'take the store review' });
store.append('message.sent', 'codex', { from: 'codex', to: [], kind: 'announce', text: 'I am on TASK-011' });
store.append('human.verdict', null, { target: 'ATT-4', verdict: 'approve', text: 'go ahead' });

const box = store.inbox('claude');
check('an arriving agent has an inbox waiting for it', box.items.length === 5, `${box.items.length} items`);

const first = firstTurnPrompt('claude', '=== STUDIO BRIEF ===\nnothing yet', { inbox: box.items });

// THE INVARIANT. The runner acknowledges through box.cursor when the turn exits
// cleanly. Anything acknowledged but absent from the prompt is a message the
// studio told its author was delivered and no one ever read.
const missing = box.items.filter((i) => !first.includes(i.line));
check(
  'every item that will be acknowledged appears in the first-turn prompt',
  missing.length === 0,
  missing.map((i) => `[${i.seq}] ${i.line}`).join(' | '),
);

check(
  "the human's own words survive into the arrival prompt",
  first.includes('review the reward system first') && first.includes('ship the core loop before anything else'),
);
check('a verdict left for the agent is in the arrival prompt', first.includes('go ahead'));
check('delegation from another agent is in the arrival prompt', first.includes('take the store review'));

// The human is the creative director; their waiting directives outrank the
// introduce-yourself script this prompt otherwise opens with.
const humanBlock = first.indexOf('THE HUMAN HAS ALREADY SAID THIS');
const teamBlock = first.indexOf('SAID BEFORE YOU ARRIVED');
const thisTurn = first.indexOf('=== THIS TURN ===');
check('the human block exists and is separate from the team block', humanBlock !== -1 && teamBlock !== -1);
check('the human block comes before the team block', humanBlock < teamBlock, `${humanBlock} vs ${teamBlock}`);
check('both come before the turn instructions', teamBlock < thisTurn, `${teamBlock} vs ${thisTurn}`);
check('the agent is told to answer the human first', /Answer the human first/.test(first));

// The runner does not send this constructor result directly. It passes it
// through the Windows command-line size guard, which slices the tail of the
// prompt. The waiting-human block lives after the brief, so a sufficiently long
// arrival directive can be present here but absent from what the provider gets,
// while the runner still acknowledges its cursor after exit 0.
const tail = 'ARRIVAL-DIRECTIVE-TAIL-MUST-REACH-PROVIDER';
const largeInbox = [{
  seq: box.cursor + 1,
  kind: 'human.message',
  line: 'Human: ' + 'x'.repeat(60_000) + tail,
}];
const config = {
  codexSandbox: 'workspace-write',
  claudePermissionMode: 'acceptEdits',
  grokPermissionMode: 'auto',
  disableMcp: true,
};
for (const [id, adapter] of Object.entries(ADAPTERS)) {
  const prompt = firstTurnPrompt(id, 'brief', { inbox: largeInbox });
  const args = buildLaunchableArgs({ append() {} }, id, adapter, {
    prompt,
    sessionId: null,
    fresh: true,
    config,
  });
  check(
    id + ': the launch-size guard preserves the arrival directive',
    args.some((arg) => String(arg).includes(tail)),
    'the prompt constructor had it, but the provider argv did not',
  );
}

// codex's sharper half of the TASK-006 defect: even with the size guard cutting
// the middle instead of the tail, a long enough queue still loses characters, and
// a clean exit used to acknowledge the whole cursor regardless. So the invariant
// is not "the tail survives" — it is "nothing is acknowledged that was not sent".
for (const [id, adapter] of Object.entries(ADAPTERS)) {
  const prompt = firstTurnPrompt(id, 'brief', { inbox: largeInbox });
  const outcome = {};
  buildLaunchableArgs({ append() {} }, id, adapter, { prompt, sessionId: null, fresh: true, config }, outcome);
  check(
    id + ': a prompt that had to be shortened says so, so the turn can refuse to ack',
    outcome.shortened === true,
    JSON.stringify(outcome),
  );
}
{
  const small = firstTurnPrompt('claude', 'brief', { inbox: [{ seq: 1, kind: 'human.message', line: 'Human: hello' }] });
  const outcome = {};
  buildLaunchableArgs({ append() {} }, 'claude', ADAPTERS.claude, { prompt: small, sessionId: null, fresh: true, config }, outcome);
  check('an ordinary prompt is not reported as shortened', outcome.shortened === false, JSON.stringify(outcome));
}

// An agent arriving to nothing should not be handed empty ceremony.
const quiet = firstTurnPrompt('grok', 'brief', { inbox: [] });
check('an empty inbox adds no waiting section', !quiet.includes('THE HUMAN HAS ALREADY SAID THIS') && !quiet.includes('SAID BEFORE YOU ARRIVED'));
check('an empty inbox adds no answer-the-human step', !/Answer the human first/.test(quiet));
check('the prompt still works with no options argument at all', typeof firstTurnPrompt('codex', 'brief') === 'string');

// The same invariant on the ordinary path, including redelivery marking.
store.markDelivered('claude', box.cursor, box.items.length);
const again = store.inbox('claude');
const later = turnPrompt('claude', { turn: 2, reason: 'a message arrived', inbox: again.items, brief: 'brief' });
const missingLater = again.items.filter((i) => !later.includes(i.line));
check(
  'every item that will be acknowledged appears in an ordinary turn prompt',
  missingLater.length === 0,
  missingLater.map((i) => `[${i.seq}]`).join(' '),
);
check('a redelivered item is marked as one in the prompt', later.includes('↻'));
check('the agent is told why it is seeing them again', /delivered again rather than dropped/.test(later));

store.close();

if (failures) {
  console.log(`\n${failures} arrival check(s) failed\n`);
  process.exit(1);
}
console.log('\narrival ok\n');
