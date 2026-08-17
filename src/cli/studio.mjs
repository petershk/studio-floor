#!/usr/bin/env node
/**
 * `studio` — the command line the agents use to be part of the team.
 *
 * Every agent has shell access to the shared project directory, so this is the
 * one channel all three of them can speak through regardless of which vendor's
 * CLI they are. Everything an agent does here becomes an event the human can
 * see in the browser.
 *
 * The agent identity comes from $STUDIO_AGENT (set by the runner) or --agent.
 */
import { BASE_URL } from '../core/paths.mjs';
import { AGENT_IDS } from '../core/events.mjs';

/** Set on a studio that requires one; the runner passes it to every agent. */
const TOKEN = process.env.STUDIO_TOKEN || '';
const AUTH = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};


const argv = process.argv.slice(2);
const cmd = argv.shift();
const { flags, positional } = parseArgs(argv);
// This used to fall back to 'unknown', which the server accepted: an agent with
// a misconfigured environment would talk to itself as a phantom fourth member
// and nobody would be told. Fail here, before anything is written.
const AGENT = flags.agent || process.env.STUDIO_AGENT || '';

const HELP = `studio — team channel for the multi-agent studio

  studio brief                          everything you need to know right now
  studio inbox [--wait 90] [--ack]      what has been said to you since you last looked
  studio ack [--through SEQ]            confirm you have handled your inbox; until you do it comes back
  studio join --strengths a,b --intro "..."
  studio state <state> [--task ID] [--note "..."]
        states: thinking working reviewing waiting blocked requesting-input idle

  studio say "text" [--to claude,grok] [--kind chat|announce|question|answer|proposal|challenge|delegation|review|concern|concede] [--re ID]
  studio ask "open question text"
  studio answer <Q-id> "answer"

  studio tasks [--state active] [--owner claude]
  studio task show <TASK-id>
  studio task new --title "..." --objective "..." [--owner x] [--reviewer y] [--context "..."] [--deps TASK-01]
  studio task set <TASK-id> [--state x] [--owner y] [--reviewer z] [--result "..."] [--note "..."]
        task states: proposed ready assigned active blocked under-review completed rejected

  studio debate open --question "..." [--task TASK-01]
  studio debate say <DEB-id> --stance "..." --because "..." [--critique "..."]
  studio debate close <DEB-id> --outcome "..." [--decision DEC-01]

  studio decide --question "..." --chosen "..." --why "..." [--alternatives "a|b"] [--arguments "..."] [--participants codex,claude] [--task TASK-01]

  studio attention --kind decision|blocked|conflict|review --text "..." [--options "a|b"] [--ref TASK-01]
  studio withdraw <ATT-id> --reason "..."   take back an attention item you raised that went stale
  studio files --action changed|added|deleted --files a.js,b.js [--task TASK-01]
  studio validate --name "tests" --command "npm test" --ok|--fail [--output "..."] [--task TASK-01]
  studio discover "something the team should know"

  studio log [--limit 40] [--raw]       recent studio history
`;

