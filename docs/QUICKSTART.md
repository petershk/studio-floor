# Quickstart

Everything from an empty machine to a team of AI agents building your project,
assuming you have never seen this repository before.

Budget about 30 minutes the first time. Most of that is installing agent CLIs
and writing down what you actually want built.

**Contents**

1. [What you are setting up](#1-what-you-are-setting-up)
2. [Prerequisites](#2-prerequisites)
3. [Install at least one agent CLI](#3-install-at-least-one-agent-cli)
4. [Get this repository](#4-get-this-repository)
5. [Install the studio command](#5-install-the-studio-command)
6. [Set up your project directory](#6-set-up-your-project-directory)
7. [Create the studio files](#7-create-the-studio-files)
8. [Write PROJECT.md](#8-write-projectmd--the-step-that-matters)
9. [Configure the team](#9-configure-the-team)
10. [Check the wiring](#10-check-the-wiring)
11. [Dry run](#11-dry-run-costs-nothing)
12. [Start the team](#12-start-the-team)
13. [Driving, stopping, resetting](#13-driving-stopping-and-resetting)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. What you are setting up

Two separate things. Keeping them straight saves confusion later.

| | What | Where it lives |
| --- | --- | --- |
| **The studio** | this tool. Installed once. | wherever you clone this repo |
| **Your project** | the code the agents write. | a directory you choose |

The studio is not a library you add to your project and not a framework you
build inside. It is a program you install once and then point at any directory.
It launches agent CLIs as child processes, feeds them a shared task board and
conversation, and shows you all of it in a browser.

When you are done you will have a web page at `http://127.0.0.1:4173` showing
several agents talking to each other, claiming tasks, disagreeing, and changing
files in your project — with controls to pause, redirect, or stop them.

---

## 2. Prerequisites

### Node.js 20 or newer

```bash
node --version
```

If that errors or prints something below `v20`, install it:

- **Windows:** `winget install OpenJS.NodeJS.LTS`, or download from [nodejs.org](https://nodejs.org)
- **macOS:** `brew install node`, or download from [nodejs.org](https://nodejs.org)
- **Linux:** use [nodesource](https://github.com/nodesource/distributions) or your distro's package manager. Distro Node is often too old — check the version.

Close and reopen your terminal after installing.

### Git

```bash
git --version
```

If missing: `winget install Git.Git` (Windows), `brew install git` (macOS), or
your package manager.

### A terminal you are comfortable in

Any shell works. On Windows, PowerShell and Git Bash both work; the commands in
this guide are shown in a POSIX style, and the only difference in PowerShell is
that `~` and `$EDITOR` are not available — use full paths and `notepad` instead.

---

## 3. Install at least one agent CLI

**This is the part people skip and then wonder why nothing runs.** The studio
launches these programs. It does not install them, and it cannot authenticate
them for you.

You need **at least one**. Three different providers makes for a more
interesting team — agents from different models genuinely disagree with each
other — but one provider running several agents with different jobs also works.

Install from each vendor's own instructions; they change their install method
periodically and a stale command in this file would be worse than a link.

| Provider | Install | Sign in | Verify |
| --- | --- | --- | --- |
| **Claude Code** | [claude.com/claude-code](https://claude.com/claude-code) | `claude auth login` | `claude --version` |
| **OpenAI Codex** | [developers.openai.com/codex](https://developers.openai.com/codex) | `codex login` | `codex --version` |
| **Grok** | [xAI's CLI docs](https://docs.x.ai) | `grok login` | `grok --version` |

Each `--version` must print something **in a new terminal**, not just in the one
where you installed it. If it does not, the installer did not put it on your
PATH and the studio will not find it either.

Check you are actually signed in — an installed-but-logged-out CLI passes
`--version` and then fails on the first real turn:

```bash
claude auth status
```

### About cost

Every agent turn is a full model call, and agents keep taking turns while there
is work to do. A team of three left running can spend real money quickly.

Step 9 sets a low turn budget on purpose. Do not skip it and then leave the
studio running overnight.

---

## 4. Get this repository

**Decide where it will live first.** In step 5 you link a global command into
this clone, so wherever you put it becomes permanent — moving or deleting it
later breaks the `studio` command. Somewhere boring you keep long-term is right;
a temp directory or `Downloads` is not.

```bash
# pick a permanent home and go there
mkdir -p ~/tools
cd ~/tools

# git creates the studio-floor/ directory for you — do not mkdir it yourself
git clone https://github.com/petershk/studio-floor.git
cd studio-floor
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force C:\tools
cd C:\tools
git clone https://github.com/petershk/studio-floor.git
cd studio-floor
```

You should now be inside `~/tools/studio-floor` (or `C:\tools\studio-floor`).
Confirm with `pwd`.

Nothing to install and nothing to build — the studio has **zero dependencies**.
Confirm it works:

```bash
npm test
```

You should see a list of test files, all `ok`, ending in `all green`. This runs
the entire collaboration loop against a throwaway directory — agents joining,
talking, delegating, disagreeing, deciding, reviewing, crashing mid-turn, and a
human intervening. It spends no tokens, touches no network, and takes about 30
seconds.

If that passes, the studio itself is sound and anything that goes wrong later is
configuration or a provider CLI.

---

## 5. Install the `studio` command

From inside the clone:

```bash
npm link
```

This puts a `studio` command on your PATH pointing at this clone. Two
consequences worth knowing:

- `git pull` in this directory updates the command everywhere.
- **Do not delete or move the clone**, or the command breaks. This is why step 4
  had you choose a permanent location for it.

Verify:

```bash
studio --version
studio help
```

<details>
<summary>Prefer not to install globally?</summary>

Skip `npm link` and run it by path instead. Everywhere this guide says
`studio ...`, use:

```bash
node /full/path/to/studio-floor/bin/studio.mjs ...
```

It still operates on whatever directory you are standing in, so nothing else in
this guide changes. Use `--project /path/to/somewhere` to point it elsewhere.
</details>

---

## 6. Set up your project directory

The studio works on a directory. Pick one.

### If you are starting something new

```bash
mkdir ~/my-project
cd ~/my-project
git init
```

That `git init` creates a **new, empty, local repository for your project**. It
has no remote and no relationship to `studio-floor` — that is the tool, which
you installed in step 5. The studio never touches its own repository.

### If your project already exists on GitHub

Do not `git init`. Clone it:

```bash
git clone https://github.com/you/your-project.git
cd your-project
```

### If your project already exists locally

Just `cd` into it. If it is not under version control yet, run `git init` now.

### Commit before you let anyone in

```bash
git add -A
git commit -m "before letting the team at it"
```

**Do this.** Agents edit files, run shell commands, and delete things. Git is
the difference between "undo that" and "it is gone". The studio does not require
git — it works fine in a plain directory — but running autonomous agents without
an undo button is a decision you make exactly once.

Commit again whenever the team reaches a state you would be sad to lose.

<details>
<summary>Publishing your project to GitHub later</summary>

Nothing about the studio needs a remote. When you want one:

```bash
git add -A && git commit -m "initial"
git branch -M main
gh repo create your-project --private --source=. --remote=origin --push
```

The `git branch -M main` matters if your git still defaults to `master`. `gh`
creates the remote expecting `main`, and without it the push fails with a
confusing `src refspec main does not match any`.
</details>

---

## 7. Create the studio files

From inside your project directory:

```bash
studio init
```

Two files appear:

| File | What it is |
| --- | --- |
| `PROJECT.md` | what you want built. Every agent reads it on its first turn. |
| `studio.config.json` | who is on the team, and their budget. |

A third thing appears once you start: `.studio/`, holding the event log — the
team's entire memory. You do not need to gitignore it; the studio writes a
`.gitignore` inside it on creation so git never sees it.

Both `PROJECT.md` and `studio.config.json` are yours. Commit them if you want
the team's brief tracked alongside the code, which is usually right.

---

## 8. Write PROJECT.md — the step that matters

Everything else in this guide is typing commands. **This is the step that
determines whether the output is any good.**

Every agent reads this file in full on its first turn, and it outranks anything
else they are told. A brief that says "build me a todo app" produces a team that
spends its first four turns deciding what you meant, and then builds the wrong
thing confidently.

Write it for a competent colleague who has never seen the project.

### What to include

**What "done" looks like, concretely enough to check.**
"A working login page" is not checkable. "A user can register, log out, log back
in, and reset a forgotten password by email" is.

**Decisions you have already made.**
Anything you leave open, the team will debate — sometimes for several turns. If
you already know it is PostgreSQL, write that down and the debate never happens.
Mark them as closed so nobody reopens them.

**Questions you genuinely have not decided.**
Say so explicitly. The team will research them and bring you a recommendation,
which is one of the better uses of several agents.

**Ordered milestones, and an instruction not to start the next before the
previous one works.** Otherwise agents build the interesting part first — the
renderer before the data model, the UI before the API.

**What not to do.** Worth as much as saying what to do. "Do not add a state
management library", "do not build an admin panel yet", "do not touch
`legacy/`."

### A worked example

```markdown
# Recipe Box

A private web app where I keep recipes and plan a week of meals.

## Goal

I have recipes in six places and no way to plan a week. I want one place to put
them, search them, and drag them onto a week to get a shopping list.

Single user — me. No accounts, no sharing, no mobile app. Runs on my home
server.

## What done looks like

### M1 — Recipes exist
- Add a recipe: title, ingredients with amounts, steps, tags.
- Edit, delete, and list them.
- Search by title, ingredient, or tag, and get results as I type.
- Data survives a restart.

### M2 — A week can be planned
- Drag recipes onto a seven-day grid.
- The grid produces a shopping list with amounts combined
  (two recipes needing 1 onion each produce "2 onions", not two lines).
- Print the shopping list.

Do not start M2 until M1 works in a browser.

## Decisions already made — do not reopen

- TypeScript. Not JavaScript.
- SQLite, single file. Not Postgres, not an ORM. Plain SQL is fine.
- Server-rendered HTML with light sprinkles of JS. Not React, not a SPA.
- One `npm start` runs the whole thing.

## Constraints

- No paid services. No cloud anything.
- No auth. It is behind my firewall.
- Keep dependencies few enough that I can read the list and understand it.

## Open questions — decide these as a team and tell me

- How should ingredient amounts be stored so "1/2 cup" and "120ml" can be
  combined? Research this before designing the schema; it looks simple and
  is not.
- Is a full-text search index worth it at this scale, or is `LIKE` fine?

## Do not

- Do not build an import-from-a-website scraper. I will ask for it later.
- Do not add user accounts.
- Do not restructure the project after M1 without asking me.
```

That brief is specific enough that three agents can divide it up on their first
turn without needing you.

---

## 9. Configure the team

Open `studio.config.json`. `studio init` wrote a default: three agents on three
different providers.

```json
{
  "project": {
    "name": "Recipe Box",
    "brief": "PROJECT.md"
  },
  "agents": [
    { "id": "architect", "provider": "claude", "persona": "architect" },
    { "id": "builder",   "provider": "claude", "persona": "implementer" },
    { "id": "breaker",   "provider": "grok",   "persona": "adversary" }
  ],
  "runner": {
    "maxTurns": 15
  }
}
```

### Two things to change before your first run

**Remove any provider you did not install.** An agent whose CLI is missing will
fail to launch three times and then stop with an escalation. Not fatal, but
noisy and pointless.

**Set `maxTurns` to 10–20.** This is a hard per-agent stop and the default is
200. A low budget means the team runs out while you are still watching, instead
of while you are asleep. Raise it once you trust what you are seeing.

### Understanding the roster

Each agent has three things that matter:

- **`id`** — what the team calls it. Any lowercase name: `architect`, `builder`,
  `alice`.
- **`provider`** — which CLI to launch: `claude`, `codex`, or `grok`.
- **`persona`** — what it is for.

**An `id` is not a provider.** Two agents can share one provider with completely
different jobs, as `architect` and `builder` do above. If you only installed
Claude Code, you can still run a real team:

```json
"agents": [
  { "id": "architect", "provider": "claude", "persona": "architect" },
  { "id": "builder",   "provider": "claude", "persona": "implementer" },
  { "id": "breaker",   "provider": "claude", "persona": "adversary" }
]
```

**Give them different personas.** Built in: `implementer`, `architect`,
`adversary`, `researcher`, `integrator`. Any other string is used verbatim, so
you can write your own. Three agents with the same framing will agree with each
other, and agreement is not what you are paying for.

**Two or three agents is a team. Five is a committee** — coordination overhead
grows faster than output, and so does the bill. Start with three.

Every configuration key is documented in [CONFIG.md](CONFIG.md).

### Optional: a first run that cannot change anything

If you would rather watch before trusting it, make the agents read-only. They
will still plan, talk, disagree, and record decisions — they just cannot write:

```json
"agents": [
  { "id": "architect", "provider": "claude", "permissionMode": "default" },
  { "id": "scout",     "provider": "codex",  "sandbox": "read-only" }
]
```

---

## 10. Check the wiring

```bash
studio doctor
```

Expected:

```
  studio doctor — /home/you/my-project

  config     /home/you/my-project/studio.config.json
  providers  codex, claude, grok

  ok    project brief PROJECT.md
  ok    architect → claude (claude — 2.1.233 (Claude Code))
  ok    builder → claude (claude — 2.1.233 (Claude Code))
  ok    breaker → grok (grok — grok 1.0.4)

  ready
```

Every line must say `ok`. Common failures:

| Line | Meaning | Fix |
| --- | --- | --- |
| `no project brief at PROJECT.md` | the brief is missing | you are in the wrong directory, or `studio init` was never run |
| `"claude" is not installed or not on PATH` | the CLI is missing | go back to step 3; open a **new** terminal after installing |
| `no adapter for provider "gemini"` | typo, or a provider with no adapter | fix the name, or see [ADAPTERS.md](ADAPTERS.md) |

`doctor` only checks that the CLIs exist and respond. It cannot tell whether you
are logged in — that shows up on the first turn.

---

## 11. Dry run (costs nothing)

```bash
studio start --no-agents
```

This starts the web server with **no agents running**, so no tokens are spent.

Open **http://127.0.0.1:4173**.

Take a minute to learn the layout:

| Area | What it shows |
| --- | --- |
| top bar | how many agents are active, what is in flight, what needs you |
| left rail | each agent, its state, its current task |
| **Needs you** | escalations — the things worth your attention |
| Conversation | what the agents say to each other, verbatim |
| Timeline | chronological history of everything |
| Tasks | the board, proposed through done |
| Decisions | settled questions and open debates |
| Raw | the lowest-level output of each CLI — where you look when confused |
| bottom bar | the box you type into to talk to the team |

Press `Ctrl-C` in the terminal when you are done looking.

---

## 12. Start the team

```bash
studio start
```

Open **http://127.0.0.1:4173** and watch.

### What the first ten minutes should look like

1. Agents start staggered, about ten seconds apart.
2. Each reads `PROJECT.md` and introduces itself with what it thinks it is best
   at.
3. They discuss the project — including, if your brief was good, telling you
   what they think is wrong with it.
4. They break the work into tasks and claim them.
5. Someone disagrees with someone else about approach.
6. Work starts. Files change. Validation runs.

**Turns are slow.** Anywhere from twenty seconds to a couple of minutes each. A
still screen for a minute is normal, not broken. Check the Raw panel if you want
to see something happening.

### Signs your brief needs work

- **All three implement the same thing.** Ownership was too vague.
- **They debate for several turns without building.** Too much was left open —
  answer them in the message box.
- **They build something you did not ask for.** "Done" was not concrete enough.

All three are cheap to fix: `Ctrl-C`, edit `PROJECT.md`, `rm -rf .studio`,
start again.

---

## 13. Driving, stopping, and resetting

### Talking to them

The box at the bottom of the page. Agents see what you say on their next turn,
and anything from you takes priority over whatever they were doing. Use it
freely — it is the main control.

### The buttons

Pause all, resume all, stop all. Per agent: start, stop, nudge. You can also
assign a task, set a priority, and answer anything in **Needs you** with approve,
reject, or a reply.

### Stopping

`Ctrl-C` in the terminal. Stops the agents and the server cleanly.

**You lose nothing.** The studio rebuilds its entire world — conversation, tasks,
decisions, history — from `.studio/events.jsonl` next time you start. Stop
whenever you like.

### Starting over

```bash
rm -rf .studio
```

Erases all studio history. Touches none of your project files. Use it when you
have rewritten the brief and want the team to start fresh rather than carry on
from a bad plan.

### Keeping the cost down

- **`runner.maxTurns`** — the hard per-agent stop, and the most reliable brake.
- **Fewer agents.** Three is a team. Five costs nearly twice as much and
  coordinates worse.
- **Idle agents are free.** After three turns with nothing to do, an agent
  sleeps until something happens.
- **`Ctrl-C` any time.** Nothing is lost.

---

## 14. Troubleshooting

**`studio: command not found`**
`npm link` did not take, or the clone moved. Re-run `npm link` from inside the
clone, in a new terminal.

**Everything says `offline` and nothing happens**
You probably ran `studio start --no-agents`. Restart without the flag.

**An agent goes to `error` immediately, every time**
It is installed but not logged in. Run its provider's login command
(`claude auth login`, `codex login`, `grok login`) and check the Raw panel
filtered to that agent for the actual message.

**`X cannot be launched … failed to start 3 times in a row`**
The CLI is not on PATH for the process that started the studio. Verify with
`claude --version` in the same terminal you ran `studio start` from.

**Nothing has happened for several minutes**
Open Raw, filter to one agent. A turn in progress shows tool calls arriving. If
Raw is silent too, the agent is idle — it will wake when addressed. Type
something in the message box to wake it.

**An agent keeps redoing the same work**
Its turns are not completing, so its inbox is redelivered each time. Look for
timeouts or crashes in Raw. Consider raising `runner.turnTimeoutMs`.

**They changed something I did not want changed**
`git diff`, then `git checkout -- <file>`. This is why step 6 exists.

**The page is blank or unstyled**
Hard-refresh (`Ctrl-Shift-R`). If it persists, check the browser console and
open an issue — that is a bug in the studio, not your setup.

---

## Next

- [CONFIG.md](CONFIG.md) — every configuration key
- [PROTOCOL.md](PROTOCOL.md) — what agents are expected to do, and the CLI they do it with
- [ADAPTERS.md](ADAPTERS.md) — adding a provider the studio does not support yet
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it works underneath
- [CLOUD.md](CLOUD.md) — running it somewhere other than your laptop
