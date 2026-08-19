import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  WEB_DIR, PORT, HOST, CONFIG_FILE, PROJECT_ROOT, EXIT_SWITCH, IS_LEGACY_LAYOUT, STATE_DIR, HOME_DIR,
} from '../core/paths.mjs';
import { AGENT_IDS, AGENT_STATES, TASK_STATES, MESSAGE_KINDS } from '../core/events.mjs';
import { AGENTS, SERVER as SERVER_CONFIG, PROJECT, RUNNER as RUNNER_CONFIG } from '../core/roster.mjs';
import { providers, getAdapter } from '../agents/adapters/index.mjs';
import {
  readRawConfig, applyConfigPatch, saveRawConfig, restartRequiredFor, normaliseConfig,
  configSchema, PERSONAS, AGENT_PROTECTED_OPTIONS, AGENT_SECRET_OPTIONS, RUNNER_EDITABLE,
} from '../core/config.mjs';
import {
  inspect, problemsWith, recentProjects, requestSwitch, forgetProject,
} from '../core/projects.mjs';
import { updateStatus, pullUpdate } from '../core/update.mjs';
import { parseRemote, checkName, cloneRepo, WORKSPACE_DIR } from '../core/clone.mjs';
import { resolveAuth } from '../core/auth.mjs';
import { detect } from '../core/detect.mjs';
import { fetchModels } from '../core/models.mjs';
import {
  putSecret, listSecrets, removeSecret, secretNameFor, storageHint, generateKey, secretKey, NO_KEY,
} from '../core/secrets.mjs';
import { ensureGitIdentity } from '../core/git.mjs';
import {
  resolvePreview, previewVersion, resolvePreviewFile, PREVIEW_MIME,
} from '../core/preview.mjs';

/**
 * A shared secret the human's browser and the agents' CLI must present.
 *
 * Null on a loopback studio, where it would only be ceremony. Set it — via
 * `server.token` or `STUDIO_TOKEN` — before binding to anything but localhost.
 * A studio reachable from the internet without one is a stranger's shell on
 * your machine, running as you, with your credentials.
 */
const TOKEN = process.env.STUDIO_TOKEN || SERVER_CONFIG.token || null;

function authorised(req, url) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const supplied = bearer || req.headers['x-studio-token'] || url.searchParams.get('token');
  return supplied === TOKEN;
}

/**
 * Refuse a write that another website told the browser to make.
 *
 * This server answers on loopback with `Access-Control-Allow-Origin: *`, which
 * means any page the human has open in another tab can POST to it. For messages
 * that is a nuisance the provenance stamp already handles. For the config it
 * would be remote code execution: the roster decides which programs the studio
 * spawns.
 *
 * A browser always sets `Origin` on a cross-origin POST and cannot be talked out
 * of it, so an Origin that is present and foreign is the one case worth
 * rejecting outright. An absent Origin is curl, the studio CLI, or a test —
 * callers who can already run code here and gain nothing from this route.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (host === req.headers.host) return true;
  const allowed = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  try {
    if (process.env.STUDIO_URL) allowed.add(new URL(process.env.STUDIO_URL).host);
  } catch { /* malformed STUDIO_URL is not an authorisation */ }
  return allowed.has(host);
}

