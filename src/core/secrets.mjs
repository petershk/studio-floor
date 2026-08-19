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
 * hardening guide for it now warns about. This refuses to store a secret at all
 * without `STUDIO_SECRET_KEY`, and says so. Friction lands on cloud operators,
 * who are already generating STUDIO_TOKEN one line earlier.
 *
 * What this buys, precisely: a leaked backup, volume snapshot or stolen disk
 * does not hand over the keys. It does nothing against someone who has the
 * running container, because the key is in its environment. That is true of all
 * four tools above. It is worth doing because it is cheap, not because it makes
 * the box safe.
 */

const VERSION = 1;
const ALGO = 'aes-256-gcm';

/** The passphrase, or null when the operator has not set one. */
export function secretKey(env = process.env) {
  const raw = env.STUDIO_SECRET_KEY;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export const NO_KEY = 'no STUDIO_SECRET_KEY is set, so this studio will not store a secret. '
  + 'Set one (openssl rand -hex 32) and restart, or name an environment variable instead. '
  + 'Keep it with your backups: without it, stored keys cannot be read back.';

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

/** The name a given agent's key is filed under. */
export const secretNameFor = (agentId) => `agent:${agentId}:apiKey`;
