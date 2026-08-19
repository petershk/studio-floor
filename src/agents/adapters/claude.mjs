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

  /** The variable this CLI reads a key from, and where its own login lives. */
  apiKeyVar: 'ANTHROPIC_API_KEY',
  loginHint: 'claude /login, stored in ~/.claude',

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

  /**
   * Point this CLI at something other than Anthropic.
   *
   * Kimi, GLM, DeepSeek and several others expose Anthropic-compatible
   * endpoints precisely so Claude Code can talk to them, which means a second
   * adapter for each would be a copy of this one with a different URL. Instead
   * an agent declares where to go, and the two variables the CLI reads are set
   * from it.
   *
   * `apiKeyEnv` names a variable to read the secret from and is the better
   * habit: `apiKey` puts the literal key in studio_floor/config.json, which is
   * a file worth committing, and committing a key is how they leak.
   */
  env(agent) {
    const o = agent?.options || {};
    const out = {};
    if (o.baseUrl) out.ANTHROPIC_BASE_URL = String(o.baseUrl);
    const key = o.apiKeyEnv ? process.env[o.apiKeyEnv] : o.apiKey;
    if (key) out.ANTHROPIC_AUTH_TOKEN = String(key);
    return out;
  },

  parse: parseAnthropicStream,
};
