/**
 * An agent must not lose its messages because its turn died.
 *
 * The inbox cursor used to advance the moment an agent *read* its inbox. An
 * agent that crashed, was killed, or hit a provider error after the read had
 * already been marked as having seen those messages, so they were never
 * delivered again — to it or to anyone — and nobody was told. For a studio whose
 * entire product is observable communication, a message that is reported
 * delivered and reaches no one is the worst failure available.
 *
 * The cursor is now two cursors: `delivered` (what an agent was shown) and
 * `acked` (what a completed turn confirmed it handled). Only `acked` drops
 * items. Both are events in the log, so they survive a restart — the old
 * .studio/cursors.json was written and never read back, which meant every
 * restart silently replayed the entire history at every agent.
 *
 * Run: node test/inbox-ack.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// harness.mjs deliberately imports nothing from studio/core, so pulling it in
// here does not freeze PROJECT_ROOT before the line below sets it.
import { startStudioServer, studioUrl } from './harness.mjs';

/**
 * Where a studio rooted at `root` keeps its log, under either layout.
 *
 * Local rather than imported from paths.mjs: that module resolves against this
 * process's own project root, and the studio under test is a child with a
 * different one.
 */
const eventLogFor = (root) => (
  fs.existsSync(path.join(root, 'studio_floor'))
    ? path.join(root, 'studio_floor', 'state', 'events.jsonl')
    : path.join(root, '.studio', 'events.jsonl')
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-inbox-'));
process.env.STUDIO_PROJECT_ROOT = root;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const { Store } = await import(studioUrl('core/store.mjs'));
const { isTimeline } = await import(studioUrl('core/events.mjs'));

console.log('inbox acknowledgement');

// --------------------------------------------------------------- in-process

let store = new Store();

const baselines = store.events.filter((e) => e.kind === 'inbox.acked' && e.data.baseline);
check('a fresh store baselines every agent once', baselines.length === 3, `${baselines.length} baseline acks`);
check(
  'baselines are recorded in the log, not a side file',
  baselines.every((e) => typeof e.seq === 'number'),
);

const sent = store.append('message.sent', 'codex', { from: 'codex', to: ['claude'], text: 'review this', kind: 'review' });

let box = store.inbox('claude');
check('a message to claude reaches claude', box.items.some((i) => i.seq === sent.seq));
check('a first delivery is not flagged as a redelivery', box.items.every((i) => !i.redelivered));
check('the sender does not get their own message back', !store.inbox('codex').items.some((i) => i.seq === sent.seq));

// The turn starts: the agent is shown the item.
store.markDelivered('claude', box.cursor, box.items.length);

// ---- THE BUG. The turn now dies without acknowledging anything.
box = store.inbox('claude');
check(
  'being SHOWN a message does not remove it from the inbox',
  box.items.some((i) => i.seq === sent.seq),
  'the crashed turn lost the message — this is the TASK-14 regression',
);
check('the redelivered item says so', box.items.find((i) => i.seq === sent.seq)?.redelivered === true);
check('the redelivery count is reported', box.redelivered === 1, String(box.redelivered));

// ---- A turn that actually completes acknowledges.
store.ack('claude', box.cursor, 'turn completed');
box = store.inbox('claude');
check('an acknowledged message leaves the inbox', !box.items.some((i) => i.seq === sent.seq));

// ---- An agent cannot acknowledge past what it was shown.
const later = store.append('message.sent', 'grok', { from: 'grok', to: ['claude'], text: 'and this', kind: 'chat' });
const res = store.ack('claude', later.seq + 500, 'overreach');
check('acknowledging past what was delivered is refused', res.clamped === true);
check(
  'the message the agent was never shown survives the overreach',
  store.inbox('claude').items.some((i) => i.seq === later.seq),
);

// ---- Bookkeeping is durable but invisible.
check('inbox bookkeeping is not in any agent inbox', !store.inbox('grok').items.some((i) => i.kind.startsWith('inbox.')));
check('inbox bookkeeping is not in the human timeline', !isTimeline('inbox.delivered') && !isTimeline('inbox.acked'));
check(
  'inbox bookkeeping IS in the log on disk',
  fs.readFileSync(eventLogFor(root), 'utf8').includes('"inbox.acked"'),
);

// ---- The human's interventions must actually arrive, with their words intact.
// The "Needs you" panel sends verdicts targeting an attention id. That target is
// neither an agent nor a task, so the old ownership test made it relevant to
// nobody: the human pressed approve and the decision reached no one.
const verdict = store.append('human.verdict', null, { target: 'ATT-7', verdict: 'approve', text: 'ship it' });
for (const id of ['codex', 'claude', 'grok']) {
  check(
    `a verdict on an attention record reaches ${id}`,
    store.inbox(id).items.some((i) => i.seq === verdict.seq),
  );
}
check(
  "the human's words survive into the line agents are handed",
  store.inbox('claude').items.find((i) => i.seq === verdict.seq)?.line.includes('ship it'),
  store.inbox('claude').items.find((i) => i.seq === verdict.seq)?.line,
);

const blankVerdict = store.append('human.verdict', null, { target: 'ATT-8', verdict: 'reject', text: '' });
check(
  'a verdict with a blank note still reaches every agent',
  ['codex', 'claude', 'grok'].every((id) => store.inbox(id).items.some((i) => i.seq === blankVerdict.seq)),
);

const detailedPriority = store.append('human.control', null, {
  action: 'priority',
  text: 'finish the current slice\nTASK-15-SECOND-LINE-MUST-REACH-THE-AGENT',
});
check(
  'multi-line human reasoning survives into the line agents are handed',
  store.inbox('claude').items
    .find((i) => i.seq === detailedPriority.seq)
    ?.line.includes('TASK-15-SECOND-LINE-MUST-REACH-THE-AGENT'),
  store.inbox('claude').items.find((i) => i.seq === detailedPriority.seq)?.line,
);

const stop = store.append('human.control', null, { action: 'stop', target: 'grok', text: 'you are looping' });
check('a control aimed at one agent reaches that agent', store.inbox('grok').items.some((i) => i.seq === stop.seq));
check('a control aimed at one agent does not go to the others', !store.inbox('codex').items.some((i) => i.seq === stop.seq));
check(
  'the reason for a stop is not discarded',
  store.inbox('grok').items.find((i) => i.seq === stop.seq)?.line.includes('you are looping'),
);

const priority = store.append('human.control', null, { action: 'priority', text: 'finish the studio first' });
check(
  'an untargeted control reaches everyone',
  ['codex', 'claude', 'grok'].every((id) => store.inbox(id).items.some((i) => i.seq === priority.seq)),
);

// ---- Restart. Cursors must be reconstructed from the log.
const ackedBefore = store.state.cursors.claude.acked;
const pendingBefore = store.inbox('claude').items.length;
store.close();
store = new Store();
check(
  'a restart reconstructs the acknowledgement cursor from the log',
  store.state.cursors.claude?.acked === ackedBefore,
  `${JSON.stringify(store.state.cursors.claude)} vs acked ${ackedBefore}`,
);
check(
  'a restart does not replay already-handled history at the agent',
  store.inbox('claude').items.length === pendingBefore,
  `${store.inbox('claude').items.length} items after restart, ${pendingBefore} before`,
);
check('a restart does not re-baseline', store.events.filter((e) => e.data?.baseline).length === 3);

// ---- The legacy read-is-acknowledgement path still works for old callers.
const legacySeq = store.seq;
store.markRead('grok', legacySeq);
check('legacy markRead still acknowledges', store.state.cursors.grok.acked === legacySeq);

// -------------------------------------------------------------- over HTTP

// This half is where the defect bit hardest. The port used to be
// 4300 + hrtime % 300, overlapping stream-gap's and validation's ranges, and the
// test then polled until *something* answered. When the port was already held,
// this child died with EADDRINUSE and every check below ran against a stranger
// with an empty inbox — the three failures another agent saw in a full-suite run
// that passed in isolation. The harness takes an OS-assigned port and refuses to
// return until the server answering it has proved it is our child.
const boot = `
import { Store } from ${JSON.stringify(studioUrl('core/store.mjs'))};
import { createHttpServer } from ${JSON.stringify(studioUrl('server/server.mjs'))};
const s = new Store();
s.append('message.sent', 'codex', { from: 'codex', to: ['claude'], text: 'over http', kind: 'chat' });
studioTestReady(s, createHttpServer(s, null));
`;
const server = await startStudioServer({ boot, prefix: 'studio-inbox-http-' });
const { get, post } = server;

const first = await get(`/api/inbox?agent=claude`);
check('http: the message is in the inbox', first.items.length === 1, JSON.stringify(first.items.map((i) => i.kind)));

await post('/api/inbox/delivered', { agent: 'claude', through: first.cursor, count: first.items.length });
const second = await get(`/api/inbox?agent=claude`);
check('http: /delivered does not empty the inbox', second.items.length === 1);
check('http: /delivered marks the item as a redelivery', second.items[0]?.redelivered === true);

const overreach = await post('/api/inbox/ack', { agent: 'claude', through: second.cursor + 1000 });
check('http: /ack refuses to acknowledge past what was delivered', overreach.clamped === true);

await post('/api/inbox/ack', { agent: 'claude', through: first.cursor, reason: 'test turn completed' });
const third = await get(`/api/inbox?agent=claude`);
check('http: /ack empties the inbox', third.items.length === 0, JSON.stringify(third.items.map((i) => i.line)));

// The ack clamp is only meaningful if /delivered cannot itself move into the
// future. A typo or stale client must not be able to acknowledge messages that
// do not exist yet and silently hide them when they are later appended.
const future = third.cursor + 1000;
const forgedDelivery = await post('/api/inbox/delivered', {
  agent: 'claude',
  through: future,
  count: 0,
});
check(
  'http: /delivered cannot advance beyond the current log head',
  forgedDelivery.delivered <= third.cursor,
  JSON.stringify({ cursor: third.cursor, delivered: forgedDelivery.delivered }),
);
await post('/api/inbox/ack', { agent: 'claude', through: future, reason: 'future-cursor attack' });
const futureMessage = await post('/api/action', {
  agent: 'codex',
  verb: 'say',
  to: ['claude'],
  text: 'this was appended after the forged cursor',
});
const afterFuture = await get(`/api/inbox?agent=claude`);
check(
  'http: a forged future cursor cannot hide a later message',
  afterFuture.items.some((item) => item.seq === futureMessage.seq),
  JSON.stringify({ message: futureMessage.seq, acked: afterFuture.acked, delivered: afterFuture.delivered }),
);

// The stronger invariant codex asked for on review, and the case his reproduction
// above does not reach. Clamping to the log head only defeats a cursor pointing
// past the end of the log. It does nothing about a message that ALREADY EXISTS and
// has simply not been shown: by the time the forged POST arrives the head has moved
// past it, so the head clamp happily covers it. A cursor may only cover what this
// server actually handed this agent.
const snapshot = await get('/api/inbox?agent=claude');
const unseen = await post('/api/action', {
  agent: 'codex',
  verb: 'say',
  to: ['claude'],
  text: 'appended after the snapshot, before the forged cursor',
});
const beyondSnapshot = await post('/api/inbox/delivered', {
  agent: 'claude',
  through: snapshot.cursor + 1000,
});
check(
  'http: /delivered cannot cover a message that existed but was never shown',
  beyondSnapshot.delivered < unseen.seq,
  JSON.stringify({ shownThrough: snapshot.cursor, unseenAt: unseen.seq, delivered: beyondSnapshot.delivered }),
);
await post('/api/inbox/ack', { agent: 'claude', through: snapshot.cursor + 1000 });
const stillThere = await get(`/api/inbox?agent=claude`);
check(
  'http: an unshown message survives a forged delivered+ack pair',
  stillThere.items.some((item) => item.seq === unseen.seq),
  JSON.stringify({ want: unseen.seq, got: stillThere.items.map((i) => i.seq) }),
);

const bogus = await post('/api/inbox/ack', { agent: 'clude', through: 1 });
check('http: /ack refuses an unknown agent instead of silently succeeding', bogus.ok === false, JSON.stringify(bogus));
const bogusDeliver = await post('/api/inbox/delivered', { agent: 'clude', through: 1 });
check('http: /delivered refuses an unknown agent', bogusDeliver.ok === false, JSON.stringify(bogusDeliver));

server.stop();
console.log(failures ? `\n${failures} FAILED` : '\nall inbox acknowledgement checks passed');
// Stop the child and let the loop drain. process.exit() with the harness child
// still live aborts on Windows (libuv UV_HANDLE_CLOSING) and returns 127 after
// printing a clean pass, so the exit code stops meaning anything.
server.stop();
process.exitCode = failures ? 1 : 0;
