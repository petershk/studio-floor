import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { EVENT_LOG, STATE_DIR, ensureStateDir } from './paths.mjs';
import { AGENT_IDS, describe, isBookkeeping, isRaw, isTimeline } from './events.mjs';
import { UsageLedger } from './usage.mjs';
import { CONFIG, getAgent } from './roster.mjs';

/**
 * The single source of truth.
 *
 * One append-only JSONL log. Every view the human sees is a projection of it,
 * rebuilt from scratch on startup. The server process is the only writer;
 * agents and the web UI reach it over HTTP, so there is no file locking to get
 * wrong and no way for two writers to interleave a half-written line.
 */
export class Store extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    ensureStateDir();
    this.events = [];
    this.seq = 0;
    this.fd = null;
    // The highest seq this server has actually HANDED to each agent. Deliberately
    // in memory and not replayed: it is a fact about this process's conversation
    // with a client, not about project history. On restart it is empty, which
    // means /delivered cannot advance until the agent reads its inbox again —
    // failing closed into redelivery rather than into loss. See markDelivered.
    this.shown = new Map();
    this.state = emptyState();
    // Token accounting is a projection like any other, rebuilt from the log.
    // Prices are the project's own: no rate card ships with the studio, because
    // an invented default would be confidently wrong the day a vendor changes
    // its pricing, and a wrong bill is worse than no bill.
    this.usage = new UsageLedger({
      prices: (CONFIG.prices && typeof CONFIG.prices === 'object') ? CONFIG.prices : {},
      providerOf: (id) => getAgent(id)?.provider || null,
    });
    const recovered = this.#load();
    this.fd = fs.openSync(EVENT_LOG, 'a');
    for (const rec of recovered) {
      this.append('log.recovered', null, rec);
    }
    this.#seedCursors();
  }

  /**
   * Inbox cursors used to live only in .studio/cursors.json, which was written
   * but never read back, so every server restart silently reset every agent to
   * seq 0 and replayed the whole history at them. Cursors are now events. This
   * runs once, on the first boot after that change: it converts whatever the old
   * side file claimed into real acknowledgements so the change does not itself
   * cause the flood it exists to prevent. Agents with no prior record are
   * baselined at the current head, because replaying history at them would be
   * worse than admitting we do not know what they had seen.
   */
  #seedCursors() {
    if (this.events.some((ev) => ev.kind === 'inbox.acked')) return;
    let legacy = {};
    try {
      legacy = JSON.parse(fs.readFileSync(`${STATE_DIR}/cursors.json`, 'utf8'));
    } catch {
      /* no side file, or unreadable: everyone gets baselined at the head */
    }
    const head = this.seq;
    for (const id of AGENT_IDS) {
      const prior = Number(legacy[id]);
      const known = Number.isFinite(prior) && prior > 0;
      this.append('inbox.acked', null, {
        agent: id,
        through: known ? Math.min(prior, head) : head,
        reason: known
          ? 'baseline imported from the pre-event cursors.json'
          : 'baseline at head — no acknowledgement existed for this agent',
        baseline: true,
      });
    }
  }

  /**
   * Load the log.
   *
   * A torn final line (unreadable JSON) is the crash-mid-write case: quarantine
   * the bytes, truncate them off the file, and return a recovery record.
   * A final line that parses but has no trailing newline is different — the
   * record was written in full and we must not treat it as torn. Write the
   * missing terminator so the next append cannot concatenate onto it.
   * A corrupt line in the middle is not either of those: refuse to start.
   */
  #load() {
    const recovered = [];
    if (!fs.existsSync(EVENT_LOG)) return recovered;
    const buf = fs.readFileSync(EVENT_LOG);
    if (buf.length === 0) return recovered;

    const lines = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        lines.push({ start, end: i });
        start = i + 1;
      }
    }
    if (start < buf.length) lines.push({ start, end: buf.length });

    let lastGoodEnd = 0;
    const parsed = [];
    const endsWithNl = buf[buf.length - 1] === 0x0a;

    for (let i = 0; i < lines.length; i++) {
      const { start: a, end: b } = lines[i];
      const lineBuf = buf.subarray(a, b);
      const slice = lineBuf.length && lineBuf[lineBuf.length - 1] === 0x0d
        ? lineBuf.subarray(0, lineBuf.length - 1)
        : lineBuf;
      if (!slice.length || !slice.toString('utf8').trim()) {
        lastGoodEnd = b < buf.length && buf[b] === 0x0a ? b + 1 : b;
        continue;
      }
      const text = slice.toString('utf8').trim();
      let ev;
      try {
        ev = JSON.parse(text);
      } catch {
        const preview = text.length > 200 ? `${text.slice(0, 197)}…` : text;
        if (i !== lines.length - 1) {
          throw new Error(
            `event log corrupt at byte ${a}: unreadable line is not the final line (preview: ${preview})`,
          );
        }
        const lostBytes = b - a;
        const quarantined = `${STATE_DIR}/events.jsonl.torn`;
        fs.appendFileSync(
          quarantined,
          `\n--- ${new Date().toISOString()} offset=${a} bytes=${lostBytes} ---\n${slice.toString('utf8')}\n`,
        );
        recovered.push({
          torn: true,
          reason: 'torn',
          offset: a,
          lostBytes,
          preview,
          quarantined,
        });
        break;
      }
      parsed.push(ev);
      lastGoodEnd = b < buf.length && buf[b] === 0x0a ? b + 1 : b;
    }

    if (recovered.length && lastGoodEnd < buf.length) {
      const fd = fs.openSync(EVENT_LOG, 'r+');
      try {
        fs.ftruncateSync(fd, lastGoodEnd);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else if (!endsWithNl && parsed.length && !recovered.length) {
      // Last record is complete JSON with no terminator. Repair, do not
      // truncate: the author was already told this write succeeded.
      const fd = fs.openSync(EVENT_LOG, 'r+');
      try {
        fs.writeSync(fd, Buffer.from('\n'), 0, 1, buf.length);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      recovered.push({
        torn: false,
        reason: 'unterminated',
        offset: lines[lines.length - 1].start,
        lostBytes: 0,
        preview: 'last record was missing its trailing newline; terminator written',
      });
    }

    for (const [i, ev] of parsed.entries()) {
      // A line can be valid JSON and still not be an event.
      //
      // Everything downstream — isRaw, isTimeline, describe, every projection —
      // assumes `kind` is a string. A record without one used to reach them and
      // come back out as `Cannot read properties of undefined (reading
      // 'startsWith')` with a stack trace and no indication of which line was at
      // fault. This log is the team's entire memory; refusing to start is the
      // right answer, but it has to be a refusal that says what is wrong.
      if (!ev || typeof ev !== 'object' || typeof ev.kind !== 'string') {
        throw new Error(
          `event log corrupt: record ${i + 1} parses as JSON but is not an event `
          + `(no "kind" field). Found: ${clipRecord(ev)}`,
        );
      }
      this.events.push(ev);
      this.seq = Math.max(this.seq, ev.seq || 0);
      this.#project(ev);
    }
    return recovered;
  }

  /** Append an event. Returns the stored event (with seq + ts assigned). */
  append(kind, agent, data = {}) {
    const ev = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      kind,
      agent: agent || null,
      data,
    };
    const payload = Buffer.from(`${JSON.stringify(ev)}\n`, 'utf8');
    const written = fs.writeSync(this.fd, payload);
    if (written !== payload.length) {
      throw new Error(`short write to event log: wrote ${written} of ${payload.length} bytes`);
    }
    fs.fsyncSync(this.fd);
    this.events.push(ev);
    this.#project(ev);
    this.#trim();
    this.emit('event', ev);
    return ev;
  }

  /** Release the log fd. Tests that reopen the same file must call this first. */
  close() {
    if (this.fd == null) return;
    try { fs.fsyncSync(this.fd); } catch { /* already invalid */ }
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
    this.fd = null;
  }

  /** Keep memory bounded by evicting old raw events; the log on disk keeps everything. */
  #trim() {
    if (this.events.length < 80_000) return;
    const keep = [];
    let dropped = 0;
    for (const ev of this.events) {
      // Cursor state has already been projected out of these, so evicting the
      // bookkeeping from memory loses nothing; the log on disk keeps it all.
      if ((isRaw(ev.kind) || isBookkeeping(ev.kind)) && dropped < 40_000) {
        dropped++;
        continue;
      }
      keep.push(ev);
    }
    this.events = keep;
  }

  // ---------------------------------------------------------------- queries

  getEvents({
    since = 0, kinds = null, agent = null, raw = null, limit = 500, order = 'asc', includeCleared = false,
  } = {}) {
    // Everything before a clear is still in the file and still readable by
    // anything that asks for it, which is the difference between hiding and
    // deleting. The feed asks for the hidden version; `studio log` does not.
    const clearedSeq = includeCleared ? 0 : (this.state.clearedAt?.seq || 0);
    let out = [];
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev.seq <= since) break;
      if (ev.seq <= clearedSeq) break;
      if (kinds && !kinds.includes(ev.kind)) continue;
      if (agent && ev.agent !== agent && ev.data?.from !== agent) continue;
      if (raw === true && !isRaw(ev.kind)) continue;
      if (raw === false && isRaw(ev.kind)) continue;
      out.push(ev);
      if (out.length >= limit) break;
    }
    out.reverse();
    if (order === 'desc') out.reverse();
    return out;
  }

  getState() {
    return {
      ...this.state,
      usage: this.usage.snapshot(),
      seq: this.seq,
      now: new Date().toISOString(),
    };
  }

  /**
   * What an agent has not yet seen: messages addressed to it (or to everyone),
   * human directives, tasks assigned to it, and review requests. This is what
   * makes the agents responsive to each other and to the human instead of
   * running off on their own.
   */
  /**
   * `record` is true for an ordinary read: handing an agent its inbox is what
   * makes those messages eligible to be marked delivered later. The HTTP long-poll
   * passes false, because it calls this repeatedly to ask whether there is anything
   * worth sending — recording on a probe would mark messages as handed to an agent
   * that never received them, which is the loss this cursor exists to prevent.
   */
  inbox(agentId, since = null, { record = true } = {}) {
    const c = this.#cursor(agentId);
    const cursor = since ?? c.acked;
    const items = [];
    for (const ev of this.events) {
      if (ev.seq <= cursor) continue;
      if (isRaw(ev.kind) || isBookkeeping(ev.kind)) continue;
      const d = ev.data || {};
      let relevant = false;
      if (ev.kind === 'message.sent') {
        const to = d.to || [];
        relevant = d.from !== agentId && (to.length === 0 || to.includes(agentId));
      } else if (ev.kind === 'human.message') {
        relevant = !d.to?.length || d.to.includes(agentId);
      } else if (ev.kind === 'human.control' || ev.kind === 'human.verdict') {
        // The human's interventions go to everyone unless they name one agent.
        // This used to require the target to be an agent id or a task the agent
        // owned, which meant a verdict on an attention record — the target the
        // "Needs you" panel actually sends — was relevant to nobody. The human
        // pressed approve, the UI said it worked, and the decision reached no
        // one. Over-delivering a human intervention costs a line in a prompt;
        // under-delivering it breaks the thing this studio is for.
        //
        // TASK-18: on a reassignment `target` is the agent who GAINED the task,
        // so the agent who lost it matched nothing here and was never told. It
        // is the losing agent who most needs to know: it may be mid-turn on work
        // that is no longer its own.
        relevant = !AGENT_IDS.includes(d.target) || d.target === agentId || d.previousOwner === agentId;
      } else if (ev.kind === 'task.created' || ev.kind === 'task.updated') {
        const task = this.state.tasks[d.id];
        // previousOwner is a sibling of `changes`, never inside it — see
        // humanAssign. Matching it here is what tells the outgoing owner.
        relevant =
          ev.agent !== agentId &&
          (task?.owner === agentId ||
            d.changes?.owner === agentId ||
            d.changes?.reviewer === agentId ||
            d.previousOwner === agentId);
      } else if (ev.kind === 'debate.opened' || ev.kind === 'debate.position' || ev.kind === 'debate.closed') {
        relevant = ev.agent !== agentId;
      } else if (ev.kind === 'decision.recorded' || ev.kind === 'question.opened') {
        relevant = ev.agent !== agentId;
      }
      if (relevant) {
        items.push({
          seq: ev.seq,
          ts: ev.ts,
          kind: ev.kind,
          agent: ev.agent,
          data: d,
          line: describe(ev),
          // Shown before but never confirmed handled: the previous turn saw this
          // and died. The agent is being told so, rather than quietly served a
          // duplicate.
          redelivered: ev.seq <= c.delivered,
        });
      }
    }
    if (record) this.markShown(agentId, this.seq);
    return {
      cursor: this.seq,
      acked: c.acked,
      delivered: c.delivered,
      items,
      redelivered: items.filter((i) => i.redelivered).length,
    };
  }

  #cursor(agentId) {
    const c = this.state.cursors[agentId];
    if (typeof c === 'number') return { acked: c, delivered: c }; // pre-event shape
    return { acked: c?.acked || 0, delivered: c?.delivered || 0 };
  }

  /**
   * Record that an agent was *shown* items. This deliberately does not advance
   * the acknowledgement cursor: reading is not handling. If the turn dies here,
   * the next read gets the same items back, flagged as redelivered.
   */
  /**
   * Record that an agent was handed everything up to `seq`. Called only where the
   * server actually writes an inbox response — not from a long-poll probe, which
   * asks whether there is anything to send without sending it.
   */
  markShown(agentId, seq) {
    const to = Math.min(Number(seq) || 0, this.seq);
    if (to > (this.shown.get(agentId) ?? 0)) this.shown.set(agentId, to);
    return this.shown.get(agentId) ?? 0;
  }

  markDelivered(agentId, through, count = 0) {
    const c = this.#cursor(agentId);
    // Clamp to what this agent was actually SHOWN, not to the log head.
    //
    // I first clamped to `this.seq` and codex returned it, correctly. Clamping to
    // the head only defeats a cursor pointing past the end of the log; it does
    // nothing about a message that already exists and has not been shown. The
    // sequence that beat it: claude reads its inbox at head 4, codex sends claude a
    // message at seq 5, claude POSTs /delivered {through: 1004}. Head is now 5, so
    // the head clamp yields 5, ack follows, and seq 5 is skipped before anyone
    // ever saw it. A cursor may only cover what this server handed out.
    const ceiling = Math.max(this.shown.get(agentId) ?? 0, c.delivered);
    const want = Math.min(Number(through) || 0, ceiling);
    const to = Math.max(c.delivered, want);
    if (to === c.delivered) return { ...c, clamped: (Number(through) || 0) > to };
    this.append('inbox.delivered', null, { agent: agentId, through: to, count });
    return this.#cursor(agentId);
  }

  /**
   * Record that an agent finished a turn and is done with everything up to
   * `through`. Only this drops items out of the inbox. Clamped to what the agent
   * was actually shown, so nobody can acknowledge away messages they never saw.
   */
  ack(agentId, through = null, reason = null) {
    const c = this.#cursor(agentId);
    const want = through == null ? c.delivered : Number(through) || 0;
    const to = Math.min(Math.max(c.acked, want), Math.max(c.delivered, c.acked));
    const clamped = want > to;
    if (to === c.acked) return { ...this.#cursor(agentId), clamped };
    this.append('inbox.acked', null, { agent: agentId, through: to, reason });
    return { ...this.#cursor(agentId), clamped };
  }

  /** @deprecated Kept so older callers do not silently do nothing. Use ack(). */
  markRead(agentId, cursor) {
    // The legacy contract IS "reading is acknowledgement": the caller asserts it
    // has seen everything through `cursor`. So the assertion is recorded as a
    // showing, and the rest of the path behaves exactly as it always did.
    //
    // This does mean /api/inbox/read remains forgeable in the way /delivered no
    // longer is, and that is deliberate rather than overlooked: it is the lossy
    // path TASK-14 exists to replace, it is already marked deprecated on the wire,
    // and silently no-opping an old client would be a worse failure than the one
    // it is being kept for. Closing it means deleting it, which is a decision to
    // take on purpose and not a clamp to slip in here.
    this.markShown(agentId, cursor);
    this.markDelivered(agentId, cursor);
    return this.ack(agentId, cursor, 'legacy markRead');
  }

  // ------------------------------------------------------------- projection

  #project(ev) {
    const s = this.state;
    const d = ev.data || {};
    const agentId = ev.agent;

    // Before the switch below: the ledger needs raw.turn.start (for the turn
    // number and session id) as well as raw.usage, and turn.start is handled
    // separately down there.
    this.usage.observe(ev);

    if (agentId && !s.agents[agentId]) s.agents[agentId] = newAgent(agentId);
    if (agentId) s.agents[agentId].lastSeen = ev.ts;

    switch (ev.kind) {
      case 'inbox.delivered':
      case 'inbox.acked': {
        const id = d.agent;
        if (!id) break;
        const prev = s.cursors[id];
        const c = typeof prev === 'number'
          ? { acked: prev, delivered: prev }
          : { acked: prev?.acked || 0, delivered: prev?.delivered || 0 };
        const through = Number(d.through) || 0;
        // An ack implies delivery: whatever was confirmed was necessarily shown.
        c.delivered = Math.max(c.delivered, through);
        if (ev.kind === 'inbox.acked') c.acked = Math.max(c.acked, through);
        s.cursors[id] = c;
        break;
      }

      case 'agent.registered': {
        const a = s.agents[agentId];
        a.online = true;
        a.state = d.state || 'idle';
        a.strengths = d.strengths || a.strengths;
        a.intro = d.intro || a.intro;
        a.joinedAt = ev.ts;
        break;
      }
      case 'agent.stopped': {
        const a = s.agents[agentId];
        a.online = false;
        a.state = 'offline';
        a.note = d.reason || '';
        break;
      }
      case 'agent.state': {
        const a = s.agents[agentId];
        a.state = d.state;
        if ('task' in d) a.currentTask = d.task || null;
        if ('note' in d) a.note = d.note || '';
        break;
      }

      case 'message.sent':
        s.messages.push({
          seq: ev.seq,
          ts: ev.ts,
          from: d.from || agentId,
          to: d.to || [],
          kind: d.kind || 'chat',
          text: d.text || '',
          re: d.re || null,
        });
        break;

      case 'human.message':
        s.messages.push({
          seq: ev.seq,
          ts: d.historical && d.originalTs ? d.originalTs : ev.ts,
          from: 'human',
          to: d.to || [],
          kind: 'chat',
          text: d.text || '',
          re: d.re || null,
        });
        break;

      case 'task.created':
        s.tasks[d.id] = {
          id: d.id,
          title: d.title || '',
          objective: d.objective || '',
          owner: d.owner || null,
          reviewer: d.reviewer || null,
          state: d.state || 'proposed',
          context: d.context || '',
          deps: d.deps || [],
          createdBy: agentId,
          createdAt: ev.ts,
          updatedAt: ev.ts,
          result: null,
          history: [{ ts: ev.ts, by: agentId, change: 'created', state: d.state || 'proposed' }],
        };
        s.counters.task = Math.max(s.counters.task, numeric(d.id));
        break;

      case 'task.updated': {
        const t = s.tasks[d.id];
        if (!t) break;
        Object.assign(t, d.changes || {});
        t.updatedAt = ev.ts;
        t.history.push({ ts: ev.ts, by: agentId, change: summarise(d.changes), note: d.note || '', state: t.state });
        break;
      }

      case 'decision.recorded':
        s.decisions.push({
          id: d.id,
          ts: ev.ts,
          question: d.question || '',
          supersedes: d.supersedes || null,
          alternatives: d.alternatives || [],
          arguments: d.arguments || [],
          chosen: d.chosen || '',
          why: d.why || '',
          participants: d.participants || [],
          humanRole: d.humanRole || 'none',
          relatedTask: d.relatedTask || null,
          by: agentId,
        });
        s.counters.decision = Math.max(s.counters.decision, numeric(d.id));
        break;

      case 'debate.opened':
        s.debates[d.id] = {
          id: d.id,
          ts: ev.ts,
          question: d.question || '',
          openedBy: agentId,
          status: 'open',
          positions: [],
          outcome: null,
          relatedTask: d.relatedTask || null,
        };
        s.counters.debate = Math.max(s.counters.debate, numeric(d.id));
        break;

      case 'debate.position': {
        const deb = s.debates[d.id];
        if (!deb) break;
        deb.positions.push({
          ts: ev.ts,
          agent: agentId,
          stance: d.stance || '',
          because: d.because || '',
          critique: d.critique || '',
          round: d.round || deb.positions.length + 1,
        });
        break;
      }

      case 'debate.closed': {
        const deb = s.debates[d.id];
        if (!deb) break;
        deb.status = 'closed';
        deb.outcome = d.outcome || '';
        deb.decisionId = d.decisionId || null;
        break;
      }

      case 'question.opened':
        s.questions.push({ id: d.id, ts: ev.ts, text: d.text, by: agentId, status: 'open' });
        s.counters.question = Math.max(s.counters.question, numeric(d.id));
        break;

      case 'question.closed': {
        const q = s.questions.find((x) => x.id === d.id);
        if (q) {
          q.status = 'closed';
          q.answer = d.answer || '';
        }
        break;
      }

      case 'attention.raised':
        s.attention.push({
          id: `ATT-${ev.seq}`,
          seq: ev.seq,
          ts: ev.ts,
          by: agentId,
          kind: d.kind || 'decision',
          text: d.text || '',
          options: d.options || [],
          ref: d.ref || null,
          status: 'open',
        });
        break;

      // An agent can take back its own ask when it goes stale, but it can never
      // make it vanish: status becomes 'withdrawn', not 'cleared', so the human can
      // still tell the difference between "I dealt with this" and "an agent decided
      // I no longer needed to". the project brief tells us not to overwhelm the human, and
      // until now the queue could only grow from our side.
      case 'attention.withdrawn': {
        const item = s.attention.find((x) => x.id === d.id);
        if (item && item.status === 'open') {
          item.status = 'withdrawn';
          item.withdrawnBy = agentId;
          item.withdrawnReason = d.reason || '';
          item.withdrawnAt = ev.ts;
        }
        break;
      }

      case 'attention.cleared': {
        const item = s.attention.find((x) => x.id === d.id);
        if (item) {
          item.status = 'cleared';
          item.resolution = d.resolution || '';
        }
        break;
      }

      case 'work.files':
        s.files.push({ ts: ev.ts, by: agentId, action: d.action || 'changed', files: d.files || [], task: d.task || null });
        for (const f of d.files || []) s.fileIndex[f] = { by: agentId, ts: ev.ts, task: d.task || null };
        break;

      case 'work.validation':
        s.validations.push({
          ts: ev.ts,
          by: agentId,
          name: d.name || 'validation',
          command: d.command || '',
          ok: !!d.ok,
          output: d.output || '',
          task: d.task || null,
        });
        s.health = { ok: !!d.ok, name: d.name || 'validation', ts: ev.ts, by: agentId };
        break;

      case 'work.discovery':
        s.discoveries.push({ ts: ev.ts, by: agentId, text: d.text || '', ref: d.ref || null });
        break;

      case 'log.recovered':
        s.recoveries.push({
          seq: ev.seq,
          ts: ev.ts,
          torn: !!d.torn,
          reason: d.reason || (d.torn ? 'torn' : 'recovered'),
          offset: d.offset || 0,
          lostBytes: d.lostBytes || 0,
          preview: d.preview || '',
          quarantined: d.quarantined || null,
        });
        break;

      case 'human.control':
        if (!d.historical) {
          if (d.action === 'pause') {
            if (d.target && s.agents[d.target]) s.agents[d.target].paused = true;
            else s.paused = true;
          } else if (d.action === 'resume') {
            if (d.target && s.agents[d.target]) s.agents[d.target].paused = false;
            else s.paused = false;
          } else if (d.action === 'priority') {
            s.priority = d.text || '';
          }
        }
        s.controls.push({
          ts: d.historical && d.originalTs ? d.originalTs : ev.ts,
          action: d.action,
          target: d.target || null,
          text: d.text || '',
          historical: !!d.historical,
          legacyDirectiveId: d.legacyDirectiveId || null,
        });
        break;

      case 'human.verdict': {
        const item = s.attention.find((x) => x.id === d.target);
        if (item && !d.historical) {
          item.status = 'cleared';
          item.resolution = `${d.verdict}: ${d.text || ''}`;
        }
        // Attention records often point at the thing the human is actually
        // judging. Clearing ATT-123 without updating its DEC/TASK ref made the
        // click visible in the queue but left the referenced decision unchanged.
        const judged = item?.ref && ['approve', 'reject'].includes(d.verdict)
          ? item.ref
          : d.target;
        const approved = d.verdict === 'approve' ? true : d.verdict === 'reject' ? false : null;
        const t = s.tasks[judged];
        if (t && !d.historical && approved !== null) {
          t.humanApproved = approved;
          t.humanVerdict = d.verdict;
          t.humanVerdictText = d.text || '';
          t.humanVerdictAt = ev.ts;
        }
        const decision = s.decisions.find((x) => x.id === judged);
        if (decision && !d.historical && approved !== null) {
          decision.humanApproved = approved;
          decision.humanVerdict = d.verdict;
          decision.humanVerdictText = d.text || '';
          decision.humanVerdictAt = ev.ts;
          // Reuse the field the existing decision UI already renders. A reject
          // is an override of the recorded choice; an approve is an approval.
          decision.humanRole = approved ? 'approved' : 'override';
        }
        break;
      }

      case 'raw.turn.start': {
        const a = s.agents[agentId];
        a.turn = { n: d.turn, startedAt: ev.ts, reason: d.reason || '' };
        a.turns = (a.turns || 0) + 1;
        break;
      }
      case 'raw.turn.end': {
        const a = s.agents[agentId];
        a.turn = null;
        a.lastTurnEnded = ev.ts;
        break;
      }
      case 'raw.usage': {
        // The ledger decides what this event means -- a turn total, one message
        // of many, or a cumulative session counter -- because the three
        // providers report all three shapes and adding them together overstates
        // Codex by an order of magnitude. See core/usage.mjs.
        const a = s.agents[agentId];
        a.usage = { ...(a.usage || {}), ...(d.usage || {}) };
        a.tokens = this.usage.totalsFor(agentId);
        break;
      }
      case 'raw.tool.call': {
        const a = s.agents[agentId];
        a.lastTool = { name: d.name, brief: d.brief || '', ts: ev.ts };
        a.toolCalls = (a.toolCalls || 0) + 1;
        break;
      }
      case 'raw.error': {
        const a = s.agents[agentId];
        a.lastError = { text: d.text || '', ts: ev.ts };
        break;
      }
      default:
        break;
    }

    // Clearing is an event, not an edit.
    //
    // The log is append-only and nothing rewrites it — that invariant is why a
    // studio can be rebuilt from its file and why two agents cannot lose each
    // other's history. So "clear the conversation" appends a marker, and the
    // projection empties itself when it reaches one. Replay reproduces exactly
    // the same result, the file still holds every word, and `studio log --raw`
    // can still show what was said.
    if (ev.kind === 'studio.cleared') {
      const what = d.what || 'conversation';
      if (what === 'conversation' || what === 'all') {
        s.messages.length = 0;
        s.timeline.length = 0;
      }
      // The raw feed is served from the log rather than from here, so the
      // marker is all this projection needs to record for it.
      s.clearedAt = { seq: ev.seq, ts: ev.ts, what };
    }

    if (isTimeline(ev.kind)) {
      const displayTs = d.historical && d.originalTs ? d.originalTs : ev.ts;
      s.timeline.push({ seq: ev.seq, ts: displayTs, kind: ev.kind, agent: agentId, line: describe(ev), data: d });
      if (s.timeline.length > 5000) s.timeline.shift();
    }
    if (s.messages.length > 5000) s.messages.shift();
  }
}

