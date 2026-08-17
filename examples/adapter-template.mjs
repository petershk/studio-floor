/**
 * A template for adding a provider.
 *
 * Copy to your project, fill in the four things that matter, and name the file
 * in `adapters` in studio.config.json:
 *
 *   { "adapters": ["./adapters/mycli.mjs"],
 *     "agents":   [{ "id": "helper", "provider": "mycli" }] }
 *
 * See docs/ADAPTERS.md for the full contract.
 */
import { randomUUID } from 'node:crypto';

export default {
  id: 'mycli',
  label: 'My CLI',
  command: 'mycli',
  versionArgs: ['--version'],

  /**
   * Return null if the CLI assigns its own id and announces it in the stream —
   * then emit a `session` item from parse() when you see it.
   */
  newSession: randomUUID,

  args({ prompt, sessionId, fresh, agent }) {
    const o = agent.options || {};
    const a = [];

    // Session continuity is what gives the agent memory of its own work across
    // turns. Without it every turn is an amnesiac restart and the team never
    // builds on itself.
    if (fresh) a.push('--session-id', sessionId);
    else a.push('--resume', sessionId);

    // The prompt must stay one argv element. The runner measures the whole
    // command line and trims the prompt if it would exceed the OS limit; do not
    // add your own truncation.
    a.push('--print', prompt);

    // Ask for machine-readable output. A CLI with no JSON mode can still be
    // adapted — emit one raw.text per line — but you lose tool visibility, and
    // tool visibility is most of what the human is watching for.
    a.push('--output-format', 'json-lines');

    if (o.model) a.push('--model', o.model);
    if (Array.isArray(o.extraArgs)) a.push(...o.extraArgs);
    return a;
  },

  /**
   * One parsed line of stdout in, zero or more studio events out.
   *
   * Fall through to raw.native rather than dropping anything. A provider that
   * changes its shape should degrade to "here is JSON we did not understand",
   * never to silence.
   */
  parse(obj) {
    switch (obj.type) {
      case 'session':
        return [{ kind: 'session', data: { sessionId: obj.id } }];

      case 'text':
        return [{ kind: 'raw.text', data: { text: obj.text } }];

      // Only if the vendor actually exposes it. Never synthesise reasoning.
      case 'thinking':
        return [{ kind: 'raw.reasoning', data: { text: obj.text } }];

      case 'tool_call':
        return [
          { kind: 'raw.tool.call', data: { name: obj.name, id: obj.id, brief: obj.summary, input: obj.input } },
          // Tell the studio which files were touched, so `work.files` is real
          // rather than self-reported.
          ...(obj.name === 'write_file' && obj.input?.path
            ? [{ kind: 'files', data: { action: 'changed', files: [obj.input.path] } }]
            : []),
        ];

      case 'tool_result':
        return [{
          kind: 'raw.tool.result',
          data: { id: obj.id, output: obj.output, isError: Boolean(obj.error) },
        }];

      case 'done':
        return [
          { kind: 'raw.usage', data: { usage: obj.usage || {}, costUsd: obj.cost } },
          { kind: 'final', data: { text: obj.result || '' } },
        ];

      default:
        return [{ kind: 'raw.native', data: { summary: `mycli ${obj.type}`, payload: obj } }];
    }
  },
};
