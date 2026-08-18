/**
 * The human must be able to watch the thing being built, and must never be
 * shown a frame that is lying about what it is serving.
 *
 * This session cost a day to one relative filename: `PROJECT.md` meant three
 * different files to three different agents, and every one of them was sure it
 * had read the human's spec. The preview is the same shape of risk with a
 * bigger blast radius — it serves a directory over HTTP — so the rules it is
 * held to here are:
 *
 *   - nothing is served until server.preview says what to serve (grok killed
 *     auto-detect on review: a leftover web/index.html would have hidden the
 *     game behind a marketing page and the frame would have looked fine);
 *   - a configured directory is never silently replaced by a suggestion;
 *   - the version changes when the directory changes, including on delete;
 *   - nothing outside the preview root is ever served, checked on the real
 *     path rather than on a string prefix.
 *
 * Run: node test/preview.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startStudioServer, studioUrl } from './harness.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const { resolvePreview, previewVersion, resolvePreviewFile, CANDIDATE_DIRS } =
  await import(studioUrl('core/preview.mjs'));

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `studio-preview-${name}-`));
const put = (root, rel, body = '<!doctype html>hello') => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

console.log('preview');

// ------------------------------------------------------------------ detection

{
  const root = tmp('unset');
  put(root, path.join('web', 'index.html'));
  const info = resolvePreview(null, root);
  check('an unset server.preview serves NOTHING, however obvious the guess looks',
    info.found === false && info.root === null && info.source === 'unset', `${info.source} ${info.root}`);
  check('and it offers the directory instead of taking it',
    info.offers.length === 1 && info.offers[0].path === path.join(root, 'web'),
    JSON.stringify(info.offers.map((o) => o.dir)));
  check('the offer is named with an absolute path', (info.reason || '').includes(path.join(root, 'web')), info.reason);
  check('every candidate is reported, not just the offers',
    info.candidates.length === CANDIDATE_DIRS.length, `${info.candidates.length} of ${CANDIDATE_DIRS.length}`);
}

{
  // The exact failure grok named on review: a leftover marketing page in web/
  // and the real thing in test_project/. Auto-detect served web/ and the frame
  // looked healthy. Now neither is served and both are offered, in order.
  const root = tmp('two');
  put(root, path.join('web', 'index.html'), 'MARKETING');
  put(root, path.join('test_project', 'index.html'), 'THE GAME');
  const info = resolvePreview(null, root);
  check('two plausible directories means a choice, not a winner', info.found === false);
  check('both are offered, most conventional first',
    info.offers.map((o) => o.dir).join(',') === 'web,test_project',
    info.offers.map((o) => o.dir).join(','));
  check('the one that was chosen is the one that was named',
    resolvePreview('test_project', root).entry === path.join(root, 'test_project', 'index.html'));

  // The pane says "serving (configured)" with no other branch, and that is only
  // honest if `unset` can never hand back something servable. Stack the deck:
  // every candidate directory holds an index.html. Still nothing is served.
  const loaded = tmp('every-candidate');
  for (const dir of CANDIDATE_DIRS) put(loaded, path.join(dir, 'index.html'));
  const stacked = resolvePreview(null, loaded);
  check('unset has no servable answer even when every candidate is servable',
    stacked.found === false && stacked.root === null && stacked.entry === null,
    `${stacked.found} ${stacked.root} ${stacked.entry}`);
}

{
  const root = tmp('none');
  fs.mkdirSync(path.join(root, 'web'));
  const info = resolvePreview(null, root);
  check('an empty candidate directory is not a preview', info.found === false);
  check('nothing to offer is a different sentence to nothing chosen',
    info.offers.length === 0 && /nothing to preview/i.test(info.reason), info.reason);
}

// ------------------------------------- a configured path is never substituted

{
  const root = tmp('configured');
  put(root, path.join('web', 'index.html'));       // a perfectly good preview
  const info = resolvePreview('game', root);       // that the human did not ask for
  check('a configured directory that does not exist reports as missing', info.found === false);
  check('and is NOT quietly replaced by the one that could be offered',
    info.root === null && !/web/.test(info.reason || ''), String(info.reason));
  check('the failure names the absolute path it resolved to',
    (info.reason || '').includes(path.join(root, 'game')), info.reason);
}

{
  const root = tmp('configured-empty');
  fs.mkdirSync(path.join(root, 'game'));
  const info = resolvePreview('game', root);
  check('a configured directory with no index.html is found but has no entry',
    info.found === true && info.entry === null);
  check('and says which file is missing', /index\.html/.test(info.reason), info.reason);
}

{
  const root = tmp('configured-abs');
  const abs = path.join(root, 'elsewhere');
  put(abs, 'index.html');
  const info = resolvePreview(abs, root);
  check('an absolute server.preview is honoured', info.root === abs, String(info.root));
}

// -------------------------------------------------------------------- version

{
  const root = tmp('version');
  const dir = path.join(root, 'web');
  put(root, path.join('web', 'index.html'));
  const first = previewVersion(dir);
  put(root, path.join('web', 'game.js'), 'console.log(1)');
  const second = previewVersion(dir);
  check('adding a file changes the version', second.version !== first.version, `${first.version} -> ${second.version}`);

  fs.rmSync(path.join(dir, 'game.js'));
  const third = previewVersion(dir);
  check('deleting a file changes the version too', third.version !== second.version, `${second.version} -> ${third.version}`);
  check('a missing root is a version, not a crash', previewVersion(null).version === '0:0');
}

// ------------------------------------------------------------------ traversal

{
  const root = tmp('escape');
  const web = path.join(root, 'web');
  put(root, path.join('web', 'index.html'), 'INDEX');
  put(root, path.join('web', 'sub', 'deep.js'), 'DEEP');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET');

  check('a normal file resolves',
    resolvePreviewFile(web, '/sub/deep.js') === fs.realpathSync(path.join(web, 'sub', 'deep.js')));
  check('a directory resolves to its index',
    resolvePreviewFile(web, '/') === fs.realpathSync(path.join(web, 'index.html')));
  check('..  is refused', resolvePreviewFile(web, '/../secret.txt') === null);
  check('encoded ..%2f is refused', resolvePreviewFile(web, '/..%2fsecret.txt') === null);
  check('a leading slash cannot mean the filesystem root', resolvePreviewFile(web, '//etc/passwd') === null);
  check('a NUL byte is refused', resolvePreviewFile(web, '/index.html%00.png') === null);
  check('a missing file is null rather than a throw', resolvePreviewFile(web, '/nope.js') === null);

  // The reason this checks realpath and not a string prefix. Windows needs
  // privilege for symlinks, so a refusal here is reported as unproven rather
  // than passed off as a pass.
  const link = path.join(web, 'out.txt');
  try {
    fs.symlinkSync(path.join(root, 'secret.txt'), link);
    check('a symlink pointing out of the root is refused', resolvePreviewFile(web, '/out.txt') === null);
  } catch (err) {
    console.log(`  skip  symlink escape — this machine will not create one (${err.code}); the realpath check is unproven here`);
  }
}

// ------------------------------------------------------------------ over HTTP

const boot = `
import { Store } from ${JSON.stringify(studioUrl('core/store.mjs'))};
import { createHttpServer } from ${JSON.stringify(studioUrl('server/server.mjs'))};
const s = new Store();
studioTestReady(s, createHttpServer(s, null));
`;

const served = tmp('http');
put(served, path.join('web', 'index.html'), '<!doctype html><title>MARKER-9f13</title>');
put(served, path.join('later', 'index.html'), '<!doctype html><title>MARKER-SECOND</title>');
fs.writeFileSync(path.join(served, 'secret.txt'), 'SECRET');

// The server serves what the config names and nothing else, so the config is
// part of the fixture now rather than something the server works out.
const cfgFile = path.join(served, 'studio.config.json');
const writeCfg = (preview) => {
  fs.writeFileSync(cfgFile, JSON.stringify({ server: { preview } }, null, 2));
  // Two writes inside one filesystem tick would be invisible to an mtime cache,
  // and a test that passes because the clock was slow is not a test.
  const ahead = new Date(Date.now() + 2000);
  fs.utimesSync(cfgFile, ahead, ahead);
};
writeCfg('web');

const server = await startStudioServer({
  boot, root: served, prefix: 'studio-preview-http-', env: { STUDIO_CONFIG: cfgFile },
});

try {
  const info = await server.get('/api/preview');
  check('http: /api/preview finds the directory', info.found === true, JSON.stringify(info.reason));
  check('http: it reports an absolute entry', path.isAbsolute(info.entry || ''), String(info.entry));
  check('http: it hands the pane a url to frame', info.url === '/preview/', String(info.url));
  check('http: it hands the pane a version to watch',
    typeof info.version === 'string' && info.version !== '0:0', String(info.version));

  const page = await fetch(`${server.base}/preview/`);
  const body = await page.text();
  check('http: /preview/ serves the game itself',
    page.status === 200 && body.includes('MARKER-9f13'), `${page.status} ${body.slice(0, 60)}`);
  check('http: it is html', (page.headers.get('content-type') || '').startsWith('text/html'),
    page.headers.get('content-type'));
  check('http: it is never cached — a reload must show the new bytes',
    /no-store/.test(page.headers.get('cache-control') || ''), page.headers.get('cache-control'));

  const bare = await fetch(`${server.base}/preview`, { redirect: 'manual' });
  check('http: /preview redirects to /preview/ so relative assets resolve',
    bare.status === 302 && bare.headers.get('location') === '/preview/',
    `${bare.status} ${bare.headers.get('location')}`);

  // fetch() normalises `..` out of a path before it is sent, so the escape is
  // attempted down a raw socket where the bytes reach the server unchanged.
  const raw = await new Promise((resolve, reject) => {
    const req = http.request({ port: server.port, host: '127.0.0.1', path: '/preview/../secret.txt' }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
  check('http: a raw ../ escape is refused and leaks nothing',
    raw.status === 404 && !raw.text.includes('SECRET'), `${raw.status} ${raw.text.slice(0, 80)}`);

  const before = (await server.get('/api/preview')).version;
  fs.writeFileSync(path.join(served, 'web', 'later.js'), 'console.log("added while the human watched")');
  const after = (await server.get('/api/preview')).version;
  check('http: writing a file changes the version the pane polls', after !== before, `${before} -> ${after}`);

  // The preview serves the human's own project directory. The studio's API is
  // open cross-origin on purpose; this must not be, or any page in any other
  // tab could read the project out of the frame.
  check('http: no cross-origin header on the preview',
    page.headers.get('access-control-allow-origin') === null,
    String(page.headers.get('access-control-allow-origin')));
  const api = await fetch(`${server.base}/api/state`);
  check('http: the studio API keeps its open header — this narrowed one door, not all of them',
    api.headers.get('access-control-allow-origin') === '*',
    String(api.headers.get('access-control-allow-origin')));

  // server.preview is the setting a human edits precisely when the preview is
  // showing them nothing. Making them restart the studio to see the effect of
  // the setting that fixes the preview would be a bad joke, so it is re-read.
  writeCfg('later');
  const moved = await server.get('/api/preview');
  check('http: editing server.preview takes effect with no restart',
    moved.entry === path.join(served, 'later', 'index.html'), String(moved.entry));
  const movedPage = await fetch(`${server.base}/preview/`);
  const movedBody = await movedPage.text();
  check('http: and the frame is serving the new directory, not the old one',
    movedBody.includes('MARKER-SECOND'), movedBody.slice(0, 60));

  writeCfg('nowhere-at-all');
  const broken = await server.get('/api/preview');
  check('http: a live edit to a directory that does not exist is reported, not guessed around',
    broken.found === false && (broken.reason || '').includes(path.join(served, 'nowhere-at-all')), String(broken.reason));
} finally {
  server.stop();
}

// ------------------------------------------- and when there is nothing to show

const bareRoot = tmp('http-empty');
const empty = await startStudioServer({ boot, root: bareRoot, prefix: 'studio-preview-empty-' });
try {
  const info = await empty.get('/api/preview');
  check('http: an empty project reports nothing to preview', info.found === false, JSON.stringify(info.reason));
  check('http: it names the config file the human has to edit',
    typeof info.configFile === 'string' && path.isAbsolute(info.configFile), String(info.configFile));
  check('http: and still lists where it looked', Array.isArray(info.candidates) && info.candidates.length > 0);
  const page = await fetch(`${empty.base}/preview/`);
  const text = await page.text();
  check('http: the frame says so in words rather than showing a blank page',
    page.status === 404 && /nothing to preview/i.test(text), `${page.status} ${text.slice(0, 80)}`);
} finally {
  empty.stop();
}

console.log(failures ? `preview: ${failures} failed` : 'preview: all passed');
process.exit(failures ? 1 : 0);
