#!/usr/bin/env node
/**
 * The console the human watches the team through must actually load.
 *
 * A syntax error in one agent's edit to settings.js once broke the module graph
 * and the whole UI went blank while the team kept working. And a `let` read
 * before its declaration — added while building the liveness banner, caught by
 * hand rather than by anything here — would have done the same: every module
 * parses, and the page is still empty.
 *
 * So this does not check that the files parse. It runs them: app.js is imported
 * against a stub browser, which means the whole startup path executes — every
 * module it pulls in, the first render of every panel, and the wiring of every
 * control. Anything that throws on the way up fails here instead of in front of
 * the human.
 *
 * The stub is deliberately permissive. It is not a DOM and it is not trying to
 * be one: every element is the same do-nothing object, so a renderer that asks
 * for something the real page has gets an answer rather than a null. What it
 * models faithfully is only what decides whether the page comes up — the
 * network, the event stream, and the passage of time.
 *
 *   node test/web-loads.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installStubBrowser } from './stub-browser.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-web-'));
fs.mkdirSync(path.join(tmp, 'studio_floor'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# Web fixture\n\nProve the console loads.\n');
fs.writeFileSync(path.join(tmp, 'studio_floor', 'config.json'), JSON.stringify({
  project: { name: 'Web fixture', brief: 'PROJECT.md' },
  agents: [{ id: 'alpha', provider: 'grok' }, { id: 'beta', provider: 'grok' }],
}, null, 2));
process.env.STUDIO_PROJECT_ROOT = tmp;
process.env.STUDIO_CONFIG = path.join(tmp, 'studio_floor', 'config.json');
process.env.STUDIO_STATE_DIR = path.join(tmp, 'state');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\nthe web console loads\n');

// The state the page is handed comes from the real projection rather than from
// a handwritten fixture, so a field the UI starts depending on cannot quietly
// go missing here while the server still sends it.
const { Store } = await import('../src/core/store.mjs');
const store = new Store();
store.append('studio.started', null, { project: 'Web fixture' });
store.append('agent.registered', 'alpha', { strengths: ['x'], intro: 'hello' });
store.append('message.said', 'alpha', { text: 'working on it', to: ['human'], kind: 'chat' });
const STATE = {
  ...store.getState(),
  roster: [{ id: 'alpha', label: 'Alpha', provider: 'grok' }, { id: 'beta', label: 'Beta', provider: 'grok' }],
  project: { name: 'Web fixture', goal: '', brief: 'PROJECT.md' },
  runner: { maxTurns: 200 },
};
store.close();

// -------------------------------------------------------------------- the run

const { doc, calls, streams } = installStubBrowser({ state: STATE });

const WEB = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src', 'web');
const modules = fs.readdirSync(WEB).filter((f) => f.endsWith('.js'));

check('there are web modules to load', modules.length > 0, `${modules.length} found`);

// Each module on its own first: a failure here names the file, where a failure
// through app.js only names the import that pulled it in.
for (const file of modules.filter((f) => f !== 'app.js')) {
  try {
    await import(pathToFileURL(path.join(WEB, file)).href);
    check(`${file} loads`, true);
  } catch (e) {
    check(`${file} loads`, false, e.message);
  }
}

// app.js last, and it is the real assertion: importing it runs startup, which
// fetches the state, renders every panel and wires every control.
let started = false;
try {
  await import(pathToFileURL(path.join(WEB, 'app.js')).href);
  started = true;
} catch (e) {
  check('app.js starts up', false, `${e.message}\n        ${(e.stack || '').split('\n')[1] || ''}`);
}
if (started) {
  check('app.js starts up', true);
  check('it asked the server for the state', calls.some((c) => c.url.startsWith('/api/state')), calls.map((c) => c.url).join(', '));
  check('it opened the event stream', streams.length > 0);
  check('it named the studio in the tab title', doc.title.includes('Web fixture'), doc.title);
}

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover tmp */ }

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
