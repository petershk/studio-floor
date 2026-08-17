# Quickstart

From nothing to a team of agents working on your project. Ten minutes, most of
it spent writing down what you actually want.

## Before you start

**You need at least one agent CLI installed and logged in.** The studio launches
them; it does not authenticate them for you.

| Provider | Install | Log in |
| --- | --- | --- |
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude` then `/login` |
| OpenAI Codex | `npm i -g @openai/codex` | `codex login` |
| Grok | see xAI's CLI docs | `grok auth login` |

You also need **Node 20 or newer**. Check with `node --version`.

**This costs real money.** Every agent turn is a full model call, and agents run
until they run out of work or hit their turn budget. Step 6 sets a low budget on
purpose. Do not skip it and then leave five agents running overnight.

---

## 1. Install the studio

```bash
git clone https://github.com/petershk/studio-floor.git
cd studio-floor
npm link
```

There is nothing to build and there are no dependencies to install. `npm link`
puts the `studio` command on your PATH, pointing at this clone — so
`git pull` here updates the command everywhere.

Check it:

```bash
studio --version
```

## 2. Make a directory for your project

The studio is a tool you point at a project. It is not the project.

```bash
mkdir ~/my-project
cd ~/my-project
```

## 3. Put it under git — do this before the agents run

This is a **new, empty, local repo for your project**. It has no remote and no
connection to `studio-floor` — that is the tool, installed separately in step 1.
The two are unrelated, and the studio never touches its own repo.

```bash
git init
git add -A && git commit -m "before letting the team at it"
```

**Do not skip this.** Agents edit files, run commands, and delete things. A git
repository is the difference between "undo that" and "it is gone". Commit
whenever the team reaches a state you would be sad to lose.

Git is not *required* — the studio works in a plain directory — but running
autonomous agents without an undo button is a decision you will regret exactly
once.

### If you already have a project

Then you do not want `git init` at all.

**Already on GitHub** — clone it and set the studio up inside it:

```bash
git clone https://github.com/you/your-project.git
cd your-project
```

**Already local and under git** — nothing to do. Just `cd` there.

Either way, `studio init` in the next step adds `PROJECT.md` and
`studio.config.json` to the repo you already have. Commit them or gitignore
them, whichever you prefer.

### Publishing your project later

Nothing about the studio needs your project to be on a remote. When you want it
there:

```bash
git add -A && git commit -m "initial"
git branch -M main
gh repo create your-project --private --source=. --remote=origin --push
```

The `git branch -M main` matters if your git still defaults to `master` — `gh`
creates the remote expecting `main` and the push fails confusingly otherwise.

## 4. Set it up

```bash
studio init
```

Two files appear:

- `PROJECT.md` — what you want built
- `studio.config.json` — who is on the team

## 5. Write PROJECT.md — this is the actual work

Everything else in this guide is typing commands. This step is the one that
determines whether the result is any good.

Every agent reads this file in full on its first turn, and it outranks anything
else they are told. Write it for a competent colleague who has never seen the
project.

What makes the difference:

- **Say what "done" looks like**, concretely enough to check. "A working login
  page" is not checkable. "A user can register, log out, log back in, and reset
  a forgotten password by email" is.
- **Record decisions you have already made.** Anything you leave open, the team
  will debate — sometimes for several turns. If you already know it is
  PostgreSQL, write that down and the debate never happens.
- **List the questions you genuinely have not decided.** The team will research
  them and bring you a recommendation, which is a good use of them.
- **Order the milestones** and say not to start the second before the first
  works. Agents will otherwise build the interesting part first.
- **Say what not to do.** This is worth as much as saying what to do.

A brief that says "build me a todo app" produces a team that spends its first
four turns deciding what you meant.

## 6. Set the roster and the budget

Open `studio.config.json`. The default is three agents on three different
providers. Two things to change for a first run:

```json
{
  "agents": [
    { "id": "architect", "provider": "claude", "persona": "architect" },
    { "id": "builder",   "provider": "claude", "persona": "implementer" },
    { "id": "breaker",   "provider": "grok",   "persona": "adversary" }
  ],
  "runner": { "maxTurns": 15 }
}
```

**`maxTurns` is a hard per-agent budget** and the default of 200 is a lot. Set it
to 10–20 for your first run so the team stops on its own while you are still
watching. Raise it once you trust what you are seeing.

An `id` is not a provider — two agents can share one provider with different
jobs, as above. Give them **different personas**; two agents with the same
framing will agree with each other, and agreement is not what you are paying
for.

Built-in personas: `implementer`, `architect`, `adversary`, `researcher`,
`integrator`. Any other string is used verbatim.

## 7. Check the wiring

```bash
studio doctor
```

Every line should say `ok`. It probes each configured CLI for a version, so a
failure here means that agent cannot run — not that the studio is broken.

## 8. Look around before you let anyone in

```bash
studio start --no-agents
```

Open **http://127.0.0.1:4173**. Empty studio, no tokens spent, nothing running.
Get familiar with the panels — agents, conversation, tasks, timeline, raw — then
`Ctrl-C`.

## 9. Start the team

```bash
studio start
```

Open **http://127.0.0.1:4173** and watch.

Agents start staggered, about ten seconds apart. Turns are slow — anywhere from
twenty seconds to a couple of minutes each, depending on the provider and what
the agent is doing. Nothing is wrong if the screen is still for a minute.

`Ctrl-C` stops the agents and the server cleanly. Nothing is lost: the studio
rebuilds its entire world from `.studio/events.jsonl` next time you start.

---

## What the first ten minutes should look like

1. Each agent arrives, reads `PROJECT.md`, and introduces itself with what it
   thinks it is best at.
2. They talk about the project — including, if you wrote the brief well, telling
   you what they think is wrong with it.
3. They divide the work into tasks and claim them.
4. Someone disagrees with someone else about approach.
5. Work starts, files change, validation runs.

If instead they all immediately start implementing the same thing, your brief
was too vague about ownership. Stop them, sharpen it, delete `.studio/`, restart.

## Driving the team

From the browser you can pause, resume, stop individual agents, nudge one,
assign a task, set a priority, message one agent or all of them, and answer
anything they escalate.

The message box at the bottom is the main one. Agents see what you say on their
next turn, and anything from you takes priority over everything else they were
doing.

## When something looks wrong

**Nothing is happening.** Check the Raw panel, filtered to one agent. A turn
that failed to launch shows up there as an error. Three failed launches in a row
stop that agent and raise an escalation.

**An agent keeps redoing work.** Its inbox is being redelivered because its
turns are not completing. Look for timeouts or crashes in Raw.

**The team is debating instead of building.** Your brief left too much open. Say
so in the message box — a direct instruction from you outranks their debate.

**You want to start completely over.** Stop the studio and delete `.studio/`.
That erases all history — conversation, tasks, decisions — but touches none of
your project files.

## Cost control

- `runner.maxTurns` — hard per-agent stop. The most reliable brake.
- Fewer agents. Three is a team; five is a committee and costs nearly twice as
  much.
- Idle agents cost nothing. After three turns with no activity an agent sleeps
  until something happens.
- `Ctrl-C` any time. You lose nothing.

## Running agents that cannot change anything

To watch the collaboration without letting anyone touch your files:

```json
{ "agents": [
  { "id": "a", "provider": "claude", "permissionMode": "default" },
  { "id": "b", "provider": "codex",  "sandbox": "read-only" }
]}
```

They will still plan, talk, disagree, and record decisions. They just will not
write anything. A good way to spend your first run.

---

## Next

- [CONFIG.md](CONFIG.md) — every configuration key
- [PROTOCOL.md](PROTOCOL.md) — what agents are expected to do, and the CLI they do it with
- [ADAPTERS.md](ADAPTERS.md) — adding a provider
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it works underneath
- [CLOUD.md](CLOUD.md) — running it somewhere other than your laptop
