/**
 * The settings panel.
 *
 * Editing studio.config.json by hand is the sharpest edge a newcomer hits, so
 * this is the same thing as a form. Two rules shape it:
 *
 * 1. It never claims a change took effect when it did not. The runner re-reads
 *    its own timings every loop, so those apply live; the roster is resolved
 *    once at import and cannot. The panel says which is which, per save.
 *
 * 2. It cannot change what program runs. `command`, `extraArgs` and `env` are
 *    refused by the API and are not rendered here — an agent carrying them is
 *    shown with a note instead. See the allowlist in core/config.mjs for why.
 */

const $ = (id) => document.getElementById(id);

let update = null;    // the last /api/update payload
let checking = false;
let projects = null;  // the last /api/projects payload
let pathDraft = '';   // the directory the human is typing
let probe = null;     // what /api/projects/inspect says about it
let cloneDraft = '';  // the repository URL typed into the clone box
let cloning = false;  // a clone in flight, so the button can say so
let data = null;      // the last /api/config payload
let draft = null;     // what the human has typed but not saved
let dirty = false;
let notice = null;    // { kind, text } shown above the form
let detectResult = null;  // the last /api/detect answer
let detecting = false;
const modelsByVendor = {};  // what each provider last said it serves
let modelsLoading = null;

async function load() {
  const [r, pr, ur] = await Promise.all([
    fetch('/api/config'), fetch('/api/projects'), fetch('/api/update'),
  ]);
  data = await r.json();
  projects = await pr.json().catch(() => null);
  update = await ur.json().catch(() => null);
  if (!data.ok) {
    render();
    return;
  }
  draft = structuredClone(data.config);
  dirty = false;
  render();
}

/** Called when the tab is opened, so the panel never shows a stale file. */
export async function refreshSettings() {
  // Do not silently throw away typing because a tab was re-clicked.
  if (dirty) return render();
  return load();
}

function setNotice(kind, text) {
  notice = text ? { kind, text } : null;
}

// ---------------------------------------------------------------- rendering

function render() {
  const el = $('settings');
  if (!el) return;

  if (!data) return void (el.innerHTML = '<div class="muted">loading…</div>');

  if (!data.ok) {
    el.innerHTML = `
      <div class="set-error">
        <strong>The config file could not be read.</strong>
        <div class="muted">${esc(data.error || '')}</div>
        <div class="muted">${esc(data.file || '')}</div>
        <p>Fix the file by hand — the panel will not overwrite a file it cannot parse,
        because that would throw away whatever is in it.</p>
      </div>`;
    return;
  }

  const s = data.schema;
  const divergent = rosterDiverged();

  el.innerHTML = `
    <div class="set-head">
      <div>
        <strong>Configuration</strong>
        <span class="muted mono">${esc(data.file)}</span>
      </div>
      <div class="set-actions">
        <button class="btn" id="set-reload" type="button">Reload from file</button>
        ${restartButton()}
        <button class="btn primary" id="set-save" type="button" ${dirty ? '' : 'disabled'}>Save</button>
      </div>
    </div>

    ${notice ? `<div class="set-notice ${notice.kind}">${notice.text}</div>` : ''}
    ${divergent ? `<div class="set-notice warn">
      The running studio is <b>${esc(divergent.running)}</b> but the file now says
      <b>${esc(divergent.file)}</b>. Restart the studio for the file to take effect.
      ${data.canRestart ? '<button class="btn primary" id="set-restart-2" type="button">Restart the studio</button>' : ''}
    </div>` : ''}
    ${dirty ? '<div class="set-notice">Unsaved changes.</div>' : ''}

    ${projectBlock()}
    ${updateBlock()}

    <section class="set-block">
      <h3>Project</h3>
      <p class="muted">What the team is for. The brief is the file every agent reads
      in full on its first turn.</p>
      ${field('Name', 'text', draft.project.name, 'project.name', 'live')}
      ${field('Brief', 'text', draft.project.brief, 'project.brief', 'restart')}
      ${area('Goal', draft.project.goal, 'project.goal', 'live',
    'One paragraph, shown to agents before they read the brief. Optional.')}
    </section>

    <section class="set-block">
      <h3>The team <span class="muted">— ${draft.agents.length} agent${draft.agents.length === 1 ? '' : 's'}</span></h3>
      <p class="muted">An <b>id</b> is what the team calls it; the <b>provider</b> is whose
      model it runs on. Several agents can share a provider with different jobs, and they
      should have different personas — agents given the same framing agree with each other,
      which defeats the point of having several.</p>
      <p class="muted">Which command-line tool actually runs is decided by the provider and
      how it authenticates, so you never have to pick one: xAI signed in on this machine is
      the Grok CLI, and xAI with an API key is the Codex CLI pointed at the xAI API.</p>
      ${detectBlock()}
      <div class="set-agents">${draft.agents.map((a, i) => agentCard(a, i, s)).join('')}</div>
      <button class="btn" id="set-add-agent" type="button">Add an agent</button>
    </section>

    <section class="set-block">
      <h3>Runner</h3>
      <p class="muted">These apply immediately — the runner re-reads them every loop.</p>
      <div class="set-grid">
        ${num('Turn budget per agent', draft.runner.maxTurns, 'runner.maxTurns',
    'A hard stop. The most reliable brake on cost. 0 means no limit.')}
        ${num('Time budget for this run (ms)', draft.runner.maxWallMs, 'runner.maxWallMs',
    '0 means no limit. 3600000 is one hour. Counts from the first turn after the studio '
    + 'started, not from the whole history, and stops the whole team.')}
        ${num('Spend budget for this run ($)', draft.runner.maxSpendUsd, 'runner.maxSpendUsd',
    '0 means no limit. Estimated: an agent whose provider reports no cost and has no rate '
    + 'in `prices` is not counted, so this is a floor rather than a bill.', '0.01')}
        ${num('Turn timeout (ms)', draft.runner.turnTimeoutMs, 'runner.turnTimeoutMs',
    'A turn running longer than this is killed.')}
        ${num('Cooldown between turns (ms)', draft.runner.cooldownMs, 'runner.cooldownMs',
    'Stops an agent spinning.')}
        ${num('Stagger on start (ms)', draft.runner.staggerMs, 'runner.staggerMs',
    'Delay between agent starts.')}
        ${num('Command line budget', draft.runner.commandLineBudget, 'runner.commandLineBudget',
    'Prompts longer than this are cut from the middle. Windows refuses a command line over 32767 characters.')}
        ${field('Idle backoff (ms, comma separated)', 'text',
    (draft.runner.idleBackoffMs || []).join(', '), 'runner.idleBackoffMs', 'live',
    'Escalating wait when an agent has nothing to do.')}
      </div>
    </section>

    <section class="set-block">
      <h3>Not editable here</h3>
      <p class="muted">
        The server address and token, per-agent <code>command</code>,
        <code>extraArgs</code> and <code>env</code>, and the <code>adapters</code> list
        are editable only in the file. They decide which programs run and which code is
        imported, so a settings form reachable over HTTP must not be able to set them.
      </p>
      <div class="set-readonly">
        <div><span class="muted">server</span> ${esc(draft.server.host)}:${esc(String(draft.server.port))}
          ${draft.server.token ? '<span class="pill">token set</span>' : '<span class="pill warn">no token</span>'}</div>
        ${data.config.adapters?.length
    ? `<div><span class="muted">adapters</span> ${data.config.adapters.map((a) => `<code>${esc(a)}</code>`).join(' ')}</div>`
    : ''}
      </div>
    </section>
  `;

  wire();
}

