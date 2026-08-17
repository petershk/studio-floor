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
check(
  'a missing brief is reported rather than invented',
  prompt.includes('no PROJECT.md in this project'),
  'the prompt must refuse to guess the project',
);

fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# A real brief\n\nBuild the thing.\n');
const withBrief = firstTurnPrompt(getAgent('breaker'), 'brief', { project: config.project });
check('a present brief is pointed at', withBrief.includes('specification at PROJECT.md'));

console.log(failures ? `\n${failures} roster check(s) failed\n` : '\nall roster checks passed\n');
process.exit(failures ? 1 : 0);
