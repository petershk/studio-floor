/**
 * What the team has spent.
 *
 * The numbers come from the store's ledger, which already resolved the awkward
 * part: three providers report usage in three different shapes, and adding them
 * together overstates one of them tenfold. This module's job is to present the
 * result without overclaiming — to keep a cost the provider actually reported
 * visually distinct from one derived from a rate card the human typed in, and to
 * say plainly when there is no cost at all rather than rendering a confident $0.
 */

const $ = (id) => document.getElementById(id);

let state = null;

export function renderUsage(s) {
  state = s;
  const el = $('usage');
  if (!el || !state) return;

  const byAgent = state.usage?.byAgent || {};
  const rows = Object.entries(byAgent);

  if (!rows.length) {
    el.innerHTML = '<div class="set-head"><div><strong>Usage</strong></div></div>'
      + '<p class="muted">No usage recorded yet. Numbers appear as agents finish turns.</p>';
    return;
  }

  const totalCost = rows.reduce((n, [, t]) => n + (t.costUsd || 0), 0);
  const totalTok = rows.reduce((n, [, t]) => n + t.input + t.output, 0);
  const billed = rows.reduce((n, [, t]) => n + t.turns, 0);
  const anyEstimated = rows.some(([, t]) => t.costEstimated > 0);
  const unpriced = rows.filter(([, t]) => !t.reportsCost && !t.costEstimated);

  const agentRows = rows
    .sort((a, b) => (b[1].costUsd || 0) - (a[1].costUsd || 0))
    .map(([id, t]) => `<tr>
        <td>${esc(id)}</td>
        <td class="r">${t.turns}</td>
        <td class="r">${tokens(t.input)}</td>
        <td class="r muted">${tokens(t.cacheRead)}</td>
        <td class="r">${tokens(t.output)}</td>
        <td class="r">${costCell(t)}</td>
        <td class="r muted">${t.turns && t.costUsd ? money(t.costUsd / t.turns) : '—'}</td>
      </tr>`).join('');

  const turnRows = (state.usage.turns || []).slice(-60).reverse().map((r) => `<tr>
      <td class="muted">${esc(time(r.at))}</td>
      <td>${esc(r.agent)}</td>
      <td class="r muted">${r.turn == null ? '—' : r.turn}</td>
      <td class="r">${tokens(r.input)}</td>
      <td class="r">${tokens(r.output)}</td>
      <td class="r">${turnCost(r)}</td>
      <td class="r muted">${r.durationMs ? `${(r.durationMs / 1000).toFixed(0)}s` : '—'}</td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="set-head">
      <div><strong>Usage</strong>
        <span class="muted">${billed} billed turn${billed === 1 ? '' : 's'}</span></div>
    </div>

    <div class="u-big">
      <div class="u-stat"><span class="u-n">${money(totalCost)}</span><span class="u-l">total so far</span></div>
      <div class="u-stat"><span class="u-n">${tokens(totalTok)}</span><span class="u-l">tokens in + out</span></div>
      <div class="u-stat"><span class="u-n">${money(billed ? totalCost / billed : 0)}</span><span class="u-l">average per turn</span></div>
    </div>

    ${unpriced.length ? `<div class="set-notice warn">
      <b>${unpriced.map(([id]) => esc(id)).join(', ')}</b>
      ${unpriced.length === 1 ? 'does' : 'do'} not report a cost, and no rate is configured, so
      ${unpriced.length === 1 ? 'those' : 'their'} tokens are counted but the spend is
      <b>not</b> included above. Add a <code>prices</code> block to your config to estimate it.
    </div>` : ''}

    ${anyEstimated ? `<div class="set-notice">
      Figures marked <span class="pill">est</span> come from your configured rates, not from the
      provider. They are exactly as right as those rates are.
    </div>` : ''}

    <section class="set-block">
      <h3>By agent</h3>
      <div class="u-scroll"><table class="u-table">
        <thead><tr><th>agent</th><th class="r">turns</th><th class="r">in</th>
          <th class="r">cached</th><th class="r">out</th><th class="r">cost</th>
          <th class="r">per turn</th></tr></thead>
        <tbody>${agentRows}</tbody>
      </table></div>
      <p class="muted">Cached input is charged at a reduced rate by every provider here, which is
      why it is shown apart from fresh input.</p>
    </section>

    ${forecast(rows.length, billed, totalCost)}

    <section class="set-block">
      <h3>Recent turns</h3>
      <p class="muted">Newest first. A turn appears once its provider reports what it used.</p>
      <div class="u-scroll"><table class="u-table">
        <thead><tr><th>when</th><th>agent</th><th class="r">turn</th><th class="r">in</th>
          <th class="r">out</th><th class="r">cost</th><th class="r">took</th></tr></thead>
        <tbody>${turnRows}</tbody>
      </table></div>
    </section>`;
}

/**
 * What finishing the turn budget would cost.
 *
 * The number the question "what will this bill be" is actually asking for.
 * Straight-line from the average so far and labelled as such, because turns are
 * not uniform: a team reading a codebase spends differently from one writing to
 * it, and the first turns of a run are the cheapest it will ever be.
 */
function forecast(agents, billed, totalCost) {
  if (!billed || !totalCost) return '';
  const perTurn = totalCost / billed;
  const maxTurns = Number(state.runner?.maxTurns);

  if (!Number.isFinite(maxTurns) || maxTurns <= 0) {
    return `<section class="set-block"><h3>Rough forecast</h3>
      <p class="muted">At ${money(perTurn)} per billed turn, another 50 turns is about
      <b>${money(perTurn * 50)}</b> and 200 about <b>${money(perTurn * 200)}</b>.</p>
      ${CAVEAT}</section>`;
  }

  const ceiling = maxTurns * agents;
  const remaining = Math.max(0, ceiling - billed);
  return `<section class="set-block"><h3>Rough forecast</h3>
    <p class="muted">The budget is <b>${maxTurns}</b> turns per agent, so at most
      <b>${ceiling}</b> across ${agents} agent${agents === 1 ? '' : 's'}.
      ${billed} are billed; about <b>${remaining}</b> remain.
      At ${money(perTurn)} each that is roughly <b>${money(perTurn * remaining)}</b> more,
      landing near <b>${money(totalCost + perTurn * remaining)}</b>.</p>
    ${CAVEAT}</section>`;
}

const CAVEAT = '<p class="muted">Straight-line from the average so far. Turns are not uniform, so'
  + ' treat this as an order of magnitude rather than a quote.</p>';

function costCell(t) {
  if (!t.reportsCost && !t.costEstimated) return '<span class="muted">not reported</span>';
  const est = t.costEstimated > 0 && t.costReported === 0 ? ' <span class="pill">est</span>' : '';
  return `${money(t.costUsd)}${est}`;
}

function turnCost(r) {
  if (r.costUsd == null) return '<span class="muted">not reported</span>';
  return `${money(r.costUsd)}${r.costSource === 'estimated' ? ' <span class="pill">est</span>' : ''}`;
}

function money(n) {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(0)}`;
}

function tokens(n) {
  if (!Number.isFinite(n) || n === 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function time(ts) {
  return ts ? new Date(ts).toTimeString().slice(0, 5) : '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