/** How far back a reconnecting stream will replay. Beyond this we send a gap frame. */
const STREAM_BACKFILL = Number(process.env.STUDIO_STREAM_BACKFILL || 2000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * The studio server is the single writer to the event log and the single place
 * both the agents (over the `studio` CLI) and the human (over the web UI) meet.
 */
export function createHttpServer(store, runner) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // The studio's own API is deliberately open cross-origin: it is a loopback
    // dev tool and the event log is already readable by anything that can reach
    // the port. The preview is not the same thing. It serves the human's
    // project directory, so a page they happen to have open in another tab must
    // not be able to read it out of the frame. Same server, narrower door.
    if (!isPreviewPath(p)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-studio-token');
    }
    if (req.method === 'OPTIONS') return end(res, 204, '');

    // The login page and its assets are the only unauthenticated surface, so a
    // human with the token can get a browser into a state where it holds one.
    if (TOKEN && (p.startsWith('/api/') || isPreviewPath(p)) && !authorised(req, url)) {
      // The preview is an iframe, which cannot send a header, so its 401 has to
      // be readable in the frame rather than a JSON blob nobody sees.
      if (isPreviewPath(p)) return html(res, 401, previewPage('This studio requires a token', 'Open the preview with <code>?token=…</code> on the URL, or unset <code>server.token</code>.'));
      return json(res, { ok: false, error: 'unauthorised — this studio requires a token' }, 401);
    }

    try {
      if (p === '/api/state') {
        return json(res, {
          ...store.getState(),
          // The UI must not hardcode a roster. It renders whoever is configured,
          // in configured order, whatever their ids and however many there are.
          roster: AGENTS.map((a) => ({ id: a.id, label: a.label, provider: a.provider })),
          project: { name: PROJECT.name, goal: PROJECT.goal, brief: PROJECT.brief },
          // The usage view forecasts against the turn budget, so it needs to
          // know what the budget is.
          runner: { maxTurns: RUNNER_CONFIG.maxTurns },
          // Live countdowns, not just limits: what a human wants to know about
          // a studio they left running is how much of it is left. Null when the
          // server runs without a runner, which the tests do.
          budgets: runner?.budgets?.() ?? null,
        });
      }

      if (p === '/api/events') {
        return json(res, {
          events: store.getEvents({
            since: num(url.searchParams.get('since'), 0),
            agent: url.searchParams.get('agent') || null,
            raw: triState(url.searchParams.get('raw')),
            kinds: url.searchParams.get('kinds')?.split(',').filter(Boolean) || null,
            limit: num(url.searchParams.get('limit'), 300),
          }),
          seq: store.seq,
        });
      }

      if (p === '/api/stream') return stream(req, res, store, url);

      if (p === '/api/inbox') return inbox(req, res, store, url);

      if (p === '/api/runner') return json(res, runner ? runner.status() : { agents: {} });

      // What the human can watch while the team builds. Resolved per request on
      // purpose: a game directory created one minute from now must light the
      // pane up without a restart.
      if (p === '/api/preview') return json(res, previewStatus());

      if (isPreviewPath(p)) return servePreview(p, url, req, res);

      if (p === '/api/config' && req.method !== 'POST') return json(res, readConfigForUi());

      if (p === '/api/projects' && req.method !== 'POST') {
        return json(res, {
          ok: true,
          current: { ...inspect(PROJECT_ROOT), legacyLayout: IS_LEGACY_LAYOUT },
          recent: recentProjects(),
          // The workspace is where clones land, and it is not the project. On
          // a cloud box the studio starts pointed at the workspace itself —
          // a directory holding repositories rather than a thing to build —
          // and a panel that shows only one path makes those look like the
          // same idea.
          workspace: {
            path: WORKSPACE_DIR,
            isProject: path.resolve(WORKSPACE_DIR) === path.resolve(PROJECT_ROOT),
            holds: listWorkspace(),
          },
          // What the team is actually building, when that is a directory inside
          // the project rather than the project itself. This studio's own team
          // builds in test_project/ and the panel never said so, which made the
          // whole section read as being about the wrong thing.
          building: (() => {
            const pv = resolvePreview(SERVER_CONFIG.preview);
            if (!pv.configured && !pv.root) return null;
            return {
              configured: pv.configured || '',
              path: pv.root || '',
              found: pv.found,
              reason: pv.reason,
              source: pv.source,
            };
          })(),
        });
      }

      // Look before you leap: the panel calls this as you type, so a switch is
      // never offered for a directory that cannot take one.
      if (p === '/api/update' && req.method !== 'POST') {
        // The network call is opt-in: rendering the settings page must not
        // reach out to a remote on its own.
        return json(res, updateStatus({ fetch: url.searchParams.get('check') === '1' }));
      }

      // What a provider is serving right now, asked of the provider with the
      // same key the agent would use. Falls back to the written list rather
      // than failing, so the dropdown always has something in it.
      if (p === '/api/models') {
        const vendor = url.searchParams.get('vendor') || '';
        return fetchModels(vendor).then((r) => json(res, { ok: true, vendor, ...r }));
      }

      // What this machine can actually run. The same probe `studio doctor`
      // performs, so the panel and the CLI cannot disagree about it.
      if (p === '/api/detect') return json(res, { ok: true, vendors: detect() });

      if (p === '/api/projects/inspect') {
        const dir = url.searchParams.get('path') || '';
        if (!dir) return json(res, { ok: false, error: 'no path given' }, 400);
        const info = inspect(dir);
        return json(res, { ok: true, info, problems: problemsWith(info) });
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        // Where did this come from?
        //
        // Every /api/human/* route appends with agent=null, describe() renders
        // that as "Human:", and the brief prints it under "the human has already
        // said this". So anything that can POST here is indistinguishable from the
        // creative director. On loopback that is not a security problem and we are
        // not each other's adversaries — but I proved it is a real one anyway by
        // probing the live server and handing codex and grok a directive the human
        // never sent. Two agents spent part of a turn reasoning about it.
        //
        // A browser fetch always carries origin or referer; node's does not. That
        // is a weak signal and it is not meant to resist anyone. It is meant to
        // stop an honest mistake from impersonating the human, which is the failure
        // that actually happened.
        if (p.startsWith('/api/human/')) body.via = req.headers.origin || req.headers.referer ? 'browser' : 'api';

        if (p === '/api/update') {
          if (!sameOrigin(req)) {
            return json(res, {
              ok: false,
              error: 'refused: this request came from another origin. Updating runs git '
                + 'against the installation and restarts it, so it is not writable cross-site.',
            }, 403);
          }
          return runUpdate(store, runner, res);
        }

        if (p === '/api/projects/clone') {
          if (!sameOrigin(req)) {
            return json(res, {
              ok: false,
              error: 'refused: this request came from another origin. Cloning decides what code '
                + 'lands on this machine for agents to run, so it is not writable cross-site.',
            }, 403);
          }
          return cloneProject(store, body, res);
        }

        if (p === '/api/projects') {
          if (!sameOrigin(req)) {
            return json(res, {
              ok: false,
              error: 'refused: this request came from another origin. Pointing the studio at a '
                + 'directory decides where agents run commands, so it is not writable cross-site.',
            }, 403);
          }
          return switchProject(store, runner, body, res);
        }

        if (p === '/api/restart') {
          if (!sameOrigin(req)) {
            return json(res, { ok: false, error: 'refused: this request came from another origin.' }, 403);
          }
          return restartStudio(store, runner, res);
        }

        if (p === '/api/secrets') {
          if (!sameOrigin(req)) {
            return json(res, {
              ok: false,
              error: 'refused: this request came from another origin. A provider key decides what '
                + 'this studio can spend, so it is not writable cross-site.',
            }, 403);
          }
          return json(res, writeSecret(store, body));
        }

        if (p === '/api/config') {
          if (!sameOrigin(req)) {
            return json(res, {
              ok: false,
              error: 'refused: this request came from another origin. The config decides which '
                + 'programs the studio launches, so it is not writable cross-site.',
            }, 403);
          }
          return json(res, writeConfigFromUi(store, runner, body));
        }
        if (p === '/api/action') return json(res, handleAction(store, body));
        // Reading is not handling. /delivered records what an agent was shown;
        // only /ack drops items out of its inbox. An agent that dies between the
        // two gets the same items back next turn, flagged as redelivered.
        if (p === '/api/inbox/delivered') {
          if (!AGENT_IDS.includes(body.agent)) {
            return json(res, { ok: false, error: `unknown agent "${body.agent}" — one of: ${AGENT_IDS.join(', ')}` }, 400);
          }
          const c = store.markDelivered(body.agent, body.through ?? store.seq, body.count || 0);
          return json(res, { ok: true, ...c });
        }
        if (p === '/api/inbox/ack') {
          if (!AGENT_IDS.includes(body.agent)) {
            return json(res, { ok: false, error: `unknown agent "${body.agent}" — one of: ${AGENT_IDS.join(', ')}` }, 400);
          }
          const c = store.ack(body.agent, body.through ?? null, body.reason || null);
          return json(res, { ok: true, ...c });
        }
        // Legacy read-is-acknowledgement path. Kept working rather than silently
        // no-opping for an older client, but it is the lossy behaviour TASK-14
        // exists to remove, so it says so on the way through.
        if (p === '/api/inbox/read') {
          if (!AGENT_IDS.includes(body.agent)) {
            return json(res, { ok: false, error: `unknown agent "${body.agent}" — one of: ${AGENT_IDS.join(', ')}` }, 400);
          }
          const c = store.markRead(body.agent, body.cursor || store.seq);
          return json(res, { ok: true, ...c, deprecated: 'use /api/inbox/delivered then /api/inbox/ack' });
        }
        if (p === '/api/human/say') {
          const ev = store.append('human.message', null, {
            from: 'human',
            to: normList(body.to),
            text: body.text || '',
            re: body.re || null,
            via: body.via,
          });
          runner?.wake(normList(body.to).length ? normList(body.to) : AGENT_IDS, 'the human said something');
          return json(res, { ok: true, seq: ev.seq });
        }
        if (p === '/api/human/control') return humanJson(res, () => humanControl(store, runner, body));
        if (p === '/api/human/verdict') return humanJson(res, () => humanVerdict(store, runner, body));
        // TASK-16: the four interventions that had no control anywhere.
        // Separate from /api/human/control so TASK-17 can harden that path
        // without inheriting these verbs, and so we never go through
        // handleAction (requireAgent rejects the human).
        if (p === '/api/human/task') return humanJson(res, () => humanCreateTask(store, runner, body));
        if (p === '/api/human/assign') return humanJson(res, () => humanAssign(store, runner, body));
        if (p === '/api/human/review') return humanJson(res, () => humanReview(store, runner, body));
        if (p === '/api/human/debate') return humanJson(res, () => humanDebate(store, runner, body));
        if (p === '/api/runner/start') {
          await runner?.start(body.agent);
          return json(res, { ok: true });
        }
        if (p === '/api/runner/stop') {
          await runner?.stop(body.agent, body.reason || 'stopped by human');
          return json(res, { ok: true });
        }
        if (p === '/api/runner/nudge') {
          runner?.wake([body.agent], body.text || 'the human nudged you');
          return json(res, { ok: true });
        }
      }

      return serveStatic(p, res);
    } catch (err) {
      return json(res, { error: String(err?.stack || err) }, 500);
    }
  });

  // HOST is loopback by default. A cloud deployment sets STUDIO_HOST=0.0.0.0,
  // and should not do that without STUDIO_TOKEN.
  server.listen(PORT, HOST);
  return server;
}

// -------------------------------------------------------------------- update

/**
 * Fast-forward the studio's own clone and restart into it.
 *
 * The restart is the supervisor's, exactly as for a project switch: this process
 * loaded its modules at import and cannot swap them underneath itself. It goes
 * back to the same project, so nothing about the team's state changes — only the
 * code running it.
 */
async function runUpdate(store, runner, res) {
  const result = pullUpdate();
  if (!result.ok) return json(res, { ok: false, errors: result.errors }, 400);

  if (!result.changed) {
    return json(res, { ok: true, changed: false, message: 'already up to date' });
  }

  store.append('human.control', null, {
    action: 'update',
    text: `updated the studio from ${result.from} to ${result.to}`
      + `${result.commits?.length ? ` — ${result.commits.length} commit(s)` : ''}`,
    via: 'browser',
    from: result.from,
    to: result.to,
  });

  json(res, { ok: true, changed: true, from: result.from, to: result.to, commits: result.commits });

  setTimeout(async () => {
    try {
      await runner?.stopAll('the human updated the studio');
    } catch { /* leaving anyway */ }
    // Same project, new code.
    requestSwitch(PROJECT_ROOT, { reset: false, reason: 'update' });
    store.close?.();
    process.exit(EXIT_SWITCH);
  }, 250);
  return undefined;
}

// ------------------------------------------------------------------ projects

