#!/usr/bin/env node
/**
 * Prove that a killed write cannot vanish without a visible break.
 *
 * The old store skipped unparsable JSONL lines and writeSync'd with no fsync.
 * A crash during the last append then looked like the event never happened.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-durability-'));
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

console.log(`\nstudio durability  (state dir: ${tmp})\n`);

// 1 — append fsyncs before it returns ---------------------------------------
{
  const store = new Store();
  const orig = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = (fd) => {
    calls++;
    return orig(fd);
  };
  try {
    store.append('work.discovery', 'grok', { text: 'fsync-canary' });
    check('append calls fsyncSync before returning', calls >= 1, `calls=${calls}`);
  } finally {
    fs.fsyncSync = orig;
    store.close();
  }
}

// 1b — a short write is refused, not reported as stored --------------------
{
  const store = new Store();
  const orig = fs.writeSync;
  fs.writeSync = (fd, data, ...rest) => {
    const n = orig(fd, data, ...rest);
    if (Buffer.isBuffer(data) && data.length > 1 && data[data.length - 1] === 0x0a) {
      return Math.max(0, data.length - 1);
    }
    return n;
  };
  let threw = null;
  try {
    store.append('work.discovery', 'grok', { text: 'short-write-must-fail' });
  } catch (err) {
    threw = err;
  } finally {
    fs.writeSync = orig;
    store.close();
  }
  check(
    'a short write throws instead of returning ok',
    /short write/.test(threw?.message || ''),
    threw ? threw.message : 'append returned ok after a short write',
  );
}

// 2 — a torn final line is recovered, not dropped ---------------------------
{
  const store = new Store();
  const ev = store.append('work.discovery', 'grok', { text: 'canary-keep' });
  const goodSeq = ev.seq;
  store.close();

  fs.appendFileSync(EVENT_LOG, '{"seq":999,"kind":"work.discovery","data":{"text":"this-must-not-vanish-silently"');
  check(
    'log file now contains a torn tail',
    fs.readFileSync(EVENT_LOG, 'utf8').includes('this-must-not-vanish-silently'),
  );

  const reopened = new Store();
  const state = reopened.getState();
  const recovered = state.recoveries || [];
  check('recovery is visible in the projection', recovered.length >= 1 && recovered.some((r) => r.torn));
  check('original event is still projected', state.discoveries.some((d) => d.text === 'canary-keep'));
  check(
    'torn payload is not projected as a real event',
    !state.discoveries.some((d) => d.text === 'this-must-not-vanish-silently'),
  );
  check('timeline names the break', state.timeline.some((t) => t.kind === 'log.recovered'));
  const diskLines = fs.readFileSync(EVENT_LOG, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  let unreadable = 0;
  let parsedOk = 0;
  for (const line of diskLines) {
    try {
      JSON.parse(line);
      parsedOk++;
    } catch {
      unreadable++;
    }
  }
  check(
    'every remaining log line is parseable JSON',
    unreadable === 0 && parsedOk === diskLines.length,
    `unreadable=${unreadable} parsed=${parsedOk}`,
  );
  const tornFile = path.join(STATE_DIR, 'events.jsonl.torn');
  check(
    'torn bytes were quarantined',
    fs.existsSync(tornFile) && fs.readFileSync(tornFile, 'utf8').includes('this-must-not-vanish-silently'),
  );
  const next = reopened.append('work.discovery', 'grok', { text: 'after-recovery' });
  check(
    'next seq continues from last good event plus the visible recovery',
    next.seq === goodSeq + 2,
    `good=${goodSeq} next=${next.seq}`,
  );
  reopened.close();

  const third = new Store();
  check(
    'restart after recovery does not invent a second torn write',
    (third.getState().recoveries || []).filter((r) => r.torn).length === 1,
  );
  third.close();
}

// 3 — a hole in the middle of the file is not skipped -----------------------
{
  const store = new Store();
  store.append('work.discovery', 'grok', { text: 'before-hole' });
  store.close();
  const good = fs.readFileSync(EVENT_LOG, 'utf8');
  const lines = good.split('\n').filter(Boolean);
  const last = lines[lines.length - 1];
  const smashed = `${lines.slice(0, -1).join('\n')}\n{"this is not json"\n${last}\n`;
  fs.writeFileSync(EVENT_LOG, smashed);
  let threw = null;
  try {
    new Store();
  } catch (err) {
    threw = err;
  }
  check('middle-file corruption throws instead of skipping', !!threw, threw ? threw.message : 'no throw');
  check(
    'middle-file error names the class of failure',
    /not the final line/.test(threw?.message || ''),
    threw?.message,
  );
}

if (failures) {
  console.log(`\n${failures} durability check(s) failed\n`);
  process.exit(1);
}
console.log('\ndurability ok\n');
