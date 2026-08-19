#!/usr/bin/env node
/**
 * ACP spike — one agent, one provider, end to end, before any migration.
 *
 * The plan's B strand proposes replacing the hand-rolled per-vendor adapters
 * with the Agent Client Protocol, and says not to migrate the roster until a
 * spike proves five things against a real binary rather than against a summary
 * of the spec:
 *
 *   1. a new session                      session/new
 *   2. a prompt that does real work       session/prompt
 *   3. streaming at least as fine as today's      session/update
 *   4. a permission request that reaches the studio   session/request_permission
 *   5. memory that survives a restart     session/load, then ask what it did
 *
 * This is that spike. It is not part of `npm test`: it spends provider tokens
 * and needs a working login, so it is run by hand like adapter-check.mjs.
 *
 *   node test/acp-spike.mjs
 *   node test/acp-spike.mjs --command <path-to-acp-agent> --model haiku --keep
 *
 * The default command is `claude-code-acp` on PATH. Claude Code's ACP support
 * is NOT a flag on the `claude` binary: it is a separate wrapper package,
 * @zed-industries/claude-code-acp, and it does not shell out to the CLI at all —
 * it links @anthropic-ai/claude-agent-sdk directly. So `--command` also accepts
 * a path to that package's dist/index.js, which is what you want if you would
 * rather not install it globally to answer a question about it.
 *
 * Everything below speaks JSON-RPC over stdio by hand. There is an official SDK
 * (@agentclientprotocol/sdk), and the real adapter may well use it, but a spike
 * that hides the wire behind a library cannot answer questions about the wire.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLaunch } from '../src/agents/launch.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const COMMAND = flag('command', 'claude-code-acp');
const MODEL = flag('model', '');
const TURN_TIMEOUT_MS = Number(flag('timeout', '180')) * 1000;
const PROTOCOL_VERSION = 1;

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-acp-'));
const FILENAME = 'spike.txt';
const CONTENT = 'ready';

let failures = 0;

/** Everything the agent said on stderr, kept so a failure can show it. */
const STDERR = [];
const stderrOf = () => STDERR.join('');

function ok(name, cond, detail = '') {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return !!cond;
}
const note = (line) => console.log(`        ${line}`);

/**
 * The client end of an ACP connection.
 *
 * ACP frames are newline-delimited JSON on the child's stdin and stdout, and
 * traffic goes both ways: the agent answers our requests, and it also makes
 * requests OF US — to write a file, to ask permission. That bidirectionality is
 * the whole architectural difference from today's runner, which spawns a
 * process per turn and reads it to exit, so it is modelled here rather than
 * papered over.
 */
class Connection {
  #child; #buf = ''; #nextId = 1; #pending = new Map(); #closed = null;

  constructor(child, handlers) {
    this.#child = child;
    this.handlers = handlers;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this.#feed(d));
    child.on('exit', (code, signal) => {
      this.#closed = `agent exited (code ${code}, signal ${signal})`;
      for (const [, p] of this.#pending) p.reject(new Error(this.#closed));
      this.#pending.clear();
    });
  }

  #feed(chunk) {
    this.#buf += chunk;
    let i;
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, i).trim();
      this.#buf = this.#buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    // A request from the agent to us: it has both a method and an id.
    if (msg.method && msg.id !== undefined) return this.#serve(msg);
    // A notification: a method and no id. This is where the live feed comes from.
    if (msg.method) return this.handlers.notify?.(msg.method, msg.params);
    // Otherwise it answers something we asked.
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
    else p.resolve(msg.result);
    return undefined;
  }

  async #serve(msg) {
    const handler = this.handlers.serve?.[msg.method];
    if (!handler) {
      this.#send({ id: msg.id, error: { code: -32601, message: `no client handler for ${msg.method}` } });
      return;
    }
    try {
      this.#send({ id: msg.id, result: (await handler(msg.params)) ?? null });
    } catch (e) {
      this.#send({ id: msg.id, error: { code: -32603, message: String(e?.message || e) } });
    }
  }

  #send(obj) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
  }

  request(method, params, timeoutMs = 30000) {
    if (this.#closed) return Promise.reject(new Error(this.#closed));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} did not answer within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.#send({ id, method, params });
    });
  }
}

