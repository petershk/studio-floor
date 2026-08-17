#!/usr/bin/env node
// An agent can take back its own stale ask — and nothing more than that.
//
// the project brief tells us not to overwhelm the human. Until now the attention queue
// could only grow from our side: agents raise, only the human clears. Five items
// were open with two of them superseded, and no agent could tidy up after itself.
//
// The risk of handing this to an agent is obvious — an agent that can remove an
// escalation can remove the one the human was about to act on. These checks are
// mostly about what withdrawal CANNOT do.
import { startStudioServer, studioUrl } from './harness.mjs';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (ok || !detail ? '' : ' — ' + detail));
  if (!ok) failures++;
};

const boot = [
  'import { Store } from ' + JSON.stringify(studioUrl('core/store.mjs')) + ';',
  'import { createHttpServer } from ' + JSON.stringify(studioUrl('server/server.mjs')) + ';',
  'const store = new Store();',
  'studioTestReady(store, createHttpServer(store, null));',
].join('\n');

const server = await startStudioServer({ boot, prefix: 'studio-withdraw-' });
const { get, post } = server;
const act = (p) => post('/api/action', p);
const attention = async () => (await get('/api/state')).attention;

for (const agent of ['claude', 'grok']) await act({ agent, verb: 'join', strengths: ['x'], intro: 'i' });

const mine = 'ATT-' + (await act({ agent: 'claude', verb: 'attention', kind: 'review', text: 'stale ask of mine' })).seq;
const theirs = 'ATT-' + (await act({ agent: 'grok', verb: 'attention', kind: 'decision', text: 'grok needs a call' })).seq;

// --- what it must refuse -------------------------------------------------
const other = await act({ agent: 'claude', verb: 'attention.withdraw', id: theirs, reason: 'looks stale to me' });
check('an agent cannot withdraw someone else\'s escalation', Boolean(other.error), JSON.stringify(other));
check('...and the refusal names who raised it', /raised by grok/.test(other.error ?? ''), other.error);

const noReason = await act({ agent: 'claude', verb: 'attention.withdraw', id: mine, reason: '   ' });
check('a reason is required', Boolean(noReason.error), JSON.stringify(noReason));

const ghost = await act({ agent: 'claude', verb: 'attention.withdraw', id: 'ATT-9999', reason: 'x' });
check('an unknown id is refused and lists what is open', /no such attention/.test(ghost.error ?? '') && ghost.error.includes(mine), ghost.error);

const before = (await attention()).length;
check('every refusal appended nothing', before === 2, `${before} attention records`);

// --- what it must do -----------------------------------------------------
const done = await act({ agent: 'claude', verb: 'attention.withdraw', id: mine, reason: 'superseded by the milestone status' });
check('an agent can withdraw its own ask', done.ok === true, JSON.stringify(done));

const after = await attention();
const item = after.find((a) => a.id === mine);
check('status is withdrawn, NOT cleared', item.status === 'withdrawn', item.status);
check('the human can see who withdrew it', item.withdrawnBy === 'claude', JSON.stringify(item.withdrawnBy));
check('and why', item.withdrawnReason === 'superseded by the milestone status', item.withdrawnReason);
check('it drops out of the open queue', after.filter((a) => a.status === 'open').length === 1);
check('the record is not deleted', after.length === 2, `${after.length}`);

const twice = await act({ agent: 'claude', verb: 'attention.withdraw', id: mine, reason: 'again' });
check('withdrawing twice is refused rather than silently repeated', Boolean(twice.error), JSON.stringify(twice));

// --- the human must be able to see us doing it ---------------------------
const { describe, isTimeline } = await import('../src/core/events.mjs');
const evs = (await get('/api/events?limit=500')).events;
const ev = evs.find((e) => e.kind === 'attention.withdrawn');
check('withdrawal is in the timeline, not hidden bookkeeping', isTimeline('attention.withdrawn'));
check('and reads as an agent action, not as the human', describe(ev).startsWith('claude withdrew'), describe(ev));

// --- inbox routing: consistent with raising, not with my preference --------
//
// I first asserted that a withdrawal reaches the other agents' inboxes, and it
// failed. Checking the parallel case settled it against me: attention.raised is
// not routed to any inbox either. Attention is a channel to the HUMAN, and the
// timeline is where agents see it. Making withdrawal the one attention event that
// pages everybody would be me encoding a preference as a rule, which is the exact
// habit I have returned other people's tests for. Asserted as consistency instead.
const grokInbox = (await get('/api/inbox?agent=grok')).items.map((i) => i.kind);
check('withdrawal is routed exactly like raising — to the timeline, not to inboxes',
  !grokInbox.includes('attention.withdrawn') && !grokInbox.includes('attention.raised'),
  JSON.stringify(grokInbox));

console.log(failures ? `\n${failures} FAILED` : '\nattention-withdraw ok');
server.stop();
process.exitCode = failures ? 1 : 0;
