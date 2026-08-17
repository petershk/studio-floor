#!/usr/bin/env node
/**
 * REVIEWER'S FAILING REPRODUCTION for TASK-12 — written by claude, owned by grok.
 *
 * This file is EXPECTED TO FAIL until the recovery path is fixed. It is not a
 * regression suite; it is the specific case I could not break TASK-12 on by
 * reading it, and could break by running it. Fold it into durability.mjs once
 * the fix lands, or delete it and tell me why it is not a real case.
 *
 * THE CASE durability.mjs does not cover: a partial write that loses only the
 * trailing NEWLINE. durability.mjs tests a tail that is invalid JSON, which the
 * recovery path handles correctly. But a write can also be cut after the closing
 * brace and before the '\n' — a short write on a full disk does exactly this,
 * and append() ignores the byte count fs.writeSync returns, so it reports
 * success either way.
 *
 * The final line is then VALID JSON. Recovery does not fire, because nothing
 * checks that the file ends with a terminator. The next append is opened 'a' and
 * concatenates onto that same physical line, producing {...}{...} — one line
 * holding two records.
 *
 * The damage arrives one boot later, and it is the opposite of what TASK-12
 * promises: the combined line is unparseable, it IS the final line, so it is
 * quarantined as "a torn write" — destroying an event that was completely
 * written, fsynced, and reported ok to its author. A committed event vanishes,
 * and the log calls it a torn write.
 *
 * Run: node test/attack-newline.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-newline-'));
process.env.STUDIO_PROJECT_ROOT = tmp;

const { Store } = await import('../src/core/store.mjs');
const { EVENT_LOG, STATE_DIR } = await import('../src/core/paths.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log(`\nattack: a write cut before its newline  (state dir: ${tmp})\n`);

// A write that fully succeeded. Its author was told so.
const first = new Store();
const committed = first.append('work.discovery', 'grok', { text: 'COMMITTED-AND-FSYNCED' });
first.close();

// The crash: everything reached disk except the final newline byte.
const buf = fs.readFileSync(EVENT_LOG);
check('the log ended with a newline before the crash', buf[buf.length - 1] === 0x0a);
fs.writeFileSync(EVENT_LOG, buf.subarray(0, buf.length - 1));

// Boot 1. The final line is valid JSON, so nothing looks wrong — and nothing is,
// yet. The defect is that the missing terminator is neither noticed nor repaired.
const second = new Store();
check(
  'the committed event is still there on the next boot',
  second.getState().discoveries.some((d) => d.text === 'COMMITTED-AND-FSYNCED'),
);
check(
  'a log missing its final newline is noticed and repaired',
  (second.getState().recoveries || []).length >= 1
    || fs.readFileSync(EVENT_LOG)[fs.readFileSync(EVENT_LOG).length - 1] === 0x0a,
  'the log ends mid-line and the store neither reported it nor fixed it, so the next append lands on the same line',
);
const after = second.append('work.discovery', 'grok', { text: 'AFTER-CRASH' });
second.close();

const lines = fs.readFileSync(EVENT_LOG, 'utf8').split('\n').filter((l) => l.trim());
let unparseable = 0;
for (const l of lines) {
  try { JSON.parse(l); } catch { unparseable++; }
}
check(
  'appending after the crash does not produce an unparseable line',
  unparseable === 0,
  `${unparseable} of ${lines.length} lines hold two records concatenated`,
);

// Boot 2. This is where a committed event is destroyed and called a torn write.
const third = new Store();
const state = third.getState();
check(
  'a COMMITTED, FSYNCED event survives — it was never torn',
  state.discoveries.some((d) => d.text === 'COMMITTED-AND-FSYNCED'),
  'quarantined and reported as a torn write, but this event was written in full and its author was told it succeeded',
);
check(
  'the event written after the crash survives',
  state.discoveries.some((d) => d.text === 'AFTER-CRASH'),
);

// Sequence numbers are the studio's ordering guarantee. Recovery rewinds the
// head, so the numbers the destroyed events held are handed out a second time.
const reissued = third.append('work.discovery', 'grok', { text: 'REISSUED' });
check(
  'a sequence number is never handed out twice',
  reissued.seq !== after.seq && reissued.seq !== committed.seq,
  `seq ${reissued.seq} was already used by the event quarantined above`,
);
third.close();

const tornFile = path.join(STATE_DIR, 'events.jsonl.torn');
if (fs.existsSync(tornFile)) {
  const torn = fs.readFileSync(tornFile, 'utf8');
  check(
    'the quarantine does not contain a fully committed event',
    !torn.includes('COMMITTED-AND-FSYNCED'),
    'the quarantine file is the only remaining copy of an event the studio said it had durably stored',
  );
}

if (failures) {
  console.log(`\n${failures} check(s) failed — this is the open TASK-12 defect, not a new regression\n`);
  process.exit(1);
}
console.log('\nattack repelled — the newline case is handled\n');
