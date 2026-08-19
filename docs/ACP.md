# ACP — what the spike proved, and what it would cost

The plan proposes replacing the hand-rolled per-vendor adapters with the
[Agent Client Protocol](https://agentclientprotocol.com) and says not to migrate
the roster until a spike works end to end. This is the result of that spike.

Run it yourself:

```
npm i -g @zed-industries/claude-code-acp
node test/acp-spike.mjs
```

It is not part of `npm test` — it spends provider tokens and needs a login, like
`adapter-check.mjs`. Everything below was observed on Windows, node 24, against
`@zed-industries/claude-code-acp` 0.16.2, protocol version 1.

## What it proved

Thirteen of fourteen checks pass. In one run:

```
 handshake
  ok    initialize answered
  ok    protocol version 1 accepted
  ok    agent advertises loadSession (A3, session restore)
 a session and a turn that does real work
  ok    session/new returned a session id
  ok    the turn ended cleanly
  ok    the file the agent was asked for exists
  ok    with the content it was asked for
 what the live feed would see
  ok    updates streamed during the turn
        7 updates in 11.8s: available_commands_update×1, tool_call×2,
        tool_call_update×2, agent_message_chunk×2
  ok    tool calls are visible as they happen
  ok    assistant text is visible as it happens
 the human in the loop
  ok    a permission request reached the client
        asked about: `echo -n "ready" > spike.txt`
        options: Always Allow (allow_always) | Allow (allow_once) | Reject (reject_once)
 memory across a restart
  ok    session/load restored the session
  ok    the replay carries the earlier conversation
  ok    and the agent still remembers what it did
```

The three answers the plan asked for, in its own words:

**"Confirm what the binary actually is."** It is not a flag on `claude`. It is a
separate package, `@zed-industries/claude-code-acp`, which does not shell out to
the CLI at all — it links `@anthropic-ai/claude-agent-sdk` directly. Codex has
an equivalent wrapper, `@zed-industries/codex-acp`. Gemini CLI carries its own
`--experimental-acp` flag. **Grok has nothing**, which is why this has to be an
additional adapter kind and not a replacement.

**"Confirm `session/load` genuinely restores conversational memory, not just an
id."** It does. The spike kills the agent process — the studio restarting — then
reconnects, calls `session/load`, and asks the model what file it created
earlier. It answers correctly, from the replayed conversation and not from disk.
The replay arrives as ordinary `session/update` notifications before the call
returns, so the studio would get the history in exactly the shape it already
renders.

**"Confirm streaming granularity is at least as good as today's."** It is the
same granularity, differently named: `agent_message_chunk` for text,
`agent_thought_chunk` for thinking, `tool_call` and `tool_call_update` for tools,
against today's `raw.text` / `raw.reasoning` / `raw.tool.call`. The first update
arrives immediately; assistant text arrives as whole blocks at the end of the
turn, which is what the stream-json parser sees today too. Nothing regresses.

## What it unlocks, concretely

`session/request_permission` arrives **as a request addressed to the client**,
carrying the tool call and a list of options with kinds
(`allow_once`, `allow_always`, `reject_once`, `reject_always`). Today the studio
passes `--permission-mode auto` and surrenders that decision to the vendor CLI.
Under ACP the studio receives it and can put it in front of the human — the
protocol hands over the visibility feature rather than the studio building it.

Two more things came free that the plan did not anticipate:

- **`session/set_mode`.** `session/new` returned the modes `default`,
  `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` and the current one.
  That is today's `permissionMode` option as a protocol call, changeable
  mid-session, with the current value readable rather than assumed.
- **`session/fork`, `session/list`, `session/resume`** are advertised as session
  capabilities. Forking an agent's session is a thing the studio has no concept
  of and might want.

Declaring `fs.readTextFile` / `fs.writeTextFile` in `clientCapabilities` also
routes the agent's file edits **through the studio**. In one run the file arrived
as an `fs/write_text_file` request; in another the agent used a shell command
instead and only the permission request surfaced. So this is a real hook, but not
a complete audit trail on its own.

## The one failure, and it matters

**No usage or cost is reported.** `PromptResponse.usage` was absent and no
`usage_update` notification ever arrived.

This is the wrapper, not the protocol. The protocol has both — and the SDK
version the wrapper itself bundles (`@agentclientprotocol/sdk` 0.14.1) defines
`usage_update` and `totalTokens`. `claude-code-acp` 0.16.2 simply never sends
them: `usage_update` does not appear anywhere in its `dist`, even though the
Agent SDK it wraps reports `total_cost_usd` on every result.

Today the studio reads that figure out of stream-json, and `runner.maxSpendUsd`
is measured against it. An ACP agent as it stands would be an agent whose spend
is invisible — and `spend()` already treats an unpriced agent as contributing
zero, so the budget would silently under-count rather than fail loudly. That is
the single blocker to migrating an agent the budget is supposed to cover.

Fixable three ways: an upstream patch to the wrapper (small — the data is already
in hand), a rate-card estimate from `usage_update` if a newer wrapper sends it,
or keeping a provider on the subprocess adapter until it reports cost.

## One environmental trap

The wrapper starts Claude Code's runtime, which refuses to run inside another
Claude Code session — and says so **only on stderr**. Over the wire you get
`{"code":-32603,"message":"Internal error","data":{"details":"Query closed before
response received"}}`, which names nothing. Anything the studio spawns inherits
its environment, so a studio launched from inside an agent session would hit this
too. The spike deletes `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` from the child
environment; a real ACP adapter must do the same, and must surface child stderr
when a call fails, because the JSON-RPC error alone is not diagnosable.

## What migrating would actually change

Not the adapter registry — `register()` / `validate()` gate on shape, so an ACP
kind is a second shape beside the existing one. The change is in `runner.mjs`:

| Today | Under ACP |
| --- | --- |
| a process per turn, read to exit | one long-lived connection per agent |
| `sessionId` minted by us, passed as `--resume` | `session/new` returns it; `session/load` resumes it |
| four bespoke stdout parsers | one `session/update` shape |
| stderr regex for "could not resume" | JSON-RPC errors |
| `--permission-mode auto` | `session/request_permission`, answered by the human |
| prompt in argv, under `COMMAND_LINE_BUDGET` | prompt in a JSON-RPC message, no limit |
| kill the child on timeout | `session/cancel` |

The last two are worth naming as deletions. The Windows command-line limit and
everything built on it — `buildLaunchableArgs`, the middle-truncation, the
"inbox NOT acknowledged because the prompt was shortened" path — all exist only
because the prompt travels in argv. Under ACP they are unnecessary.

Process lifecycle moves up to the agent record, which is the one real
architectural change and the reason this is weeks rather than days.

## Recommendation

Proven enough to build on, with one gap to close first.

1. **Fix or work around the cost gap** before any agent that a budget covers
   moves to ACP. Everything else is parity or better.
2. **Add an ACP adapter kind** beside the subprocess kind, and move one agent —
   Claude — onto it. Codex has a wrapper and Gemini has a flag when that works.
   Grok stays on the subprocess adapter indefinitely.
3. **Take A3 (session restore) inside that work, not before it.** `session/load`
   is the feature, and it is already proven here; building a bespoke sessionId
   revival for the subprocess adapters first would be work thrown away for every
   agent that later moves.
4. **Route permission requests to the human** once one agent is on ACP. That is
   the differentiator the protocol hands over, and it is not available any other
   way.