/**
 * Which directory the team is working in, and how to point it somewhere else.
 *
 * A switch is not an edit: this process resolved its project root at import and
 * its store has already replayed one log, so pointing elsewhere replaces the
 * studio rather than reconfiguring it. The button says "switch and restart"
 * because that is what happens.
 */
function projectBlock() {
  if (!projects?.ok) return '';
  const cur = projects.current;
  const p = probe;
  const typed = pathDraft.trim();
  const same = p && cur && p.info.path === cur.path;
  const blocked = p ? p.problems.length > 0 : true;

  return `
    <section class="set-block">
      <h3>Working directory</h3>
      <p class="muted">The studio works on one project at a time. Its memory lives inside
      that project, so coming back to a directory picks up exactly where the team left off.</p>

      <div class="set-current">
        <div class="mono">${esc(cur.path)}</div>
        <div class="muted">
          ${cur.briefUntouched
            ? '<b>brief is still the init template — the team will draft a real one</b>'
            : cur.briefInferred
              ? '<b>brief is an agent-inferred draft — not a human spec</b>'
              : cur.hasBrief ? 'brief found' : '<b>no brief — the team will read the directory and draft one</b>'}
          · ${cur.events ? `${cur.events} recorded events` : 'no history yet'}
          ${cur.isGitRepo ? ' · git repo' : ' · <b>not a git repo</b>'}
          ${cur.legacyLayout ? ' · legacy .studio layout' : ''}
        </div>
      </div>

      <label class="set-f wide">
        <span>Clone a repository into the workspace</span>
        <input class="input" id="proj-clone" value="${esc(cloneDraft)}" spellcheck="false"
               placeholder="https://github.com/owner/repo">
      </label>
      <div class="set-actions">
        <button class="btn primary" id="proj-clone-go" type="button"
          ${cloning || !cloneDraft.trim() ? 'disabled' : ''}>
          ${cloning ? 'Cloning…' : 'Clone and switch'}</button>
      </div>
      <p class="muted">It lands beside the other repositories and the studio moves into it.
      A private repository needs STUDIO_GIT_TOKEN set where the studio runs.</p>

      <label class="set-f wide">
        <span>Point the team at another directory</span>
        <input class="input" id="proj-path" value="${esc(pathDraft)}" spellcheck="false"
               placeholder="an absolute path to a project directory">
      </label>

      ${typed && p ? `<div class="set-probe ${blocked ? 'bad' : 'good'}">
        ${blocked
    ? p.problems.map((x) => esc(x)).join('; ')
    : `<b>${esc(p.info.name)}</b> — ${p.info.entries} item(s)`
      + `${p.info.isGitRepo ? ', git repo' : ', not a git repo'}`
      + `${p.info.briefUntouched
        ? ', <b>brief is still the init template</b>'
        : p.info.briefInferred
          ? ', <b>brief is an agent-inferred draft</b>'
          : p.info.hasBrief ? ', has a brief' : ', <b>no brief — the team will draft one</b>'}`
      + `${p.info.events ? `, <b>${p.info.events} events to resume</b>` : ', no history yet'}`}
      </div>` : ''}

      <div class="set-actions">
        <button class="btn primary" id="proj-switch" type="button"
          ${blocked || same ? 'disabled' : ''}>Switch and restart</button>
        <button class="btn danger" id="proj-reset" type="button"
          ${blocked ? 'disabled' : ''}>Switch and reset its history</button>
      </div>
      <p class="muted">Switching stops the agents and restarts the studio. Reset deletes that
      project's recorded history — its code, brief and config are untouched.</p>

      ${projects.recent?.length > 1 ? `<div class="set-recent">
        <span class="muted">Recent</span>
        ${projects.recent.filter((r) => r.path !== cur.path).slice(0, 6).map((r) => `
          <button class="btn ghost" data-recent="${esc(r.path)}" title="${esc(r.path)}">
            ${esc(r.name)}${r.events ? ` <span class="muted">${r.events}</span>` : ''}
          </button>`).join('')}
      </div>` : ''}
    </section>`;
}

/**
 * Updating the studio from inside the studio.
 *
 * Deliberately quiet until asked. Checking means a network call, and a settings
 * page that phoned home every time it rendered would be slow and presumptuous.
 * If the installation cannot be updated — not a git clone, no upstream, local
 * commits, a dirty tree — it says which, because every one of those is something
 * a human should look at in a terminal rather than have a button paper over.
 */
