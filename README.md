# Agent Studio

Several AI coding agents working as a **team** on one project, in one directory,
while a human watches and directs through a browser.

Not "run three prompts in parallel". The agents divide the work themselves, hand
each other tasks, argue about approach, review each other's output, record what
they settled, and escalate the things that genuinely need you. All of it is
visible, live, and replayable — because every single thing that happens is one
line in an append-only log, and every view is a projection of that log.

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

## Quick start

You need Node 20+ and at least one agent CLI on your PATH
([Claude Code](https://claude.com/claude-code), OpenAI Codex CLI, or Grok CLI).

```bash
npm install -g agent-studio     # or: git clone … && npm link

cd ~/my-project
studio init                     # writes studio.config.json and PROJECT.md
$EDITOR PROJECT.md              # say what you actually want built
studio doctor                   # check the CLIs are installed
studio start
```

Open **http://127.0.0.1:4173**.

`Ctrl-C` stops the agents and the server. Nothing is lost — the studio rebuilds
its whole world from the log on the next start.

## Configure the team

`studio.config.json` is the roster. An agent has an **id** (what the team calls
it), a **provider** (which CLI to launch), and a **persona** (what it is for).
An id is not a provider, which is the point: you can run five agents on one
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
purpose. A team where every agent was told it is a strong implementer produces
three implementers who agree with each other, which is the failure this whole
project exists to avoid.

See [docs/CONFIG.md](docs/CONFIG.md) for every key.

## Add a provider

An adapter is one file: how to launch the CLI fresh, how to resume the session
it opened last turn, and how to read its stdout. Nothing else in the studio
knows a vendor exists.

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

Controls: pause, resume, stop, per-agent start/stop/nudge, set a priority, send
a message to one agent or all, and answer any escalation.

## How it works

**The log is the only truth.** Everything is one line in `.studio/events.jsonl`.
Agents, tasks, decisions, debates, the timeline and the raw feed are all
projections rebuilt from it on startup. Nothing can appear in the interface that
did not actually happen, and restarting loses nothing. The server is the only
writer, so concurrent agents can never interleave a half-written line.

**Agents run in bounded turns.** Each agent loops headless turns against its own
persistent, resumable session. Between turns it blocks on its inbox, so it wakes
because someone addressed it — not on a timer. The runner injects what changed:
the inbox, the brief, and why it was woken. That is what makes separate vendor
CLIs behave like a team rather than several agents answering the same prompt.

A turn that produces no studio activity three times running puts that agent to
sleep until something happens, so an idle studio does not burn tokens re-reading
its own empty inbox.

**Raw activity is never discarded.** `raw.*` events carry the lowest level each
CLI exposes: text, reasoning where the vendor emits it, tool calls, results,
usage, errors. Full JSONL of every turn is also written to
`.studio/transcripts/<agent>-turn-NNN.jsonl`. Where a vendor does not expose
something — Codex's internal reasoning, for instance — the studio shows nothing
rather than inventing it.

**Nothing is claimed that was not observed.** Inbox items are acknowledged only
by a turn that actually finished; a crashed turn's items come back marked as a
redelivery. If a prompt has to be shortened to fit the OS command-line limit,
the acknowledgement fails closed. These are not hypotheticals — each one is a
bug that silently ate a human directive before it was fixed.

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Running it in the cloud

The studio is a single Node process with a filesystem, so it containerises
directly. See [docs/CLOUD.md](docs/CLOUD.md) for the Docker image, the state
volume, the auth token, and the provider-credential problem you have to solve
before exposing it.

**Do not bind this to a public address without `STUDIO_TOKEN`.** Anyone who can
reach the API can direct agents that run shell commands as you.

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

They will still plan, talk, disagree and decide. They just will not change
anything.

## Tests

```bash
npm test                        # 18 files, no tokens spent, no network
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
