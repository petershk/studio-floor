/**
 * The update button in the top bar.
 *
 * Hidden unless there is genuinely something to install, because a control that
 * is always present stops being read. When it does appear it is red and next to
 * the pause controls, where the eye already goes.
 *
 * Checking costs a network call, so it happens on a slow timer rather than on
 * every render, and never on first paint — a studio that phones home the moment
 * you open it is a studio people turn off.
 */

const $ = (id) => document.getElementById(id);

/** Long enough to be unobtrusive, short enough to notice a release the same day. */
const CHECK_EVERY_MS = 30 * 60 * 1000;

/** Not immediately: the first seconds after opening belong to the studio, not to us. */
const FIRST_CHECK_MS = 45 * 1000;

let status = null;
let busy = false;

export function startUpdateWatch() {
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
  wire();
  // Show anything already known without touching the network — the server may
  // have counted commits behind on an earlier check.
  refreshQuiet();
}

async function refreshQuiet() {
  try {
    status = await (await fetch('/api/update')).json();
    render();
  } catch { /* the studio is restarting or gone; the badge is not the place to say so */ }
}

async function check() {
  if (busy) return;
  try {
    status = await (await fetch('/api/update?check=1')).json();
    render();
  } catch { /* offline is not an error worth shouting about in a toolbar */ }
}

function render() {
  const btn = $('btn-update');
  if (!btn) return;

  const behind = status?.behind || 0;
  const blocked = status?.reasons?.length > 0;

  // Nothing to install, or something a human must sort out in a terminal. A red
  // button that cannot do anything when pressed is worse than no button.
  if (!status?.isGitRepo || behind === 0 || blocked) {
    btn.hidden = true;
    return;
  }

  btn.hidden = false;
  btn.disabled = busy;
  btn.textContent = busy
    ? 'Updating…'
    : `Update available (${behind})`;
  btn.title = [
    `${behind} new commit${behind === 1 ? '' : 's'} on ${status.branch}.`,
    'Downloads them and restarts the studio. Agents are stopped;',
    'your project and its history are untouched.',
    ...(status.commits || []).slice(0, 6),
  ].join('\n');
}

function wire() {
  const btn = $('btn-update');
  if (!btn) return;
  btn.onclick = async () => {
    const n = status?.behind || 0;
    if (!confirm(`Update the studio and restart it?\n\n${n} new commit${n === 1 ? '' : 's'}. `
      + 'Agents will be stopped. Your project and its history are untouched.')) return;

    busy = true;
    render();
    let r;
    try {
      r = await (await fetch('/api/update', { method: 'POST' })).json();
    } catch {
      // The server can exit before the response lands. That is a successful
      // update, not a failure.
      return waitForRestart();
    }
    if (!r.ok) {
      busy = false;
      render();
      alert(`Could not update:\n\n${(r.errors || [r.error]).join('\n')}`);
      return undefined;
    }
    if (!r.changed) {
      busy = false;
      await check();
      return undefined;
    }
    return waitForRestart();
  };
}

/**
 * Poll until the replacement studio answers, then reload.
 *
 * The old process exits and a new one binds the same port, so there is a gap of
 * a second or two where nothing is listening. Sitting on a dead page through it
 * is worse than saying what is happening.
 */
async function waitForRestart() {
  const btn = $('btn-update');
  if (btn) { btn.hidden = false; btn.disabled = true; btn.textContent = 'Restarting…'; }
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (r.ok) return void location.reload();
    } catch { /* still down */ }
  }
  busy = false;
  if (btn) btn.textContent = 'Restart did not finish';
  return undefined;
}
