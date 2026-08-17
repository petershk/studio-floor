# Configuration

Most of this is editable from the **Settings** tab in the studio's web UI, which
is the easier way in. This page is the reference, and the authority for the
fields the panel deliberately will not touch.

## The Settings panel

`studio start`, then open http://127.0.0.1:4173 and pick **Settings**. You can
add, remove and reorder agents, change ids, providers, personas, models,
sandboxes and permission modes, edit the project name, brief and goal, and set
every runner tunable.

Two things about it are worth knowing.

**It tells you what actually took effect.** The runner re-reads its own settings
every loop, so turn budgets, timeouts, cooldown, stagger and backoff apply the
moment you save. The roster does not work that way — `AGENT_IDS` is resolved once
at import and baked into the store's projection, the server's validation and the
runner's agent map — so adding or removing an agent needs a restart. The panel
says which happened, per save, rather than implying everything is live. If the
file and the running studio have diverged it says that too.

**It cannot change which program runs.** Per-agent `command`, `extraArgs` and
`env`, and the top-level `adapters` list, are refused by the API and not
rendered. They decide what executable is spawned, with what arguments, in what
environment, and which JavaScript is imported at boot. The server answers on
loopback with `Access-Control-Allow-Origin: *`, so a writable-over-HTTP version
of those fields would be remote code execution reachable from any tab you have
open. Cross-origin writes to the config are rejected outright for the same
reason. Edit those in the file.

An edit made in the panel preserves them: they are carried across per agent,
matched by id, so saving the roster from the UI will not delete a hand-written
`command`. Every save is recorded in the event log as a `human.control` event,
so a change to what the agents are allowed to do shows up in the timeline.

---

`studio.config.json` in the project directory, or wherever `STUDIO_CONFIG`
points. Written by `studio init`; every key has a default, so a studio with no
config is a valid studio.

```json
{
  "project": {
    "name": "My Game",
    "brief": "PROJECT.md",
    "goal": "One paragraph, for agents that have not read the brief yet."
  },
  "agents": [
    { "id": "architect", "provider": "claude", "persona": "architect" },
    { "id": "builder",   "provider": "claude", "persona": "implementer",
      "model": "claude-sonnet-5" },
    { "id": "breaker",   "provider": "grok",   "persona": "adversary" },
    { "id": "scout",     "provider": "codex",  "persona": "researcher",
      "sandbox": "read-only" }
  ],
  "adapters": ["./adapters/gemini.mjs"],
  "runner": {
    "maxTurns": 200,
    "turnTimeoutMs": 1200000,
    "cooldownMs": 4000,
    "staggerMs": 10000,
    "idleBackoffMs": [15000, 30000, 60000, 120000],
    "commandLineBudget": 28000
  },
  "server": { "port": 4173, "host": "127.0.0.1", "token": null }
}
```

## `project`

| key | meaning |
| --- | --- |
| `name` | shown in the UI and the browser tab. Defaults to the directory name. |
| `brief` | the file agents read first. Default `PROJECT.md`. |
| `goal` | optional one-paragraph summary injected into the first-turn prompt. |

If the brief file does not exist, agents are told so explicitly and instructed
to ask you rather than guess. That is deliberate: a team that invents its own
project is the worst possible failure for a tool like this.

## `agents`

Order matters — it is the order in the UI and the order agents are started in.

| key | meaning |
| --- | --- |
| `id` | **required.** What the team calls it. Lowercase letters, digits, dashes. Must be unique. |
| `provider` | which adapter to use. Defaults to `id`, which is why `{"id":"claude"}` alone works. |
| `label` | display name. Derived from the id if omitted. |
| `persona` | a built-in name, or your own text. See below. |
| `model` | passed to the provider. Empty means the CLI's default. |
| `command` | override the executable — a wrapper script, or a pinned version. |
| `extraArgs` | extra CLI arguments, appended verbatim. |
| `env` | extra environment variables for that agent's process. |

Provider-specific:

| key | provider | meaning |
| --- | --- | --- |
| `sandbox` | codex | `read-only`, `workspace-write` (default), or `full`. |
| `permissionMode` | claude, grok | `auto` (default), `acceptEdits`, `default`. |
| `disableMcp` | claude | default `true`. MCP servers load per turn and cost real seconds on every turn of every agent. |

`codex` with `sandbox: "workspace-write"` has **no network access**, so it cannot
`npm install` or download assets. Raise it to `"full"` when the team needs that,
knowing what that means.

### Personas

Built in: `implementer`, `architect`, `adversary`, `researcher`, `integrator`.
Any other string is used verbatim.

Every built-in ends with *"you are not obliged to accept that framing — tell the
team what you actually think you are best at."* Keep that spirit in your own: a
team where every agent was handed the same framing produces agents who agree
with each other, and agreement is not what you are paying for.

Give agents on the same provider **different** personas. Two identical Claudes
will reach the same conclusion twice and call it consensus.

## `adapters`

Paths (resolved against the project directory) or package names, loaded before
the roster is resolved. See [ADAPTERS.md](ADAPTERS.md).

## `runner`

| key | meaning |
| --- | --- |
| `maxTurns` | per-agent turn budget. The agent stops when it is reached. |
| `turnTimeoutMs` | a turn is killed if it runs longer than this. |
| `cooldownMs` | pause between an agent's turns, so it cannot spin. |
| `staggerMs` | delay between agent starts, so they do not all boot into the same second. |
| `idleBackoffMs` | escalating wait when an agent has nothing to do. |
| `commandLineBudget` | prompts longer than this are cut from the middle. Windows refuses a command line over 32767 characters, and the failure happens before the process exists. |

## `server`

| key | meaning |
| --- | --- |
| `port` | default 4173. |
| `host` | default `127.0.0.1`. Set `0.0.0.0` to expose it. |
| `token` | shared secret required by every `/api/*` route. Null means an open local server. |

## Environment variables

Environment wins over the config file, which is what makes containerising this
straightforward.

| variable | effect |
| --- | --- |
| `STUDIO_PROJECT_ROOT` | the project the agents work in. Same as `--project`. |
| `STUDIO_CONFIG` | path to the config file. |
| `STUDIO_STATE_DIR` | where the event log lives. Default `<project>/.studio`. Point it at a volume in a container. |
| `STUDIO_PORT` | port. `0` picks a free one and prints it. |
| `STUDIO_HOST` | bind address. |
| `STUDIO_URL` | how agents reach the server. Set when it is not on loopback. |
| `STUDIO_TOKEN` | auth token. Overrides `server.token`. |
| `STUDIO_CMD` | how agents invoke the studio CLI. Defaults to an absolute `node …/cli/studio.mjs`. |
| `STUDIO_STREAM_BACKFILL` | how far a reconnecting SSE client replays. Default 2000. |

## The old flat format

The pre-1.0 shape still loads and is translated, so upgrading does not silently
change your team:

```json
{ "agents": ["codex", "claude", "grok"],
  "maxTurns": 200, "codexSandbox": "workspace-write", "claudeModel": "" }
```

Run `studio start` once and check the roster line it prints matches what you
expect, then move to the new shape.
