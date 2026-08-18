import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WEB_DIR, PORT, HOST, CONFIG_FILE } from '../core/paths.mjs';
import { AGENT_IDS, AGENT_STATES, TASK_STATES, MESSAGE_KINDS } from '../core/events.mjs';
import { AGENTS, SERVER as SERVER_CONFIG, PROJECT } from '../core/roster.mjs';
import { providers } from '../agents/adapters/index.mjs';
import {
  readRawConfig, applyConfigPatch, saveRawConfig, restartRequiredFor, normaliseConfig,
  configSchema, PERSONAS, AGENT_PROTECTED_OPTIONS, RUNNER_EDITABLE,
} from '../core/config.mjs';

/**
 * A shared secret the human's browser and the agents' CLI must present.
 *
 * Null on a loopback studio, where it would only be ceremony. Set it — via
 * `server.token` or `STUDIO_TOKEN` — before binding to anything but localhost.
 * A studio reachable from the internet without one is a stranger's shell on
 * your machine, running as you, with your credentials.
 */
const TOKEN = process.env.STUDIO_TOKEN || SERVER_CONFIG.token || null;

function authorised(req, url) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const supplied = bearer || req.headers['x-studio-token'] || url.searchParams.get('token');
  return supplied === TOKEN;
}

/**
 * Refuse a write that another website told the browser to make.
 *
 * This server answers on loopback with `Access-Control-Allow-Origin: *`, which
 * means any page the human has open in another tab can POST to it. For messages
 * that is a nuisance the provenance stamp already handles. For the config it
 * would be remote code execution: the roster decides which programs the studio
 * spawns.
 *
 * A browser always sets `Origin` on a cross-origin POST and cannot be talked out
 * of it, so an Origin that is present and foreign is the one case worth
 * rejecting outright. An absent Origin is curl, the studio CLI, or a test —
 * callers who can already run code here and gain nothing from this route.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (host === req.headers.host) return true;
  const allowed = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  try {
    if (process.env.STUDIO_URL) allowed.add(new URL(process.env.STUDIO_URL).host);
  } catch { /* malformed STUDIO_URL is not an authorisation */ }
  return allowed.has(host);
}

