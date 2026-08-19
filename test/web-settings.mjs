#!/usr/bin/env node
/**
 * Choosing a provider in the settings panel.
 *
 * The panel asks two human questions — which company, and how it authenticates
 * — and writes four technical fields from the answers. That indirection is the
 * whole point of it, and it is also where it can go quietly wrong: an agent
 * relabelled Anthropic while still pointed at Moonshot, a model name belonging
 * to the provider you just left, a warning about a key variable that no longer
 * applies to anything.
 *
 * None of that is reachable by clicking in a stub browser, because there is
 * nothing to click. The edit handler is driven directly instead.
 *
 *   node test/web-settings.mjs
 */
import { installStubBrowser } from './stub-browser.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const VENDORS = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: ['claude-opus-5'],
    canLogin: true,
    canKey: true,
    loginCli: 'claude',
    keyCli: 'claude',
    keyPreset: '',
    keyBaseUrl: '',
    keyVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'xai',
    label: 'xAI',
    models: ['grok-4', 'grok-4-fast'],
    canLogin: true,
    canKey: true,
    loginCli: 'grok',
    keyCli: 'codex',
    keyPreset: 'grok',
    keyBaseUrl: 'https://api.x.ai/v1',
    keyVar: 'XAI_API_KEY',
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    models: ['kimi-k2'],
    canLogin: false,
    canKey: true,
    loginCli: '',
    keyCli: 'claude',
    keyPreset: 'kimi',
    keyBaseUrl: 'https://api.moonshot.ai/anthropic',
    keyVar: 'MOONSHOT_API_KEY',
  },
];

const configWith = (agent, vendors = VENDORS) => ({
  ok: true,
  file: '/tmp/config.json',
  config: {
    project: { name: 'Fixture', brief: 'PROJECT.md', goal: '' },
    agents: [agent],
    runner: {
      maxTurns: 1,
      maxWallMs: 0,
      maxSpendUsd: 0,
      turnTimeoutMs: 1,
      cooldownMs: 1,
      staggerMs: 1,
      commandLineBudget: 1,
      idleBackoffMs: [1],
    },
    server: { host: '127.0.0.1', port: 4173, token: null },
    adapters: [],
  },
  providers: ['claude', 'codex', 'grok'],
  protectedFields: {},
  running: [],
  secrets: {
    canStore: false, keySource: 'none', protects: '', steps: [], keep: '',
  },
  schema: {
    vendors,
    authModes: ['auto', 'key', 'login'],
    personas: ['architect'],
    sandboxes: [],
    permissionModes: [],
    agentFields: [],
    protectedFields: [],
    runnerFields: [],
    projectFields: [],
    liveFields: [],
    bounds: {},
  },
});

/** A fresh panel over one agent. Each case gets its own module instance. */
let instance = 0;
async function panel(agent, vendors) {
  const cfg = configWith(agent, vendors);
  const stub = installStubBrowser({ state: {}, config: cfg });
  globalThis.fetch = async (u) => ({
    ok: true,
    status: 200,
    json: async () => (String(u).startsWith('/api/config') ? cfg
      : String(u).startsWith('/api/projects') ? { ok: false } : { ok: true }),
  });
  instance += 1;
  const mod = await import(`../src/web/settings.js?case=${instance}`);
  await mod.refreshSettings();
  return {
    mod,
    html: () => stub.byId('settings').innerHTML,
    edit: (path, value) => mod.__test_onEdit({ dataset: { path }, value, type: 'select-one' }),
  };
}

/** The model select's markup, so a change of shape fails loudly here. */
function modelSelect(html) {
  const at = html.indexOf('data-path="agents.0.model"');
  if (at < 0) throw new Error('no model field rendered at all');
  return html.slice(at, html.indexOf('</select>', at));
}
const modelValue = (html) => /<option value="([^"]*)" selected>/.exec(modelSelect(html))?.[1];
const suggestions = (html) => [...modelSelect(html).matchAll(/<option value="([^"]*)"/g)]
  .map((m) => m[1]).filter(Boolean);
const pill = (html) => {
  const at = html.indexOf('set-auth');
  return /<span class="pill[^"]*">([^<]*)</.exec(html.slice(at))?.[1] || '';
};

console.log('\nchoosing a provider\n');

