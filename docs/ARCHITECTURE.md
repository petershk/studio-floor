# Architecture

```
src/
  core/
    paths.mjs      where everything lives; the only place that knows the layout
    config.mjs     read and normalise studio_floor/config.json
    roster.mjs     the resolved team, loaded once per process
    events.mjs     the event vocabulary and one-line renderer
    store.mjs      the append-only log and every projection of it
    heartbeat.mjs  proof the studio is alive, left where it outlives the process
  agents/
    adapters/      one file per vendor CLI, plus the registry
    prompts.mjs    what agents are actually told
    runner.mjs     bounded turns, sessions, wake-on-mention
  server/
    server.mjs     the single writer; HTTP + SSE
  cli/
    studio.mjs     the channel agents speak through
  bin/
    serve.mjs      one studio: the log, the server and the agents, bound to one project
    supervise.mjs  restarts the studio after a switch, an update or a crash
    rehearse-restart.mjs  would a restart work? replays a copy of the live log, read-only
  web/             what the human watches, including the settings panel
  index.mjs        the programmatic entry point
```

## The log is the only truth

Everything that happens is one line in `studio_floor/state/events.jsonl`:

```json
{"seq":41,"ts":"…","kind":"task.updated","agent":"builder","data":{…}}
```

Agents, tasks, decisions, debates, the timeline, the raw feed and project health
are **projections** — rebuilt from scratch by replaying the log on startup
(`core/store.mjs`). There is no second store to fall out of sync with, nothing
can appear in the interface that did not actually happen, and restarting loses
nothing.

The server process is the only writer. Agents reach it over HTTP through the
CLI, so N processes can never interleave a half-written line and there is no
file locking to get wrong.

On load, a torn final line (crash mid-write) is quarantined, truncated off, and
recorded as a `log.recovered` event. A final line that parses but lacks its
newline is repaired rather than treated as torn. A corrupt line in the *middle*
refuses to start — that is corruption, not a crash, and guessing would be worse.

## Event kinds

| prefix | what it covers |
| --- | --- |
| `studio.*` | lifecycle of the studio itself |
| `agent.*` | identity, presence, self-reported state |
| `message.*` | observable agent-to-agent communication |
| `task.*` | explicit units of work |
| `decision.*` | durable project knowledge |
| `memory.*` | the small durable working set handed to every turn |
| `debate.*` | structured disagreement |
| `attention.*` | things that genuinely want the human |
| `work.*` | files touched, validation runs, discoveries |
| `human.*` | the human's interventions |
| `inbox.*` | delivery bookkeeping: what was shown, what was confirmed |
| `raw.*` | the lowest-level observable activity a CLI exposes |

`raw.*` is streamed and stored but kept out of the timeline. `inbox.*` is
durable bookkeeping and kept out of both the timeline and every inbox.

## Turns

Each agent is a loop:

1. Is there a reason to spend a turn? (inbox, owned task, review waiting,
   unclaimed work, an open debate you have not taken a position in) If not,
   sleep with escalating backoff.
2. Read the inbox and the brief. Build a prompt.
3. Spawn the provider CLI for one bounded headless turn, resuming its session.
4. Stream stdout through the adapter into events.
5. On a clean exit, acknowledge the inbox.

Between turns the runner injects what changed — the inbox, the brief, and why it
was woken. That injection is the entire difference between a team and several
agents answering the same prompt.

None of this starts until a human has chosen where the team works.
`agentReadiness` in `core/config.mjs` holds every agent idle while
`project.workDir` is unset, and refuses one that is or contains the studio's own
code. It used to default to wherever the studio was launched, which from inside
the studio's clone meant the agents' first project was the tool running them.

An agent is woken when it is addressed, when a task naming it as owner or
reviewer changes, when a debate opens, and when the human says anything. Not on
a timer.

Three turns without any studio activity puts an agent to sleep until something
happens. Without that an idle studio burns tokens re-reading its own empty
inbox.

## Failure handling that exists because it was needed

Each of these was a bug that silently lost a human's words.

**The inbox acknowledges only on a completed turn.** A crashed or killed turn
leaves its items unacknowledged; the next turn is handed them again, marked as a
redelivery. Losing a message because a process died is exactly the silent
failure this studio exists to expose.

**A shortened prompt acknowledges nothing.** Prompts over the command-line
budget are cut from the *middle*, not the tail — the tail is where the human's
directive and the turn instructions live, and the middle is the brief, which is
regenerable and which the inserted note tells the agent to re-fetch. Even so,
the whole inbox goes unacknowledged, because we cannot prove what survived the
cut. Failing closed costs one repeated inbox; failing open loses the human's
words silently.

**A launch failure is not a turn failure.** If the provider never started,
nothing changed and retrying immediately just reproduces it. After three in a
row the agent stops and raises an attention item, instead of generating
thousands of identical errors with no single event saying the team is down.

