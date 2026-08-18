#!/usr/bin/env node
/**
 * studio doctor must not print 'ready' over an unwritten brief.
 *
 * existsSync was treated as authorship. After `studio init` the file is
 * always there, so doctor went green on the scaffold and the team started
 * against a fiction. This asserts the live CLI, not a helper.
 *
 *   node test/doctor.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = path.resolve(here, '..', 'bin', 'studio.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function doctor(dir) {
  const r = spawnSync(process.execPath, [studio, 'doctor', '--project', dir], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    code: r.status ?? -1,
    output: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-doctor-'));
// The agent points at the node binary running this test, not at a real provider
// CLI. Every assertion here is about the BRIEF, but doctor's exit code and its
// closing line are computed from brief problems and agent problems together —
// so on a machine without grok installed the agent probe failed, the summary
// changed, and two brief assertions went red for a reason that had nothing to
// do with the brief. That is exactly what CI is: a clean runner with no vendor
// CLI on it, which is why this suite passed locally and failed there on the
// same tree digest. `command` is honoured per agent, and `node --version`
// exits 0 everywhere, so the agent half is now a constant and the brief half is
// what is actually under test.
const cfg = {
  project: { name: 'Doctor Test', brief: 'PROJECT.md' },
  agents: [{ id: 'only', provider: 'grok', persona: 'adversary', command: process.execPath }],
};
fs.mkdirSync(path.join(tmp, 'studio_floor'));
fs.writeFileSync(path.join(tmp, 'studio_floor', 'config.json'), JSON.stringify(cfg, null, 2));

console.log('\ndoctor — an unwritten brief is not ready\n');

{
  const missing = doctor(tmp);
  const abs = path.resolve(tmp, 'PROJECT.md');
  check('a missing brief is a problem', missing.code !== 0);
  check('and says so', /no project brief/i.test(missing.output), missing.output.slice(0, 200));
  check('it names the resolved path it looked for', missing.output.includes(abs), missing.output.slice(0, 300));
  check('it does not print ready', !/\n  ready\n/.test(missing.output));
}

fs.writeFileSync(path.join(tmp, 'PROJECT.md'), `# Doctor Test

## Goal

Describe what you want built, and why.

## What done looks like

- A concrete, checkable outcome.
- Another one.

## Decisions already made

- Things that are settled. The team should not reopen these without new information.
`);

{
  const scaffold = doctor(tmp);
  const abs = path.resolve(tmp, 'PROJECT.md');
  check('the init template is a problem', scaffold.code !== 0);
  check(
    'and names the template',
    /init template/i.test(scaffold.output),
    scaffold.output.slice(0, 300),
  );
  check('a template fail names the resolved path', scaffold.output.includes(abs), scaffold.output.slice(0, 400));
  check('it does not print ready over a scaffold', !/\n  ready\n/.test(scaffold.output));
  check(
    'a template brief is named as the problem',
    /no written brief/i.test(scaffold.output),
    scaffold.output.slice(-200),
  );
  // Unconditional now. This used to be skipped when the agent probe failed,
  // which quietly turned the check off on precisely the machines it mattered on.
  check(
    'the agent probe is green, so brief assertions stand alone',
    /\bok\s+only → grok\b/.test(scaffold.output),
    scaffold.output.slice(-300),
  );
  check(
    'a template brief does not claim the agents cannot run',
    !/those agents cannot run/i.test(scaffold.output),
  );
}

fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# Doctor Test\n\nHarden doctor so it refuses the init template.\n');

{
  const written = doctor(tmp);
  const abs = path.resolve(tmp, 'PROJECT.md');
  check(
    'a written brief is accepted',
    written.output.includes(`ok    project brief ${abs}`),
    written.output.slice(0, 400),
  );
  check('a written brief still prints the resolved path as a fact', /\sbrief\s+/.test(written.output) && written.output.includes(abs));
}

{
  const otherDir = path.join(tmp, 'other_project');
  fs.mkdirSync(otherDir);
  fs.writeFileSync(path.join(otherDir, 'PROJECT.md'), '# Other\n\nThe spec the human actually typed.\n');
  const written = doctor(tmp);
  const mine = path.resolve(tmp, 'PROJECT.md');
  const other = path.resolve(otherDir, 'PROJECT.md');
  check('a sibling PROJECT.md is named', written.output.includes(other), written.output.slice(0, 500));
  check('and is marked as not the session brief', /not the brief this session will read/i.test(written.output));
  check('the session brief is still the resolved configured path', written.output.includes(mine));
}

fs.writeFileSync(path.join(tmp, 'PROJECT.md'), `# Collapse

> **STATUS: DRAFT — written by claude (agent), not by the human.**

A one-rule card puzzle. **[inferred]**
`);

{
  const inferred = doctor(tmp);
  const abs = path.resolve(tmp, 'PROJECT.md');
  check(
    'an inferred draft is still a present brief',
    inferred.output.includes(`ok    project brief ${abs}`),
    inferred.output.slice(0, 400),
  );
  check(
    'an inferred draft is named as not a human spec',
    /inferred\/draft — not a human spec/i.test(inferred.output),
    inferred.output.slice(0, 500),
  );
  check(
    'an inferred draft does not print a clean ready',
    !/\n  ready\n/.test(inferred.output),
  );
  check(
    'an inferred draft still says the studio can start',
    /ready — brief is an agent-inferred draft/i.test(inferred.output),
  );
  check('an inferred draft is not a hard fail', inferred.code === 0, `exit ${inferred.code}`);
}

fs.writeFileSync(path.join(tmp, 'PROJECT.md'), `# Card puzzle

**STATUS: DRAFT**

Build a fun puzzle game with playing cards. This decision is not by the human
reviewer — I wrote the spec myself.
`);

{
  const humanDraft = doctor(tmp);
  const abs = path.resolve(tmp, 'PROJECT.md');
  check(
    'a human STATUS: DRAFT is still a present brief',
    humanDraft.output.includes(`ok    project brief ${abs}`),
    humanDraft.output.slice(0, 400),
  );
  check(
    'a human STATUS: DRAFT is not named as an agent draft',
    !/inferred\/draft — not a human spec/i.test(humanDraft.output),
    humanDraft.output.slice(0, 500),
  );
}

console.log(failures ? `\n${failures} doctor check(s) failed\n` : '\nall doctor checks passed\n');
process.exit(failures ? 1 : 0);
