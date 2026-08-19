import { VENDORS } from './config.mjs';
import { resolveAuth } from './auth.mjs';
import { getAdapter } from '../agents/adapters/index.mjs';

/**
 * Which models a provider is actually serving, asked of the provider.
 *
 * This file has always refused to hardcode a default model, on the grounds that
 * names move faster than a release does and a stale one silently routing to a
 * retired model is worse than an empty box. That reasoning is sound and it
 * produced a bad panel: an empty box is no use to somebody who has never used
 * the vendor, and a list written here is out of date the week after it ships.
 *
 * The provider knows. Every one of them publishes the list behind the same key
 * the agent will use, so this asks — and falls back to the written suggestions
 * when there is no key, when the network is not there, or when the endpoint has
 * moved. The suggestions are still there, still stale, and now only a fallback.
 *
 * They disagree about everything except the idea: bearer tokens, an `x-api-key`
 * header, a query parameter, `data[]`, `models[]`, ids with a `models/` prefix.
 * All of that is per-vendor data rather than per-vendor code.
 */

/** Long enough for a slow API, short enough that a panel does not hang on it. */
const TIMEOUT_MS = 8000;

/** Cached per vendor, because a dropdown must not re-ask on every render. */
const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

/** Ids out of whatever shape the vendor chose. */
function idsFrom(json) {
  const rows = Array.isArray(json?.data) ? json.data
    : Array.isArray(json?.models) ? json.models
      : [];
  return rows
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.name || ''))
    // Google returns `models/gemini-3-pro`; the CLI wants the bare name.
    .map((id) => String(id).replace(/^models\//, ''))
    .filter(Boolean);
}

function request(spec, key) {
  const headers = { accept: 'application/json' };
  let url = spec.url;
  if (spec.auth === 'bearer') headers.authorization = `Bearer ${key}`;
  else if (spec.auth === 'x-api-key') {
    headers['x-api-key'] = key;
    // Anthropic requires a version header and refuses the request without it.
    headers['anthropic-version'] = '2023-06-01';
  } else if (spec.auth === 'query') {
    url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
  }
  return { url, headers };
}

/**
 * Ask one company what it serves.
 *
 * Never throws: every failure is a reported reason and an empty list, because
 * the caller is a dropdown and a dropdown that explodes is worse than one
 * showing the written suggestions.
 */
export async function fetchModels(vendorId, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const vendor = VENDORS[vendorId];
  if (!vendor) return { ok: false, models: [], error: `no provider called ${vendorId}` };
  if (!vendor.modelsApi) {
    return { ok: false, models: vendor.models || [], error: 'this provider does not publish a model list here', source: 'suggested' };
  }

  const hit = cache.get(vendorId);
  if (hit && now() - hit.at < TTL_MS) return { ...hit.result, cached: true };

  // The same key the agent would use, resolved the same way — including one
  // held in this studio's own store rather than the environment.
  const keySpec = vendor.key || vendor.login;
  const adapter = getAdapter(keySpec?.provider);
  const auth = resolveAuth(
    { id: `models:${vendorId}`, options: { auth: 'key', apiKeyEnv: vendor.key?.apiKeyEnv } },
    adapter,
    { env },
  );
  const key = auth.env[vendor.key?.apiKeyEnv] || env[vendor.key?.apiKeyEnv] || '';
  if (!key) {
    return {
      ok: false,
      models: vendor.models || [],
      source: 'suggested',
      error: `no key for ${vendor.label} yet, so this is the written list rather than theirs`,
    };
  }

  const { url, headers } = request(vendor.modelsApi, key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res.ok) {
      return {
        ok: false,
        models: vendor.models || [],
        source: 'suggested',
        error: `${vendor.label} answered ${res.status} — the key may be wrong, or the endpoint moved`,
      };
    }
    const models = idsFrom(await res.json());
    if (!models.length) {
      return { ok: false, models: vendor.models || [], source: 'suggested', error: `${vendor.label} returned no models` };
    }
    const result = { ok: true, models, source: 'provider' };
    cache.set(vendorId, { at: now(), result });
    return result;
  } catch (e) {
    return {
      ok: false,
      models: vendor.models || [],
      source: 'suggested',
      error: e.name === 'AbortError'
        ? `${vendor.label} did not answer within ${TIMEOUT_MS / 1000}s`
        : `could not reach ${vendor.label} — ${e.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** For tests and for a human who wants the next ask to go out for real. */
export function forgetModels() {
  cache.clear();
}
