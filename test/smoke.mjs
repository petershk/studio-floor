#!/usr/bin/env node
/**
 * Studio smoke test — proves the collaboration loop end to end without spending
 * a single token on a real agent.
 *
 * It runs the real server against a throwaway state directory and drives it the
 * way the three agents do: join, talk, delegate, disagree, decide, complete,
 * review, escalate to the human, and let the human intervene.
 *
 *   node test/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-smoke-'));
const PORT = 4199;
process.env.STUDIO_PROJECT_ROOT = tmp;
process.env.STUDIO_PORT = String(PORT);
process.env.STUDIO_URL = `http://127.0.0.1:${PORT}`;

const { Store } = await import('../src/core/store.mjs');
const { createHttpServer } = await import('../src/server/server.mjs');

const store = new Store();
const server = createHttpServer(store, null);
await new Promise((r) => setTimeout(r, 120));

let failures = 0;
const base = `http://127.0.0.1:${PORT}`;

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function act(agent, verb, body = {}) {
  const r = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb, agent, ...body }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${verb}: ${j.error}`);
  return j;
}

async function human(pathname, body) {
  const r = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

const state = async () => (await fetch(`${base}/api/state`)).json();

console.log(`\nstudio smoke test  (state dir: ${tmp})\n`);

// 1 — three agents enter the same project and recognise each other -----------
for (const [id, strengths] of [
  ['codex', 'implementation,refactoring'],
  ['claude', 'architecture,review'],
  ['grok', 'adversarial analysis'],
]) {
  await act(id, 'register', { strengths, intro: `${id} reporting in` });
}
let s = await state();
check('three agents are registered', Object.values(s.agents).filter((a) => a.online).length === 3);
check('agents carry their own strengths', s.agents.grok.strengths.includes('adversarial analysis'));

// 2 — observable conversation ------------------------------------------------
await act('claude', 'say', { text: 'Proposal: the server is the only writer to the event log.', kind: 'proposal' });
await act('grok', 'say', { to: 'claude', text: 'That serialises every agent behind one process. What happens when it dies mid-turn?', kind: 'challenge' });
await act('claude', 'say', { to: 'grok', text: 'The log is append-only and torn lines are skipped on reload.', kind: 'answer' });
s = await state();
check('conversation is preserved verbatim', s.messages.length === 3 && s.messages[1].kind === 'challenge');
check('messages keep their addressing', s.messages[1].to.includes('claude'));

// 3 — tasks, delegation ------------------------------------------------------
const t1 = await act('claude', 'task.create', {
  title: 'Event log and projection',
  objective: 'Append-only log with a rebuilt projection',
  owner: 'codex',
  reviewer: 'grok',
});
check('task ids are allocated centrally', t1.id === 'TASK-01', t1.id);
const t2 = await act('grok', 'task.create', { title: 'Adversarial review of the log', objective: 'Find the failure mode' });
check('a second task gets a distinct id', t2.id === 'TASK-02', t2.id);

await act('codex', 'task.update', { id: t1.id, state: 'active', note: 'starting on the store' });
s = await state();
check('task state advances', s.tasks['TASK-01'].state === 'active');
check('task history records who changed it', s.tasks['TASK-01'].history.at(-1).by === 'codex');

// 4 — the owner is told about work created for them --------------------------
const codexInbox = await (await fetch(`${base}/api/inbox?agent=codex`)).json();
check('an agent sees work delegated to it', codexInbox.items.some((i) => i.kind === 'task.created' && i.data.id === 'TASK-01'));
check('an agent sees messages addressed to it', (await (await fetch(`${base}/api/inbox?agent=grok`)).json()).items.some((i) => i.kind === 'message.sent'));

// 5 — debate, changed mind, decision -----------------------------------------
const deb = await act('grok', 'debate.open', { question: 'Bounded turns or resident agents?' });
await act('grok', 'debate.position', { id: deb.id, stance: 'resident', because: 'no restart latency' });
await act('codex', 'debate.position', { id: deb.id, stance: 'bounded turns', because: 'the human can interrupt cleanly', critique: 'resident agents cannot be paused mid-thought' });
await act('grok', 'say', { text: 'Fair — interruptibility matters more than latency here.', kind: 'concede' });
await act('grok', 'debate.close', { id: deb.id, outcome: 'bounded turns' });
const latePosition = await fetch(`${base}/api/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ verb: 'debate.position', agent: 'codex', id: deb.id, stance: 'too late' }),
});
const latePositionBody = await latePosition.json();
check(
  'closed debate rejects late positions',
  latePosition.status === 500 && /already closed/.test(latePositionBody.error || ''),
);
const unknownDebate = await fetch(`${base}/api/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ verb: 'debate.close', agent: 'codex', id: 'DEB-999', outcome: 'missing' }),
});
const unknownDebateBody = await unknownDebate.json();
check(
  'unknown debate fails loudly',
  unknownDebate.status === 500 && /no such debate DEB-999/.test(unknownDebateBody.error || ''),
);
const dec = await act('claude', 'decision', {
  question: 'How are agents driven?',
  alternatives: ['resident processes', 'bounded turns'],
  chosen: 'bounded turns with resumed sessions',
  why: 'the human can interrupt between turns and inboxes can be injected',
  participants: ['codex', 'claude', 'grok'],
});
s = await state();
check('debate records both positions', s.debates[deb.id].positions.length === 2);
check('debate closes with an outcome', s.debates[deb.id].status === 'closed');
check('decision is durable', s.decisions.at(-1).id === dec.id && s.decisions.at(-1).chosen.startsWith('bounded'));

// 6 — work, validation, review round-trip ------------------------------------
await act('codex', 'files', { action: 'changed', files: 'studio/core/store.mjs,studio/server/server.mjs', task: t1.id });
await act('codex', 'validation', { name: 'store round-trip', command: 'node test', ok: true, output: 'all good', task: t1.id });
await act('codex', 'task.update', { id: t1.id, state: 'under-review', result: 'log + projection landed' });
await act('grok', 'task.update', { id: t1.id, state: 'active', owner: 'codex', note: 'returning: reconnect drops events' });
await act('grok', 'say', { to: 'codex', text: 'TASK-01 review: SSE reconnect drops events between the snapshot and the first streamed event.', kind: 'review', re: t1.id });
await act('codex', 'task.update', { id: t1.id, state: 'completed', result: 'fixed by replaying from ?since=' });
s = await state();
check('completion is not automatic acceptance', s.tasks['TASK-01'].history.some((h) => /returning/.test(h.note || '')));
check('validation feeds project health', s.health?.ok === true);
check('file activity is attributed', s.files.at(-1).by === 'codex');
check('task completes with a result', s.tasks['TASK-01'].state === 'completed');

// 7 — escalation and human intervention --------------------------------------
await act('claude', 'attention', { kind: 'decision', text: 'Do we build the city in three.js or Unity?', options: ['three.js', 'Unity'] });
s = await state();
const att = s.attention.at(-1);
check('escalation surfaces to the human', att.status === 'open' && att.kind === 'decision');

await human('/api/human/say', { to: ['claude'], text: 'three.js — I want it to open in a browser.' });
await human('/api/human/verdict', { target: att.id, verdict: 'approve', text: 'three.js' });
s = await state();
check('the human can answer an escalation', s.attention.at(-1).status === 'cleared');
check("the human's words reach the agent's inbox",
  (await (await fetch(`${base}/api/inbox?agent=claude`)).json()).items.some((i) => i.kind === 'human.message'));

await human('/api/human/control', { action: 'pause' });
check('the human can pause the studio', (await state()).paused === true);
await human('/api/human/control', { action: 'resume' });
check('the human can resume the studio', (await state()).paused === false);

store.append('human.control', null, {
  action: 'pause',
  text: 'historical pause replay',
  historical: true,
  originalTs: '2026-01-01T00:00:00.000Z',
  legacyDirectiveId: 'dir_fixture',
});
s = await state();
check('historical controls are auditable without pausing live work', s.paused === false && s.controls.at(-1).historical === true);

// 8 — levels of detail -------------------------------------------------------
s = await state();
check('level 1 — studio summary is derivable', Object.keys(s.tasks).length === 2 && s.decisions.length === 1);
check('level 3 — conversation is available', s.messages.length >= 5);
check('level 4 — timeline is chronological', s.timeline.every((t, i, a) => !i || t.seq > a[i - 1].seq));
const rawProbe = await (await fetch(`${base}/api/events?raw=false&limit=500`)).json();
check('level 5 — every action is a retrievable event', rawProbe.events.length >= 20);

// 9 — durability: a new process rebuilds the same world ----------------------
const before = await state();
const store2 = new (await import('../src/core/store.mjs')).Store();
check('state survives a restart', store2.getState().decisions.length === before.decisions.length);
check('tasks survive a restart', Object.keys(store2.getState().tasks).length === Object.keys(before.tasks).length);
check('conversation survives a restart', store2.getState().messages.length === before.messages.length);

// 10 — the log really is the source of truth ---------------------------------
const logLines = fs.readFileSync(path.join(tmp, '.studio', 'events.jsonl'), 'utf8').trim().split('\n');
check('every event is on disk as one line of JSON', logLines.length === before.seq, `${logLines.length} lines vs seq ${before.seq}`);
check('nothing in the log is unparseable', logLines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));

server.close();
console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
