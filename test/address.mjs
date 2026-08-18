#!/usr/bin/env node
/**
 * Which address the studio binds, and where that decision comes from.
 *
 * `server.port` and `server.host` were documented in CONFIG.md, rendered in the
 * settings panel, and completely ignored: paths.mjs resolved PORT from the
 * environment or a literal 4173 and never read the config file, because
 * importing config.mjs from paths.mjs is a cycle. A config asking for 5099 bound
 * 4173 and printed 4173 in the banner, so nothing looked wrong.
 *
 *   node test/address.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-address-'));
let n = 0;
const ok = (name, cond, detail = '') => {
  n++;
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1; }
};

console.log('\naddress — where the port and host come from\n');

/**
 * paths.mjs reads its environment at import, so each case needs a fresh module
 * registry. A child process is the only honest way to get one.
 */
function resolve(env, config) {
  const root = fs.mkdtempSync(path.join(tmp, 'p-'));
  if (config !== null) {
    fs.mkdirSync(path.join(root, 'studio_floor'), { recursive: true });
    fs.writeFileSync(path.join(root, 'studio_floor', 'config.json'), config);
  }
  const url = pathToFileURL(path.resolve('src/core/paths.mjs')).href;
  const r = require('node:child_process').spawnSync(process.execPath, ['--input-type=module', '-e',
    `import('${url}').then(m => console.log(JSON.stringify({ port: m.PORT, host: m.HOST })));`],
  { encoding: 'utf8', env: cleanEnv(root, env) });
  try { return JSON.parse(r.stdout.trim()); } catch { return { error: r.stderr.trim() }; }
}
const require = (await import('node:module')).createRequire(import.meta.url);

/** `undefined` in the case's env means genuinely unset, not empty. */
function cleanEnv(root, env) {
  const out = { ...process.env, STUDIO_PROJECT_ROOT: root };
  delete out.STUDIO_PORT;
  delete out.STUDIO_HOST;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

{
  const r = resolve({ }, null);
  ok('with no config and no environment, the default is 4173', r.port === 4173, JSON.stringify(r));
  ok('and the host is loopback', r.host === '127.0.0.1', JSON.stringify(r));
}
{
  const r = resolve({ },
    '{"server":{"port":5099,"host":"0.0.0.0"}}');
  ok('the config file sets the port', r.port === 5099, JSON.stringify(r));
  ok('the config file sets the host', r.host === '0.0.0.0', JSON.stringify(r));
}
{
  const r = resolve({ STUDIO_PORT: '5100', STUDIO_HOST: 'localhost' },
    '{"server":{"port":5099,"host":"0.0.0.0"}}');
  ok('the environment beats the config file', r.port === 5100, JSON.stringify(r));
  ok('for the host too', r.host === 'localhost', JSON.stringify(r));
}
{
  const r = resolve({ STUDIO_PORT: '0' }, '{"server":{"port":5099}}');
  ok('STUDIO_PORT=0 is honoured, not treated as unset', r.port === 0, JSON.stringify(r));
}
{
  // Exported but empty is common in shells, .env files and CI. It means unset,
  // not "bind a random port", which is what Number('') would have given.
  const r = resolve({ STUDIO_PORT: '', STUDIO_HOST: '' }, '{"server":{"port":5099}}');
  ok('an empty STUDIO_PORT means unset, not port 0', r.port === 5099, JSON.stringify(r));
  ok('an empty STUDIO_HOST means unset too', r.host === '127.0.0.1', JSON.stringify(r));
}
{
  const r = resolve({ }, '{ this is not json');
  ok('a malformed config does not take down paths.mjs', r.port === 4173, JSON.stringify(r));
}
{
  const r = resolve({ }, '{"server":{"port":"nonsense"}}');
  ok('a nonsense port falls back to the default', r.port === 4173, JSON.stringify(r));
}
{
  const r = resolve({ }, '{"server":{"port":99999}}');
  ok('an out-of-range port falls back to the default', r.port === 4173, JSON.stringify(r));
}

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
console.log(process.exitCode ? '\naddress checks FAILED\n' : `\nall ${n} address checks passed\n`);
