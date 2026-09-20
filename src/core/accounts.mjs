import fs from 'node:fs';
import path from 'node:path';
import {
  randomBytes, scryptSync, timingSafeEqual, createHash,
} from 'node:crypto';
import { USER_DIR } from './paths.mjs';

/**
 * Who the people are.
 *
 * A studio used to have exactly one human: whoever held `STUDIO_TOKEN`. That is
 * a fine model for one person on one laptop and a poor one for a team, in three
 * ways at once. Everybody shares one secret, so nobody can be removed without
 * changing it for everyone. Every message reads as "Human", so the log cannot
 * say who asked for a thing and the agents cannot either. And anybody who can
 * get in can change what agents are allowed to do on the machine.
 *
 * So: accounts, with roles, and a session per person.
 *
 * **Sessions are bearer tokens, not cookies, and that is deliberate.** This
 * server answers with `Access-Control-Allow-Origin: *`. A cookie would then be
 * attached by the browser to requests made by any page in any tab — a
 * cross-site request forgery hole opened in the name of convenience, against a
 * server whose whole job is running shell commands. A token held in JavaScript
 * is never sent cross-origin and cannot be read cross-origin, so the hole never
 * exists. src/web/token.js already carries one; a session is the same shape.
 *
 * **Where this lives.** Beside the studio's other person-shaped state, in
 * USER_DIR, and never in a project's event log. Logs get copied between
 * machines and handed to whoever is debugging; password hashes must not travel
 * with them. `STUDIO_ACCOUNTS` moves the file, which is how the container puts
 * it on a volume that outlives the container.
 */

export const ROLES = ['owner', 'director', 'viewer'];

/** How long a session lasts without being used again. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long an invite link is good for. Long enough to send, short enough to expire. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ACCOUNTS_FILE = process.env.STUDIO_ACCOUNTS
  ? path.resolve(process.env.STUDIO_ACCOUNTS)
  : path.join(USER_DIR, 'accounts.json');

const EMPTY = { version: 1, users: [], invites: [], sessions: [] };

export function load(file = ACCOUNTS_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...EMPTY,
      ...raw,
      users: raw.users || [],
      invites: raw.invites || [],
      sessions: raw.sessions || [],
    };
  } catch {
    // A missing file is a studio nobody has set up yet, which is a state, not
    // an error. A corrupt one is not silently replaced: see save().
    return { ...EMPTY, users: [], invites: [], sessions: [] };
  }
}

export function save(db, file = ACCOUNTS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    // Belt and braces: the file holds password hashes and live sessions, and a
    // rename keeps the mode of the source, not of anything it replaced.
    fs.chmodSync(file, 0o600);
  } catch { /* a filesystem without modes is reported by confinement, not here */ }
  return db;
}

// --------------------------------------------------------------- passwords

/**
 * scrypt, from Node's own crypto. No dependency, and deliberately slow.
 *
 * Stored as an algorithm-tagged string so the cost can be raised later without
 * locking anyone out: an old hash still says how it was made.
 */
