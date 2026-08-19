/**
 * The window the human watches the studio through.
 *
 * Live events arrive over SSE. Raw events are appended straight to the raw feed;
 * anything that changes shared state triggers a debounced refetch of the whole
 * projection, which keeps every view honest with a trivial amount of code.
 */

// First, and before any other module gets a chance to fetch: a studio with a
// token refuses every /api/ call without one, and the failure looks like a
// frozen page rather than a locked one.
import { installAuth, withToken, TOKEN } from './token.js';
import { isHumanDirected } from './message-addressing.js';
import { refillKeepingPlace } from './scroll-follow.js';
import { refreshSettings } from './settings.js';
import { renderUsage } from './usage.js';
import { showPreview, hidePreview } from './preview.js';
import { startUpdateWatch } from './update-badge.js';
import { livenessState, livenessTitle } from './liveness.js';

const $ = (id) => document.getElementById(id);
/**
 * The roster, learned from the server rather than hardcoded.
 *
 * This UI used to declare `['codex','claude','grok']` and a test asserted that
 * it did. That is fine for one studio and wrong for a tool: the team is
 * whatever studio.config.json says, in that order, and it may be two agents or
 * eight, with ids that are roles rather than vendors.
 */
let AGENTS = [];
let ROSTER = [];

/** Distinguishable even when every agent is the same provider. */
const PALETTE = [
  '#7bd88f', '#e0a06a', '#b58cf0', '#6ab7e0',
  '#e07b9a', '#c8d86a', '#8f9ce0', '#e0c86a',
];
const agentColor = (id) => PALETTE[Math.max(0, AGENTS.indexOf(id)) % PALETTE.length];

/** Attributes that colour a span by which agent it belongs to. */
function agentAttrs(id) {
  if (!id || !AGENTS.includes(id)) return '';
  return ` data-agent="${esc(id)}" style="--agent-color:${agentColor(id)}"`;
}
const COLUMNS = [
  ['proposed', 'Proposed'],
  ['ready', 'Ready'],
  ['assigned', 'Assigned'],
  ['active', 'Active'],
  ['blocked', 'Blocked'],
  ['under-review', 'Review'],
  ['completed', 'Done'],
];

let state = null;
let rawEvents = [];
let lastSeq = 0;
// Views built from `state` pass a redraw function to openDrawer so the drawer
// follows SSE updates instead of going stale. Declared here because the first
// render happens below, before the drawer section is reached.
let drawerRedraw = null;

// Liveness bookkeeping. Declared up here rather than beside renderLiveness
// because startup runs `refresh()` during module evaluation, and a `let` read
// before its declaration is a ReferenceError that takes the whole page with it.
let connected = false;
let downSince = null;
let attempts = 0;
let lastEventAt = null;
let baseTitle = 'Studio Floor';
/** The studio refused us. Nothing else is worth trying until that changes. */
let locked = false;

// ------------------------------------------------------------------ startup

installAuth();

// Startup stops at the first refusal rather than carrying on into it. Every
// step below asks the same API the same way, so a 401 that is survivable in
// refresh() is only survivable if nothing after it tries again — the first
// version of this fix cleared the render and then threw in primeRaw() instead,
// which is the same blank page one function later.
await refresh();
if (!locked) {
  await primeRaw();
  connect();
  wireControls();
  startUpdateWatch();
}

async function refresh() {
  const r = await fetch('/api/state');
  // A 401 used to be assigned to `state` as though it were state, and the first
  // render then threw on `Object.values(state.tasks)` — killing module
  // evaluation and leaving a static shell with no explanation in it. Say what
  // happened instead: a locked studio should look locked.
  if (!r.ok) {
    if (r.status === 401) return void lockedOut();
    throw new Error(`the studio answered ${r.status} for /api/state`);
  }
  locked = false;
  state = await r.json();
  adoptRoster(state);
  // Seeded from the log rather than from page load: opening a tab on a studio
  // that has been idle for an hour should say so immediately, not start the
  // clock again and look healthy for ten minutes.
  if (lastEventAt === null) {
    const newestTs = state.timeline?.length ? Date.parse(state.timeline.at(-1).ts) : NaN;
    lastEventAt = Number.isFinite(newestTs) ? newestTs : Date.now();
  }
  renderAll();
}

/**
 * A studio that will not talk to us, said out loud.
 *
 * The page is served to anyone; the API is not. So this is the one failure a
 * browser can hit before it knows anything at all, and it has to explain itself
 * without any of the machinery below being alive yet.
 */
function lockedOut() {
  locked = true;
  const el = $('liveness');
  if (el) {
    el.hidden = false;
    el.className = 'liveness down';
    el.innerHTML = '<strong>THIS STUDIO NEEDS ITS TOKEN</strong> '
      + '<span class="lv-detail">open it once as '
      + '<code>' + esc(location.pathname) + '?token=&lt;STUDIO_TOKEN&gt;</code>'
      + (TOKEN ? ' — the token this page is holding was refused' : '')
      + '</span>';
  }
  document.title = 'locked — Studio Floor';
}

// --------------------------------------------------------------- liveness

/**
 * Say plainly when nothing is happening.
 *
 * The only signal this page had was the word "reconnecting…" beside the studio
 * name, and the studio once died under it for 87 minutes. Runs on its own timer
 * as well as on events, because the interesting case is precisely the one where
 * no event arrives to trigger a render.
 */