function newAgent(id) {
  return {
    id,
    online: false,
    paused: false,
    state: 'offline',
    currentTask: null,
    strengths: [],
    intro: '',
    note: '',
    lastSeen: null,
    joinedAt: null,
    turns: 0,
    toolCalls: 0,
    usage: null,
    turn: null,
    lastTool: null,
    lastError: null,
  };
}

function emptyState() {
  const agents = {};
  for (const id of AGENT_IDS) agents[id] = newAgent(id);
  return {
    paused: false,
    priority: '',
    agents,
    tasks: {},
    messages: [],
    // Set by a studio.cleared marker: where the visible history starts.
    clearedAt: null,
    decisions: [],
    debates: {},
    questions: [],
    attention: [],
    timeline: [],
    files: [],
    fileIndex: {},
    validations: [],
    discoveries: [],
    controls: [],
    health: null,
    recoveries: [],
    cursors: {},
    counters: { task: 0, decision: 0, debate: 0, question: 0 },
  };
}

function numeric(id) {
  const m = /(\d+)\s*$/.exec(String(id || ''));
  return m ? Number(m[1]) : 0;
}

function summarise(changes = {}) {
  return Object.entries(changes)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

/** A record rendered short enough for an error message. */
function clipRecord(v) {
  let s;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  s = String(s ?? 'nothing');
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}
