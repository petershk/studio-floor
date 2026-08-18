/**
 * The pane the human watches the thing being built through.
 *
 * The studio's own UI and the thing under construction are two different
 * programs, and this pane refuses to blur them. The game is served from its own
 * path, in an iframe, with its own bytes — no live-reload script is injected
 * into the human's HTML, because a preview that edits the file it is previewing
 * is a preview you cannot trust.
 *
 * Three things this pane will not do:
 *
 * 1. It will not show a frame that is lying. If there is nothing to preview it
 *    says so in words, names the absolute directory it looked in, and lists the
 *    candidates it rejected. An empty phone is not a preview.
 * 2. It will not print a relative path. An entire session of this project was
 *    lost to `PROJECT.md` meaning three different files to three different
 *    agents. Every path in this pane is absolute.
 * 3. It will not poll when it is not visible. The poll is a directory walk on
 *    the server; a hidden tab must not pay for it.
 */

const POLL_MS = 1500;

let timer = null;
let lastVersion = null;
let lastFound = null;
let mounted = false;

/** Called when the Preview tab is opened, and once at boot if it is active. */
export function showPreview() {
  mount();
  poll(true);
  if (!timer) timer = setInterval(() => poll(false), POLL_MS);
}

/** Called when any other tab is opened. */
export function hidePreview() {
  if (timer) { clearInterval(timer); timer = null; }
}

function mount() {
  if (mounted) return;
  const pane = document.getElementById('pane-preview');
  if (!pane) return;
  pane.innerHTML = `
    <div class="pv-bar">
      <span class="pv-state" id="pv-state">looking…</span>
      <span class="pv-path" id="pv-path"></span>
      <span class="pv-grow"></span>
      <a class="btn ghost" id="pv-open" href="/preview/" target="_blank" rel="noopener">Open in a new tab</a>
      <button class="btn ghost" id="pv-reload" type="button">Reload</button>
    </div>
    <div class="pv-stage" id="pv-stage">
      <div class="pv-phone" id="pv-phone" hidden>
        <iframe id="pv-frame" title="Live preview of the thing being built"
                src="about:blank" referrerpolicy="no-referrer"></iframe>
      </div>
      <div class="pv-empty" id="pv-empty"></div>
    </div>`;
  document.getElementById('pv-reload').onclick = () => reload(lastVersion || String(Date.now()));
  mounted = true;
}

async function poll(force) {
  const pane = document.getElementById('pane-preview');
  if (!pane || !pane.classList.contains('active')) return;
  let info;
  try {
    const res = await fetch('/api/preview');
    // The studio serves this pane's own files straight off disk, so a new tab
    // appears the moment it is written — but the route behind it only exists in
    // a server process started since. Saying "unreachable" there would blame the
    // preview for a stale process; saying which one it is costs one status code.
    if (res.status === 404) return stale();
    info = await res.json();
  } catch (err) {
    return fail(String(err));
  }
  render(info, force);
}

function render(info, force) {
  const stateEl = document.getElementById('pv-state');
  const pathEl = document.getElementById('pv-path');
  const phone = document.getElementById('pv-phone');
  const empty = document.getElementById('pv-empty');
  const open = document.getElementById('pv-open');
  if (!stateEl) return;

  if (!info.found || !info.entry) {
    phone.hidden = true;
    open.classList.add('off');
    stateEl.textContent = 'nothing to preview yet';
    stateEl.className = 'pv-state waiting';
    pathEl.textContent = info.reason || '';
    empty.hidden = false;
    empty.innerHTML = emptyHtml(info);
    lastFound = false;
    lastVersion = null;
    return;
  }

  empty.hidden = true;
  phone.hidden = false;
  open.classList.remove('off');
  // Only a configured root ever reaches here — `unset` never has an entry, so
  // there is no detected-source branch to write. If that ever changes, this
  // line should start lying loudly rather than inventing a word for it.
  stateEl.textContent = 'serving (configured)';
  stateEl.className = 'pv-state live';
  pathEl.textContent = info.entry;
  pathEl.title = info.reason || '';

  // A directory that just appeared is a change too, so a first sighting reloads
  // even when the version happens to match whatever was there before.
  if (force || !lastFound || info.version !== lastVersion) reload(info.version);
  lastVersion = info.version;
  lastFound = true;
}

function reload(version) {
  const frame = document.getElementById('pv-frame');
  if (!frame) return;
  // The version is in the URL rather than a header so a back-forward cache or a
  // proxy cannot hand the iframe a page the server has already replaced.
  frame.src = `/preview/?v=${encodeURIComponent(version)}`;
}

function emptyHtml(info) {
  const rows = (info.candidates || []).map((c) => `
    <tr>
      <td class="pv-c">${esc(c.dir)}</td>
      <td class="pv-p">${esc(c.path)}</td>
      <td class="pv-v">${c.index ? 'has an index.html' : (c.exists ? 'no index.html' : 'does not exist')}</td>
    </tr>`).join('');
  const offers = info.offers || [];

  // Three different sentences, because they are three different situations and
  // one vague "nothing to preview" would send the human looking in the wrong
  // place. What is NOT here is a button that writes the config: the setting
  // decides which directory this server hands out over HTTP, and a route that
  // lets a browser move it is a bigger door than this feature is worth.
  const head = info.source === 'configured'
    ? `<h3>${info.root ? 'Watching the directory. There is no page in it yet.' : 'The directory you named is not there.'}</h3>
       <p>${esc(info.reason)}</p>
       ${info.root ? `<p>The file that lights this up:<br><code>${esc(info.root)}${info.root.includes('\\') ? '\\' : '/'}index.html</code></p>` : ''}`
    : offers.length
      ? `<h3>Point the preview at something and it starts.</h3>
         <p>Nothing is being served, because nothing has been chosen. This pane
            will not pick for you — a preview that quietly serves a directory you
            did not name is worse than an empty one.</p>
         <p>${offers.length === 1 ? 'This directory has an <code>index.html</code> and could be it:' : 'These directories have an <code>index.html</code> and could be it:'}</p>
         <ul class="pv-offers">${offers.map((o) => `<li><code>${esc(o.path)}</code></li>`).join('')}</ul>`
      : `<h3>There is nothing to show you yet.</h3>
         <p>This pane is live. Write an <code>index.html</code> into the project
            and point <code>server.preview</code> at it — the frame fills in by
            itself, and you do not have to reload anything.</p>`;

  // Only when nothing is chosen. A human who has already set server.preview and
  // is waiting for a file to appear does not need to be told to set it again.
  const target = info.source === 'unset'
    ? (offers[0] || (info.candidates || []).find((c) => c.exists) || (info.candidates || [])[0])
    : null;
  const setting = target ? `
    <p>Set it in <code>${esc(info.configFile || 'the studio config')}</code>:</p>
    <pre class="pv-snippet">"server": { "preview": "${esc(target.dir === '.' ? '.' : target.dir)}" }</pre>
    <p class="muted">Saved config is re-read on the next poll — no restart, and a
       path that does not exist is reported as missing rather than swapped for a
       guess.</p>` : '';

  return `${head}${setting}
    <table class="pv-cands"><tbody>${rows}</tbody></table>`;
}

function fail(text) {
  const stateEl = document.getElementById('pv-state');
  if (!stateEl) return;
  stateEl.textContent = 'preview unreachable';
  stateEl.className = 'pv-state bad';
  document.getElementById('pv-path').textContent = text;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
