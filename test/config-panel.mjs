#!/usr/bin/env node
/**
 * The settings panel writes the config file, so it is a write API to the thing
 * that decides which programs this machine runs. These assertions are the
 * boundary.
 *
 * Two of them exist because the code failed them:
 *
 *   - A provider with no adapter was accepted, saved, and bricked the studio:
 *     the Runner refuses to construct, so `studio start` threw before printing
 *     anything. The panel could write a config that could not boot.
 *   - Per-agent `command`/`env`/`extraArgs` decide what executable runs with
 *     what arguments in what environment. The server sets
 *     Access-Control-Allow-Origin:*, so a writable-over-HTTP version of those
 *     is remote code execution reachable from any tab the human has open.
 *
 *   node test/config-panel.mjs
 */
import assert from 'node:assert/strict';
import {
  applyConfigPatch, restartRequiredFor, configSchema,
  AGENT_PROTECTED_OPTIONS, RUNNER_EDITABLE,
} from '../src/core/config.mjs';

const PROVIDERS = ['codex', 'claude', 'grok'];
const opts = { knownProviders: PROVIDERS };

const base = {
  project: { name: 'Test', brief: 'PROJECT.md' },
  agents: [
    { id: 'architect', provider: 'claude', persona: 'architect' },
    { id: 'scout', provider: 'codex', persona: 'researcher', command: '/custom/codex', env: { SECRET: 'keep' }, extraArgs: ['--x'] },
  ],
  adapters: ['./adapters/mine.mjs'],
  runner: { maxTurns: 15 },
};

let n = 0;
const ok = (name, cond, detail = '') => {
  n++;
  if (!cond) {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  } else console.log(`  ok    ${name}`);
};

console.log('\nconfig panel — what the settings API will and will not accept\n');

// ------------------------------------------------- the executable is off limits

for (const field of AGENT_PROTECTED_OPTIONS) {
  const { errors } = applyConfigPatch(base, {
    agents: [{ id: 'evil', provider: 'claude', [field]: field === 'env' ? { X: '1' } : '/bin/sh' }],
  }, opts);
  ok(`"${field}" is refused`, errors.some((e) => e.includes(field)), errors.join('; '));
}

// ...but an edit that does not mention them must not silently drop them, or
// saving the roster from the UI would delete a hand-written command.
{
  const { config, errors } = applyConfigPatch(base, {
    agents: [
      { id: 'architect', provider: 'claude', persona: 'architect' },
      { id: 'scout', provider: 'codex', persona: 'adversary' },
    ],
  }, opts);
  ok('an unrelated edit is accepted', errors.length === 0, errors.join('; '));
  const scout = config.agents.find((a) => a.id === 'scout');
  ok('command survives an edit to the same agent', scout.command === '/custom/codex');
  ok('env survives', scout.env?.SECRET === 'keep');
  ok('extraArgs survive', Array.isArray(scout.extraArgs) && scout.extraArgs[0] === '--x');
  ok('the edit that was asked for did happen', scout.persona === 'adversary');
  ok('a file-only top-level key survives', config.adapters?.[0] === './adapters/mine.mjs');
}

// A removed agent takes its protected fields with it — nothing to preserve.
{
  const { config } = applyConfigPatch(base, {
    agents: [{ id: 'architect', provider: 'claude', persona: 'architect' }],
  }, opts);
  ok('removing an agent removes it', config.agents.length === 1);
  ok('and does not resurrect its command', !JSON.stringify(config).includes('/custom/codex'));
}

// ------------------------------------------------------ a config that cannot boot

{
  const { errors } = applyConfigPatch(base, {
    agents: [{ id: 'a', provider: 'gemini' }],
  }, opts);
  ok('a provider with no adapter is refused', errors.some((e) => e.includes('gemini')), errors.join('; '));
  ok('and the message says why it matters', errors.some((e) => /fail to start/i.test(e)));
}

{
  // Without the provider list the check cannot run; it must not throw, because
  // the CLI loads configs without an adapter registry.
  const { errors } = applyConfigPatch(base, { agents: [{ id: 'a', provider: 'gemini' }] });
  ok('no provider list means no provider check, not a crash', errors.length === 0);
}

