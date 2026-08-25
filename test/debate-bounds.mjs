#!/usr/bin/env node
/**
 * What stops a debate becoming the work.
 *
 * Debates ran forever on questions that did not matter, and the reason was not
 * the questions. Two studio rules combine into an amplifier: a position was
 * addressed to every agent that had not written it, so each one woke the rest of
 * the team; and the brief told every agent, every turn, that it had not stated a
 * position yet. Three agents sustain that indefinitely on delivery rules alone.
 * The topic never had to be worth arguing about, which is why the debates that
 * ran longest were the ones about the team's own conventions.
 *
 * So: a debate names the work it blocks, an exchange reaches the people in it,
 * and two rounds is the budget. The checks below are mostly about the parts that
 * could regress quietly — that opening and closing still reach everyone, that an
 * agent who joins starts hearing the argument, and that the brief stops inviting
 * a position the server would refuse.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-debate-'));
process.env.STUDIO_PROJECT_ROOT = tmp;

const { Store } = await import('../src/core/store.mjs');
const { handleAction } = await import('../src/server/server.mjs');
const { renderBrief } = await import('../src/agents/runner.mjs');
const { DEBATE_ROUNDS, positionLimit } = await import('../src/core/debate.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('');
console.log(`studio debate bounds  (state dir: ${tmp})`);
console.log('');

const store = new Store();
const act = (agent, verb, body = {}) => handleAction(store, { agent, verb, ...body });
const refusal = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.message;
  }
};
/**
 * How many times one debate woke an agent, without advancing its cursor.
 * Filtered by debate id, because every debate in this file shares an inbox.
 */
const woke = (agent, kind, debId) => store.inbox(agent, 0, { record: false }).items
  .filter((i) => i.kind === kind && i.data?.id === debId).length;

for (const agent of ['codex', 'claude', 'grok']) act(agent, 'register', { intro: 'hello' });

// --- before the board exists ----------------------------------------------
//
// The first real debate a team has is how to divide the work, and at that point
// there is nothing to attach it to. Requiring a task then would refuse the one
// debate most worth having.
const early = act('claude', 'debate.open', { question: 'do we build the log or the UI first?' });
check('a debate needs no task while the board is empty', early.id === 'DEB-01', JSON.stringify(early));
act('claude', 'debate.close', { id: early.id, outcome: 'log first' });

// --- once there is work -----------------------------------------------------
const task = act('codex', 'task.create', { title: 'event log', objective: 'append-only' });
const loose = refusal(() => act('grok', 'debate.open', { question: 'should docs use sentence case?' }));
check('a debate that names no task is refused once tasks exist', Boolean(loose), loose);
check('...and the refusal offers the cheaper channel', /concern/.test(loose || ''), loose);
const ghostTask = refusal(() => act('grok', 'debate.open', { question: 'x', relatedTask: 'TASK-99' }));
check('...and a task that does not exist is still refused', Boolean(ghostTask), ghostTask);

const deb = act('claude', 'debate.open', { question: 'fsync every append?', relatedTask: task.id });
check('a debate that names its task is accepted', deb.id === 'DEB-02', JSON.stringify(deb));

// --- who gets woken ---------------------------------------------------------
check('opening a debate reaches the whole team',
  woke('codex', 'debate.opened', deb.id) === 1 && woke('grok', 'debate.opened', deb.id) === 1);

act('codex', 'debate.position', { id: deb.id, stance: 'yes, durability beats throughput here' });
check('a position reaches the agent who opened it', woke('claude', 'debate.position', deb.id) === 1);
check('...and NOT an agent who is not in the debate', woke('grok', 'debate.position', deb.id) === 0,
  `grok was woken by an argument it is not part of (${woke('grok', 'debate.position', deb.id)})`);

act('grok', 'debate.position', { id: deb.id, stance: 'only on the last write of a turn' });
check('an agent that joins starts hearing the argument', woke('grok', 'debate.position', deb.id) === 1,
  'grok posted a position and still hears nothing');
check('...and everyone already in it hears the new one', woke('codex', 'debate.position', deb.id) === 1);

// --- the budget -------------------------------------------------------------
const limit = positionLimit();
check(`the budget is ${DEBATE_ROUNDS} rounds of the roster`, limit === DEBATE_ROUNDS * 3, String(limit));
let posted = store.state.debates[deb.id].positions.length;
const speakers = ['codex', 'claude', 'grok'];
let capped = null;
for (let i = posted; i < limit + 2; i++) {
  const err = refusal(() => act(speakers[i % 3], 'debate.position', { id: deb.id, stance: `round ${i}` }));
  if (err) { capped = err; break; }
  posted++;
}
check('a debate runs out of rounds instead of running forever', Boolean(capped), `${posted} positions went in`);
check('...at exactly the budget', posted === limit, `${posted} of ${limit}`);
check('...and the refusal names both ways out', /close/.test(capped || '') && /attention|human/.test(capped || ''), capped);

// --- the brief must stop asking for what the server refuses -----------------
const brief = renderBrief('codex', store.getState());
check('the brief marks a spent debate', brief.includes('ROUND LIMIT REACHED'), brief.split('\n').filter((l) => l.includes(deb.id)).join(' | '));

// --- and it can still end ---------------------------------------------------
const closed = act('claude', 'debate.close', { id: deb.id, outcome: 'fsync every append; revisit if it shows up in a profile' });
check('a spent debate can still be closed', closed.ok === true, JSON.stringify(closed));
check('closing reaches the whole team, in it or not',
  woke('codex', 'debate.closed', deb.id) === 1 && woke('grok', 'debate.closed', deb.id) === 1);
check('and a position after the close is refused as closed, not as spent',
  /closed/.test(refusal(() => act('codex', 'debate.position', { id: deb.id, stance: 'one more' })) || ''));

console.log('');
console.log(failures ? `${failures} FAILED` : 'debate-bounds ok');
process.exitCode = failures ? 1 : 0;
