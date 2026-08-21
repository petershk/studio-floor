import { spawn } from 'node:child_process';
import { resolveLaunch } from '../agents/launch.mjs';
import { getAdapter } from '../agents/adapters/index.mjs';
import { resolveAuth } from './auth.mjs';
import { WORK_DIR } from './roster.mjs';

/**
 * Does this agent actually work?
 *
 * Everything else the panel can say is a statement about configuration: the CLI
 * exists, a key is set, the mode is `key`. All of that can be true of an agent
 * that fails on its first turn — an expired login, a key with no credit, a
 * model name the provider retired, a permission mode that stalls. The only
 * honest answer comes from running it.
 *
 * So this runs it. One trivial prompt, no tools, in the same working directory
 * with the same environment and the same launch resolution the runner uses,
 * because a check that spawns differently is a check of something else. It
 * costs a few tokens, which is why it happens when a human asks and not on a
 * timer.
 */

/** Small, tool-free, and obviously not real work if it shows up in a log. */
const PROMPT = 'Reply with exactly this and nothing else: STUDIO-OK. Do not use any tools.';
const EXPECT = 'STUDIO-OK';

export function tryAgent(record, { timeoutMs = 90_000, env = process.env } = {}) {
  const adapter = getAdapter(record?.provider);
  if (!adapter) {
    return Promise.resolve({ ok: false, stage: 'config', error: `no adapter for provider "${record?.provider}"` });
  }

  const auth = resolveAuth(record, adapter, { env });
  const wanted = record.options?.command || adapter.command;
  const launch = resolveLaunch(wanted);
  if (launch.error) return Promise.resolve({ ok: false, stage: 'launch', error: launch.error });

  // A fresh session every time: this must not resume, append to, or otherwise
  // disturb the conversation the agent is actually having.
  const sessionId = adapter.newSession ? adapter.newSession() : null;
  let args;
  try {
    args = adapter.args({
      prompt: PROMPT, sessionId, fresh: true, agent: record,
    });
  } catch (e) {
    return Promise.resolve({ ok: false, stage: 'config', error: e.message });
  }

  const childEnv = {
    ...env,
    ...(adapter.env ? adapter.env(record) || {} : {}),
    ...auth.env,
    ...(record.options?.env || {}),
  };
  for (const name of auth.unset) delete childEnv[name];

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(launch.command, [...(launch.prefixArgs || []), ...args], {
        cwd: WORK_DIR.path,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, stage: 'launch', error: `could not start ${wanted} — ${e.message}` });
    }

    let out = '';
    let err = '';
    const said = [];
    const problems = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      // Parsed with the adapter's own parser, so a provider that answers in a
      // shape this studio cannot read fails here rather than at the first real
      // turn — which is the whole point of asking now.
      for (const line of out.split('\n').slice(0, -1)) {
        if (!line.trim()) continue;
        try {
          for (const item of adapter.parse(JSON.parse(line))) {
            if (item.kind === 'raw.text' && item.data?.text) said.push(item.data.text);
            if (item.kind === 'raw.error' && item.data?.text) problems.push(item.data.text);
          }
        } catch { /* a line that is not JSON is not an answer */ }
      }
      out = out.slice(out.lastIndexOf('\n') + 1);
    });
    child.stderr.on('data', (d) => { err += d; });

    const timer = setTimeout(() => {
      child.kill();
      resolve({
        ok: false,
        stage: 'timeout',
        ms: Date.now() - startedAt,
        error: `no answer within ${Math.round(timeoutMs / 1000)}s — the CLI may be waiting for an `
          + 'approval nobody can give, or the provider is not responding',
      });
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stage: 'launch', error: `could not start ${wanted} — ${e.message}` });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      const text = said.join(' ').trim();
      const ms = Date.now() - startedAt;
      if (text.includes(EXPECT)) {
        return resolve({
          ok: true, stage: 'answered', ms, said: text.slice(0, 200), auth: auth.detail,
        });
      }
      // It ran and said something else. That is still a working agent, and
      // saying "failed" would be wrong — a model that decides to be chatty is
      // not a broken configuration.
      if (code === 0 && text) {
        return resolve({
          ok: true, stage: 'answered', ms, said: text.slice(0, 200), auth: auth.detail, note: 'answered, but not with the exact phrase asked for',
        });
      }
      return resolve({
        ok: false,
        stage: 'ran',
        ms,
        error: problems[0] || firstLine(err) || `exited with code ${code} and said nothing`,
        auth: auth.detail,
      });
    });
    return undefined;
  });
}

const firstLine = (s) => String(s || '').trim().split('\n').filter(Boolean)[0] || '';
