// Carrying the token from the URL into every request the page makes.
//
// Without this, a studio with `STUDIO_TOKEN` set is unusable from a browser and
// looks broken rather than locked: `/` is served to anyone, `/api/*` is not, so
// the page's own first fetch 401s, the first render throws on a state object
// that is really an error object, and module evaluation stops. The result is a
// static shell — no feed, no agents, no error. It reads as a frozen page.
//
// It never showed up on a laptop because nobody sets a token on loopback. It
// showed up within a minute of the first cloud deployment, which is exactly the
// class of thing that only a real deployment finds.
//
// **Why a bearer token in JS rather than a cookie.** A cookie is the tidier
// answer right up until you notice this server sends
// `Access-Control-Allow-Origin: *`, and that most write routes are not
// origin-checked. Cookie auth would mean any page in any tab could drive these
// agents through the browser's own credentials — a CSRF hole opened in the name
// of convenience. A token held in JS cannot be read cross-origin and is never
// attached to a cross-origin request, so the hole never exists.

const KEY = 'studio.token';

/**
 * Take the token out of the URL, keep it, and remove it from the address bar.
 *
 * Stripping it matters: a URL with a credential in it gets bookmarked, pasted
 * into chat, and screenshotted. It only has to be in the address bar once.
 */
function capture() {
  let url;
  try {
    url = new URL(globalThis.location?.href || '');
  } catch {
    return stored();
  }

  const fromUrl = url.searchParams.get('token');
  if (!fromUrl) return stored();

  try {
    globalThis.localStorage?.setItem(KEY, fromUrl);
  } catch { /* private mode: it still works for this page load */ }

  try {
    url.searchParams.delete('token');
    globalThis.history?.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch { /* not fatal — the token is captured either way */ }

  return fromUrl;
}

function stored() {
  try {
    return globalThis.localStorage?.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export const TOKEN = capture();

/** Forget it — for a studio that has stopped accepting it. */
export function clearToken() {
  try { globalThis.localStorage?.removeItem(KEY); } catch { /* nothing to do */ }
}

/**
 * A URL with the token on it, for the two things that cannot send a header:
 * `EventSource`, and the preview iframe.
 */
export function withToken(path) {
  if (!TOKEN) return path;
  const join = path.includes('?') ? '&' : '?';
  return `${path}${join}token=${encodeURIComponent(TOKEN)}`;
}

/** Is this request going to the studio, or to somewhere else entirely? */
function sameOrigin(input) {
  const raw = typeof input === 'string' ? input : input?.url || '';
  if (raw.startsWith('/')) return true;
  try {
    return new URL(raw, globalThis.location?.href).origin === globalThis.location?.origin;
  } catch {
    return false;
  }
}

/**
 * Attach the token to every request the page makes to its own studio.
 *
 * Wrapping fetch rather than editing twenty call sites is deliberate. The
 * call sites are spread over five modules and grow with every feature; the one
 * that gets forgotten would fail exactly the way this whole file exists to fix,
 * and it would fail only for people running with a token — which is to say, in
 * the cloud, where nobody is watching a console.
 */
export function installAuth() {
  if (!TOKEN || typeof globalThis.fetch !== 'function' || globalThis.fetch.__studioAuth) return;

  const real = globalThis.fetch.bind(globalThis);
  const wrapped = (input, init = {}) => {
    if (!sameOrigin(input)) return real(input, init);
    const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined));
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${TOKEN}`);
    return real(input, { ...init, headers });
  };
  wrapped.__studioAuth = true;
  globalThis.fetch = wrapped;
}