main().catch((err) => {
  console.error(`studio: ${err.message}`);
  process.exit(1);
});

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return void console.log(HELP);

  switch (cmd) {
    case 'brief':
      return void console.log(await brief());

    case 'inbox': {
      const wait = Number(flags.wait || 0) * 1000;
      const r = await get(`/api/inbox?agent=${AGENT}&wait=${wait}`);
      if (!r.items.length) return void console.log('(nothing new)');
      if (r.redelivered) {
        console.log(
          `↻ ${r.redelivered} of these were already shown to you and never confirmed —\n` +
          `  your previous turn ended without acknowledging them. They are back rather than lost.`,
        );
      }
      for (const it of r.items) {
        console.log(`${it.redelivered ? '↻' : ' '}[${it.seq}] ${short(it.ts)} ${it.line}`);
      }
      // Reading is not handling. This records only that you were shown them; the
      // runner acknowledges when the turn actually completes. Pass --ack if you
      // are done with them right now.
      await post('/api/inbox/delivered', { agent: AGENT, through: r.cursor, count: r.items.length });
      if (flags.ack) {
        await post('/api/inbox/ack', { agent: AGENT, through: r.cursor, reason: 'studio inbox --ack' });
      } else {
        console.log(`  (not yet acknowledged — 'studio ack' when you have handled them, or they come back)`);
      }
      return;
    }

    case 'ack': {
      const through = flags.through ? Number(flags.through) : null;
      const r = await post('/api/inbox/ack', { agent: AGENT, through, reason: flags.reason || 'agent finished handling' });
      if (r.clamped) {
        console.error(`studio: cannot acknowledge past seq ${r.delivered} — that is the newest thing you were actually shown.`);
        process.exit(1);
      }
      return void console.log(`acknowledged through seq ${r.acked}`);
    }

    case 'join':
      return void report(await act('register', {
        strengths: flags.strengths,
        intro: flags.intro || positional.join(' '),
      }));

    case 'state':
      return void report(await act('state', {
        state: positional[0] || flags.state,
        task: flags.task ?? null,
        note: flags.note,
      }));

    case 'say':
      return void report(await act('say', {
        text: positional.join(' ') || flags.text,
        to: flags.to,
        kind: flags.kind,
        re: flags.re,
      }));

    case 'ask':
      return void report(await act('question.open', { text: positional.join(' ') || flags.text }));

    case 'answer':
      return void report(await act('question.close', { id: positional[0], answer: positional.slice(1).join(' ') }));

    case 'tasks':
      return void console.log(await tasks(flags));

    case 'task':
      return void (await taskCmd());

    case 'debate':
      return void (await debateCmd());

    case 'decide':
      return void report(await act('decision', {
        question: flags.question,
        chosen: flags.chosen,
        why: flags.why,
        alternatives: splitPipe(flags.alternatives),
        arguments: splitPipe(flags.arguments),
        participants: flags.participants,
        humanRole: flags['human-role'],
        relatedTask: flags.task,
      }));

    case 'attention':
      return void report(await act('attention', {
        kind: flags.kind,
        text: flags.text || positional.join(' '),
        options: splitPipe(flags.options),
        ref: flags.ref,
      }));

    // Only your own, only while open, and only with a reason. The queue is the
    // human's, not ours; this is for taking back an ask that went stale, not for
    // tidying their inbox on their behalf.
    case 'withdraw':
      return void report(await act('attention.withdraw', {
        id: flags.id || positional[0],
        reason: flags.reason || positional.slice(1).join(' '),
      }));

    case 'files':
      return void report(await act('files', { action: flags.action, files: flags.files, task: flags.task }));

    case 'validate':
      return void report(await act('validation', {
        name: flags.name,
        command: flags.command,
        ok: flags.ok === true || flags.ok === 'true' ? true : flags.fail ? false : !!flags.ok,
        output: flags.output,
        task: flags.task,
      }));

    case 'discover':
      return void report(await act('discovery', { text: positional.join(' ') || flags.text, ref: flags.ref }));

    case 'log': {
      const r = await get(`/api/events?limit=${flags.limit || 40}&raw=${flags.raw ? 'true' : 'false'}`);
      for (const ev of r.events) console.log(`[${ev.seq}] ${short(ev.ts)} ${ev.agent || '-'} ${ev.kind}`);
      return;
    }

    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

async function taskCmd() {
  const sub = positional.shift();
  if (sub === 'new') {
    return report(await act('task.create', {
      title: flags.title,
      objective: flags.objective,
      owner: flags.owner,
      reviewer: flags.reviewer,
      context: flags.context,
      deps: flags.deps,
      state: flags.state,
    }));
  }
  if (sub === 'set') {
    const id = positional.shift();
    return report(await act('task.update', {
      id,
      state: flags.state,
      owner: flags.owner,
      reviewer: flags.reviewer,
      result: flags.result,
      blockedBy: flags['blocked-by'],
      note: flags.note,
    }));
  }
  if (sub === 'show') {
    const st = await get('/api/state');
    const t = st.tasks[positional[0]];
    if (!t) throw new Error(`no such task ${positional[0]}`);
    return console.log(renderTask(t, true));
  }
  throw new Error('usage: studio task new|set|show');
}

async function debateCmd() {
  const sub = positional.shift();
  if (sub === 'open') {
    return report(await act('debate.open', { question: flags.question || positional.join(' '), relatedTask: flags.task }));
  }
  if (sub === 'say' || sub === 'position') {
    return report(await act('debate.position', {
      id: positional.shift(),
      stance: flags.stance,
      because: flags.because,
      critique: flags.critique,
      round: flags.round,
    }));
  }
  if (sub === 'close') {
    return report(await act('debate.close', {
      id: positional.shift(),
      outcome: flags.outcome,
      decisionId: flags.decision,
    }));
  }
  throw new Error('usage: studio debate open|say|close');
}

// ------------------------------------------------------------------- briefing

/**
 * One call that tells an agent where the project stands. Agents are told to run
 * this before starting significant work so they do not duplicate or overwrite
 * each other.
 */
async function brief() {
  const s = await get('/api/state');
  const L = [];
  L.push(`STUDIO BRIEF — ${short(s.now)}   (you are: ${AGENT})`);
  if (s.paused) L.push('!! THE HUMAN HAS PAUSED ALL WORK — do not start new work, acknowledge and wait.');
  if (s.priority) L.push(`!! Human priority: ${s.priority}`);

  L.push('\nAGENTS');
  for (const a of Object.values(s.agents)) {
    const mark = a.id === AGENT ? '*' : ' ';
    L.push(`${mark} ${pad(a.id, 7)} ${pad(a.state, 17)} ${a.currentTask ? `on ${a.currentTask}` : ''} ${a.paused ? '[paused]' : ''} ${a.strengths?.length ? `— ${a.strengths.join(', ')}` : ''}`);
  }

  const open = Object.values(s.tasks).filter((t) => !['completed', 'rejected'].includes(t.state));
  L.push(`\nTASKS (${open.length} open, ${Object.keys(s.tasks).length} total)`);
  for (const t of open) L.push(`  ${renderTask(t)}`);
  const done = Object.values(s.tasks).filter((t) => t.state === 'completed').slice(-6);
  if (done.length) {
    L.push('  recently completed:');
    for (const t of done) L.push(`    ${t.id} ${t.title}`);
  }

  if (s.decisions.length) {
    L.push('\nDECISIONS ALREADY MADE (do not reopen without new information)');
    for (const d of s.decisions.slice(-10)) L.push(`  ${d.id} ${d.question}\n      → ${d.chosen}  (${d.why})`);
  }

  const openDebates = Object.values(s.debates).filter((d) => d.status === 'open');
  if (openDebates.length) {
    L.push('\nOPEN DEBATES');
    for (const d of openDebates) {
      L.push(`  ${d.id} ${d.question}`);
      for (const p of d.positions) L.push(`      ${p.agent}: ${p.stance}${p.because ? ` — because ${p.because}` : ''}`);
      if (!d.positions.some((p) => p.agent === AGENT)) L.push('      ^ you have not stated a position yet');
    }
  }

  const openQ = s.questions.filter((q) => q.status === 'open');
  if (openQ.length) {
    L.push('\nUNRESOLVED QUESTIONS');
    for (const q of openQ) L.push(`  ${q.id} (${q.by}) ${q.text}`);
  }

  const att = s.attention.filter((a) => a.status === 'open');
  if (att.length) {
    L.push('\nWAITING ON THE HUMAN');
    for (const a of att) L.push(`  ${a.id} [${a.kind}] ${a.text}`);
  }

  if (s.discoveries.length) {
    L.push('\nDISCOVERIES');
    for (const d of s.discoveries.slice(-8)) L.push(`  (${d.by}) ${d.text}`);
  }

  L.push('\nRECENT CONVERSATION');
  for (const m of s.messages.slice(-25)) {
    L.push(`  ${short(m.ts)} ${m.from}${m.to?.length ? `→${m.to.join(',')}` : ''} [${m.kind}] ${m.text}`);
  }

  if (s.health) L.push(`\nPROJECT HEALTH: ${s.health.name} ${s.health.ok ? 'passing' : 'FAILING'} (${short(s.health.ts)}, ${s.health.by})`);
  if (s.files.length) {
    L.push('\nRECENT FILE ACTIVITY');
    for (const f of s.files.slice(-8)) L.push(`  ${short(f.ts)} ${f.by} ${f.action} ${f.files.join(', ')}`);
  }

  return L.join('\n');
}

async function tasks(f) {
  const s = await get('/api/state');
  let list = Object.values(s.tasks);
  if (f.state) list = list.filter((t) => t.state === f.state);
  if (f.owner) list = list.filter((t) => t.owner === f.owner);
  if (f.mine) list = list.filter((t) => t.owner === AGENT);
  return list.length ? list.map((t) => renderTask(t)).join('\n') : '(no tasks match)';
}

function renderTask(t, full = false) {
  const head = `${t.id} [${t.state}] ${t.title} — owner:${t.owner || 'unassigned'}${t.reviewer ? ` reviewer:${t.reviewer}` : ''}${t.deps?.length ? ` deps:${t.deps.join(',')}` : ''}`;
  if (!full) return head;
  const L = [head, `  objective: ${t.objective}`];
  if (t.context) L.push(`  context: ${t.context}`);
  if (t.result) L.push(`  result: ${t.result}`);
  L.push('  history:');
  for (const h of t.history) L.push(`    ${short(h.ts)} ${h.by} ${h.change}${h.note ? ` — ${h.note}` : ''}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------- http

async function act(verb, body) {
  if (!AGENT_IDS.includes(AGENT)) {
    throw new Error(
      `I do not know who you are${AGENT ? `: ${AGENT}` : ''}. ` +
      `Set STUDIO_AGENT to one of ${AGENT_IDS.join(', ')}, or pass --agent.`,
    );
  }
  return post('/api/action', { verb, agent: AGENT, ...body });
}

async function get(p) {
  const r = await fetch(BASE_URL + p, { headers: AUTH });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function post(p, body) {
  const r = await fetch(BASE_URL + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

function report(r) {
  if (r?.error) throw new Error(r.error);
  console.log(r?.id ? `ok ${r.id}` : 'ok');
}

// --------------------------------------------------------------------- utils

function parseArgs(list) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (list[i + 1] && !list[i + 1].startsWith('--')) {
        flags[a.slice(2)] = list[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function splitPipe(v) {
  if (!v || v === true) return [];
  return String(v).split('|').map((x) => x.trim()).filter(Boolean);
}

function short(ts) {
  return ts ? new Date(ts).toTimeString().slice(0, 8) : '--:--:--';
}

function pad(s, n) {
  return String(s || '').padEnd(n);
}
