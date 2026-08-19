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
  canRestart: true,
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
async function panel(agent, vendors, projects = { ok: false }) {
  const cfg = configWith(agent, vendors);
  const stub = installStubBrowser({ state: {}, config: cfg });
  globalThis.fetch = async (u) => ({
    ok: true,
    status: 200,
    json: async () => (String(u).startsWith('/api/config') ? cfg
      : String(u).startsWith('/api/projects') ? projects : { ok: true }),
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

/** Render once with a particular canRestart, and return just the header. */
async function panelWith({ canRestart }) {
  const agent = { id: 'a', provider: 'claude', auth: 'auto', credentials: { ok: true, detail: 'fine' } };
  const cfg = configWith(agent);
  if (canRestart === undefined) delete cfg.canRestart;
  else cfg.canRestart = canRestart;
  const stub = installStubBrowser({ state: {}, config: cfg });
  globalThis.fetch = async (u) => ({
    ok: true,
    status: 200,
    json: async () => (String(u).startsWith('/api/config') ? cfg
      : String(u).startsWith('/api/projects') ? { ok: false } : { ok: true }),
  });
  instance += 1;
  const mod = await import(`../src/web/settings.js?restart=${instance}`);
  await mod.refreshSettings();
  const html = stub.byId('settings').innerHTML;
  return html.slice(0, html.indexOf('</div>', html.indexOf('set-actions')));
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

console.log('\n the project, and the workspace it sits in');

const projectsPayload = ({ projectPath, workspacePath, holds = [] }) => ({
  ok: true,
  current: {
    path: projectPath, name: 'p', entries: 3, hasBrief: true, isGitRepo: true, events: 0,
  },
  recent: [],
  workspace: { path: workspacePath, isProject: projectPath === workspacePath, holds },
});

{
  // The studio starts pointed at the workspace on a cloud box — a directory
  // holding repositories rather than a thing to build — and a panel showing one
  // path made those look like the same idea.
  const p = await panel(
    { id: 'a', provider: 'claude', auth: 'auto', credentials: { ok: true, detail: 'fine' } },
    undefined,
    projectsPayload({
      projectPath: '/workspace',
      workspacePath: '/workspace',
      holds: [{ name: 'repo-a', path: '/workspace/repo-a', isGitRepo: true, isCurrent: false }],
    }),
  );
  const html = p.html();
  check('working in the workspace itself is called out as almost never what you want',
    /This is the <b>workspace<\/b>/.test(html));
  check('and the project and the workspace are shown as two different things',
    html.includes('The team is working in') && html.includes('Repositories live in'));
  check('with something already there offered first',
    /data-projmode="workspace"[^>]*>Something already here/.test(html)
    || /class="btn primary"[\s\S]{0,80}data-projmode="workspace"/.test(html), 'wrong default mode');
}

{
  const p = await panel(
    { id: 'a', provider: 'claude', auth: 'auto', credentials: { ok: true, detail: 'fine' } },
    undefined,
    projectsPayload({ projectPath: '/workspace/repo-a', workspacePath: '/workspace', holds: [] }),
  );
  const html = p.html();
  check('a real project is not warned about', !/This is the <b>workspace<\/b>/.test(html));
  // Nothing cloned yet, so the only useful first offer is to clone something.
  check('an empty workspace offers cloning first',
    /class="btn primary"[\s\S]{0,80}data-projmode="clone"/.test(html), 'wrong default mode');
  check('and an empty workspace is not shown as a place things live',
    !html.includes('Repositories live in'));
  check('nor offered as somewhere to pick from',
    !/data-projmode="workspace"/.test(html));
}

{
  // The thing being built is often a directory inside the project — this
  // studio's own team builds in test_project/ — and the section read as being
  // about the wrong thing entirely while never mentioning it.
  const payload = projectsPayload({ projectPath: '/repo', workspacePath: '/ws', holds: [] });
  payload.building = {
    configured: 'test_project', path: '/repo/test_project', found: true, reason: 'serving /repo/test_project', source: 'configured',
  };
  const p = await panel(
    { id: 'a', provider: 'claude', auth: 'auto', credentials: { ok: true, detail: 'fine' } },
    undefined,
    payload,
  );
  check('what the team is building is named, not only where it works',
    p.html().includes('The thing being built is in') && p.html().includes('/repo/test_project'));

  payload.building = {
    configured: 'gone', path: '', found: false, reason: 'server.preview is "gone", which resolves to /repo/gone — that directory does not exist', source: 'configured',
  };
  const missing = await panel(
    { id: 'a', provider: 'claude', auth: 'auto', credentials: { ok: true, detail: 'fine' } },
    undefined,
    payload,
  );
  check('and a build directory that is not there says so rather than showing a path that works',
    /does not exist/.test(missing.html()));
}

console.log('\n restarting');

{
  // The roster is resolved once at import, so changing the team always needs a
  // restart — and telling somebody to find the terminal it was started in is
  // not an instruction they can follow through a browser.
  const p = await panel({ id: 'a', provider: 'claude', auth: 'auto', credentials: { ok: true, detail: 'fine' } });
  check('a supervised studio offers a restart button where you would look for it',
    /id="set-restart"/.test(p.html()) && !/id="set-restart"[^>]*disabled/.test(p.html()));
}

{
  // Two different problems, and conflating them would accuse a perfectly good
  // deployment of something it is not doing.
  const noSupervisor = await panelWith({ canRestart: false });
  check('a studio with no supervisor says that, rather than offering a button that kills it',
    /disabled/.test(noSupervisor) && /without a supervisor/.test(noSupervisor), 'wrong reason');

  const oldStudio = await panelWith({ canRestart: undefined });
  check('and one too old to say is not accused of the same thing',
    /disabled/.test(oldStudio) && /cannot restart itself/.test(oldStudio) && !/without a supervisor/.test(oldStudio),
    'wrong reason');
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
