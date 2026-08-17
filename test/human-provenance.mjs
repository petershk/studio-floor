#!/usr/bin/env node
// A human directive has to actually be from the human.
//
// Every /api/human/* route appends with agent=null, which describe() renders as
// "Human:" and the brief prints under "the human has already said this". So
// anything able to POST to the studio was indistinguishable from the creative
// director. That is not a security boundary — we are on loopback — but it cost two
// agent-turns when a probe of mine reached codex and grok as a directive the human
// never sent. This asserts a mistake announces itself.
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

const server = await startStudioServer({ boot, prefix: 'studio-provenance-' });
const { base, get, post } = server;

await post('/api/action', { agent: 'claude', verb: 'join', strengths: ['x'], intro: 'i' });

// A plain fetch, exactly like the one that caused the incident.
await post('/api/human/control', { action: 'priority', text: 'from a script' });
await post('/api/human/say', { to: [], text: 'also from a script' });

// What a browser sends: same-origin fetch carries origin/referer.
await fetch(`${base}/api/human/control`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base, referer: `${base}/` },
  body: JSON.stringify({ action: 'priority', text: 'from the browser' }),
});

const events = (await get('/api/events?limit=500')).events;
const controls = events.filter((e) => e.kind === 'human.control');
const script = controls.find((e) => e.data.text === 'from a script');
const browser = controls.find((e) => e.data.text === 'from the browser');
const said = events.find((e) => e.kind === 'human.message');

check('a scripted human write records where it came from', script?.data.via === 'api', JSON.stringify(script?.data));
check('a browser human write is recorded as the browser', browser?.data.via === 'browser', JSON.stringify(browser?.data));
check('human.message carries provenance too', said?.data.via === 'api', JSON.stringify(said?.data));

const inbox = (await get('/api/inbox?agent=claude')).items;
const line = (text) => inbox.find((i) => JSON.stringify(i.data).includes(text))?.line ?? '';

check('the agent is told a scripted directive is not the human speaking',
  line('from a script').includes('via api'), line('from a script'));
check('a real browser directive still reads as the human, with no noise',
  line('from the browser').startsWith('Human:'), line('from the browser'));
check('the scripted message is still DELIVERED, not filtered',
  Boolean(line('also from a script')), JSON.stringify(inbox.map((i) => i.kind)));

// Older events predate the field and must not be relabelled as suspicious.
const { describe } = await import('../src/core/events.mjs');
check('an event with no provenance still reads as the human',
  describe({ kind: 'human.control', data: { action: 'pause' } }).startsWith('Human:'),
  describe({ kind: 'human.control', data: { action: 'pause' } }));

console.log(failures ? `\n${failures} FAILED` : '\nhuman-provenance ok');
server.stop();
process.exitCode = failures ? 1 : 0;
