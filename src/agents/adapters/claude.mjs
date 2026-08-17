import { randomUUID } from 'node:crypto';
import { opts, parseAnthropicStream } from './shared.mjs';

/**
 * Claude Code.
 *
 *   claude --session-id <uuid> -p <prompt> --output-format stream-json --verbose
 *   claude --resume     <uuid> -p <prompt> --output-format stream-json --verbose
 *
 * The session id is ours to choose, so a fresh turn mints one and every later
 * turn resumes it — which is what gives the agent memory of its own work.
 */
export default {
  id: 'claude',
  label: 'Claude Code',
  command: 'claude',
  versionArgs: ['--version'],

  newSession: randomUUID,

  args({ prompt, sessionId, fresh, agent }) {
    const o = opts(agent, { permissionMode: 'auto', model: '', disableMcp: true });
    const a = [];
    if (fresh) a.push('--session-id', sessionId);
    else a.push('--resume', sessionId);
    a.push('-p', prompt, '--output-format', 'stream-json', '--verbose');
    a.push('--permission-mode', o.permissionMode || 'acceptEdits');
    if (o.model) a.push('--model', o.model);
    // MCP servers are loaded per turn and a large set costs real seconds on
    // every single turn of every single agent. Off by default; the team can
    // still reach anything it needs through the shell.
    if (o.disableMcp) a.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
    if (Array.isArray(o.extraArgs)) a.push(...o.extraArgs);
    return a;
  },

  parse: parseAnthropicStream,
};
