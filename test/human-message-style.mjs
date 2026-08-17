#!/usr/bin/env node
/** TASK-40: human-directed messages are visually and semantically distinct. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHumanDirected } from '../src/web/message-addressing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

console.log('\nhuman-directed message style  (TASK-40)\n');

check('explicit human recipient is highlighted', isHumanDirected({ from: 'codex', to: ['human'], text: 'done' }));
check('human among multiple recipients is highlighted',
  isHumanDirected({ from: 'grok', to: ['claude', 'human'], text: 'review' }));
check('legacy Human: broadcast remains highlighted',
  isHumanDirected({ from: 'claude', to: [], text: 'Human: this is ready' }));
check('ordinary broadcast is not highlighted',
  !isHumanDirected({ from: 'claude', to: [], text: 'turn complete' }));
check('a casual human mention is not addressing',
  !isHumanDirected({ from: 'grok', to: [], text: 'the human-facing route passed' }));
check('human-origin messages keep their existing treatment',
  !isHumanDirected({ from: 'human', to: ['codex'], text: 'please review' }));

const app = fs.readFileSync(path.resolve(here, '../src/web/app.js'), 'utf8');
const css = fs.readFileSync(path.resolve(here, '../src/web/style.css'), 'utf8');
check('conversation renderer applies the semantic class', /isHumanDirected\(m\).*to-human/.test(app));
check('timeline renderer applies the semantic class', /message\.sent.*isHumanDirected\(t\.data\)/.test(app));
check('conversation has a distinct human-directed treatment', css.includes('.msg.to-human'));
check('timeline has a distinct human-directed treatment', css.includes('.tl.to-human'));
check('human-directed color is a named shared token', css.includes('--to-human:'));

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall human-message style checks passed\n');
process.exitCode = failures ? 1 : 0;
