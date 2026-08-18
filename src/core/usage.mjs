/**
 * Token accounting.
 *
 * Three providers, three different vocabularies, and three different ideas of
 * what a usage report covers. Getting this wrong does not produce a slightly
 * off number — measured against a real 24,000-event log, adding every usage
 * event together overstated Codex by 10.7x. So the shape of each provider's
 * reporting is handled explicitly rather than averaged over.
 *
 *   scope: 'turn'     the authoritative total for one turn. Claude and Grok
 *                     emit exactly one, on their `result` event, and it carries
 *                     the provider's own costing. Add these up.
 *
 *   scope: 'message'  one assistant message inside a turn. Claude emits ten or
 *                     more per turn and their cache figures are running values,
 *                     so the turn total is NOT their sum. Kept for the raw feed,
 *                     never added to anything.
 *
 *   scope: 'session'  cumulative for the whole provider session so far. Codex
 *                     reports this: it climbs across a resumed thread and resets
 *                     when a new one starts. The contribution of one report is
 *                     its delta from the previous report on the same session.
 */

/** Provider field names, normalised. Each provider spells these differently. */
export function normaliseTokens(usage = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    input: n(usage.input_tokens ?? usage.prompt_tokens),
    output: n(usage.output_tokens ?? usage.completion_tokens),
    // Codex says `cached_input_tokens`; Anthropic-style says
    // `cache_read_input_tokens`. Same thing, charged at a reduced rate.
    cacheRead: n(usage.cache_read_input_tokens ?? usage.cached_input_tokens),
    // Writing to the cache costs more than a plain input token.
    cacheWrite: n(usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens),
    // Codex bills reasoning tokens as output; it also reports them separately,
    // so they are surfaced but never added to `output` a second time.
    reasoning: n(usage.reasoning_output_tokens),
  };
}

export function emptyTotals() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    costUsd: 0, costReported: 0, costEstimated: 0,
    turns: 0, durationMs: 0, reportsCost: false,
  };
}

function addInto(t, tok) {
  t.input += tok.input;
  t.output += tok.output;
  t.cacheRead += tok.cacheRead;
  t.cacheWrite += tok.cacheWrite;
  t.reasoning += tok.reasoning;
}

/**
 * Infer a scope for an event that does not carry one.
 *
 * Logs written before scopes existed have none. Defaulting them all to 'turn'
 * would reproduce the exact overcount this module exists to prevent, and only
 * for Codex, whose payload is recognisable: `cached_input_tokens` is a spelling
 * no Anthropic-style provider uses. A heuristic, and labelled as one, but a
 * far better answer than being confidently wrong about an old log.
 */
export function inferScope(data = {}) {
  if (data.scope) return data.scope;
  const u = data.usage || {};
  if (u.cached_input_tokens !== undefined || u.reasoning_output_tokens !== undefined) return 'session';
  if (data.costUsd != null || data.numTurns != null) return 'turn';
  return 'message';
}

/**
 * Fold usage events into per-agent totals and a per-turn ledger.
 *
 * `events` may be the whole log; only `raw.turn.start` and `raw.usage` matter.
 * Pure, so the projection and the tests exercise identical code.
 */
/**
 * A running ledger, fed one event at a time.
 *
 * The store projects incrementally as events arrive; tests and the CLI fold a
 * whole log at once. Both go through this, so there is no second implementation
 * to drift out of agreement with the first.
 */
export class UsageLedger {
  constructor({ prices = {}, providerOf = () => null, keepTurns = 500 } = {}) {
    this.prices = prices;
    this.providerOf = providerOf;
    this.keepTurns = keepTurns;
    this.byAgent = {};
    this.turns = [];
    this.turnOf = {};
    this.sessionOf = {};
    this.lastSession = {};
  }

  totalsFor(id) {
    return (this.byAgent[id] ||= emptyTotals());
  }

