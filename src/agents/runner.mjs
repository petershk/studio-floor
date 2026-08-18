import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, STATE_DIR, TRANSCRIPT_DIR, BASE_URL, STUDIO_CMD } from '../core/paths.mjs';
import { CONFIG, AGENTS, getAgent } from '../core/roster.mjs';
import { getAdapter } from './adapters/index.mjs';
import { resolveLaunch } from './launch.mjs';
import { firstTurnPrompt, turnPrompt } from './prompts.mjs';

/**
 * The runner's own settings, flattened out of the config so the rest of this
 * file can keep reading `this.config.maxTurns` rather than reaching two levels
 * deep on every access.
 */
export function loadConfig(config = CONFIG) {
  return {
    ...config.runner,
    project: config.project,
    // Which agents this process supervises. Narrowed by `--only`; it does not
    // narrow the roster, because a stopped agent should look stopped rather
    // than disappear from the team.
    agents: config.agents.map((a) => a.id),
    roster: config.agents,
  };
}

/**
 * Runs the configured agents as long-lived participants.
 *
 * Each agent is a loop of bounded headless turns against its own persistent
 * session. Between turns it blocks on its studio inbox, so an agent reacts to
 * what another agent (or the human) said instead of running on a timer.
 *
 * Nothing here knows what a "codex" is. An agent has a provider, the provider
 * resolves to an adapter, and the adapter is the only code that has ever seen a
 * vendor CLI. That is what lets a team be three different models, or five
 * instances of one model wearing five different hats.
 */
export class Runner {
  constructor(store, config = loadConfig()) {
    this.store = store;
    this.config = config;
    this.agents = new Map();
    const roster = config.roster || AGENTS;
    for (const id of config.agents) {
      const record = roster.find((a) => a.id === id) || getAgent(id);
      if (!record) {
        throw new Error(`studio: "${id}" is not in the roster — check the agents list in your config`);
      }
      if (!getAdapter(record.provider)) {
        throw new Error(
          `studio: agent "${id}" wants provider "${record.provider}", which has no adapter. `
          + 'Add one to the `adapters` list in your config, or fix the provider name.',
        );
      }
      this.agents.set(id, {
        id,
        record,
        running: false,
        stopping: false,
        child: null,
        sessionId: null,
        turn: 0,
        quietTurns: 0,
        idleLevel: 0,
        wakeReason: null,
        waiter: null,
        lastExit: null,
      });
    }
    this.store.on('event', (ev) => this.#onStoreEvent(ev));
  }

  status() {
    const out = {};
    for (const [id, a] of this.agents) {
      out[id] = {
        running: a.running,
        provider: a.record.provider,
        label: a.record.label,
        turn: a.turn,
        sessionId: a.sessionId,
        pid: a.child?.pid || null,
        lastExit: a.lastExit,
        quietTurns: a.quietTurns,
      };
    }
    return { agents: out, config: redact(this.config) };
  }

  /** Wake an agent so it takes a turn as soon as its current one finishes. */
  wake(ids, reason) {
    for (const id of ids || []) {
      const a = this.agents.get(id);
      if (!a) continue;
      a.wakeReason = reason;
      a.idleLevel = 0;
      if (a.waiter) {
        a.waiter();
        a.waiter = null;
      }
    }
  }

  #onStoreEvent(ev) {
    const d = ev.data || {};
    if (ev.kind === 'message.sent') {
      const to = d.to?.length ? d.to : [...this.agents.keys()].filter((x) => x !== d.from);
      this.wake(to, `${d.from} sent you a ${d.kind || 'message'}`);
    } else if (ev.kind === 'task.created' || ev.kind === 'task.updated') {
      const owner = d.changes?.owner || this.store.state.tasks[d.id]?.owner;
      const reviewer = d.changes?.reviewer || this.store.state.tasks[d.id]?.reviewer;
      const targets = [owner, reviewer].filter((x) => x && x !== ev.agent);
      if (targets.length) this.wake(targets, `${d.id} concerns you`);
    } else if (ev.kind === 'debate.opened' || ev.kind === 'debate.position') {
      this.wake([...this.agents.keys()].filter((x) => x !== ev.agent), `debate ${d.id} is live`);
    }
  }