/** How far back a reconnecting stream will replay. Beyond this we send a gap frame. */
const STREAM_BACKFILL = Number(process.env.STUDIO_STREAM_BACKFILL || 2000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * The studio server is the single writer to the event log and the single place
 * both the agents (over the `studio` CLI) and the human (over the web UI) meet.
 */
export function createHttpServer(store, runner) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-studio-token');
    if (req.method === 'OPTIONS') return end(res, 204, '');

    // The login page and its assets are the only unauthenticated surface, so a
    // human with the token can get a browser into a state where it holds one.
    if (TOKEN && p.startsWith('/api/') && !authorised(req, url)) {
      return json(res, { ok: false, error: 'unauthorised — this studio requires a token' }, 401);
    }

    try {
      if (p === '/api/state') {
        return json(res, {
          ...store.getState(),
          // The UI must not hardcode a roster. It renders whoever is configured,
          // in configured order, whatever their ids and however many there are.
          roster: AGENTS.map((a) => ({ id: a.id, label: a.label, provider: a.provider })),
          project: { name: PROJECT.name, goal: PROJECT.goal, brief: PROJECT.brief },
        });
      }

      if (p === '/api/events') {
        return json(res, {
          events: store.getEvents({
            since: num(url.searchParams.get('since'), 0),
            agent: url.searchParams.get('agent') || null,
            raw: triState(url.searchParams.get('raw')),
            kinds: url.searchParams.get('kinds')?.split(',').filter(Boolean) || null,
            limit: num(url.searchParams.get('limit'), 300),
          }),
          seq: store.seq,
        });
      }

      if (p === '/api/stream') return stream(req, res, store, url);

      if (p === '/api/inbox') return inbox(req, res, store, url);

      if (p === '/api/runner') return json(res, runner ? runner.status() : { agents: {} });

      if (p === '/api/config' && req.method !== 'POST') return json(res, readConfigForUi());

      if (req.method === 'POST') {
        const body = await readJson(req);
        // Where did this come from?
        //
        // Every /api/human/* route appends with agent=null, describe() renders
        // that as "Human:", and the brief prints it under "the human has already
        // said this". So anything that can POST here is indistinguishable from the
        // creative director. On loopback that is not a security problem and we are
        // not each other's adversaries — but I proved it is a real one anyway by
        // probing the live server and handing codex and grok a directive the human
        // never sent. Two agents spent part of a turn reasoning about it.
        //
        // A browser fetch always carries origin or referer; node's does not. That
        // is a weak signal and it is not meant to resist anyone. It is meant to
        // stop an honest mistake from impersonating the human, which is the failure
        // that actually happened.
        if (p.startsWith('/api/human/')) body.via = req.headers.origin || req.headers.referer ? 'browser' : 'api';

        if (p === '/api/config') {
          if (!sameOrigin(req)) {
            return json(res, {
              ok: false,
              error: 'refused: this request came from another origin. The config decides which '
                + 'programs the studio launches, so it is not writable cross-site.',
            }, 403);
          }
          return json(res, writeConfigFromUi(store, runner, body));
        }
        if (p === '/api/action') return json(res, handleAction(store, body));
        // Reading is not handling. /delivered records what an agent was shown;
        // only /ack drops items out of its inbox. An agent that dies between the
        // two gets the same items back next turn, flagged as redelivered.
        if (p === '/api/inbox/delivered') {
          if (!AGENT_IDS.includes(body.agent)) {
            return json(res, { ok: false, error: `unknown agent "${body.agent}" — one of: ${AGENT_IDS.join(', ')}` }, 400);
          }
          const c = store.markDelivered(body.agent, body.through ?? store.seq, body.count || 0);
          return json(res, { ok: true, ...c });
        }
        if (p === '/api/inbox/ack') {
          if (!AGENT_IDS.includes(body.agent)) {
            return json(res, { ok: false, error: `unknown agent "${body.agent}" — one of: ${AGENT_IDS.join(', ')}` }, 400);
          }
          const c = store.ack(body.agent, body.through ?? null, body.reason || null);
          return json(res, { ok: true, ...c });
        }
        // Legacy read-is-acknowledgement path. Kept working rather than silently
        // no-opping for an older client, but it is the lossy behaviour TASK-14
        // exists to remove, so it says so on the way through.
        if (p === '/api/inbox/read') {
          if (!AGENT_IDS.includes(body.agent)) {
            return json(res, { ok: false, error: `unknown agent "${body.agent}" — one of: ${AGENT_IDS.join(', ')}` }, 400);
          }
          const c = store.markRead(body.agent, body.cursor || store.seq);
          return json(res, { ok: true, ...c, deprecated: 'use /api/inbox/delivered then /api/inbox/ack' });
        }
        if (p === '/api/human/say') {
          const ev = store.append('human.message', null, {
            from: 'human',
            to: normList(body.to),
            text: body.text || '',
            re: body.re || null,
            via: body.via,
          });
          runner?.wake(normList(body.to).length ? normList(body.to) : AGENT_IDS, 'the human said something');
          return json(res, { ok: true, seq: ev.seq });
        }
        if (p === '/api/human/control') return humanJson(res, () => humanControl(store, runner, body));
        if (p === '/api/human/verdict') return humanJson(res, () => humanVerdict(store, runner, body));
        // TASK-16: the four interventions that had no control anywhere.
        // Separate from /api/human/control so TASK-17 can harden that path
        // without inheriting these verbs, and so we never go through
        // handleAction (requireAgent rejects the human).
        if (p === '/api/human/task') return humanJson(res, () => humanCreateTask(store, runner, body));
        if (p === '/api/human/assign') return humanJson(res, () => humanAssign(store, runner, body));
        if (p === '/api/human/review') return humanJson(res, () => humanReview(store, runner, body));
        if (p === '/api/human/debate') return humanJson(res, () => humanDebate(store, runner, body));
        if (p === '/api/runner/start') {
          await runner?.start(body.agent);
          return json(res, { ok: true });
        }
        if (p === '/api/runner/stop') {
          await runner?.stop(body.agent, body.reason || 'stopped by human');
          return json(res, { ok: true });
        }
        if (p === '/api/runner/nudge') {
          runner?.wake([body.agent], body.text || 'the human nudged you');
          return json(res, { ok: true });
        }
      }

      return serveStatic(p, res);
    } catch (err) {
      return json(res, { error: String(err?.stack || err) }, 500);
    }
  });

  // HOST is loopback by default. A cloud deployment sets STUDIO_HOST=0.0.0.0,
  // and should not do that without STUDIO_TOKEN.
  server.listen(PORT, HOST);
  return server;
}

// ------------------------------------------------------------------- config

/**
 * What the settings panel is shown.
 *
 * Read from disk on every request rather than served from the roster loaded at
 * boot, so the panel shows what the file actually says — including edits made in
 * an editor while the studio was running, and including the fields the panel
 * refuses to manage. Showing the boot-time roster would quietly hide a change
 * the human had already made.
 */