function updateBlock() {
  if (!update?.isGitRepo) {
    return `
      <section class="set-block">
        <h3>Updates</h3>
        <p class="muted">This studio was not installed from a git clone, so it cannot update
        itself. ${update?.root ? `<span class="mono">${esc(update.root)}</span>` : ''}</p>
      </section>`;
  }

  const blocked = update.reasons?.length > 0;
  const behind = update.behind || 0;

  return `
    <section class="set-block">
      <h3>Updates</h3>
      <div class="set-current">
        <div class="mono">${esc(update.branch || '?')} @ ${esc(update.head || '?')}</div>
        <div class="muted">
          ${esc(update.root)}
          ${update.remote ? `<br>${esc(update.remote)}` : ''}
        </div>
      </div>

      ${blocked ? `<div class="set-probe bad">
        Cannot update automatically: ${update.reasons.map(esc).join('; ')}.
        Update from a terminal instead.
      </div>` : ''}

      ${!blocked && update.fetched && behind === 0
    ? '<div class="set-probe good">Up to date.</div>' : ''}

      ${!blocked && behind > 0 ? `<div class="set-probe good">
        <b>${behind} update${behind === 1 ? '' : 's'} available.</b>
        ${update.commits?.length ? `<ul class="set-commits">${
      update.commits.slice(0, 8).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
      </div>` : ''}

      <div class="set-actions">
        <button class="btn" id="upd-check" type="button" ${checking ? 'disabled' : ''}>
          ${checking ? 'Checking…' : 'Check for updates'}</button>
        <button class="btn primary" id="upd-apply" type="button"
          ${blocked || behind === 0 ? 'disabled' : ''}>Update and restart</button>
      </div>
      <p class="muted">Updating fast-forwards this clone and restarts the studio on the new
      code. It never merges: if the update needs one, it stops and tells you. Your project,
      its brief and its history are untouched.</p>
    </section>`;
}

/** Write-only: a key goes up, and nothing about it ever comes back. */
async function postKey(agent, value, extra = {}) {
  try {
    return await (await fetch('/api/secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, value, ...extra }),
    })).json();
  } catch {
    return { ok: false, error: 'the studio did not answer' };
  }
}

/**
 * What this machine can actually run.
 *
 * The same probe `studio doctor` performs, in the place where somebody is
 * choosing — because the two questions people arrive with are "which of these
 * do I already have" and "which need a key", and until now the only way to
 * answer either was to leave the browser.
 *
 * It reports installed and credentialled separately, because they fail
 * separately: a box with Claude Code installed and nobody signed into it is not
 * the same as a box without it.
 */
function detectBlock() {
  const rows = detectResult?.vendors || [];
  return `
    <div class="set-detect">
      <button class="btn" id="set-detect" type="button"${detecting ? ' disabled' : ''}>
        ${detecting ? 'Looking…' : 'Detect what is installed'}</button>
      ${rows.length ? `<table class="set-detect-t">
        ${rows.map((v) => `<tr>
          <td>${esc(v.label)}</td>
          <td>${v.login
    ? (v.login.installed
      ? `<span class="pill ok">${esc(v.login.cli)} installed</span>`
      : `<span class="pill">${esc(v.login.cli)} not installed</span>`)
    : '<span class="muted">no CLI of its own</span>'}</td>
          <td>${v.key
    ? (v.key.hasKey
      ? `<span class="pill ok">key found in ${esc(v.key.source)}</span>`
      : `<span class="pill">no ${esc(v.key.keyVar)}</span>`)
    : ''}</td>
          <td class="muted">${v.usable ? 'ready' : (v.keysAt ? `key from ${esc(v.keysAt)}` : '')}</td>
        </tr>`).join('')}
      </table>
      <p class="muted">A CLI being installed does not prove it is signed in — only it knows that.
      A key found here is one an agent set to "an API key" would actually get.</p>` : ''}
    </div>`;
}

/**
 * Restarting, offered where somebody would look for it.
 *
 * It used to appear only in the notice after a save that needed one, which is
 * the moment you are told you need it and not the moment you go looking. The
 * roster is resolved once at import, so changing the team always needs a
 * restart, and "go and find the terminal it was started in" is not an
 * instruction somebody reaching this through a browser can follow.
 *
 * Three states, because two of them are different problems: a studio with no
 * supervisor cannot restart itself, and a studio too old to say either way is
 * not the same thing and must not be accused of it.
 */
function restartButton(id = 'set-restart') {
  if (data.canRestart) {
    return `<button class="btn" id="${id}" type="button" title="Stop the agents and start this studio again">Restart studio</button>`;
  }
  const why = data.canRestart === false
    ? 'This studio was started without a supervisor, so it cannot restart itself. Use `studio start`.'
    : 'This studio is running a version that cannot restart itself. Restart it once by hand and the button works after that.';
  return `<button class="btn" type="button" disabled title="${esc(why)}">Restart studio</button>`;
}

/**
 * The model list, from the provider where possible.
 *
 * A select rather than a text box with completions: a datalist filters itself
 * as you type, so choosing one model made the others disappear, which reads as
 * the list having been lost.
 *
 * The options come from the provider when this studio has a key for it, and
 * from the written suggestions otherwise — and the panel says which, because
 * "these are the models" and "these are the models somebody typed into a source
 * file months ago" deserve different amounts of trust. Whatever the agent is
 * already set to always appears, even if the provider has stopped listing it,
 * since silently dropping a human's setting is worse than showing a stale one.
 */
function modelField(a, i, vendorSpec, vendorId) {
  const fetched = modelsByVendor[vendorId];
  const list = fetched?.models?.length ? fetched.models : (vendorSpec?.models || []);
  const options = [...new Set([a.model, ...list].filter(Boolean))];
  const busy = modelsLoading === vendorId;

  return `
      <label class="set-f">
        <span>Model <em class="muted">optional</em></span>
        <select class="input" data-path="agents.${i}.model">
          <option value=""${a.model ? '' : ' selected'}>the provider's default</option>
          ${options.map((mdl) => `<option value="${esc(mdl)}"${mdl === a.model ? ' selected' : ''}>${esc(mdl)}</option>`).join('')}
        </select>
        <span class="set-key-actions">
          ${vendorSpec?.canListModels ? `<button class="btn ghost" type="button" data-models="${esc(vendorId)}"${busy ? ' disabled' : ''}>
            ${busy ? 'Asking…' : 'Refresh from provider'}</button>` : ''}
        </span>
        <em class="muted">${fetched?.source === 'provider'
    ? `From ${esc(vendorSpec?.label || vendorId)}, just now.`
    : fetched?.error
      ? esc(fetched.error)
      : (vendorSpec?.canListModels
        ? 'Suggestions written into this project. Refresh to ask the provider what it actually serves.'
        : 'Suggestions written into this project.')}</em>
      </label>`;
}

/**
 * The company options, and never an empty list.
 *
 * A select with no options renders as a blank box that cannot be used and does
 * not say why, which is what a browser holding this page shows when it is
 * talking to a studio old enough not to send the company list. Falling back to
 * the raw providers keeps the control usable and honest — it is the same
 * question asked in the older, worse vocabulary — and an agent whose setting
 * matches nothing on offer keeps an option of its own rather than silently
 * appearing to be something else.
 */
function vendorOptions(a, vendor, s) {
  const list = s.vendors || [];
  const opts = list.length
    ? list.map((v) => ({ id: v.id, label: v.label }))
    : (data.providers || []).map((pid) => ({ id: pid, label: pid }));

  if (!opts.some((o) => o.id === vendor)) {
    opts.unshift({ id: vendor, label: vendor === 'other' ? 'Other' : `${vendor} (from the file)` });
  }
  return opts.map((o) => `<option value="${esc(o.id)}"${o.id === vendor ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
}

/**
 * Company plus auth mode, written into the fields the config actually stores.
 *
 * This is the whole trick that lets the panel ask two human questions instead
 * of four technical ones: xAI with a login is the Grok CLI, xAI with a key is
 * the Codex CLI pointed at the xAI API, and nobody has to know that. Clearing
 * baseUrl and preset on the way matters — leaving them behind is how an agent
 * ends up labelled Anthropic while still talking to Moonshot.
 */
function applyVendor(agent, vendorId, authMode) {
  const v = (data.schema.vendors || []).find((x) => x.id === vendorId);
  if (!v || vendorId === 'other') return;
  const wantsKey = authMode === 'key' || !v.canLogin;
  Object.assign(agent, {
    provider: wantsKey ? (v.keyCli || v.loginCli) : (v.loginCli || v.keyCli),
    preset: wantsKey ? (v.keyPreset || '') : '',
    baseUrl: wantsKey ? (v.keyBaseUrl || '') : '',
    apiKeyEnv: wantsKey ? (v.keyVar || '') : '',
  });
  if (!agent.preset) delete agent.preset;
  // A company reachable only by key cannot be in login mode, and silently
  // leaving it there would show a mode that does nothing.
  if (!v.canLogin && agent.auth !== 'key') agent.auth = 'key';

  // A model belongs to the company it came from. Switching Anthropic to xAI and
  // leaving `claude-opus-5` in the box produces an agent that fails on its first
  // turn with a model name the new provider has never heard of. A model the
  // human typed themselves is left alone — only a suggestion this panel offered
  // for some other company is cleared.
  const suggestedElsewhere = (data.schema.vendors || [])
    .filter((x) => x.id !== vendorId)
    .some((x) => (x.models || []).includes(agent.model));
  if (agent.model && suggestedElsewhere) agent.model = '';

  // The credential status came from the server and describes the provider this
  // agent used to be. Keeping it would warn about a key variable that no longer
  // applies; the honest state until a save is "not checked yet".
  delete agent.credentials;
}

/**
 * Which company an agent is set to.
 *
 * Read backwards out of the fields the config actually stores, so an agent
 * configured by hand in the file shows up correctly here without anyone having
 * written a company name anywhere.
 */
function vendorOf(a, s) {
  const list = s.vendors || [];
  if (a.preset) {
    const byPreset = list.find((v) => v.keyPreset === a.preset);
    if (byPreset) return byPreset.id;
  }
  if (a.baseUrl) {
    const byUrl = list.find((v) => v.keyBaseUrl === a.baseUrl);
    return byUrl ? byUrl.id : 'other';
  }
  const byCli = list.find((v) => v.loginCli && v.loginCli === a.provider);
  return byCli ? byCli.id : 'other';
}

/**
 * How this agent proves who it is.
 *
 * The question a newcomer actually has is "do I paste a key, or is it already
 * signed in on this machine", and until now the panel could not express either.
 * A key typed here goes to a write-only route and into an encrypted store; it
 * is never rendered back, so the field shows whether one exists and not what
 * it is.
 */
function authBlock(a, i, s) {
  const cred = a.credentials || {};
  const mode = a.auth || 'auto';
  const stored = cred.source === 'studio';
  const canStore = data.secrets?.canStore;

  // No credentials block at all means this agent was just re-pointed and the
  // server has not been asked about it yet. Saying so beats showing the last
  // provider's warning as though it were this one's.
  const status = !a.credentials
    ? '<span class="pill">not checked yet — save to see whether this can run</span>'
    : (cred.ok
      ? `<span class="pill ok">${esc(cred.detail || 'ready')}</span>`
      : `<span class="pill warn">${esc(cred.detail || 'no credentials')}</span>`);

  return `
      <label class="set-f">
        <span>Authentication</span>
        <select class="input" data-path="agents.${i}.auth">
          ${(s.authModes || []).map((m) => `<option value="${esc(m)}"${m === mode ? ' selected' : ''}>${esc({
    auto: 'whatever this machine has',
    key: 'an API key',
    login: "this machine's CLI login",
  }[m] || m)}</option>`).join('')}
        </select>
      </label>

      <div class="set-f wide set-auth">
        <div>${status}</div>
        ${mode === 'key' ? `
          <label class="set-f wide">
            <span>API key</span>
            <input class="input" type="password" autocomplete="off" spellcheck="false"
                   id="key-${i}" placeholder="${stored ? 'a key is stored — type to replace it' : 'paste the key'}">
            <span class="set-key-actions">
              <button class="btn" type="button" data-setkey="${esc(a.id)}:${i}">Save key</button>
              ${stored ? `<button class="btn ghost danger" type="button" data-clearkey="${esc(a.id)}">Remove</button>` : ''}
            </span>
            <em class="muted">Stored encrypted, never shown again, and never written to the
            config file.${canStore && data.secrets?.keySource === 'studio'
    ? ' The encryption key sits beside it on this machine.' : ''}</em>
          </label>
          ${canStore ? '' : `
          <div class="set-note">Keys are stored encrypted. This studio will make the encryption
          key itself when you save — it will tell you what that does and does not protect
          first.</div>`}` : ''}
      </div>`;
}

function agentCard(a, i, s) {
  const prot = data.protectedFields?.[a.id] || [];
  const isCustomPersona = a.persona && !s.personas.includes(a.persona);
  // Which company this agent is set to, worked out from what the config stores
  // rather than asked for separately. An unrecognised combination lands on
  // "Other" instead of being relabelled as whatever sits first in the list.
  const vendor = vendorOf(a, s);
  const vendorSpec = (s.vendors || []).find((v) => v.id === vendor);
  const detected = detectResult?.vendors?.find((v) => v.id === vendor);
  return `
  <div class="set-agent" data-i="${i}">
    <div class="set-agent-head">
      <span class="set-agent-n">${i + 1}</span>
      <label class="set-f">
        <span>Agent name</span>
        <input class="input" data-path="agents.${i}.id" value="${esc(a.id)}"
               placeholder="what the team calls it">
      </label>
      <label class="set-f">
        <span>Provider</span>
        <select class="input" data-path="agents.${i}.vendor.select">
          ${vendorOptions(a, vendor, s)}
        </select>
      </label>
      <div class="set-agent-move">
        <button class="btn ghost" data-move="${i}:-1" type="button" title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
        <button class="btn ghost" data-move="${i}:1" type="button" title="Move down"${i === draft.agents.length - 1 ? ' disabled' : ''}>↓</button>
        <button class="btn ghost danger" data-remove="${i}" type="button" title="Remove this agent">remove</button>
      </div>
    </div>

    <div class="set-agent-body">
      <label class="set-f">
        <span>Persona</span>
        <select class="input" data-path="agents.${i}.persona.select">
          ${s.personas.map((p) =>
    `<option value="${esc(p)}"${p === a.persona ? ' selected' : ''}>${esc(p)}</option>`).join('')}
          <option value="__custom"${isCustomPersona ? ' selected' : ''}>custom…</option>
        </select>
      </label>
      ${isCustomPersona ? `<label class="set-f wide">
        <span>Custom persona</span>
        <textarea class="input" rows="3" data-path="agents.${i}.persona">${esc(a.persona)}</textarea>
      </label>` : ''}

      ${modelField(a, i, vendorSpec, vendor)}

      ${authBlock(a, i, s)}

      ${a.preset || a.baseUrl ? `<label class="set-f wide">
        <span>API base URL</span>
        <input class="input" data-path="agents.${i}.baseUrl" spellcheck="false"
               value="${esc(a.baseUrl || '')}" placeholder="https://…">
        <em class="muted">Must be https. This is where the key gets sent.</em>
      </label>
      <label class="set-f wide">
        <span>API key, from this environment variable</span>
        <input class="input" data-path="agents.${i}.apiKeyEnv" spellcheck="false"
               value="${esc(a.apiKeyEnv || '')}" placeholder="MOONSHOT_API_KEY">
        <em class="muted">The studio reads the key from this variable at launch. Naming a
        variable keeps the secret out of the config file, which is worth committing.</em>
      </label>
      ${a.apiKey ? `<div class="set-warn">
        This agent has a literal API key in the config file. That file is meant to be
        committed — move the key into an environment variable and name it above.</div>` : ''}` : ''}

      <label class="set-f">
        <span>Sandbox <em class="muted">codex</em></span>
        <select class="input" data-path="agents.${i}.sandbox">
          <option value="">default</option>
          ${s.sandboxes.map((v) =>
    `<option value="${esc(v)}"${v === a.sandbox ? ' selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
      </label>

      <label class="set-f">
        <span>Permissions <em class="muted">claude / grok</em></span>
        <select class="input" data-path="agents.${i}.permissionMode">
          <option value="">default</option>
          ${s.permissionModes.map((v) =>
    `<option value="${esc(v)}"${v === a.permissionMode ? ' selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
      </label>
    </div>

    ${a.provider && !data.providers.includes(a.provider) ? `<div class="set-warn">
      No adapter is loaded for <b>${esc(a.provider)}</b>, so this agent cannot run and the
      studio will refuse to start while it is in the roster. Add the adapter to
      <code>adapters</code> in the config file, or pick a company above.</div>` : ''}
    ${vendor === 'other' && a.provider ? `<div class="set-locked">
      Configured in the file rather than from this list: <code>${esc(a.provider)}</code>${a.baseUrl
    ? ` at <code>${esc(a.baseUrl)}</code>` : ''}. Choosing a company above would replace that.</div>` : ''}
    ${a.sandbox === 'full' ? `<div class="set-warn">
      <b>full</b> bypasses Codex's approvals and sandbox entirely. This agent can run
      any command on this machine.</div>` : ''}
    ${prot.length ? `<div class="set-locked">
      Set in the file and preserved on save: ${prot.map((k) => `<code>${esc(k)}</code>`).join(' ')}
    </div>` : ''}
  </div>`;
}

// -------------------------------------------------------------------- wiring

function wire() {
  wireProject();
  wireUpdate();
  $('settings').querySelectorAll('[data-path]').forEach((input) => {
    input.oninput = () => onEdit(input);
    input.onchange = () => onEdit(input);
  });

  $('settings').querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = () => {
      const [i, d] = b.dataset.move.split(':').map(Number);
      const j = i + d;
      if (j < 0 || j >= draft.agents.length) return;
      [draft.agents[i], draft.agents[j]] = [draft.agents[j], draft.agents[i]];
      dirty = true;
      render();
    };
  });

  $('settings').querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.remove);
      if (draft.agents.length === 1) {
        setNotice('warn', 'A studio needs at least one agent.');
        return render();
      }
      if (!confirm(`Remove "${draft.agents[i].id}" from the roster?`)) return;
      draft.agents.splice(i, 1);
      dirty = true;
      render();
    };
  });

  const add = $('set-add-agent');
  if (add) {
    add.onclick = () => {
      const used = new Set(draft.agents.map((a) => a.id));
      let n = draft.agents.length + 1;
      while (used.has(`agent-${n}`)) n++;
      draft.agents.push({
        id: `agent-${n}`,
        provider: data.providers[0] || 'claude',
        label: '',
        persona: 'implementer',
        model: '',
        sandbox: '',
        permissionMode: '',
      });
      dirty = true;
      render();
    };
  }

  $('set-reload').onclick = async () => {
    if (dirty && !confirm('Discard your unsaved changes and reload the file?')) return;
    dirty = false;
    setNotice(null);
    await load();
  };

  $('set-save').onclick = save;
}

