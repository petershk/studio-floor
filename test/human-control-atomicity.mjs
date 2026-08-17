#!/usr/bin/env node
// TASK-24: a committed human control must never be reported as a refusal.
import { startStudioServer, studioUrl } from './harness.mjs';
import { describe, isTimeline } from '../src/core/events.mjs';

let failures = 0;
const check = (name, pass, detail = '') => {
  console.log('  ' + (pass ? 'ok  ' : 'FAIL') + '  ' + name + (pass || !detail ? '' : ' -- ' + detail));
  if (!pass) failures++;
};

const boot = [
  'import { Store } from ' + JSON.stringify(studioUrl('core/store.mjs')) + ';',
  'import { createHttpServer } from ' + JSON.stringify(studioUrl('server/server.mjs')) + ';',
  'const store = new Store();',
  'const runner = {',
  '  onControl: async (body) => {',
  '    if (body.action === "stop" || body.action === "pause") throw new Error("delivery failed for " + body.action);',
  '  },',
  '  wake: () => {},',
  '};',
  'studioTestReady(store, createHttpServer(store, runner));',
].join('\n');

const server = await startStudioServer({ boot, prefix: 'human-control-atomicity-' });
const { get, post } = server;
const events = async () => (await get('/api/events?limit=2000')).events;
const count = async () => (await events()).length;

try {
  await post('/api/action', { agent: 'claude', verb: 'join', strengths: ['test'], intro: 'atomicity' });

  const beforeStop = await count();
  const stop = await post('/api/human/control', { action: 'stop', target: 'claude' });
  const afterStop = await count();
  const stopEvents = (await events()).slice(beforeStop);
  const stopControl = stopEvents.filter((event) => event.kind === 'human.control');
  const stopFailure = stopEvents.find((event) => event.kind === 'human.control.delivery-failed');
  const stateAfterStop = await get('/api/state');
  check('runner failure keeps the response successful', stop.ok === true && !stop.error, JSON.stringify(stop));
  check('success identifies the committed event', Number.isInteger(stop.seq), JSON.stringify(stop));
  check('stop warning names the consequence', /claude may still be running/i.test(stop.warning || ''), JSON.stringify(stop));
  check('warning preserves the runner cause', /delivery failed for stop/i.test(stop.warning || ''), JSON.stringify(stop));
  check('exactly one stop control is committed', stopControl.length === 1, JSON.stringify(stopEvents));
  check('the failed delivery is a second durable event', afterStop - beforeStop === 2 && !!stopFailure,
    JSON.stringify(stopEvents));
  check('the failure is linked to the committed control', stopFailure?.data?.controlSeq === stop.seq,
    JSON.stringify(stopFailure));
  check('the failure survives as a human-facing timeline event', !!stopFailure
    && isTimeline(stopFailure.kind)
    && /claude may still be running/i.test(describe(stopFailure)),
  stopFailure ? describe(stopFailure) : 'no delivery-failure event');
  check('committed stop is projected',
    (stateAfterStop.controls || []).some((item) => item.action === 'stop' && item.target === 'claude'),
    JSON.stringify(stateAfterStop.controls || []));

  const beforePause = await count();
  const pause = await post('/api/human/control', { action: 'pause' });
  const afterPause = await count();
  const pauseEvents = (await events()).slice(beforePause);
  const pauseFailure = pauseEvents.find((event) => event.kind === 'human.control.delivery-failed');
  const stateAfterPause = await get('/api/state');
  check('pause delivery failure is also a success', pause.ok === true && !pause.error, JSON.stringify(pause));
  check('pause response names the consequence', /agents may still be running/i.test(pause.warning || ''), JSON.stringify(pause));
  check('pause cause remains available', /delivery failed for pause/i.test(pause.warning || ''), JSON.stringify(pause));
  check('pause also records its delivery failure', afterPause - beforePause === 2
    && pauseFailure?.data?.controlSeq === pause.seq, JSON.stringify(pauseEvents));
  check('the committed pause remains visible', stateAfterPause.paused === true, JSON.stringify(stateAfterPause.paused));

  const beforeInvalid = await count();
  const invalid = await post('/api/human/control', { action: 'explode' });
  const afterInvalid = await count();
  check('an invalid intent is still refused', !!invalid.error && !invalid.ok, JSON.stringify(invalid));
  check('a refused intent appends nothing', afterInvalid === beforeInvalid, beforeInvalid + ' -> ' + afterInvalid);

  const beforeNudge = await count();
  const nudge = await post('/api/human/control', { action: 'nudge', target: 'claude' });
  const afterNudge = await count();
  check('successful runner delivery has no warning', nudge.ok === true && !nudge.warning, JSON.stringify(nudge));
  check('successful delivery commits exactly once', afterNudge - beforeNudge === 1, beforeNudge + ' -> ' + afterNudge);
} finally {
  server.stop();
}

console.log('\nhuman-control-atomicity: ' + (failures ? failures + ' FAILED' : 'all checks passed'));
process.exitCode = failures ? 1 : 0;