function readConfigForUi() {
  let raw;
  try {
    raw = readRawConfig(CONFIG_FILE);
  } catch (e) {
    return { ok: false, error: e.message, file: CONFIG_FILE };
  }
  const resolved = normaliseConfig(raw);

  // Which of the file's agents carry fields the panel must not touch. The UI
  // marks these so nobody wonders why an agent looks different in the file.
  const protectedBy = {};
  for (const a of Array.isArray(raw.agents) ? raw.agents : []) {
    if (!a || typeof a !== 'object') continue;
    const found = AGENT_PROTECTED_OPTIONS.filter(
      (k) => a[k] !== undefined || a.options?.[k] !== undefined,
    );
    if (found.length) protectedBy[a.id] = found;
  }

  return {
    ok: true,
    file: CONFIG_FILE,
    exists: fs.existsSync(CONFIG_FILE),
    // The resolved view, so the panel shows the defaults that are actually in
    // force rather than empty boxes for everything the file left unset.
    config: {
      project: resolved.project,
      agents: resolved.agents.map((a) => ({
        id: a.id,
        provider: a.provider,
        label: a.label,
        // Send back the persona *key* when it is a built-in, so the panel can
        // select it rather than showing the expanded paragraph in a text box.
        persona: personaKeyOf(a.persona) ?? a.persona,
        model: a.options?.model || '',
        sandbox: a.options?.sandbox || '',
        permissionMode: a.options?.permissionMode || '',
        disableMcp: a.options?.disableMcp ?? null,
      })),
      runner: resolved.runner,
      server: { port: resolved.server.port, host: resolved.server.host, token: resolved.server.token ? '(set)' : null },
      adapters: Array.isArray(raw.adapters) ? raw.adapters : [],
    },
    protectedFields: protectedBy,
    providers: providers(),
    schema: configSchema(),
    // The roster this process is actually running, so the panel can say plainly
    // when the file and the running studio have diverged.
    running: AGENTS.map((a) => ({ id: a.id, provider: a.provider })),
  };
}

function personaKeyOf(text) {
  for (const [key, body] of Object.entries(PERSONAS)) {
    if (typeof text === 'string' && text.startsWith(body)) return key;
  }
  return null;
}

/**
 * Save an edit from the settings panel.
 *
 * Validates, writes the file, applies live what can genuinely be applied live,
 * and reports honestly what still needs a restart. Every accepted change is
 * appended to the event log, because a human quietly changing what the agents
 * are allowed to do is exactly the kind of thing the timeline exists to record.
 */