function renderLiveness() {
  const el = $('liveness');
  if (!el) return;
  const agents = Object.values(state?.agents || {});
  const { level, headline, detail } = livenessState({
    connected,
    downSince,
    lastEventAt,
    attempts,
    now: Date.now(),
    paused: !!state?.paused,
    running: agents.filter((a) => a.state !== 'offline' && !a.paused).length,
  });

  el.hidden = level === 'ok';
  el.className = `liveness ${level}`;
  el.innerHTML = level === 'ok' ? ''
    : `<strong>${esc(headline)}</strong> <span class="lv-detail">${esc(detail)}</span>`;
  document.title = livenessTitle(level, baseTitle);
}
setInterval(renderLiveness, 5_000);

/**
 * Learn the team from the server.
 *
 * `roster` is authoritative and ordered. `state.agents` is the fallback for a
 * server old enough not to send one — losing the order but never losing an
 * agent, which is the failure that matters.
 */
function adoptRoster(s) {
  const next = Array.isArray(s.roster) && s.roster.length
    ? s.roster
    : Object.keys(s.agents || {}).map((id) => ({ id, label: id }));
  const changed = next.map((a) => a.id).join(',') !== AGENTS.join(',');
  ROSTER = next;
  AGENTS = next.map((a) => a.id);
  if (changed) fillAgentSelects();
  if (s.project?.name) {
    baseTitle = `${s.project.name} — studio`;
    document.title = baseTitle;
  }
}

function labelOf(id) {
  return ROSTER.find((a) => a.id === id)?.label || id;
}

/** Every place the human picks an agent is built from the roster, never from markup. */
function fillAgentSelects() {
  for (const [id, blank] of [
    ['new-task-owner', 'unassigned'],
    ['raw-agent', 'all agents'],
    ['say-to', 'everyone'],
  ]) {
    const el = $(id);
    if (!el) continue;
    const keep = el.value;
    el.innerHTML = `<option value="">${blank}</option>`
      + AGENTS.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    if (AGENTS.includes(keep)) el.value = keep;
  }
}

async function primeRaw() {
  const r = await fetch('/api/events?raw=true&limit=400');
  if (!r.ok) return;
  const { events } = await r.json();
  rawEvents = events;
  renderRaw();
}

function connect(since = state.seq) {
  const es = new EventSource(withToken(`/api/stream?since=${since}`));
  es.onopen = () => {
    $('conn-dot').classList.add('on');
    $('studio-sub').textContent = 'live';
    connected = true;
    downSince = null;
    attempts = 0;
    renderLiveness();
  };
  es.onerror = () => {
    $('conn-dot').classList.remove('on');
    $('studio-sub').textContent = 'reconnecting…';
    connected = false;
    if (!downSince) downSince = Date.now();
    attempts += 1;
    renderLiveness();
    // EventSource's own retry reuses the URL it was built with, so it would
    // reconnect forever at the cursor captured at page load. Rebuild it at the
    // last sequence we actually saw.
    es.close();
    setTimeout(() => connect(lastSeq || since), 1000);
  };
  // The server could not replay everything we missed. Re-prime rather than
  // leaving a hole in the raw feed.
  es.addEventListener('gap', () => {
    primeRaw();
    scheduleRefresh();
  });
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    lastEventAt = Date.now();
    if (ev.seq <= lastSeq) return;
    lastSeq = ev.seq;
    if (ev.kind.startsWith('raw.')) {
      rawEvents.push(ev);
      if (rawEvents.length > 4000) rawEvents.splice(0, 1000);
      appendRaw(ev);
      if (ev.kind === 'raw.turn.start' || ev.kind === 'raw.turn.end' || ev.kind === 'raw.tool.call') scheduleRefresh();
    } else {
      scheduleRefresh();
    }
  };
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}

// ------------------------------------------------------------------- render

function renderAll() {
  renderLiveness();
  renderGlance();
  renderUsage(state);
  renderAgents();
  renderAttention();
  renderConversation();
  renderTimeline();
  renderBoard();
  renderDecisions();
  renderRight();
  refreshDrawer();
}

function renderGlance() {
  const tasks = Object.values(state.tasks);
  const active = tasks.filter((t) => t.state === 'active').length;
  const review = tasks.filter((t) => t.state === 'under-review').length;
  const blocked = tasks.filter((t) => t.state === 'blocked').length;
  const done = tasks.filter((t) => t.state === 'completed').length;
  const busy = Object.values(state.agents).filter((a) => ['working', 'thinking', 'reviewing'].includes(a.state)).length;
  const debates = Object.values(state.debates).filter((d) => d.status === 'open').length;
  const att = queueTotal();

  $('glance').innerHTML = [
    item(`<b>${busy}</b> agents active`),
    item(`<b>${active}</b> active`),
    review ? item(`<b>${review}</b> in review`) : '',
    blocked ? item(`<b class="health-bad">${blocked}</b> blocked`) : '',
    item(`<b>${done}</b> done`),
    debates ? item(`<b>${debates}</b> open debate${debates > 1 ? 's' : ''}`) : '',
    // Clicking this opens the same categorised queue as the "Needs you" header.
    att
      ? item(`<b class="health-bad">${att}</b> awaiting you`, 'glance-attention')
      : item('nothing awaiting you', 'glance-attention'),
    state.paused ? item('<b class="health-bad">PAUSED</b>') : '',
  ].join('');
  function item(h, id) {
    if (!h) return '';
    if (!id) return `<span class="g-item">${h}</span>`;
    return `<span class="g-item clickable" id="${id}" role="button" tabindex="0" title="Show everything that is waiting on you">${h}</span>`;
  }
}

