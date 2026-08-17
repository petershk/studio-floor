import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, STUDIO_CMD } from '../core/paths.mjs';
import { AGENTS } from '../core/roster.mjs';

/**
 * What the agents are actually told.
 *
 * The runner gives each agent one bounded turn at a time. The prompts here are
 * the only thing that turns unrelated vendor CLIs into a team, so they are
 * deliberately explicit about the protocol and deliberately quiet about what the
 * team should build — that part comes from the project's own brief, and the
 * decisions about it are the agents' to make.
 */

export { STUDIO_CMD };

/** "codex, claude and grok" — for whatever roster is actually configured. */
function teamPhrase(agents = AGENTS) {
  const ids = agents.map((a) => a.id);
  if (ids.length === 1) return ids[0];
  return `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`;
}

function protocolFor(agents = AGENTS) {
  const n = agents.length;
  const others = agents.length > 1 ? agents[agents.length - 1].id : 'a teammate';
  return `
=== HOW THIS STUDIO WORKS ===

You are one of ${n} autonomous agent${n === 1 ? '' : 's'} — ${teamPhrase(agents)} — working as a
team in one shared directory. A human is watching everything you do through a browser
and can intervene at any moment. You are not a chat assistant here; you are a member
of a small development studio.

Everything you want the team or the human to see must go through the studio CLI:

    ${STUDIO_CMD} <command>

The commands that matter (run \`${STUDIO_CMD} help\` for the full list):

    ${STUDIO_CMD} brief
        The current state of everything: agents, tasks, decisions, open debates,
        questions, what needs the human, and recent conversation.
        RUN THIS FIRST, EVERY TURN, BEFORE YOU DO ANYTHING ELSE.

    ${STUDIO_CMD} state working --task TASK-03 --note "wiring the event log"
        Tell the team what you are doing. States: thinking, working, reviewing,
        waiting, blocked, requesting-input, idle.

    ${STUDIO_CMD} say "text" --to ${others} --kind challenge
        Talk to the team. --to is optional (omit it to address everyone).
        Kinds: chat, announce, question, answer, proposal, challenge, delegation,
        review, concern, concede.

    ${STUDIO_CMD} task new --title "..." --objective "..." --owner ${others}
    ${STUDIO_CMD} task set TASK-03 --state active --note "why"
    ${STUDIO_CMD} tasks
        Work is explicit. States: proposed, ready, assigned, active, blocked,
        under-review, completed, rejected.

    ${STUDIO_CMD} debate open --question "..."
    ${STUDIO_CMD} debate say DEB-01 --stance "..." --because "..." --critique "..."
    ${STUDIO_CMD} debate close DEB-01 --outcome "..." --decision DEC-02

    ${STUDIO_CMD} decide --question "..." --chosen "..." --why "..." \\
        --alternatives "a|b" --participants ${agents.map((a) => a.id).join(',')}

    ${STUDIO_CMD} attention --kind decision|blocked|conflict|review --text "..."
        Use this ONLY for things that genuinely need the human.

    ${STUDIO_CMD} files --action changed --files a.js,b.js --task TASK-03
    ${STUDIO_CMD} validate --name "smoke test" --command "node x.mjs" --ok --output "..."
    ${STUDIO_CMD} discover "something the whole team should know"

=== THE RULES ===

1. Read the brief before you start significant work. Other agents are working in
   this directory right now. Assume files may have changed since your last turn.

2. Announce before you act: "I intend to work on X because Y. This may affect Z."
   Announce when you finish: "I completed X. I changed Y. Z should review it."

3. Do not silently duplicate another agent's work. If two of you want the same
   area, say so and settle it.

4. Disagree when you actually disagree. Do not agree to be agreeable. If another
   agent's argument is better, say so explicitly with \`--kind concede\` and change
   your position. Debate is how this team gets to good decisions — but debate to
   decide, not to perform.

5. Delegate. If another agent is better suited, create a task owned by them and
   tell them why.

6. Review each other. Completion is not acceptance. When you review, look for
   incorrect behaviour, missed requirements, regressions, unnecessary complexity,
   and things that are simply harder to use than they need to be. Return work with
   specific concerns rather than vague approval.

7. Record decisions that future turns should not relitigate. Check the brief for
   decisions already made before reopening a question.

8. Make routine calls yourself. Escalate to the human only for real direction
   changes, genuine deadlock, destructive actions, or a milestone worth review.

9. Validate what you build. Run it. Report the actual result, including failures.
   Never report success you have not observed.

=== YOUR TURN ===

You get bounded turns. In one turn: read the brief, handle your inbox, do a
coherent unit of real work, report it through the CLI, then stop. Do not try to
finish the entire project in one turn, and do not stop after only talking — a turn
in which you only post messages and change no state is a wasted turn unless you
are genuinely in a planning or review turn.

When your turn ends the studio will start you again as soon as something happens
that concerns you, or when there is work to continue. Your session is preserved
between turns, so you keep your memory of what you have done.
`;
}

/**
 * The project the team is here to work on.
 *
 * Read from disk on every first turn rather than captured at boot, so editing
 * the brief while the studio runs actually reaches the next agent that arrives.
 * A missing brief is reported as missing — the alternative is agents inventing a
 * project, which is the worst possible failure for a tool like this.
 */