/**
 * Point the studio at a different directory, or forget one.
 *
 * This process cannot follow: its project root was fixed at import and its store
 * has already replayed one log. So it stops the agents, records where to go, and
 * exits with EXIT_SWITCH — the supervisor starts a fresh studio there.
 *
 * Resume is not implemented anywhere, because it does not need to be. A
 * project's event log lives inside the project, so arriving at a directory the
 * team has worked in before finds the whole history where it was left. Reset is
 * the deliberate opposite: the supervisor deletes that state before the new
 * studio starts, while nothing is holding the files open.
 */
/**
 * What is already sitting in the workspace.
 *
 * Cheap and shallow on purpose — this is a list of names for a dropdown, not a
 * survey. A directory with a .git in it is a repository somebody cloned; the
 * rest are reported anyway, because a folder somebody copied there by hand is
 * just as valid a project and refusing to mention it would be a lie about what
 * is on the disk.
 */
function listWorkspace() {
  try {
    // The studio's own directories are not projects. Offering `studio_floor`
    // or the state directory as somewhere to work would point the team at the
    // studio's memory of itself.
    const ours = new Set([path.resolve(STATE_DIR), path.resolve(HOME_DIR)]);
    return fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .filter((e) => !ours.has(path.resolve(WORKSPACE_DIR, e.name)))
      .map((e) => {
        const full = path.join(WORKSPACE_DIR, e.name);
        return {
          name: e.name,
          path: full,
          isGitRepo: fs.existsSync(path.join(full, '.git')),
          isCurrent: path.resolve(full) === path.resolve(PROJECT_ROOT),
        };
      })
      .slice(0, 50);
  } catch {
    return [];
  }
}

/**
 * Put a repository on this machine.
 *
 * Separate from the switch on purpose: this one acquires a directory and the
 * other one moves the studio into it, and keeping them apart means a clone that
 * lands somewhere unexpected can be looked at before the team is turned loose
 * in it. The UI calls them in sequence; a human can call either alone.
 *
 * Local paths are refused here even though the CLI accepts them. A person at a
 * shell on this box can already clone anything they like; a request arriving
 * over HTTP is a different thing, and `file:///` is how a remote caller reaches
 * the rest of the disk.
 */
async function cloneProject(store, body, res) {
  const remote = parseRemote(body?.url, { allowLocal: false });
  if (!remote.ok) return json(res, { ok: false, error: remote.error }, 400);

  const name = String(body?.name || '').trim() || remote.name;
  const problem = checkName(name);
  if (problem) return json(res, { ok: false, error: problem }, 400);

  const into = WORKSPACE_DIR;
  const dest = path.join(into, name);
  if (fs.existsSync(dest)) {
    return json(res, {
      ok: false,
      error: `${dest} already exists — switch to it, or clone under another name`,
      path: dest,
      exists: true,
    }, 409);
  }

  const credentials = ensureGitIdentity();
  const result = await cloneRepo({
    url: remote.url,
    into,
    name,
    depth: Number(body?.depth) > 0 ? Number(body.depth) : 0,
    // Shorter than the CLI's: a browser is holding this request open, and a
    // clone that needs longer than two minutes wants a shell and a log, not a
    // spinner.
    timeoutMs: 120_000,
  });

  if (!result.ok) {
    return json(res, { ok: false, error: result.error, output: tail(result.output) }, 502);
  }

  const info = inspect(result.path);
  store.append('human.control', null, {
    action: 'clone',
    // The URL as rebuilt from its parts, never the caller's string, and never
    // anything carrying a credential.
    text: `cloned ${remote.url} into ${result.path}`,
    via: 'browser',
    target: result.path,
    repo: remote.repo,
    host: remote.host,
  });

  return json(res, {
    ok: true,
    path: result.path,
    name,
    info,
    credentials: { token: credentials.token, from: credentials.tokenFrom },
  });
}

/** The last few lines of git's own output, for a human who wants the detail. */
const tail = (text, lines = 6) => String(text || '').trim().split('\n').slice(-lines).join('\n');

async function switchProject(store, runner, body, res) {
  const { path: target, reset = false, forget = false } = body || {};
  if (typeof target !== 'string' || !target.trim()) {
    return json(res, { ok: false, error: 'no path given' }, 400);
  }

  if (forget) {
    return json(res, { ok: true, forgotten: true, recent: forgetProject(target) });
  }

  const info = inspect(target);
  const problems = problemsWith(info);
  if (problems.length) return json(res, { ok: false, errors: problems }, 400);

  if (path.resolve(target) === PROJECT_ROOT && !reset) {
    return json(res, { ok: false, error: 'the studio is already working in that directory' }, 400);
  }

  store.append('human.control', null, {
    action: 'switch-project',
    text: `pointed the studio at ${path.resolve(target)}${reset ? ' and reset its history' : ''}`
      + `${info.hasState && !reset ? ` — resuming ${info.events} recorded events` : ''}`,
    via: 'browser',
    target: path.resolve(target),
    reset: Boolean(reset),
  });

  // Answer before leaving, or the browser sees a dropped socket instead of a
  // reason. The exit is deferred just long enough for this response to flush.
  json(res, {
    ok: true,
    switching: path.resolve(target),
    reset: Boolean(reset),
    resuming: info.hasState && !reset ? info.events : 0,
  });

  setTimeout(async () => {
    try {
      await runner?.stopAll('the human pointed the studio at another project');
    } catch { /* leaving anyway */ }
    requestSwitch(target, { reset });
    store.close?.();
    process.exit(EXIT_SWITCH);
  }, 250);
  return undefined;
}

// ------------------------------------------------------------------- config

/**
 * What the settings panel is shown.
 *
 * Read from disk on every request rather than served from the roster loaded at
 * boot, so the panel shows what the file actually says — including edits made in
 * an editor while the studio was running, and including the fields the panel
 * refuses to manage. Showing the boot-time roster would quietly hide a change
 * the human had already made.
 */
function readConfigForUi() {
  let raw;
  try {
    raw = readRawConfig(CONFIG_FILE);
  } catch (e) {
    return { ok: false, error: e.message, file: CONFIG_FILE };
  }
  const resolved = normaliseConfig(raw);

  // Which of the file's agents carry fields the panel must not touch. The UI
  // marks these so nobody wonders why an agent looks different in the file.
  const protectedBy = {};
  for (const a of Array.isArray(raw.agents) ? raw.agents : []) {
    if (!a || typeof a !== 'object') continue;
    const found = [...AGENT_PROTECTED_OPTIONS, ...AGENT_SECRET_OPTIONS].filter(
      (k) => a[k] !== undefined || a.options?.[k] !== undefined,
    );
    if (found.length) protectedBy[a.id] = found;
  }

  return {
    ok: true,
    file: CONFIG_FILE,
    exists: fs.existsSync(CONFIG_FILE),
    // The resolved view, so the panel shows the defaults that are actually in
    // force rather than empty boxes for everything the file left unset.
    config: {
      project: resolved.project,
      agents: resolved.agents.map((a) => ({
        id: a.id,
        provider: a.provider,
        label: a.label,
        // Send back the persona *key* when it is a built-in, so the panel can
        // select it rather than showing the expanded paragraph in a text box.
        persona: personaKeyOf(a.persona) ?? a.persona,
        model: a.options?.model || '',
        preset: a.preset || '',
        baseUrl: a.options?.baseUrl || '',
        apiKeyEnv: a.options?.apiKeyEnv || '',
        // Never the key itself: a settings page that echoes a secret back is a
        // secret one screenshot away from being public. Its presence is enough
        // for the panel to warn about it.
        apiKey: a.options?.apiKey ? true : false,
        sandbox: a.options?.sandbox || '',
        permissionMode: a.options?.permissionMode || '',
        disableMcp: a.options?.disableMcp ?? null,
        auth: a.options?.auth || 'auto',
        // Whether this agent has a usable credential and where it comes from —
        // never the credential. The panel can then say "key stored" or "no key"
        // instead of the human finding out on the first turn.
        credentials: authSummary(a),
      })),
      runner: resolved.runner,
      server: { port: resolved.server.port, host: resolved.server.host, token: resolved.server.token ? '(set)' : null },
      adapters: Array.isArray(raw.adapters) ? raw.adapters : [],
    },
    protectedFields: protectedBy,
    providers: providers(),
    schema: configSchema({ knownProviders: providers() }),
    // Whether this studio can store a key at all, so the panel offers the field
    // or explains why it cannot.
    secrets: { ...storageHint(), stored: listSecrets() },
    // Whether this studio can restart itself, which depends on something being
    // there to start it again.
    canRestart: Boolean(process.env.STUDIO_SUPERVISED),
    // The roster this process is actually running, so the panel can say plainly
    // when the file and the running studio have diverged.
    running: AGENTS.map((a) => ({ id: a.id, provider: a.provider })),
  };
}

