import { clip, clipObj, opts, str } from './shared.mjs';

/**
 * OpenAI Codex CLI.
 *
 *   codex exec --json <prompt>
 *   codex exec resume <thread> --json <prompt>
 *
 * Codex assigns its own thread id, so `newSession` returns null and the runner
 * picks the id up out of the stream.
 *
 * It can also be pointed at something that is not OpenAI, which is how an agent
 * runs on a machine that has no CLI of its own. xAI is the case this was built
 * for: its Grok CLI is a native binary rather than an npm package, so a
 * container that installs its tools from npm cannot have one, and Grok's own
 * Anthropic-compatible endpoint is deprecated. Its OpenAI-shaped one is not.
 *
 * Codex takes that as config rather than environment: `-c` overrides the same
 * keys `~/.codex/config.toml` would set. Verified against codex-cli 0.148.0 —
 * with the provider named and the key variable absent it fails with "Missing
 * environment variable", which is the config being understood rather than
 * rejected.
 */

/**
 * The provider id used for whatever an agent is pointed at.
 *
 * Codex reserves `openai`, `ollama` and `lmstudio`, so this is deliberately
 * none of those, and deliberately fixed: one agent is one process, and a name
 * that varied per agent would only show up in error messages.
 */
const PROVIDER_ID = 'studio';

/** Where a literal `apiKey` is put, since codex names a variable, not a secret. */
const LITERAL_KEY_VAR = 'STUDIO_CODEX_API_KEY';

/**
 * TOML, in a value that will not be seen by a shell but will be parsed as TOML.
 *
 * `baseUrl` is already restricted to https or localhost by config.mjs and
 * `apiKeyEnv` to an environment variable name, so this is the second lock
 * rather than the first: anything with a quote in it never reaches a config
 * file, an argument list or a log line.
 */