function renderAgents() {
  const el = $('agents');
  el.innerHTML = '';
  for (const id of AGENTS) {
    const a = state.agents[id] || { id, state: 'offline' };
    const d = document.createElement('div');
    d.className = 'agent';
    const busy = ['working', 'thinking', 'reviewing'].includes(a.state);
    d.innerHTML = `
      <div class="row">
        <span class="name"${agentAttrs(id)}>${esc(labelOf(id))}</span>
        <span class="st ${a.state} ${busy ? 'pulse' : ''}">${a.paused ? 'paused' : a.state}</span>
      </div>
      <div class="meta">
        ${a.currentTask ? `<span class="task">${a.currentTask}</span> · ` : ''}${esc(a.note || (a.strengths?.length ? a.strengths.join(', ') : '—'))}
      </div>
      ${a.lastTool ? `<div class="tool">${esc(a.lastTool.name)}: ${esc(clip(a.lastTool.brief, 70))}</div>` : ''}
      <div class="meta muted">turn ${a.turns || 0}${a.toolCalls ? ` · ${a.toolCalls} tool calls` : ''}${a.usage?.output_tokens ? ` · ${a.usage.output_tokens} out` : ''}</div>
      <div class="acts">
        <button class="btn" data-act="start" data-agent="${id}">start</button>
        <button class="btn" data-act="stop" data-agent="${id}">stop</button>
        <button class="btn" data-act="nudge" data-agent="${id}">nudge</button>
        <button class="btn" data-act="raw" data-agent="${id}">raw</button>
      </div>`;
    d.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return openAgent(id);
      e.stopPropagation();
      agentAction(b.dataset.act, b.dataset.agent);
    });
    el.appendChild(d);
  }
}

function renderAttention() {
  const open = state.attention.filter((a) => a.status === 'open');
  // The badge counts everything waiting on the human, not only escalations —
  // otherwise it reads 0 while three tasks sit blocked. The hint says so.
  const total = queueTotal();
  $('attention-count').textContent = total;
  $('attention-count').className = `badge ${total ? 'hot' : ''}`;
  $('attention-hint').innerHTML = total
    ? `${total} thing${total === 1 ? '' : 's'} waiting on you — escalations, questions, blocked work, work in review, open debates. <b>Click “Needs you” for all of them.</b>`
    : 'nothing is waiting on you.';
  const el = $('attention');
  const show = open.length ? open : state.attention.slice(-2);
  if (!show.length) return void (el.innerHTML = '<div class="empty">nothing right now</div>');
  el.innerHTML = '';
  for (const a of show) {
    const d = document.createElement('div');
    d.className = `att ${a.status === 'open' ? '' : 'cleared'}`;
    d.innerHTML = `
      <div class="k">${esc(a.kind)} · ${esc(a.by || '')}</div>
      <div class="tx">${esc(a.text)}</div>
      ${a.options?.length ? `<div class="opts">options: ${a.options.map(esc).join(' · ')}</div>` : ''}
      ${a.ref ? `<div class="opts">re ${esc(a.ref)}</div>` : ''}
      ${a.status === 'open' ? `<div class="acts">
        <button class="btn" data-v="approve">approve</button>
        <button class="btn" data-v="reject">reject</button>
        <button class="btn" data-v="reply">reply</button>
      </div>` : `<div class="opts">${esc(a.resolution || 'cleared')}</div>`}`;
    d.querySelectorAll('button').forEach((b) => {
      b.onclick = () => attentionVerdict(a, b.dataset.v);
    });
    el.appendChild(d);
  }
}

/** The panel and the drawer must answer an escalation in exactly the same way. */
async function attentionVerdict(a, verdict) {
  const text = prompt(verdict === 'reply' ? 'Your answer to the team:' : `Note for ${verdict} (optional):`) ?? '';
  if (verdict === 'reply' && !text) return;
  await post('/api/human/verdict', { target: a.id, verdict, text });
  if (text) await post('/api/human/say', { to: [], text: `(on "${clip(a.text, 60)}") ${text}` });
}

function renderConversation() {
  const el = $('conversation');
  refillKeepingPlace(el, () => {
    el.innerHTML = '';
    if (!state.messages.length) el.innerHTML = '<div class="empty">no messages yet — the agents have not spoken.</div>';
    for (const m of newest(state.messages)) {
      const d = document.createElement('div');
      d.className = `msg ${m.from === 'human' ? 'human' : ''} ${isHumanDirected(m) ? 'to-human' : ''}`;
      d.innerHTML = `
      <div class="head">
        <span class="who"${agentAttrs(m.from)}>${esc(m.from)}</span>
        ${m.to?.length ? `<span class="to">→ ${m.to.join(', ')}</span>` : '<span class="to">→ all</span>'}
        <span class="kind ${m.kind}">${m.kind}</span>
        ${m.re ? `<span class="to">re ${esc(m.re)}</span>` : ''}
        <span class="ts">${time(m.ts)}</span>
      </div>
      <div class="body">${esc(m.text)}</div>`;
      el.appendChild(d);
    }
  });
}

