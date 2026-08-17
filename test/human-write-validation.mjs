#!/usr/bin/env node
/**
 * TASK-17: human writes get the same ingress guarantees as agent writes.
 *
 * A refusal must explain what is valid and append nothing. An acceptance must
 * change projected state, including verdicts delivered through an ATT ref.
 */
import { startStudioServer, studioUrl } from './harness.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (ok || !detail ? '' : ' — ' + detail));
  if (!ok) failures++;
}

const boot = [
  'import { Store } from ' + JSON.stringify(studioUrl('core/store.mjs')) + ';',
  'import { createHttpServer } from ' + JSON.stringify(studioUrl('server/server.mjs')) + ';',
  'const store = new Store();',
  'studioTestReady(store, createHttpServer(store, null));',
].join('\n');

const server = await startStudioServer({ boot, prefix: 'studio-human-write-' });
const { get, post } = server;

async function eventCount() {
  return (await get('/api/events?limit=1000')).events.length;
}

async function refuses(name, path, payload, mentions) {
  const before = await eventCount();
  const result = await post(path, payload);
  const after = await eventCount();
  const said = String(result.error || '');
  check(name, !!result.error && mentions.every((part) => said.includes(part)), said || JSON.stringify(result));
  check(name + ' appends nothing', after === before, before + ' -> ' + after);
}

async function accepts(name, path, payload) {
  const result = await post(path, payload);
  check(name, !!result.ok, result.error || JSON.stringify(result));
  return result;
}

async function act(payload) {
  return accepts(payload.verb, '/api/action', payload);
}

try {
  await act({ verb: 'register', agent: 'codex', intro: 'human validation test' });
  const reviewTask = await act({
    verb: 'task.create',
    agent: 'codex',
    title: 'Ready for human review',
    owner: 'codex',
    reviewer: 'claude',
    state: 'under-review',
  });
  const activeTask = await act({
    verb: 'task.create',
    agent: 'codex',
    title: 'Still being built',
    owner: 'codex',
    state: 'active',
  });
  const decision = await act({
    verb: 'decision',
    agent: 'codex',
    question: 'Which path?',
    chosen: 'browser',
    alternatives: ['browser', 'native'],
    participants: ['codex'],
  });
  const attention = await act({
    verb: 'attention',
    agent: 'codex',
    kind: 'decision',
    text: 'Approve the browser decision?',
    ref: decision.id,
  });
  const attentionId = 'ATT-' + attention.seq;

  console.log('\n controls');
  await refuses(
    'an unknown control action is refused',
    '/api/human/control',
    { action: 'launch' },
    ['invalid human control action', 'pause', 'priority'],
  );
  await refuses(
    'a control aimed at a typo agent is refused',
    '/api/human/control',
    { action: 'pause', target: 'claud' },
    ['unknown control target', 'codex, claude, grok'],
  );
  await refuses(
    'an empty priority is refused',
    '/api/human/control',
    { action: 'priority', text: '   ' },
    ['priority needs text'],
  );
  await refuses(
    'a misleading targeted priority is refused',
    '/api/human/control',
    { action: 'priority', target: 'codex', text: 'ship' },
    ['studio-wide', 'omit control target'],
  );
  await accepts('a targeted pause is accepted', '/api/human/control', { action: 'pause', target: 'codex' });
  check('the targeted pause changes projected agent state', (await get('/api/state')).agents.codex.paused === true);
  await accepts('a targeted resume is accepted', '/api/human/control', { action: 'resume', target: 'codex' });
  check('the targeted resume changes projected agent state', (await get('/api/state')).agents.codex.paused === false);

  console.log('\n verdicts');
  await refuses(
    'a verdict without a target is refused',
    '/api/human/verdict',
    { verdict: 'approve' },
    ['needs a target', 'ATT', 'TASK', 'DEC'],
  );
  await refuses(
    'a verdict with an unknown enum is refused',
    '/api/human/verdict',
    { target: decision.id, verdict: 'maybe' },
    ['invalid human verdict', 'approve', 'reject', 'reply'],
  );
  await refuses(
    'a missing attention id is refused',
    '/api/human/verdict',
    { target: 'ATT-999', verdict: 'approve' },
    ['no such attention', attentionId],
  );
  await refuses(
    'a missing decision id is refused',
    '/api/human/verdict',
    { target: 'DEC-999', verdict: 'approve' },
    ['no such decision', decision.id],
  );
  await refuses(
    'reply cannot masquerade as a decision verdict',
    '/api/human/verdict',
    { target: decision.id, verdict: 'reply', text: 'consider this' },
    ['reply is only valid', 'approve or reject a decision'],
  );
  await refuses(
    'an empty attention reply is refused',
    '/api/human/verdict',
    { target: attentionId, verdict: 'reply', text: '   ' },
    ['reply needs text', 'team should know'],
  );
  await refuses(
    'a task not under review cannot receive a verdict',
    '/api/human/verdict',
    { target: activeTask.id, verdict: 'reject' },
    ['not under-review', 'request review'],
  );

  await accepts(
    'a direct decision approval is accepted',
    '/api/human/verdict',
    { target: decision.id, verdict: 'approve', text: 'browser is right' },
  );
  let state = await get('/api/state');
  let projectedDecision = state.decisions.find((item) => item.id === decision.id);
  check(
    'a direct decision approval is visible in projection',
    projectedDecision?.humanApproved === true
      && projectedDecision?.humanVerdict === 'approve'
      && projectedDecision?.humanVerdictText === 'browser is right'
      && projectedDecision?.humanRole === 'approved',
    JSON.stringify(projectedDecision),
  );

  await accepts(
    'an under-review task rejection is accepted',
    '/api/human/verdict',
    { target: reviewTask.id, verdict: 'reject', text: 'needs another pass' },
  );
  state = await get('/api/state');
  check(
    'a task rejection is visible in projection',
    state.tasks[reviewTask.id]?.humanApproved === false
      && state.tasks[reviewTask.id]?.humanVerdict === 'reject'
      && state.tasks[reviewTask.id]?.humanVerdictText === 'needs another pass',
    JSON.stringify(state.tasks[reviewTask.id]),
  );

  await accepts(
    'an open attention rejection is accepted',
    '/api/human/verdict',
    { target: attentionId, verdict: 'reject', text: 'choose native instead' },
  );
  state = await get('/api/state');
  projectedDecision = state.decisions.find((item) => item.id === decision.id);
  check(
    'an attention verdict clears the live item and reaches its decision ref',
    state.attention.find((item) => item.id === attentionId)?.status === 'cleared'
      && projectedDecision?.humanApproved === false
      && projectedDecision?.humanVerdictText === 'choose native instead'
      && projectedDecision?.humanRole === 'override',
    JSON.stringify({ attention: state.attention, decision: projectedDecision }),
  );
  await refuses(
    'a stale browser verdict on cleared attention is refused',
    '/api/human/verdict',
    { target: attentionId, verdict: 'approve' },
    ['already cleared', 'reject'],
  );
} finally {
  server.stop();
}

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
process.exit(failures ? 1 : 0);
