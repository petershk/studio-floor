#!/usr/bin/env node
// TASK-18: the agent whose task was taken away must be told.
//
// Before this, humanAssign woke the losing agent through the runner, but nothing
// reached its INBOX — and the runner's wake is lost the moment the process is not
// running. An agent that comes back from a crashed turn would keep working a task
// that is no longer its own and never learn otherwise.
import { startStudioServer, studioUrl } from './harness.mjs';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (ok || !detail ? '' : ' — ' + detail));
  if (!ok) failures++;
};

const boot = [
  'import { Store } from ' + JSON.stringify(studioUrl('core/store.mjs')) + ';',
  'import { createHttpServer } from ' + JSON.stringify(studioUrl('server/server.mjs')) + ';',
  'const store = new Store();',
  'studioTestReady(store, createHttpServer(store, null));',
].join('\n');

const server = await startStudioServer({ boot, prefix: 'studio-reassign-' });
const { get, post } = server;
const act = (p) => post('/api/action', p);
const inboxOf = async (agent) => (await get(`/api/inbox?agent=${agent}`)).items ?? [];
// The real protocol: reading does not advance the cursor (TASK-14). An agent
// marks what it was handed delivered, then acks it.
const drain = async (agent) => {
  const items = await inboxOf(agent);
  const last = items.at(-1)?.seq;
  if (last) await post('/api/inbox/delivered', { agent, through: last });
  await post('/api/inbox/ack', { agent });
};

for (const agent of ['claude', 'grok']) await act({ agent, verb: 'join', strengths: ['x'], intro: 'i' });
const task = (await act({ agent: 'grok', verb: 'task.create', title: 'grok work', owner: 'grok' })).id;

// Drain both inboxes so what follows is only the reassignment.
for (const agent of ['claude', 'grok']) await drain(agent);

await post('/api/human/assign', { task, owner: 'claude', text: 'claude is closer to this' });

const grokInbox = await inboxOf('grok');
const claudeInbox = await inboxOf('claude');
const mentions = (items) => items.filter((i) => JSON.stringify(i.data).includes(task));

check('the incoming owner is told', mentions(claudeInbox).length > 0, `${claudeInbox.length} items`);
check('the OUTGOING owner is told', mentions(grokInbox).length > 0,
  `grok got ${grokInbox.length} items, ${mentions(grokInbox).length} about ${task}`);

const grokEvents = mentions(grokInbox);
check('the outgoing owner sees who it went to',
  grokEvents.some((i) => JSON.stringify(i.data).includes('claude')),
  JSON.stringify(grokEvents.map((i) => i.kind)));
check('previousOwner rides on the event, not on the task',
  grokEvents.some((i) => i.data.previousOwner === 'grok'),
  JSON.stringify(grokEvents.map((i) => i.data.previousOwner ?? null)));

const state = await get('/api/state');
check('previousOwner did not leak onto the task itself',
  state.tasks[task].previousOwner === undefined,
  JSON.stringify(state.tasks[task].previousOwner ?? null));
check('the task really moved', state.tasks[task].owner === 'claude', state.tasks[task].owner);

// grok's review note: the outgoing owner was told, but the one-line summary said
// "reassign claude" and never "taken from you". Agents are handed only that line.
const lines = grokEvents.map((i) => i.line ?? '');
check('the summary line says it was taken from the outgoing owner',
  lines.some((l) => /taken from grok/i.test(l)),
  JSON.stringify(lines));
check('the summary line names the task',
  lines.some((l) => l.includes(task)),
  JSON.stringify(lines));

// A plain owner-less update must not spam the previous owner forever.
await drain('grok');
await act({ agent: 'claude', verb: 'task.update', id: task, note: 'ordinary progress' });
check('an ordinary later update does not re-notify the old owner',
  mentions(await inboxOf('grok')).length === 0,
  `${mentions(await inboxOf('grok')).length} items`);

console.log(`\n${failures === 0 ? 'reassign-notice: all checks passed' : `reassign-notice: ${failures} FAILED`}`);
// Stop the child and let the loop drain rather than calling process.exit(),
// which aborted on Windows with a libuv UV_HANDLE_CLOSING assertion and turned a
// clean pass into exit 127.
server.stop();
process.exitCode = failures ? 1 : 0;
