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
    el.innerHTML = '<div class="set-head"><div><strong>Usage &amp; cost estimate</strong></div></div>'
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
      <div><strong>Usage &amp; cost estimate</strong>
        <span class="muted">${billed} billed turn${billed === 1 ? '' : 's'}</span></div>
    </div>

    <div class="u-warn">
      <b>These are estimates.</b> Every figure here is derived from token counts and
      per-token rates. Your actual bill can be <b>very different</b> — plans, credits,
      discounts, minimums, batch rates and subscription allowances all change what you are
      really charged, and some providers here are not billed per token at all.
      <b>Check your provider's own billing pages for what you actually owe.</b>
      Use this to compare runs and spot a run that is getting expensive, not to predict an invoice.
    </div>

    <div class="u-big">
      <div class="u-stat"><span class="u-n">${money(totalCost)}</span><span class="u-l">estimated total so far</span></div>
      <div class="u-stat"><span class="u-n">${tokens(totalTok)}</span><span class="u-l">tokens in + out</span></div>
      <div class="u-stat"><span class="u-n">${money(billed ? totalCost / billed : 0)}</span><span class="u-l">estimated average per turn</span></div>
    </div>

    ${budgetBlock(state.budgets)}

    ${unpriced.length ? `<div class="set-notice warn">
      <b>${unpriced.map(([id]) => esc(id)).join(', ')}</b>
      ${unpriced.length === 1 ? 'does' : 'do'} not report a cost, and no rate is configured, so
      ${unpriced.length === 1 ? 'those' : 'their'} tokens are counted but the spend is
      <b>not</b> included above. Add a <code>prices</code> block to your config to estimate it.
    </div>` : ''}

    ${anyEstimated ? `<div class="set-notice">
      Figures marked <span class="pill">est</span> are computed from the rates in your config.
      Figures without it were reported by the provider for that turn — closer to the truth, but
      still not an invoice.
    </div>` : ''}

    <section class="set-block">
      <h3>By agent</h3>
      <div class="u-scroll"><table class="u-table">
        <thead><tr><th>agent</th><th class="r">turns</th><th class="r">in</th>
          <th class="r">cached</th><th class="r">out</th><th class="r">cost estimate</th>
          <th class="r">est per turn</th></tr></thead>
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
          <th class="r">out</th><th class="r">cost estimate</th><th class="r">took</th></tr></thead>
        <tbody>${turnRows}</tbody>
      </table></div>
    </section>`;

  // innerHTML replaced the node, so the control is wired after every render
  // rather than once. Going through /api/human/control rather than
  // /api/runner/stop records it as a human intervention, so the log says who
  // stopped the team and the agents are told when they come back.
  const stop = $('usage-stop-all');
  if (stop) {
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      stop.textContent = 'Stopping…';
      try {
        await fetch('/api/human/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'stop', text: 'stopped from the usage panel', via: 'browser' }),
        });
      } finally {
        stop.disabled = false;
        stop.textContent = 'Stop the team';
      }
    });
  }
}

/**
 * How much of each budget is left, and one control that ends the run.
 *
 * Deliberately a countdown rather than a total. "You have spent $4.10" invites
 * arithmetic; "$5.90 left of $10" is the thing a human actually wanted to know
 * when they set the cap, and it is the number that tells them whether to walk
 * away from the machine.
 *
 * A budget that is off says so plainly. Rendering "no limit" as an empty box or
 * a zero would read as "nothing left", which is the opposite of true.
 */
function budgetBlock(b) {
  if (!b) return '';
  const rows = [];

  if (b.time?.limit) {
    rows.push(bar('Time', duration(b.time.remainingMs), `of ${duration(b.time.limit)}`,
      pct(b.time.remainingMs, b.time.limit)));
  }
  if (b.spend?.limit) {
    // "this run" is not decoration. The ledger above totals the whole event
    // log, so the two numbers on this page differ by every earlier run, and
    // without the label the budget looks broken rather than scoped.
    rows.push(bar('Spend', money(b.spend.remainingUsd),
      `of ${money(b.spend.limit)} this run — estimated`,
      pct(b.spend.remainingUsd, b.spend.limit)));
  }
  if (b.turns?.limit) {
    const used = Math.max(0, ...Object.values(b.turns.perAgent || {}));
    rows.push(bar('Turns', String(Math.max(0, b.turns.limit - used)),
      `of ${b.turns.limit} — per agent, the busiest shown`, pct(b.turns.limit - used, b.turns.limit)));
  }

  const unpriced = b.spend?.unpriced || [];

  return `<section class="set-block">
    <h3>Budgets</h3>
    ${rows.length
    ? `<div class="u-budgets">${rows.join('')}</div>
       <p class="muted">Time and spend are measured from this studio's start, not from the
       whole event log — the total above covers every run this project has ever had, and a
       budget measured against that would be spent before the team took a turn.
       ${b.spend?.limit && b.spend.lifetime > b.spend.total
    ? `This run has spent <b>${money(b.spend.total)}</b> of the
          <b>${money(b.spend.lifetime)}</b> shown above.` : ''}</p>`
    : `<p class="muted">No time or spend limit is set, so this team runs until you stop it
       or its turn budget runs out. Set <code>maxWallMs</code> or <code>maxSpendUsd</code>
       in the runner settings before leaving it unattended.</p>`}

    ${b.hit ? `<div class="set-notice warn">
      The <b>${esc(b.hit)}</b> budget was reached and the team was stopped. Raise it in
      settings and start the agents again to continue.
    </div>` : ''}

    ${unpriced.length ? `<div class="set-notice warn">
      <b>${unpriced.map(esc).join(', ')}</b> ${unpriced.length === 1 ? 'reports' : 'report'} no cost
      and ${unpriced.length === 1 ? 'has' : 'have'} no configured rate, so
      ${unpriced.length === 1 ? 'its' : 'their'} spend is <b>not counted</b> against the cap.
      The figure above is a floor, not a bill.
    </div>` : ''}

    <div class="set-actions">
      <button class="btn danger" id="usage-stop-all" type="button">Stop the team</button>
    </div>
    <p class="muted">Stopping is safe at any moment: an interrupted turn leaves its inbox
    unacknowledged, so nothing the team was told goes missing. The event log is untouched.</p>
  </section>`;
}

function bar(label, big, sub, filled) {
  return `<div class="u-budget">
    <div class="u-b-head"><span class="u-b-label">${esc(label)}</span>
      <span class="u-n">${esc(big)}</span> <span class="u-l">left ${esc(sub)}</span></div>
    <div class="u-b-track"><div class="u-b-fill${filled <= 15 ? ' low' : ''}" style="width:${filled}%"></div></div>
  </div>`;
}

const pct = (left, limit) => (limit > 0 ? Math.max(0, Math.min(100, (left / limit) * 100)) : 0);

function duration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
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