/**
 * Restart this studio, in place.
 *
 * The roster is resolved once at import, so a change to it cannot apply live —
 * the panel has always said so and then left the human to find the terminal it
 * was started in, which on a box they reach only through a browser is not a
 * thing they can do at all.
 *
 * Mechanically identical to a project switch, pointed at the project already
 * open: ask the supervisor to start us again, then exit. Refused outright when
 * nothing is supervising, because there the same exit is simply the end.
 */
async function restartStudio(store, runner, res) {
  if (!process.env.STUDIO_SUPERVISED) {
    return json(res, {
      ok: false,
      error: 'this studio was started without a supervisor, so exiting would stop it for good. '
        + 'Start it with `studio start` for this button to work, or restart it yourself.',
    }, 409);
  }

  store.append('human.control', null, {
    action: 'restart',
    text: 'restarted the studio from the settings panel',
    via: 'browser',
  });

  // Answer first. The socket dies with the process, and a browser that sees a
  // dropped connection instead of a reason cannot tell a restart from a crash.
  json(res, { ok: true, restarting: PROJECT_ROOT });

  setTimeout(async () => {
    try {
      await runner?.stopAll('the human restarted the studio');
    } catch { /* leaving anyway */ }
    requestSwitch(PROJECT_ROOT, { reset: false });
    store.close?.();
    process.exit(EXIT_SWITCH);
  }, 250);
  return undefined;
}

/**
 * Store or clear one agent's API key.
 *
 * Write-only, the way Grafana's secureJsonData and n8n's credentials are: it
 * can be set from a browser and never read back into one. The response says
 * whether a key is now present, and nothing else — an "ends in …a1b2" hint is
 * still four characters of a secret in a response that crosses a network.
 */
function writeSecret(store, body) {
  // Generating a passphrase is a separate, explicit act. It is never a silent
  // fallback, because a passphrase kept beside the keys it protects is a real
  // downgrade and the human asking for it should have been told that first.
  if (body?.generateKey && !secretKey()) {
    generateKey();
    store.append('human.control', null, {
      action: 'secret',
      text: 'generated an encryption passphrase for stored keys, kept on this machine',
      via: 'browser',
    });
  }

  const agent = String(body?.agent || '').trim();
  if (!AGENT_IDS.includes(agent)) {
    return { ok: false, error: `no agent "${agent}" in this studio — it is ${AGENT_IDS.join(', ')}` };
  }
  const value = typeof body?.value === 'string' ? body.value.trim() : '';
  const name = secretNameFor(agent);

  if (!value) {
    removeSecret(name);
    // Recorded, because a key disappearing is a change to what this studio can
    // do, and the feed is where "why did that agent stop working" gets answered.
    store.append('human.control', null, { action: 'secret', text: `cleared the API key for ${agent}`, via: 'browser' });
    return { ok: true, agent, set: false };
  }

  try {
    putSecret(name, value);
  } catch (e) {
    return { ok: false, error: e.message === NO_KEY ? NO_KEY : `could not store that key — ${e.message}` };
  }
  store.append('human.control', null, { action: 'secret', text: `set an API key for ${agent}`, via: 'browser' });
  return { ok: true, agent, set: true };
}

/**
 * What the panel is allowed to know about an agent's credentials.
 *
 * Deliberately shaped so there is nothing here to leak: whether a key exists,
 * where it came from, and the name of the variable. Never a value, and never a
 * prefix of one — a "sk-ant-…" hint is still four characters of a secret in a
 * response that crosses a network.
 */
function authSummary(agent) {
  const adapter = getAdapter(agent.provider);
  const a = resolveAuth(agent, adapter);
  return {
    mode: a.mode, source: a.source, keyVar: a.keyVar, ok: a.ok, detail: a.detail,
  };
}

function personaKeyOf(text) {
  for (const [key, body] of Object.entries(PERSONAS)) {
    if (typeof text === 'string' && text.startsWith(body)) return key;
  }
  return null;
}

/**
 * Save an edit from the settings panel.
 *
 * Validates, writes the file, applies live what can genuinely be applied live,
 * and reports honestly what still needs a restart. Every accepted change is
 * appended to the event log, because a human quietly changing what the agents
 * are allowed to do is exactly the kind of thing the timeline exists to record.
 */