  observe(ev) {
    if (ev.kind === 'raw.turn.start') {
      this.turnOf[ev.agent] = ev.data?.turn ?? ((this.turnOf[ev.agent] || 0) + 1);
      this.sessionOf[ev.agent] = ev.data?.sessionId || 'unknown';
      return null;
    }
    if (ev.kind !== 'raw.usage') return null;

    const d = ev.data || {};
    const scope = inferScope(d);
    if (scope === 'message') return null;

    const tok = normaliseTokens(d.usage);
    let contribution = tok;

    if (scope === 'session') {
      const key = `${ev.agent}::${this.sessionOf[ev.agent] || 'unknown'}`;
      const prev = this.lastSession[key];
      // A cumulative counter that goes *down* has been reset: the provider
      // started a fresh thread under a session id we did not see change. The
      // whole new reading is then this turn's contribution.
      //
      // Subtracting and clamping at zero -- the obvious implementation --
      // silently loses every token of that new thread's first report. The runner
      // mints a fresh session whenever a resume fails, so this is a real path.
      const reset = prev && tok.input < prev.input;
      if (prev && !reset) {
        contribution = {
          input: Math.max(0, tok.input - prev.input),
          output: Math.max(0, tok.output - prev.output),
          cacheRead: Math.max(0, tok.cacheRead - prev.cacheRead),
          cacheWrite: Math.max(0, tok.cacheWrite - prev.cacheWrite),
          reasoning: Math.max(0, tok.reasoning - prev.reasoning),
        };
      }
      this.lastSession[key] = tok;
    }

    const t = this.totalsFor(ev.agent);
    addInto(t, contribution);
    t.turns += 1;
    if (Number.isFinite(d.durationMs)) t.durationMs += d.durationMs;

    const reported = Number.isFinite(d.costUsd) ? d.costUsd : null;
    const rate = this.prices[this.providerOf(ev.agent)] ?? this.prices[ev.agent];
    const estimated = reported == null ? estimateCost(contribution, rate) : null;

    if (reported != null) { t.costReported += reported; t.reportsCost = true; }
    if (estimated != null) t.costEstimated += estimated;
    t.costUsd = t.costReported + t.costEstimated;

    const row = {
      seq: ev.seq,
      at: ev.ts,
      agent: ev.agent,
      turn: this.turnOf[ev.agent] ?? null,
      scope,
      ...contribution,
      costUsd: reported ?? estimated,
      costSource: reported != null ? 'reported' : (estimated != null ? 'estimated' : null),
      durationMs: Number.isFinite(d.durationMs) ? d.durationMs : null,
    };
    this.turns.push(row);
    if (this.turns.length > this.keepTurns) this.turns.splice(0, this.turns.length - this.keepTurns);
    return row;
  }

  snapshot() {
    return { byAgent: this.byAgent, turns: this.turns };
  }
}

/** Fold a whole log at once. Thin wrapper over the ledger. */
export function accumulate(events, opts = {}) {
  const ledger = new UsageLedger({ keepTurns: Infinity, ...opts });
  for (const ev of events) ledger.observe(ev);
  return ledger.snapshot();
}

/**
 * Cost from a rate card, or null.
 *
 * Null when no rates are configured, and that is the point: an invented default
 * price would produce a confident number that is quietly wrong the moment a
 * vendor changes its pricing, and a wrong bill is worse than no bill. Providers
 * that report their own cost never come through here.
 *
 * Rates are dollars per million tokens.
 */
export function estimateCost(tok, rate) {
  if (!rate || typeof rate !== 'object') return null;
  const per = (n, r) => (Number.isFinite(r) ? (n / 1e6) * r : 0);
  const any = ['input', 'output', 'cacheRead', 'cacheWrite'].some((k) => Number.isFinite(rate[k]));
  if (!any) return null;
  return per(tok.input, rate.input)
    + per(tok.output, rate.output)
    + per(tok.cacheRead, rate.cacheRead ?? rate.input)
    + per(tok.cacheWrite, rate.cacheWrite ?? rate.input);
}

/** One line a human can read, for the CLI brief. */
export function summarise(byAgent) {
  const rows = Object.entries(byAgent);
  if (!rows.length) return 'no usage recorded yet';
  const total = rows.reduce((s, [, t]) => s + t.costUsd, 0);
  const known = rows.some(([, t]) => t.reportsCost);
  const parts = rows.map(([id, t]) => `${id} ${fmtTokens(t.input + t.output)}${t.costUsd ? ` ($${t.costUsd.toFixed(2)})` : ''}`);
  return `${parts.join(', ')}${known || total ? ` — total $${total.toFixed(2)}` : ''}`;
}

export function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
