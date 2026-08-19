import { spawnSync } from 'node:child_process';
import { resolveLaunch } from '../agents/launch.mjs';
import { getAdapter, providers } from '../agents/adapters/index.mjs';
import { resolveAuth } from './auth.mjs';
import { VENDORS, vendorList } from './config.mjs';

/**
 * What this machine can actually run, asked once and answered the same way
 * everywhere.
 *
 * `studio doctor` and the settings panel both need this, and a second
 * implementation of it is not hypothetical trouble: doctor used to probe by
 * shelling out while the runner spawned directly, so doctor reported healthy
 * for agents the runner could not start on Windows. One probe, one answer.
 *
 * It launches each CLI exactly the way the runner would — same resolution of
 * npm shims, same absence of a shell — and asks it for its version. That is
 * cheap, needs no credentials, and is the only question a probe can settle
 * without spending money.
 */

/** Probe one executable. Cached by command, since five agents may share one. */
export function probeCommand(command, versionArgs = ['--version'], cache = new Map()) {
  if (cache.has(command)) return cache.get(command);

  const launch = resolveLaunch(command);
  let result;
  if (launch.error) {
    result = { command, found: false, version: '', why: launch.error };
  } else {
    const probe = spawnSync(
      launch.command,
      [...(launch.prefixArgs || []), ...versionArgs],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true },
    );
    result = {
      command,
      found: probe.status === 0,
      version: (probe.stdout || probe.stderr || '').trim().split('\n')[0],
      why: probe.status === 0 ? '' : `"${command}" is not installed or not on PATH`,
      viaShim: Boolean(launch.via),
    };
  }
  cache.set(command, result);
  return result;
}

/**
 * Every company this studio knows, and whether this machine can reach it.
 *
 * Two separate answers per company, because they fail independently: whether
 * the CLI is installed, and whether there is a credential for it. A box with
 * Claude Code installed and nobody signed in is not the same as a box without
 * it, and telling them apart is the whole reason this exists.
 */
export function detect({ env = process.env } = {}) {
  const cache = new Map();
  const known = providers();

  return vendorList(known).filter((v) => v.id !== 'other').map((v) => {
    const spec = VENDORS[v.id];
    const out = { id: v.id, label: v.label, keysAt: v.keysAt, login: null, key: null };

    if (spec.login && known.includes(spec.login.provider)) {
      const adapter = getAdapter(spec.login.provider);
      const probe = probeCommand(adapter.command, adapter.versionArgs, cache);
      // A stored login is a file this process will not open and a session that
      // may have expired, so "installed" is as far as a probe can honestly go.
      out.login = {
        cli: adapter.command,
        installed: probe.found,
        version: probe.version,
        why: probe.why,
        hint: adapter.loginHint || '',
      };
    }

    if (spec.key && known.includes(spec.key.provider)) {
      const adapter = getAdapter(spec.key.provider);
      const probe = probeCommand(adapter.command, adapter.versionArgs, cache);
      const keyVar = spec.key.apiKeyEnv;
      // Asked through the same resolver the runner uses, so this reports the
      // key the agent would actually get — including one held in the studio's
      // own store rather than the environment.
      const auth = resolveAuth(
        { id: `detect:${v.id}`, options: { auth: 'key', apiKeyEnv: keyVar } },
        adapter,
        { env },
      );
      out.key = {
        cli: adapter.command,
        installed: probe.found,
        version: probe.version,
        why: probe.why,
        keyVar,
        hasKey: auth.ok,
        source: auth.source,
      };
    }

    out.usable = Boolean((out.login?.installed) || (out.key?.installed && out.key?.hasKey));
    return out;
  });
}