{
  const p = await panel({
    id: 'a',
    provider: 'claude',
    model: 'claude-opus-5',
    auth: 'auto',
    credentials: { ok: false, detail: 'no key yet — set ANTHROPIC_API_KEY', source: 'none', keyVar: 'ANTHROPIC_API_KEY' },
  });

  check('the company is worked out from what the config stores',
    /value="anthropic" selected/.test(p.html()));

  p.edit('agents.0.vendor.select', 'xai');
  const after = p.html();

  // A model belongs to the company it came from. Leaving claude-opus-5 in the
  // box makes an agent that fails on its first turn with a model name the new
  // provider has never heard of.
  check('switching company drops a model that belonged to the old one',
    modelValue(after) === '', JSON.stringify(modelValue(after)));
  check('and offers the new company\'s models instead',
    suggestions(after).join(',') === 'grok-4,grok-4-fast', suggestions(after).join(','));

  // The old warning named a key variable that no longer applies to anything.
  check('the stale credential warning is cleared rather than left pointing at the old provider',
    /not checked yet/.test(pill(after)), pill(after));
}

{
  // A model the human typed is theirs. Only a suggestion this panel offered for
  // some other company is presumed stale.
  const p = await panel({
    id: 'a', provider: 'claude', model: 'my-finetune-v3', auth: 'auto', credentials: { ok: true, detail: 'fine' },
  });
  p.edit('agents.0.vendor.select', 'xai');
  check('a model the human typed themselves survives the switch',
    modelValue(p.html()) === 'my-finetune-v3', JSON.stringify(modelValue(p.html())));
  // ...and stays selectable, even though the new provider has never heard of
  // it. Dropping a human's setting out of the list silently is worse than
  // showing one that may be stale.
  check('and is still in the list rather than dropped from it',
    suggestions(p.html()).includes('my-finetune-v3'), suggestions(p.html()).join(','));
}

{
  // A datalist filters itself as you type, so picking one model made the rest
  // vanish and read as the list having been lost. This is a select.
  const p = await panel({ id: 'a', provider: 'claude', auth: 'auto', credentials: { ok: true, detail: 'fine' } });
  check('the model field is a list to choose from, not a box to type in',
    /<select class="input" data-path="agents\.0\.model">/.test(p.html()),
    modelSelect(p.html()).slice(0, 80));
  check('with an explicit option for leaving it to the provider',
    modelSelect(p.html()).includes('the provider'), modelSelect(p.html()).slice(0, 140));
}

console.log('\n what the two answers decide between them');

{
  const p = await panel({ id: 'a', provider: 'grok', auth: 'login', credentials: { ok: true, detail: 'fine' } });
  check('xAI signed in on this machine is its own CLI',
    /value="xai" selected/.test(p.html()));

  p.edit('agents.0.auth', 'key');
  const html = p.html();
  // The same company, a different CLI, because that is the one that can carry
  // a key to xAI. Nobody had to know that.
  check('and xAI with an API key becomes codex pointed at the xAI API',
    html.includes('https://api.x.ai/v1'), 'baseUrl not written');
  check('with the company unchanged', /value="xai" selected/.test(html));
}

{
  // Moonshot has no CLI of its own, so a login mode would be a setting that
  // does nothing.
  const p = await panel({ id: 'a', provider: 'claude', auth: 'login', credentials: { ok: true, detail: 'fine' } });
  p.edit('agents.0.vendor.select', 'moonshot');
  const html = p.html();
  check('a company reachable only by key is forced into key mode',
    /value="key" selected/.test(html), 'auth mode not corrected');
}

console.log('\n talking to an older studio');

{
  // A browser holding this page against a studio too old to send the company
  // list used to render a select with no options at all: a blank box that
  // cannot be used and does not say why.
  const p = await panel({ id: 'a', provider: 'claude', auth: 'auto', credentials: { ok: true, detail: 'fine' } }, undefined);
  const noVendors = await panel({ id: 'a', provider: 'claude', auth: 'auto', credentials: { ok: true, detail: 'fine' } }, []);
  check('a studio that sends no company list still renders a usable control',
    /<option value="claude"/.test(noVendors.html()), 'no options rendered');
  check('and the newer one is unaffected', /value="anthropic" selected/.test(p.html()));
}

console.log('\n labels');
{
  const p = await panel({ id: 'a', provider: 'claude', auth: 'auto', credentials: { ok: true, detail: 'fine' } });
  const html = p.html();
  check('the name and provider fields are labelled, not just placeholdered',
    html.includes('<span>Agent name</span>') && html.includes('<span>Provider</span>'));
}

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
