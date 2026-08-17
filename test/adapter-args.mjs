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

// ------------------------------------------------------------------ registry

assert.deepEqual(providers().sort(), ['claude', 'codex', 'grok']);
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
