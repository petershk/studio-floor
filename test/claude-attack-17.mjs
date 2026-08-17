#!/usr/bin/env node
// TASK-17 REVIEW — claude attacking codex's human-write guards.
// Not a keeper test; a reviewer's probe. Reports facts, judges nothing.
import { startStudioServer, studioUrl } from './harness.mjs';

const boot = [
  'import { Store } from ' + JSON.stringify(studioUrl('core/store.mjs')) + ';',
  'import { createHttpServer } from ' + JSON.stringify(studioUrl('server/server.mjs')) + ';',
  'const store = new Store();',
  'studioTestReady(store, createHttpServer(store, null));',
].join('\n');

const { get, post } = await startStudioServer({ boot, prefix: 'claude-attack-17-' });
const count = async () => (await get('/api/events?limit=2000')).events.length;
const act = (p) => post('/api/action', p);
const state = () => get('/api/state');

// --- build a world -----------------------------------------------------------
await act({ agent: 'claude', verb: 'join', strengths: ['x'], intro: 'i' });
await act({ agent: 'grok', verb: 'join', strengths: ['y'], intro: 'i' });
const mkTask = async (title) => (await act({ agent: 'claude', verb: 'task.create', title, objective: 'o' })).id;

const assigned = await mkTask('a task that is merely assigned');
await act({ agent: 'claude', verb: 'task.update', id: assigned, state: 'assigned', owner: 'claude' });
const reviewing = await mkTask('a task actually under review');
await act({ agent: 'claude', verb: 'task.update', id: reviewing, state: 'under-review', owner: 'claude', reviewer: 'grok' });

const attOnAssigned = 'ATT-' + (await act({ agent: 'claude', verb: 'attention', kind: 'review', text: 'look at this', ref: assigned })).seq;
const attPlain = 'ATT-' + (await act({ agent: 'claude', verb: 'attention', kind: 'decision', text: 'decide this' })).seq;

console.log(`world: assigned=${assigned} under-review=${reviewing} attOnAssigned=${attOnAssigned} attPlain=${attPlain}\n`);

async function probe(label, path, payload) {
  const before = await count();
  const r = await post(path, payload);
  const after = await count();
  const verdict = r.error ? `REFUSED (${after - before} events appended)` : `ACCEPTED (${after - before} events appended)`;
  console.log(`  ${label}\n      ${verdict}${r.error ? `\n      "${r.error}"` : ''}`);
  return r;
}

console.log('BOUNDARY 1 — codex asked: stale ATT verdict returns 400 and appends nothing');
await probe('verdict on a nonexistent ATT-999', '/api/human/verdict', { target: 'ATT-999', verdict: 'approve' });
await post('/api/human/verdict', { target: attPlain, verdict: 'approve', text: 'yes' });
await probe(`verdict on ${attPlain} a second time (already cleared)`, '/api/human/verdict', { target: attPlain, verdict: 'reject', text: 'no' });
await probe('verdict with no target at all', '/api/human/verdict', { verdict: 'approve' });
await probe('verdict with a garbage target', '/api/human/verdict', { target: 'BANANA-1', verdict: 'approve' });
await probe('lowercase att id that passes the regex', '/api/human/verdict', { target: attPlain.toLowerCase(), verdict: 'approve' });

console.log('\nBOUNDARY 2 — codex asked: direct TASK verdicts require under-review');
await probe(`approve ${assigned} directly (state=assigned)`, '/api/human/verdict', { target: assigned, verdict: 'approve' });
await probe(`approve ${reviewing} directly (state=under-review)`, '/api/human/verdict', { target: reviewing, verdict: 'approve', text: 'ship it' });
await probe(`reply on ${reviewing} (reply is ATT-only)`, '/api/human/verdict', { target: reviewing, verdict: 'reply', text: 'hm' });

console.log('\nATTACK codex did NOT name — the same guard via an ATT ref');
const r = await probe(`approve ${attOnAssigned}, whose ref is ${assigned} (NOT under review)`, '/api/human/verdict', { target: attOnAssigned, verdict: 'approve', text: 'approved through the ref' });
const s = await state();
const t = s.tasks[assigned] ?? Object.values(s.tasks).find((x) => x.id === assigned);
console.log(`      -> ${assigned}.state=${t?.state} humanApproved=${t?.humanApproved} humanVerdictText=${JSON.stringify(t?.humanVerdictText ?? null)}`);
const t2 = s.tasks[reviewing] ?? Object.values(s.tasks).find((x) => x.id === reviewing);
console.log(`      -> ${reviewing}.state=${t2?.state} humanApproved=${t2?.humanApproved} (direct approve above)`);

console.log('\nBOUNDARY 3 — codex asked: ATT approve/reject/reply carry text and reach an inbox');
const att2 = 'ATT-' + (await act({ agent: 'grok', verb: 'attention', kind: 'decision', text: 'grok needs a call' })).seq;
await probe(`reply on ${att2} with text`, '/api/human/verdict', { target: att2, verdict: 'reply', text: 'here is my answer' });
const att3 = 'ATT-' + (await act({ agent: 'grok', verb: 'attention', kind: 'decision', text: 'another' })).seq;
await probe(`reply on ${att3} with empty text`, '/api/human/verdict', { target: att3, verdict: 'reply', text: '   ' });
const inbox = await get('/api/inbox?agent=grok');
const items = inbox.items ?? inbox.messages ?? inbox.events ?? [];
console.log(`      grok inbox: ${items.length} items; verdict text present: ${JSON.stringify(items.filter((i) => JSON.stringify(i).includes('here is my answer')).length)}`);

console.log('\nATTACK codex did NOT name — human.control destructive defaults');
await probe('stop with NO target (what does this do?)', '/api/human/control', { action: 'stop' });
await probe('pause with NO target', '/api/human/control', { action: 'pause' });
const s2 = await state();
console.log(`      -> studio-wide paused=${s2.paused}; per-agent paused: ${Object.values(s2.agents).map((a) => `${a.id}=${a.paused ?? false}`).join(' ')}`);
await probe('control targeting the human', '/api/human/control', { action: 'nudge', target: 'human' });
await probe('control targeting an unknown agent', '/api/human/control', { action: 'nudge', target: 'gemini' });
await probe('unknown action', '/api/human/control', { action: 'delete-everything' });

console.log(`\ntotal events on the log: ${await count()}`);
process.exit(0);
