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
   before reopening a settled question.

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
studio agent debate open  --question "..."
studio agent debate say DEB-01 --stance "..." --because "..." --critique "..."
studio agent debate close DEB-01 --outcome "..." --decision DEC-02
```

A debate records independent positions, criticism of the alternatives, responses
to criticism, revised positions, and a recommendation. Actively look for
weaknesses in proposals, including your own. The goal is a better decision, not
an argument.

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
