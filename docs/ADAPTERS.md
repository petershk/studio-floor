# Writing an adapter

An adapter is the whole of what the studio needs to know about one vendor CLI.
Everything else — turns, inboxes, tasks, debates, the log, the UI — is
provider-agnostic and stays that way. Adding a provider is one file and one line
of config. It is never a change to core.

## The interface

```js
export default {
  /** Provider name. `agent.provider` in the config refers to this. */
  id: 'gemini',

  /** Display name. Optional. */
  label: 'Gemini CLI',

  /** The executable to spawn. */
  command: 'gemini',

  /** Args that make it print a version, for `studio doctor`. Optional. */
  versionArgs: ['--version'],

  /**
   * Mint a session id, or return null if the CLI assigns its own and announces
   * it in the stream. Optional; omit for a CLI with no session concept, and
   * accept that the agent will have no memory between turns.
   */
  newSession: () => crypto.randomUUID(),

  /**
   * Build the command line for one turn.
   *
   * `fresh` is true on the agent's first turn and whenever a session could not
   * be resumed. `agent` is the resolved roster record; `agent.options` holds
   * whatever the config put there (model, permissionMode, extraArgs, …).
   */
  args({ prompt, sessionId, fresh, agent }) {
    return fresh
      ? ['--session', sessionId, '--print', prompt, '--json']
      : ['--resume', sessionId, '--print', prompt, '--json'];
  },

  /**
   * Turn one parsed line of stdout into studio events.
   * Return an array — one line often means several events, and often none.
   */
  parse(obj) {
    return [{ kind: 'raw.text', data: { text: obj.text } }];
  },
};
```

## What `parse` may return

The runner reads three control kinds and passes everything else straight to the
event log.

| kind | meaning |
| --- | --- |
| `session` | `{ sessionId }` — the CLI told us which session this is. Store it. |
| `files` | `{ action, files: [...] }` — files the agent touched, observed from a tool call. Becomes a `work.files` event. |
| `final` | `{ text }` — the turn's final answer. Recorded as `raw.text` with `final: true`. |
| `raw.text` | observable assistant text |
| `raw.reasoning` | reasoning **the vendor actually exposed**. Never synthesise this. |
| `raw.tool.call` | `{ name, id, brief, input }` |
| `raw.tool.result` | `{ id, name, output, isError, exitCode }` |
| `raw.usage` | `{ usage, costUsd, durationMs, numTurns }` |
| `raw.error` | `{ text }` |
| `raw.native` | `{ summary, payload }` — anything you did not recognise |

**Fall through to `raw.native` rather than dropping a line.** A provider that
changes its output shape should degrade to "here is JSON we did not understand",
never to silence. The human is watching this feed specifically to catch the
moments the summarised views are wrong.

**Do not invent reasoning.** If a vendor does not expose its internal reasoning,
emit nothing. A studio that fabricates a plausible thought process is worse than
one that admits it cannot see one.

## Registering it

Put the file anywhere in your project and name it in the config. Paths are
resolved against the project directory; a bare package name is imported
normally, so an adapter can ship on npm.

```json
{
  "adapters": ["./adapters/gemini.mjs"],
  "agents": [
    { "id": "gem", "provider": "gemini", "persona": "researcher" }
  ]
}
```

Programmatically:

```js
import { register } from 'studio-floor/adapters';
register(myAdapter);
```

Registering an existing id replaces it, so a project can override a built-in
without forking.

## Non-obvious things the built-ins had to handle

These are all real, and all cost a debugging session before they were found.

**Resume does not take the same flags as start.** `codex exec resume` rejects
`-s/--sandbox`; the resumed thread keeps the sandbox it was created with. Check
the resume path separately.

**A clean exit is not evidence the agent saw its prompt.** The runner will
shorten an over-long command line, and when it does it deliberately refuses to
acknowledge the inbox. Do not paper over truncation inside an adapter.

**Windows caps the whole command line at 32767 characters** and the failure is
`ENAMETOOLONG` from `spawn` itself, before the process exists — so the provider
cannot report it. Keep the prompt as one argv element and let the runner's
budget handle the rest; do not add your own silent truncation.

**Session loss looks like a normal failure.** If your CLI prints something like
"no session" or "could not resume" on stderr, the runner detects it and mints a
fresh session. Match the wording in `runner.mjs`'s `sessionProblem` regex if
your CLI phrases it differently.

## Testing an adapter

`test/adapter-args.mjs` asserts against the argument builders with no process
launched — fast, free, and where flag regressions get caught.

`test/adapter-check.mjs` launches the real CLIs with a trivial prompt and checks
the stream parses. It spends tokens, so it is not in `npm test`. Run it when you
add a provider, and after any vendor upgrade.

## The other kind of adapter

Everything above describes a subprocess adapter: launch a CLI per turn, read its
stdout. There is a standard for this — the Agent Client Protocol — and a spike
against a real ACP agent is in `test/acp-spike.mjs`, with what it proved, what it
costs, and the one thing it does not yet give us in
[docs/ACP.md](ACP.md). Grok has no ACP support, so subprocess adapters are not
going away.
