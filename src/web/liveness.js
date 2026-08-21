// Is anything actually happening?
//
// This page had exactly one way to say something was wrong: the word
// "reconnecting…" in 11px grey beside the studio name. The studio once died and
// stayed dead for 87 minutes with that word on screen the whole time.
//
// Two different silences look identical from here, and the fix is to name them
// separately:
//
//   down    nothing is reaching this page at all
//   quiet   the studio is answering, and no agent has done anything for ages
//
// The second is the one no amount of connection-checking finds, because the
// connection is fine.
//
// What this must NOT do is claim to know more than it does. A browser cannot
// tell a dead studio from a closed laptop lid or a dropped VPN, so the wording
// says what is true — nothing is reaching this page — and points at the one
// command that can tell you which it is.

/** Ten minutes of a running team doing nothing at all is worth a look. */
export const QUIET_AFTER_MS = 10 * 60_000;

/** A blip is not an outage. Reconnects usually land inside a second. */
export const DOWN_GRACE_MS = 3_000;

/**
 * What to show, if anything. Pure: the caller supplies the clock, so the suite
 * can put the studio an hour into the past without waiting an hour.
 *
 * @param {object} o
 * @param {boolean} o.connected     is the event stream open right now
 * @param {number|null} o.downSince  when it first dropped, or null
 * @param {number|null} o.lastEventAt when this page last saw any event
 * @param {number} o.now
 * @param {boolean} o.paused        the human paused the team on purpose
 * @param {number} o.running        how many agents are supposed to be working
 * @param {number} o.attempts       reconnection attempts since it dropped
 */
export function livenessState({
  connected, downSince, lastEventAt, now, paused = false, running = 0, attempts = 0,
}) {
  if (!connected) {
    if (!downSince || now - downSince < DOWN_GRACE_MS) return { level: 'ok' };
    return {
      level: 'down',
      headline: 'NOTHING IS REACHING THIS PAGE',
      detail: `no contact for ${duration(now - downSince)}`
        + `${attempts > 1 ? `, ${attempts} reconnect attempts` : ''}`
        + `${lastEventAt ? ` · last event ${duration(now - lastEventAt)} ago` : ''}`
        + ' · run `studio status` to see whether it is still running',
    };
  }

  // A paused team and a stopped team are both silent on purpose. Warning about
  // a silence the human asked for is how a warning becomes wallpaper.
  if (paused || running < 1) return { level: 'ok' };

  const idleMs = lastEventAt ? now - lastEventAt : 0;
  if (idleMs > QUIET_AFTER_MS) {
    return {
      level: 'quiet',
      headline: `NO AGENT HAS DONE ANYTHING FOR ${duration(idleMs).toUpperCase()}`,
      detail: `the studio is answering and ${running} agent${running === 1 ? ' is' : 's are'} supposed to be working`,
    };
  }
  return { level: 'ok' };
}

/**
 * The tab title. A background tab is the whole point — the 87 minutes were 87
 * minutes precisely because nobody was looking at the page.
 */
export function livenessTitle(level, base = 'Studio Floor') {
  if (level === 'down') return `⚠ no contact · ${base}`;
  if (level === 'quiet') return `⏸ idle · ${base}`;
  return base;
}

/** "45s", "3 minutes", "1h 27m" — a duration, not a moment. */
export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

/**
 * One word for what the studio is doing, always on screen.
 *
 * The banner below only appears when something is wrong, which leaves the
 * ordinary question — is this thing running? — answered by inference from
 * whether the feed is moving. The states are ordered by what a human needs to
 * know first: not being able to see the studio beats anything the studio might
 * be doing, a paused team beats a warning about one agent, and "running" is
 * only claimed when an agent is actually working.
 */
export function studioStatus({
  connected, downSince, lastEventAt, now, state, attention = 0, locked = false,
}) {
  if (locked) return { level: 'locked', label: 'LOCKED', detail: 'this studio needs its token' };

  if (!connected) {
    const forMs = downSince ? now - downSince : 0;
    if (forMs >= DOWN_GRACE_MS) {
      return { level: 'down', label: 'NO CONTACT', detail: `nothing has reached this page for ${duration(forMs)}` };
    }
  }

  const agents = Object.values(state?.agents || {});
  const running = agents.filter((a) => a.state !== 'offline' && !a.paused);
  const busy = agents.filter((a) => ['working', 'thinking', 'reviewing'].includes(a.state));
  const errored = agents.filter((a) => a.state === 'error');

  if (state?.paused) return { level: 'paused', label: 'PAUSED', detail: 'you paused the team' };
  if (!agents.length) return { level: 'stopped', label: 'NO TEAM', detail: 'no agents are configured' };
  if (!running.length) {
    return {
      level: 'stopped',
      label: 'STOPPED',
      detail: errored.length ? `${errored.length} of ${agents.length} stopped on an error` : 'no agent is running',
    };
  }

  // A warning is about agents that are still meant to be working, so it sits
  // below paused and stopped: a team you switched off is not a fault.
  if (errored.length) {
    return {
      level: 'warning',
      label: 'WARNING',
      detail: `${errored.length} agent${errored.length === 1 ? '' : 's'} in error, ${running.length} still running`,
    };
  }
  if (attention > 0) {
    return {
      level: 'warning',
      label: 'NEEDS YOU',
      detail: `${attention} thing${attention === 1 ? '' : 's'} waiting on you`,
    };
  }

  if (busy.length) {
    return {
      level: 'running',
      label: 'RUNNING',
      detail: `${busy.length} of ${running.length} working`,
    };
  }

  const idleMs = lastEventAt ? now - lastEventAt : 0;
  return {
    level: 'idle',
    label: 'IDLE',
    detail: idleMs > 60_000 ? `nothing for ${duration(idleMs)}` : 'waiting for something to do',
  };
}
