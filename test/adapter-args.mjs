#!/usr/bin/env node
/**
 * The argument builders, and the registry that resolves them.
 *
 * These assertions are about the vendor CLIs' real surface — `codex exec resume`
 * rejects `-s`, a fresh Claude turn mints a session id while a later one resumes
 * it — so they are worth having even though no process is launched.
 */
import assert from 'node:assert/strict';
import { ADAPTERS, getAdapter, register, validate, providers } from '../src/agents/adapters/index.mjs';
import { normaliseConfig, PERSONAS } from '../src/core/config.mjs';

const prompt = 'continue the assigned task';
const agentOf = (options) => ({ id: 'x', provider: 'p', label: 'X', persona: '', options });

// --------------------------------------------------------------------- codex

const codex = getAdapter('codex');
const fresh = codex.args({ prompt, sessionId: null, fresh: true, agent: agentOf({ sandbox: 'workspace-write' }) });
assert.deepEqual(fresh.slice(0, 2), ['exec', '--json']);
assert.ok(fresh.includes('-s'), 'a fresh Codex thread receives the configured sandbox');
assert.ok(fresh.includes('workspace-write'));
assert.equal(fresh.at(-1), prompt);

const resumed = codex.args({
  prompt,
  sessionId: '00000000-0000-0000-0000-000000000001',
  fresh: false,
  agent: agentOf({ sandbox: 'workspace-write' }),
});
assert.deepEqual(resumed.slice(0, 3), ['exec', 'resume', '00000000-0000-0000-0000-000000000001']);
assert.ok(resumed.includes('--json'));
assert.ok(!resumed.includes('-s'), '`codex exec resume` must not receive unsupported -s');
assert.ok(!resumed.includes('--sandbox'), '`codex exec resume` must not receive unsupported --sandbox');
assert.equal(resumed.at(-1), prompt);

const fullResume = codex.args({
  prompt,
  sessionId: '00000000-0000-0000-0000-000000000002',
  fresh: false,
  agent: agentOf({ sandbox: 'full' }),
});
assert.ok(fullResume.includes('--dangerously-bypass-approvals-and-sandbox'));

// -------------------------------------------------------------------- claude

const claude = getAdapter('claude');
const cFresh = claude.args({ prompt, sessionId: 'sid', fresh: true, agent: agentOf({}) });
assert.ok(cFresh.includes('--session-id'), 'a fresh Claude turn declares its session id');
assert.ok(!cFresh.includes('--resume'));
const cResume = claude.args({ prompt, sessionId: 'sid', fresh: false, agent: agentOf({}) });
assert.ok(cResume.includes('--resume'), 'a later Claude turn resumes rather than restarting');
assert.ok(cResume.includes('--strict-mcp-config'), 'MCP is off unless the agent asks for it');
const cMcp = claude.args({ prompt, sessionId: 'sid', fresh: false, agent: agentOf({ disableMcp: false }) });
assert.ok(!cMcp.includes('--strict-mcp-config'));
const cModel = claude.args({ prompt, sessionId: 'sid', fresh: false, agent: agentOf({ model: 'claude-opus-5' }) });
assert.ok(cModel.includes('claude-opus-5'));

// Per-agent extra args reach the command line, so a roster can pass anything a
// provider supports that the studio has no opinion about.
const extra = claude.args({ prompt, sessionId: 'sid', fresh: false, agent: agentOf({ extraArgs: ['--foo', 'bar'] }) });
assert.ok(extra.includes('--foo') && extra.includes('bar'));

// ------------------------------------------- pointing an adapter elsewhere

