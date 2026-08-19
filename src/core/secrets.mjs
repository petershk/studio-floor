import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SECRETS_FILE } from './paths.mjs';

/**
 * Provider keys, entered in the studio and kept out of everything that gets
 * committed, logged or sent back to a browser.
 *
 * The rule this replaces was right and incomplete. A literal `apiKey` is
 * refused over HTTP because it would land in `studio_floor/config.json`, a file
 * the docs tell you to commit — and committing keys is how they leak. But
 * `apiKeyEnv`, the alternative, only helps someone who can edit the machine's
 * environment. A person running a studio they did not deploy has no `.env` to
 * edit and no shell to edit it in, so the honest options were "SSH somewhere"
 * or "put a key in git".
 *
 * So the key gets a third place to live, and the shape is the one every tool
 * that has solved this converged on — n8n, Grafana, Jenkins, LibreChat:
 *
 *   - the app's own store, never the human-editable config
 *   - encrypted at rest, with the encryption key supplied by the environment
 *   - write-only across the API: settable, never readable back
 *   - environment variables still win, because that is how deployments inject
 *
 * One deliberate deviation. n8n ships a *default* encryption key used when the
 * operator sets none, which means an instance deployed without reading the docs
 * is encrypted with a value published on the internet — the thing every
 * hardening guide for it now warns about. Nothing here is ever encrypted with a
 * value this project chose.
 *
 * There are therefore two passphrases, and they are not equally good:
 *
 *   environment  STUDIO_SECRET_KEY, supplied by whoever runs the studio. The
 *                encrypted file is then worthless on its own, so a leaked
 *                backup, snapshot or disk gives up nothing.
 *   studio       generated on request and kept beside the keys it protects.
 *                Defends a stolen `secrets.json`; does not defend a copy of the
 *                whole directory.
 *
 * The second exists because refusing it is worse. Somebody using a studio they
 * did not deploy has no shell to export a variable in, and a tool that answers
 * "go and get one" gets a key pasted somewhere genuinely unprotected instead.
 * It is offered, it is never the silent default, and every place that offers it
 * says which of the two is in use.
 *
 * Neither does anything against someone who has the running container, since
 * the passphrase is readable there either way. That is true of all four tools
 * above. It is worth doing because it is cheap, not because it makes the box
 * safe.
 */

const VERSION = 1;
const ALGO = 'aes-256-gcm';

/** Where a studio-generated passphrase lives, when the operator supplied none. */
export const KEY_FILE = path.join(path.dirname(SECRETS_FILE), 'secret.key');

/**
 * The passphrase: the operator's if they set one, otherwise this studio's own.
 *
 * The two are not equally good and the panel says so. An operator-supplied
 * passphrase lives in the environment, so the encrypted file is worthless on
 * its own — a leaked backup, snapshot or disk gives up nothing. A generated one
 * lives on the same disk it protects, so it defends a stolen `secrets.json`
 * and not a copy of the whole directory.
 *
 * The generated case exists because the alternative is worse. Somebody using a
 * studio they did not deploy has no shell to export a variable in, and telling
 * them to go and get one means they either give up or paste the key somewhere
 * genuinely unprotected. This is the smaller of two evils, chosen deliberately
 * and described accurately wherever it is offered.
 */
export function secretKey(env = process.env, { file = KEY_FILE } = {}) {
  const raw = env.STUDIO_SECRET_KEY;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  try {
    const own = fs.readFileSync(file, 'utf8').trim();
    return own || null;
  } catch {
    return null;
  }
}

/** Where the passphrase in use came from, for anything that has to explain itself. */
export function keySource(env = process.env, { file = KEY_FILE } = {}) {
  if (typeof env.STUDIO_SECRET_KEY === 'string' && env.STUDIO_SECRET_KEY.trim()) return 'environment';
  try {
    return fs.readFileSync(file, 'utf8').trim() ? 'studio' : 'none';
  } catch {
    return 'none';
  }
}

/**
 * Generate a passphrase and keep it. Only ever called because a human asked, so
 * that nothing is silently encrypted with a key sitting next to it.
 */
export function generateKey({ file = KEY_FILE } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { file, source: 'studio' };
}

export const NO_KEY = 'this studio has no passphrase to encrypt a stored key with, and will not '
  + 'write one in the clear. Set STUDIO_SECRET_KEY where it runs, or let it generate one for '
  + 'itself — which is weaker, because that passphrase then sits on the same disk as the keys '
  + 'it protects.';

