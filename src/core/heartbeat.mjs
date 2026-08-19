import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_FILE } from './paths.mjs';

/**
 * Proof that the studio is alive, left somewhere it outlives the process.
 *
 * This studio once died and stayed dead for 87 minutes with nobody the wiser.
 * Budgets say what a run will cost; nothing said it had stopped. The awkward
 * part is that a dead process cannot report its own death, so the only honest
 * design is a mark on disk that a *different* program reads: `studio status`
 * from another terminal, the supervisor deciding whether to restart, or a cron
 * line that mails you.
 *
 * So the studio rewrites `runtime.json` every few seconds while it is up, and
 * on a clean shutdown stamps it with why it stopped. After that:
 *
 *   - stamped with a reason        it stopped on purpose, and this is when
 *   - no reason, pid gone          it died, and this is roughly when
 *   - no reason, pid alive, stale  it is wedged: running and not beating
 *   - fresh                        it is fine
 *
 * The stamp is a courtesy, not the mechanism. On Windows a process killed by
 * anything other than a console Ctrl-C is stopped with TerminateProcess, and no
 * exit handler of any kind runs — so the honest signal is the one that needs no
 * cooperation from the dying process: a pid that is gone, and a beat that has
 * not moved. The stamp only ever adds detail to a death already visible.
 *
 * The one thing this cannot tell you is whether the *team* is working, which is
 * a different silence with the same shape. `movedAt` covers it: the log's seq
 * at each beat, and the last time that number changed.
 */

/** Six missed beats. Long enough to survive a slow disk, short enough to notice. */
export const BEAT_MS = 5_000;
export const STALE_AFTER_MS = 30_000;

/** Write the file so a reader can never catch it half-written. */
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function readBeat(file = RUNTIME_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    // Missing, unreadable or truncated all mean the same thing to a caller:
    // there is nothing here to trust.
    return null;
  }
}

/**
 * Is this pid a live process?
 *
 * Signal 0 asks the kernel without delivering anything. EPERM means it exists
 * and belongs to someone else, which is still alive. A pid on its own is never
 * proof of identity — pids get reused — so callers weigh this against the
 * beat's own timestamps rather than trusting it alone.
 */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Start beating. Returns a stop function that stamps the file with a reason,
 * which is what separates "shut down" from "died" for everyone downstream.
 */
export function startHeartbeat({
  snapshot = () => ({}), file = RUNTIME_FILE, intervalMs = BEAT_MS, now = Date.now,
} = {}) {
  const startedAt = new Date(now()).toISOString();
  const base = { pid: process.pid, startedAt };
  let movedAt = startedAt;
  let lastSeq = null;

  const write = (extra = {}) => {
    const snap = snapshot() || {};
    if (snap.seq !== undefined && snap.seq !== lastSeq) {
      if (lastSeq !== null) movedAt = new Date(now()).toISOString();
      lastSeq = snap.seq;
    }
    atomicWrite(file, {
      ...base, ...snap, movedAt, beatAt: new Date(now()).toISOString(), ...extra,
    });
  };

  write();
  const timer = setInterval(write, intervalMs);
  // The studio should not be held open by its own heartbeat.
  timer.unref?.();

  // Idempotent: a signal handler and the process's own exit both want to stamp
  // this, and the first one to arrive knows the most about why.
  let stopped = false;
  return function stop(reason = 'stopped', exitCode = null) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      write({ stoppedAt: new Date(now()).toISOString(), stopReason: reason, exitCode });
    } catch { /* a shutdown is no place to throw */ }
  };
}

/**
 * What the beat means, as text. Pure, so the suite can age a beat by an hour
 * without waiting an hour or killing anything.
 */
export function describeBeat(beat, { now = Date.now(), alive = null, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!beat) {
    return {
      state: 'unknown',
      headline: 'NO STUDIO HAS RUN HERE',
      // Every other branch returns [label, value] pairs, and a bare list of
      // strings here printed one letter per line before anyone noticed.
      detail: [],
    };
  }

  const beatAt = Date.parse(beat.beatAt || '');
  const silentMs = Number.isFinite(beatAt) ? now - beatAt : null;
  const running = alive === null ? processAlive(beat.pid) : alive;

  const detail = [];
  const add = (label, value) => { if (value) detail.push([label, value]); };

  if (beat.stoppedAt) {
    add('stopped', `${since(now - Date.parse(beat.stoppedAt))} ago (${beat.stopReason || 'no reason given'})`);
  } else {
    add('last beat', silentMs === null ? 'never' : `${since(silentMs)} ago`);
  }
  add('started', beat.startedAt ? `${since(now - Date.parse(beat.startedAt))} ago` : null);
  add('pid', String(beat.pid ?? '?'));
  add('project', beat.project);
  add('watch at', beat.url);
  if (beat.seq !== undefined) {
    add('event log', `${beat.seq} events, last moved ${since(now - Date.parse(beat.movedAt || ''))} ago`);
  }
  if (beat.agents && Object.keys(beat.agents).length) {
    add('agents', Object.entries(beat.agents).map(([id, s]) => `${id} ${s}`).join(', '));
  }

  if (beat.stoppedAt) {
    // A process that exits badly still runs its exit handlers, so a crash gets
    // stamped too. Reporting that as "shut down" would be the same comforting
    // lie the 87 minutes were made of.
    if (beat.exitCode) {
      return {
        state: 'crashed',
        headline: `NOT RUNNING — it exited with code ${beat.exitCode}, ${since(now - Date.parse(beat.stoppedAt))} ago`,
        detail,
      };
    }
    return { state: 'stopped', headline: 'NOT RUNNING — it was shut down', detail };
  }
  if (!running) {
    return {
      state: 'died',
      headline: `NOT RUNNING — it stopped without shutting down, ${silentMs === null ? 'at some point' : `about ${since(silentMs)} ago`}`,
      detail,
    };
  }
  if (silentMs !== null && silentMs > staleAfterMs) {
    return {
      state: 'wedged',
      headline: `RUNNING BUT NOT BEATING — pid ${beat.pid} is alive and has not written for ${since(silentMs)}`,
      detail,
    };
  }
  return { state: 'running', headline: 'RUNNING', detail };
}

/** "3 minutes", "2h 4m", "just now" — a duration, not a moment. */
export function since(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}
