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
11. [Open the studio and set up the team](#11-open-the-studio-and-set-up-the-team-costs-nothing)
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

Commands in this guide are written for a POSIX shell — macOS or Linux terminal,
or Git Bash on Windows. They work as printed there.

**In Windows PowerShell, three of them do not.** `~` and `mkdir -p` are fine;
these are not:

| POSIX | PowerShell |
| --- | --- |
| `a && b` | `a; if ($?) { b }` — `&&` is a parser error in PowerShell 5.1 |
| `rm -rf dir` | `Remove-Item -Recurse -Force dir` |
| `$EDITOR file` | `notepad file` |

Where a step is easy to get wrong, the PowerShell version is given alongside.

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
| **Gemini CLI** | `npm i -g @google/gemini-cli` | `gemini` once, interactively | `gemini --version` |

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

### Why this matters

Agents edit files, run shell commands, and delete things. Git is the difference
between "undo that" and "it is gone". The studio does not require it — it works
fine in a plain directory — but running autonomous agents without an undo button
is a decision you make exactly once.

You will make the first commit at the end of step 7, once there is something to
commit. A brand-new directory is empty, and `git commit` on an empty repository
just fails with `nothing to commit`.

<details>
<summary>Publishing your project to GitHub later</summary>

Nothing about the studio needs a remote. When you want one:

```bash
git add -A
git commit -m "initial"
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

Two things appear:

| Path | What it is |
| --- | --- |
| `PROJECT.md` | what you want built. Every agent reads it on its first turn. |
| `studio_floor/config.json` | who is on the team, and their budget. |

Everything the studio generates lives in `studio_floor/`, so pointing the team at
a repository adds exactly one directory to it. Once you start, the event log —
the team's entire memory for this project — appears at `studio_floor/state/`.
That subdirectory is gitignored for you; the config beside it is not, because it
is worth committing.

**`studio init` is optional.** Point the studio at a directory with no brief and
the team reads the code, works out what the project is, drafts `PROJECT.md`
itself, and asks you to confirm it before building anything. Use `init` when you
are starting something new and want the template; skip it when you are pointing
the team at a repository that already exists.

Both `PROJECT.md` and `studio_floor/config.json` are yours. Committing them is usually
right — the team's brief belongs with the code it describes.

Now make that first commit, so you have a point to return to:

```bash
git add -A
git commit -m "before letting the team at it"
```

PowerShell: same two lines, run separately.

Commit again whenever the team reaches a state you would be sad to lose.

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

`studio init` wrote a default roster: three agents on three different providers.
You almost certainly want to change it, and there are two ways.

**The Settings panel** — a form in the studio's own web UI. It needs the studio
running, so it happens in step 11. If you would rather not touch JSON at all,
read the concepts below, then go on to step 11 and do the actual editing there.

**The file** — `studio_floor/config.json`. Same fields, and the panel writes it,
so the two are interchangeable. The file is also the *only* place a few things
can be set; see "What the panel will not change" below.

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

### What the panel will not change

Four things are editable only in the file, on purpose:

| Field | What it does |
| --- | --- |
| `command` | which executable to run for that agent |
| `extraArgs` | extra arguments handed to that CLI |
| `env` | environment variables for that agent's process |
| `adapters` | JavaScript files imported at boot |

Those decide what program runs on your machine. The studio's web server answers
on loopback with a permissive CORS policy, so any page you have open in another
tab can send it requests — a settings form that could write those fields would
be remote code execution with a Save button. Cross-origin writes to the config
are rejected outright for the same reason.

Editing in the panel does not disturb them. They are preserved per agent,
matched by id, so saving the roster from the UI will not delete a `command` you
hand-wrote.

### Optional: a first run that cannot change anything

If you would rather watch before trusting it, make the agents read-only. They
will still plan, talk, disagree, and record decisions — they just cannot write:

```json
"agents": [
  { "id": "architect", "provider": "claude", "permissionMode": "default" },
  { "id": "scout",     "provider": "codex",  "sandbox": "read-only" }
]
```

Both fields are in the panel too, as **Permissions** and **Sandbox**.

---

## 10. Check the wiring

```bash
studio doctor
```

Expected:

```
  studio doctor — /home/you/my-project

  config     /home/you/my-project/studio_floor/config.json
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

## 11. Open the studio and set up the team (costs nothing)

```bash
studio start --no-agents
```

This starts the web server with **no agents running**, so no tokens are spent
and nothing touches your files.

It prints the URL and opens your browser for you:

```
  ▸  Open http://127.0.0.1:4173
     opening your browser… (studio start --no-open to skip)
```

Add `--no-open` if you would rather it did not — over SSH, or when you already
have the tab. Restarts caused by switching project or updating never open a
second tab; the one you have reconnects on its own.

### Learn the layout

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
| **Settings** | the roster and runner tunables, as a form instead of JSON |
| bottom bar | the box you type into to talk to the team |

### Build your roster in Settings

Open the **Settings** tab. This is the config file as a form.

- **Project** — name, brief path, and an optional one-paragraph goal.
- **The team** — one card per agent. Edit the id, pick a provider and a persona
  from menus, set a model, reorder with ↑ ↓, remove, or **Add an agent**.
- **Runner** — turn budget, timeouts, cooldown, stagger, idle backoff.

Do the two things from step 9 here: delete any agent whose provider you did not
install, and set the turn budget to 10–20. Then **Save**.

### Read what it tells you after saving

The panel does not pretend everything took effect. Each save reports:

- **Applied now** — the runner re-reads its own settings every loop, so turn
  budget, timeouts, cooldown, stagger and backoff take hold immediately.
- **Restart required** — the roster is resolved once when the studio starts and
  is baked into several places, so adding, removing or renaming an agent needs a
  restart before it means anything. Changing the brief path does too.

If the file and the running studio have drifted apart, a banner says so until
you restart. That banner is expected after any roster change — it is the panel
being honest, not an error.

Fields are tagged `live` or `restart` so you can see which is which before you
save.

### Then stop it

Press `Ctrl-C` in the terminal. Your changes are in `studio_floor/config.json` and the
next start picks them up.

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
decisions, history — from `studio_floor/state/events.jsonl` next time. Stop
whenever you like.

### Pointing the team at a different project

The **Settings** tab has a *Working directory* section. Type or paste a path and
it tells you what is there before you commit — whether it is a git repo, whether
it has a brief, and how many recorded events are waiting. Then:

- **Switch and restart** — stops the agents and restarts the studio in that
  directory. If the team has worked there before, it picks up exactly where it
  left off, because that project's event log lives inside that project.
- **Switch and reset its history** — the same, but deletes that project's
  recorded history first. Its code, brief and config are untouched.

The studio works on one project at a time. Recently opened directories are
listed as buttons, so switching back is one click.

If the directory has no `PROJECT.md`, the team reads the code, works out what
the project is, drafts one, and asks you to confirm it before building anything.

### Starting over

The **Settings** tab has a *Switch and reset its history* button for this. From a
shell:

```bash
rm -rf studio_floor/state    # PowerShell: Remove-Item -Recurse -Force studio_floor/state
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

**I changed the roster in Settings and nothing happened**
Expected. The roster is resolved once when the studio starts, so adding,
removing or renaming an agent needs a restart. The panel says so on save, and
keeps a banner up until the running studio matches the file. `Ctrl-C` and
`studio start`.

**Settings says my save was refused**
It lists the reason per field. The common ones: an id with a capital or a space
(ids are lowercase letters, digits and dashes), two agents with the same id, or a
provider with no adapter installed. That last one is refused deliberately —
saving it would write a config that crashes `studio start` before it prints
anything.

**Settings will not let me set `command` / `extraArgs` / `env`**
By design — see step 9. Edit `studio.config.json` directly. Anything you set
there survives later edits made in the panel.

**Settings shows "the config file could not be read"**
The JSON is malformed. The panel refuses to overwrite a file it cannot parse,
because that would throw away whatever is in it. Fix the file by hand, then
press **Reload from file**.

**My changes vanished**
The panel does not save as you type. If you edit and switch tabs without pressing
**Save**, the draft is kept; if you press **Reload from file**, it is discarded
after a confirmation.

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
