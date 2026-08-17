/**
 * The live stream must never lose events silently.
 *
 * /api/stream backfills the newest N events after `since`. If the client fell
 * further behind than N, the events in between are gone from the stream. The
 * projection views self-heal on the next /api/state refetch, but the raw feed
 * is append-only in the browser, so a silent truncation leaves the human
 * looking at a raw history with an invisible hole in it.
 *
 * These checks assert the server announces the gap instead.
 */
import http from 'node:http';
import { startStudioServer, studioUrl } from './harness.mjs';

const BACKFILL = 5;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const boot = `
import { Store } from ${JSON.stringify(studioUrl('core/store.mjs'))};
import { createHttpServer } from ${JSON.stringify(studioUrl('server/server.mjs'))};
const store = new Store();
studioTestReady(store, createHttpServer(store, null));
`;

// The harness starts the child on an OS-assigned port and does not return until
// the child has announced that port itself and proved the server answering on it
// is the one we started. There is no port to collide on and no stranger to
// mistake for our own server.
const server = await startStudioServer({
  boot,
  prefix: 'studio-stream-',
  env: { STUDIO_STREAM_BACKFILL: String(BACKFILL) },
});
const { base: BASE, get, post } = server;

try {
  // 20 events on top of whatever the store wrote at boot, so a client at since=0
  // is several times further behind than we will replay. Measured relative to
  // the boot seq rather than assumed to be 1: the store legitimately writes
  // startup bookkeeping (inbox cursor baselines, log recovery) before we begin.
  const { seq: boot } = await get('/api/state');
  // strict: a refused action here is broken setup, not a result — say so at the
  // call rather than letting it show up later as a mysterious seq count.
  await post('/api/action', { verb: 'register', agent: 'claude', strengths: ['x'], intro: 'stream gap test' }, { strict: true });
  for (let i = 1; i <= 19; i++) {
    await post('/api/action', { verb: 'say', agent: 'claude', text: `event ${i}`, kind: 'chat' }, { strict: true });
  }
  const { seq } = await get('/api/state');
  check('20 events exist to stream', seq - boot === 20, `seq=${seq} boot=${boot}`);
  check('the client at since=0 is well beyond the backfill', seq > BACKFILL * 3, `seq=${seq}`);

  const behind = await readStream(`/api/stream?since=0`);
  check('a client further behind than the backfill is told there is a gap', behind.gaps.length === 1,
    JSON.stringify(behind.gaps));
  check('the gap names exactly the events that were dropped',
    behind.gaps[0]?.from === 1 && behind.gaps[0]?.to === seq - BACKFILL,
    JSON.stringify(behind.gaps[0]));
  check('the events after the gap still arrive', behind.events.length === BACKFILL,
    `${behind.events.length} events`);
  check('the first replayed event continues from the gap',
    behind.events[0]?.seq === (behind.gaps[0]?.to ?? 0) + 1,
    `first=${behind.events[0]?.seq}`);

  const caughtUp = await readStream(`/api/stream?since=${seq - 2}`);
  check('a client within the backfill is not told there is a gap', caughtUp.gaps.length === 0,
    JSON.stringify(caughtUp.gaps));
  check('a client within the backfill gets exactly what it missed', caughtUp.events.length === 2,
    `${caughtUp.events.length} events`);

  const current = await readStream(`/api/stream?since=${seq}`);
  check('a fully caught-up client gets neither a gap nor a replay',
    current.gaps.length === 0 && current.events.length === 0,
    `gaps=${current.gaps.length} events=${current.events.length}`);
} finally {
  server.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

// ---------------------------------------------------------------- helpers

/** Read the SSE handshake and backfill, then disconnect. */
function readStream(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${pathname}`, (res) => {
      let buf = '';
      const events = [];
      const gaps = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!data) continue; // ": connected" / ": ping" comments
          if (name === 'gap') gaps.push(JSON.parse(data));
          else events.push(JSON.parse(data));
        }
      });
      // The stream stays open by design; take what arrived in the handshake.
      setTimeout(() => {
        req.destroy();
        resolve({ events, gaps });
      }, 300);
    });
    req.on('error', (e) => {
      if (e.code !== 'ECONNRESET') reject(e);
    });
  });
}