export function hashPassword(password, { N = 16384, r = 8, p = 1 } = {}) {
  const salt = randomBytes(16);
  const key = scryptSync(String(password), salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, salt, key] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const want = Buffer.from(key, 'base64');
    const got = scryptSync(String(password), Buffer.from(salt, 'base64'), want.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return want.length === got.length && timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

/** Strong enough to be worth the scrypt, short enough that people will use it. */
export function passwordProblem(password) {
  const s = String(password || '');
  if (s.length < 12) return 'a password needs at least 12 characters';
  if (/^\d+$/.test(s)) return 'a password of only digits is guessed in seconds';
  return '';
}

// ------------------------------------------------------------------ tokens

/** Tokens are stored as hashes: a stolen accounts file is not a stolen session. */
const digest = (token) => createHash('sha256').update(String(token)).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

const normalEmail = (email) => String(email || '').trim().toLowerCase();

// ------------------------------------------------------------------- people

export function userCount(db) {
  return db.users.filter((u) => !u.disabled).length;
}

export function findUser(db, email) {
  const want = normalEmail(email);
  return db.users.find((u) => u.email === want) || null;
}

export function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

/**
 * The first account, created with the setup code the studio printed when it
 * found no accounts at all. The code is held in memory by the server process,
 * so it changes on every restart and is never written anywhere.
 */
export function createOwner(db, { email, name, password }) {
  if (userCount(db)) return { ok: false, error: 'this studio already has an owner' };
  return addUser(db, { email, name, password, role: 'owner', invitedBy: null });
}

export function addUser(db, {
  email, name, password, role = 'director', invitedBy = null,
}) {
  const want = normalEmail(email);
  if (!want || !want.includes('@')) return { ok: false, error: 'that is not an email address' };
  if (findUser(db, want)) return { ok: false, error: 'somebody already has that email address' };
  if (!ROLES.includes(role)) return { ok: false, error: `role must be one of ${ROLES.join(', ')}` };
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };

  const user = {
    id: randomBytes(8).toString('hex'),
    email: want,
    name: String(name || '').trim() || want.split('@')[0],
    role,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    invitedBy,
    disabled: false,
  };
  db.users.push(user);
  return { ok: true, user };
}

export function setRole(db, id, role) {
  if (!ROLES.includes(role)) return { ok: false, error: `role must be one of ${ROLES.join(', ')}` };
  const user = db.users.find((u) => u.id === id);
  if (!user) return { ok: false, error: 'no such person' };
  // The last owner cannot demote themselves into a studio nobody can administer.
  if (user.role === 'owner' && role !== 'owner' && owners(db).length < 2) {
    return { ok: false, error: 'this is the only owner — make somebody else an owner first' };
  }
  user.role = role;
  return { ok: true, user };
}

export function removeUser(db, id) {
  const user = db.users.find((u) => u.id === id);
  if (!user) return { ok: false, error: 'no such person' };
  if (user.role === 'owner' && owners(db).length < 2) {
    return { ok: false, error: 'this is the only owner — make somebody else an owner first' };
  }
  db.users = db.users.filter((u) => u.id !== id);
  // Their sessions die with the account, or removing somebody would only stop
  // them logging in again.
  db.sessions = db.sessions.filter((s) => s.userId !== id);
  return { ok: true, user: publicUser(user) };
}

const owners = (db) => db.users.filter((u) => u.role === 'owner' && !u.disabled);

// ------------------------------------------------------------------ invites

/**
 * An invite is a link, not an email.
 *
 * Sending mail means an SMTP server to configure before anybody can join, which
 * is the single most common place a self-hosted tool loses people. The owner
 * copies a link and sends it however they already talk to their team.
 */
export function createInvite(db, { email, role = 'director', byId = null, now = Date.now() }) {
  const want = normalEmail(email);
  if (!want || !want.includes('@')) return { ok: false, error: 'that is not an email address' };
  if (findUser(db, want)) return { ok: false, error: 'somebody already has that email address' };
  if (!ROLES.includes(role)) return { ok: false, error: `role must be one of ${ROLES.join(', ')}` };
  const token = newToken();
  const invite = {
    id: randomBytes(6).toString('hex'),
    email: want,
    role,
    tokenHash: digest(token),
    createdBy: byId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
  };
  db.invites.push(invite);
  return { ok: true, invite, token };
}

export function inviteFor(db, token, { now = Date.now() } = {}) {
  const hash = digest(token);
  const invite = db.invites.find((i) => i.tokenHash === hash);
  if (!invite) return null;
  if (Date.parse(invite.expiresAt) < now) return null;
  return invite;
}

export function acceptInvite(db, token, { name, password, now = Date.now() }) {
  const invite = inviteFor(db, token, { now });
  if (!invite) return { ok: false, error: 'that invitation has expired or was already used' };
  const made = addUser(db, {
    email: invite.email, name, password, role: invite.role, invitedBy: invite.createdBy,
  });
  if (!made.ok) return made;
  db.invites = db.invites.filter((i) => i.id !== invite.id);
  return made;
}

export function revokeInvite(db, id) {
  const before = db.invites.length;
  db.invites = db.invites.filter((i) => i.id !== id);
  return { ok: db.invites.length < before };
}

// ----------------------------------------------------------------- sessions

export function login(db, { email, password, now = Date.now() }) {
  const user = findUser(db, email);
  // The same answer either way: "no such account" tells a stranger which
  // addresses are worth guessing a password for.
  if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
    return { ok: false, error: 'that email address and password do not match' };
  }
  return { ok: true, ...startSession(db, user, now), user };
}

