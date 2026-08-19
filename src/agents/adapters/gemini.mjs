import { randomUUID } from 'node:crypto';
import { clip, clipObj, opts, str } from './shared.mjs';

/**
 * Google's Gemini CLI.
 *
 *   gemini --skip-trust --session-id <uuid> -p <prompt> -o stream-json
 *   gemini --skip-trust --resume     <uuid> -p <prompt> -o stream-json
 *
 * Everything here was read off the real CLI (v0.55) rather than its docs, and
 * three findings shaped it.
 *
 * `--skip-trust` is not optional. Without it a headless run refuses with
 * "not running in a trusted directory" and does no work — and exits 0 while
 * doing so, which the runner would read as a completed turn and acknowledge the
 * agent's inbox against. It is passed unconditionally because an agent the
 * studio launched into a project directory has already been trusted by the
 * human who launched it.
 *
 * Sessions take our UUID but refuse to take it twice: a repeated `--session-id`
 * errors with "already exists. Use --resume to resume it". So a fresh turn
 * declares the id and every later turn resumes it, exactly as Claude does.
 * `--resume` does accept the UUID, despite `--help` describing it as taking
 * "latest" or an index — verified by planting a word in one turn and recalling
 * it in the next.
 *
 * Its token vocabulary is a fourth distinct spelling: `cached` rather than
 * `cache_read_input_tokens` or `cached_input_tokens`.
 */

/**
 * The studio's permission vocabulary, in Gemini's terms.
 *
 * `auto` maps to `yolo` because that is what the studio means by an autonomous
 * team member: an agent that has to stop and ask cannot take a bounded headless
 * turn at all. `default` keeps the asking behaviour for anyone who wants to
 * watch before trusting it, and is the honest mapping of "do not act freely".
 */
const APPROVAL = {
  default: 'default',
  acceptEdits: 'auto_edit',
  auto: 'yolo',
  yolo: 'yolo',
  plan: 'plan',
};

export default {
  id: 'gemini',
  label: 'Gemini CLI',
  command: 'gemini',
  versionArgs: ['--version'],

  apiKeyVar: 'GEMINI_API_KEY',
  loginHint: 'gemini auth, stored in ~/.gemini',

  newSession: randomUUID,

  args({ prompt, sessionId, fresh, agent }) {
    const o = opts(agent, { permissionMode: 'auto', model: '' });
    const a = ['--skip-trust'];

    if (fresh) a.push('--session-id', sessionId);
    else a.push('--resume', sessionId);

    a.push('-p', prompt, '-o', 'stream-json');
    a.push('--approval-mode', APPROVAL[o.permissionMode] || 'default');
    if (o.model) a.push('-m', o.model);
    if (Array.isArray(o.extraArgs)) a.push(...o.extraArgs);
    return a;
  },

  parse(obj) {
    const out = [];
    switch (obj.type) {
      case 'init':
        if (obj.session_id) out.push({ kind: 'session', data: { sessionId: obj.session_id } });
        out.push({
          kind: 'raw.native',
          data: { summary: `session init — model ${obj.model || '?'}` },
        });
        return out;

      case 'message': {
        // The user role is our own prompt read back to us; showing it would put
        // the studio's own words in the feed as though the model had said them.
        if (obj.role !== 'assistant') return out;
        const text = str(obj.content);
        if (text.trim()) out.push({ kind: 'raw.text', data: { text: clip(text) } });
        return out;
      }

      case 'thought':
        // Only when the vendor actually exposes it. Nothing is synthesised.
        if (obj.content) out.push({ kind: 'raw.reasoning', data: { text: clip(str(obj.content)) } });
        return out;

      case 'tool_use': {
        const name = obj.tool_name || 'tool';
        out.push({
          kind: 'raw.tool.call',
          data: { name, id: obj.tool_id, brief: briefOf(obj.parameters), input: clipObj(obj.parameters) },
        });
        const files = filesFrom(name, obj.parameters);
        if (files.length) out.push({ kind: 'files', data: { action: 'changed', files } });
        return out;
      }

      case 'tool_result':
        out.push({
          kind: 'raw.tool.result',
          data: {
            id: obj.tool_id,
            output: clip(str(obj.output)),
            isError: obj.status != null && obj.status !== 'success',
          },
        });
        return out;

      case 'error':
        out.push({ kind: 'raw.error', data: { text: clip(str(obj.message || obj.error || obj)) } });
        return out;

      case 'result': {
        const st = obj.stats || {};
        if (obj.status && obj.status !== 'success') {
          out.push({ kind: 'raw.error', data: { text: clip(`turn ended with status ${obj.status}`) } });
        }
        // A per-invocation total: not cumulative like Codex, and not one of many
        // like Claude's per-message reports. Exactly one per turn.
        out.push({
          kind: 'raw.usage',
          data: {
            usage: st,
            durationMs: st.duration_ms,
            scope: 'turn',
            // No cost is reported. On the free tier there is no per-token bill
            // to report, so none is invented here.
          },
        });
        out.push({ kind: 'final', data: { text: '' } });
        return out;
      }

      default:
        return [{ kind: 'raw.native', data: { summary: `gemini ${obj.type || 'event'}`, payload: clipObj(obj) } }];
    }
  },
};

function briefOf(params) {
  if (!params || typeof params !== 'object') return '';
  const first = params.command ?? params.file_path ?? params.path ?? params.absolute_path
    ?? params.pattern ?? params.query ?? params.prompt;
  return clip(first ? String(first) : JSON.stringify(params), 300);
}

function filesFrom(name, params) {
  if (!params || typeof params !== 'object') return [];
  const writers = ['write_file', 'replace', 'edit', 'WriteFile', 'Edit'];
  if (!writers.some((w) => String(name).toLowerCase().includes(w.toLowerCase()))) return [];
  const p = params.file_path || params.path || params.absolute_path;
  return p ? [String(p)] : [];
}