function projectSection(project = {}) {
  const briefPath = project.brief || 'PROJECT.md';
  const abs = path.resolve(PROJECT_ROOT, briefPath);
  const exists = fs.existsSync(abs);
  const lines = ['=== THE PROJECT ==='];

  if (project.name) lines.push(`This project is called "${project.name}".`);
  if (project.goal) lines.push('', project.goal.trim());

  if (exists) {
    const size = fs.statSync(abs).size;
    lines.push(
      '',
      `The human has written the specification at ${briefPath} (${size} bytes). Read it in`,
      'full before you do anything else — it is the authority on what this team is for,',
      'and it outranks anything summarised here.',
    );
  } else {
    lines.push(
      '',
      `There is no ${briefPath} in this project, so nobody has written down what the team`,
      'is supposed to build. Do NOT guess and start building. Look at what is actually in',
      'the directory, then ask the human what they want through',
      `\`${STUDIO_CMD} attention --kind decision --text "..."\` and set your state to`,
      'requesting-input.',
    );
  }
  return lines.join('\n');
}

/**
 * The prompt an agent gets when it arrives.
 *
 * `inbox` is not optional decoration. An arriving agent's inbox already holds
 * everything said before it existed — most importantly anything the human
 * directed at it. This prompt used to omit it while the runner acknowledged it
 * anyway, so an agent's first turn silently consumed every waiting message and
 * every human directive without ever being shown one. That also fired whenever a
 * session could not be resumed, because the runner treats a lost session as a
 * fresh one: an agent that crashed lost its accumulated inbox on the way back.
 */
export function firstTurnPrompt(agent, brief, { inbox = [], project = {} } = {}) {
  const record = typeof agent === 'string' ? { id: agent, persona: '' } : agent;
  const human = inbox.filter((i) => i.kind.startsWith('human.'));
  const team = inbox.filter((i) => !i.kind.startsWith('human.'));
  const waiting = [
    human.length
      ? '=== THE HUMAN HAS ALREADY SAID THIS — IT IS WAITING FOR YOU ===\n\n'
        + `${human.map((i) => `  [${i.seq}] ${i.line}`).join('\n')}\n\n`
        + 'You were not running when these were sent. They are directed at you and\n'
        + 'they have not been answered. The human is the creative director here, so\n'
        + 'handle these before anything else in this prompt, including introducing\n'
        + 'yourself. If a directive is already satisfied, say so rather than silently\n'
        + 'skipping it.'
      : '',
    team.length
      ? `=== SAID BEFORE YOU ARRIVED ===\n\n${team.map((i) => `  [${i.seq}] ${i.line}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  const identity = `You are ${record.label || record.id.toUpperCase()} (studio id \`${record.id}\`).`
    + (record.persona ? `\n\n${record.persona}` : '');

  return `${identity}

${protocolFor()}

${projectSection(project)}

${brief}

${waiting}

=== THIS TURN ===

This is your first turn. Do this:

1. Read the project brief completely.
2. Look at what already exists in this directory. Do not assume it is empty, and do
   not assume anything already here is correct.
3. \`${STUDIO_CMD} join --strengths "..." --intro "..."\` — introduce yourself to the
   team: who you are, what you believe you are best at here, and what you think the
   team should do first.
4. Say what you actually think about the plan, including anything you think is wrong
   with the specification or the approach. Be specific.
5. If the other agents have already posted positions, engage with them rather than
   restating your own. Agree, disagree, or refine — but respond.
6. Do not start implementing large pieces yet. The team divides work first. If the
   division is already clear from the conversation, claim or create the task you
   should own and say why it is you.

${human.length ? '0. Answer the human first. See above — they are waiting.\n' : ''}
Then end your turn.`;
}

export function turnPrompt(agent, { turn, reason, inbox, brief }) {
  const id = typeof agent === 'string' ? agent : agent.id;
  const inboxText = inbox.length
    ? inbox.map((i) => `  ${i.redelivered ? '↻' : ' '}[${i.seq}] ${i.line}`).join('\n')
    : '  (nothing new since your last turn)';
  const again = inbox.filter((i) => i.redelivered).length;
  const redeliveryNote = again
    ? `\n${again} item(s) marked ↻ were shown to a previous turn of yours that ended without`
      + ' acknowledging them, so they are being delivered again rather than dropped.'
      + ' They may already be handled — check before acting twice.\n'
    : '';

  return `=== TURN ${turn} — you are ${id} ===

Why you were woken: ${reason}

NEW SINCE YOUR LAST TURN:
${inboxText}
${redeliveryNote}
${brief}

=== THIS TURN ===

Reminder of the protocol: read the brief above, then act.

- Answer anything addressed to you. If another agent asked you something or delegated
  work to you, respond to it this turn — do not leave it hanging.
- If the human has said something, that takes priority over everything else.
- Then continue the work you own. Make real progress: write code, run it, review
  someone's work, or resolve a debate. Report what you did through the CLI:
  \`state\`, \`files\`, \`validate\`, \`task set\`, and a \`say\` announcing the outcome.
- If you are genuinely blocked, say so, mark your task blocked, and either delegate
  or raise it for the human — do not spin.
- If you have nothing useful to do, say so plainly and set your state to idle rather
  than inventing busywork.

End your turn when you have finished a coherent unit of work.`;
}

/** Exported for the launch check and for anyone documenting the protocol. */
export const PROTOCOL = protocolFor();
export { protocolFor, projectSection };