function wireUpdate() {
  const check = $('upd-check');
  if (check) {
    check.onclick = async () => {
      checking = true; render();
      try {
        update = await (await fetch('/api/update?check=1')).json();
      } catch {
        setNotice('warn', 'Could not check for updates.');
      }
      checking = false; render();
    };
  }

  const apply = $('upd-apply');
  if (apply) {
    apply.onclick = async () => {
      if (!confirm('Update the studio and restart it?\n\nAgents will be stopped. '
        + 'Your project and its history are untouched.')) return;
      setNotice('', 'Updating… the studio will restart and this page will reconnect.');
      render();
      let r;
      try {
        r = await (await fetch('/api/update', { method: 'POST' })).json();
      } catch {
        // The server may exit before the response lands. That is a successful
        // update, not a failure.
        return waitForRestart();
      }
      if (!r.ok) {
        setNotice('warn', (r.errors || [r.error]).map(esc).join('; '));
        return render();
      }
      if (!r.changed) {
        setNotice('ok', 'Already up to date.');
        return render();
      }
      return waitForRestart();
    };
  }
}

function wireProject() {
  const input = $('proj-path');
  if (!input) return;

  let timer = null;
  input.oninput = () => {
    pathDraft = input.value;
    // Probe as you type, debounced. A stat() per keystroke would be rude to the
    // filesystem and would race its own responses.
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const typed = pathDraft.trim();
      if (!typed) { probe = null; return renderKeepingCaret(); }
      try {
        probe = await (await fetch(`/api/projects/inspect?path=${encodeURIComponent(typed)}`)).json();
      } catch {
        probe = { ok: false, problems: ['could not reach the studio'], info: { path: typed } };
      }
      // Ignore a reply that arrived after the human typed on.
      if (probe?.info?.path && pathDraft.trim() && probe.ok) renderKeepingCaret();
      else renderKeepingCaret();
    }, 220);
  };

  $('settings').querySelectorAll('[data-recent]').forEach((b) => {
    b.onclick = () => {
      pathDraft = b.dataset.recent;
      probe = null;
      render();
      $('proj-path')?.focus();
      $('proj-path')?.dispatchEvent(new Event('input'));
    };
  });

  const go = async (reset) => {
    const target = pathDraft.trim();
    if (!target) return;
    if (dirty && !confirm('You have unsaved configuration changes. Switch anyway and lose them?')) return;
    if (reset && !confirm(
      `Delete all recorded studio history for:

${target}

`
      + 'Its code, brief and config are untouched. This cannot be undone.')) return;

    setNotice('', 'Switching… the studio is restarting. This page will reconnect.');
    render();
    let r;
    try {
      r = await (await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: target, reset }),
      })).json();
    } catch {
      // The server may exit before the response lands; that is a successful
      // switch, not a failure, so say so rather than crying wolf.
      return waitForRestart();
    }
    if (!r.ok) {
      setNotice('warn', (r.errors || [r.error]).map(esc).join('; '));
      return render();
    }
    return waitForRestart();
  };

  // A key never travels with the rest of the form: the config save writes a
  // file meant to be committed, and this goes to a write-only route instead.
  $('settings').querySelectorAll('[data-setkey]').forEach((b) => {
    b.onclick = async () => {
      const [agent, i] = b.dataset.setkey.split(':');
      const input = $(`key-${i}`);
      const value = input?.value || '';
      if (!value.trim()) return;
      // The one place a human is told what they are trading before they trade
      // it. A generated passphrase lives beside the keys it protects, and
      // saying so here is the difference between a choice and a surprise.
      if (!data.secrets?.canStore && !confirm(
        'The studio will make an encryption key and keep it in the same folder as your '
        + 'saved keys.\n\n'
        + 'That stops someone reading the key file on its own. It does not help if '
        + 'someone copies the whole folder, or a backup of it, because they would get '
        + 'both.\n\n'
        + 'For stronger protection, set STUDIO_SECRET_KEY where the studio runs, and the '
        + 'encryption key lives outside the folder instead.\n\n'
        + 'Save the key now?',
      )) return;
      const r = await postKey(agent, value, { generateKey: !data.secrets?.canStore });
      if (input) input.value = '';
      if (r.ok) setNotice('ok', `Key stored for ${esc(agent)}.`);
      else setNotice('warn', esc(r.error || 'that key could not be stored'));
      return load();
    };
  });
  $('settings').querySelectorAll('[data-clearkey]').forEach((b) => {
    b.onclick = async () => {
      const agent = b.dataset.clearkey;
      if (!confirm(`Remove the stored API key for ${agent}?`)) return;
      const r = await postKey(agent, '');
      setNotice(r.ok ? 'ok' : 'warn', r.ok ? `Key removed for ${esc(agent)}.` : esc(r.error || 'could not remove it'));
      return load();
    };
  });

  for (const id of ['set-restart', 'set-restart-2', 'set-restart-3']) {
    const b = $(id);
    if (!b) continue;
    b.onclick = async () => {
      if (dirty && !confirm('You have unsaved changes. Restart anyway and lose them?')) return;
      setNotice('', 'Restarting… the studio is coming back and this page will reconnect.');
      render();
      try {
        const r = await (await fetch('/api/restart', { method: 'POST' })).json();
        if (!r.ok) {
          setNotice('warn', esc(r.error || 'the studio refused to restart'));
          return render();
        }
      } catch {
        // The socket dies with the process, which is a successful restart
        // rather than a failure — so wait for it rather than crying wolf.
      }
      return waitForRestart();
    };
  }

  $('settings').querySelectorAll('[data-models]').forEach((b) => {
    b.onclick = async () => {
      const vendorId = b.dataset.models;
      modelsLoading = vendorId;
      render();
      try {
        modelsByVendor[vendorId] = await (await fetch(`/api/models?vendor=${encodeURIComponent(vendorId)}`)).json();
      } catch {
        modelsByVendor[vendorId] = { ok: false, models: [], error: 'the studio did not answer' };
      }
      modelsLoading = null;
      render();
    };
  });

  const detectBtn = $('set-detect');
  if (detectBtn) {
    detectBtn.onclick = async () => {
      detecting = true;
      render();
      try {
        detectResult = await (await fetch('/api/detect')).json();
      } catch {
        setNotice('warn', 'The studio did not answer the detection request.');
      }
      detecting = false;
      render();
    };
  }

  $('proj-switch').onclick = () => go(false);
  $('proj-reset').onclick = () => go(true);

  const cloneBox = $('proj-clone');
  if (cloneBox) {
    cloneBox.oninput = () => {
      const wasEmpty = !cloneDraft.trim();
      cloneDraft = cloneBox.value;
      // Only re-render when the button's enabled state actually changes, or
      // every keystroke would rebuild the panel and lose the caret.
      if (wasEmpty !== !cloneDraft.trim()) renderKeepingCaret('proj-clone');
    };
    cloneBox.onkeydown = (e) => { if (e.key === 'Enter') $('proj-clone-go')?.click(); };
  }

  const cloneGo = $('proj-clone-go');
  if (cloneGo) {
    cloneGo.onclick = async () => {
      const url = cloneDraft.trim();
      if (!url || cloning) return;
      cloning = true;
      setNotice('', `Cloning ${url}…`);
      render();
      let r;
      try {
        r = await (await fetch('/api/projects/clone', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url }),
        })).json();
      } catch {
        cloning = false;
        setNotice('warn', 'The studio did not answer. The clone may still be running — check the terminal.');
        return render();
      }
      cloning = false;
      if (!r.ok) {
        // The clone failed for a reason the human can act on, and git's own
        // last words are worth more than a summary of them.
        setNotice('warn', `${esc(r.error)}${r.output ? `<pre class="set-out">${esc(r.output)}</pre>` : ''}`);
        return render();
      }
      // Cloned. Now move the studio into it, which is the existing switch and
      // the existing wait for the replacement to come back.
      cloneDraft = '';
      pathDraft = r.path;
      probe = null;
      setNotice('', `Cloned into ${r.path} — switching…`);
      render();
      return go(false);
    };
  }
}