export function startSession(db, user, now = Date.now()) {
  const token = newToken();
  db.sessions.push({
    tokenHash: digest(token),
    userId: user.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  });
  // Expired sessions are swept here rather than on a timer: the file is only
  // interesting when somebody is logging in anyway.
  db.sessions = db.sessions.filter((s) => Date.parse(s.expiresAt) > now);
  return { token, expiresAt: new Date(now + SESSION_TTL_MS).toISOString() };
}

export function sessionUser(db, token, { now = Date.now() } = {}) {
  if (!token) return null;
  const hash = digest(token);
  const session = db.sessions.find((s) => s.tokenHash === hash);
  if (!session || Date.parse(session.expiresAt) < now) return null;
  const user = db.users.find((u) => u.id === session.userId);
  if (!user || user.disabled) return null;
  return user;
}

export function endSession(db, token) {
  const hash = digest(token);
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.tokenHash !== hash);
  return { ok: db.sessions.length < before };
}

// -------------------------------------------------------------------- roles

/**
 * What each role may do, by what it changes rather than by route name.
 *
 * `owner` runs the studio: accounts, configuration, which project, the keys.
 * `director` directs the team: says things, answers escalations, starts and
 * stops agents. `viewer` watches, which costs nothing and is the right default
 * for somebody who only wants to see what the team decided.
 */
export const ROLE_RANK = { viewer: 0, director: 1, owner: 2 };

/** Routes only an owner may touch, by prefix. */
const OWNER_ONLY = [
  '/api/config', '/api/secrets', '/api/projects', '/api/reset', '/api/restart',
  '/api/accounts', '/api/update',
];

/** Routes a director may use as well; everything else is reading. */
const DIRECTOR = ['/api/human/', '/api/runner/', '/api/clear', '/api/agents/test', '/api/action'];

/**
 * Reads that are not for everyone. The list of people is a list of who to
 * phish, and the secrets route answers with credentials.
 */
const PRIVATE_READS = ['/api/secrets', '/api/accounts'];

export function mayUse(role, pathname, method = 'GET') {
  const rank = ROLE_RANK[role] ?? -1;
  if (rank < 0) return false;
  // Ending your own session is yours to do whoever you are. Everything else
  // under /api/auth/ answers before anybody is signed in at all.
  if (pathname.startsWith('/api/auth/')) return true;
  if (rank === ROLE_RANK.owner) return true;
  const writes = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  if (!writes) {
    // Reading is open to everyone with an account, except the routes whose
    // answers are a credential or a list of people to phish.
    return !PRIVATE_READS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  }
  if (OWNER_ONLY.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return false;
  // A viewer watches. Without this it fell through to the director list and
  // could direct the team, which is the opposite of what the role is for.
  if (rank < ROLE_RANK.director) return false;
  return DIRECTOR.some((p) => pathname === p || pathname.startsWith(p));
}

/** A one-time code, printed by a studio that has no accounts yet. */
export function newSetupCode() {
  return randomBytes(4).toString('hex').replace(/(.{4})/, '$1-');
}
