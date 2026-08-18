#!/usr/bin/env node
/**
 * Turn, time and spend budgets, and the honesty of the number they act on.
 *
 * `maxTurns` was the only budget the runner enforced. It bounds how much work
 * an agent does, but not how long the team runs or what it costs — the two
 * questions a human leaving a studio running overnight is actually asking.
 *
 * Two properties matter more than the arithmetic:
 *
 *   - A budget stops the team BEFORE a turn, never during one. Killing a turn
 *     in flight does not refund the tokens it already spent; it throws away the
 *     work they bought and leaves an inbox unacknowledged.
 *   - The spend figure is a floor, not a bill. A provider that reports no cost
 *     and has no configured rate contributes nothing, so the cap can undercount.
 *     Every place that shows the number has to say so, or it reads as a promise.
 *
 * The budgets are driven to their limits directly rather than by running real
 * turns, so no provider is spawned and the assertions are deterministic.
 *
 *   node test/budgets.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-budgets-'));
const cfgPath = path.join(tmp, 'studio_floor', 'config.json');
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# Budget fixture\n\nProve the budgets stop the team.\n');
fs.writeFileSync(cfgPath, JSON.stringify({
  project: { name: 'Budget fixture', brief: 'PROJECT.md' },
  agents: [{ id: 'alpha', provider: 'grok' }, { id: 'beta', provider: 'grok' }],
}, null, 2));

process.env.STUDIO_PROJECT_ROOT = tmp;
process.env.STUDIO_CONFIG = cfgPath;
process.env.STUDIO_STATE_DIR = path.join(tmp, 'state');

const { Store } = await import('../src/core/store.mjs');
const { Runner } = await import('../src/agents/runner.mjs');

/**
 * A Store with no history.
 *
 * A Store replays its log on construction, and STUDIO_STATE_DIR is resolved
 * once at import — so a second `new Store()` in the same process inherits every
 * event the first one wrote, and each case's spend would include the last
 * case's. Clearing the directory between cases is what makes them independent.
 */
