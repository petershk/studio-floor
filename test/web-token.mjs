#!/usr/bin/env node
/**
 * A studio with a token has to be usable from a browser.
 *
 * It was not. `/` is served to anyone and `/api/*` is not, and nothing carried
 * the token from the URL into the page's own requests — so the first fetch
 * 401'd, the error object was assigned as if it were state, and the first
 * render threw on `Object.values(state.tasks)`. Module evaluation stopped and
 * left a static shell: no feed, no agents, no error. It reads as a frozen page,
 * and it is what the first cloud deployment did within a minute of coming up.
 *
 * It never appeared on a laptop because nobody sets a token on loopback, and no
 * test caught it because every stub answered 200. So the stub here refuses, and
 * these are the assertions that would have failed.
 *
 *   node test/web-token.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installStubBrowser } from './stub-browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..', 'src', 'web');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\na studio that wants a token\n');
console.log(' taking it out of the URL');

const TOKEN = 'ad0092ac2c006319c68dd60bc1eff59ef08453';
const stub = installStubBrowser({ href: `http://127.0.0.1:4173/?token=${TOKEN}&tab=usage` });
const tokenModule = await import(pathToFileURL(path.join(WEB, 'token.js')).href);

check('the token is read off the URL', tokenModule.TOKEN === TOKEN, tokenModule.TOKEN);
check('and kept, so a reload without it still works',
  stub.localStorage.getItem('studio.token') === TOKEN);

// A URL with a credential in it gets bookmarked, pasted into chat and
// screenshotted. It only has to be in the address bar once.
check('and taken out of the address bar', !stub.location.search.includes('token'), stub.location.search);
check('without losing the rest of the query', stub.location.search.includes('tab=usage'), stub.location.search);

console.log('\n putting it on every request');

tokenModule.installAuth();
await fetch('/api/state');
await fetch('/api/events?raw=true');
check('a studio request carries the token',
  stub.calls.filter((c) => c.url.startsWith('/api/')).every((c) => c.authorization === `Bearer ${TOKEN}`),
  JSON.stringify(stub.calls));

// The token must never leave the origin it belongs to. This server sends
// Access-Control-Allow-Origin:*, so a page here can talk to anywhere.
await fetch('https://example.invalid/somewhere');
const offsite = stub.calls.find((c) => c.url.startsWith('https://example.invalid'));
check('a request to anywhere else does not', offsite && !offsite.authorization, JSON.stringify(offsite));

check('installing twice does not wrap twice', (() => {
  const before = globalThis.fetch;
  tokenModule.installAuth();
  return globalThis.fetch === before;
})());

// EventSource cannot send a header, and neither can the preview iframe, so
// those two carry it in the URL or not at all.
check('the stream URL carries it instead',
  tokenModule.withToken('/api/stream?since=4') === `/api/stream?since=4&token=${TOKEN}`,
  tokenModule.withToken('/api/stream?since=4'));
check('and a URL with no query gets one',
  tokenModule.withToken('/preview/') === `/preview/?token=${TOKEN}`);

console.log('\n when the studio refuses anyway');

// A separate process: app.js is a singleton once imported, and this needs it to
// meet a 401 on its very first fetch.
const child = spawnSync(process.execPath, [path.join(HERE, 'web-token-401.mjs')], {
  encoding: 'utf8',
  timeout: 60_000,
  env: { ...process.env },
});
const out = `${child.stdout || ''}${child.stderr || ''}`;
check('the page survives a 401 rather than dying mid-render',
  child.status === 0, out.trim().split('\n').slice(-4).join(' | '));
check('and says what to do about it', /THIS STUDIO NEEDS ITS TOKEN/.test(out), out.trim().slice(-200));
check('and the tab says it too, for a page nobody is looking at', /locked/.test(out), out.trim().slice(-200));

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