  async startAll() {
    let delay = 0;
    for (const id of this.config.agents) {
      setTimeout(() => this.start(id), delay);
      delay += this.config.staggerMs;
    }
  }

  async start(id) {
    const a = this.agents.get(id);
    if (!a || a.running) return;
    a.running = true;
    a.stopping = false;
    this.store.append('agent.state', id, { state: 'starting', note: 'process starting' });
    this.#loop(a).catch((err) => {
      this.store.append('raw.error', id, { text: `runner loop crashed: ${err?.stack || err}` });
      a.running = false;
      this.store.append('agent.state', id, { state: 'error', note: 'runner loop crashed; inspect Raw for evidence' });
    });
  }

  async stop(id, reason = 'stopped') {
    const a = this.agents.get(id);
    if (!a) return;
    a.stopping = true;
    a.running = false;
    if (a.waiter) {
      a.waiter();
      a.waiter = null;
    }
    if (a.child) {
      try {
        a.child.kill();
      } catch {
        /* already gone */
      }
    }
    this.store.append('agent.stopped', id, { reason });
  }

  async stopAll(reason = 'studio shutting down') {
    await Promise.all([...this.agents.keys()].map((id) => this.stop(id, reason)));
  }

  async onControl(body) {
    const { action, target } = body;
    if (action === 'stop') {
      if (target) await this.stop(target, 'stopped by human');
      else await this.stopAll('stopped by human');
    } else if (action === 'resume') {
      const ids = target ? [target] : [...this.agents.keys()];
      for (const id of ids) {
        const a = this.agents.get(id);
        if (a && !a.running) await this.start(id);
      }
      this.wake(ids, 'the human resumed work');
    } else if (action === 'pause') {
      // the loop checks the paused flag before each turn; nothing to kill
    } else if (action === 'nudge' || action === 'assign' || action === 'priority') {
      this.wake(target ? [target] : [...this.agents.keys()], `the human ${action}ed`);
    }
  }

  // ------------------------------------------------------------------- loop

  async #loop(a) {
    while (a.running && !a.stopping) {
      if (this.config.maxTurns && a.turn >= this.config.maxTurns) {
        a.running = false;
        this.store.append('agent.stopped', a.id, {
          reason: `turn budget of ${this.config.maxTurns} reached — restart from the studio to continue`,
        });
        break;
      }

      const paused = this.store.state.paused || this.store.state.agents[a.id]?.paused;
      if (paused) {
        this.store.append('agent.state', a.id, { state: 'paused', note: 'paused by the human' });
        await this.#waitForWake(a, 0);
        continue;
      }

      const decision = this.#shouldTakeTurn(a);
      if (!decision.go) {
        const backoff = this.config.idleBackoffMs[Math.min(a.idleLevel, this.config.idleBackoffMs.length - 1)];
        a.idleLevel++;
        await this.#waitForWake(a, backoff);
        continue;
      }

      a.idleLevel = 0;
      await this.#runTurn(a, decision.reason);
      await sleep(this.config.cooldownMs);
    }
  }

  /**
   * Whether there is a reason to spend a turn. Without this an idle studio
   * would burn tokens re-reading its own empty inbox forever.
   */
  #shouldTakeTurn(a) {
    if (a.wakeReason) {
      const reason = a.wakeReason;
      a.wakeReason = null;
      return { go: true, reason };
    }
    if (a.turn === 0) return { go: true, reason: 'you are joining the studio' };

    const s = this.store.state;
    const inbox = this.store.inbox(a.id).items;
    if (inbox.length) return { go: true, reason: `${inbox.length} new item(s) concern you` };

    const mine = Object.values(s.tasks).filter(
      (t) => t.owner === a.id && ['assigned', 'active', 'ready'].includes(t.state),
    );
    if (mine.length) return { go: true, reason: `you own ${mine.map((t) => t.id).join(', ')}` };

    const toReview = Object.values(s.tasks).filter((t) => t.state === 'under-review' && t.reviewer === a.id);
    if (toReview.length) return { go: true, reason: `${toReview.map((t) => t.id).join(', ')} is waiting on your review` };

    const unowned = Object.values(s.tasks).filter((t) => !t.owner && ['proposed', 'ready'].includes(t.state));
    if (unowned.length && a.quietTurns < 2) return { go: true, reason: `unclaimed work exists: ${unowned.map((t) => t.id).join(', ')}` };

    const openDebate = Object.values(s.debates).some(
      (d) => d.status === 'open' && !d.positions.some((p) => p.agent === a.id),
    );
    if (openDebate) return { go: true, reason: 'a debate is open and you have not taken a position' };

    if (Object.keys(s.tasks).length === 0) return { go: true, reason: 'the team has not divided the work yet' };

    return { go: false, reason: 'nothing to do' };
  }

  async #waitForWake(a, ms) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        a.waiter = null;
        resolve();
      };
      const timer = ms > 0 ? setTimeout(finish, ms) : null;
      a.waiter = finish;
    });
  }

  // ------------------------------------------------------------------- turn

  async #runTurn(a, reason) {
    const adapter = getAdapter(a.record.provider);
    if (!adapter) throw new Error(`no adapter for provider ${a.record.provider} (agent ${a.id})`);

    a.turn++;
    const startSeq = this.store.seq;
    const fresh = !a.sessionId;
    if (fresh && adapter.newSession) a.sessionId = adapter.newSession();

    const inboxData = this.store.inbox(a.id);
    this.store.markDelivered(a.id, inboxData.cursor, inboxData.items.length);
    const brief = await fetchBrief(a.id);
    // Both paths get the inbox. A fresh turn used to get only the brief while the
    // acknowledgement below still ran, so arriving — or coming back from a lost
    // session — silently consumed everything waiting, human directives included.
    const prompt = fresh
      ? firstTurnPrompt(a.record, brief, { inbox: inboxData.items, project: this.config.project })
      : turnPrompt(a.record, { turn: a.turn, reason, inbox: inboxData.items, brief });

    this.store.append('raw.turn.start', a.id, { turn: a.turn, reason, fresh, sessionId: a.sessionId });
    this.store.append('agent.state', a.id, { state: 'thinking', note: reason });

    const launch = {};
    const args = buildLaunchableArgs(this.store, a.id, adapter, {
      prompt,
      sessionId: a.sessionId,
      fresh,
      agent: a.record,
    }, launch, this.config.commandLineBudget);
    const transcript = fs.createWriteStream(
      path.join(TRANSCRIPT_DIR, `${a.id}-turn-${String(a.turn).padStart(3, '0')}.jsonl`),
    );
    transcript.write(`${JSON.stringify({ meta: 'turn', agent: a.id, turn: a.turn, reason, args: redactArgs(args) })}\n`);

    const exit = await this.#spawnTurn(a, adapter, args, transcript);
    transcript.end();

    // The inbox is acknowledged only by a turn that actually finished. A crashed
    // or killed turn leaves its items unacknowledged, so the next turn is handed
    // them again and told they are a redelivery. Losing a message because the
    // process died is exactly the silent failure this studio exists to expose.
    if (exit.code === 0 && launch.shortened && inboxData.items.length) {
      // A clean exit is not evidence the agent saw its inbox.
      //
      // codex found this on the TASK-006 review and it is the sharper half of that
      // defect: even after the size guard was fixed to cut the middle instead of
      // the tail, a long enough queue still loses characters somewhere, and the
      // ack below covered the whole cursor regardless. So a human directive could
      // be partially cut out of the launched prompt and then marked handled.
      //
      // Rather than guess which items survived the cut, acknowledge none of them.
      // The items come back next turn flagged as a redelivery, which the system
      // already handles and the agent is already told about. Failing closed costs
      // one repeated inbox; failing open loses the human's words silently.
      this.store.append('studio.note', a.id, {
        text: `turn ${a.turn} completed, but its prompt was shortened to fit the command line, `
          + `so ${inboxData.items.length} inbox item(s) are NOT acknowledged and will be delivered again`,
      });
    } else if (exit.code === 0) {
      this.store.ack(a.id, inboxData.cursor, `turn ${a.turn} completed`);
    } else if (inboxData.items.length) {
      this.store.append('studio.note', a.id, {
        text: `turn ${a.turn} exited with code ${exit.code}; ${inboxData.items.length} inbox item(s) `
          + `left unacknowledged and will be delivered again`,
      });
    }

    const produced = this.store.events.filter(
      (ev) => ev.seq > startSeq && ev.agent === a.id && !ev.kind.startsWith('raw.'),
    ).length;
    a.quietTurns = produced ? 0 : a.quietTurns + 1;

    this.store.append('raw.turn.end', a.id, {
      turn: a.turn,
      exitCode: exit.code,
      signal: exit.signal,
      studioActions: produced,
      durationMs: exit.durationMs,
    });

    if (exit.code === 0 && ['starting', 'thinking'].includes(this.store.state.agents[a.id]?.state)) {
      this.store.append('agent.state', a.id, {
        state: 'waiting',
        note: 'provider turn ended; waiting for work or a message',
      });
    }

    // A launch failure is not a turn failure: the provider never ran, so nothing
    // about the studio changed and retrying immediately just reproduces it. Left
    // alone this span forever — thousands of identical errors, the whole team
    // down, and no single event saying so. Give up after a few and tell the human.
    if (exit.launchFailed) {
      a.launchFailures = (a.launchFailures || 0) + 1;
      if (a.launchFailures >= 3) {
        this.store.append('attention.raised', a.id, {
          kind: 'blocked',
          text: `${a.id} cannot be launched: ${adapter.command} failed to start ${a.launchFailures} times in a row. `
            + 'The agent is stopped. This is an environment or runner problem, not something the team can fix from inside the studio.',
        });
        await this.stop(a.id, `provider failed to launch ${a.launchFailures} times`);
        return;
      }
      await sleep(Math.min(30_000, 5_000 * a.launchFailures));
      return;
    }
    a.launchFailures = 0;

    if (exit.code !== 0 && !a.stopping) {
      this.store.append('agent.state', a.id, {
        state: 'error',
        note: `turn ${a.turn} exited with code ${exit.code}`,
      });
      // A failed resume usually means the session is gone; start a fresh one.
      if (exit.sessionProblem) {
        this.store.append('studio.note', a.id, { text: 'session could not be resumed — starting a fresh session' });
        a.sessionId = adapter.newSession ? adapter.newSession() : null;
      }
      await sleep(5000);
    }

    if (a.quietTurns >= 3) {
      this.store.append('agent.state', a.id, {
        state: 'idle',
        note: 'three turns without any studio activity — sleeping until something happens',
      });
      a.idleLevel = this.config.idleBackoffMs.length - 1;
    }
  }

  #spawnTurn(a, adapter, args, transcript) {
    return new Promise((resolve) => {
      const started = Date.now();
      const env = {
        ...process.env,
        STUDIO_AGENT: a.id,
        STUDIO_URL: BASE_URL,
        STUDIO_PROJECT_ROOT: PROJECT_ROOT,
        STUDIO_CMD,
        ...(a.record.options?.env || {}),
      };
      // An agent may override the executable — a wrapper script, a pinned
      // version, or the same provider reached through a different binary.
      const wanted = a.record.options?.command || adapter.command;
      // On Windows an npm-installed CLI is a .cmd shim that Node will not spawn
      // without a shell, and a shell is not an option here: one of the arguments
      // is the turn prompt, which is arbitrary text. See agents/launch.mjs.
      const launch = resolveLaunch(wanted);
      if (launch.error) {
        this.store.append('raw.error', a.id, { text: launch.error });
        return resolve({ code: -1, signal: null, durationMs: 0, sessionProblem: false, launchFailed: true });
      }
      const command = launch.command;
      const spawnArgs = [...(launch.prefixArgs || []), ...args];
      let child;
      try {
        child = spawn(command, spawnArgs, {
          cwd: PROJECT_ROOT,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        this.store.append('raw.error', a.id, { text: `could not launch ${wanted}: ${err.message}` });
        return resolve({ code: -1, signal: null, durationMs: 0, sessionProblem: false, launchFailed: true });
      }
      a.child = child;

      let stdoutBuf = '';
      let stderrBuf = '';
      let sessionProblem = false;

      const timer = setTimeout(() => {
        this.store.append('raw.error', a.id, { text: `turn exceeded ${this.config.turnTimeoutMs}ms — terminating` });
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, this.config.turnTimeoutMs);

      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk;
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          transcript.write(`${line}\n`);
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            this.store.append('raw.native', a.id, { summary: 'non-json stdout', payload: { line: line.slice(0, 2000) } });
            continue;
          }
          for (const item of adapter.parse(obj)) this.#emit(a, item);
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          transcript.write(`${JSON.stringify({ stderr: line })}\n`);
          if (/no session|session not found|unknown session|could not resume/i.test(line)) sessionProblem = true;
          if (/error|fatal|panic|unauthori[sz]ed|not logged in/i.test(line)) {
            this.store.append('raw.error', a.id, { text: line.slice(0, 2000), stream: 'stderr' });
          } else {
            this.store.append('raw.native', a.id, { summary: 'stderr', payload: { line: line.slice(0, 1000) } });
          }
        }
      });

      child.on('error', (err) => {
        this.store.append('raw.error', a.id, { text: `process error: ${err.message}` });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        a.child = null;
        a.lastExit = { code, signal, at: new Date().toISOString() };
        resolve({ code, signal, durationMs: Date.now() - started, sessionProblem });
      });
    });
  }

  /** Turn one normalised adapter item into studio events. */
  #emit(a, item) {
    if (item.kind === 'session') {
      if (item.data.sessionId) a.sessionId = item.data.sessionId;
      return;
    }
    if (item.kind === 'files') {
      const files = (item.data.files || []).map((f) => rel(f));
      if (files.length) this.store.append('work.files', a.id, { action: item.data.action, files, source: 'observed' });
      return;
    }
    if (item.kind === 'final') {
      if (item.data.text?.trim()) this.store.append('raw.text', a.id, { text: item.data.text, final: true });
      return;
    }
    this.store.append(item.kind, a.id, item.data);
  }
}

