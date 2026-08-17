#!/usr/bin/env node
// TASK-17 REVIEW part 2 — atomicity of /api/human/control.
// humanControl appends BEFORE it calls runner.onControl. If the runner throws,
// humanJson turns that into a 400 while the event is already durable and already
// projected. "A refusal appends nothing" is the guarantee codex built; this is the
// one path where it does not hold.
import { startStudioServer, studioUrl } from './harness.mjs';

const boot = [
  'import { Store } from ' + JSON.stringify(studioUrl('core/store.mjs')) + ';',
  'import { createHttpServer } from ' + JSON.stringify(studioUrl('server/server.mjs')) + ';',
  'const store = new Store();',
  // A runner whose stop() fails. Real cause: the child process is already gone,
  // or a kill on Windows races. onControl awaits it and does not catch.
  'const runner = {',
  '  onControl: async (body) => { if (body.action === "stop") throw new Error("kill failed: process already exited"); },',
  '  wake: () => {},',
  '};',
  'studioTestReady(store, createHttpServer(store, runner));',
].join('\n');

const { get, post } = await startStudioServer({ boot, prefix: 'claude-attack-17b-' });
const count = async () => (await get('/api/events?limit=2000')).events.length;

await post('/api/action', { agent: 'claude', verb: 'join', strengths: ['x'], intro: 'i' });

const before = await count();
const res = await post('/api/human/control', { action: 'stop', target: 'claude' });
const after = await count();
const controls = (await get('/api/state')).controls ?? [];

console.log(`response:            ${JSON.stringify(res)}`);
console.log(`events appended:     ${after - before}`);
console.log(`controls projected:  ${JSON.stringify(controls.map((c) => `${c.action}->${c.target}`))}`);
console.log('');
console.log(res.error && after > before
  ? 'DEFECT CONFIRMED: the caller was told 400 and the event is durable and projected.'
  : 'no defect on this path');

// The same shape with pause, which mutates projected state the human can see.
const boot2 = boot.replace('body.action === "stop"', 'body.action === "pause"');
const s2 = await startStudioServer({ boot: boot2, prefix: 'claude-attack-17b2-' });
await s2.post('/api/action', { agent: 'claude', verb: 'join', strengths: ['x'], intro: 'i' });
const r2 = await s2.post('/api/human/control', { action: 'pause' });
const st2 = await s2.get('/api/state');
console.log(`\npause with a failing runner -> ${JSON.stringify(r2)}`);
console.log(`studio paused flag after that "failed" call: ${st2.paused}`);
process.exit(0);