/**
 * Wait for the replacement studio to answer, then reload.
 *
 * The old process exits and a new one binds the same port, so there is a gap of
 * a second or two where nothing is listening. Polling through it is friendlier
 * than a dead page and more honest than pretending the switch was instant.
 */
async function waitForRestart() {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (r.ok) return void location.reload();
    } catch { /* still down */ }
  }
  setNotice('warn', 'The studio did not come back. Check the terminal you started it in.');
  render();
}

/** Re-render without stealing the caret out of the box being typed in. */
function renderKeepingCaret(id = 'proj-path') {
  const el = $(id);
  const pos = el?.selectionStart ?? null;
  const focused = document.activeElement === el;
  render();
  const next = $(id);
  if (next && focused) {
    next.focus();
    if (pos != null) next.setSelectionRange(pos, pos);
  }
}

function onEdit(input) {
  const path = input.dataset.path;
  const value = input.type === 'checkbox' ? input.checked : input.value;

  if (path.endsWith('.vendor.select') || path.endsWith('.auth')) {
    const i = Number(path.split('.')[1]);
    if (path.endsWith('.auth')) draft.agents[i].auth = value;
    const vendorId = path.endsWith('.vendor.select') ? value : vendorOf(draft.agents[i], data.schema);
    applyVendor(draft.agents[i], vendorId, draft.agents[i].auth || 'auto');
    dirty = true;
    return render();
  }

  if (path.endsWith('.backend.select')) {
    const i = Number(path.split('.')[1]);
    const chosen = (data.schema.backends || []).find((b) => b.id === value);
    if (chosen) {
      // Both halves at once, because they are one decision. Clearing baseUrl and
      // apiKeyEnv on a native backend matters: leaving them behind is how an
      // agent ends up pointed at Moonshot while its label says Anthropic.
      Object.assign(draft.agents[i], {
        provider: chosen.provider,
        preset: chosen.preset || undefined,
        baseUrl: chosen.baseUrl || '',
        apiKeyEnv: chosen.apiKeyEnv || '',
      });
      if (!chosen.preset) delete draft.agents[i].preset;
    }
    dirty = true;
    return render();
  }

  if (path.endsWith('.preset.select')) {
    const i = Number(path.split('.')[1]);
    const preset = data.schema.presets?.[value];
    if (!value) {
      delete draft.agents[i].preset;
    } else if (preset) {
      // Fill the fields in rather than hiding them: the human should be able to
      // see and change where their key is going.
      Object.assign(draft.agents[i], {
        preset: value,
        provider: preset.provider || draft.agents[i].provider,
        baseUrl: preset.baseUrl || '',
        apiKeyEnv: preset.apiKeyEnv || '',
      });
    }
    dirty = true;
    return render();
  }

  if (path.endsWith('.persona.select')) {
    const i = Number(path.split('.')[1]);
    // "custom…" seeds the textarea with the built-in text so the human edits a
    // real starting point rather than an empty box.
    draft.agents[i].persona = value === '__custom' ? (draft.agents[i].persona || '') : value;
    dirty = true;
    return render();
  }

  const parts = path.split('.');
  let target = draft;
  for (let k = 0; k < parts.length - 1; k++) target = target[parts[k]];
  target[parts.at(-1)] = value;
  dirty = true;

  // Re-render only for things that change the shape of the form; otherwise the
  // caret would jump to the end of the field on every keystroke.
  if (path.endsWith('.sandbox')) return render();
  $('set-save').disabled = false;
}