async function fetchBrief(agentId) {
  try {
    const r = await fetch(`${BASE_URL}/api/state`);
    const s = await r.json();
    return renderBrief(agentId, s);
  } catch {
    return `(the studio brief was unavailable this turn — run \`${STUDIO_CMD} brief\` yourself)`;
  }
}

/**
 * How much of each unbounded section the brief may spend.
 *
 * Every one of these used to be uncapped. The brief is embedded in the turn
 * prompt, the prompt was passed to the provider as a single argv element, and
 * Windows refuses a command line over 32767 characters — so once the studio had
 * accumulated enough history the brief crossed that line and every spawn failed
 * with ENAMETOOLONG before the process started. The whole team stopped at once,
 * and because a launch failure is not a turn failure the runner retried forever.
 * Bound the inputs, and separately refuse to hand spawn a prompt that cannot fit.
 */
const BRIEF_LIMITS = {
  message: 700,      // one message body
  messages: 16,      // how many recent messages
  taskTitle: 110,
  decision: 220,
  discovery: 200,
  discoveries: 6,
  question: 160,
  attention: 220,
  total: 12_000,     // the brief as a whole
};

function clipText(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}… [+${t.length - n} chars, see the studio]` : t;
}

/** A compact copy of the CLI briefing, inlined so the first prompt is never empty. */
function renderBrief(agentId, s) {
  const L = ['=== STUDIO BRIEF ==='];
  if (s.paused) L.push('!! ALL WORK IS PAUSED BY THE HUMAN');
  if (s.priority) L.push(`!! Human priority: ${s.priority}`);
  L.push('Agents:');
  for (const a of Object.values(s.agents)) {
    L.push(`  ${a.id}${a.id === agentId ? ' (you)' : ''}: ${a.state}${a.currentTask ? ` on ${a.currentTask}` : ''}${a.strengths?.length ? ` — ${a.strengths.join(', ')}` : ''}`);
  }
  const tasks = Object.values(s.tasks);
  L.push(`Tasks: ${tasks.length ? '' : '(none yet — the team has not divided the work)'}`);
  for (const t of tasks) {
    if (['completed', 'rejected'].includes(t.state)) continue;
    L.push(`  ${t.id} [${t.state}] ${clipText(t.title, BRIEF_LIMITS.taskTitle)} — owner:${t.owner || 'unassigned'}${t.reviewer ? ` reviewer:${t.reviewer}` : ''}`);
  }
  const done = tasks.filter((t) => t.state === 'completed');
  if (done.length) L.push(`  completed: ${done.map((t) => t.id).join(', ')}`);
  if (s.decisions.length) {
    L.push('Decisions already made (do not reopen without new information):');
    for (const d of s.decisions.slice(-8)) L.push(`  ${d.id} ${clipText(`${d.question} → ${d.chosen}`, BRIEF_LIMITS.decision)}`);
  }
  const openDebates = Object.values(s.debates).filter((d) => d.status === 'open');
  if (openDebates.length) {
    L.push('Open debates:');
    for (const d of openDebates) {
      L.push(`  ${d.id} ${clipText(d.question, BRIEF_LIMITS.decision)}`);
      for (const p of d.positions) L.push(`     ${p.agent}: ${clipText(p.stance, BRIEF_LIMITS.decision)}`);
    }
  }
  const openQ = s.questions.filter((q) => q.status === 'open');
  if (openQ.length) L.push(`Unresolved questions: ${openQ.map((q) => `${q.id} ${clipText(q.text, BRIEF_LIMITS.question)}`).join(' | ')}`);
  const att = s.attention.filter((x) => x.status === 'open');
  if (att.length) L.push(`Waiting on the human: ${att.map((x) => `${x.kind}: ${clipText(x.text, BRIEF_LIMITS.attention)}`).join(' | ')}`);
  if (s.discoveries.length) {
    L.push('Discoveries:');
    for (const d of s.discoveries.slice(-BRIEF_LIMITS.discoveries)) L.push(`  (${d.by}) ${clipText(d.text, BRIEF_LIMITS.discovery)}`);
  }
  L.push('Recent conversation:');
  const msgs = s.messages.slice(-BRIEF_LIMITS.messages);
  if (!msgs.length) L.push('  (nobody has said anything yet)');
  for (const m of msgs) {
    L.push(`  ${m.from}${m.to?.length ? `→${m.to.join(',')}` : ''} [${m.kind}]: ${clipText(m.text, BRIEF_LIMITS.message)}`);
  }
  if (s.health) L.push(`Project health: ${s.health.name} ${s.health.ok ? 'passing' : 'FAILING'}`);

  const brief = L.join('\n');
  if (brief.length <= BRIEF_LIMITS.total) return brief;
  // Keep the head — agents, tasks, decisions — and say plainly what was cut,
  // rather than silently handing the agent a half-truth about its own studio.
  return `${brief.slice(0, BRIEF_LIMITS.total)}\n\n[brief truncated at ${BRIEF_LIMITS.total} of ${brief.length} characters — run \`${STUDIO_CMD} brief\` for the full picture]`;
}

