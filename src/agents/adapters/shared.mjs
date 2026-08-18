/**
 * Helpers every adapter needs, and the Anthropic-style stream parser that more
 * than one provider happens to speak.
 */

export const MAX_TEXT = 4000;

/**
 * Parse one line of an Anthropic-style `stream-json` feed.
 *
 * Claude Code emits this, and Grok's `streaming-messages-json` is close enough
 * that sharing the parser is honest rather than lazy. Anything unrecognised
 * still comes out as `raw.native`, so a provider that changes its shape degrades
 * to "we showed you the JSON we did not understand" instead of silence.
 */
export function parseAnthropicStream(obj) {
  const out = [];
  const t = obj.type;

  if (obj.session_id) out.push({ kind: 'session', data: { sessionId: obj.session_id } });

  if (t === 'system' && obj.subtype === 'init') {
    out.push({
      kind: 'raw.native',
      data: {
        summary: `session init — model ${obj.model || '?'}, ${(obj.tools || []).length} tools, ${(obj.mcp_servers || []).length} mcp servers`,
      },
    });
    return out;
  }

  if (t === 'assistant') {
    for (const block of obj.message?.content || []) {
      if (block.type === 'text' && block.text?.trim()) {
        out.push({ kind: 'raw.text', data: { text: clip(block.text) } });
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        out.push({ kind: 'raw.reasoning', data: { text: clip(block.thinking) } });
      } else if (block.type === 'tool_use') {
        out.push({
          kind: 'raw.tool.call',
          data: { name: block.name, id: block.id, brief: briefInput(block.name, block.input), input: clipObj(block.input) },
        });
        const files = filesFromToolInput(block.name, block.input);
        if (files.length) out.push({ kind: 'files', data: { action: 'changed', files } });
      }
    }
    // One assistant message, not the turn. These arrive many times per turn and
    // their cache figures are running values, so they are recorded for the raw
    // feed and deliberately excluded from any total. The `result` event below
    // carries the authoritative numbers.
    if (obj.message?.usage) {
      out.push({ kind: 'raw.usage', data: { usage: obj.message.usage, scope: 'message' } });
    }
    return out;
  }

  if (t === 'user') {
    for (const block of obj.message?.content || []) {
      if (block.type === 'tool_result') {
        out.push({
          kind: 'raw.tool.result',
          data: {
            id: block.tool_use_id,
            isError: !!block.is_error,
            output: clip(textOf(block.content)),
          },
        });
      }
    }
    return out;
  }

  if (t === 'result') {
    if (obj.is_error) out.push({ kind: 'raw.error', data: { text: clip(obj.result || obj.error || 'turn failed') } });
    // The turn's real totals, and the provider's own costing of it.
    out.push({
      kind: 'raw.usage',
      data: {
        usage: obj.usage || {},
        costUsd: obj.total_cost_usd,
        durationMs: obj.duration_ms,
        numTurns: obj.num_turns,
        scope: 'turn',
      },
    });
    out.push({ kind: 'final', data: { text: clip(obj.result || '') } });
    return out;
  }

  if (t === 'rate_limit_event' || t === 'stream_event') return out;

  out.push({ kind: 'raw.native', data: { summary: `${t || 'event'}`, payload: clipObj(obj) } });
  return out;
}

export function briefInput(name, input = {}) {
  if (!input || typeof input !== 'object') return '';
  const candidates = [
    input.command,
    input.file_path,
    input.path,
    input.pattern,
    input.query,
    input.url,
    input.prompt,
    input.description,
  ].filter(Boolean);
  const s = candidates[0] ? String(candidates[0]) : JSON.stringify(input);
  return clip(s, 300);
}

export function filesFromToolInput(name, input = {}) {
  if (!input || typeof input !== 'object') return [];
  const writers = ['Write', 'Edit', 'NotebookEdit', 'write', 'search_replace', 'str_replace_editor'];
  if (!writers.includes(name)) return [];
  const p = input.file_path || input.path || input.target_file;
  return p ? [String(p)] : [];
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n');
  }
  return str(content);
}

export function str(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function clip(s, n = MAX_TEXT) {
  const t = str(s);
  return t.length > n ? `${t.slice(0, n)}\n…[${t.length - n} more characters]` : t;
}

export function clipObj(o) {
  try {
    const s = JSON.stringify(o);
    return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : JSON.parse(s);
  } catch {
    return { unserialisable: true };
  }
}

/** Options an adapter reads, with the agent record's values layered on top. */
export function opts(agent, fallback = {}) {
  return { ...fallback, ...(agent?.options || {}) };
}
