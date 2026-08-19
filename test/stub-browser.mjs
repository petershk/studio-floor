/**
 * Just enough browser to run the console's own code in node.
 *
 * Not a DOM and not trying to be one: every element is the same do-nothing
 * object, so a renderer that asks for something gets an answer rather than a
 * null. What it models faithfully is only what decides whether the page comes
 * up — the network, the event stream, the URL, and storage.
 *
 * Shared because two tests need it from opposite ends: one proves the page
 * loads, the other proves it says something useful when the studio refuses to
 * talk to it.
 */

/** One object that answers to everything an element is asked to do. */
export function element() {
  return {
    id: '',
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    innerHTML: '',
    innerText: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    checked: false,
    dataset: {},
    style: {},
    classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    },
    children: [],
    parentNode: null,
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { return child; },
    removeChild(child) { return child; },
    insertBefore(child) { return child; },
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    closest: () => null,
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({
      top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    }),
    querySelector: () => element(),
    querySelectorAll: () => [],
    matches: () => false,
  };
}

/**
 * Install the stub.
 *
 * @param {object} o
 * @param {object} o.state       what /api/state should answer with
 * @param {number} o.status      the HTTP status every /api/ call gets
 * @param {string} o.href        the page's own URL, including any ?token=
 * @returns everything a test needs to assert against afterwards
 */
export function installStubBrowser({ state = {}, config = null, status = 200, href = 'http://127.0.0.1:4173/' } = {}) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, { ...element(), id });
    return elements.get(id);
  };

  const doc = {
    title: '',
    body: element(),
    documentElement: element(),
    readyState: 'complete',
    getElementById: byId,
    querySelector: () => element(),
    querySelectorAll: () => [],
    createElement: () => element(),
    createTextNode: () => element(),
    addEventListener() {},
    removeEventListener() {},
  };

  const calls = [];
  const store = new Map();
  const streams = [];
  const replaced = [];

  async function fakeFetch(url, init = {}) {
    const asString = typeof url === 'string' ? url : String(url?.url || url);
    const headers = new Headers(init.headers || {});
    calls.push({ url: asString, authorization: headers.get('authorization') });
    const body = asString.startsWith('/api/state') ? state
      : asString.startsWith('/api/events') ? { events: [] }
        : asString.startsWith('/api/config') ? (config || { config: {}, schema: {} })
          : {};
    const answer = status === 200 ? body : { ok: false, error: 'unauthorised — this studio requires a token' };
    return {
      ok: status === 200,
      status,
      json: async () => answer,
      text: async () => JSON.stringify(answer),
    };
  }

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      streams.push(this);
    }

    addEventListener(name, fn) { this.listeners[name] = fn; }

    close() { this.closed = true; }
  }

  const url = new URL(href);
  const location = {
    href,
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const history = {
    replaceState(_s, _t, next) {
      replaced.push(next);
      const u = new URL(next, location.origin);
      location.href = u.href;
      location.search = u.search;
    },
  };

  globalThis.document = doc;
  globalThis.location = location;
  globalThis.history = history;
  globalThis.localStorage = localStorage;
  globalThis.window = {
    location,
    history,
    localStorage,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  globalThis.fetch = fakeFetch;
  globalThis.EventSource = FakeEventSource;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

  return {
    doc, calls, streams, replaced, location, localStorage, byId,
  };
}