/** Start the agent process. Reuses the studio's own npm-shim resolution. */
function startAgent() {
  const isScript = /\.(c|m)?js$/i.test(COMMAND);
  const launch = isScript
    ? { command: process.execPath, prefixArgs: [path.resolve(COMMAND)] }
    : resolveLaunch(COMMAND);
  if (launch.error) throw new Error(launch.error);

  const env = { ...process.env };
  if (MODEL) env.ANTHROPIC_MODEL = MODEL;
  // The wrapper starts Claude Code's own runtime, which refuses to run inside
  // another Claude Code session and says so only on stderr — the ACP reply is
  // a bare "Internal error". Anything the studio spawns inherits its
  // environment, so a studio started from inside an agent session would hit
  // this too, and the error would name nothing.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const child = spawn(launch.command, [...launch.prefixArgs], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr.push(d); STDERR.push(d); });
  child.on('error', (e) => {
    console.log(`\n  could not start ${COMMAND}: ${e.message}`);
    console.log('  Install it with:  npm i -g @zed-industries/claude-code-acp');
    console.log('  or point --command at its dist/index.js.\n');
    process.exit(1);
  });
  return { child, stderr };
}

const freshSeen = () => ({
  sessionId: null,
  updates: [], kinds: new Map(), other: [], permissions: [], reads: [], writes: [],
  text: '', usage: null, promptAt: 0, firstUpdateMs: 0, firstChunkMs: 0,
});

/** What we tell the agent we can do, and what we do when it takes us up on it. */
function clientOf(seen) {
  return {
    notify(method, params) {
      if (method !== 'session/update') { seen.other.push(method); return; }
      const u = params?.update || {};
      seen.updates.push(u);
      const kind = u.sessionUpdate;
      seen.kinds.set(kind, (seen.kinds.get(kind) || 0) + 1);
      if (!seen.firstUpdateMs && seen.promptAt) seen.firstUpdateMs = Date.now() - seen.promptAt;
      if (!seen.firstChunkMs && kind === 'agent_message_chunk') seen.firstChunkMs = Date.now() - seen.promptAt;
      if (kind === 'agent_message_chunk' && u.content?.type === 'text') seen.text += u.content.text;
      if (kind === 'usage_update') seen.usage = u;
    },
    serve: {
      // THE POINT OF THE WHOLE MIGRATION. Today the studio passes
      // --permission-mode auto and hands this decision to the vendor CLI. Here
      // it arrives as a request addressed to us, with the tool call and the
      // options attached — which is exactly what "the human approves or denies
      // individual actions, live" needs. The spike answers automatically; the
      // studio would put this in front of the human.
      'session/request_permission'(params) {
        seen.permissions.push(params);
        const options = params?.options || [];
        const pick = options.find((o) => o.kind === 'allow_once') || options[0];
        if (!pick) return { outcome: { outcome: 'cancelled' } };
        return { outcome: { outcome: 'selected', optionId: pick.optionId } };
      },
      // Declared in clientCapabilities, so the agent's edits come through us
      // rather than happening behind our back — another thing the studio wants,
      // since it can then see, and in principle refuse, every write.
      'fs/read_text_file'(params) {
        seen.reads.push(params?.path);
        return { content: fs.readFileSync(params.path, 'utf8') };
      },
      'fs/write_text_file'(params) {
        seen.writes.push(params?.path);
        fs.mkdirSync(path.dirname(params.path), { recursive: true });
        fs.writeFileSync(params.path, params.content ?? '');
        return {};
      },
    },
  };
}

const initialize = (conn) => conn.request('initialize', {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
  clientInfo: { name: 'studio-floor', title: 'Studio Floor', version: '0.1.0' },
});

