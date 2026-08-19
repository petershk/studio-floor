# Running the studio in the cloud

The point of moving it off your laptop: the team keeps working when your machine
is asleep, you can look in from any browser, and you can point it at a repository
without first copying that repository onto your laptop.

The studio is one Node process that needs a filesystem, a few long-lived child
processes, and a port. That rules out edge runtimes with no process model
(Cloudflare Workers, Vercel functions, Lambda) and rules *in* anything that runs
a container with a disk: a plain VM, Fly.io, Cloud Run with a volume, Railway,
Render, a Cloudflare **container** (not a Worker).

A small VM you own is the path this document takes, because the compose file
already describes it exactly and there is nothing to work around. 2 vCPU / 4 GB
is comfortable for a four-agent team.

## Read this first

Agents in this studio run shell commands with whatever credentials the container
holds. Putting that on the internet means:

- **Anyone who reaches the API can direct them.** `/api/human/*` routes are
  indistinguishable from you; `/api/config` can change the roster, the sandbox
  each agent runs under, and how many turns it may take; `/api/projects/clone`
  puts code on the box. `STUDIO_TOKEN` is not optional off loopback. It is the
  only thing standing between a stranger and your agents.
- **The container is a blast radius, not a sandbox.** It stops an agent wrecking
  your laptop. It does not stop one exfiltrating the credentials mounted into
  it, or spending your provider budget.
- **A git token in the container is usable by everything in the container.**
  That includes an agent having a bad day. Scope it to the repositories you are
  willing to lose an afternoon over.

Start with an agent that cannot change anything (`sandbox: "read-only"`,
`permissionMode: "default"`), on a private network, and widen from there.

## The whole thing, on a droplet

Any Linux box that runs Docker will do. These are the exact steps for a
DigitalOcean droplet, which is the one this was set up on.

**1. The droplet.** Marketplace image **Docker on Ubuntu** — it saves installing
Docker and nothing else about it matters. Basic / Regular, **2 vCPU / 4 GB /
80 GB** ($24/mo), a **US region**: the agents' API calls egress from this box,
and a European IP is the kind of thing that makes a provider login behave oddly
for no benefit. Add your SSH key at creation. Turn on weekly backups (+20%) —
the event log is the team's entire memory and there is no second copy.

**2. Close everything.** A DO cloud firewall with inbound **SSH only**, ideally
from your own IP. Nothing else ever needs to be open: the tunnel in step 4 dials
out, and 4173 is bound to loopback inside the box regardless.

**3. Bring it up.**

```bash
ssh root@<droplet-ip>
git clone https://github.com/petershk/studio-floor && cd studio-floor
cp .env.example .env
openssl rand -hex 32          # paste into STUDIO_TOKEN
vi .env                       # provider key(s), STUDIO_GIT_TOKEN if you want pushes
docker compose up -d --build
docker compose exec studio studio doctor    # are the CLIs there, do the keys work
```

At this point it is running and reachable only through an SSH tunnel:

```bash
ssh -N -L 4173:127.0.0.1:4173 root@<droplet-ip>
open http://127.0.0.1:4173/?token=<STUDIO_TOKEN>
```

**A note on the token.** Open the studio once as `https://…/?token=<STUDIO_TOKEN>`.
The page takes the token out of the URL — so it is not left in the address bar,
in a bookmark or in a screenshot — keeps it, and sends it as a bearer header on
every request after that, including the event stream. If a studio ever refuses
the token it says so on the page rather than going blank.

**4. The tunnel**, so you can look from anywhere. In the Cloudflare dashboard:
Zero Trust → Networks → Tunnels → create one, add a public hostname, point it at
`http://studio:4173` (the compose service name, not localhost). Then Zero Trust
→ Access → Applications → add that hostname with a policy allowing your email
only. Copy the tunnel token into `TUNNEL_TOKEN` in `.env` and:

```bash
docker compose --profile tunnel up -d
```

No inbound port is opened, the identity check happens before anything reaches
the studio, and `STUDIO_TOKEN` still sits behind it. SSE passes through cleanly,
so the live feed stays live.

The `cloudflared` service is behind a compose profile: without `--profile
tunnel` it does not start, so the SSH-tunnel setup remains the default.

**Do the Access policy before you route the hostname.** A tunnel with no policy
in front of it is the studio on the public internet with a single token as its
only guard.

## Pointing it at a repository

The container starts pointed at `/workspace`, which is a directory of
repositories rather than a project. Put one in it:

```bash
docker compose exec studio studio clone https://github.com/you/thing
```

or, from the browser, **Settings → Working directory → Clone a repository**,
which clones and then switches the studio into it in one action.

Either way the repository lands in `/workspace/thing`, and switching restarts
the studio pointed at it. The team's memory lives inside the project it belongs
to, so `/workspace/thing/studio_floor/` holds that project's config and event
log, and coming back to it later picks up exactly where the team left off.
Switching between repositories is switching between teams-with-memory.

A private repository needs `STUDIO_GIT_TOKEN`. Without one, the clone fails at
once rather than hanging on a password prompt that has no terminal to appear on.

## What the team does with git

Agents are told the convention in their prompt, and the prompt describes the
machine it is generated on:

- Work happens on a branch per task, named after it — `studio/task-07`.
- Commits happen as the work happens, with messages a reviewer can read.
- **With `STUDIO_GIT_TOKEN` set and a remote present**, agents are told to push
  the branch when a task is ready for review, never to the default branch and
  never force-pushed. You open the PR.
- **Without one**, they are told plainly that this machine cannot push, that it
  is deliberate, and not to spend a turn trying — otherwise an agent reports a
  task blocked on an authentication failure nobody can act on.

The token is stored through git's own credential helper, in its own file rather
than `~/.git-credentials`, and never in a remote URL — a URL with a token in it
ends up in `.git/config`, in `git remote -v`, and in the first error message an
agent pastes into the channel.

If the machine has no git identity, one is set (`STUDIO_GIT_NAME`,
`STUDIO_GIT_EMAIL`), because otherwise the first `git commit` fails with "Please
tell me who you are". An identity that already exists is never overwritten.

## Credentials

Ranked by how much you should like them.

**API keys as secrets.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` etc. via your
platform's secret store, scoped to one project with a spend cap. Boring, which
is the highest compliment available here. Set them per agent if you want
separate budgets:

```json
{ "id": "builder", "provider": "claude", "apiKeyEnv": "BUILDER_ANTHROPIC_KEY" }
```

`apiKey` — the literal key in the config file — is refused over HTTP for this
reason, and `studio_floor/config.json` is a file worth committing.

**Mounted credential directories.** `~/.claude`, `~/.codex` read-only into the
container. Fine on your own machine; poor in the cloud, because you are copying
an interactive login session onto a remote host.

**Interactive login inside the container.** `docker compose exec -it studio
claude /login`. Works, does not survive a rebuild, and is a manual step in what
should be an automated deploy.

## State, and what to back up

Back up **`/workspace`**. It holds every repository the team works in and, inside
each one, that project's `studio_floor/state/events.jsonl` — the append-only log
that is the team's whole memory: decisions, debates, task history, every message.
There is no second store to recover from.

- Copying a project's `events.jsonl` to another host reproduces that studio
  exactly. That is the migration path, and also how you snapshot before letting
  the team try something risky.
- `transcripts/` grows without bound (full JSONL of every turn). Rotate it if
  disk matters; nothing reads it back.
- The `studio-state` volume holds only the state of the studio that runs before
  you clone anything. Once you switch into a repository, that repository holds
  its own.

## Knowing it is alive

The studio writes a heartbeat every five seconds, and `studio status` reads it
without touching the event log — so it answers when the studio is dead, which is
when you need it:

```bash
docker compose exec studio studio status     # exits 0 running, 1 not
```

It distinguishes a clean shutdown from a crash from a process that is up and no
longer beating, and says how long it has been silent. It is cheap enough for a
cron line.

In the browser, a strip appears under the top bar when nothing is reaching the
page, and separately when the studio is answering but no agent has done anything
for ten minutes — the silence a connection check cannot find. The tab title
changes too, since a background tab is exactly where an outage goes unnoticed.

If the studio process dies, the supervisor restarts it: five attempts backing
off 1s, 2s, 5s, 15s, 30s, then it stops and says so rather than spinning. The
feed records the gap and the reason. A studio that refuses to start for a reason
a restart cannot fix — a roster typo, a port already taken — is not retried.

## Cost

The real cost is tokens, not compute. Three budgets are enforced before each
turn, never during one:

- `runner.maxTurns` — per agent, hard.
- `runner.maxWallMs` — how long this run may last.
- `runner.maxSpendUsd` — measured from the start of this run, not the lifetime
  of the log.

All three default to no limit except `maxTurns`. Set them in Settings → Runner
before you leave a team unattended overnight. Spend is a **floor**: an agent
whose provider reports no cost and has no configured rate contributes zero, and
the panel names those agents rather than pretending the number is a bill.

## Sizing

Each agent turn is one child process holding a provider session. Roughly 200–400
MB resident per concurrently running agent, spiky CPU during a turn, near-idle
between turns. A four-agent team is comfortable on 2 vCPU / 4 GB.

## Restarting

The studio rebuilds everything from the log on start, so a restart or a redeploy
loses nothing except in-flight turns — and an in-flight turn that dies leaves its
inbox unacknowledged, so its messages come back rather than vanishing.

Provider sessions do **not** survive a container replacement. Agents come back
with a fresh session, which the runner handles: the arriving agent is handed its
full accumulated inbox and the brief, so it knows what happened while it was
gone. It loses its own conversational memory of *how* it did things, not the
record of *what* was done.

## What is not built yet

Honestly, so you can plan around it:

- **No multi-tenancy.** One studio, one project at a time, one team, one token.
  Several repositories can live side by side in the workspace; only one is live.
- **No horizontal scale.** The server is the single writer by design. More
  agents, not more servers.
- **No managed sandbox per agent.** Isolation is whatever the container and the
  provider's own sandbox give you.
- **No agent session memory across restarts.** The session id is written to the
  log every turn and never read back.
- **No review gate on a push.** If the team can push, it pushes when it decides a
  task is ready. Branch protection on the remote is what makes that safe.