function writeConfigFromUi(store, runner, body) {
  let raw;
  try {
    raw = readRawConfig(CONFIG_FILE);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const { config: next, errors, warnings } = applyConfigPatch(
    raw, body || {}, { knownProviders: providers() },
  );
  if (errors.length) return { ok: false, errors };

  const before = normaliseConfig(raw);
  const restart = restartRequiredFor(raw, next);

  try {
    saveRawConfig(CONFIG_FILE, next);
  } catch (e) {
    return { ok: false, error: `could not write ${CONFIG_FILE}: ${e.message}` };
  }

  // Apply what the runner re-reads each loop. Everything else is honestly
  // reported as pending rather than pretended into effect.
  const applied = [];
  const resolved = normaliseConfig(next);
  if (runner) {
    for (const k of RUNNER_EDITABLE) {
      if (JSON.stringify(before.runner[k]) !== JSON.stringify(resolved.runner[k])) {
        runner.config[k] = resolved.runner[k];
        applied.push(`runner.${k}`);
      }
    }
    if (before.project.name !== resolved.project.name || before.project.goal !== resolved.project.goal) {
      runner.config.project = resolved.project;
      applied.push('project');
    }
  }

  store.append('human.control', null, {
    action: 'configure',
    text: describeConfigChange(before, resolved, applied, restart),
    via: 'browser',
    applied,
    restartRequired: restart,
  });

  return {
    ok: true, applied, restartRequired: restart, warnings,
    config: readConfigForUi().config,
  };
}

function describeConfigChange(before, after, applied, restart) {
  const bits = [];
  const ids = (c) => c.agents.map((a) => a.id);
  const wasIds = ids(before);
  const nowIds = ids(after);
  const added = nowIds.filter((i) => !wasIds.includes(i));
  const removed = wasIds.filter((i) => !nowIds.includes(i));
  if (added.length) bits.push(`added ${added.join(', ')}`);
  if (removed.length) bits.push(`removed ${removed.join(', ')}`);
  for (const a of after.agents) {
    const b = before.agents.find((x) => x.id === a.id);
    if (!b) continue;
    if (b.provider !== a.provider) bits.push(`${a.id} now runs on ${a.provider}`);
    if (b.persona !== a.persona) bits.push(`${a.id}'s persona changed`);
    if ((b.options?.sandbox || '') !== (a.options?.sandbox || '')) {
      bits.push(`${a.id} sandbox → ${a.options?.sandbox || 'default'}`);
    }
    if ((b.options?.permissionMode || '') !== (a.options?.permissionMode || '')) {
      bits.push(`${a.id} permissions → ${a.options?.permissionMode || 'default'}`);
    }
    if ((b.options?.model || '') !== (a.options?.model || '')) {
      bits.push(`${a.id} model → ${a.options?.model || 'provider default'}`);
    }
  }
  for (const k of RUNNER_EDITABLE) {
    if (JSON.stringify(before.runner[k]) !== JSON.stringify(after.runner[k])) {
      bits.push(`${k} ${JSON.stringify(before.runner[k])} → ${JSON.stringify(after.runner[k])}`);
    }
  }
  if (!bits.length) bits.push('saved with no effective change');
  const tail = restart.length ? ` — needs a restart (${restart.join('; ')})` : '';
  return `changed the studio configuration: ${bits.join('; ')}${tail}`;
}

// ------------------------------------------------------------------ actions

/**
 * Every verb an agent can perform against the shared state. IDs are allocated
 * here so two agents acting at the same moment can never collide on one.
 */
export function handleAction(store, body) {
  const { verb } = body;
  if (!verb) throw new Error('missing verb');
  const s = store.state;
  const agent = requireAgent(body.agent);

  switch (verb) {
    case 'register':
      return ok(store.append('agent.registered', agent, {
        strengths: normList(body.strengths),
        intro: body.intro || '',
        state: 'idle',
      }));

    case 'state':
      return ok(store.append('agent.state', agent, {
        state: requireEnum(body.state, AGENT_STATES, 'agent state'),
        task: body.task ? requireTask(s, body.task) : null,
        note: body.note || '',
      }));

    case 'say':
      return ok(store.append('message.sent', agent, {
        from: agent,
        to: requireEach(normList(body.to), RECIPIENTS, 'recipient'),
        kind: requireEnum(body.kind || 'chat', MESSAGE_KINDS, 'message kind'),
        text: body.text || '',
        re: body.re || null,
      }));

    case 'task.create': {
      const id = `TASK-${String(++s.counters.task).padStart(2, '0')}`;
      const ev = store.append('task.created', agent, {
        id,
        title: body.title || '',
        objective: body.objective || '',
        owner: body.owner ? requireAgent(body.owner, 'owner') : null,
        reviewer: body.reviewer ? requireAgent(body.reviewer, 'reviewer') : null,
        state: requireEnum(body.state || (body.owner ? 'assigned' : 'proposed'), TASK_STATES, 'task state'),
        context: body.context || '',
        deps: normList(body.deps).map((dep) => requireTask(s, dep, 'dependency')),
      });
      return { ok: true, seq: ev.seq, id };
    }

    case 'task.update': {
      requireTask(s, body.id);
      const changes = { ...(body.changes || {}) };
      for (const k of ['state', 'owner', 'reviewer', 'title', 'objective', 'context', 'result', 'blockedBy']) {
        if (body[k] !== undefined) changes[k] = body[k];
      }
      // An unknown state lands in the projection but matches no board column, so
      // the task disappears from the human's view while still existing.
      if (changes.state !== undefined) requireEnum(changes.state, TASK_STATES, 'task state');
      for (const role of ['owner', 'reviewer']) {
        if (changes[role]) requireAgent(changes[role], role);
      }
      return ok(store.append('task.updated', agent, { id: body.id, changes, note: body.note || '' }));
    }

    case 'decision': {
      const question = requireText(body.question, 'question',
        'a decision nobody can read the question of cannot be applied or argued with');
      const supersedes = requireKnownDecision(s, body.supersedes);
      requireNotAlreadyDecided(s, question, supersedes);
      const id = `DEC-${String(++s.counters.decision).padStart(2, '0')}`;
      const ev = store.append('decision.recorded', agent, {
        id,
        question,
        supersedes,
        alternatives: normList(body.alternatives),
        arguments: normList(body.arguments),
        chosen: requireText(body.chosen, 'chosen',
          'a decision appears in every brief under do-not-reopen, so one that chose'
          + ' nothing instructs future turns and cannot be argued with'),
        why: body.why || '',
        participants: requireEach(normList(body.participants), RECIPIENTS, 'participant'),
        humanRole: requireEnum(body.humanRole || 'none', HUMAN_ROLES, 'human role'),
        relatedTask: body.relatedTask ? requireTask(s, body.relatedTask) : null,
      });
      return { ok: true, seq: ev.seq, id };
    }

    case 'debate.open': {
      const id = `DEB-${String(++s.counters.debate).padStart(2, '0')}`;
      const ev = store.append('debate.opened', agent, {
        id,
        question: requireText(body.question, 'question',
          'a debate with no question is one nobody else can take a position on'),
        relatedTask: body.relatedTask ? requireTask(s, body.relatedTask) : null,
      });
      return { ok: true, seq: ev.seq, id };
    }

    // A position or a close aimed at a debate that does not exist used to return
    // ok and then vanish in the projection. Silent disappearance is the worst
    // failure this studio can have: an agent believes it argued, the record says
    // it never spoke. Fail loudly instead, and name the ids that do exist.
    case 'debate.position':
      requireOpenDebate(s, body.id);
      return ok(store.append('debate.position', agent, {
        id: body.id,
        stance: requireText(body.stance, 'stance',
          'a position with no stance is recorded as a participant who said nothing,'
          + ' which makes the debate look settled'),
        because: body.because || '',
        critique: body.critique || '',
        round: body.round || null,
      }));

    case 'debate.close':
      requireOpenDebate(s, body.id);
      return ok(store.append('debate.closed', agent, {
        id: body.id,
        outcome: body.outcome || '',
        decisionId: body.decisionId || null,
      }));

    case 'question.open': {
      const id = `Q-${String(++s.counters.question).padStart(2, '0')}`;
      const ev = store.append('question.opened', agent, { id, text: body.text || '' });
      return { ok: true, seq: ev.seq, id };
    }

    case 'question.close':
      requireOpenQuestion(s, body.id);
      return ok(store.append('question.closed', agent, { id: body.id, answer: body.answer || '' }));

    // Returns the ATT id, not just the seq.
    //
    // codex's TASK-02 review: the id is derived from the seq during projection, so
    // the caller was left to work out ATT-<seq> or go hunting in the brief — while
    // the CLI help right underneath documents `withdraw <ATT-id>`. Every other
    // creating verb here already returns its id; this one was the exception because
    // nothing had needed it until withdrawal existed.
    case 'attention': {
      const ev = store.append('attention.raised', agent, {
        kind: requireEnum(body.kind || 'decision', ATTENTION_KINDS, 'attention kind'),
        text: body.text || '',
        options: normList(body.options),
        ref: body.ref ? requireRef(s, body.ref) : null,
      });
      return { ok: true, seq: ev.seq, id: `ATT-${ev.seq}` };
    }

    // Taking back an ask that went stale.
    //
    // the project brief tells us not to overwhelm the human, and until now the queue
    // could only grow from our side: agents raise attention and only the human
    // clears it, so a superseded ask sat there forever. Three guards make this
    // safe to hand to an agent:
    //   - you may only withdraw what YOU raised, so nobody can silence a
    //     colleague's escalation or the one thing the human was about to act on
    //   - a reason is required, because "this no longer needs you" is a claim
    //   - the status becomes 'withdrawn', never 'cleared', and the event stays in
    //     the timeline, so the human can see we did it and disagree
    case 'attention.withdraw': {
      const id = String(body.id || '').trim();
      const item = s.attention.find((x) => x.id === id);
      if (!item) {
        const open = s.attention.filter((x) => x.status === 'open').map((x) => x.id);
        throw new Error(
          `no such attention ${show(id)}${open.length ? ` — open attention is ${open.join(', ')}` : ' — nothing is open'}`,
        );
      }
      if (item.status !== 'open') {
        throw new Error(`attention ${id} is already ${item.status} — nothing to withdraw`);
      }
      if (item.by !== agent) {
        throw new Error(
          `${id} was raised by ${item.by || 'the studio'}, not by ${agent} — ask them to withdraw it, or leave it for the human`,
        );
      }
      const reason = String(body.reason || '').trim();
      if (!reason) {
        throw new Error('withdrawing needs a reason — say why the human no longer needs to act');
      }
      return ok(store.append('attention.withdrawn', agent, { id, reason }));
    }

    case 'files':
      return ok(store.append('work.files', agent, {
        action: requireEnum(body.action || 'changed', FILE_ACTIONS, 'file action'),
        files: normList(body.files),
        task: body.task ? requireTask(s, body.task) : null,
      }));

    case 'validation':
      return ok(store.append('work.validation', agent, {
        name: body.name || 'validation',
        command: body.command || '',
        ok: !!body.ok,
        output: (body.output || '').slice(0, 8000),
        task: body.task ? requireTask(s, body.task) : null,
      }));

    case 'discovery':
      return ok(store.append('work.discovery', agent, { text: body.text || '', ref: body.ref || null }));

    case 'note':
      return ok(store.append('studio.note', agent, { text: body.text || '' }));

    default:
      throw new Error(`unknown verb ${verb}`);
  }
}

function ok(ev) {
  return { ok: true, seq: ev.seq };
}

// -------------------------------------------------------------- validation

/**
 * Every id and enum a caller supplies is checked here, at the door.
 *
 * The projection is written defensively — `const t = s.tasks[d.id]; if (!t)
 * break;` — so an action naming something that does not exist used to be
 * accepted, appended, and then dropped on the floor. The agent is told ok and
 * its work leaves no trace. That is the one failure this studio cannot have:
 * an event that exists on disk but appears in no view means the human is
 * looking at a record that is quietly incomplete.
 *
 * So these throw, and every message names what would have worked. An agent
 * that fat-fingers a flag mid-turn should be able to fix it from the error.
 */
const RECIPIENTS = [...AGENT_IDS, 'human'];
const ATTENTION_KINDS = ['decision', 'blocked', 'conflict', 'review'];
const FILE_ACTIONS = ['changed', 'added', 'deleted'];
const HUMAN_ROLES = ['none', 'made', 'override', 'approved'];
const HUMAN_CONTROL_ACTIONS = ['pause', 'resume', 'stop', 'nudge', 'priority'];
const HUMAN_VERDICTS = ['approve', 'reject', 'reply'];

async function humanJson(res, fn) {
  try {
    return json(res, await fn());
  } catch (err) {
    return json(res, { error: err.message || String(err) }, 400);
  }
}

async function humanControl(store, runner, body) {
  // The projection and runner only understand this finite set. Accepting an
  // arbitrary verb records a control that does nothing while telling the human
  // it worked. Assignment/review/debate have their own validated routes below.
  const action = requireEnum(body.action, HUMAN_CONTROL_ACTIONS, 'human control action');
  const target = body.target ? requireAgent(body.target, 'control target') : null;
  const text = String(body.text || '').trim();

  if (action === 'priority' && target) {
    throw new Error('priority is studio-wide — omit control target and say the priority in text');
  }
  if (action === 'priority' && !text) {
    throw new Error('priority needs text — say what the team should prioritize');
  }

  const control = { action, target, text, via: body.via };
  const ev = store.append('human.control', null, control);
  try {
    await runner?.onControl(control);
    return { ok: true, seq: ev.seq };
  } catch (err) {
    // The human's valid intent is already durable and projected. A runner
    // failure after that commit cannot truthfully turn the response into a
    // refusal: doing so tells the human nothing changed when pause/stop state
    // may already be visible. Report delivery as degraded, while preserving
    // the successful control write and its sequence.
    const reason = err?.message || String(err);
    const warning = controlDeliveryWarning(control, reason);
    try {
      store.append('human.control.delivery-failed', null, {
        controlSeq: ev.seq,
        action: control.action,
        target: control.target,
        reason,
        warning,
        via: control.via,
      });
    } catch (recordErr) {
      // The control itself is already committed. Even failure to append the
      // follow-up annotation cannot truthfully turn that committed write into a
      // refusal; keep the response successful and disclose both degradations.
      return {
        ok: true,
        seq: ev.seq,
        warning: `${warning}; the delivery failure could not be added to the event log: ${recordErr?.message || String(recordErr)}`,
      };
    }
    return { ok: true, seq: ev.seq, warning };
  }
}

function controlDeliveryWarning(control, reason) {
  const target = control.target || 'agents';
  switch (control.action) {
    case 'stop':
      return `stop was recorded, but ${target === 'agents' ? 'agents' : target} may still be running: ${reason}`;
    case 'pause':
      return `pause was recorded, but agents may still be running: ${reason}`;
    case 'resume':
      return `resume was recorded, but ${target === 'agents' ? 'agents may still be paused' : `${target} may still be paused`}: ${reason}`;
    case 'nudge':
      return `nudge was recorded, but ${target === 'agents' ? 'agents may not have been woken' : `${target} may not have been woken`}: ${reason}`;
    case 'priority':
      return `priority was recorded, but agents may not have been woken to see it: ${reason}`;
    default:
      return `control was recorded, but runner delivery failed: ${reason}`;
  }
}

function humanVerdict(store, runner, body) {
  const verdict = requireEnum(body.verdict, HUMAN_VERDICTS, 'human verdict');
  const target = requireVerdictTarget(store.state, body.target, verdict);
  const text = String(body.text || '').trim();
  if (verdict === 'reply' && !text) {
    throw new Error('reply needs text — say what the team should know');
  }
  const ev = store.append('human.verdict', null, {
    target,
    verdict,
    text,
    via: body.via,
  });
  runner?.wake(AGENT_IDS, 'the human answered a request for input');
  return { ok: true, seq: ev.seq };
}

function humanCreateTask(store, runner, body) {
  const s = store.state;
  const title = String(body.title || '').trim();
  if (!title) throw new Error('a task needs a title');
  const owner = body.owner ? requireAgent(body.owner, 'owner') : null;
  const reviewer = body.reviewer ? requireAgent(body.reviewer, 'reviewer') : null;
  const id = `TASK-${String(++s.counters.task).padStart(2, '0')}`;
  store.append('human.control', null, {
    action: owner ? 'assign' : 'task',
    target: owner,
    text: body.text || title,
    task: id,
  });
  const ev = store.append('task.created', null, {
    id,
    title,
    objective: body.objective || '',
    owner,
    reviewer,
    state: owner ? 'assigned' : 'proposed',
    context: body.context || 'created by the human',
    deps: [],
  });
  if (owner) runner?.wake([owner], `the human assigned ${id} to you`);
  else runner?.wake(AGENT_IDS, `the human created ${id}`);
  return { ok: true, seq: ev.seq, id };
}

function humanAssign(store, runner, body) {
  const s = store.state;
  const taskId = requireTask(s, body.task || body.id);
  const owner = requireAgent(body.owner, 'owner');
  const t = s.tasks[taskId];
  const action = t.owner && t.owner !== owner ? 'reassign' : 'assign';
  // Sibling of `changes`, never inside it: #project Object.assigns changes
  // onto the task, and previousOwner is an event fact, not a task field.
  const previousOwner = action === 'reassign' ? t.owner : null;
  store.append('human.control', null, {
    action,
    target: owner,
    text: body.text || `${action} ${taskId} to ${owner}`,
    task: taskId,
    previousOwner,
  });
  const changes = { owner };
  if (!t.owner || t.state === 'proposed' || t.state === 'ready') changes.state = 'assigned';
  const ev = store.append('task.updated', null, {
    id: taskId,
    changes,
    previousOwner,
    note: body.text || `human ${action}ed to ${owner}`,
  });
  runner?.wake([owner], `the human ${action}ed ${taskId} to you`);
  if (t.owner && t.owner !== owner) runner?.wake([t.owner], `the human moved ${taskId} off you`);
  return { ok: true, seq: ev.seq, id: taskId, action };
}

function humanReview(store, runner, body) {
  const s = store.state;
  const taskId = requireTask(s, body.task || body.id);
  const reviewer = requireAgent(body.reviewer, 'reviewer');
  const t = s.tasks[taskId];
  store.append('human.control', null, {
    action: 'review',
    target: reviewer,
    text: body.text || `request review of ${taskId} by ${reviewer}`,
    task: taskId,
  });
  const ev = store.append('task.updated', null, {
    id: taskId,
    changes: { state: 'under-review', reviewer },
    note: body.text || `human requested review by ${reviewer}`,
  });
  runner?.wake([reviewer], `the human asked you to review ${taskId}`);
  if (t.owner && t.owner !== reviewer) runner?.wake([t.owner], `the human sent ${taskId} to review`);
  return { ok: true, seq: ev.seq, id: taskId };
}

function humanDebate(store, runner, body) {
  const s = store.state;
  const question = String(body.question || body.text || '').trim();
  if (!question) throw new Error('a debate needs a question — say what the team should settle');
  const relatedTask = body.relatedTask || body.task || null;
  if (relatedTask) requireTask(s, relatedTask);
  const id = `DEB-${String(++s.counters.debate).padStart(2, '0')}`;
  store.append('human.control', null, {
    action: 'debate',
    target: null,
    text: question,
    debate: id,
    relatedTask,
  });
  const ev = store.append('debate.opened', null, {
    id,
    question,
    relatedTask,
  });
  runner?.wake(AGENT_IDS, `the human requested a debate: ${question}`);
  return { ok: true, seq: ev.seq, id };
}

function requireAgent(id, label = 'agent') {
  if (AGENT_IDS.includes(id)) return id;
  throw new Error(
    `unknown ${label} ${show(id)} — this studio is ${AGENT_IDS.join(', ')}` +
    (label === 'agent' ? '. Set STUDIO_AGENT or pass --agent.' : '.'),
  );
}

function requireEnum(value, allowed, label) {
  if (allowed.includes(value)) return value;
  throw new Error(`invalid ${label} ${show(value)} — expected one of ${allowed.join(', ')}`);
}

function requireEach(values, allowed, label) {
  for (const v of values) {
    if (!allowed.includes(v)) {
      throw new Error(`unknown ${label} ${show(v)} — expected one of ${allowed.join(', ')}`);
    }
  }
  return values;
}

/**
 * The field that IS the content cannot be empty.
 *
 * requireOpenDebate already stops a position aimed at a debate that does not
 * exist, on the grounds that silent disappearance is the worst failure this
 * studio can have. An empty position is the same failure one field deeper, and
 * it happened: an agent posted a stance, a because and a critique that were all
 * empty strings, the server said ok, and the brief listed them as a participant
 * who had argued nothing. Nobody saw it until someone read the raw event log.
 *
 * That is worse than a refusal, because a debate with a silent participant
 * looks settled. So the content field is required and the refusal says which
 * one, rather than recording a record of nothing.
 */
function requireText(value, label, why) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text) return text;
  throw new Error(`${label} cannot be empty — ${why}`);
}