function tomlString(value, what) {
  const v = String(value);
  if (/["\\\n\r]/.test(v)) {
    throw new Error(`studio: ${what} contains a character that cannot be passed to codex`);
  }
  return `"${v}"`;
}

export default {
  id: 'codex',
  label: 'Codex',
  command: 'codex',
  versionArgs: ['--version'],

  newSession() {
    return null;
  },

  args({ prompt, sessionId, agent }) {
    const o = opts(agent, { sandbox: 'workspace-write', model: '' });
    const sandbox = o.sandbox === 'full'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['-s', o.sandbox || 'workspace-write'];
    const common = ['--json', '--skip-git-repo-check'];
    if (o.model) common.push('-m', o.model);

    // Point it somewhere other than OpenAI. Nothing is added at all unless the
    // agent asked for it, so the ordinary case is byte-for-byte what it was.
    if (o.baseUrl) {
      const keyVar = o.apiKeyEnv || (o.apiKey ? LITERAL_KEY_VAR : '');
      common.push(
        '-c', `model_provider=${tomlString(PROVIDER_ID, 'provider id')}`,
        // The agent's own label, because this name is what codex prints in its
        // errors, and "Grok" there is worth more than "Studio provider".
        '-c', `model_providers.${PROVIDER_ID}.name=${tomlString(agent?.label || agent?.id || 'Studio provider', 'label')}`,
        '-c', `model_providers.${PROVIDER_ID}.base_url=${tomlString(o.baseUrl, 'baseUrl')}`,
        // "responses" rather than "chat": recent codex speaks the Responses API
        // and nothing else. Overridable because that is a vendor decision on
        // both ends and this file should not be the reason a working endpoint
        // cannot be used.
        '-c', `model_providers.${PROVIDER_ID}.wire_api=${tomlString(o.wireApi || 'responses', 'wireApi')}`,
      );
      if (keyVar) {
        common.push('-c', `model_providers.${PROVIDER_ID}.env_key=${tomlString(keyVar, 'apiKeyEnv')}`);
      }
    }
    const extra = Array.isArray(o.extraArgs) ? o.extraArgs : [];

    if (sessionId) {
      // `codex exec resume` does not accept `-s/--sandbox`; the resumed thread
      // retains the sandbox selected when it was created. The full bypass flag
      // is accepted by both commands and therefore stays explicit when that
      // deliberately unsafe mode was configured.
      const resumeSandbox = o.sandbox === 'full' ? sandbox : [];
      return ['exec', 'resume', sessionId, ...common, ...resumeSandbox, ...extra, prompt];
    }
    return ['exec', ...common, ...sandbox, ...extra, prompt];
  },

  /**
   * A literal `apiKey` still has to arrive as a variable, because a codex
   * provider names one rather than carrying the secret. `apiKeyEnv` is the
   * better habit and needs nothing here: the variable is already in the
   * environment the runner passes down.
   */
  env(agent) {
    const o = agent?.options || {};
    if (!o.apiKeyEnv && o.apiKey) return { [LITERAL_KEY_VAR]: String(o.apiKey) };
    return {};
  },

  parse(obj) {
    const out = [];
    const t = obj.type;

    if (t === 'thread.started' || t === 'session.created') {
      return [{ kind: 'session', data: { sessionId: obj.thread_id || obj.session_id } }];
    }
    if (t === 'turn.started') return [];
    if (t === 'turn.completed') {
      // Cumulative for the whole thread, not for this turn: the figure climbs
      // across a resumed session and resets when a new one starts. Summing these
      // as if they were per-turn overcounts by an order of magnitude — measured
      // at 10.7x against a real 24,000-event log — so the scope is recorded and
      // the store takes deltas.
      return [{ kind: 'raw.usage', data: { usage: obj.usage || {}, scope: 'session' } }];
    }
    if (t === 'turn.failed') {
      return [{ kind: 'raw.error', data: { text: str(obj.error?.message || obj.error) } }];
    }
    if (t === 'error') {
      return [{ kind: 'raw.error', data: { text: str(obj.message || obj.error) } }];
    }

    if (t === 'item.started' || t === 'item.completed' || t === 'item.updated') {
      const it = obj.item || {};
      const done = t === 'item.completed';
      switch (it.type) {
        case 'agent_message':
          if (done) out.push({ kind: 'raw.text', data: { text: clip(it.text) } });
          break;
        case 'reasoning':
          if (done) out.push({ kind: 'raw.reasoning', data: { text: clip(it.text || it.summary) } });
          break;
        case 'command_execution':
          if (!done) {
            out.push({ kind: 'raw.tool.call', data: { name: 'shell', brief: clip(it.command, 400), input: { command: it.command } } });
          } else {
            out.push({
              kind: 'raw.tool.result',
              data: {
                name: 'shell',
                brief: clip(it.command, 200),
                output: clip(it.aggregated_output || ''),
                isError: it.exit_code !== 0 && it.exit_code !== undefined,
                exitCode: it.exit_code,
              },
            });
          }
          break;
        case 'file_change': {
          const files = (it.changes || []).map((c) => c.path || c.file).filter(Boolean);
          if (done) {
            out.push({ kind: 'raw.tool.call', data: { name: 'file_change', brief: files.join(', ') } });
            if (files.length) out.push({ kind: 'files', data: { action: 'changed', files } });
          }
          break;
        }
        case 'mcp_tool_call':
          out.push({
            kind: done ? 'raw.tool.result' : 'raw.tool.call',
            data: {
              name: `${it.server || 'mcp'}.${it.tool || ''}`,
              brief: clip(str(it.arguments), 300),
              output: done ? clip(str(it.result)) : undefined,
            },
          });
          break;
        case 'web_search':
          if (done) out.push({ kind: 'raw.tool.call', data: { name: 'web_search', brief: clip(it.query, 200) } });
          break;
        case 'error':
          out.push({ kind: 'raw.error', data: { text: clip(it.message || str(it)) } });
          break;
        case 'todo_list':
          if (done) out.push({ kind: 'raw.native', data: { summary: 'todo list updated', payload: clipObj(it) } });
          break;
        default:
          if (done) out.push({ kind: 'raw.native', data: { summary: `codex ${it.type}`, payload: clipObj(it) } });
      }
      return out;
    }

    return [{ kind: 'raw.native', data: { summary: `codex ${t || 'event'}`, payload: clipObj(obj) } }];
  },
};
