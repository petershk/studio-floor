import { clip, clipObj, opts, str } from './shared.mjs';

/**
 * OpenAI Codex CLI.
 *
 *   codex exec --json <prompt>
 *   codex exec resume <thread> --json <prompt>
 *
 * Codex assigns its own thread id, so `newSession` returns null and the runner
 * picks the id up out of the stream.
 */
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

  parse(obj) {
    const out = [];
    const t = obj.type;

    if (t === 'thread.started' || t === 'session.created') {
      return [{ kind: 'session', data: { sessionId: obj.thread_id || obj.session_id } }];
    }
    if (t === 'turn.started') return [];
    if (t === 'turn.completed') return [{ kind: 'raw.usage', data: { usage: obj.usage || {} } }];
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
