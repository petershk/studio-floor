import { nextScrollTop } from '../src/web/scroll-follow.js';

function check(name, ok, detail = '') {
  if (!ok) {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
}

check('at the top, stay on newest', nextScrollTop({ scrollTop: 0, scrollHeight: 800, nextHeight: 900 }) === 0);
check('near the top still follows', nextScrollTop({ scrollTop: 10, scrollHeight: 800, nextHeight: 900 }) === 0);
check(
  'reading down keeps the same distance from the older end',
  nextScrollTop({ scrollTop: 200, scrollHeight: 800, nextHeight: 950 }) === 350,
);
check(
  'a shorter list still keeps you at the older end',
  nextScrollTop({ scrollTop: 500, scrollHeight: 500, nextHeight: 100 }) === 100,
);
check('NaN scroll follows newest rather than jumping to garbage', nextScrollTop({ scrollTop: Number.NaN, scrollHeight: 800, nextHeight: 900 }) === 0);
