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

**The provider menu lists whatever adapters are loaded**, not a fixed three. Add
an adapter to the `adapters` list in the file and restart, and it appears in the
dropdown for every agent. What the panel cannot do is *register* a new provider —
that means importing a JavaScript file, which is the next paragraph.

If the roster names a provider with no adapter, the panel shows it as
`name (no adapter)` and warns on the card rather than silently displaying the
first provider in the list. Saving an unrelated field still works and repeats the
warning; introducing a provider with no adapter is refused outright, because the
studio would then fail to start.

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

`studio_floor/config.json` inside the project, or wherever `STUDIO_CONFIG`
points. Written by `studio init`; every key has a default, so a studio with no
config at all is a valid studio.

A project set up before this layout — with `studio.config.json` at the root and
`.studio/` for state — keeps working exactly as it did. The studio uses whichever
layout it finds and never migrates one to the other on its own, because doing so
silently would orphan that project's event log.

```json
{
  "project": {
    "name": "My Game",
    "brief": "PROJECT.md",
    "goal": "One paragraph, for agents that have not read the brief yet.",
    "workDir": "."
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
    "maxWallMs": 0,
    "maxSpendUsd": 0,
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
| `workDir` | **where the team works, and required before any agent starts.** `"."` for the whole project, or a subdirectory of it. Unset, every agent stays idle; a directory that is or contains the studio's own code is refused. `studio init` sets it to `"."`. |
| `commitTo` | `branch` (default) gives every task its own `studio/<task>` branch; `current` commits on whatever is checked out. |

Agents are launched in `workDir` and told it is the only directory they may
look at. The CLIs' own sandboxes keep writes there; reads from a shell command
are not blocked by any of them, so a container is the way to contain those.

If the brief file does not exist, agents are told so explicitly and instructed
to ask you rather than guess. That is deliberate: a team that invents its own
project is the worst possible failure for a tool like this.

## `agents`

Order matters — it is the order in the UI and the order agents are started in.

| key | meaning |
| --- | --- |
| `id` | **required.** What the team calls it. Lowercase letters, digits, dashes. Must be unique. |
| `provider` | which adapter to use: `claude`, `codex`, `grok`, `gemini`, or one you added. Defaults to `id`. |
| `label` | display name. Derived from the id if omitted. |
| `persona` | a built-in name, or your own text. See below. |
| `model` | passed to the provider. Empty means the CLI's default. |
| `command` | override the executable — a wrapper script, or a pinned version. |
| `extraArgs` | extra CLI arguments, appended verbatim. |
| `env` | extra environment variables for that agent's process. Agents inherit only what a CLI needs to run, so this is how you add anything else. |

Provider-specific:

| key | provider | meaning |
| --- | --- | --- |
| `sandbox` | codex | `read-only`, `workspace-write` (default), or `full`. |
| `permissionMode` | claude, grok, gemini | `auto` (default), `acceptEdits`, `default`. For Gemini these map to its `yolo`, `auto_edit` and `default` approval modes. |
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

## Pointing an agent at another backend

Kimi, GLM, DeepSeek and others publish **Anthropic-compatible endpoints** so that
Claude Code can talk to them. They therefore need no adapter of their own — a
second adapter would be `claude.mjs` with a different URL. Point the existing one
somewhere else instead:

```json
{ "id": "kimi", "preset": "kimi", "persona": "implementer",
  "model": "kimi-k2-turbo-preview" }