// Breakage already in the file must not hold unrelated edits hostage.
//
// `--only` skips an agent whose adapter is missing, so the studio starts with a
// broken entry in the roster — and every save, including one that touched
// nothing but maxTurns, was refused because of an agent the human never edited.
// The panel became unusable until the file was hand-edited, which is the
// opposite of what it is for.
{
  const broken = {
    ...base,
    agents: [...base.agents, { id: 'gem', provider: 'gemini', persona: 'researcher' }],
  };
  const { errors, warnings } = applyConfigPatch(broken, { runner: { maxTurns: 99 } }, opts);
  ok('an unrelated edit survives a pre-existing bad provider', errors.length === 0, errors.join('; '));
  ok('and it is reported as a warning instead', warnings.some((w) => w.includes('gemini')), warnings.join('; '));
  ok('the warning says the studio will not start', warnings.some((w) => /refuse to start/.test(w)));
}
{
  // Introducing one is still an error, and changing an existing agent onto a
  // missing provider counts as introducing it.
  const broken = {
    ...base,
    agents: [...base.agents, { id: 'gem', provider: 'gemini', persona: 'researcher' }],
  };
  const { errors } = applyConfigPatch(broken, {
    agents: [{ id: 'architect', provider: 'llama', persona: 'architect' }],
  }, opts);
  ok('introducing a bad provider is still refused', errors.some((e) => e.includes('llama')), errors.join('; '));
}
{
  const { errors } = applyConfigPatch(base, {
    agents: [...base.agents.map((a) => ({ id: a.id, provider: a.provider, persona: a.persona })),
      { id: 'gem', provider: 'gemini' }],
  }, opts);
  ok('adding a new agent on a missing provider is refused', errors.some((e) => e.includes('gemini')));
}

// Unknown top-level keys must survive normalisation.
//
// normaliseConfig used to build a fresh defaultConfig() and copy across only the
// four keys it knew about. That silently killed `adapters` (the whole pluggable
// provider feature was dead: CONFIG.adapters was always undefined) and then
// killed `prices` the same way when token costing arrived. This asserts the
// general property, not the two specific keys, so the third occurrence fails
// here instead of shipping.
{
  const { normaliseConfig: nc } = await import('../src/core/config.mjs');
  const cfg = nc({
    agents: [{ id: 'a', provider: 'claude' }],
    prices: { codex: { input: 1.25 } },
    adapters: ['./x.mjs'],
    somethingNobodyHasWrittenYet: { deep: true },
  });
  ok('prices survive normalisation', cfg.prices?.codex?.input === 1.25, JSON.stringify(cfg.prices));
  ok('an unrecognised top-level key survives too',
    cfg.somethingNobodyHasWrittenYet?.deep === true, Object.keys(cfg).join(','));
  ok('and the keys config owns are still normalised',
    cfg.runner.cooldownMs === 4000 && cfg.agents[0].label === 'A');
}

// The `adapters` key must survive loading, or custom providers never register.
{
  const { normaliseConfig: nc } = await import('../src/core/config.mjs');
  const cfg = nc({ adapters: ['./a.mjs', 'pkg'], agents: [{ id: 'a', provider: 'claude' }] });
  ok('adapters survive normalisation', JSON.stringify(cfg.adapters) === '["./a.mjs","pkg"]',
    JSON.stringify(cfg.adapters));
  let threw = false;
  try { nc({ adapters: 'nope', agents: [{ id: 'a', provider: 'claude' }] }); } catch { threw = true; }
  ok('a non-list adapters key is rejected', threw);
}

// -------------------------------------------- where credentials get sent

// baseUrl and apiKey are data, not code, so unlike `env` the panel may write
// them. That makes the panel the place where a key could be sent somewhere it
// should not go, so the destination is checked.
{
  const t = (a) => applyConfigPatch(base, { agents: [{ id: 'x', provider: 'claude', ...a }] }, opts);
  ok('an https endpoint is accepted', t({ baseUrl: 'https://api.moonshot.ai/anthropic' }).errors.length === 0);
  ok('a cleartext endpoint is refused',
    t({ baseUrl: 'http://api.example.com' }).errors.some((e) => /https/.test(e)),
    'an API key must not travel in clear');
  ok('localhost over http is allowed for local proxies',
    t({ baseUrl: 'http://localhost:8080' }).errors.length === 0);
  ok('a non-URL is refused', t({ baseUrl: 'moonshot' }).errors.some((e) => /must be a URL/.test(e)));
  ok('an env var name is accepted', t({ apiKeyEnv: 'MOONSHOT_API_KEY' }).errors.length === 0);
  ok('a bogus env var name is refused',
    t({ apiKeyEnv: 'not a var' }).errors.some((e) => /environment variable/.test(e)));
  ok('the panel may still not set raw env',
    t({ env: { NODE_OPTIONS: '--require /evil.js' } }).errors.some((e) => /cannot be set/.test(e)));
}