function prompt(conn, seen, text) {
  seen.promptAt = Date.now();
  return conn.request('session/prompt', {
    sessionId: seen.sessionId,
    prompt: [{ type: 'text', text }],
  }, TURN_TIMEOUT_MS);
}

const summarise = (seen) => [...seen.kinds.entries()].map(([k, n]) => `${k}x${n}`).join(', ');

async function main() {
  console.log(`\nACP spike  (cwd: ${cwd})`);
  console.log(`           command: ${COMMAND}${MODEL ? `, model: ${MODEL}` : ''}\n`);

  // ---- 1. connect and initialize ------------------------------------------
  console.log(' handshake');
  const first = startAgent();
  const seen = freshSeen();
  const conn = new Connection(first.child, clientOf(seen));

  let init;
  try {
    init = await initialize(conn);
  } catch (e) {
    ok('initialize answered', false, e.message);
    console.log(`\n  stderr: ${first.stderr.join('').trim().split('\n').slice(-6).join('\n          ')}\n`);
    process.exit(1);
  }
  ok('initialize answered', !!init);
  ok(`protocol version ${PROTOCOL_VERSION} accepted`, init.protocolVersion === PROTOCOL_VERSION,
    `agent replied ${init.protocolVersion}`);
  note(`agent: ${`${init.agentInfo?.name || '?'} ${init.agentInfo?.version || ''}`.trim()}`);
  note(`capabilities: ${JSON.stringify(init.agentCapabilities)}`);
  if (init.authMethods?.length) note(`authMethods: ${init.authMethods.map((m) => m.id).join(', ')}`);
  const canLoad = !!init.agentCapabilities?.loadSession;
  ok('agent advertises loadSession (A3, session restore)', canLoad,
    'without it a restart cannot resume, which is the gap we have today');

  // ---- 2. a session, and a turn that does real work ------------------------
  console.log('\n a session and a turn that does real work');
  const created = await conn.request('session/new', { cwd, mcpServers: [] });
  seen.sessionId = created?.sessionId;
  ok('session/new returned a session id', !!seen.sessionId);
  if (created?.modes) {
    note(`modes: ${created.modes.availableModes?.map((m) => m.id).join(', ')} `
      + `(current: ${created.modes.currentModeId})`);
  }

  const startedAt = Date.now();
  const res = await prompt(conn, seen,
    `Create a file named ${FILENAME} in the current directory whose entire content is the single `
    + `word ${CONTENT}. Then reply with just the word DONE.`);
  const turnSecs = ((Date.now() - startedAt) / 1000).toFixed(1);

  ok('the turn ended cleanly', res?.stopReason === 'end_turn', `stopReason ${res?.stopReason}`);
  const madeIt = fs.existsSync(path.join(cwd, FILENAME));
  ok('the file the agent was asked for exists', madeIt);
  const wrote = madeIt ? fs.readFileSync(path.join(cwd, FILENAME), 'utf8').trim() : '';
  ok('with the content it was asked for', wrote === CONTENT, `found ${JSON.stringify(wrote)}`);

  // ---- 3. streaming granularity -------------------------------------------
  console.log('\n what the live feed would see');
  ok('updates streamed during the turn', seen.updates.length > 0);
  note(`${seen.updates.length} updates in ${turnSecs}s: ${summarise(seen)}`);
  if (seen.firstUpdateMs) note(`first update after ${(seen.firstUpdateMs / 1000).toFixed(1)}s, `
    + `first agent text after ${(seen.firstChunkMs / 1000).toFixed(1)}s`);
  ok('tool calls are visible as they happen', seen.kinds.has('tool_call'),
    'the studio shows raw.tool.call today, so parity needs this');
  ok('assistant text is visible as it happens', seen.kinds.has('agent_message_chunk'));
  if (seen.kinds.has('agent_thought_chunk')) note('thinking streams separately, so raw.reasoning has a home');
  if (seen.kinds.has('plan')) note('plans arrive as structured entries, which the studio has no equivalent of');
  if (seen.other.length) note(`other notifications: ${[...new Set(seen.other)].join(', ')}`);

  // ---- 4. the permission request ------------------------------------------
  console.log('\n the human in the loop');
  if (seen.permissions.length) {
    ok('a permission request reached the client', true);
    const p = seen.permissions[0];
    note(`asked about: ${p.toolCall?.title || p.toolCall?.toolCallId}`);
    note(`options: ${(p.options || []).map((o) => `${o.name} (${o.kind})`).join(' | ')}`);
  } else {
    ok('a permission request reached the client', false,
      'none arrived — the agent may be in a mode that does not ask');
  }
  if (seen.writes.length) note(`${seen.writes.length} write(s) came through fs/write_text_file, i.e. through us`);
  if (seen.reads.length) note(`${seen.reads.length} read(s) came through fs/read_text_file`);

  // ---- 5. usage, which the budgets need -----------------------------------
  console.log('\n what the budgets could read');
  if (res?.usage) note(`the prompt result carried usage: ${JSON.stringify(res.usage)}`);
  if (seen.usage) note(`usage_update: ${JSON.stringify(seen.usage)}`);
  ok('the turn reported token usage or cost', !!(res?.usage || seen.usage),
    'the protocol carries usage on the prompt result and as usage_update, but this agent sent '
    + 'neither, so maxSpendUsd would be blind for it');

  // ---- 6. restart, then resume --------------------------------------------
  console.log('\n memory across a restart');
  first.child.kill();
  await new Promise((r) => { setTimeout(r, 500); });
  note('agent process killed — this stands in for the studio restarting');

  const second = startAgent();
  const seen2 = freshSeen();
  seen2.sessionId = seen.sessionId;
  const conn2 = new Connection(second.child, clientOf(seen2));
  await initialize(conn2);

  if (!canLoad) {
    ok('session/load restored the session', false, 'the agent does not advertise loadSession');
  } else {
    let loaded = true;
    try {
      await conn2.request('session/load',
        { sessionId: seen.sessionId, cwd, mcpServers: [] }, TURN_TIMEOUT_MS);
    } catch (e) {
      loaded = false;
      ok('session/load restored the session', false, e.message);
    }
    if (loaded) {
      ok('session/load restored the session', true);
      note(`${seen2.updates.length} updates replayed on load: ${summarise(seen2)}`);
      ok('the replay carries the earlier conversation', seen2.updates.length > 0,
        'the spec says the agent MUST replay the whole conversation');

      // The id surviving is not the question. Whether the model still knows
      // what it did is the question, and it is what A3 is actually about.
      seen2.text = '';
      seen2.kinds.clear();
      const res2 = await prompt(conn2, seen2,
        'Without using any tools, what is the exact name of the file you created earlier? '
        + 'Reply with the filename and nothing else.');
      ok('and the agent still remembers what it did', seen2.text.includes(FILENAME),
        `it answered ${JSON.stringify(seen2.text.trim().slice(0, 80))}`);
      note(`the resumed turn ended with stopReason ${res2?.stopReason}`);
    }
  }
  second.child.kill();

  console.log(`\n${failures ? `${failures} FAILED` : 'the spike works end to end'}\n`);
  if (has('keep')) console.log(`kept: ${cwd}\n`);
  // The agent we just killed may still hold the directory for a moment, which
  // on Windows is an EPERM rather than a wait. Retry, the way the rest of the
  // suite already does, and never let teardown decide the result.
  else try { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover tmp */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.log(`\n  the spike stopped: ${e.message}`);
  if (e.rpc) console.log(`  rpc error: ${JSON.stringify(e.rpc).slice(0, 2000)}`);
  const err = stderrOf().trim();
  if (err) console.log(`\n  stderr:\n${err.split('\n').slice(-12).map((l) => `    ${l}`).join('\n')}`);
  console.log('');
  process.exit(1);
});