{
  // Kimi, GLM and others publish Anthropic-compatible endpoints so Claude Code
  // can talk to them, which makes a separate adapter per vendor a copy of
  // claude.mjs with a different URL. A preset is that URL.
  const { normaliseConfig, PRESETS } = await import('../src/core/config.mjs');
  const cfg = normaliseConfig({ agents: [
    { id: 'kimi', preset: 'kimi', model: 'kimi-k2-turbo-preview' },
    { id: 'plain', provider: 'claude' },
  ] });
  const [kimi, plain] = cfg.agents;

  assert.equal(kimi.provider, 'claude', 'a preset rides an existing adapter');
  assert.equal(kimi.options.baseUrl, PRESETS.kimi.baseUrl);
  assert.equal(kimi.options.model, 'kimi-k2-turbo-preview', 'the model is for the human to choose');

  const prev = process.env[PRESETS.kimi.apiKeyEnv];
  process.env[PRESETS.kimi.apiKeyEnv] = 'secret-value';
  try {
    const env = claude.env(kimi);
    assert.equal(env.ANTHROPIC_BASE_URL, PRESETS.kimi.baseUrl, 'the endpoint reaches the CLI');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'secret-value', 'the key is read from the named variable');
    // A plain Claude agent must be left completely alone.
    assert.deepEqual(claude.env(plain), {}, 'an unconfigured agent gets no overrides');
  } finally {
    if (prev === undefined) delete process.env[PRESETS.kimi.apiKeyEnv];
    else process.env[PRESETS.kimi.apiKeyEnv] = prev;
  }

  // A literal key works but is the worse habit; both paths are supported.
  const literal = normaliseConfig({ agents: [{ id: 'x', provider: 'claude', apiKey: 'abc123' }] }).agents[0];
  assert.equal(claude.env(literal).ANTHROPIC_AUTH_TOKEN, 'abc123');

  // Anything the agent states beats the preset, so a preset is a starting
  // point rather than something that overrules the human.
  const overridden = normaliseConfig({
    agents: [{ id: 'k', preset: 'kimi', baseUrl: 'https://my-proxy.internal' }],
  }).agents[0];
  assert.equal(overridden.options.baseUrl, 'https://my-proxy.internal');
}

// -------------------------------------------------------------------- gemini

const gemini = getAdapter('gemini');
{
  const g = agentOf({ permissionMode: 'auto' });
  const fresh = gemini.args({ prompt, sessionId: 'sid', fresh: true, agent: g });
  const resumed = gemini.args({ prompt, sessionId: 'sid', fresh: false, agent: g });

  // Without this, a headless run refuses with "not running in a trusted
  // directory" -- and exits 0 while refusing, so the runner would read it as a
  // completed turn and acknowledge the agent's inbox against nothing.
  assert.ok(fresh.includes('--skip-trust'), 'gemini must always skip the trust prompt');
  assert.ok(resumed.includes('--skip-trust'));

  // A repeated --session-id is refused by the CLI with "already exists. Use
  // --resume". Verified against v0.55: --resume does take the UUID, despite the
  // help text describing it as "latest" or an index.
  assert.ok(fresh.includes('--session-id'), 'a fresh gemini turn declares the session id');
  assert.ok(!fresh.includes('--resume'));
  assert.ok(resumed.includes('--resume'), 'a later gemini turn resumes by id');
  assert.ok(!resumed.includes('--session-id'), 'resuming must not also declare the id');

  assert.ok(fresh.includes('stream-json'), 'gemini streams so tool calls are visible live');
  assert.deepEqual(
    gemini.args({ prompt, sessionId: 's', fresh: true, agent: agentOf({ permissionMode: 'auto' }) })
      .slice(-1), ['yolo'],
    'the studio auto mode maps to gemini yolo: an agent that must stop and ask cannot take a turn',
  );
  assert.ok(gemini.args({ prompt, sessionId: 's', fresh: true, agent: agentOf({ permissionMode: 'default' }) })
    .includes('default'), 'and "default" still means ask');
  assert.ok(gemini.args({ prompt, sessionId: 's', fresh: true, agent: agentOf({ permissionMode: 'acceptEdits' }) })
    .includes('auto_edit'));
}
{
  // Real event shapes, copied from the CLI's own output.
  const sess = gemini.parse({ type: 'init', session_id: 'abc', model: 'gemini-3.5-flash' });
  assert.equal(sess.find((i) => i.kind === 'session')?.data.sessionId, 'abc');

  const assistant = gemini.parse({ type: 'message', role: 'assistant', content: 'hello', delta: true });
  assert.equal(assistant[0].kind, 'raw.text');

  // The user role is the studio's own prompt read back; showing it would put
  // our words in the feed as though the model had said them.
  assert.deepEqual(gemini.parse({ type: 'message', role: 'user', content: 'our prompt' }), []);

  const call = gemini.parse({ type: 'tool_use', tool_name: 'write_file', tool_id: 't1', parameters: { file_path: 'a.js' } });
  assert.equal(call[0].kind, 'raw.tool.call');
  assert.deepEqual(call[1], { kind: 'files', data: { action: 'changed', files: ['a.js'] } },
    'a write is reported as a file change');

  const res = gemini.parse({ type: 'tool_result', tool_id: 't1', status: 'error', output: 'nope' });
  assert.equal(res[0].data.isError, true);

  const done = gemini.parse({
    type: 'result',
    status: 'success',
    stats: { input_tokens: 9037, output_tokens: 39, cached: 0, duration_ms: 5244 },
  });
  const usage = done.find((i) => i.kind === 'raw.usage');
  assert.equal(usage.data.scope, 'turn', 'gemini reports one total per invocation');
  assert.equal(usage.data.durationMs, 5244);
  assert.equal(usage.data.costUsd, undefined, 'no cost is invented for a provider that reports none');

  assert.equal(gemini.parse({ type: 'something-new' })[0].kind, 'raw.native',
    'an unrecognised event is surfaced, never dropped');
}

