import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, writeConfig } from './config.mjs';

/**
 * Starting a project from nothing.
 *
 * Both the CLI's `studio init` and the panel's "start something new" need the
 * same three things — a directory, a brief to fill in, and a config — and a
 * second copy of any of them would drift. The brief template in particular is
 * load-bearing: `isUntouchedBrief` recognises it, and the studio uses that to
 * tell agents nobody has written down what this team is for yet.
 *
 * A new project also gets its own state directory by virtue of being its own
 * directory, which is the point of offering this at all: a team started here
 * remembers nothing from whatever the studio was doing before.
 */

export const TEMPLATE_BRIEF = `# {{name}}

<!--
  This file is the authority on what the team builds. Every agent reads it in
  full on its first turn, and it outranks anything else it is told.

  Write it for a competent colleague who has never seen the project. Be specific
  about what "done" looks like, and explicit about the decisions you have already
  made so the team does not spend a debate rediscovering them.
-->

## Goal

Describe what you want built, and why.

## What done looks like

- A concrete, checkable outcome.
- Another one.

## Constraints

- Languages, frameworks, or services that are required or forbidden.
- Anything the agents must not touch.

## Decisions already made

- Things that are settled. The team should not reopen these without new information.

## Open questions

- Things you genuinely have not decided. The team should debate these and
  escalate to you rather than guessing.
`;

/**
 * Create a project, or report why not. Never writes over an existing brief or
 * config — an existing directory with work in it is somebody's project, and
 * "new" is not a licence to overwrite one.
 */
export function initProject(dir, { name = path.basename(dir) } = {}) {
  const root = path.resolve(dir);
  const created = [];

  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
    return { ok: false, error: `${root} is a file, not a directory` };
  }
  fs.mkdirSync(root, { recursive: true });

  const cfg = defaultConfig();
  cfg.project.name = name;

  const configFile = path.join(root, 'studio_floor', 'config.json');
  const { written } = writeConfig(configFile, cfg);
  if (written) created.push(configFile);

  const briefPath = path.join(root, cfg.project.brief);
  if (!fs.existsSync(briefPath)) {
    fs.writeFileSync(briefPath, TEMPLATE_BRIEF.replace('{{name}}', name));
    created.push(briefPath);
  }

  return { ok: true, path: root, brief: briefPath, created };
}
