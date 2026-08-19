import { getSecret, secretNameFor } from './secrets.mjs';

/**
 * How one agent proves who it is.
 *
 * On a laptop this question never comes up: every CLI already holds a login
 * from when its human signed in, the studio spawns it, and it authenticates
 * itself. In a container none of that exists — fresh filesystem, no stored
 * session, and no browser to finish an OAuth flow — so the same roster that
 * works locally fails on every turn.
 *
 * It failed *silently*, which is the part worth fixing. `studio doctor`
 * reported `ok claude → claude (2.1.235)` on a box where claude answered every
 * turn with "Not logged in · Please run /login", because doctor asked whether
 * the binary existed and the binary did. Installed and authenticated are two
 * facts and this file is what makes them separately answerable.
 *
 * Four modes, and the point of naming them is that a studio can say which one
 * an agent is in before the first turn burns:
 *
 *   backend  pointed at another provider — the adapter handles its own key
 *   key      an API key, from the environment or from this studio's store
 *   login    the CLI's own stored login, and nothing else
 *   auto     whatever the CLI can find. The default, and the honest name for
 *            what every agent was doing before this existed.
 */

export const AUTH_MODES = ['auto', 'key', 'login'];

/**
 * Work out where an agent's credentials come from, without going near a
 * process. Pure apart from reading the secret store, so `doctor` can report the
 * same answer the runner will act on rather than a plausible guess at it.
 *
 * @param {object} record   the agent record, with its options
 * @param {object} adapter  its adapter, which knows the variable its CLI reads
 * @returns {{mode: string, source: string, keyVar: string|null, env: object,
 *            unset: string[], ok: boolean, detail: string}}
 */
export function resolveAuth(record, adapter, { env = process.env } = {}) {
  const o = record?.options || {};
  const wanted = AUTH_MODES.includes(o.auth) ? o.auth : 'auto';
  const keyVar = o.apiKeyEnv || adapter?.apiKeyVar || null;

  // Pointed at another backend: the adapter turns baseUrl and the key into
  // whatever its CLI wants, and a second opinion from here would be a second
  // variable set to the same value for the CLI to choose between.
  if (o.baseUrl) {
    const named = o.apiKeyEnv;
    const present = named ? Boolean(env[named]) : Boolean(o.apiKey);
    return {
      mode: 'backend',
      source: named ? 'environment' : (o.apiKey ? 'config' : 'none'),
      keyVar: named || null,
      env: {},
      unset: [],
      ok: present,
      detail: present
        ? `pointed at ${o.baseUrl}${named ? `, with a key from ${named}` : ''}`
        : `pointed at ${o.baseUrl}, but there is no key${named ? ` in ${named}` : ''} yet`,
    };
  }

  // The CLI's own login, and only that. The environment is actively cleared,
  // because an inherited key would otherwise win and the mode would be a label
  // rather than a choice — which is exactly the ambiguity this replaces.
  if (wanted === 'login') {
    const vars = [keyVar, adapter?.apiKeyVar].filter(Boolean);
    return {
      mode: 'login',
      source: 'login',
      keyVar: null,
      env: {},
      unset: [...new Set(vars)],
      ok: true,
      detail: adapter?.loginHint
        ? `the CLI's own stored login (${adapter.loginHint})`
        : "the CLI's own stored login",
    };
  }

  const stored = getSecret(secretNameFor(record.id), { env });
  const fromEnv = keyVar ? env[keyVar] : null;

  if (wanted === 'key') {
    if (!keyVar) {
      return {
        mode: 'key',
        source: 'none',
        keyVar: null,
        env: {},
        unset: [],
        ok: false,
        detail: `${adapter?.id || 'this provider'} does not read an API key from a variable this `
          + 'studio knows about — name one with apiKeyEnv, or use its own login',
      };
    }
    // The environment wins over the store. Deployments inject keys that way,
    // and a value the operator put in the container must not be silently
    // overridden by something typed into a browser months earlier.
    if (fromEnv) {
      return {
        mode: 'key',
        source: 'environment',
        keyVar,
        env: {},
        unset: [],
        ok: true,
        // Naming the variable is the point here and nowhere else: it says where
        // the key came from, which is the one thing somebody debugging needs.
        detail: `a key from ${keyVar} in the environment`,
      };
    }
    if (stored) {
      return {
        mode: 'key', source: 'studio', keyVar, env: { [keyVar]: stored }, unset: [], ok: true, detail: 'a key stored in this studio',
      };
    }
    return {
      mode: 'key',
      source: 'none',
      keyVar,
      env: {},
      unset: [],
      ok: false,
      detail: `no key yet — paste one, or set ${keyVar} where the studio runs`,
    };
  }

  // auto — what every agent did before any of this existed.
  if (fromEnv) {
    return {
      mode: 'auto', source: 'environment', keyVar, env: {}, unset: [], ok: true, detail: `a key from ${keyVar} in the environment`,
    };
  }
  if (stored) {
    return {
      mode: 'auto', source: 'studio', keyVar, env: { [keyVar]: stored }, unset: [], ok: true, detail: 'a key stored in this studio',
    };
  }
  return {
    mode: 'auto',
    source: 'login',
    keyVar,
    env: {},
    unset: [],
    // Not a failure: on a laptop this is the normal, working case. It is only
    // unknowable-in-advance, which is why doctor says which it found rather
    // than declaring it fine.
    ok: true,
    detail: adapter?.loginHint
      ? `no key configured — falling back to the CLI's own login (${adapter.loginHint})`
      : 'no key configured — falling back to whatever the CLI can find',
  };
}