let current = null;
function freshStore() {
  if (current) { current.close(); current = null; }
  fs.rmSync(process.env.STUDIO_STATE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  current = new Store();
  return current;
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\nbudgets — turns, time and spend stop the team\n');

/** A runner over the same two agents, with whatever budgets a case needs. */
function makeRunner(store, budgets = {}) {
  return new Runner(store, {
    maxTurns: 0,
    cooldownMs: 0,
    staggerMs: 0,
    idleBackoffMs: [0],
    turnTimeoutMs: 15_000,
    commandLineBudget: 28_000,
    project: { name: 'Budget fixture', brief: 'PROJECT.md' },
    agents: ['alpha', 'beta'],
    // A command that does not exist. Nothing should ever spawn it: every case
    // here must stop at the pre-turn gate, and a spawn attempt means it did not.
    roster: [
      { id: 'alpha', provider: 'grok', label: 'Alpha', persona: '', options: { command: 'no-such-cmd-xyz' } },
      { id: 'beta', provider: 'grok', label: 'Beta', persona: '', options: { command: 'no-such-cmd-xyz' } },
    ],
    ...budgets,
  });
}

/** Start both agents and wait for the loop to settle. */
async function runUntilQuiet(runner, ms = 300) {
  await runner.start('alpha');
  await runner.start('beta');
  await new Promise((r) => { setTimeout(r, ms); });
  await runner.stopAll('test finished');
}

const stops = (store, budget) => store.events.filter(
  (e) => e.kind === 'agent.stopped' && e.data?.budget === budget);
const turnsStarted = (store) => store.events.filter((e) => e.kind === 'raw.turn.start');

// ------------------------------------------------------------------- spend

{
  const store = freshStore();
  // The runner is constructed first, then the run spends: that is the real
  // order, and it is what makes the spend belong to this run rather than to
  // the log's history.
  const runner = makeRunner(store, { maxSpendUsd: 1.0 });
  // $1.50 of provider-reported cost, spread over two agents.
  store.append('raw.usage', 'alpha', {
    usage: { input_tokens: 100, output_tokens: 50 }, costUsd: 1.0, scope: 'turn',
  });
  store.append('raw.usage', 'beta', {
    usage: { input_tokens: 100, output_tokens: 50 }, costUsd: 0.5, scope: 'turn',
  });

  check('spend is read from the ledger', Math.abs(runner.spend().total - 1.5) < 1e-9, String(runner.spend().total));

  await runUntilQuiet(runner);

  const stopped = stops(store, 'spend');
  check('the spend budget stops the team, not one agent', stopped.length === 2, `stopped=${stopped.length}`);
  check('no turn was started after the budget was blown', turnsStarted(store).length === 0,
    `turns=${turnsStarted(store).length}`);
  check('the reason names the budget and the amount',
    /spend budget of \$1\.00 reached — \$1\.50/.test(stopped[0]?.data?.reason || ''),
    stopped[0]?.data?.reason || '');
}

// -------------------------------------------------------------------- time

{
  const store = freshStore();
  const runner = makeRunner(store, { maxWallMs: 60_000 });
  // Pretend the run started well over an hour ago.
  runner.startedAt = Date.now() - 90 * 60 * 1000;

  await runUntilQuiet(runner);

  const stopped = stops(store, 'time');
  check('the time budget stops the team', stopped.length === 2, `stopped=${stopped.length}`);
  check('no turn was started after the time ran out', turnsStarted(store).length === 0,
    `turns=${turnsStarted(store).length}`);
  check('the reason gives the limit and the elapsed time in human units',
    /time budget of 1m reached — the team ran for 1h 30m/.test(stopped[0]?.data?.reason || ''),
    stopped[0]?.data?.reason || '');
}

// ------------------------------------------------------------------- turns

{
  const store = freshStore();
  const runner = makeRunner(store, { maxTurns: 3 });
  // alpha has used its budget; beta has not.
  runner.agents.get('alpha').turn = 3;

  await runner.start('alpha');
  await new Promise((r) => { setTimeout(r, 200); });
  await runner.stopAll('test finished');

  const stopped = stops(store, 'turns');
  check('the turn budget stops the agent that spent it', stopped.length === 1, `stopped=${stopped.length}`);
  check('and it is that agent', stopped[0]?.agent === 'alpha', stopped[0]?.agent || '');
  check('the turn budget does not stop the team',
    !store.events.some((e) => e.kind === 'agent.stopped' && e.agent === 'beta' && e.data?.budget === 'turns'));
  check('the existing wording is unchanged',
    /turn budget of 3 reached/.test(stopped[0]?.data?.reason || ''), stopped[0]?.data?.reason || '');
}

// -------------------------------------- the budget is on the run, not the log

// The store replays the whole event log on boot, so its usage total is the
// lifetime spend of the project. Measuring a cap against that means a studio
// with any history is already over budget before its first turn — it stops
// instantly against money spent days ago. This is what shipping the cap against
// the lifetime total did on a real log carrying $65.84 of earlier runs.
{
  const store = freshStore();
  store.append('raw.usage', 'alpha', {
    usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 65.84, scope: 'turn',
  });

  // A runner constructed AFTER that history baselines against it.
  const runner = makeRunner(store, { maxSpendUsd: 5 });
  const s = runner.spend();
  check('a fresh run starts at zero spent, whatever the log holds', s.total === 0, String(s.total));
  check('and the lifetime figure is still available', Math.abs(s.lifetime - 65.84) < 1e-9, String(s.lifetime));
  check('the qualifier says which one it is', /this run/.test(s.qualifier), s.qualifier);

  await runUntilQuiet(runner);
  check('history alone does not stop the team', stops(store, 'spend').length === 0,
    `stopped=${stops(store, 'spend').length}`);

  // Spend accrued during the run does count, and does stop it.
  store.append('raw.usage', 'alpha', {
    usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 6, scope: 'turn',
  });
  check('spend during the run counts', Math.abs(runner.spend().total - 6) < 1e-9, String(runner.spend().total));

  const runner2 = makeRunner(store, { maxSpendUsd: 5 });
  runner2.spendAtStart = 65.84; // same run, restated
  await runUntilQuiet(runner2);
  check('and it stops the team once it passes the cap', stops(store, 'spend').length === 2,
    `stopped=${stops(store, 'spend').length}`);
}

// ------------------------------------------- the number is a floor, not a bill

{
  const store = freshStore();
  const runner = makeRunner(store, { maxSpendUsd: 100 });
  // alpha's provider reports cost. beta's does not, and no rate is configured,
  // so beta's tokens are real and its spend is invisible.
  store.append('raw.usage', 'alpha', {
    usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 0.25, scope: 'turn',
  });
  store.append('raw.usage', 'beta', {
    usage: { input_tokens: 900_000, output_tokens: 900_000 }, scope: 'turn',
  });

  const s = runner.spend();

  check('an unpriced provider contributes nothing to the total', Math.abs(s.total - 0.25) < 1e-9, String(s.total));
  check('and is named rather than silently dropped', s.unpriced.includes('beta'), JSON.stringify(s.unpriced));
  check('the qualifier says the spend is not counted',
    /beta report no cost.*NOT counted/s.test(s.qualifier), s.qualifier);
}

// ---------------------------------------------------------------- countdowns

{
  const store = freshStore();
  const runner = makeRunner(store, { maxSpendUsd: 10, maxWallMs: 60 * 60 * 1000, maxTurns: 50 });
  store.append('raw.usage', 'alpha', {
    usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 2, scope: 'turn',
  });
  runner.startedAt = Date.now() - 15 * 60 * 1000;
  const b = runner.budgets();

  check('spend remaining counts down', Math.abs(b.spend.remainingUsd - 8) < 1e-9, String(b.spend.remainingUsd));
  check('time remaining counts down', Math.abs(b.time.remainingMs - 45 * 60 * 1000) < 2000,
    String(b.time.remainingMs));
  check('turns are reported per agent', b.turns.limit === 50 && 'alpha' in b.turns.perAgent,
    JSON.stringify(b.turns));
  check('nothing has been hit yet', b.hit === null, String(b.hit));
}

// Before the first turn the clock has not started. "Null" there would be drawn
// as an empty bar and read as "no time left" — the opposite of the truth.
{
  const store = freshStore();
  const runner = makeRunner(store, { maxWallMs: 60 * 60 * 1000 });
  const b = runner.budgets();
  check('before the first turn the whole time budget remains',
    b.time.remainingMs === 60 * 60 * 1000, String(b.time.remainingMs));
  check('and no time has elapsed', b.time.elapsedMs === 0, String(b.time.elapsedMs));
}

// An unset budget must read as "no limit", not as zero remaining.
{
  const store = freshStore();
  const b = makeRunner(store).budgets();
  check('an unset spend budget has no remaining figure', b.spend.remainingUsd === null, String(b.spend.remainingUsd));
  check('an unset time budget has no remaining figure', b.time.remainingMs === null, String(b.time.remainingMs));
}

if (current) current.close();

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover tmp */ }

console.log(failures ? `\n${failures} budget check(s) failed\n` : '\nall budget checks passed\n');
process.exit(failures ? 1 : 0);