function read(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries) return raw;
  } catch { /* missing or unreadable is the same as empty */ }
  return { version: VERSION, salt: crypto.randomBytes(16).toString('hex'), entries: {} };
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // 0600 at creation rather than after: a world-readable moment is still a
  // moment, and on a shared box that moment is the whole vulnerability.
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** scrypt, so a short or guessable passphrase is not directly a key. */
function derive(passphrase, saltHex) {
  return crypto.scryptSync(passphrase, Buffer.from(saltHex, 'hex'), 32);
}

/**
 * Store a secret under a name. Throws when there is no encryption key, because
 * writing it in the clear and mentioning that in a log is not a fallback.
 */
export function putSecret(name, value, { file = SECRETS_FILE, env = process.env } = {}) {
  const key = secretKey(env);
  if (!key) throw new Error(NO_KEY);
  if (!name || typeof name !== 'string') throw new Error('a secret needs a name');

  const data = read(file);
  const text = String(value ?? '');
  if (!text) {
    delete data.entries[name];
    write(file, data);
    return { name, set: false };
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, derive(key, data.salt), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  data.entries[name] = {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: enc.toString('hex'),
    // For the panel, so it can say "set on 3 August" without holding a value.
    setAt: new Date().toISOString(),
  };
  write(file, data);
  return { name, set: true };
}

/**
 * Read a secret back. Returns null when absent, when no key is configured, or
 * when the key does not match what encrypted it — a wrong key is a missing
 * secret as far as anything downstream is concerned, and it is reported rather
 * than thrown so one unreadable entry cannot stop a studio booting.
 */
export function getSecret(name, { file = SECRETS_FILE, env = process.env } = {}) {
  const key = secretKey(env);
  if (!key) return null;
  const data = read(file);
  const entry = data.entries?.[name];
  if (!entry) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGO, derive(key, data.salt), Buffer.from(entry.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(entry.data, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Which secrets exist, and when they were set. Never the values. */
export function listSecrets({ file = SECRETS_FILE, env = process.env } = {}) {
  const data = read(file);
  const key = secretKey(env);
  const out = {};
  for (const [name, entry] of Object.entries(data.entries || {})) {
    out[name] = {
      set: true,
      setAt: entry.setAt || null,
      // A studio restarted with a different key holds entries it cannot read.
      // Saying so is the difference between "your key is wrong" and an agent
      // that mysteriously cannot authenticate.
      readable: key ? getSecret(name, { file, env }) !== null : false,
    };
  }
  return out;
}

export function removeSecret(name, { file = SECRETS_FILE } = {}) {
  const data = read(file);
  if (!data.entries?.[name]) return { name, set: false };
  delete data.entries[name];
  write(file, data);
  return { name, set: false };
}

/**
 * How to turn "this studio will not store a key" into a studio that will.
 *
 * The first version of this said "set one where the studio runs and restart",
 * which names the problem and leaves the fix as an exercise — and the person
 * reading it is standing in a browser, possibly nowhere near the machine. So it
 * hands over the actual commands, and the commands differ: a container reads a
 * file beside its compose config, a laptop reads the shell.
 *
 * The generator is node rather than openssl because this project already
 * requires node and Windows does not ship openssl.
 */
export function storageHint({ env = process.env, inContainer = detectContainer() } = {}) {
  const source = keySource(env);
  const generate = 'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"';
  return {
    canStore: Boolean(secretKey(env)),
    // Which passphrase is protecting stored keys, so the panel can describe the
    // protection accurately instead of implying the stronger one.
    keySource: source,
    protects: source === 'environment'
      ? 'Stored keys are encrypted with STUDIO_SECRET_KEY from the environment, so a backup or '
        + 'snapshot of this disk does not contain them.'
      : source === 'studio'
        ? 'Stored keys are encrypted with a passphrase this studio generated and keeps on the '
          + 'same disk. That protects the key file on its own, not a copy of the whole directory. '
          + 'Set STUDIO_SECRET_KEY in the environment for the stronger version.'
        : '',
    inContainer,
    generate,
    steps: inContainer
      ? [
        `Generate one:  ${generate}`,
        'Put it in .env beside docker-compose.yml as STUDIO_SECRET_KEY=…',
        'Then: docker compose up -d',
      ]
      : [
        `Generate one:  ${generate}`,
        'Start the studio with it: STUDIO_SECRET_KEY=… studio start',
        'On Windows PowerShell: $env:STUDIO_SECRET_KEY="…"; studio start',
      ],
    keep: 'Keep it with your backups. Without it, keys stored here cannot be read back — '
      + 'they are encrypted with it.',
  };
}

/** Are we inside a container? Changes where the answer goes, not what it is. */
function detectContainer() {
  if (process.env.STUDIO_IN_CONTAINER) return true;
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

/** The name a given agent's key is filed under. */
export const secretNameFor = (agentId) => `agent:${agentId}:apiKey`;