/**
 * Two agents deciding the same thing at the same time.
 *
 * DEB-04 produced three decision records for one question — DEC-10, DEC-11 and
 * DEC-12, by three different agents inside ten minutes, two of them with
 * byte-identical question text. Every one of them was recorded, and every one
 * appears in the brief under "do not reopen without new information". A future
 * turn reading that has to work out for itself that three instructions are one.
 *
 * Superseding is legitimate: DEC-06 was correctly replaced when new information
 * arrived. So this refuses the ACCIDENT and not the revision, and the way
 * through is to name the decision being replaced — which is also the thing a
 * later reader needs in order to follow the chain.
 *
 * It catches the clean case and not a paraphrase. DEC-11 would have been
 * refused; my own DEC-12 reworded the question and would still have got in.
 * The deeper fix is one path for recording a decision at all, which is a change
 * to how debates close and not something to slip in behind a validation guard.
 */
const normQuestion = (q) => String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();

function requireKnownDecision(s, id) {
  if (!id) return null;
  if (s.decisions.some((d) => d.id === id)) return id;
  const known = s.decisions.map((d) => d.id);
  throw new Error(
    `no such decision ${show(id)}${known.length ? ` — decisions are ${known.join(', ')}` : ' — none exist yet'}`,
  );
}

function requireNotAlreadyDecided(s, question, supersedes) {
  const already = s.decisions.find((d) => normQuestion(d.question) === normQuestion(question));
  if (!already || already.id === supersedes) return;
  throw new Error(
    `${already.id} has already decided that question — ${show(already.chosen)}.`
    + ` If this replaces it, pass --supersedes ${already.id}. If it is a different question, say so in the question.`,
  );
}