function renderTimeline() {
  const el = $('timeline');
  refillKeepingPlace(el, () => {
    el.innerHTML = '';
    for (const t of newest(state.timeline)) {
      const d = document.createElement('div');
      const toHuman = t.kind === 'message.sent' && isHumanDirected(t.data);
      d.className = `tl k-${t.kind.split('.')[0]} ${toHuman ? 'to-human' : ''}`;
      d.innerHTML = `<span class="t">${time(t.ts)}</span><span class="txt">${esc(t.line)}</span>`;
      d.onclick = () => openTimelineTarget(t);
      el.appendChild(d);
    }
    if (!state.timeline.length) el.innerHTML = '<div class="empty">nothing has happened yet.</div>';
  });
}

function renderBoard() {
  const el = $('board');
  el.innerHTML = '';
  const tasks = Object.values(state.tasks);
  for (const [key, label] of COLUMNS) {
    const list = tasks
      .filter((t) => t.state === key)
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `<h3>${label} <span class="badge">${list.length}</span></h3>`;
    for (const t of list) {
      const c = document.createElement('div');
      c.className = 'card';
      c.innerHTML = `
        <div class="id">${t.id}${t.humanApproved ? ' ✓' : ''}</div>
        <div class="ti">${esc(t.title)}</div>
        <div class="own">${t.owner ? `<span class="${t.owner}">${t.owner}</span>` : 'unassigned'}${t.reviewer ? ` · review ${t.reviewer}` : ''}</div>`;
      c.onclick = () => openTask(t.id);
      col.appendChild(c);
    }
    el.appendChild(col);
  }
  if (!tasks.length) el.innerHTML = '<div class="empty">no tasks yet — the team has not divided the work.</div>';
}

function renderDecisions() {
  fillTaskSelect($('new-debate-task'));
  const el = $('decisions');
  el.innerHTML = '';
  const debates = Object.values(state.debates).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    return String(b.ts || '').localeCompare(String(a.ts || ''));
  });
  for (const d of debates) {
    const box = document.createElement('div');
    box.className = `deb ${d.status}`;
    box.innerHTML = `
      <div class="q">${d.id} — ${esc(d.question)}</div>
      ${d.positions.map((p) => `
        <div class="pos"><span class="a ${p.agent}">${p.agent}</span>: ${esc(p.stance)}
          ${p.because ? `<div class="why">because ${esc(p.because)}</div>` : ''}
          ${p.critique ? `<div class="why">critique: ${esc(p.critique)}</div>` : ''}
        </div>`).join('')}
      ${d.outcome ? `<div class="why">outcome: ${esc(d.outcome)}${d.decisionId ? ` (${d.decisionId})` : ''}</div>` : ''}
      <div class="meta">opened by ${d.openedBy} · ${time(d.ts)}</div>`;
    el.appendChild(box);
  }
  for (const d of newest(state.decisions)) {
    const box = document.createElement('div');
    box.className = 'dec';
    box.innerHTML = `
      <div class="q">${d.id} — ${esc(d.question)}</div>
      <div class="chosen">→ ${esc(d.chosen)}</div>
      ${d.why ? `<div class="why">${esc(d.why)}</div>` : ''}
      ${d.alternatives?.length ? `<div class="alts">alternatives: ${d.alternatives.map(esc).join(' · ')}</div>` : ''}
      ${d.arguments?.length ? `<div class="alts">arguments: ${d.arguments.map(esc).join(' · ')}</div>` : ''}
      <div class="meta">${time(d.ts)} · recorded by ${d.by}${d.participants?.length ? ` · with ${d.participants.join(', ')}` : ''}${d.humanRole !== 'none' ? ` · human ${d.humanRole}` : ''}${d.relatedTask ? ` · ${d.relatedTask}` : ''}</div>`;
    el.appendChild(box);
  }
  if (!debates.length && !state.decisions.length) el.innerHTML = '<div class="empty">no decisions or debates recorded yet.</div>';
}

function renderRight() {
  const h = $('health');
  if (state.health) {
    h.innerHTML = `<div class="${state.health.ok ? 'health-ok' : 'health-bad'}">${esc(state.health.name)} — ${state.health.ok ? 'passing' : 'failing'}</div>
      <div class="muted">${time(state.health.ts)} by ${state.health.by}</div>`;
  } else {
    h.innerHTML = '<div class="empty">nothing has been validated yet.</div>';
  }
  const recent = state.validations.slice(-5).reverse();
  if (recent.length) {
    h.innerHTML += `<div class="small-list" style="margin-top:6px">${recent.map((v) =>
      `<div><span class="${v.ok ? 'health-ok' : 'health-bad'}">${v.ok ? '✓' : '✗'}</span> <span class="k">${esc(v.name)}</span> <span class="muted">${v.by}</span></div>`).join('')}</div>`;
  }

  const q = state.questions.filter((x) => x.status === 'open');
  $('questions').innerHTML = q.length
    ? `<div class="small-list">${q.map((x) => `<div><span class="k">${x.id}</span> ${esc(x.text)} <span class="muted">(${x.by})</span></div>`).join('')}</div>`
    : '<div class="empty">none open</div>';

  const disc = state.discoveries.slice(-6).reverse();
  $('discoveries').innerHTML = disc.length
    ? `<div class="small-list">${disc.map((x) => `<div><span class="k">${x.by}</span> ${esc(x.text)}</div>`).join('')}</div>`
    : '<div class="empty">none yet</div>';

  const files = state.files.slice(-8).reverse();
  $('files').innerHTML = files.length
    ? `<div class="small-list">${files.map((f) => `<div><span class="k ${f.by}">${f.by}</span> ${f.action} <span class="mono muted">${f.files.map(esc).join(', ')}</span></div>`).join('')}</div>`
    : '<div class="empty">no files touched yet</div>';
}

