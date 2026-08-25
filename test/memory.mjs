#!/usr/bin/env node
/**
 * Memory — the only thing an agent still has when its session is gone.
 *
 * Every other durable thing in this studio is a record of something that
 * happened. Memory is a small curated set of lines the team chooses to be handed
 * back on every future turn, and it exists for the case nothing else covers: a
 * vendor session is compacted, expires, or is lost, the agent comes back knowing
 * only what the brief tells it, and the brief has to still contain what the team
 * learned.
 *
 * So these checks are mostly about the properties that make that true — it
 * survives a rebuild from the log, it reaches the right agent's brief and not
 * the wrong one's, it stays small, and nothing it refuses is written anyway.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-memory-'));
process.env.STUDIO_PROJECT_ROOT = tmp;

const { Store } = await import('../src/core/store.mjs');
const { handleAction } = await import('../src/server/server.mjs');
const { renderBrief } = await import('../src/agents/runner.mjs');
const { describe, isTimeline } = await import('../src/core/events.mjs');
const { MEMORY_LIMITS, memoryFor } = await import('../src/core/memory.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('');
console.log(`studio memory  (state dir: ${tmp})`);
console.log('');

let store = new Store();
const act = (agent, verb, body = {}) => handleAction(store, { agent, verb, ...body });
/** The message of the refusal, or null if it was allowed through. */
const refusal = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.message;
  }
};
const active = () => store.getState().memory.filter((m) => !m.forgotten);

for (const agent of ['claude', 'grok']) act(agent, 'register', { intro: 'hello' });

// --- what it keeps --------------------------------------------------------
const team = act('claude', 'memory', { text: 'the suite is npm test from the repo root; it fails from test/' });
check('remembering returns the id', team.id === 'MEM-01', JSON.stringify(team));
check('team is the default scope', active()[0].scope === 'team', active()[0].scope);

const mine = act('claude', 'memory', { scope: 'self', text: 'I keep reaching for src/studio.mjs; it is src/cli/studio.mjs' });
const theirs = act('grok', 'memory', { scope: 'self', text: 'read the adapter before claiming a vendor bug' });
const human = act('grok', 'memory', { scope: 'human', text: 'wants the failing output pasted, not summarised' });
check('every scope is accepted', [mine, theirs, human].every((r) => r.ok), JSON.stringify([mine, theirs, human]));

// --- who is handed what ---------------------------------------------------
const claudeBrief = renderBrief('claude', store.getState());
const grokBrief = renderBrief('grok', store.getState());
check('the brief carries team memory', claudeBrief.includes('npm test from the repo root'));
check('...and the human scope', claudeBrief.includes('not summarised'));
check('...and your own notes', claudeBrief.includes('src/cli/studio.mjs'));
check("...but not another agent's notes", !claudeBrief.includes('claiming a vendor bug'), 'a private note reached the wrong brief');
check('and the other agent gets the mirror image', grokBrief.includes('claiming a vendor bug') && !grokBrief.includes('src/cli/studio.mjs'));
check('memory sits above the work, where a clipped brief cannot lose it',
  claudeBrief.indexOf('Memory (') < claudeBrief.indexOf('Tasks:'),
  `memory at ${claudeBrief.indexOf('Memory (')}, tasks at ${claudeBrief.indexOf('Tasks:')}`);

// --- revising it ----------------------------------------------------------
const replaced = act('claude', 'memory', { replaces: 'MEM-01', text: 'the suite is npm test from the repo root, and it takes about a minute' });
check('a replacement is one event, not a delete and an add', replaced.id === 'MEM-05', replaced.id);
const gone = store.getState().memory.find((m) => m.id === 'MEM-01');
check('the replaced entry is marked forgotten', gone.forgotten === true);
check('...and says what replaced it', gone.forgottenReason === 'replaced by MEM-05', gone.forgottenReason);
check('...and is not deleted from the projection', Boolean(gone.text));
const afterReplace = renderBrief('claude', store.getState());
check('only the new text is handed to the next turn',
  afterReplace.includes('about a minute') && !afterReplace.includes('it fails from test/'));

const forgotten = act('grok', 'memory.forget', { id: human.id, reason: 'they asked for summaries instead' });
check('forgetting works', forgotten.ok === true);
check('...and drops it out of every brief', !renderBrief('claude', store.getState()).includes('not summarised'));
check('...while the record stays for the human to see',
  store.getState().memory.some((m) => m.id === human.id && m.forgottenBy === 'grok'));

// --- what it refuses ------------------------------------------------------
const before = store.getState().memory.length;