function requireTask(s, id, label = 'task') {
  if (s.tasks[id]) return id;
  const known = Object.keys(s.tasks);
  throw new Error(
    `no such ${label} ${show(id)}${known.length ? ` — known tasks are ${known.join(', ')}` : ' — no tasks exist yet'}`,
  );
}

/**
 * A verdict must land on state the human can still act on. In particular, an
 * attention id from a stale browser tab must not become a durable event that
 * projects nowhere. Direct task/decision verdicts are supported as well because
 * The protocol gives the human authority to approve or reject project decisions.
 */
function requireVerdictTarget(s, rawTarget, verdict) {
  const target = String(rawTarget || '').trim();
  if (!target) {
    throw new Error('a human verdict needs a target — use an open ATT id, an under-review TASK id, or a DEC id');
  }

  if (/^ATT-/i.test(target)) {
    const item = s.attention.find((x) => x.id === target);
    if (!item) {
      const open = s.attention.filter((x) => x.status === 'open').map((x) => x.id);
      throw new Error(`no such attention ${show(target)}${open.length ? ` — open attention is ${open.join(', ')}` : ' — no attention is open'}`);
    }
    if (item.status !== 'open') {
      throw new Error(`attention ${target} is already ${item.status}${item.resolution ? `: ${show(item.resolution)}` : ''}`);
    }
    return target;
  }

  if (/^TASK-/i.test(target)) {
    const id = requireTask(s, target);
    if (verdict === 'reply') {
      throw new Error('reply is only valid for an open attention item — approve or reject a task');
    }
    if (s.tasks[id].state !== 'under-review') {
      throw new Error(`task ${id} is ${s.tasks[id].state}, not under-review — request review before giving a verdict`);
    }
    return id;
  }

  if (/^DEC-/i.test(target)) {
    if (!s.decisions.some((d) => d.id === target)) {
      const known = s.decisions.map((d) => d.id);
      throw new Error(`no such decision ${show(target)}${known.length ? ` — known decisions are ${known.join(', ')}` : ' — no decisions exist yet'}`);
    }
    if (verdict === 'reply') {
      throw new Error('reply is only valid for an open attention item — approve or reject a decision');
    }
    return target;
  }

  throw new Error(
    `no verdict target ${show(target)} — use an open ATT id, an under-review TASK id, or a DEC id`,
  );
}

function requireOpenQuestion(s, id) {
  const q = s.questions.find((x) => x.id === id);
  if (q?.status === 'open') return q;
  if (q) throw new Error(`question ${id} is already answered: ${show(q.answer || '')}`);
  const open = s.questions.filter((x) => x.status === 'open').map((x) => x.id);
  throw new Error(
    `no such question ${show(id)}${open.length ? ` — open questions are ${open.join(', ')}` : ' — no questions are open'}`,
  );
}

/** An attention ref points the human at something. A dangling one points nowhere. */
function requireRef(s, ref) {
  if (/^TASK-/i.test(ref)) return requireTask(s, ref);
  if (/^DEB-/i.test(ref)) {
    if (s.debates[ref]) return ref;
    throw new Error(`no such debate ${show(ref)} — known debates are ${Object.keys(s.debates).join(', ') || 'none'}`);
  }
  if (/^DEC-/i.test(ref)) {
    if (s.decisions.some((d) => d.id === ref)) return ref;
    throw new Error(`no such decision ${show(ref)} — known decisions are ${s.decisions.map((d) => d.id).join(', ') || 'none'}`);
  }
  return ref; // free-form refs (a file, a URL) are the caller's business
}

function show(v) {
  return JSON.stringify(v ?? null);
}

function requireOpenDebate(s, id) {
  if (s.debates[id]?.status === 'open') return;
  const known = Object.keys(s.debates);
  if (s.debates[id]) throw new Error(`debate ${id} is already ${s.debates[id].status}`);
  throw new Error(
    `no such debate ${id}${known.length ? ` — open debates are ${known.join(', ')}` : ' — no debates exist yet'}`,
  );
}

// ------------------------------------------------------------------ streams

function stream(req, res, store, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Send bytes immediately. Without this, browsers can leave EventSource in
  // CONNECTING until the first real event or 20-second heartbeat arrives.
  res.flushHeaders?.();
  res.write(': connected\n\n');
  const since = num(url.searchParams.get('since'), store.seq);
  // Subscribe before reading the backfill. Any event appended during the
  // synchronous replay is buffered and deduplicated by sequence afterwards,
  // closing the replay/listener race.
  let buffering = true;
  const pending = [];
  const onEvent = (ev) => {
    if (buffering) pending.push(ev);
    else send(res, ev);
  };
  store.on('event', onEvent);
  const backfill = store.getEvents({ since, limit: STREAM_BACKFILL });
  // getEvents returns the NEWEST events after `since`. If the client fell
  // further behind than we can replay -- or if #trim() has evicted old raw
  // events from memory -- the gap is real and must be announced, or the raw
  // feed silently develops a hole the human has no way to notice.
  const oldest = backfill.length ? backfill[0].seq : since + 1;
  if (oldest > since + 1) {
    res.write(`event: gap\ndata: ${JSON.stringify({ from: since + 1, to: oldest - 1 })}\n\n`);
  }
  let sentThrough = since;
  for (const ev of backfill) {
    send(res, ev);
    sentThrough = Math.max(sentThrough, ev.seq);
  }
  while (pending.length) {
    for (const ev of pending.splice(0).sort((a, b) => a.seq - b.seq)) {
      if (ev.seq <= sentThrough) continue;
      send(res, ev);
      sentThrough = ev.seq;
    }
  }
  buffering = false;

  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    store.off('event', onEvent);
  });
}

