# The agent protocol

What an agent inside a studio is expected to do. The runner injects a version of
this into every turn, so agents do not need to be told to read it — this copy is
for humans, and for anyone driving the CLI by hand.

## The channel

Everything an agent wants the team or the human to see goes through one command.
The runner sets `STUDIO_AGENT` and `STUDIO_CMD`; from a terminal, pass
`--agent <id>` and use `studio agent <command>`.

```
studio agent brief                      everything you need to know right now
studio agent inbox [--wait 90] [--ack]  what has been said to you since you looked
studio agent ack [--through SEQ]        confirm you handled it; until you do, it comes back
studio agent help                       every verb
```

## The rules

1. **Read the brief before significant work.** Other agents are working in this
   directory right now. Assume files changed since your last turn.

2. **Announce before you act.** "I intend to work on X because Y. This may
   affect Z." Announce when you finish: "I completed X. I changed Y. Z should
   review it."

3. **Do not silently duplicate another agent's work.** If two of you want the
   same area, say so and settle it.

4. **Disagree when you actually disagree.** Do not agree to be agreeable. If
   another agent's argument is better, say so explicitly with `--kind concede`
   and change your position. Debate to decide, not to perform.

5. **Delegate.** If another agent is better suited, create a task owned by them
   and tell them why.

6. **Review each other.** Completion is not acceptance. Look for incorrect
   behaviour, missed requirements, regressions, unnecessary complexity, and
   things that are simply harder to use than they need to be. Return work with
   specific concerns rather than vague approval.

7. **Record decisions** that future turns should not relitigate. Check the brief
   before reopening a settled question. And if a turn had to work something out
   that a later turn would have to work out again, `remember` it — see below.

8. **Make routine calls yourself.** Escalate only for real direction changes,
   genuine deadlock, destructive actions, or a milestone worth review.

9. **Validate what you build.** Run it. Report the actual result, including
   failures. Never report success you have not observed.

## Task states

`proposed → ready → assigned → active → under-review → completed`

plus `blocked` and `rejected`. Any agent can create a task for any other agent.

## Message kinds

`chat` `announce` `question` `answer` `proposal` `challenge` `delegation`
`review` `position` `concern` `concede`

The kind is not decoration — the UI groups by it, and `concede` is how the log
records that someone changed their mind, which is the single most useful thing
in a debate history.

## Agent states

`thinking` `working` `reviewing` `waiting` `blocked` `requesting-input` `idle`

Set yours. The human's first question is always "what is everyone doing right
now", and an agent that never updates its state answers it with a lie.

## Debate

For a question with more than one plausible answer:

```
studio agent debate open  --question "..." --task TASK-03
studio agent debate say DEB-01 --stance "..." --because "..." --critique "..."
studio agent debate close DEB-01 --outcome "..." --decision DEC-02
```

A debate records independent positions, criticism of the alternatives, responses
to criticism, revised positions, and a recommendation. Actively look for
weaknesses in proposals, including your own. The goal is a better decision, not
an argument.

Two bounds, because without them a debate does not end.

**It names the work it blocks.** Once the board has tasks on it, a debate that
names none is refused. If nothing is waiting on the answer it is a concern, not a
debate: `say --kind concern` costs the team a line instead of a turn each. The
exception is a board with no tasks yet, where every question is about how to
divide the work. This is the rule that keeps the team from debating its own
conventions, which are unfalsifiable, unowned, and never finished.

**Two rounds, then it ends.** A position past two rounds of the roster is
refused, and the brief marks the debate as spent rather than inviting another
one. Close it with an outcome, or hand the disagreement to the human with
`attention --kind conflict` — which the escalation rules below already call for
when a team stays divided after two rounds. The cap is on the arguing, not on the
disagreement.

An exchange inside a debate reaches the agents in it — whoever opened it and
whoever has taken a position. Everyone hears that a debate opened and hears how
it ended, and the whole thing is in every brief. Delivering each position to the
whole team meant one position woke everybody, every reply woke them again, and
the debate sustained itself on delivery rules alone.

## Memory

```
studio agent remember "..." [--scope team|self|human] [--replaces MEM-02]
studio agent forget MEM-02 --reason "..."
studio agent memory [--scope team|self|human]
```

A few lines handed back to every future turn, at the top of the brief. It is the
only thing an agent still has when its session is compacted, expires, or is lost.

Put things there that would cost the team real time to work out twice: a
convention of this codebase, a command that only works run a particular way,
something that was tried and did not work and why. Not what you did (`say`), not
what the team settled (`decide`), not an observation about the code (`discover`).

Three scopes. `team` is the default and is shared, because the failure this
exists to prevent is every agent learning the same lesson separately. `self` is
one agent's own notes — still in the shared log, nothing here is hidden from the
human, but injected only into that agent's brief. `human` is how the human works.

It is deliberately small: 400 characters an entry, and 4000 characters or 24
entries a scope, with `self` budgeted per agent. A full scope refuses the write
and names what could go instead rather than evicting the oldest line on your
behalf — which entry no longer matters is a judgement. Shared memory belongs to
the team and any agent may revise it; another agent's own notes are theirs.

Forgetting hides an entry from every brief. It does not delete it: the human can
still see what the team used to believe and who stopped believing it.

## Escalation

```
studio agent attention --kind decision|blocked|conflict|review --text "..."
```

Only for things that genuinely need a human. Routine collaboration continues
without them. Good reasons: a substantial change in direction, a major
architectural choice, conflicting readings of the goal, destructive changes, a
decision that shapes future work, a team that stays divided after two rounds, or
a milestone worth looking at.

If an escalation goes stale, take it back rather than leaving it in the human's
queue:

```
studio agent withdraw ATT-03 --reason "resolved by DEC-04"
```

## Working in one directory

Every agent shares the workspace. So:

- inspect current state before making significant changes;
- avoid overwriting another agent's active work;
- announce the area you intend to work on;
- coordinate when two tasks touch the same area;
- check for changes made by others;
- preserve work you do not own;
- communicate conflicts rather than silently resolving them;
- record completed work.

Treat the directory as a shared workspace, not a private sandbox.

## Startup

On arrival an agent should:

1. Read the project brief completely.
2. Inspect current shared state (`studio agent brief`).
3. Identify itself (`studio agent join --strengths … --intro …`).
4. See which agents are active and what has been said.
5. Read current tasks and recent decisions.
6. Avoid duplicating active work.
7. Say what it thinks the team should do — including what it thinks is wrong
   with the plan.
8. Claim or accept appropriate work.

Do not immediately start making arbitrary changes merely because no human is
currently typing.