// ---------------------------------------------------------------- raw feed

function rawClass(ev) {
  if (ev.data?.source === 'derived legacy archive import') return 'derived';
  if (ev.kind === 'raw.text') return 'text';
  if (ev.kind === 'raw.reasoning') return 'reasoning';
  if (ev.kind === 'raw.tool.call') return 'tool';
  if (ev.kind === 'raw.tool.result') return 'result';
  if (ev.kind === 'raw.error') return 'error';
  if (ev.kind.startsWith('raw.turn')) return 'turn';
  return 'native';
}

function rawVisible(ev) {
  const agent = $('raw-agent').value;
  if (agent && ev.agent !== agent) return false;
  const c = rawClass(ev);
  if (c === 'derived') return $('raw-derived').checked;
  if (c === 'text') return $('raw-text').checked;
  if (c === 'reasoning') return $('raw-reasoning').checked;
  if (c === 'tool' || c === 'result') return $('raw-tools').checked;
  if (c === 'turn') return true;
  return $('raw-native').checked;
}

function rawLine(ev) {
  const d = ev.data || {};
  if (rawClass(ev) === 'derived') {
    return `[DERIVED LEGACY — NOT PROVIDER OUTPUT] ${d.summary || JSON.stringify(d.payload || {})}`;
  }
  switch (ev.kind) {
    case 'raw.text': return d.text || '';
    case 'raw.reasoning': return d.text || '';
    case 'raw.tool.call': return `${d.name || 'tool'} ${d.brief || ''}`;
    case 'raw.tool.result': return `${d.isError ? '! ' : ''}${clip(d.output || '', 1500)}`;
    case 'raw.usage': return JSON.stringify(d.usage || {});
    case 'raw.error': return d.text || '';
    case 'raw.turn.start': return `— turn ${d.turn} begins — ${d.reason || ''}`;
    case 'raw.turn.end': return `— turn ${d.turn} ends — exit ${d.exitCode}, ${d.studioActions} studio actions, ${Math.round((d.durationMs || 0) / 1000)}s`;
    default: return d.summary || JSON.stringify(d).slice(0, 400);
  }
}

function renderRaw() {
  const el = $('raw');
  el.innerHTML = '';
  for (const ev of newest(rawEvents)) if (rawVisible(ev)) el.appendChild(rawNode(ev));
  $('raw-note').textContent = `${rawEvents.length} events buffered`;
  el.scrollTop = 0;
}

function appendRaw(ev) {
  if (!rawVisible(ev)) return;
  const el = $('raw');
  el.prepend(rawNode(ev));
  while (el.childElementCount > 3000) el.removeChild(el.lastChild);
  if ($('raw-follow').checked) el.scrollTop = 0;
  $('raw-note').textContent = `${rawEvents.length} events buffered`;
}

function rawNode(ev) {
  const d = document.createElement('div');
  const cls = rawClass(ev);
  d.className = `rw ${cls}`;
  d.innerHTML = `<span class="t">${time(ev.ts)}</span><span class="ag"${agentAttrs(ev.agent)}>${esc(ev.agent || '')}</span><span class="k">${ev.kind.replace('raw.', '')}</span><span class="b">${esc(rawLine(ev))}</span>`;
  return d;
}

// ---------------------------------------------------------------- controls

