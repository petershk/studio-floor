/**
 * Starting a studio server for a test, without lying about which one answered.
 *
 * Three tests used to pick a port out of `process.hrtime()` and then poll
 * GET /api/state until *something* answered:
 *
 *   stream-gap  4199 + hrtime % 200  →  4199..4398
 *   inbox-ack   4300 + hrtime % 300  →  4300..4599
 *   validation  4400 + hrtime % 300  →  4400..4699
 *
 * Those ranges overlap each other and smoke.mjs's fixed 4199. When the port was
 * already held — by a leftover child from an earlier run whose socket had not
 * been released yet, by another test in the same run, by anything at all on the
 * machine — the new child died with EADDRINUSE and the poll cheerfully succeeded
 * against the stranger. The test then ran every assertion against a server whose
 * state it had never seeded. That fails noisily some of the time (an agent
 * running the suite saw three inbox-ack HTTP checks fail with an empty inbox
 * while the same test passed in isolation) and, far worse, it *passes* some of
 * the time. A green tick for a run that never happened is the one failure this
 * studio cannot ship.
 *
 * So there is no port arithmetic here. The child listens on STUDIO_PORT=0, the
 * OS hands it a port nobody else holds, and the child tells the parent which one
 * over its own stdout. The parent waits for that exact line instead of probing a
 * socket, so a stranger on some other port can never be mistaken for it, and a
 * child that dies is reported as a dead child rather than as a timeout.
 *
 * Identity is then proved rather than assumed. The child stamps a per-run nonce
 * into its own event log before it starts listening, and this helper will not
 * return until it has read that nonce back over HTTP. Port 0 already makes a
 * collision impossible; the nonce is what makes the *claim* checkable, which is
 * the standard the rest of this project holds itself to.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** studio/ — the tests all need this to build imports for their child. */
export const STUDIO_DIR = path.resolve(here, '..', 'src');

/** file:// URL of a file under studio/, ready to embed in a child's import. */
export function studioUrl(rel) {
  return pathToFileURL(path.join(STUDIO_DIR, rel)).href;
}

// Every child we spawn, so a test that throws half way through does not leave a
// node process holding a socket for the next run to trip over. That is the exact
// condition the port arithmetic used to turn into a false pass.
const children = new Set();
let cleanupRegistered = false;

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  // Last-resort reaping only. Tests must call server.stop() themselves and then
  // let the loop drain: calling process.exit() while a child and its stdio pipes
  // are still live aborts on Windows with libuv's UV_HANDLE_CLOSING assertion, and
  // the process exits 127 AFTER printing "all checks passed". That made the exit
  // code a lie in both directions — a green run looked failed to anything checking
  // $?, and a genuine `process.exitCode = 1` was indistinguishable from the abort.
  const killAll = () => {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    children.clear();
  };
  process.on('exit', killAll);
  // Ctrl-C during a hung test would otherwise skip 'exit' entirely.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      killAll();
      process.exit(130);
    });
  }
}

/**
 * The source the child actually runs: our preamble, then the test's own boot.
 *
 * The boot decides what world the test needs — which Store, which seed events —
 * and hands the store and the server it built to `studioTestReady`. Everything
 * about announcing the port and proving identity stays here, so the tests only
 * describe what they are testing.
 */
function childProgram(boot) {
  return `
// ---- studio test harness preamble; the test's boot source follows ----------
const __nonce = process.env.STUDIO_TEST_NONCE;
function studioTestReady(store, server) {
  // The marker is written while listen() is still in flight: createHttpServer
  // has called listen(), but 'listening' has not fired, so this process has not
  // served a single request yet. That ordering is what lets the parent treat the
  // nonce as proof of identity instead of as a race it hopes to win.
  store.append('studio.note', null, { text: 'studio test harness marker', nonce: __nonce });
  server.on('error', (err) => {
    // EADDRINUSE cannot happen on port 0, but a child that cannot listen must
    // still die loudly rather than sit there never announcing itself.
    process.stderr.write('studio test child: server error: ' + ((err && err.stack) || err) + '\\n');
    process.exit(1);
  });
  server.on('listening', () => {
    process.stdout.write('STUDIO_TEST_READY ' + server.address().port + ' ' + __nonce + '\\n');
  });
}
${boot}
`;
}

/**
 * Start a studio server in a child process and return once it is proven up.
 *
 * @param {object}  opts
 * @param {string}  opts.boot      ES module source. Must call studioTestReady(store, server).
 * @param {string} [opts.root]     project root for the child; a fresh temp dir if omitted.
 * @param {string} [opts.prefix]   mkdtemp prefix, so a stray temp dir names the test that left it.
 * @param {object} [opts.env]      extra env for the child (e.g. STUDIO_STREAM_BACKFILL).
 * @param {number} [opts.timeoutMs]
 */
