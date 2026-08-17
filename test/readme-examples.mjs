#!/usr/bin/env node
/**
 * The README's examples are executed, not proofread.
 *
 * This exists because both of its configuration sections were wrong at once and
 * neither was caught by reading them:
 *
 *   - "Add a provider" printed a config that could not start a studio.
 *     `normaliseConfig` silently dropped the `adapters` key, so `CONFIG.adapters`
 *     was always undefined, the launcher's `if (CONFIG.adapters?.length)` guard
 *     never fired, and `loadUserAdapters()` was correct code that nothing ever
 *     called. Every custom provider failed with "no adapter for provider X".
 *     The whole pluggable-provider feature was dead, and the README documented
 *     it working.
 *   - "Configure the team" claimed *every* persona ends with the "not obliged to
 *     accept that framing" sentence, two lines after correctly saying a custom
 *     persona is used verbatim. Both cannot be true; the second one is.
 *
 * So the code blocks are extracted from README.md and run. A doc that drifts
 * from the code now fails the suite.
 *
 *   node test/readme-examples.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Normalised to LF. On a Windows checkout with core.autocrlf=true the working
// copy is CRLF, and every fence and heading match below would miss — silently,
// so the suite would go green having extracted nothing at all.
const README = fs.readFileSync(path.resolve(here, '../README.md'), 'utf8').replace(/\r\n/g, '\n');

/** How many fenced blocks the two documented sections are expected to carry. */
const EXPECTED_BLOCKS = 3;

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** Every fenced block of `lang` inside the `## heading` section. */
function blocks(heading, lang) {
  const start = README.indexOf(`## ${heading}`);
  if (start < 0) return [];
  const rest = README.slice(start + 1);
  const end = rest.indexOf('\n## ');
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]);
}

console.log('\nREADME examples — extracted from the file and run\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-readme-'));
fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# brief\n');
process.env.STUDIO_PROJECT_ROOT = tmp;
process.env.STUDIO_PORT = '0';

const { normaliseConfig, PERSONAS } = await import('../src/core/config.mjs');
const { validate, register, getAdapter, providers } = await import('../src/agents/adapters/index.mjs');

// ------------------------------------------------------- Configure the team

const teamJson = blocks('Configure the team', 'json');
check('the section has a config example', teamJson.length >= 1);

if (teamJson.length) {
  let raw;
  try {
    raw = JSON.parse(teamJson[0]);
    check('the printed config is valid JSON', true);
  } catch (e) {
    check('the printed config is valid JSON', false, e.message);
  }

  if (raw) {
    let cfg;
    try {
      cfg = normaliseConfig(raw);
      check('it loads', true);
    } catch (e) {
      check('it loads', false, e.message);
    }
    if (cfg) {
      check('every agent in it survives', cfg.agents.length === raw.agents.length,
        `${cfg.agents.length} of ${raw.agents.length}`);
      // The claim the section is built around.
      const claude = cfg.agents.filter((a) => a.provider === 'claude');
      check('two agents share one provider, as the text claims', claude.length >= 2);
      check('and they get different personas',
        new Set(claude.map((a) => a.persona)).size === claude.length);
      // Inline shorthand the example relies on.
      const withModel = cfg.agents.find((a) => raw.agents.find((r) => r.id === a.id)?.model);
      check('an inline `model` reaches the provider options', Boolean(withModel?.options.model));
      const withSandbox = cfg.agents.find((a) => raw.agents.find((r) => r.id === a.id)?.sandbox);
      check('an inline `sandbox` reaches the provider options', Boolean(withSandbox?.options.sandbox));
    }
  }
}

// The persona claim, in both directions.
const suffix = /You are not obliged to accept that framing/;
const listed = [...README.matchAll(/`(implementer|architect|adversary|researcher|integrator)`/g)]
  .map((m) => m[1]);
check('the personas the README lists all exist',
  [...new Set(listed)].every((p) => p in PERSONAS), [...new Set(listed)].join(','));
check('the README names every built-in persona',
  Object.keys(PERSONAS).every((p) => listed.includes(p)),
  `missing: ${Object.keys(PERSONAS).filter((p) => !listed.includes(p)).join(',') || 'none'}`);

for (const key of Object.keys(PERSONAS)) {
  const p = normaliseConfig({ agents: [{ id: 'a', provider: 'claude', persona: key }] }).agents[0].persona;
  check(`built-in "${key}" carries the framing sentence`, suffix.test(p));
}
{
  const custom = normaliseConfig({
    agents: [{ id: 'a', provider: 'claude', persona: 'You only write tests.' }],
  }).agents[0].persona;
  check('a custom persona is passed through verbatim', custom === 'You only write tests.');
  check('and the README does not claim otherwise',
    !/Every persona ends with/.test(README),
    'README says "Every persona ends with…", which is false for custom ones');
}

// ------------------------------------------------------------ Add a provider

const adapterJs = blocks('Add a provider', 'js');
const adapterJson = blocks('Add a provider', 'json');
check('the section has an adapter example', adapterJs.length >= 1);
check('the section has a config example', adapterJson.length >= 1);

if (adapterJs.length) {
  const file = path.join(tmp, 'adapters', 'gemini.mjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, adapterJs[0]);

  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
    check('the printed adapter is valid JavaScript', true);
  } catch (e) {
    check('the printed adapter is valid JavaScript', false, e.message);
  }

  if (mod?.default) {
    const problems = validate(mod.default);
    check('it satisfies the adapter contract', problems.length === 0, problems.join('; '));

    // It must actually build a command line and parse a line, not merely typecheck.
    try {
      const fresh = mod.default.args({ prompt: 'hi', sessionId: 'sid', fresh: true, agent: { options: {} } });
      const resumed = mod.default.args({ prompt: 'hi', sessionId: 'sid', fresh: false, agent: { options: {} } });
      check('args() returns a command line', Array.isArray(fresh) && fresh.includes('hi'));
      check('and a fresh turn differs from a resumed one', JSON.stringify(fresh) !== JSON.stringify(resumed));
      const out = mod.default.parse({ text: 'hello' });
      check('parse() returns studio events', Array.isArray(out) && out[0]?.kind === 'raw.text');
      check('newSession() mints an id', typeof mod.default.newSession() === 'string');
    } catch (e) {
      check('the adapter runs', false, e.message);
    }

    register(mod.default);
    check('it registers', Boolean(getAdapter('gemini')));
    check('and shows up as a provider', providers().includes('gemini'));
  }
}

if (adapterJson.length) {
  const raw = JSON.parse(adapterJson[0]);
  // The bug this file was written for.
  const cfg = normaliseConfig(raw);
  check('`adapters` survives config loading',
    Array.isArray(cfg.adapters) && cfg.adapters.length === raw.adapters.length,
    `got ${JSON.stringify(cfg.adapters)} — the launcher only loads adapters when this is set`);
  check('the agent keeps its custom provider', cfg.agents[0].provider === 'gemini');
}

// An extractor that finds nothing would turn every check above into a no-op and
// still report success, which is the failure mode this whole file exists to
// prevent. Count what came out.
const extracted = blocks('Configure the team', 'json').length
  + blocks('Add a provider', 'js').length
  + blocks('Add a provider', 'json').length;
check(`all ${EXPECTED_BLOCKS} documented code blocks were found`,
  extracted === EXPECTED_BLOCKS,
  `extracted ${extracted} — a section heading or fence moved`);

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
console.log(failures ? `\n${failures} README example check(s) failed\n` : '\nall README examples work\n');
process.exit(failures ? 1 : 0);
