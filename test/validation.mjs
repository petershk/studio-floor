/**
 * An action the studio accepts must leave a trace.
 *
 * Every projection case in store.mjs guards defensively — `if (!x) break` — so
 * before these checks existed the server would accept a position on a debate
 * that never existed, a message to an agent that is not here, or a task moved
 * to a state no board column renders. Each returned ok, appended an event, and
 * then vanished from every view. The agent believed it acted; the record said
 * it never did.
 *
 * These checks assert the opposite invariant: if the server said ok, the human
 * can see it; and if it could not, the agent was told why and what would work.
 */
import { startStudioServer, studioUrl } from './harness.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

/** The action must be refused, and the refusal must name what would have worked. */
async function refuses(name, body, mustMention) {
  const r = await act(body);
  const said = String(r.error || '');
  const ok = !!r.error && mustMention.every((m) => said.includes(m));
  check(name, ok, r.error ? `message was: ${said.split('\n')[0]}` : `accepted with seq ${r.seq}`);
}

async function accepts(name, body) {
  const r = await act(body);
  check(name, !!r.ok, r.error);
  return r;
}

const boot = `
import { Store } from ${JSON.stringify(studioUrl('core/store.mjs'))};
import { createHttpServer } from ${JSON.stringify(studioUrl('server/server.mjs'))};
const store = new Store();
studioTestReady(store, createHttpServer(store, null));
`;

// The harness starts the child on an OS-assigned port and does not return until
// the child has announced that port itself and proved the server answering on it
// is the one we started. A test about refusals is worthless if the refusals came
// from somebody else's server.
const server = await startStudioServer({ boot, prefix: 'studio-valid-' });
const { get, post } = server;