function writeConfigFromUi(store, runner, body) {
  let raw;
  try {
    raw = readRawConfig(CONFIG_FILE);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const { config: next, errors, warnings } = applyConfigPatch(
    raw, body || {}, { knownProviders: providers() },
  );
  if (errors.length) return { ok: false, errors };

  const before = normaliseConfig(raw);
  const restart = restartRequiredFor(raw, next);

  try {
    saveRawConfig(CONFIG_FILE, next);
  } catch (e) {
    return { ok: false, error: `could not write ${CONFIG_FILE}: ${e.message}` };
  }

  // Apply what the runner re-reads each loop. Everything else is honestly
  // reported as pending rather than pretended into effect.
  const applied = [];
  const resolved = normaliseConfig(next);
  if (runner) {
    for (const k of RUNNER_EDITABLE) {
      if (JSON.stringify(before.runner[k]) !== JSON.stringify(resolved.runner[k])) {
        runner.config[k] = resolved.runner[k];
        applied.push(`runner.${k}`);
      }
    }
    if (before.project.name !== resolved.project.name || before.project.goal !== resolved.project.goal) {
      runner.config.project = resolved.project;
      applied.push('project');
    }
  }

  store.append('human.control', null, {
    action: 'configure',
    text: describeConfigChange(before, resolved, applied, restart),
    via: 'browser',
    applied,
    restartRequired: restart,
  });

  return {
    ok: true, applied, restartRequired: restart, warnings,
    config: readConfigForUi().config,
  };
}

function describeConfigChange(before, after, applied, restart) {
  const bits = [];
  const ids = (c) => c.agents.map((a) => a.id);
  const wasIds = ids(before);
  const nowIds = ids(after);
  const added = nowIds.filter((i) => !wasIds.includes(i));
  const removed = wasIds.filter((i) => !nowIds.includes(i));
  if (added.length) bits.push(`added ${added.join(', ')}`);
  if (removed.length) bits.push(`removed ${removed.join(', ')}`);
  for (const a of after.agents) {
    const b = before.agents.find((x) => x.id === a.id);
    if (!b) continue;
    if (b.provider !== a.provider) bits.push(`${a.id} now runs on ${a.provider}`);
    if (b.persona !== a.persona) bits.push(`${a.id}'s persona changed`);
    if ((b.options?.sandbox || '') !== (a.options?.sandbox || '')) {
      bits.push(`${a.id} sandbox → ${a.options?.sandbox || 'default'}`);
    }
    if ((b.options?.permissionMode || '') !== (a.options?.permissionMode || '')) {
      bits.push(`${a.id} permissions → ${a.options?.permissionMode || 'default'}`);
    }
    if ((b.options?.model || '') !== (a.options?.model || '')) {
      bits.push(`${a.id} model → ${a.options?.model || 'provider default'}`);
    }
  }
  for (const k of RUNNER_EDITABLE) {
    if (JSON.stringify(before.runner[k]) !== JSON.stringify(after.runner[k])) {
      bits.push(`${k} ${JSON.stringify(before.runner[k])} → ${JSON.stringify(after.runner[k])}`);
    }
  }
  if (!bits.length) bits.push('saved with no effective change');
  const tail = restart.length ? ` — needs a restart (${restart.join('; ')})` : '';
  return `changed the studio configuration: ${bits.join('; ')}${tail}`;
}

// ------------------------------------------------------------------ actions

/**
 * Every verb an agent can perform against the shared state. IDs are allocated
 * here so two agents acting at the same moment can never collide on one.
 */
export function handleAction(store, body) {
  const { verb } = body;
  if (!verb) throw new Error('missing verb');
  const s = store.state;
  const agent = requireAgent(body.agent);

  switch (verb) {
    case 'register':
      return ok(store.append('agent.registered', agent, {
        strengths: normList(body.strengths),
        intro: body.intro || '',
        state: 'idle',
      }));

    case 'state':
      return ok(store.append('agent.state', agent, {
        state: requireEnum(body.state, AGENT_STATES, 'agent state'),
        task: body.task ? requireTask(s, body.task) : null,
        note: body.note || '',
      }));

    case 'say':
      return ok(store.append('message.sent', agent, {
        from: agent,
        to: requireEach(normList(body.to), RECIPIENTS, 'recipient'),
        kind: requireEnum(body.kind || 'chat', MESSAGE_KINDS, 'message kind'),
        text: body.text || '',
        re: body.re || null,
      }));

    case 'task.create': {
      const id = `TASK-${String(++s.counters.task).padStart(2, '0')}`;
      const ev = store.append('task.created', agent, {
        id,
        title: body.title || '',
        objective: body.objective || '',
        owner: body.owner ? requireAgent(body.owner, 'owner') : null,
        reviewer: body.reviewer ? requireAgent(body.reviewer, 'reviewer') : null,
        state: requireEnum(body.state || (body.owner ? 'assigned' : 'proposed'), TASK_STATES, 'task state'),
        context: body.context || '',
        deps: normList(body.deps).map((dep) => requireTask(s, dep, 'dependency')),
      });
      return { ok: true, seq: ev.seq, id };
    }

    case 'task.update': {
      requireTask(s, body.id);
      const changes = { ...(body.changes || {}) };
      for (const k of ['state', 'owner', 'reviewer', 'title', 'objective', 'context', 'result', 'blockedBy']) {
        if (body[k] !== undefined) changes[k] = body[k];
      }
      // An unknown state lands in the projection but matches no board column, so
      // the task disappears from the human's view while still existing.
      if (changes.state !== undefined) requireEnum(changes.state, TASK_STATES, 'task state');
      for (const role of ['owner', 'reviewer']) {
        if (changes[role]) requireAgent(changes[role], role);
      }
      return ok(store.append('task.updated', agent, { id: body.id, changes, note: body.note || '' }));
    }

    case 'decision': {
      const id = `DEC-${String(++s.counters.decision).padStart(2, '0')}`;
      const ev = store.append('decision.recorded', agent, {
        id,
        question: body.question || '',
        alternatives: normList(body.alternatives),
        arguments: normList(body.arguments),
        chosen: body.chosen || '',
        why: body.why || '',
        participants: requireEach(normList(body.participants), RECIPIENTS, 'participant'),
        humanRole: requireEnum(body.humanRole || 'none', HUMAN_ROLES, 'human role'),
        relatedTask: body.relatedTask ? requireTask(s, body.relatedTask) : null,
      });
      return { ok: true, seq: ev.seq, id };
    }

    case 'debate.open': {
      const id = `DEB-${String(++s.counters.debate).padStart(2, '0')}`;
      const ev = store.append('debate.opened', agent, {
        id,
        question: body.question || '',
        relatedTask: body.relatedTask ? requireTask(s, body.relatedTask) : null,
      });
      return { ok: true, seq: ev.seq, id };
    }

    // A position or a close aimed at a debate that does not exist used to return
    // ok and then vanish in the projection. Silent disappearance is the worst
    // failure this studio can have: an agent believes it argued, the record says
    // it never spoke. Fail loudly instead, and name the ids that do exist.
    case 'debate.position':
      requireOpenDebate(s, body.id);
      return ok(store.append('debate.position', agent, {
        id: body.id,
        stance: body.stance || '',
        because: body.because || '',
        critique: body.critique || '',
        round: body.round || null,
      }));

    case 'debate.close':
      requireOpenDebate(s, body.id);
      return ok(store.append('debate.closed', agent, {
        id: body.id,
        outcome: body.outcome || '',
        decisionId: body.decisionId || null,
      }));

    case 'question.open': {
      const id = `Q-${String(++s.counters.question).padStart(2, '0')}`;
      const ev = store.append('question.opened', agent, { id, text: body.text || '' });
      return { ok: true, seq: ev.seq, id };
    }

    case 'question.close':
      requireOpenQuestion(s, body.id);
      return ok(store.append('question.closed', agent, { id: body.id, answer: body.answer || '' }));

    // Returns the ATT id, not just the seq.
    //
    // codex's TASK-02 review: the id is derived from the seq during projection, so
    // the caller was left to work out ATT-<seq> or go hunting in the brief — while
    // the CLI help right underneath documents `withdraw <ATT-id>`. Every other
    // creating verb here already returns its id; this one was the exception because
    // nothing had needed it until withdrawal existed.
    case 'attention': {
      const ev = store.append('attention.raised', agent, {
        kind: requireEnum(body.kind || 'decision', ATTENTION_KINDS, 'attention kind'),
        text: body.text || '',
        options: normList(body.options),
        ref: body.ref ? requireRef(s, body.ref) : null,
      });
      return { ok: true, seq: ev.seq, id: `ATT-${ev.seq}` };
    }

    // Taking back an ask that went stale.
    //
    // the project brief tells us not to overwhelm the human, and until now the queue
    // could only grow from our side: agents raise attention and only the human
    // clears it, so a superseded ask sat there forever. Three guards make this
    // safe to hand to an agent:
    //   - you may only withdraw what YOU raised, so nobody can silence a
    //     colleague's escalation or the one thing the human was about to act on
    //   - a reason is required, because "this no longer needs you" is a claim
    //   - the status becomes 'withdrawn', never 'cleared', and the event stays in
    //     the timeline, so the human can see we did it and disagree
    case 'attention.withdraw': {
      const id = String(body.id || '').trim();
      const item = s.attention.find((x) => x.id === id);
      if (!item) {
        const open = s.attention.filter((x) => x.status === 'open').map((x) => x.id);
        throw new Error(
          `no such attention ${show(id)}${open.length ? ` — open attention is ${open.join(', ')}` : ' — nothing is open'}`,
        );
      }
      if (item.status !== 'open') {
        throw new Error(`attention ${id} is already ${item.status} — nothing to withdraw`);
      }
      if (item.by !== agent) {
        throw new Error(
          `${id} was raised by ${item.by || 'the studio'}, not by ${agent} — ask them to withdraw it, or leave it for the human`,
        );
      }
      const reason = String(body.reason || '').trim();
      if (!reason) {
        throw new Error('withdrawing needs a reason — say why the human no longer needs to act');
      }
      return ok(store.append('attention.withdrawn', agent, { id, reason }));
    }

    case 'files':
      return ok(store.append('work.files', agent, {
        action: requireEnum(body.action || 'changed', FILE_ACTIONS, 'file action'),
        files: normList(body.files),
        task: body.task ? requireTask(s, body.task) : null,
      }));

    case 'validation':
      return ok(store.append('work.validation', agent, {
        name: body.name || 'validation',
        command: body.command || '',
        ok: !!body.ok,
        output: (body.output || '').slice(0, 8000),
        task: body.task ? requireTask(s, body.task) : null,
      }));

    case 'discovery':
      return ok(store.append('work.discovery', agent, { text: body.text || '', ref: body.ref || null }));

    case 'note':
      return ok(store.append('studio.note', agent, { text: body.text || '' }));

    default:
      throw new Error(`unknown verb ${verb}`);
  }
}

function ok(ev) {
  return { ok: true, seq: ev.seq };
}

// -------------------------------------------------------------- validation

/**
 * Every id and enum a caller supplies is checked here, at the door.
 *
 * The projection is written defensively — `const t = s.tasks[d.id]; if (!t)
 * break;` — so an action naming something that does not exist used to be
 * accepted, appended, and then dropped on the floor. The agent is told ok and
 * its work leaves no trace. That is the one failure this studio cannot have:
 * an event that exists on disk but appears in no view means the human is
 * looking at a record that is quietly incomplete.
 *
 * So these throw, and every message names what would have worked. An agent
 * that fat-fingers a flag mid-turn should be able to fix it from the error.
 */
const RECIPIENTS = [...AGENT_IDS, 'human'];
const ATTENTION_KINDS = ['decision', 'blocked', 'conflict', 'review'];
const FILE_ACTIONS = ['changed', 'added', 'deleted'];
const HUMAN_ROLES = ['none', 'made', 'override', 'approved'];
const HUMAN_CONTROL_ACTIONS = ['pause', 'resume', 'stop', 'nudge', 'priority'];
const HUMAN_VERDICTS = ['approve', 'reject', 'reply'];

async function humanJson(res, fn) {
  try {
    return json(res, await fn());
  } catch (err) {
    return json(res, { error: err.message || String(err) }, 400);
  }
}

async function humanControl(store, runner, body) {
  // The projection and runner only understand this finite set. Accepting an
  // arbitrary verb records a control that does nothing while telling the human
  // it worked. Assignment/review/debate have their own validated routes below.
  const action = requireEnum(body.action, HUMAN_CONTROL_ACTIONS, 'human control action');
  const target = body.target ? requireAgent(body.target, 'control target') : null;
  const text = String(body.text || '').trim();

  if (action === 'priority' && target) {
    throw new Error('priority is studio-wide — omit control target and say the priority in text');
  }
  if (action === 'priority' && !text) {
    throw new Error('priority needs text — say what the team should prioritize');
  }

  const control = { action, target, text, via: body.via };
  const ev = store.append('human.control', null, control);
  try {
    await runner?.onControl(control);
    return { ok: true, seq: ev.seq };
  } catch (err) {
    // The human's valid intent is already durable and projected. A runner
    // failure after that commit cannot truthfully turn the response into a
    // refusal: doing so tells the human nothing changed when pause/stop state
    // may already be visible. Report delivery as degraded, while preserving
    // the successful control write and its sequence.
    const reason = err?.message || String(err);
    const warning = controlDeliveryWarning(control, reason);
    try {
      store.append('human.control.delivery-failed', null, {
        controlSeq: ev.seq,
        action: control.action,
        target: control.target,
        reason,
        warning,
        via: control.via,
      });
    } catch (recordErr) {
      // The control itself is already committed. Even failure to append the
      // follow-up annotation cannot truthfully turn that committed write into a
      // refusal; keep the response successful and disclose both degradations.
      return {
        ok: true,
        seq: ev.seq,
        warning: `${warning}; the delivery failure could not be added to the event log: ${recordErr?.message || String(recordErr)}`,
      };
    }
    return { ok: true, seq: ev.seq, warning };
  }
}

function controlDeliveryWarning(control, reason) {
  const target = control.target || 'agents';
  switch (control.action) {
    case 'stop':
      return `stop was recorded, but ${target === 'agents' ? 'agents' : target} may still be running: ${reason}`;
    case 'pause':
      return `pause was recorded, but agents may still be running: ${reason}`;
    case 'resume':
      return `resume was recorded, but ${target === 'agents' ? 'agents may still be paused' : `${target} may still be paused`}: ${reason}`;
    case 'nudge':
      return `nudge was recorded, but ${target === 'agents' ? 'agents may not have been woken' : `${target} may not have been woken`}: ${reason}`;
    case 'priority':
      return `priority was recorded, but agents may not have been woken to see it: ${reason}`;
    default:
      return `control was recorded, but runner delivery failed: ${reason}`;
  }
}

function humanVerdict(store, runner, body) {
  const verdict = requireEnum(body.verdict, HUMAN_VERDICTS, 'human verdict');
  const target = requireVerdictTarget(store.state, body.target, verdict);
  const text = String(body.text || '').trim();
  if (verdict === 'reply' && !text) {
    throw new Error('reply needs text — say what the team should know');
  }
  const ev = store.append('human.verdict', null, {
    target,
    verdict,
    text,
    via: body.via,
  });
  runner?.wake(AGENT_IDS, 'the human answered a request for input');
  return { ok: true, seq: ev.seq };
}

function humanCreateTask(store, runner, body) {
  const s = store.state;
  const title = String(body.title || '').trim();
  if (!title) throw new Error('a task needs a title');
  const owner = body.owner ? requireAgent(body.owner, 'owner') : null;
  const reviewer = body.reviewer ? requireAgent(body.reviewer, 'reviewer') : null;
  const id = `TASK-${String(++s.counters.task).padStart(2, '0')}`;
  store.append('human.control', null, {
    action: owner ? 'assign' : 'task',
    target: owner,
    text: body.text || title,
    task: id,
  });
  const ev = store.append('task.created', null, {
    id,
    title,
    objective: body.objective || '',
    owner,
    reviewer,
    state: owner ? 'assigned' : 'proposed',
    context: body.context || 'created by the human',
    deps: [],
  });
  if (owner) runner?.wake([owner], `the human assigned ${id} to you`);
  else runner?.wake(AGENT_IDS, `the human created ${id}`);
  return { ok: true, seq: ev.seq, id };
}

function humanAssign(store, runner, body) {
  const s = store.state;
  const taskId = requireTask(s, body.task || body.id);
  const owner = requireAgent(body.owner, 'owner');
  const t = s.tasks[taskId];
  const action = t.owner && t.owner !== owner ? 'reassign' : 'assign';
  // Sibling of `changes`, never inside it: #project Object.assigns changes
  // onto the task, and previousOwner is an event fact, not a task field.
  const previousOwner = action === 'reassign' ? t.owner : null;
  store.append('human.control', null, {
    action,
    target: owner,
    text: body.text || `${action} ${taskId} to ${owner}`,
    task: taskId,
    previousOwner,
  });
  const changes = { owner };
  if (!t.owner || t.state === 'proposed' || t.state === 'ready') changes.state = 'assigned';
  const ev = store.append('task.updated', null, {
    id: taskId,
    changes,
    previousOwner,
    note: body.text || `human ${action}ed to ${owner}`,
  });
  runner?.wake([owner], `the human ${action}ed ${taskId} to you`);
  if (t.owner && t.owner !== owner) runner?.wake([t.owner], `the human moved ${taskId} off you`);
  return { ok: true, seq: ev.seq, id: taskId, action };
}

function humanReview(store, runner, body) {
  const s = store.state;
  const taskId = requireTask(s, body.task || body.id);
  const reviewer = requireAgent(body.reviewer, 'reviewer');
  const t = s.tasks[taskId];
  store.append('human.control', null, {
    action: 'review',
    target: reviewer,
    text: body.text || `request review of ${taskId} by ${reviewer}`,
    task: taskId,
  });
  const ev = store.append('task.updated', null, {
    id: taskId,
    changes: { state: 'under-review', reviewer },
    note: body.text || `human requested review by ${reviewer}`,
  });
  runner?.wake([reviewer], `the human asked you to review ${taskId}`);
  if (t.owner && t.owner !== reviewer) runner?.wake([t.owner], `the human sent ${taskId} to review`);
  return { ok: true, seq: ev.seq, id: taskId };
}

function humanDebate(store, runner, body) {
  const s = store.state;
  const question = String(body.question || body.text || '').trim();
  if (!question) throw new Error('a debate needs a question — say what the team should settle');
  const relatedTask = body.relatedTask || body.task || null;
  if (relatedTask) requireTask(s, relatedTask);
  const id = `DEB-${String(++s.counters.debate).padStart(2, '0')}`;
  store.append('human.control', null, {
    action: 'debate',
    target: null,
    text: question,
    debate: id,
    relatedTask,
  });
  const ev = store.append('debate.opened', null, {
    id,
    question,
    relatedTask,
  });
  runner?.wake(AGENT_IDS, `the human requested a debate: ${question}`);
  return { ok: true, seq: ev.seq, id };
}

function requireAgent(id, label = 'agent') {
  if (AGENT_IDS.includes(id)) return id;
  throw new Error(
    `unknown ${label} ${show(id)} — this studio is ${AGENT_IDS.join(', ')}` +
    (label === 'agent' ? '. Set STUDIO_AGENT or pass --agent.' : '.'),
  );
}

function requireEnum(value, allowed, label) {
  if (allowed.includes(value)) return value;
  throw new Error(`invalid ${label} ${show(value)} — expected one of ${allowed.join(', ')}`);
}

function requireEach(values, allowed, label) {
  for (const v of values) {
    if (!allowed.includes(v)) {
      throw new Error(`unknown ${label} ${show(v)} — expected one of ${allowed.join(', ')}`);
    }
  }
  return values;
}

function requireTask(s, id, label = 'task') {
  if (s.tasks[id]) return id;
  const known = Object.keys(s.tasks);
  throw new Error(
    `no such ${label} ${show(id)}${known.length ? ` — known tasks are ${known.join(', ')}` : ' — no tasks exist yet'}`,
  );
}

/**
 * A verdict must land on state the human can still act on. In particular, an
 * attention id from a stale browser tab must not become a durable event that
 * projects nowhere. Direct task/decision verdicts are supported as well because
 * The protocol gives the human authority to approve or reject project decisions.
 */
function requireVerdictTarget(s, rawTarget, verdict) {
  const target = String(rawTarget || '').trim();
  if (!target) {
    throw new Error('a human verdict needs a target — use an open ATT id, an under-review TASK id, or a DEC id');
  }

  if (/^ATT-/i.test(target)) {
    const item = s.attention.find((x) => x.id === target);
    if (!item) {
      const open = s.attention.filter((x) => x.status === 'open').map((x) => x.id);
      throw new Error(`no such attention ${show(target)}${open.length ? ` — open attention is ${open.join(', ')}` : ' — no attention is open'}`);
    }
    if (item.status !== 'open') {
      throw new Error(`attention ${target} is already ${item.status}${item.resolution ? `: ${show(item.resolution)}` : ''}`);
    }
    return target;
  }

  if (/^TASK-/i.test(target)) {
    const id = requireTask(s, target);
    if (verdict === 'reply') {
      throw new Error('reply is only valid for an open attention item — approve or reject a task');
    }
    if (s.tasks[id].state !== 'under-review') {
      throw new Error(`task ${id} is ${s.tasks[id].state}, not under-review — request review before giving a verdict`);
    }
    return id;
  }

  if (/^DEC-/i.test(target)) {
    if (!s.decisions.some((d) => d.id === target)) {
      const known = s.decisions.map((d) => d.id);
      throw new Error(`no such decision ${show(target)}${known.length ? ` — known decisions are ${known.join(', ')}` : ' — no decisions exist yet'}`);
    }
    if (verdict === 'reply') {
      throw new Error('reply is only valid for an open attention item — approve or reject a decision');
    }
    return target;
  }

  throw new Error(
    `no verdict target ${show(target)} — use an open ATT id, an under-review TASK id, or a DEC id`,
  );
}

function requireOpenQuestion(s, id) {
  const q = s.questions.find((x) => x.id === id);
  if (q?.status === 'open') return q;
  if (q) throw new Error(`question ${id} is already answered: ${show(q.answer || '')}`);
  const open = s.questions.filter((x) => x.status === 'open').map((x) => x.id);
  throw new Error(
    `no such question ${show(id)}${open.length ? ` — open questions are ${open.join(', ')}` : ' — no questions are open'}`,
  );
}

/** An attention ref points the human at something. A dangling one points nowhere. */
function requireRef(s, ref) {
  if (/^TASK-/i.test(ref)) return requireTask(s, ref);
  if (/^DEB-/i.test(ref)) {
    if (s.debates[ref]) return ref;
    throw new Error(`no such debate ${show(ref)} — known debates are ${Object.keys(s.debates).join(', ') || 'none'}`);
  }
  if (/^DEC-/i.test(ref)) {
    if (s.decisions.some((d) => d.id === ref)) return ref;
    throw new Error(`no such decision ${show(ref)} — known decisions are ${s.decisions.map((d) => d.id).join(', ') || 'none'}`);
  }
  return ref; // free-form refs (a file, a URL) are the caller's business
}

function show(v) {
  return JSON.stringify(v ?? null);
}

function requireOpenDebate(s, id) {
  if (s.debates[id]?.status === 'open') return;
  const known = Object.keys(s.debates);
  if (s.debates[id]) throw new Error(`debate ${id} is already ${s.debates[id].status}`);
  throw new Error(
    `no such debate ${id}${known.length ? ` — open debates are ${known.join(', ')}` : ' — no debates exist yet'}`,
  );
}

// ------------------------------------------------------------------ streams

function stream(req, res, store, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Send bytes immediately. Without this, browsers can leave EventSource in
  // CONNECTING until the first real event or 20-second heartbeat arrives.
  res.flushHeaders?.();
  res.write(': connected\n\n');
  const since = num(url.searchParams.get('since'), store.seq);
  // Subscribe before reading the backfill. Any event appended during the
  // synchronous replay is buffered and deduplicated by sequence afterwards,
  // closing the replay/listener race.
  let buffering = true;
  const pending = [];
  const onEvent = (ev) => {
    if (buffering) pending.push(ev);
    else send(res, ev);
  };
  store.on('event', onEvent);
  const backfill = store.getEvents({ since, limit: STREAM_BACKFILL });
  // getEvents returns the NEWEST events after `since`. If the client fell
  // further behind than we can replay -- or if #trim() has evicted old raw
  // events from memory -- the gap is real and must be announced, or the raw
  // feed silently develops a hole the human has no way to notice.
  const oldest = backfill.length ? backfill[0].seq : since + 1;
  if (oldest > since + 1) {
    res.write(`event: gap\ndata: ${JSON.stringify({ from: since + 1, to: oldest - 1 })}\n\n`);
  }
  let sentThrough = since;
  for (const ev of backfill) {
    send(res, ev);
    sentThrough = Math.max(sentThrough, ev.seq);
  }
  while (pending.length) {
    for (const ev of pending.splice(0).sort((a, b) => a.seq - b.seq)) {
      if (ev.seq <= sentThrough) continue;
      send(res, ev);
      sentThrough = ev.seq;
    }
  }
  buffering = false;

  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    store.off('event', onEvent);
  });
}

