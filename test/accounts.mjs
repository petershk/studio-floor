#!/usr/bin/env node
/**
 * Several people, each with their own way in and their own name in the log.
 *
 * A studio used to have exactly one human: whoever held STUDIO_TOKEN. Everybody
 * shared one secret, so nobody could be removed without changing it for
 * everyone; every message read as "Human", so neither the history nor the
 * agents could say who asked for a thing; and anyone who got in could change
 * what agents are allowed to do on the machine.
 *
 * This holds the replacement: accounts, invitations, sessions, roles, and the
 * author on every human event.
 *
 *   node test/accounts.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStudioServer, studioUrl } from './harness.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-accounts-'));
const file = path.join(tmp, 'accounts.json');
process.env.STUDIO_ACCOUNTS = file;

const a = await import('../src/core/accounts.mjs');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\naccounts — who may drive this studio, and under whose name\n');

// ------------------------------------------------------------- passwords

const hash = a.hashPassword('correct horse battery');
check('a password verifies against its own hash', a.verifyPassword('correct horse battery', hash));
check('and not against another', a.verifyPassword('correct horse batteries', hash) === false);
check('the hash says how it was made, so the cost can be raised later', hash.startsWith('scrypt$16384$'));
check('the same password hashes differently twice', a.hashPassword('correct horse battery') !== hash);
check('a short password is refused', /12 characters/.test(a.passwordProblem('short')));
check('so is a number', /digits/.test(a.passwordProblem('123456789012')));
check('a real one is not', a.passwordProblem('correct horse battery') === '');

// ------------------------------------------------------------ the people

const db = { version: 1, users: [], invites: [], sessions: [] };

const owner = a.createOwner(db, { email: 'Ada@Example.com', name: 'Ada', password: 'the first account here' });
check('the first account is the owner', owner.ok && owner.user.role === 'owner');
check('the email is stored lowercased, so signing in is not case-sensitive', owner.user.email === 'ada@example.com');
check('a second owner cannot be created that way', a.createOwner(db, { email: 'b@x.com', name: 'B', password: 'another long password' }).ok === false);
check('nor can two people share an email address',
  a.addUser(db, { email: 'ADA@example.com', name: 'Ada again', password: 'yet another password' }).ok === false);
check('a password hash is never handed out', a.publicUser(owner.user).passwordHash === undefined);

// ---------------------------------------------------------- invitations

const invited = a.createInvite(db, { email: 'bo@example.com', role: 'director', byId: owner.user.id });
check('an owner can invite somebody', invited.ok && typeof invited.token === 'string');
check('the invitation stores only a hash of its link', !JSON.stringify(invited.invite).includes(invited.token));

const joined = a.acceptInvite(db, invited.token, { name: 'Bo', password: 'bo joins the studio' });
check('the link creates the account it was for', joined.ok && joined.user.email === 'bo@example.com');
check('with the role it promised', joined.user.role === 'director');
check('and cannot be used twice', a.acceptInvite(db, invited.token, { name: 'Bo again', password: 'another password here' }).ok === false);

const stale = a.createInvite(db, { email: 'late@example.com', role: 'viewer', now: Date.now() - 8 * 24 * 3600e3 });
check('an expired invitation is refused',
  a.acceptInvite(db, stale.token, { name: 'Late', password: 'far too late for this' }).ok === false);

// -------------------------------------------------------------- sessions

const wrong = a.login(db, { email: 'ada@example.com', password: 'not it' });
check('a wrong password does not sign anyone in', wrong.ok === false);
const unknown = a.login(db, { email: 'nobody@example.com', password: 'not it' });
check('and an unknown address gets the same answer, so addresses cannot be fished for',
  unknown.error === wrong.error, `${unknown.error} vs ${wrong.error}`);

const session = a.login(db, { email: 'ADA@example.com', password: 'the first account here' });
check('the right password does', session.ok && Boolean(session.token));
check('a session names its owner', a.sessionUser(db, session.token)?.id === owner.user.id);
check('the session token is stored as a hash', !JSON.stringify(db.sessions).includes(session.token));
check('an unknown token is nobody', a.sessionUser(db, 'made-up') === null);
check('an expired session is nobody', a.sessionUser(db, session.token, { now: Date.now() + 40 * 24 * 3600e3 }) === null);
a.endSession(db, session.token);
check('signing out ends it', a.sessionUser(db, session.token) === null);

// ----------------------------------------------------------------- roles

const may = (role, p, method) => a.mayUse(role, p, method);
check('a viewer reads', may('viewer', '/api/state', 'GET'));
check('a viewer does not write', may('viewer', '/api/human/say', 'POST') === false);
check('a director directs the team', may('director', '/api/human/say', 'POST'));
check('a director starts and stops agents', may('director', '/api/runner/stop', 'POST'));
check('a director cannot change what agents may do', may('director', '/api/config', 'POST') === false);
check('nor switch the project', may('director', '/api/projects', 'POST') === false);
check('nor write a provider key', may('director', '/api/secrets', 'POST') === false);
check('nor read one', may('director', '/api/secrets', 'GET') === false);
check('nor manage the people', may('director', '/api/accounts', 'POST') === false);
check('nor read the list of who they are', may('director', '/api/accounts', 'GET') === false);
check('but anyone signed in may end their own session', may('viewer', '/api/auth/logout', 'POST'));
check('an owner may do all of it', ['/api/config', '/api/projects', '/api/secrets', '/api/accounts']
  .every((p) => may('owner', p, 'POST')));
check('somebody with no role may do none of it', may('stranger', '/api/state', 'GET') === false);

// --------------------------------------------------------- last owner out

const bo = a.findUser(db, 'bo@example.com');
check('the only owner cannot be demoted', a.setRole(db, owner.user.id, 'viewer').ok === false);
check('nor removed', a.removeUser(db, owner.user.id).ok === false);
a.setRole(db, bo.id, 'owner');
check('once there are two, either may go', a.setRole(db, owner.user.id, 'viewer').ok === true);

// A third person, so that removing them is not also removing the last owner.
a.addUser(db, { email: 'cy@example.com', name: 'Cy', password: 'cy works here too' });
const cy = a.findUser(db, 'cy@example.com');
const theirSession = a.login(db, { email: 'cy@example.com', password: 'cy works here too' });
check('they can sign in', theirSession.ok === true);
check('removing somebody works', a.removeUser(db, cy.id).ok === true);
check('and ends their sessions too, or removing them only stops them signing in again',
  a.sessionUser(db, theirSession.token) === null);

// ------------------------------------------------------------ on the wire

a.save(db, file);
const mode = fs.statSync(file).mode & 0o777;
check('the accounts file is not readable by anyone else', process.platform === 'win32' || mode === 0o600, mode.toString(8));

const codeFile = path.join(tmp, 'setup-code.txt');
const emptyFile = path.join(tmp, 'fresh.json');
const boot = `
import fs from 'node:fs';
import { Store } from ${JSON.stringify(studioUrl('core/store.mjs'))};
import { createHttpServer, currentSetupCode } from ${JSON.stringify(studioUrl('server/server.mjs'))};
const s = new Store();
fs.writeFileSync(${JSON.stringify(codeFile)}, String(currentSetupCode() || ''));
studioTestReady(s, createHttpServer(s, null));
`;

const server = await startStudioServer({
  boot,
  prefix: 'studio-accounts-http-',
  env: { STUDIO_ACCOUNTS: emptyFile },
});

const call = async (pathname, { token, body, method } = {}) => {
  const res = await fetch(`${server.base}${pathname}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const first = await call('/api/auth/state');
check('http: a studio with nobody in it says so', first.body.needsSetup === true);

const code = fs.readFileSync(codeFile, 'utf8').trim();
check('http: it printed a setup code', code.length > 0);

const guessed = await call('/api/auth/setup', { body: { code: 'nope', email: 'a@b.com', name: 'A', password: 'a long enough password' } });
check('http: a wrong setup code is refused', guessed.status === 403, JSON.stringify(guessed.body));

const setup = await call('/api/auth/setup', { body: { code, email: 'ada@example.com', name: 'Ada', password: 'the first account here' } });
check('http: the right one creates the owner', setup.body.ok === true && Boolean(setup.body.token));

const reused = await call('/api/auth/setup', { body: { code, email: 'b@c.com', name: 'B', password: 'another long password' } });
check('http: and cannot be used again', reused.status === 409 || reused.status === 403);

const OWNER = setup.body.token;
check('http: an account closes the open door', (await call('/api/state')).status === 401);
check('http: the owner is let in', (await call('/api/state', { token: OWNER })).status === 200);

const invite = await call('/api/accounts', { token: OWNER, body: { action: 'invite', email: 'bo@example.com', role: 'director' } });
check('http: the owner can invite', invite.body.ok === true, JSON.stringify(invite.body));
check('http: and gets a link to send', /signin\.html\?invite=/.test(invite.body.link || ''), invite.body.link);

const inviteToken = new URL(invite.body.link).searchParams.get('invite');
const preview = await call(`/api/auth/invite?token=${encodeURIComponent(inviteToken)}`);
check('http: the link says who it is for, before anyone signs in',
  preview.body.email === 'bo@example.com' && preview.body.role === 'director');

const accepted = await call('/api/auth/accept', { body: { token: inviteToken, name: 'Bo', password: 'bo joins the studio' } });
check('http: accepting it signs them straight in', accepted.body.ok === true && Boolean(accepted.body.token));
const DIRECTOR = accepted.body.token;

const said = await call('/api/human/say', { token: DIRECTOR, body: { text: 'use the parser you proposed' } });
check('http: a director can direct the team', said.body.ok === true, JSON.stringify(said.body));

const events = await call('/api/events?kinds=human.message&limit=10', { token: OWNER });
const mine = (events.body.events || []).find((e) => e.data?.text === 'use the parser you proposed');
check('http: and the log records who said it', mine?.data?.by === 'Bo', JSON.stringify(mine?.data));

const blocked = await call('/api/config', { token: DIRECTOR, body: { project: { workDir: '..' } } });
check('http: a director cannot change what agents may do', blocked.status === 403, `status ${blocked.status}`);
check('http: and is told why', /director/.test(blocked.body.error || ''), blocked.body.error);

const nosy = await call('/api/accounts', { token: DIRECTOR });
check('http: nor see the list of people', nosy.status === 403, `status ${nosy.status}`);

const viewerInvite = await call('/api/accounts', { token: OWNER, body: { action: 'invite', email: 'vi@example.com', role: 'viewer' } });
const viewerToken = new URL(viewerInvite.body.link).searchParams.get('invite');
const viewer = await call('/api/auth/accept', { body: { token: viewerToken, name: 'Vi', password: 'vi is here to watch' } });
const VIEWER = viewer.body.token;
check('http: a viewer can watch', (await call('/api/state', { token: VIEWER })).status === 200);
check('http: and cannot speak', (await call('/api/human/say', { token: VIEWER, body: { text: 'ship it' } })).status === 403);

const out = await call('/api/auth/logout', { token: DIRECTOR, body: {} });
check('http: signing out works', out.body.ok === true);
check('http: and the session stops working', (await call('/api/state', { token: DIRECTOR })).status === 401);

server.stop();
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover tmp */ }

console.log(failures ? `\n${failures} accounts check(s) failed\n` : '\nall accounts checks passed\n');
process.exitCode = failures ? 1 : 0;
