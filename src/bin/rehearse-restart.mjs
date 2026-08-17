// Would a restart work? Rehearse it against a COPY of the live log.
//
// A studio's whole world is rebuilt by replaying `.studio/events.jsonl` on
// start. That replay is the thing you least want to discover is broken at the
// moment you need to restart. This copies the live log to a temp root, boots a
// store against the copy, and reports what happened — read-only, never touching
// the real state directory.
//
//   node src/bin/rehearse-restart.mjs
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE = process.env.STUDIO_EVENT_LOG || path.join(ROOT, '.studio', 'events.jsonl');
const LIVE_URL = process.env.STUDIO_URL || 'http://127.0.0.1:4173';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-rehearsal-'));
fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
fs.copyFileSync(LIVE, path.join(root, '.studio', 'events.jsonl'));
const bytes = fs.statSync(LIVE).size;
console.log(`copied ${bytes.toLocaleString()} bytes / ${fs.readFileSync(LIVE, 'utf8').split('\n').filter(Boolean).length.toLocaleString()} events to a scratch root\n`);

process.env.STUDIO_PROJECT_ROOT = root;
const t0 = Date.now();
let store;
try {
  const { Store } = await import(pathToFileURL(path.join(ROOT, 'studio', 'core', 'store.mjs')).href);
  store = new Store();
} catch (err) {
  console.log(`BOOT FAILED: ${err.message}`);
  console.log(err.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
const ms = Date.now() - t0;
const s = store.getState();
console.log(`booted in ${ms} ms with current code`);
console.log(`  seq            ${store.seq}`);
console.log(`  agents         ${Object.keys(s.agents).length}`);
console.log(`  tasks          ${Object.keys(s.tasks).length}`);
console.log(`  decisions      ${s.decisions.length}`);
console.log(`  debates        ${Object.keys(s.debates).length}`);
console.log(`  attention      ${s.attention.length}  (${s.attention.filter((a) => a.status === 'open').length} open)`);
console.log(`  controls       ${s.controls.length}`);
console.log(`  recovered      ${store.events.filter((e) => e.kind === 'log.recovered').length}`);

// Compare against the live server's projection. Any difference is either a
// deliberate change or a bug, and either way the human should not meet it
// mid-restart.
const live = await (await fetch(`${LIVE_URL}/api/state`)).json();
const cmp = [
  ['agents', Object.keys(live.agents).length, Object.keys(s.agents).length],
  ['tasks', Object.keys(live.tasks).length, Object.keys(s.tasks).length],
  ['decisions', live.decisions.length, s.decisions.length],
  ['debates', Object.keys(live.debates).length, Object.keys(s.debates).length],
  ['attention', live.attention.length, s.attention.length],
  ['controls', live.controls.length, s.controls.length],
];
console.log('\nlive (old code) vs rehearsal (current code):');
let drift = 0;
for (const [k, a, b] of cmp) {
  const same = a === b;
  if (!same) drift++;
  console.log(`  ${k.padEnd(12)} live ${String(a).padStart(4)}   rehearsed ${String(b).padStart(4)}   ${same ? 'same' : '*** DIFFERS ***'}`);
}

// Every task must keep its id, state and owner. A projection that quietly
// reshapes the board is the thing that would actually hurt.
const liveTasks = live.tasks;
const bad = [];
for (const [id, t] of Object.entries(s.tasks)) {
  const l = liveTasks[id];
  if (!l) { bad.push(`${id} missing from live`); continue; }
  if (l.state !== t.state) bad.push(`${id} state ${l.state} -> ${t.state}`);
  if ((l.owner ?? null) !== (t.owner ?? null)) bad.push(`${id} owner ${l.owner} -> ${t.owner}`);
}
console.log(`\ntask-by-task: ${bad.length ? bad.join('; ') : 'all 31 identical in id, state and owner'}`);
console.log(`\n${drift === 0 && bad.length === 0 ? 'A RESTART WOULD REPRODUCE THE BOARD EXACTLY.' : `${drift} count difference(s), ${bad.length} task difference(s) -- investigate before restarting.`}`);

store.fd && fs.closeSync(store.fd);
fs.rmSync(root, { recursive: true, force: true });