**A failed resume mints a fresh session.** Detected from stderr. The arriving
agent then gets its full accumulated inbox, because a lost session used to look
like a first turn and first turns used to skip the inbox.

**Delivery cursors are events, not a side file.** They used to live in a
`cursors.json` that was written and never read, so every restart replayed the
entire history at every agent.

**"Human" is a claim about who spoke.** Anything that did not arrive through the
browser UI is rendered as `Human[via …]`, so a stray script cannot impersonate
the person in charge. That happened once: a probe against a live server appeared
to two agents as a directive from the creative director, and they spent part of
a turn reasoning about it.

## What an agent is handed

An agent's process is built from an allowlist (`agents/child-env.mjs`), not from
the studio's environment. It gets what a CLI needs to run — PATH, a home
directory, locale, proxy settings — its own provider key, and its own studio
credential. It does not get `STUDIO_TOKEN`, the git token, the tunnel token, or
any other agent's key.

That credential is scoped twice over: to the agent routes (`/api/state`,
`/api/events`, `/api/inbox*`, `/api/action`) and to the agent it belongs to. An
agent cannot rewrite the config, speak as the human, stop a colleague, read the
secrets route, switch project, or put another agent's name on its own work.

All of it was reachable before, because every agent was spawned with the
studio's whole environment and so held the human's token. An agent that
disagreed with its sandbox could widen it and then use it, and the log would
show the human doing it.

The filesystem is the other half, and `core/confine.mjs` is where it lives. Agent
turns run as their own unprivileged user: the work directory is owned by that
user, and the event log, the config, the stored keys and every other project are
not readable by it. What stops an agent reading the studio's memory is then a
permission it lacks rather than an instruction it was given.

That needs root on a POSIX host, which the container has and a laptop does not.
So `security.confineAgents: auto` confines wherever it can, and *requires* it
once the studio is shared — a token set, or bound off loopback. A shared studio
that cannot confine holds its agents exactly as an unset work directory does.
`off` is an operator saying out loud that agents may read whatever the studio
can, which is what keeps `npm start` on a laptop working.

Applying the plan stops at the first failure, because a half-applied plan is a
studio that believes it is confined and is not.

## The brief

Every turn's prompt embeds a rendered snapshot of shared state: roster, memory,
tasks, decisions already made, open debates, unresolved questions, what is
waiting on the human, recent discoveries, and recent conversation.

Memory sits near the head deliberately. Truncation takes the tail, and memory is
the one section that is still true after a vendor session is lost — the section
whose whole purpose is to survive an agent that has forgotten everything else.
Rendering it once per turn is also what freezes it: an entry written mid-turn
lands on disk immediately and appears in the next turn's prompt, so the prompt a
turn is running against never changes underneath it.

Every unbounded section of it is capped (`BRIEF_LIMITS` in `runner.mjs`). They
were all uncapped once; the brief grew with the studio's history until the
command line crossed the OS limit and every agent failed to launch at the same
moment. Truncation says plainly what was cut and how to get the rest.

## Configuration is a write API

The settings panel edits `studio_floor/config.json` over HTTP, making it a write
API to the thing that decides which programs this machine runs. Three properties
keep that safe, and all three are load-bearing.

**An allowlist, not a filter.** `AGENT_EDITABLE` and friends in `core/config.mjs`
name what may be written. Per-agent `command`, `extraArgs` and `env`, and the
top-level `adapters` list, are refused — they choose the executable, its
arguments, its environment, and which JavaScript is imported at boot. The server
sets `Access-Control-Allow-Origin: *`, so a writable version of those is remote
code execution reachable from any tab the human has open.

**Origin is checked on write.** A browser always sends `Origin` on a
cross-origin POST and cannot be talked out of it, so a present-and-foreign
Origin is rejected. An absent Origin is curl or the CLI — callers who can
already run code here.

**Edits patch the file as written.** Not the normalised config. Writing the
normalised form back would bake in every default and drop the fields the API
refuses to manage, so saving the roster from the UI would silently delete a
hand-written `command`. Unmanaged fields are carried across per agent, matched
by id.

What can be applied without a restart is decided by what the runner actually
re-reads: it consults `this.config` every loop iteration, so timings are live,
while `AGENT_IDS` is resolved once at import into the store, the server and the
runner's agent map, so the roster is not. The panel reports which happened
rather than implying everything took effect, and every save lands in the event
log as a `human.control` event.

## The web UI

Plain ES modules, no build step, no dependencies. Live events arrive over SSE;
`raw.*` is appended straight to the raw feed, anything that changes shared state
triggers a debounced refetch of the whole projection — which keeps every view
honest with a trivial amount of code.

A reconnecting stream replays from its last sequence. Beyond the backfill limit
the server sends a `gap` frame and the client re-primes rather than leaving a
hole.

The roster is learned from `/api/state`, never hardcoded, and each agent gets a
palette slot so a team of one provider is still visually distinguishable.