function wireControls() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.pane').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $(`pane-${t.dataset.tab}`).classList.add('active');
      if (t.dataset.tab === 'raw') renderRaw();
      if (t.dataset.tab === 'settings') refreshSettings();
      if (t.dataset.tab === 'usage') renderUsage(state);
      // The preview polls the server, so it is started and stopped by hand rather
      // than left running behind a hidden pane.
      if (t.dataset.tab === 'preview') showPreview(); else hidePreview();
    };
  });

  ['raw-agent', 'raw-text', 'raw-reasoning', 'raw-tools', 'raw-native', 'raw-derived'].forEach((id) => {
    $(id).onchange = renderRaw;
  });

  $('composer').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('say-text').value.trim();
    if (!text) return;
    const to = $('say-to').value;
    $('say-text').value = '';
    await post('/api/human/say', { to: to ? [to] : [], text });
  };

  $('btn-pause').onclick = () => post('/api/human/control', { action: 'pause' });
  $('btn-resume').onclick = () => post('/api/human/control', { action: 'resume' });
  $('btn-stop').onclick = () => confirm('Stop all three agents?') && post('/api/human/control', { action: 'stop' });

  $('priority-send').onclick = async () => {
    const text = $('priority-input').value.trim();
    if (!text) return;
    $('priority-input').value = '';
    await post('/api/human/control', { action: 'priority', text });
    await post('/api/human/say', { to: [], text: `New priority from the human: ${text}` });
  };

  $('new-task-form').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('new-task-title').value.trim();
    if (!title) return;
    const owner = $('new-task-owner').value;
    $('new-task-title').value = '';
    await postOk('/api/human/task', { title, owner: owner || null });
  };

  $('new-debate-form').onsubmit = async (e) => {
    e.preventDefault();
    const question = $('new-debate-q').value.trim();
    if (!question) return;
    const relatedTask = $('new-debate-task').value;
    $('new-debate-q').value = '';
    await postOk('/api/human/debate', { question, relatedTask: relatedTask || null });
  };

  $('drawer-close').onclick = (e) => {
    e.preventDefault();
    closeDrawer();
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // "Needs you" — header, badge (inside the header) and the glance item all
  // open the same queue. The human drives this with a mouse or a keyboard.
  $('attention-open').onclick = () => openAttention();
  $('attention-open').onkeydown = (e) => {
    if (!activates(e)) return;
    e.preventDefault();
    openAttention();
  };
  $('glance').addEventListener('click', (e) => {
    if (e.target.closest('#glance-attention')) openAttention();
  });
  $('glance').addEventListener('keydown', (e) => {
    if (!activates(e) || !e.target.closest('#glance-attention')) return;
    e.preventDefault();
    openAttention();
  });
}

function activates(e) {
  return e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
}

async function agentAction(act, agent) {
  if (act === 'start') return void post('/api/runner/start', { agent });
  if (act === 'stop') return void post('/api/runner/stop', { agent, reason: 'stopped by human' });
  if (act === 'nudge') {
    const text = prompt(`What should ${agent} do?`);
    if (!text) return;
    await post('/api/human/say', { to: [agent], text });
    return void post('/api/runner/nudge', { agent, text });
  }
  if (act === 'raw') {
    $('raw-agent').value = agent;
    document.querySelector('.tab[data-tab="raw"]').click();
    renderRaw();
  }
}

// ------------------------------------------------------------------ drawer

function openDrawer(title, html, redraw = null) {
  $('drawer-title').textContent = title;
  $('drawer-body').innerHTML = html;
  $('drawer').hidden = false;
  drawerRedraw = redraw;
}

function closeDrawer() {
  $('drawer').hidden = true;
  drawerRedraw = null;
}

function refreshDrawer() {
  if (!drawerRedraw || $('drawer').hidden) return;
  const top = $('drawer-body').scrollTop;
  drawerRedraw();
  $('drawer-body').scrollTop = top;
}

function openTask(id) {
  const t = state.tasks[id];
  if (!t) return;
  const assignLabel = t.owner ? 'Reassign' : 'Assign';
  openDrawer(`${t.id} — ${t.title}`, `
    <div class="muted">${t.state} · owner ${t.owner || 'unassigned'}${t.reviewer ? ` · reviewer ${t.reviewer}` : ''}</div>
    <form class="intervene-box" id="task-assign-form">
      <label>Owner
        <select id="task-owner" class="input small">${agentOptions(t.owner)}</select>
      </label>
      <button class="btn" type="submit">${assignLabel}</button>
    </form>
    <form class="intervene-box" id="task-review-form">
      <label>Reviewer
        <select id="task-reviewer" class="input small">${agentOptions(t.reviewer)}</select>
      </label>
      <button class="btn" type="submit">Request review</button>
    </form>
    <h4>Objective</h4><pre>${esc(t.objective || '—')}</pre>
    ${t.context ? `<h4>Context</h4><pre>${esc(t.context)}</pre>` : ''}
    ${t.deps?.length ? `<h4>Depends on</h4><pre>${t.deps.join(', ')}</pre>` : ''}
    ${t.result ? `<h4>Result</h4><pre>${esc(t.result)}</pre>` : ''}
    <h4>History</h4>
    <pre>${t.history.map((h) => `${time(h.ts)}  ${h.by || 'human'}  ${h.change}${h.note ? `  — ${h.note}` : ''}`).join('\n')}</pre>
    <h4>Conversation mentioning this task</h4>
    <pre>${esc(state.messages.filter((m) => m.re === id || m.text.includes(id)).map((m) => `${m.from}: ${m.text}`).join('\n\n') || '—')}</pre>
    <h4>Files recorded against it</h4>
    <pre>${state.files.filter((f) => f.task === id).map((f) => `${f.by} ${f.action} ${f.files.join(', ')}`).join('\n') || '—'}</pre>`, () => openTask(id));
  $('task-assign-form').onsubmit = async (e) => {
    e.preventDefault();
    await postOk('/api/human/assign', { task: id, owner: $('task-owner').value });
  };
  $('task-review-form').onsubmit = async (e) => {
    e.preventDefault();
    await postOk('/api/human/review', { task: id, reviewer: $('task-reviewer').value });
  };
}

