#!/usr/bin/env node
/**
 * The human must be able to assign, reassign, request a debate, and request
 * review — four protocol interventions that had no control anywhere.
 *
 * These go through /api/human/*, not handleAction (which rejects 'human').
 * Every accepted action must leave a human.control event and a projected
 * task or debate. Every refusal must name what would have worked.
 *
 * This test used to pick 4500 + hrtime % 300 and poll until something
 * answered. That is the stranger-server hole Claude named. It now uses the
 * identity-checked harness: OS-assigned port, child announces itself, nonce
 * proved over HTTP before any assertion runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { startStudioServer, studioUrl, STUDIO_DIR } from './harness.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const boot = `
import { Store } from ${JSON.stringify(studioUrl('core/store.mjs'))};
import { createHttpServer } from ${JSON.stringify(studioUrl('server/server.mjs'))};
const store = new Store();
studioTestReady(store, createHttpServer(store, null));
`;

const server = await startStudioServer({ boot, prefix: 'studio-intervene-' });
const { get, post, stop } = server;

function uiHas(needle) {
  const html = fs.readFileSync(path.join(STUDIO_DIR, 'web', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(STUDIO_DIR, 'web', 'app.js'), 'utf8');
  return html.includes(needle) || js.includes(needle);
}

try {
  console.log('\nhuman intervention — four missing controls\n');

  check('UI has an assign-task form', uiHas('new-task-form') && uiHas('/api/human/task'));
  check('UI has a request-debate form', uiHas('new-debate-form') && uiHas('/api/human/debate'));
  check('task drawer can assign', uiHas('/api/human/assign'));
  check('task drawer can request review', uiHas('/api/human/review'));

  const missingTitle = await post('/api/human/task', { owner: 'grok' });
  check('creating a task without a title is refused', !!missingTitle.error && /title/.test(missingTitle.error || ''));

  const badOwner = await post('/api/human/task', { title: 'x', owner: 'claud' });
  check('creating a task for a non-agent is refused', !!badOwner.error && /owner/.test(badOwner.error || '') && /grok/.test(badOwner.error || ''));

  const created = await post('/api/human/task', { title: 'Fly the city', owner: 'grok', objective: 'proof' });
  check('human can create and assign a task', created.ok && created.id, JSON.stringify(created));
  let state = await get('/api/state');
  const t = state.tasks[created.id];
  check('new task is projected with the chosen owner', t?.owner === 'grok' && t.state === 'assigned');
  check('new task does not invent a phantom human agent', !state.agents.human);
  check(
    'assign wrote a human.control the new owner can see',
    state.timeline.some((x) => x.kind === 'human.control' && /assign/i.test(x.line) && x.data?.task === created.id),
  );

  const ghost = await post('/api/human/assign', { task: 'TASK-999', owner: 'claude' });
  check('assigning a task that does not exist is refused', !!ghost.error && /TASK-999/.test(ghost.error || ''));

  const reassigned = await post('/api/human/assign', { task: created.id, owner: 'claude' });
  check('reassign is a distinct action', reassigned.ok && reassigned.action === 'reassign');
  state = await get('/api/state');
  check('reassign moved the owner', state.tasks[created.id].owner === 'claude');
  check(
    'reassign records previousOwner on the event, not on the task',
    state.timeline.some((x) =>
      x.kind === 'task.updated'
      && x.data?.id === created.id
      && x.data?.previousOwner === 'grok'
      && x.data?.changes?.owner === 'claude',
    )
      && state.tasks[created.id].previousOwner == null,
  );

  const noQuestion = await post('/api/human/debate', { question: '   ' });
  check('an empty debate is refused', !!noQuestion.error && /question/.test(noQuestion.error || ''));

  const relatedGhost = await post('/api/human/debate', { question: 'Should we?', relatedTask: 'TASK-999' });
  check('a debate tied to a missing task is refused', !!relatedGhost.error && /TASK-999/.test(relatedGhost.error || ''));

  const debate = await post('/api/human/debate', { question: 'Is the control plane honest?', relatedTask: created.id });
  check('human can request a debate', debate.ok && /^DEB-/.test(debate.id || ''));
  state = await get('/api/state');
  check('the debate is open in the projection', state.debates[debate.id]?.status === 'open');
  check('the debate is not attributed to a phantom human agent', state.debates[debate.id]?.openedBy == null);
  check(
    'debate wrote a human.control everyone can see',
    state.timeline.some((x) => x.kind === 'human.control' && x.data?.action === 'debate'),
  );

  const review = await post('/api/human/review', { task: created.id, reviewer: 'codex' });
  check('human can request review', review.ok);
  state = await get('/api/state');
  const after = state.tasks[created.id];
  check('review moved the task to under-review', after.state === 'under-review' && after.reviewer === 'codex');

  const inbox = await get('/api/inbox?agent=codex');
  check(
    'the reviewer is told about the request',
    inbox.items.some((i) => i.kind === 'task.updated' && i.data?.id === created.id),
    JSON.stringify(inbox.items.map((i) => i.kind)),
  );

  const claudeInbox = await get('/api/inbox?agent=claude');
  check(
    'the new owner is told about the reassignment',
    claudeInbox.items.some((i) => i.kind === 'task.updated' && i.data?.id === created.id),
  );

  // TASK-18: grok is the previous owner. inbox() does not yet route on
  // previousOwner — that is Claude's half. This check only asserts the event
  // fact is on the wire so their inbox() change has something to match.
  const events = await get('/api/events?kinds=task.updated&limit=50');
  check(
    'the reassign event still names grok after the owner has changed',
    (events.events || []).some((ev) => ev.data?.id === created.id && ev.data?.previousOwner === 'grok'),
  );

  console.log(failures ? `\n${failures} FAILED\n` : '\nhuman-intervene ok\n');
  stop();
  // Not process.exit(): with the harness child's pipes still closing, Windows
  // aborts on a libuv UV_HANDLE_CLOSING assertion and returns 127 after printing
  // a clean pass, which makes the exit code useless to anything that checks it.
  process.exitCode = failures ? 1 : 0;
} catch (err) {
  console.error(err);
  stop();
  process.exitCode = 1;
}
