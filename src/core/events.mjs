/**
 * The event vocabulary of the studio.
 *
 * Everything that happens in the studio is an event appended to a single
 * append-only log. All views (agents, tasks, decisions, timeline, raw feed)
 * are projections of that log. Nothing is stored anywhere else, so nothing
 * can be shown to the human that did not actually happen.
 */

// Re-exported from the roster so the historic import site keeps working while
// the list itself comes from studio.config.json. Nothing in the studio may
// assume this is three entries, or that an id names a provider.
export { AGENT_IDS, AGENTS, getAgent, isAgent } from './roster.mjs';

export const AGENT_STATES = [
  'offline',
  'starting',
  'thinking',
  'working',
  'reviewing',
  'waiting',
  'blocked',
  'requesting-input',
  'idle',
  'paused',
  'error',
];

export const TASK_STATES = [
  'proposed',
  'ready',
  'assigned',
  'active',
  'blocked',
  'under-review',
  'completed',
  'rejected',
];

export const MESSAGE_KINDS = [
  'chat',
  'announce',
  'question',
  'answer',
  'proposal',
  'challenge',
  'delegation',
  'review',
  'position',
  'concern',
  'concede',
];

/**
 * Event kinds.
 *
 * `studio.*`   lifecycle of the studio itself
 * `agent.*`    identity, presence and self-reported state
 * `message.*`  observable agent-to-agent and human communication
 * `task.*`     explicit units of work
 * `decision.*` durable project knowledge
 * `debate.*`   structured disagreement
 * `attention.*`things that genuinely want the human
 * `work.*`     files touched, validation runs
 * `human.*`    the human's interventions
 * `inbox.*`    delivery bookkeeping: what an agent was shown, what it confirmed
 * `raw.*`      the lowest-level observable activity an agent interface exposes
 */
export const EVENT_KINDS = [
  'studio.started',
  'studio.note',
  'log.recovered',

  'agent.registered',
  'agent.state',
  'agent.stopped',

  'message.sent',

  'task.created',
  'task.updated',

  'decision.recorded',

  'debate.opened',
  'debate.position',
  'debate.closed',

  'question.opened',
  'question.closed',

  'attention.raised',
  'attention.cleared',
  'attention.withdrawn',

  'work.files',
  'work.validation',
  'work.discovery',

  'human.message',
  'human.control',
  'human.control.delivery-failed',
  'human.verdict',

  'inbox.delivered',
  'inbox.acked',

  'raw.turn.start',
  'raw.turn.end',
  'raw.text',
  'raw.reasoning',
  'raw.tool.call',
  'raw.tool.result',
  'raw.usage',
  'raw.error',
  'raw.native',
];

/** Raw events are high volume; they are streamed and stored but kept out of the timeline. */
export function isRaw(kind) {
  return kind.startsWith('raw.');
}

/**
 * Bookkeeping the studio writes about itself. It is durable — inbox cursors are
 * reconstructed from these on restart rather than from a best-effort side file —
 * but it is machinery, not something that happened in the project, so it stays
 * out of the timeline and out of every agent's inbox.
 */
export function isBookkeeping(kind) {
  return kind.startsWith('inbox.');
}

/**
 * Events that belong in the human-facing chronological history.
 * Deliberately narrow — the timeline is for understanding, not for volume.
 */
export function isTimeline(kind) {
  return (
    !isRaw(kind) &&
    !isBookkeeping(kind) &&
    kind !== 'agent.state' &&
    kind !== 'studio.note' &&
    kind !== 'attention.cleared'
  );
}

