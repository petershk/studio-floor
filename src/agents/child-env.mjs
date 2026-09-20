/**
 * What an agent's process is allowed to inherit.
 *
 * Every agent used to be spawned with `...process.env`, which handed each of
 * them everything the studio holds: `STUDIO_TOKEN` (the human's own API
 * credential, enough to rewrite the roster or loosen a sandbox through
 * /api/config), `STUDIO_GIT_TOKEN`, the tunnel token, and every *other* agent's
 * provider key. Four agents on one box meant four processes each able to spend
 * the others' money and act as the person watching them.
 *
 * So inheritance is an allowlist. It names what a CLI needs to run at all —
 * where its binaries are, where its home directory is, how to reach the network
 * — and nothing about this studio. Anything an agent legitimately needs beyond
 * that is passed explicitly by the caller: its own key, its own agent token.
 *
 * The list is deliberately generous about the operating system and strict about
 * everything else. A missing PATH or APPDATA is a CLI that cannot start, which
 * looks like a studio bug; a missing secret is the entire point.
 */

/** Variables any child may inherit, by exact name. */
const INHERIT = [
  // Where things are.
  'PATH', 'Path', 'PATHEXT', 'HOME', 'SHELL', 'USER', 'USERNAME', 'LOGNAME',
  // Windows needs these to start a process at all.
  'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'ComSpec',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  // Scratch space.
  'TMPDIR', 'TMP', 'TEMP',
  // Locale and terminal, so output is not mojibake.
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM',
  // Where a CLI keeps its own config and login.
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  // Getting out to the network, including through a corporate proxy.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
  // Set in the container. Without it a git operation that wants credentials
  // blocks forever on a prompt no one can answer.
  'GIT_TERMINAL_PROMPT',
];

const INHERIT_SET = new Set(INHERIT);

/**
 * Build the environment for an agent's process.
 *
 * `studio` is what this studio tells the agent about itself, `secrets` is what
 * the agent is entitled to (its own key, from the adapter and from auth), and
 * `unset` names variables that must be absent rather than merely unset here —
 * `auth: login` means the CLI's own stored login and nothing else.
 *
 * Later arguments win, so an explicit value always beats an inherited one.
 */
export function agentEnv({
  base = process.env, studio = {}, secrets = {}, extra = {}, unset = [],
} = {}) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (INHERIT_SET.has(k) && v !== undefined) out[k] = v;
  }
  Object.assign(out, studio, secrets, extra);
  for (const name of unset) delete out[name];
  return out;
}

/** Exported for the test, which asserts the shape of this list rather than a copy of it. */
export const INHERITED_NAMES = INHERIT;
