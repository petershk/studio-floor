# Studio Floor

Several AI coding agents working as a **team** on one project, in one directory,
while a human watches and directs through a browser.

The agents divide the work themselves, hand each other tasks, argue about
approach, review each other's output, record what they settled, and escalate the
things that genuinely need you. You watch all of it happen live and can step in
at any point — every message, task, decision and tool call is one line in an
append-only log, and every view is a projection of that log.

```
  claude            codex             grok           ← real agent CLIs, one process per turn
     │                │                 │
     │  stdout JSONL  │                 │            ← adapters normalise each vendor's
     └────────────────┴─────────────────┘               format into one raw-event vocabulary
                      │
                  runner                              ← bounded turns, resumed sessions,
                      │                                  wakes an agent when it is addressed
                      ▼
  studio CLI  ──▶  server  ──▶  .studio/events.jsonl  ← the only writer; append-only log
  (agents talk)      │  ▲                                is the single source of truth
                     ▼  │  SSE
                   web UI                             ← what the human watches
```

## Quickstart

**New here? Follow [docs/QUICKSTART.md](docs/QUICKSTART.md)** — it starts from an
empty machine and assumes nothing.

The short version. You need Node 20+, git, and at least one agent CLI installed
**and signed in** — [Claude Code](https://claude.com/claude-code),
[OpenAI Codex](https://developers.openai.com/codex), or Grok. The studio launches
those CLIs; you install them and sign in yourself.

```bash
# 1. install the studio (zero dependencies — clone and link, that is the build)
#    Put the clone somewhere permanent — npm link points at it.
git clone https://github.com/petershk/studio-floor.git
cd studio-floor
npm link

# 2. make a directory for your project and put it under git FIRST.
#    This is a new local repo for YOUR project — unrelated to studio-floor,
#    which is the tool you just installed. Already have a project? Skip the
#    init and cd into it instead.
mkdir ~/my-project
cd ~/my-project
git init

# 3. set it up
studio init                # writes PROJECT.md and studio.config.json

# 4. write PROJECT.md — this is the step that decides whether it works
$EDITOR PROJECT.md

# 5. check the CLIs are installed, then go
studio doctor
studio start
```

Open **http://127.0.0.1:4173**. `Ctrl-C` stops everything, and the next start
rebuilds the studio's entire world from the log — conversation, tasks, decisions
and all.

Three things worth knowing before your first run:

- **`git init` first.** Agents edit files and run commands. Git is the
  difference between "undo that" and "it is gone". This is your project's own
  repo — it has no remote and nothing to do with the studio's repo.
- **Set `runner.maxTurns` to 10–20** in `studio.config.json` for the first run.
  The default is 200 per agent, and every turn is a real model call.
- **`studio start --no-agents`** serves the UI on its own, so you can explore it
  for free before a single token is spent.

The full walkthrough — what a good `PROJECT.md` looks like, what the first ten
minutes should look like, cost control, and what to do when it misbehaves — is
in **[docs/QUICKSTART.md](docs/QUICKSTART.md)**.

## Configure the team

`studio.config.json` is the roster. An agent has an **id** (what the team calls
it), a **provider** (which CLI to launch), and a **persona** (what it is for).
The id and the provider are separate on purpose: five agents can run on one
model wearing five different hats.

```json
{
  "project": { "name": "My Game", "brief": "PROJECT.md" },
  "agents": [
    { "id": "architect", "provider": "claude", "persona": "architect" },
    { "id": "builder",   "provider": "claude", "persona": "implementer",
      "model": "claude-sonnet-5" },
    { "id": "breaker",   "provider": "grok",   "persona": "adversary" },
    { "id": "scout",     "provider": "codex",  "persona": "researcher",
      "sandbox": "read-only" }
  ]
}
```

Built-in personas: `implementer`, `architect`, `adversary`, `researcher`,
`integrator`. Any other string is used verbatim, so write your own.

Every persona ends with *"you are not obliged to accept that framing"* on
purpose — an agent that believes it is better at something else should say so on
its first turn. Give them genuinely different jobs. Productive disagreement is
the whole point, and three agents handed the same framing will simply agree with
each other.

The **Settings** tab edits all of this as a form. It tells you exactly which
changes took effect immediately and which need a restart, and confines itself to
fields that cannot change *which program runs* — see
[docs/CONFIG.md](docs/CONFIG.md) for every key and why that line sits where it
does.

## Add a provider

An adapter is one file: how to launch the CLI fresh, how to resume the session
it opened last turn, and how to read its stdout. It is the only code in the
studio that knows a vendor exists — everything else stays provider-agnostic.

```js
// adapters/gemini.mjs
export default {
  id: 'gemini',
  command: 'gemini',
  newSession: () => crypto.randomUUID(),
  args: ({ prompt, sessionId, fresh }) => [...],
  parse: (line) => [{ kind: 'raw.text', data: { text: line.text } }],
};
```

```json
{ "adapters": ["./adapters/gemini.mjs"],
  "agents": [{ "id": "gem", "provider": "gemini" }] }
```

See [docs/ADAPTERS.md](docs/ADAPTERS.md).

## What the human gets

| view | what it answers |
| --- | --- |
| top bar | how many agents are active, what is in flight, what awaits you |
| agents | what each is doing right now, its task, its last tool call |
| needs you | escalations that genuinely want a human, with approve / reject / reply |
| conversation | what the agents are saying to each other, verbatim |
| timeline | chronological history; click through to the task or agent behind it |
| tasks | the board, proposed → done, with full history per task |
| decisions & debates | open disagreements and settled questions, with reasoning |
| raw | the lowest-level observable activity, filterable by agent and kind |
| settings | the roster and runner tunables, edited visually as a form |

Controls: pause, resume, stop, per-agent start/stop/nudge, set a priority, send
a message to one agent or all, and answer any escalation.

## How it works

**The log is the only truth.** Everything is one line in `.studio/events.jsonl`.
Agents, tasks, decisions, debates, the timeline and the raw feed are all
projections rebuilt from it on startup. Everything the interface shows actually
happened, and a restart restores all of it. The server is the sole writer, so
every line from every concurrent agent lands whole.

**Agents run in bounded turns.** Each agent loops headless turns against its own
persistent, resumable session. Between turns it blocks on its inbox, so it wakes
the moment someone addresses it rather than ticking on a timer. The runner hands
it what changed — the inbox, the brief, and why it was woken. That injection is
what turns separate vendor CLIs into a team rather than several agents answering
the same prompt.

After three turns without studio activity an agent sleeps until something
happens, so an idle studio costs you nothing.

**Every raw event is kept.** `raw.*` events carry the lowest level each CLI
exposes: text, reasoning where the vendor emits it, tool calls, results, usage,
errors. The full JSONL of every turn also lands in
`.studio/transcripts/<agent>-turn-NNN.jsonl`. The studio reports exactly what the
vendor exposed and stays silent about the rest — where Codex keeps its internal
reasoning private, you see that it is private.

**Every claim is backed by something observed.** Inbox items are acknowledged
only by a turn that actually finished; a crashed turn's items come back marked as
a redelivery. If a prompt has to be shortened to fit the OS command-line limit,
the acknowledgement fails closed. Each of these is a real bug that silently ate a
human directive before it was caught.

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Running it in the cloud

The studio is a single Node process with a filesystem, so it containerises
directly. See [docs/CLOUD.md](docs/CLOUD.md) for the Docker image, the state
volume, the auth token, and the provider-credential problem you have to solve
before exposing it.

**Set `STUDIO_TOKEN` before you bind this to any public address.** Anyone who
can reach the API can direct agents that run shell commands as you.

## Safety

The defaults let agents edit their project directory and run commands without
asking. That is what makes them team members rather than assistants. It also
means several agents are running commands on your machine with your credentials.

To watch before trusting it, start read-only:

```json
{ "agents": [
  { "id": "a", "provider": "codex",  "sandbox": "read-only" },
  { "id": "b", "provider": "claude", "permissionMode": "default" }
]}
```

They plan, talk, disagree and decide exactly as they otherwise would, and leave
every file on disk untouched.

## Tests

```bash
npm test                        # 19 files, offline, free, ~30s
node test/adapter-check.mjs     # launches the real CLIs with a trivial prompt
node test/launch-check.mjs      # measures prompt size against a running studio
```

`npm test` drives the whole collaboration loop against a throwaway state
directory: agents joining, talking, delegating, disagreeing, deciding,
completing, reviewing, escalating, crashing mid-turn, and a human intervening.
The run prints a digest of the tree it ran against, so two people comparing
results can tell instantly whether they ran the same code.

## Credits

Grown out of a working three-agent studio (Codex, Claude and Grok building
software together in one directory) and generalised into a tool. Many of the
sharper details in this codebase — the middle-out prompt truncation, the
fail-closed inbox acknowledgement, the tree digest in the test report — exist
because those agents found the bug in each other's work.

MIT.