async function save() {
  const btn = $('set-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const patch = {
    project: {
      name: draft.project.name,
      brief: draft.project.brief,
      goal: draft.project.goal || '',
    },
    agents: draft.agents.map((a) => {
      const out = { id: a.id, provider: a.provider, persona: a.persona };
      if (a.label) out.label = a.label;
      if (a.model) out.model = a.model;
      if (a.preset) out.preset = a.preset;
      if (a.baseUrl) out.baseUrl = a.baseUrl;
      if (a.apiKeyEnv) out.apiKeyEnv = a.apiKeyEnv;
      if (a.sandbox) out.sandbox = a.sandbox;
      if (a.permissionMode) out.permissionMode = a.permissionMode;
      return out;
    }),
    runner: {
      ...draft.runner,
      idleBackoffMs: String(draft.runner.idleBackoffMs)
        .split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)),
    },
  };
  // server settings are read-only here; do not send them back as an edit
  delete patch.runner.inboxWaitMs;

  let r;
  try {
    r = await (await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })).json();
  } catch (e) {
    setNotice('warn', `Could not reach the studio: ${esc(e.message)}`);
    btn.textContent = 'Save';
    return render();
  }

  btn.textContent = 'Save';

  if (!r.ok) {
    const list = r.errors?.length
      ? `<ul>${r.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
      : `<div>${esc(r.error || 'save failed')}</div>`;
    setNotice('warn', `<b>Not saved.</b>${list}`);
    return render();
  }

  dirty = false;
  const warned = r.warnings?.length
    ? `<div style="margin-top:6px"><b>Still needs attention:</b><ul>${
      r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : '';
  const live = r.applied?.length
    ? `Applied now: ${r.applied.map((x) => `<code>${esc(x)}</code>`).join(' ')}.`
    : '';
  // A restart used to be an instruction to go and find the terminal this was
  // started in — which somebody reaching the studio only through a browser
  // cannot do at all.
  const later = r.restartRequired?.length
    ? ` <b>The rest needs a restart</b> — ${esc(r.restartRequired.join('; '))}.`
      + (data.canRestart
        ? ' <button class="btn primary" id="set-restart-3" type="button">Restart it now</button>'
        : ' This studio cannot restart itself — see the button at the top for why.')
    : '';
  setNotice(r.restartRequired?.length || r.warnings?.length ? 'warn' : 'ok',
    `Saved to the config file. ${live}${later}${warned}`);

  await load();
}

/** Has the file drifted from the roster this process is actually running? */
function rosterDiverged() {
  if (!data?.running || !data?.config?.agents) return null;
  const running = data.running.map((a) => a.id).join(', ');
  const file = data.config.agents.map((a) => a.id).join(', ');
  return running === file ? null : { running, file };
}

// --------------------------------------------------------------- form helpers

function field(label, type, value, path, when, help = '') {
  return `<label class="set-f wide">
    <span>${esc(label)} ${badge(when)}</span>
    <input class="input" type="${type}" data-path="${path}" value="${esc(value ?? '')}">
    ${help ? `<em class="muted">${esc(help)}</em>` : ''}
  </label>`;
}

function area(label, value, path, when, help = '') {
  return `<label class="set-f wide">
    <span>${esc(label)} ${badge(when)}</span>
    <textarea class="input" rows="3" data-path="${path}">${esc(value ?? '')}</textarea>
    ${help ? `<em class="muted">${esc(help)}</em>` : ''}
  </label>`;
}

// `step` because a number input defaults to whole numbers, and a spend budget
// of $2.50 would be rejected by the browser before the API ever saw it.
function num(label, value, path, help = '', step = '') {
  return `<label class="set-f">
    <span>${esc(label)}</span>
    <input class="input" type="number" data-path="${path}" value="${esc(String(value ?? ''))}"
           ${step ? `step="${esc(step)}" min="0"` : ''}>
    ${help ? `<em class="muted">${esc(help)}</em>` : ''}
  </label>`;
}

function badge(when) {
  if (when === 'live') return '<span class="pill live" title="Takes effect immediately">live</span>';
  if (when === 'restart') return '<span class="pill warn" title="Needs a studio restart">restart</span>';
  return '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * The edit handler, reachable from a test.
 *
 * Switching provider has to rewrite four fields, drop a model that belonged to
 * the old one, and forget a credential status that described it — none of which
 * a stub browser can reach by clicking, because there is nothing to click.
 */
export const __test_onEdit = (input) => onEdit(input);