function send(res, ev) {
  res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
}

/** Long-poll: agents block here between turns so they react promptly. */
function inbox(req, res, store, url) {
  const agent = url.searchParams.get('agent');
  const since = url.searchParams.get('since') ? num(url.searchParams.get('since'), 0) : null;
  const waitMs = num(url.searchParams.get('wait'), 0);
  // Recording "shown" belongs HERE and not inside store.inbox(), because the
  // long-poll below calls store.inbox() repeatedly just to ask whether there is
  // anything worth sending. Recording on those probes would mark messages as
  // handed to an agent that never received them — which is the exact loss this
  // cursor exists to prevent, reintroduced by the fix for it.
  const send = (payload) => {
    if (AGENT_IDS.includes(agent)) store.markShown(agent, payload.cursor);
    return json(res, payload);
  };

  const first = store.inbox(agent, since, { record: false });
  if (first.items.length || waitMs <= 0) return send(first);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    store.off('event', onEvent);
    send(store.inbox(agent, since, { record: false }));
  };
  const onEvent = () => {
    if (store.inbox(agent, since, { record: false }).items.length) finish();
  };
  const timer = setTimeout(finish, Math.min(waitMs, 120_000));
  store.on('event', onEvent);
  req.on('close', () => {
    done = true;
    clearTimeout(timer);
    store.off('event', onEvent);
  });
}

// ------------------------------------------------------------------- static

/**
 * Everything the /preview pane needs to say something true in one round trip:
 * where it is serving from, why that directory and not another, what it
 * rejected, and a version that changes when the directory does.
 */
/**
 * `server.preview` as the config file says right now, not as it said at boot.
 *
 * Every other server setting is baked in at import because changing a port or a
 * token mid-flight would be worse than a restart. This one is different: it is
 * the answer to "where is the thing I am building", the human edits it exactly
 * when the preview is showing them nothing, and telling them to restart the
 * studio to see the effect of the setting that fixes the preview is a bad joke.
 * The file is small and this is a loopback dev server, so it is re-read when
 * its mtime moves and cached otherwise.
 */
let previewCfg = { mtime: null, value: SERVER_CONFIG.preview ?? null };
function previewSetting() {
  let mtime = null;
  try { mtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch { return previewCfg.value; }
  if (mtime === previewCfg.mtime) return previewCfg.value;
  try {
    const raw = readRawConfig(CONFIG_FILE);
    previewCfg = { mtime, value: raw?.server?.preview ?? null };
  } catch {
    // A config file that is mid-save or malformed must not take the preview
    // down; the last good answer stands and /api/config reports the breakage.
    previewCfg = { mtime, value: previewCfg.value };
  }
  return previewCfg.value;
}

function previewStatus() {
  const info = resolvePreview(previewSetting(), PROJECT_ROOT);
  const v = previewVersion(info.root);
  return {
    ok: true,
    ...info,
    version: v.version,
    files: v.files,
    projectRoot: PROJECT_ROOT,
    configFile: CONFIG_FILE,
    url: info.found ? '/preview/' : null,
  };
}

/**
 * Serve one file out of the preview root.
 *
 * Deliberately not `serveStatic` with a second base: that function trusts a
 * string prefix, which a symlink defeats. resolvePreviewFile checks the real
 * path after symlink resolution and returns null for anything outside.
 *
 * Nothing here is cached. The pane reloads the frame when the version changes,
 * and a cached bundle would make that reload a lie.
 */
function servePreview(p, url, req, res) {
  const info = resolvePreview(previewSetting(), PROJECT_ROOT);
  if (!info.found) {
    return html(res, 404, previewPage('Nothing to preview yet', esc(info.reason)));
  }

  // Without the trailing slash every relative URL inside the page resolves
  // against /, which would quietly serve the studio's own assets into the game.
  if (p === '/preview') {
    res.writeHead(302, { Location: '/preview/' + (url.search || '') });
    return res.end();
  }

  const file = resolvePreviewFile(info.root, p.slice('/preview'.length));
  if (!file) {
    // Two different 404s, because they send the reader to two different places.
    // The directory being right and empty is the normal state of a project on
    // the day the preview is wired up — telling that human "not in the preview
    // directory" would send them to check a setting that is already correct.
    if (!info.entry) {
      return html(res, 404, previewPage(
        'The preview directory has no page yet',
        `<p>${esc(info.root)} is being watched. Create</p><p><code>${esc(info.entry || info.root + '\index.html')}</code></p>`
        + '<p>and this frame fills in by itself.</p>',
      ));
    }
    return html(res, 404, previewPage('Not in the preview directory', `<code>${esc(p)}</code> is not a file under <code>${esc(info.root)}</code>.`));
  }
  const type = PREVIEW_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store, must-revalidate',
    // Which bytes come back now depends on a request header, so any cache in
    // between has to key on it. no-store makes that theoretical today; sending
    // it costs nothing and stops the day someone relaxes the caching from
    // handing a gzip body to a client that asked for text.
    'Vary': 'Accept-Encoding',
  };
  const packed = wantsGzip(req) && isCompressible(type) && sizeOf(file) >= COMPRESS_MIN;
  if (packed) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, headers);

  const source = fs.createReadStream(file);
  if (!packed) {
    source.on('error', () => res.destroy());
    return source.pipe(res);
  }
  // A file that vanishes mid-read, or a client that leaves, must kill both
  // halves of the pipe. Without this the gzip stream is left holding a socket.
  const gzip = zlib.createGzip();
  source.on('error', () => { gzip.destroy(); res.destroy(); });
  gzip.on('error', () => res.destroy());
  source.pipe(gzip).pipe(res);
}

/**
 * The human's one written constraint on the game is "mobile friendly and in a
 * browser", and this preview is the only thing that has ever served it to one.
 * It was sending 213,927 raw bytes on every load — 195,262 of them a single
 * JSON catalog — while the browser asked for gzip and was ignored.
 *
 * gzip, not brotli, and the measurement is the argument. On that catalog gzip
 * returns 47,814 bytes in 9.4ms; brotli returns 40,739 in 194.6ms. Nothing
 * here is cached, so that is paid on every reload of a pane the human leaves
 * open. 7 KB is not worth 185ms of the studio's CPU per refresh.
 */
const COMPRESS_MIN = 1024;

/** Already-compressed bytes — png, woff2, webp — only get bigger and slower. */
function isCompressible(type) {
  return type.startsWith('text/') || /(json|javascript|xml)/.test(type);
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function wantsGzip(req) {
  for (const part of String(req?.headers?.['accept-encoding'] || '').split(',')) {
    const [name, ...params] = part.trim().split(';').map((s) => s.trim());
    if (name.toLowerCase() !== 'gzip' && name !== '*') continue;
    // `gzip;q=0` is a client REFUSING gzip. Reading it as a request for gzip
    // is the whole point of parsing this header rather than searching it.
    if (params.some((q) => /^q=0([.]0+)?$/i.test(q))) continue;
    return true;
  }
  return false;
}

function isPreviewPath(p) {
  return p === '/preview' || p.startsWith('/preview/');
}

/** A page the human can read inside a 390px iframe. */
function previewPage(title, detail) {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:13px/1.6 system-ui,sans-serif;background:#0d1016;color:#dfe6f1;margin:0;padding:20px}
h1{font-size:15px;margin:0 0 8px}code{font-family:ui-monospace,monospace;color:#5da9ff;word-break:break-all}</style>
<h1>${esc(title)}</h1><p>${detail}</p>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(p, res) {
  const rel = p === '/' ? 'index.html' : p.replace(/^\//, '');
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return end(res, 404, 'not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// -------------------------------------------------------------------- utils

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function end(res, code, body) {
  res.writeHead(code);
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 8e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function triState(v) {
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

function normList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}