function openAgent(id) {
  const a = state.agents[id];
  const mine = Object.values(state.tasks).filter((t) => t.owner === id);
  openDrawer(`${id}`, `
    <div class="muted">${a.state}${a.paused ? ' · paused' : ''} · ${a.turns || 0} turns · ${a.toolCalls || 0} tool calls</div>
    ${a.intro ? `<h4>Introduced itself as</h4><pre>${esc(a.intro)}</pre>` : ''}
    ${a.strengths?.length ? `<h4>Claimed strengths</h4><pre>${a.strengths.map(esc).join(', ')}</pre>` : ''}
    ${a.note ? `<h4>Current note</h4><pre>${esc(a.note)}</pre>` : ''}
    ${a.lastError ? `<h4>Last error</h4><pre>${esc(a.lastError.text)}</pre>` : ''}
    <h4>Tasks it owns</h4><pre>${mine.map((t) => `${t.id} [${t.state}] ${t.title}`).join('\n') || '—'}</pre>
    <h4>Usage</h4><pre>${esc(JSON.stringify(a.usage || {}, null, 2))}</pre>
    <h4>Recent things it said</h4>
    <pre>${esc(state.messages.filter((m) => m.from === id).slice(-8).map((m) => `→${m.to?.join(',') || 'all'} [${m.kind}] ${m.text}`).join('\n\n') || '—')}</pre>`);
}

function openTimelineTarget(t) {
  const id = t.data?.id;
  if (id && state.tasks[id]) return openTask(id);
  if (t.agent) return openAgent(t.agent);
}

// -------------------------------------------------------------- needs you

/**
 * Everything genuinely waiting on the human, categorised.
 *
 * The protocol names four attention classes — decision requested, blocked,
 * conflict, ready for review — so the queue is wider than the attention.*
 * records the left rail shows. Rows are a uniform shape so one renderer does
 * for all of them: { kind, ref, who, what, ts, extra[], attention?, task? }.
 * Empty groups are dropped, and each group is oldest-first: the thing that has
 * been waiting longest is the thing most likely to be forgotten.
 */
function humanQueue() {
  const tasks = Object.values(state.tasks);
  const groups = [
    {
      label: 'Escalations',
      note: 'raised by an agent for your judgement',
      items: state.attention.filter((a) => a.status === 'open').map((a) => ({
        kind: a.kind,
        ref: a.id,
        who: a.by,
        what: a.text,
        ts: a.ts,
        attention: a.id,
        extra: [
          a.options?.length ? `options: ${a.options.join(' · ')}` : '',
          a.ref ? `re ${a.ref}` : '',
        ],
      })),
    },
    {
      label: 'Open questions',
      note: 'asked by an agent and still unanswered',
      items: state.questions.filter((q) => q.status === 'open').map((q) => ({
        kind: 'question',
        ref: q.id,
        who: q.by,
        what: q.text,
        ts: q.ts,
        extra: [],
      })),
    },
    {
      label: 'Blocked work',
      note: 'stuck — someone owns it and it is not moving',
      items: tasks.filter((t) => t.state === 'blocked').map((t) => ({
        kind: 'blocked',
        ref: t.id,
        who: t.owner || 'unassigned',
        what: t.title,
        ts: t.updatedAt || t.createdAt,
        task: t.id,
        extra: [lastNote(t) ? `last note: ${clip(lastNote(t), 160)}` : '', t.reviewer ? `reviewer ${t.reviewer}` : ''],
      })),
    },
    {
      label: 'Ready for review',
      note: 'finished and handed off — the protocol counts this as your business too',
      items: tasks.filter((t) => t.state === 'under-review' && !t.humanApproved).map((t) => ({
        kind: 'review',
        ref: t.id,
        who: t.owner || 'unassigned',
        what: t.title,
        ts: t.updatedAt || t.createdAt,
        task: t.id,
        extra: [
          t.reviewer ? `reviewer ${t.reviewer}` : 'no reviewer assigned',
          t.result ? `result: ${clip(t.result, 200)}` : '',
        ],
      })),
    },
    {
      label: 'Open debates',
      note: 'the agents are still divided',
      items: Object.values(state.debates).filter((d) => d.status === 'open').map((d) => ({
        kind: 'debate',
        ref: d.id,
        who: d.openedBy,
        what: d.question,
        ts: d.positions?.length ? d.positions[d.positions.length - 1].ts : d.ts,
        task: d.relatedTask && state.tasks[d.relatedTask] ? d.relatedTask : null,
        extra: [
          d.positions?.length
            ? `${d.positions.length} position${d.positions.length === 1 ? '' : 's'}: ${d.positions.map((p) => `${p.agent} — ${clip(p.stance, 60)}`).join(' · ')}`
            : 'no positions argued yet',
          d.relatedTask ? `re ${d.relatedTask}` : '',
        ],
      })),
    },
    {
      label: 'Asked you directly',
      note: 'addressed to you as a question, with nothing said by you since',
      items: unansweredAsks(),
    },
  ];
  for (const g of groups) g.items.sort((a, b) => (Date.parse(a.ts || '') || 0) - (Date.parse(b.ts || '') || 0));
  return groups.filter((g) => g.items.length);
}

/**
 * Messages the agents addressed to the human as questions. The projection has
 * no reply linkage, so "answered" can only mean: the human has spoken since.
 * That is the strongest claim the data supports — anything narrower would be
 * invented, so nothing narrower is claimed.
 */
