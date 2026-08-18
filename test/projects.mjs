#!/usr/bin/env node
/**
 * Pointing the studio at a directory, and what it finds there.
 *
 * The studio works on one project at a time and keeps that project's memory
 * inside it, which is what makes resume free: arriving somewhere the team has
 * worked before finds the log where it was left. Reset is the deliberate
 * opposite, and it must be narrow — a reset that took the brief or the code with
 * it would be unforgivable, so that is asserted here rather than trusted.
 *
 *   node test/projects.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-projects-'));
process.env.STUDIO_USER_DIR = path.join(tmp, 'user');
process.env.STUDIO_PROJECT_ROOT = tmp;

const {
  inspect, problemsWith, rememberProject, readProjects, forgetProject,
  requestSwitch, takeSwitch, resetProjectState,
} = await import('../src/core/projects.mjs');

let n = 0;
const ok = (name, cond, detail = '') => {
  n++;
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1; }
};

console.log('\nprojects — pointing the studio at a directory\n');

// ------------------------------------------------------------------- inspect

{
  const missing = inspect(path.join(tmp, 'nope'));
  ok('a missing directory is reported, not thrown', missing.exists === false);
  ok('and says so in words', problemsWith(missing).some((p) => /does not exist/.test(p)));
}
{
  const file = path.join(tmp, 'afile.txt');
  fs.writeFileSync(file, 'x');
  ok('a file is refused as a project', problemsWith(inspect(file)).some((p) => /not a directory/.test(p)));
}

// A realistic existing repository: code, no studio anything.
const repo = path.join(tmp, 'acme');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.writeFileSync(path.join(repo, 'README.md'), '# acme\n');
fs.writeFileSync(path.join(repo, 'package.json'), '{}');

{
  const i = inspect(repo);
  ok('an existing repo is usable', problemsWith(i).length === 0, problemsWith(i).join('; '));
  ok('it notices there is no brief', i.hasBrief === false);
  ok('it notices there is no history', i.events === 0 && i.hasState === false);
  ok('it notices git', i.isGitRepo === true);
  ok('it counts what is there', i.entries === 3, `entries=${i.entries}`);
  ok('and does not count .git or studio_floor as project content',
    !fs.readdirSync(repo).filter((e) => e !== '.git').includes('studio_floor') || i.entries === 3);
}

// ------------------------------------------------------------ layout + resume

{
  const state = path.join(repo, 'studio_floor', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'events.jsonl'), '{"seq":1}\n{"seq":2}\n{"seq":3}\n');
  fs.writeFileSync(path.join(repo, 'studio_floor', 'config.json'), '{"agents":[{"id":"a"}]}');
  fs.writeFileSync(path.join(repo, 'PROJECT.md'), '# acme\n');

  const i = inspect(repo);
  ok('history is found where the project keeps it', i.hasState && i.events === 3, `events=${i.events}`);
  ok('the config is found', i.hasConfig === true);
  ok('the brief is found', i.hasBrief === true);
  ok('the new layout is not mistaken for the old', i.legacyLayout === false);
}

// A project set up before studio_floor existed must still be readable, or
// switching to it would present an empty studio and orphan its whole history.
{
  const old = path.join(tmp, 'legacy');
  fs.mkdirSync(path.join(old, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(old, '.studio', 'events.jsonl'), '{"seq":1}\n{"seq":2}\n');
  fs.writeFileSync(path.join(old, 'studio.config.json'), '{}');
  const i = inspect(old);
  ok('a legacy project is recognised', i.legacyLayout === true);
  ok('its history is still counted', i.events === 2, `events=${i.events}`);
  ok('its config is still found', i.hasConfig === true);
}

// --------------------------------------------------------------------- recent

{
  rememberProject(repo, '2026-01-01T00:00:00.000Z');
  rememberProject(path.join(tmp, 'legacy'), '2026-01-02T00:00:00.000Z');
  const list = readProjects();
  ok('opening a project records it', list.length === 2);
  ok('newest first', path.basename(list[0].path) === 'legacy', list.map((p) => p.name).join(','));

  rememberProject(repo, '2026-01-03T00:00:00.000Z');
  const again = readProjects();
  ok('re-opening moves it to the front without duplicating',
    again.length === 2 && path.basename(again[0].path) === 'acme', again.map((p) => p.name).join(','));

  forgetProject(repo);
  ok('a project can be forgotten', readProjects().length === 1);
}

// -------------------------------------------------------------------- switch

{
  ok('no pending switch reads as none', takeSwitch() === null);
  requestSwitch(repo, { reset: true });
  const req = takeSwitch();
  ok('a switch request survives to the supervisor', req?.path === path.resolve(repo));
  ok('and carries the reset flag', req?.reset === true);
  ok('it is consumed once, so a crash cannot loop it', takeSwitch() === null);
}

// --------------------------------------------------------------------- reset

{
  const before = fs.readdirSync(repo).sort();
  const r = resetProjectState(repo);
  ok('reset removes the state directory', r.removed === true);
  ok('the log is gone', !fs.existsSync(path.join(repo, 'studio_floor', 'state', 'events.jsonl')));

  // The part that must never regress.
  ok('the brief survives a reset', fs.existsSync(path.join(repo, 'PROJECT.md')));
  ok('the config survives a reset', fs.existsSync(path.join(repo, 'studio_floor', 'config.json')));
  ok('the code survives a reset', fs.existsSync(path.join(repo, 'src')));
  ok('the README survives a reset', fs.existsSync(path.join(repo, 'README.md')));
  ok('nothing else in the project was touched',
    fs.readdirSync(repo).sort().join(',') === before.join(','));

  ok('resetting twice is harmless', resetProjectState(repo).removed === false);
}
{
  const old = path.join(tmp, 'legacy');
  resetProjectState(old);
  ok('reset finds the legacy state directory too', !fs.existsSync(path.join(old, '.studio')));
  ok('and leaves the legacy config alone', fs.existsSync(path.join(old, 'studio.config.json')));
}

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
console.log(process.exitCode ? '\nproject checks FAILED\n' : `\nall ${n} project checks passed\n`);