check('empty text is refused', Boolean(refusal(() => act('claude', 'memory', { text: '   ' }))));
const long = refusal(() => act('claude', 'memory', { text: 'x'.repeat(MEMORY_LIMITS.entry + 1) }));
check('an entry over the size limit is refused', Boolean(long), long);
check('...and the refusal names the limit and the alternative',
  long.includes(String(MEMORY_LIMITS.entry)) && /decide|discover/.test(long), long);
check('an unknown scope is refused', Boolean(refusal(() => act('claude', 'memory', { scope: 'private', text: 'x' }))));

const cross = refusal(() => act('claude', 'memory', { replaces: mine.id, scope: 'team', text: 'x' }));
check('a replacement cannot move an entry between budgets', Boolean(cross), cross);

const noReason = refusal(() => act('claude', 'memory.forget', { id: mine.id, reason: '  ' }));
check('forgetting needs a reason', Boolean(noReason), noReason);

const ghost = refusal(() => act('claude', 'memory.forget', { id: 'MEM-99', reason: 'x' }));
check('an unknown id is refused and lists what is held', Boolean(ghost) && ghost.includes('MEM-02'), ghost);

const twice = refusal(() => act('grok', 'memory.forget', { id: human.id, reason: 'again' }));
check('forgetting twice is refused and names who did it first', Boolean(twice) && twice.includes('grok'), twice);

const notYours = refusal(() => act('grok', 'memory.forget', { id: mine.id, reason: 'looks wrong to me' }));
check("an agent cannot rewrite another agent's own note", Boolean(notYours) && notYours.includes('claude'), notYours);
const sharedByOther = act('grok', 'memory.forget', { id: replaced.id, reason: 'the timing is no longer true' });
check("...but shared memory belongs to the team, so anyone may revise it", sharedByOther.ok === true);

check('every refusal appended nothing', store.getState().memory.length === before,
  `${store.getState().memory.length} entries, expected ${before}`);

// --- staying small --------------------------------------------------------
//
// The limit is enforced by refusing the write, not by evicting the oldest entry:
// which line no longer matters is a judgement, and making it silently is how a
// team loses the one it needed.
let filled = 0;
let full = null;
for (let i = 0; i < MEMORY_LIMITS.entries + 2; i++) {
  const err = refusal(() => act('claude', 'memory', { text: `filler ${i} `.padEnd(MEMORY_LIMITS.entry, 'y') }));
  if (err) { full = err; break; }
  filled++;
}
check('a scope fills up rather than growing without bound', Boolean(full), `${filled} entries went in`);
check('...and the refusal names what could go instead', Boolean(full) && full.includes('MEM-0'), full);
check('...and a different scope is unaffected by it',
  act('claude', 'memory', { scope: 'self', text: 'self is budgeted separately' }).ok === true);
check('...and so is the other agents own notebook',
  act('grok', 'memory', { scope: 'self', text: 'every agent gets its own budget' }).ok === true);

// --- the human can see it happening ---------------------------------------
const recorded = store.events.find((e) => e.kind === 'memory.recorded');
check('remembering is in the timeline, not hidden bookkeeping', isTimeline('memory.recorded') && isTimeline('memory.forgotten'));
check('and reads as an agent action', describe(recorded).startsWith('claude remembered MEM-01 [team]'), describe(recorded));
const forgetEvent = store.events.find((e) => e.kind === 'memory.forgotten');
check('forgetting reads as one too', describe(forgetEvent).includes('forgot'), describe(forgetEvent));

// --- the point of the whole feature ---------------------------------------
const beforeRestart = memoryFor(store.getState(), 'claude').map((m) => `${m.id}:${m.scope}:${m.text}`);
const forgottenBefore = store.getState().memory.filter((m) => m.forgotten).length;
store.close();
store = new Store();
const afterRestart = memoryFor(store.getState(), 'claude').map((m) => `${m.id}:${m.scope}:${m.text}`);
check('memory is rebuilt from the log alone, entry for entry',
  JSON.stringify(beforeRestart) === JSON.stringify(afterRestart),
  `${beforeRestart.length} before, ${afterRestart.length} after`);
check('...including which entries were forgotten',
  store.getState().memory.filter((m) => m.forgotten).length === forgottenBefore && forgottenBefore === 3,
  `${store.getState().memory.filter((m) => m.forgotten).length} of an expected ${forgottenBefore}`);
const counter = store.getState().counters.memory;
const next = act('claude', 'memory', { scope: 'human', text: 'ids keep going after a restart' });
check('...and the id counter, so a new entry cannot collide with an old one',
  next.id === `MEM-${String(counter + 1).padStart(2, '0')}`
  && store.getState().memory.filter((m) => m.id === next.id).length === 1,
  `${next.id} after a counter of ${counter}`);
store.close();

console.log('');
console.log(failures ? `${failures} FAILED` : 'memory ok');
process.exitCode = failures ? 1 : 0;
