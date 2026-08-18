#!/usr/bin/env node
/**
 * The roster is configuration, and every surface honours it.
 *
 * The original version of this test asserted the opposite: that `web/app.js`
 * declared exactly `['codex','claude','grok']` and that `core/events.mjs`
 * hardcoded the same list. That was correct for a studio with three named
 * agents and is exactly wrong for a tool, so the assertions are inverted —
 * these now fail if a roster ever gets baked back into the code.
 *
 * The interesting case is a team of one provider wearing several hats, because
 * that is the shape the old design could not express at all.
 *
 *   node test/roster.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../src');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\nroster test — the team is configuration, not code\n');

// --------------------------------------------------- nothing hardcodes a team

const appJs = fs.readFileSync(path.join(srcDir, 'web/app.js'), 'utf8');
const html = fs.readFileSync(path.join(srcDir, 'web/index.html'), 'utf8');
const eventsSrc = fs.readFileSync(path.join(srcDir, 'core/events.mjs'), 'utf8');

check('web/app.js does not declare a fixed roster', !/const AGENTS = \[\s*'/.test(appJs));
check('web/app.js learns the roster from the server', appJs.includes('adoptRoster'));
check('index.html has no hardcoded agent options', !/<option value="(codex|claude|grok)">/.test(html));
check(
  'core/events.mjs takes AGENT_IDS from the roster',
  /export \{[^}]*AGENT_IDS[^}]*\} from '\.\/roster\.mjs'/.test(eventsSrc),
);
check('index.html still has a left-rail Agents panel', /<h2>Agents<\/h2>\s*<div id="agents"><\/div>/m.test(html));

// ------------------------------------------------ a configured team is served

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-roster-'));
const config = {
  project: { name: 'Roster Test', brief: 'PROJECT.md' },
  agents: [
    { id: 'architect', provider: 'claude', persona: 'architect' },
    { id: 'builder', provider: 'claude', persona: 'implementer' },
    { id: 'breaker', provider: 'grok', persona: 'adversary' },
    { id: 'scout', provider: 'codex', persona: 'researcher' },
  ],
};
const configPath = path.join(tmp, 'studio.config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

process.env.STUDIO_PROJECT_ROOT = tmp;
process.env.STUDIO_CONFIG = configPath;
process.env.STUDIO_PORT = '0';

const { AGENT_IDS, AGENTS, getAgent } = await import('../src/core/roster.mjs');
const { Store } = await import('../src/core/store.mjs');

const expected = ['architect', 'builder', 'breaker', 'scout'];
check('a four-agent roster loads', AGENT_IDS.length === 4, AGENT_IDS.join(','));
check('roster order is preserved', AGENT_IDS.join(',') === expected.join(','), AGENT_IDS.join(','));
check('two agents may share one provider', AGENTS.filter((a) => a.provider === 'claude').length === 2);
check('an id is not a provider', getAgent('architect')?.provider === 'claude');
check(
  'agents on the same provider get different personas',
  getAgent('architect').persona !== getAgent('builder').persona,
);

const store = new Store();
const state = store.getState();
for (const id of expected) {
  check(`empty projection includes ${id}`, Boolean(state.agents[id]), Object.keys(state.agents).join(','));
}
check('the projection has no leftover default agents', !state.agents.codex && !state.agents.grok);
store.close();

// --------------------------------------------------------- prompts follow suit

const { firstTurnPrompt } = await import('../src/agents/prompts.mjs');
const prompt = firstTurnPrompt(getAgent('breaker'), '=== STUDIO BRIEF ===\n(empty)', {
  project: config.project,
});
check('the first-turn prompt names the whole team', prompt.includes('architect, builder, breaker and scout'));
check('the first-turn prompt says how many agents there are', prompt.includes('one of 4 autonomous agents'));
check('the agent is told its own studio id', prompt.includes('studio id `breaker`'));
check('the persona reaches the prompt', prompt.includes('adversarial thinker'));
// A missing brief starts a discovery mission, not a guess.
//
// This used to assert only that the agent was told to stop and ask. Pointing the
// studio at an existing repository made that the common case rather than an
// error, so the prompt now sends the team to read the directory and draft a
// brief — but the safety property is unchanged and still asserted below: an
// inferred brief must be confirmed by the human before anyone builds on it.
check(
  'a missing brief is announced, not papered over',
  prompt.includes(`THERE IS NO ${config.project.brief} — YOUR FIRST JOB IS TO WRITE ONE`),
  'the prompt must say the brief is missing',
);
check(
  'a missing brief still names the resolved path',
  prompt.includes(`Resolved brief path: ${path.resolve(tmp, 'PROJECT.md')}`),
);
check(
  'the agent is told to read the directory first',
  prompt.includes('git log') && prompt.includes('Read the directory before you conclude anything'),
);
check(
  'and to record what it could not work out',
  prompt.includes('what you could NOT determine from the directory'),
);
check(
  'an inferred brief must be confirmed before anyone builds on it',
  prompt.includes('Do not start') && prompt.includes('requesting-input'),
  'the prompt must refuse to let agents implement against a brief they wrote themselves',
);

fs.writeFileSync(path.join(tmp, 'PROJECT.md'), `# Roster Test

## Goal

Describe what you want built, and why.

## What done looks like

- A concrete, checkable outcome.
- Another one.

## Decisions already made

- Things that are settled. The team should not reopen these without new information.
`);
const withTemplate = firstTurnPrompt(getAgent('breaker'), 'brief', { project: config.project });
check(
  'an init-template brief is announced as unwritten',
  withTemplate.includes('IS STILL THE UNTOUCHED INIT TEMPLATE'),
  'the prompt must not treat studio init output as a human spec',
);
check(
  'and it still refuses to implement against an inferred brief',
  withTemplate.includes('Do not start') && withTemplate.includes('requesting-input'),
);
check(
  'a template is not called a human specification',
  !withTemplate.includes('The human has written the specification'),
);

fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# A real brief\n\nBuild the thing.\n');
const withBrief = firstTurnPrompt(getAgent('breaker'), 'brief', { project: config.project });
const absBrief = path.resolve(tmp, 'PROJECT.md');
check('a present brief is pointed at by absolute path', withBrief.includes(absBrief), withBrief.slice(0, 400));
check(
  'existence is not claimed as human authorship',
  !withBrief.includes('The human has written the specification'),
);
check(
  'a non-template brief still warns that a draft is not confirmed',
  withBrief.includes('inferred or a') && withBrief.includes('draft'),
);
check(
  'a human-looking brief is not announced as an agent draft',
  !withBrief.includes('IS AN AGENT-INFERRED DRAFT'),
);

fs.writeFileSync(path.join(tmp, 'PROJECT.md'), `# Collapse

> **STATUS: DRAFT — written by claude (agent), not by the human.**

A one-rule card puzzle. **[inferred]**
`);
const withInferred = firstTurnPrompt(getAgent('breaker'), 'brief', { project: config.project });
check(
  'an inferred draft is announced as not a human spec',
  withInferred.includes('IS AN AGENT-INFERRED DRAFT, NOT A HUMAN SPEC'),
);
check(
  'an inferred draft is not called the authority',
  !withInferred.includes('it is the authority on what this team is for'),
);
check(
  'an inferred draft is not called a human specification',
  !withInferred.includes('The human has written the specification'),
);
check(
  'an inferred draft still names the resolved path',
  withInferred.includes(absBrief),
);
check(
  'an inferred draft does not issue a blanket implement-hold',
  !withInferred.includes('until the human confirms'),
  'DEC-03 is that confirmation; the prompt must not re-issue the hold',
);
check(
  'an inferred draft defers to recorded decisions',
  withInferred.includes('unless a recorded decision has already')
    && withInferred.includes('authorized that'),
);

console.log(failures ? `\n${failures} roster check(s) failed\n` : '\nall roster checks passed\n');
process.exit(failures ? 1 : 0);