function unansweredAsks() {
  const lastHuman = state.messages
    .filter((m) => m.from === 'human')
    .reduce((max, m) => Math.max(max, Date.parse(m.ts || '') || 0), 0);
  return state.messages
    .filter((m) => m.kind === 'question' && m.to?.includes('human') && (Date.parse(m.ts || '') || 0) > lastHuman)
    .map((m) => ({
      kind: 'question',
      ref: m.re || `msg ${m.seq}`,
      who: m.from,
      what: m.text,
      ts: m.ts,
      task: m.re && state.tasks[m.re] ? m.re : null,
      extra: [],
    }));
}

function queueTotal() {
  return humanQueue().reduce((n, g) => n + g.items.length, 0);
}

function lastNote(t) {
  for (const h of [...(t.history || [])].reverse()) if (h.note) return h.note;
  return '';
}

function openAttention() {
  const groups = humanQueue();
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  openDrawer(
    `Needs you — ${total} item${total === 1 ? '' : 's'}`,
    total
      ? groups.map(queueGroup).join('')
      : '<div class="empty">Nothing is waiting on you: no escalations, no open questions, nothing blocked, nothing in review, no open debates.</div>',
    openAttention,
  );
  wireQueue();
}

function queueGroup(g) {
  return `
    <h4>${esc(g.label)} <span class="badge">${g.items.length}</span></h4>
    ${g.note ? `<div class="qnote muted">${esc(g.note)}</div>` : ''}
    ${g.items.map(queueRow).join('')}`;
}

function queueRow(r) {
  return `
    <div class="qrow"${r.task ? ` data-task="${esc(r.task)}"` : ''}>
      <div class="k">
        <span class="qkind">${esc(r.kind)}</span>
        <span class="qref">${esc(r.ref)}</span>
        <span class="qwho"${agentAttrs(r.who)}>${esc(r.who || '—')}</span>
        <span class="muted">${esc(ago(r.ts))}</span>
      </div>
      <div class="tx">${esc(clip(r.what, 400))}</div>
      ${r.extra.filter(Boolean).map((x) => `<div class="opts">${esc(x)}</div>`).join('')}
      ${r.attention ? `<div class="acts">
        <button class="btn" data-att="${esc(r.attention)}" data-v="approve">approve</button>
        <button class="btn" data-att="${esc(r.attention)}" data-v="reject">reject</button>
        <button class="btn" data-att="${esc(r.attention)}" data-v="reply">reply</button>
      </div>` : ''}
    </div>`;
}

function wireQueue() {
  const body = $('drawer-body');
  body.querySelectorAll('button[data-att]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const a = state.attention.find((x) => x.id === b.dataset.att);
      if (a) attentionVerdict(a, b.dataset.v);
    };
  });
  body.querySelectorAll('.qrow[data-task]').forEach((row) => {
    row.onclick = () => openTask(row.dataset.task);
  });
}

// ------------------------------------------------------------------- utils

// Every human control goes through here, and it used to throw the response away.
//
// Two things were therefore invisible to the person this interface exists for.
// The refusal messages — "priority needs text", "unknown control target
// \"gemini\" — this studio is codex, claude, grok" — were written precisely so a
// mistake explains itself, and the human saw a button that did nothing instead.
// And the `warning` TASK-24 added, which is the only signal that a stop was
// recorded but never actually delivered to the agent, reached nobody at all.
//
// Non-throwing on purpose: the callers here are click handlers that do not
// expect exceptions. It reports and returns.
async function post(path, body) {
  let parsed = {};
  let httpOk = false;
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    httpOk = r.ok;
    parsed = await r.json().catch(() => ({}));
  } catch (err) {
    parsed = { error: `could not reach the studio: ${err.message}` };
  }
  scheduleRefresh();

  if (!httpOk || parsed.error) alert(parsed.error || 'the studio refused that, with no reason given');
  // A warning means it WORKED and something downstream did not. Saying "failed"
  // here would be its own lie: the control is durable and already projected.
  else if (parsed.warning) alert(`Recorded, but not delivered.\n\n${parsed.warning}`);

  return parsed;
}

async function postOk(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  scheduleRefresh();
  if (!r.ok || j.error) {
    alert(j.error || `request failed (${r.status})`);
    throw new Error(j.error || String(r.status));
  }
  return j;
}

function agentOptions(selected) {
  return AGENTS.map((id) =>
    `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(id)}</option>`).join('');
}

function fillTaskSelect(el) {
  if (!el || !state) return;
  const cur = el.value;
  const tasks = Object.values(state.tasks)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  el.innerHTML = `<option value="">no related task</option>` +
    tasks.map((t) =>
      `<option value="${t.id}"${t.id === cur ? ' selected' : ''}>${t.id} ${esc(t.title)}</option>`).join('');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function time(ts) {
  return ts ? new Date(ts).toTimeString().slice(0, 8) : '';
}

function ago(ts) {
  const ms = Date.now() - Date.parse(ts || '');
  if (!Number.isFinite(ms)) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `waiting ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `waiting ${hrs}h ${mins % 60}m`;
  return `waiting ${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function newest(items) {
  return [...items].sort((a, b) => {
    const byTime = Date.parse(b.ts || '') - Date.parse(a.ts || '');
    return byTime || Number(b.seq || 0) - Number(a.seq || 0);
  });
}