/**
 * Windows refuses to start a process whose whole command line exceeds 32767
 * characters, and the failure is ENAMETOOLONG from spawn itself — the provider
 * never runs, so it cannot tell anyone what went wrong. The prompt is the only
 * part that grows without limit, so trim it to fit and say so in the prompt and
 * in the log. A turn on a shortened brief is worth having; a studio where every
 * agent silently fails to launch is not.
 */
const COMMAND_LINE_BUDGET = 28_000;

function buildLaunchableArgs(store, agentId, adapter, params, outcome = {}, budget = COMMAND_LINE_BUDGET) {
  outcome.shortened = false;
  const args = adapter.args(params);
  const command = params.agent?.options?.command || adapter.command;
  const length = commandLineLength(command, args);
  if (length <= budget) return args;

  // Cut from the MIDDLE, not the tail.
  //
  // This used to keep prompt.slice(0, keep), which drops the end. The end is where
  // the human's waiting directive and this turn's instructions live, and the middle
  // is the brief — the one section that is regenerable on demand and that the note
  // below already tells the agent to re-fetch. So slicing head-first threw away the
  // only part that cannot be recovered: an agent could be launched with the human's
  // message silently absent, do a turn that ignored it, exit 0, and have its cursor
  // acknowledged. codex found this on the TASK-006 review and he is right that it
  // is the same silent-loss class we keep hunting.
  //
  // Tail-weighted on purpose: losing the start of a long human message is bad,
  // losing all of it and the turn instructions is worse.
  const overBy = length - budget;
  const keep = Math.max(2_000, params.prompt.length - overBy - 900);
  const headKeep = Math.floor(keep * 0.4);
  const tailKeep = keep - headKeep;
  const dropped = params.prompt.length - keep;
  const prompt = `${params.prompt.slice(0, headKeep)}

[${dropped} characters were cut from the MIDDLE of this prompt so the provider
command line would fit the operating system limit and your process would start at
all. Usually that is the middle of your studio brief, which is regenerable — but if
your queue was long the cut may reach into a message someone actually sent you, and
this note cannot tell you which. So do not assume anything in this prompt is
complete: run \`${STUDIO_CMD} brief\` and \`${STUDIO_CMD} inbox\` as your first
actions this turn.

Nothing here has been acknowledged. Your whole inbox will be delivered again next
turn, marked as a redelivery, precisely because we cannot prove what survived the
cut. The end of this prompt — anything the human is waiting on, and your
instructions for this turn — was preserved deliberately and is intact below.]

${params.prompt.slice(-tailKeep)}`;

  outcome.shortened = true;
  store.append('studio.note', agentId, {
    text: `turn prompt shortened from ${params.prompt.length} to ${prompt.length} characters `
      + `to stay under the ${budget}-character command line budget; `
      + `this turn's inbox will NOT be acknowledged, so anything cut comes back`,
  });
  return adapter.args({ ...params, prompt });
}

function commandLineLength(command, args) {
  // Quotes and separators add up on Windows; count generously rather than
  // discovering the real limit as a spawn failure.
  return command.length + args.reduce((n, arg) => n + String(arg).length + 3, 0);
}

function rel(p) {
  try {
    const r = path.relative(PROJECT_ROOT, path.resolve(PROJECT_ROOT, p));
    return r && !r.startsWith('..') ? r.replaceAll('\\', '/') : String(p).replaceAll('\\', '/');
  } catch {
    return String(p);
  }
}

function redact(config) {
  return { ...config };
}

function redactArgs(args) {
  return args.map((a) => (a.length > 300 ? `${a.slice(0, 300)}…[prompt truncated in transcript header]` : a));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { STATE_DIR };

// Exported so test/launch-check.mjs can assert against the real brief and
// the real argument builder rather than a copy of them that could drift.
export { renderBrief, buildLaunchableArgs, COMMAND_LINE_BUDGET, BRIEF_LIMITS };