export async function startStudioServer({
  boot,
  root = null,
  prefix = 'studio-test-',
  env = {},
  timeoutMs = 30_000,
} = {}) {
  if (!boot) throw new Error('startStudioServer needs a `boot` source that calls studioTestReady(store, server)');

  const projectRoot = root || fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nonce = `${process.pid}-${randomUUID()}`;
  registerCleanup();

  const child = spawn(process.execPath, ['--input-type=module', '-e', childProgram(boot)], {
    env: {
      ...process.env,
      ...env,
      // After the caller's extras, never before: these three are the harness's
      // contract with itself. A test that could take back the port or the nonce
      // could reintroduce exactly the defect this file exists to remove.
      STUDIO_PROJECT_ROOT: projectRoot,
      STUDIO_PORT: '0',
      STUDIO_TEST_NONCE: nonce,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);

  // The child's complaints are the test's complaints: show them live, and keep a
  // copy so a failure to start can name its own cause instead of timing out.
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  let port;
  try {
    port = await waitForReadyLine(child, nonce, timeoutMs, () => stderr);
  } catch (err) {
    child.kill();
    children.delete(child);
    throw err;
  }

  const base = `http://127.0.0.1:${port}`;
  const { get, post } = makeClient(base);

  // The identity check. A server we did not start cannot have written our nonce.
  const seen = await get('/api/events?kinds=studio.note&limit=500');
  const ours = (seen.events || []).some((ev) => ev.data?.nonce === nonce);
  if (!ours) {
    child.kill();
    children.delete(child);
    throw new Error(
      `the server answering on ${base} is not the child this test started: ` +
      `it does not carry nonce ${nonce}. Refusing to assert against a stranger.`,
    );
  }

  const stop = () => {
    children.delete(child);
    if (!child.killed) child.kill();
  };

  return { base, port, nonce, child, root: projectRoot, get, post, stop };
}

/**
 * Wait for the child's own announcement, not for a socket to answer.
 *
 * A dead child resolves here as a dead child — with its exit code and whatever
 * it managed to say on stderr — so the failure names itself instead of arriving
 * thirty seconds later as "server did not start".
 */
function waitForReadyLine(child, nonce, timeoutMs, stderrSoFar) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    // The trailing newline is required so a nonce split across two chunks is
    // never matched as a short one.
    const ready = /^STUDIO_TEST_READY (\d+) (\S+)\n/m;

    const detail = () => {
      const out = stdout.trim();
      const err = stderrSoFar().trim();
      if (!out && !err) return '\n  the child printed nothing at all';
      return `${out ? `\n  child stdout: ${out}` : ''}${err ? `\n  child stderr: ${err}` : ''}`;
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('close', onClose);
      // Anything the child says from here on is still the test's business.
      child.stdout.on('data', (chunk) => process.stdout.write(chunk));
      fn(value);
    };

    const onData = (chunk) => {
      stdout += chunk;
      const m = ready.exec(stdout);
      if (!m) return;
      const rest = stdout.slice(0, m.index) + stdout.slice(m.index + m[0].length);
      if (rest) process.stdout.write(rest);
      if (m[2] !== nonce) {
        settle(reject, new Error(
          `a child announced itself with nonce ${m[2]}, but this test started ${nonce}`,
        ));
        return;
      }
      settle(resolve, Number(m[1]));
    };

    const onClose = (code, signal) => {
      settle(reject, new Error(
        `the test server exited before it was listening (code ${code}, signal ${signal})${detail()}`,
      ));
    };

    const timer = setTimeout(() => {
      settle(reject, new Error(
        `the test server did not announce itself within ${timeoutMs}ms${detail()}`,
      ));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.on('close', onClose);
    child.on('error', (err) => settle(reject, new Error(`could not spawn the test server: ${err.message}`)));
  });
}

/**
 * JSON over HTTP against one child.
 *
 * `post` deliberately does not throw on a 4xx or 5xx: refusing a bad action is
 * the behaviour validation.mjs and inbox-ack.mjs are there to assert, so a
 * refusal is data, not an error. Pass `{ strict: true }` where a failed POST
 * means the test's own setup broke and there is nothing left worth checking.
 */
function makeClient(base) {
  const get = async (pathname) => body(pathname, await fetch(`${base}${pathname}`));

  const post = async (pathname, payload, { strict = false } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    if (strict && !res.ok) throw new Error(`${pathname} → ${res.status} ${await res.text()}`);
    return body(pathname, res);
  };

  return { get, post };
}

async function body(pathname, res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${pathname}: ${text.slice(0, 200)}`);
  }
}