// ------------------------------------------------------------------ registry

assert.deepEqual(providers().sort(), ['claude', 'codex', 'gemini', 'grok']);
assert.ok(ADAPTERS.codex, 'the ADAPTERS view exposes built-ins by provider name');
assert.equal(getAdapter('nope'), null);

assert.deepEqual(validate({ id: 'x', command: 'x', args: () => [], parse: () => [] }), []);
assert.ok(validate({ id: 'x' }).length, 'an adapter missing args/parse is rejected');
assert.throws(() => register({ id: 'bad' }), /invalid adapter/);

register({ id: 'test-provider', command: 'echo', args: () => ['hi'], parse: () => [] });
assert.ok(getAdapter('test-provider'), 'a registered adapter is resolvable');
assert.ok(providers().includes('test-provider'));

// -------------------------------------------------------------------- roster

// The whole point of the rewrite: a team of one provider wearing several hats.
const many = normaliseConfig({
  agents: [
    { id: 'architect', provider: 'claude', persona: 'architect' },
    { id: 'builder', provider: 'claude', persona: 'implementer', model: 'claude-sonnet-5' },
    { id: 'breaker', provider: 'claude', persona: 'adversary' },
  ],
});
assert.equal(many.agents.length, 3);
assert.deepEqual(many.agents.map((a) => a.provider), ['claude', 'claude', 'claude']);
assert.ok(many.agents[0].persona.startsWith(PERSONAS.architect.slice(0, 40)));
assert.notEqual(many.agents[0].persona, many.agents[2].persona, 'different hats get different framing');
assert.equal(many.agents[1].options.model, 'claude-sonnet-5');
assert.equal(many.agents[1].options.disableMcp, true, 'provider defaults still apply');

// A free-text persona is passed through verbatim.
const custom = normaliseConfig({ agents: [{ id: 'a', provider: 'claude', persona: 'You only write tests.' }] });
assert.equal(custom.agents[0].persona, 'You only write tests.');

assert.throws(() => normaliseConfig({ agents: [{ id: 'a' }, { id: 'a' }] }), /duplicate agent id/);
assert.throws(() => normaliseConfig({ agents: [{ id: 'Bad Id' }] }), /unusable id/);

// The old flat config keeps working, so upgrading does not silently change the team.
const legacy = normaliseConfig({
  agents: ['codex', 'claude', 'grok'],
  maxTurns: 42,
  codexSandbox: 'read-only',
  claudeModel: 'claude-opus-5',
});
assert.deepEqual(legacy.agents.map((a) => a.id), ['codex', 'claude', 'grok']);
assert.equal(legacy.runner.maxTurns, 42);
assert.equal(legacy.agents[0].options.sandbox, 'read-only');
assert.equal(legacy.agents[1].options.model, 'claude-opus-5');

console.log('adapter, registry and roster checks passed');
