import { randomUUID } from 'node:crypto';
import { opts, parseAnthropicStream } from './shared.mjs';

/**
 * Grok CLI.
 *
 *   grok --session-id <uuid> -p <prompt> --output-format streaming-messages-json
 *
 * The stream is Anthropic-shaped, so it shares the parser rather than carrying
 * a near-identical copy that would drift.
 */
export default {
  id: 'grok',
  label: 'Grok',
  command: 'grok',
  versionArgs: ['--version'],

  newSession: randomUUID,

  args({ prompt, sessionId, fresh, agent }) {
    const o = opts(agent, { permissionMode: 'auto', model: '' });
    const a = [];
    if (fresh) a.push('--session-id', sessionId);
    else a.push('--resume', sessionId);
    a.push('-p', prompt, '--output-format', 'streaming-messages-json');
    a.push('--permission-mode', o.permissionMode || 'auto');
    if (o.model) a.push('--model', o.model);
    if (Array.isArray(o.extraArgs)) a.push(...o.extraArgs);
    return a;
  },

  parse: parseAnthropicStream,
};