function send(res, ev) {
  res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
}

/** Long-poll: agents block here between turns so they react promptly. */
function inbox(req, res, store, url) {
  const agent = url.searchParams.get('agent');
  const since = url.searchParams.get('since') ? num(url.searchParams.get('since'), 0) : null;
  const waitMs = num(url.searchParams.get('wait'), 0);
  // Recording "shown" belongs HERE and not inside store.inbox(), because the
  // long-poll below calls store.inbox() repeatedly just to ask whether there is
  // anything worth sending. Recording on those probes would mark messages as
  // handed to an agent that never received them — which is the exact loss this
  // cursor exists to prevent, reintroduced by the fix for it.
  const send = (payload) => {
    if (AGENT_IDS.includes(agent)) store.markShown(agent, payload.cursor);
    return json(res, payload);
  };

  const first = store.inbox(agent, since, { record: false });
  if (first.items.length || waitMs <= 0) return send(first);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    store.off('event', onEvent);
    send(store.inbox(agent, since, { record: false }));
  };
  const onEvent = () => {
    if (store.inbox(agent, since, { record: false }).items.length) finish();
  };
  const timer = setTimeout(finish, Math.min(waitMs, 120_000));
  store.on('event', onEvent);
  req.on('close', () => {
    done = true;
    clearTimeout(timer);
    store.off('event', onEvent);
  });
}

// ------------------------------------------------------------------- static

function serveStatic(p, res) {
  const rel = p === '/' ? 'index.html' : p.replace(/^\//, '');
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return end(res, 404, 'not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// -------------------------------------------------------------------- utils

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function end(res, code, body) {
  res.writeHead(code);
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 8e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function triState(v) {
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

function normList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}