try {
  await accepts('a real agent can register', { verb: 'register', agent: 'claude', intro: 'validation test' });

  console.log('\n identity');
  await refuses('an unknown agent id is refused', { verb: 'say', agent: 'claud', text: 'hi' },
    ['unknown agent', 'codex, claude, grok']);
  await refuses('the CLI default of "unknown" is refused rather than becoming a phantom agent',
    { verb: 'say', agent: 'unknown', text: 'hi' }, ['STUDIO_AGENT']);
  await refuses('a missing agent is refused', { verb: 'note', text: 'x' }, ['unknown agent']);
  await refuses('an invalid agent state is refused', { verb: 'state', agent: 'claude', state: 'busy' },
    ['invalid agent state', 'reviewing']);

  console.log('\n messages');
  await refuses('a message to an agent who is not here is refused',
    { verb: 'say', agent: 'claude', to: 'grokk', text: 'hi' }, ['unknown recipient', 'grok']);
  await accepts('a message to the human is allowed', { verb: 'say', agent: 'claude', to: 'human', text: 'hi' });
  await refuses('an invalid message kind is refused',
    { verb: 'say', agent: 'claude', text: 'hi', kind: 'shouting' }, ['invalid message kind', 'challenge']);

  console.log('\n tasks');
  const t = await accepts('a task can be created', {
    verb: 'task.create', agent: 'claude', title: 'real task', objective: 'exist', owner: 'codex',
  });
  await refuses('a task owned by a non-agent is refused — nobody would ever be told',
    { verb: 'task.create', agent: 'claude', title: 'x', objective: 'y', owner: 'nobody' }, ['unknown owner']);
  await refuses('a dependency on a task that does not exist is refused',
    { verb: 'task.create', agent: 'claude', title: 'x', objective: 'y', deps: 'TASK-99' },
    ['no such dependency', t.id]);
  await refuses('a task state no board column renders is refused',
    { verb: 'task.update', agent: 'claude', id: t.id, state: 'done' },
    ['invalid task state', 'completed']);
  await refuses('updating a task that does not exist is refused',
    { verb: 'task.update', agent: 'claude', id: 'TASK-99', state: 'active' }, ['no such task', t.id]);
  await refuses('reporting work against a task that does not exist is refused',
    { verb: 'validation', agent: 'claude', name: 'x', ok: true, task: 'TASK-99' }, ['no such task']);
  await refuses('claiming to work on a task that does not exist is refused',
    { verb: 'state', agent: 'claude', state: 'working', task: 'TASK-99' }, ['no such task']);

  console.log('\n debates and questions');
  const deb = await accepts('a debate can be opened', { verb: 'debate.open', agent: 'claude', question: 'real?' });
  await refuses('a position on a debate that does not exist is refused',
    { verb: 'debate.position', agent: 'claude', id: 'DEB-99', stance: 'x' }, ['no such debate', deb.id]);
  await accepts('a position on an open debate is recorded',
    { verb: 'debate.position', agent: 'claude', id: deb.id, stance: 'yes', because: 'reasons' });
  await accepts('the debate can be closed', { verb: 'debate.close', agent: 'claude', id: deb.id, outcome: 'settled' });
  await refuses('a position on a closed debate is refused',
    { verb: 'debate.position', agent: 'codex', id: deb.id, stance: 'late' }, ['already', 'closed']);
  await refuses('closing an already-closed debate is refused',
    { verb: 'debate.close', agent: 'codex', id: deb.id, outcome: 'again' }, ['already', 'closed']);
  const deb2 = await accepts('a second debate can be opened',
    { verb: 'debate.open', agent: 'claude', question: 'is an empty position a position?' });
  await refuses('answering a question that does not exist is refused',
    { verb: 'question.close', agent: 'claude', id: 'Q-99', answer: 'x' }, ['no such question']);

  // WITNESSED THIS SESSION, not hypothetical. grok-imp posted a DEB-04 position
  // whose stance, because and critique were all empty strings. The server said
  // ok, the brief listed them as having taken a position, and their argument was
  // gone. Nobody noticed until someone read the raw event log.
  //
  // That is the same failure this whole file exists to prevent, one field deeper
  // than the case above: the record says an agent spoke and it said nothing. A
  // debate is the studio's mechanism for disagreeing well, so a position with no
  // content is worse than a refusal — it makes the debate look settled.
  await refuses('a position with nothing in it is refused rather than recorded as silence',
    { verb: 'debate.position', agent: 'claude', id: deb2.id }, ['stance']);
  await refuses('whitespace is not an argument either',
    { verb: 'debate.position', agent: 'claude', id: deb2.id, stance: '   ' }, ['stance']);
  await accepts('a position with only a stance is still a position',
    { verb: 'debate.position', agent: 'claude', id: deb2.id, stance: 'yes' });

  // Same shape, higher stakes: a decision appears in every brief under "do not
  // reopen without new information". One with no chosen option is an instruction
  // to future turns that says nothing and cannot be argued with.
  await refuses('a decision that chose nothing is refused',
    { verb: 'decision', agent: 'claude', question: 'which?' }, ['chosen']);
  await refuses('a debate nobody can answer is refused',
    { verb: 'debate.open', agent: 'claude', question: '  ' }, ['question']);

  console.log('\n human attention');
  await refuses('an attention item pointing at a task that does not exist is refused',
    { verb: 'attention', agent: 'claude', kind: 'review', text: 'look', ref: 'TASK-99' }, ['no such task']);
  await accepts('an attention item pointing at a real task is allowed',
    { verb: 'attention', agent: 'claude', kind: 'review', text: 'look', ref: t.id });

  console.log('\n the invariant');
  const s = await get('/api/state');
  const events = (await get('/api/events?limit=1000')).events;
  const refused = events.filter((e) => e.kind === 'debate.position' && e.data.stance === 'late');
  check('no refused action reached the log', refused.length === 0, `${refused.length} leaked`);
  const positions = s.debates[deb.id].positions.length;
  check('every accepted position is visible in the projection', positions === 1, `${positions} positions`);
  const orphans = events.filter((e) => e.kind === 'task.updated' && !s.tasks[e.data.id]);
  check('no event in the log references a task the projection does not have', orphans.length === 0,
    JSON.stringify(orphans.map((e) => e.data.id)));
} finally {
  server.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
// Stop the child and let the loop drain. process.exit() with the harness child
// still live aborts on Windows (libuv UV_HANDLE_CLOSING) and returns 127 after
// printing a clean pass, so the exit code stops meaning anything.
server.stop();
process.exitCode = failures ? 1 : 0;

// ---------------------------------------------------------------- helpers

// A refused action answers 500 with its reason in the body, and that reason is
// exactly what these checks read, so this must not throw on a non-2xx.
async function act(body) {
  return post('/api/action', body);
}