// ------------------------------------------------------------------ validation

const rejects = [
  ['an unusable id', { agents: [{ id: 'Bad Id', provider: 'claude' }] }, /unusable id/],
  ['a duplicate id', { agents: [{ id: 'a', provider: 'claude' }, { id: 'a', provider: 'grok' }] }, /duplicate/],
  ['an empty roster', { agents: [] }, /at least one agent/],
  ['a negative turn budget', { runner: { maxTurns: -1 } }, /between/],
  ['an absurd timeout', { runner: { turnTimeoutMs: 1 } }, /between/],
  ['a brief outside the project', { project: { brief: '../../etc/passwd' } }, /inside the project/],
  ['an absolute brief path', { project: { brief: '/etc/passwd' } }, /inside the project/],
  ['an unknown runner key', { runner: { nope: 1 } }, /not editable/],
  ['an unknown project key', { project: { nope: 'x' } }, /not editable/],
  ['a bad sandbox', { agents: [{ id: 'a', provider: 'codex', sandbox: 'wide-open' }] }, /sandbox must be/],
  ['a bad permission mode', { agents: [{ id: 'a', provider: 'claude', permissionMode: 'yolo' }] }, /permissionMode must be/],
  ['a made-up agent field', { agents: [{ id: 'a', provider: 'claude', wat: 1 }] }, /not a known field/],
];
for (const [name, patch, re] of rejects) {
  const { errors } = applyConfigPatch(base, patch, opts);
  ok(`rejects ${name}`, errors.some((e) => re.test(e)), errors.join('; ') || 'accepted it');
}

// A rejected patch must not have half-written anything.
{
  const before = JSON.stringify(base);
  applyConfigPatch(base, { agents: [{ id: 'x', provider: 'claude', command: '/bin/sh' }] }, opts);
  ok('a rejected patch does not mutate the input', JSON.stringify(base) === before);
}

// ------------------------------------------------------ live versus restart

{
  const { config } = applyConfigPatch(base, { runner: { maxTurns: 40 } }, opts);
  ok('a runner change needs no restart', restartRequiredFor(base, config).length === 0);
}
{
  const { config } = applyConfigPatch(base, {
    agents: [{ id: 'architect', provider: 'claude', persona: 'adversary' }],
  }, opts);
  const reasons = restartRequiredFor(base, config);
  ok('a roster change needs a restart', reasons.some((r) => /roster/.test(r)), reasons.join('; '));
}
{
  const { config } = applyConfigPatch(base, { project: { brief: 'OTHER.md' } }, opts);
  ok('changing the brief path needs a restart', restartRequiredFor(base, config).some((r) => /brief/.test(r)));
}
{
  const { config } = applyConfigPatch(base, { project: { name: 'Renamed' } }, opts);
  ok('renaming the project does not', restartRequiredFor(base, config).length === 0);
}

// -------------------------------------------------------- the panel's own schema

{
  const s = configSchema();
  ok('the schema offers the built-in personas', s.personas.includes('adversary'));
  ok('the schema lists the sandboxes', s.sandboxes.includes('read-only'));
  ok('the schema names the protected fields', AGENT_PROTECTED_OPTIONS.every((f) => s.protectedFields.includes(f)));
  ok('every editable runner field is in the schema', RUNNER_EDITABLE.every((f) => s.runnerFields.includes(f)));
  ok('no protected field is advertised as editable',
    !s.agentFields.some((f) => AGENT_PROTECTED_OPTIONS.includes(f)));
}

console.log(process.exitCode ? '\nconfig panel checks FAILED\n' : `\nall ${n} config panel checks passed\n`);