/** One-line human-readable rendering of an event, used by the timeline and the CLI. */
export function describe(ev) {
  const d = ev.data || {};
  const who = ev.agent || d.from || d.by || 'studio';
  switch (ev.kind) {
    case 'studio.started':
      return 'Studio started';
    case 'log.recovered':
      if (d.reason === 'unterminated') {
        return 'Event log repaired a record missing its trailing newline';
      }
      return d.torn
        ? `Event log recovered a torn write (${d.lostBytes || 0} bytes quarantined)`
        : `Event log recovered an unreadable line (${d.lostBytes || 0} bytes)`;
    case 'agent.registered':
      return `${who} joined the studio`;
    case 'agent.stopped':
      return `${who} left the studio${d.reason ? ` (${d.reason})` : ''}`;
    case 'agent.state':
      return `${who} is ${d.state}${d.task ? ` on ${d.task}` : ''}`;
    case 'message.sent': {
      const to = (d.to || []).length ? ` → ${(d.to || []).join(', ')}` : ' → all';
      return `${who}${to}: ${firstLine(d.text)}`;
    }
    case 'task.created':
      return `${who} proposed ${d.id} — ${d.title}`;
    case 'task.updated': {
      const bits = [];
      if (d.changes?.state) bits.push(`→ ${d.changes.state}`);
      if (d.changes?.owner) bits.push(`owner ${d.changes.owner}`);
      // previousOwner is a sibling of changes, so it never lands on the task —
      // which also means it never shows up here unless it is asked for.
      if (d.previousOwner) bits.push(`(taken from ${d.previousOwner})`);
      return `${who} updated ${d.id} ${bits.join(' ')}`.trim();
    }
    case 'decision.recorded':
      return `Decision ${d.id}: ${d.question} → ${firstLine(d.chosen)}`;
    case 'debate.opened':
      return `${who} opened debate ${d.id}: ${d.question}`;
    case 'debate.position':
      return `${who} took a position in ${d.id}`;
    case 'debate.closed':
      return `Debate ${d.id} closed — ${firstLine(d.outcome)}`;
    case 'question.opened':
      return `${who} raised an open question: ${firstLine(d.text)}`;
    case 'question.closed':
      return `Question ${d.id} resolved`;
    case 'attention.raised':
      return `Needs human: ${d.kind} — ${firstLine(d.text)}`;
    // Withdrawal stays in the timeline. The point is that the human can still see
    // an agent decided something no longer needed them, and disagree.
    case 'attention.withdrawn':
      return `${who} withdrew ${d.id} — ${firstLine(d.reason)}`;
    case 'work.files':
      return `${who} ${d.action || 'changed'} ${d.files?.length || 0} file(s)`;
    case 'work.validation':
      return `${who} ran ${d.name}: ${d.ok ? 'passed' : 'FAILED'}`;
    case 'work.discovery':
      return `${who} recorded a discovery: ${firstLine(d.text)}`;
    case 'human.message':
      return `${speaker(d)}${d.to?.length ? ` → ${d.to.join(', ')}` : ''}: ${humanText(d.text)}`;
    // The human's own words are the point of a human intervention. These used to
    // render as bare verbs — a stop whose reason was recorded in full arrived at
    // every agent as "Human: stop" — because agents are handed only this line.
    // A reassignment reads as "reassign claude" — accurate, and useless to grok,
    // who is the one who needs to stop working it. Agents are handed only this
    // line, so the line has to name the loss, not just the gain. (grok's note on
    // the TASK-18 review: the event data already said it; the summary did not.)
    case 'human.control': {
      const move = d.previousOwner ? ` — taken from ${d.previousOwner}` : '';
      const task = d.task ? ` ${d.task}` : '';
      return `${speaker(d)}: ${d.action}${task}${d.target ? ` → ${d.target}` : ''}${move}${d.text ? ` — ${humanText(d.text)}` : ''}`;
    }
    case 'human.control.delivery-failed':
      return `Control delivery failed${d.controlSeq ? ` for seq ${d.controlSeq}` : ''} -- ${firstLine(d.warning || d.reason)}`;
    case 'human.verdict':
      return `${speaker(d)} ${d.verdict} ${d.target}${d.text ? ` — ${humanText(d.text)}` : ''}`;
    case 'inbox.delivered':
      return `${d.agent} was shown ${d.count} inbox item(s) through seq ${d.through}`;
    case 'inbox.acked':
      return `${d.agent} confirmed its inbox through seq ${d.through}${d.reason ? ` (${d.reason})` : ''}`;
    default:
      return `${ev.kind}${d.text ? ` — ${firstLine(d.text)}` : ''}`;
  }
}

// "Human" is a claim about who spoke, and it has been wrong at least once: a probe
// against the live server appeared to two agents as a directive from the creative
// director. Anything that did not come through the browser UI says so, so a
// mistake announces itself instead of impersonating the person in charge.
// The human's words, in full.
//
// firstLine() is right for an agent's own message -- those are long and the
// timeline wants a summary. It is wrong for the human, and codex's TASK-15
// review caught it: a directive whose reasoning ran onto a second line was
// handed to agents as the first line only, so the part the human took the
// trouble to write was silently dropped. Agents are given this line and
// little else.
//
// Newlines collapse to a separator rather than being kept, so it stays one
// line for the CLI and the timeline, but no word is lost.
function humanText(text) {
  return String(text ?? '')
    .trim()
    .split(NEWLINE_RUN)
    .filter(Boolean)
    .join(' · ');
}

const NEWLINE_RUN = /\s*\n\s*/;

function speaker(d) {
  return d?.via && d.via !== 'browser' ? `Human[via ${d.via}]` : 'Human';
}

function firstLine(text) {
  if (!text) return '';
  const s = String(text).split('\n')[0];
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}