```

A **preset** supplies the endpoint, the name of the variable to read the key
from, and which CLI does the talking. Built in:

| preset | CLI it uses | endpoint |
| --- | --- | --- |
| `kimi` | Claude Code | Moonshot's Anthropic-compatible API |
| `glm` | Claude Code | Zhipu's Anthropic-compatible API |
| `grok` | Codex | the xAI API |

Anything you state yourself wins over the preset, so it is a starting point
rather than an override.

`grok` is the odd one, and worth understanding before you copy it. The studio
drives CLIs rather than APIs — an adapter launches a program and reads its
stdout — so a model needs *some* CLI to act as its harness. Grok's own CLI is a
native binary rather than an npm package, so a container that installs its tools
from npm cannot have one. Codex can be pointed at any provider, so it is the
harness instead. That is also why the preset does not use xAI's
Anthropic-compatible endpoint through Claude Code, which would have been the
smaller change: xAI has deprecated that compatibility layer.

Without a preset, state it directly:

| key | meaning |
| --- | --- |
| `baseUrl` | the API endpoint. Must be https, or localhost for a local proxy. |
| `apiKeyEnv` | the **name** of an environment variable holding the key. Preferred. |
| `apiKey` | the key itself. Works, but see below. |

**Prefer `apiKeyEnv`.** `studio_floor/config.json` is a file worth committing, and
a literal key in it is a key in your git history. Naming a variable keeps the
secret out of the repository; the panel warns when it finds a literal one, and
never echoes a key back to the browser.

These are the only credential fields the settings panel may write, and only
because they are data. Raw `env` stays file-only: `NODE_OPTIONS` changes what
code runs, a base URL does not.

Only the endpoint is built in, never a model name — those move faster than this
file can, and a stale default silently routing to a retired model is worse than
being asked for one.

## `security`

File-only, and the settings panel is not allowed to write it. The panel may
change how much freedom agents have inside their directory; it may not decide
whether that directory is a wall. Same line `command` and `adapters` sit on, and
for the same reason.

```json
"security": { "confineAgents": "auto", "agentUser": "studio-agent" }
```

| key | meaning |
| --- | --- |
| `confineAgents` | `auto` (default) runs agent turns as `agentUser` wherever it can, and **requires** it once the studio is shared — a token set, or bound off loopback. `require` always demands it. `off` accepts that agents can read whatever the studio can. |
| `agentUser` | the unprivileged account agent turns run as. The Docker image creates `studio-agent`. |

Confinement needs root on a POSIX host: only root may become another user. In
the container that is the normal case. On a laptop it is not, so a private
loopback studio runs unconfined and says so, in the banner, in `studio doctor`
and in the panel.

When it is on, the studio **takes ownership of the work directory** for the
agent user, seals its own state (`studio_floor/`) to itself, and makes the path
down to the work directory enterable but not listable, so sibling repositories
stay invisible. A CLI login must then be made as that user:

```bash
docker compose exec -u studio-agent studio claude /login
```

A login made as root lands in root's home, where the agents cannot read it.

## `adapters`

Paths (resolved against the project directory) or package names, loaded before
the roster is resolved. See [ADAPTERS.md](ADAPTERS.md).

## `prices`

Optional. Dollars per **million** tokens, keyed by provider. Only needed for
providers that do not report their own cost — Claude Code and Grok both report
theirs, and a reported cost is always used in preference to an estimate.

```json
"prices": {
  "codex": { "input": 1.25, "output": 10, "cacheRead": 0.125 }
}
```

`cacheRead` and `cacheWrite` fall back to the `input` rate when omitted, which
understates the saving from cached input and overstates the cost of writing it.

**Everything the Usage tab shows is an estimate.** It is arithmetic on token
counts and per-token rates. Your actual bill can be very different: plans,
credits, discounts, minimums, batch rates and subscription allowances all change
what you are really charged, and some providers are not billed per token at all
— a ChatGPT-authenticated Codex draws on a plan allowance and has no per-token
invoice to compare against. Use the tab to compare runs and to notice one
getting expensive. Consult each provider's own billing pages for what you owe.

**No rate card ships with the studio, and that is deliberate.** A built-in table
would be confidently wrong the day a vendor changed its pricing, and a wrong bill
is worse than no bill. Until you set prices, the Usage tab counts tokens for
those providers and says plainly that their spend is not in the total. Anything
derived from your rates is labelled `est`.

## `runner`

| key | meaning |
| --- | --- |
| `maxTurns` | per-agent turn budget. The agent stops when it is reached. |
| `maxWallMs` | how long this run may last. `0` (default) means no limit. Checked before each turn; stops the whole team. |
| `maxSpendUsd` | dollars this run may spend, measured from its start. `0` (default) means no limit. Checked before each turn; stops the whole team. A provider that reports no cost and has no rate in `prices` contributes nothing, so this can undercount. |
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

`STUDIO_PORT` and `STUDIO_HOST` override these, so a container or a one-off run
can move the address without editing a committed config. An environment variable
that is set but empty counts as unset; `STUDIO_PORT=0` does not, and asks the OS
for a free port.

## Environment variables

Environment wins over the config file, which is what makes containerising this
straightforward.

| variable | effect |
| --- | --- |
| `STUDIO_PROJECT_ROOT` | the project the agents work in. Same as `--project`. |
| `STUDIO_CONFIG` | path to the config file. |
| `STUDIO_STATE_DIR` | where the event log lives. Default `<project>/studio_floor/state` (`<project>/.studio` in a legacy-layout project). Point it at a volume in a container. |
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
