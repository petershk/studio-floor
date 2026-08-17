# Running the studio in the cloud

The point of moving it off your laptop: the team keeps working when your machine
is asleep, and you can look in from any browser.

The studio is one Node process that needs a filesystem, a few long-lived child
processes, and a port. That rules out edge runtimes with no process model
(Cloudflare Workers, Vercel functions, Lambda) and rules *in* anything that runs
a container with a disk: Fly.io, Cloud Run with a volume, Railway, Render, a
Hetzner box, an EC2 instance, a Cloudflare **container** (not a Worker).

## Read this first

Agents in this studio run shell commands with whatever credentials the container
holds. Putting that on the internet means:

- **Anyone who reaches the API can direct them.** `/api/human/*` routes are
  indistinguishable from you, and `/api/config` can change the roster, the
  sandbox each agent runs under, and how many turns it may take.
  `STUDIO_TOKEN` is not optional off loopback. It is the only thing standing
  between a stranger and your agents.
- **The container is a blast radius, not a sandbox.** It stops an agent
  wrecking your laptop. It does not stop one exfiltrating the credentials
  mounted into it, or spending your provider budget.
- **Provider credentials have to get in somehow**, and every option is a
  trade-off (below).

Start with an agent that cannot change anything (`sandbox: "read-only"`,
`permissionMode: "default"`), on a private network, and widen from there.

## Docker

```bash
export STUDIO_TOKEN=$(openssl rand -hex 32)
docker compose up --build
```

`Dockerfile` carries the orchestrator plus the agent CLIs. It carries neither
credentials nor your project — both arrive at run time:

| mount | why |
| --- | --- |
| `/workspace` | the project the agents work on |
| `/state` | the event log; losing it loses the team's entire memory |
| `~/.claude`, `~/.codex` (ro) | provider credentials |

Pin the CLI versions in the build args. A provider CLI that changes its stdout
shape breaks the adapters, and you want that to happen when you choose.

## Credentials

Ranked by how much you should like them.

**API keys as secrets.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` etc. via your
platform's secret store, scoped to one project with a spend cap. Boring, which
is the highest compliment available here. Set them per agent if you want
separate budgets:

```json
{ "id": "builder", "provider": "claude", "env": { "ANTHROPIC_API_KEY": "…" } }
```

**Mounted credential directories.** What `docker-compose.yml` does. Fine
locally, poor in the cloud — you are copying an interactive login session onto a
remote host.

**Interactive login inside the container.** `docker exec -it … claude login`.
Works, does not survive a rebuild, and is a manual step in what should be an
automated deploy.

## Exposure

Do not publish 4173 directly. Pick one:

**SSH tunnel** — nothing is exposed at all. Best default.

```bash
ssh -N -L 4173:127.0.0.1:4173 you@your-host
```

**Reverse proxy with TLS and its own auth** — Caddy or nginx in front, plus
`STUDIO_TOKEN`. Note the UI uses **SSE**, so buffering must be off
(`proxy_buffering off;` in nginx) or the live feed arrives in lumps.

**Cloudflare Tunnel + Access** — no inbound ports, identity-based auth in front,
`STUDIO_TOKEN` behind it. The nicest option if you already use Cloudflare.

The browser passes the token as `?token=…` on first load; the CLI reads
`STUDIO_TOKEN` from its environment, which the runner passes to every agent.

## State

`/state` holds `events.jsonl` and `transcripts/`. It is append-only and it is
the team's whole memory — decisions, debates, task history, every message.

- Put it on a **persistent volume**, not the container filesystem.
- Back it up. The log is the only copy; there is no second store to recover
  from.
- Copying `events.jsonl` to another host reproduces the studio exactly. That is
  the migration path, and it is also how you take a snapshot before letting the
  team try something risky.
- `transcripts/` grows without bound (full JSONL of every turn). Rotate it if
  disk matters; nothing reads it back.

## Sizing

Each agent turn is one child process holding a provider session. Roughly 200–400
MB resident per concurrently running agent, spiky CPU during a turn, near-idle
between turns. A four-agent team is comfortable on 2 vCPU / 4 GB.

The real cost is tokens, not compute. `runner.maxTurns` is a hard per-agent
budget and the idle backoff stops an idle studio spending anything. Set
`maxTurns` deliberately before you leave one running overnight.

## Restarting

The studio rebuilds everything from the log on start, so a restart or a redeploy
loses nothing except in-flight turns — and an in-flight turn that dies leaves
its inbox unacknowledged, so its messages come back rather than vanishing.

Provider sessions do **not** survive a container replacement. Agents come back
with a fresh session, which the runner handles: the arriving agent is handed its
full accumulated inbox and the brief, so it knows what happened while it was
gone. It loses its own conversational memory of *how* it did things, not the
record of *what* was done.

## What is not built yet

Honestly, so you can plan around it:

- **No multi-tenancy.** One studio, one project, one team, one token.
- **No horizontal scale.** The server is the single writer by design. More
  agents, not more servers.
- **No managed sandbox per agent.** Isolation is whatever the container and the
  provider's own sandbox give you.
- **No cost telemetry beyond `raw.usage`.** The events carry per-turn usage and
  cost where the provider reports it; nothing aggregates or caps it yet.
