/**
 * What the human sees while the team builds.
 *
 * The studio's own web UI is served out of `src/web`. This module resolves a
 * *second* static root — the thing being built — so the human can watch it come
 * alive in the same browser tab they are already watching the team in.
 *
 * Two rules govern everything below, and both were paid for this session:
 *
 * 1. **Never report a relative path.** `PROJECT.md` meant three different files
 *    to three different agents for an entire session because a relative name
 *    was printed where an absolute one belonged. Every function here returns
 *    absolute paths and says which candidates it rejected.
 * 2. **Never choose for the human.** This module used to pick the first
 *    directory containing an index.html and serve it. Grok killed that on
 *    review and was right: a project with a leftover `web/index.html` would
 *    have shown a marketing page while the game sat unserved in another
 *    directory, and the human would have had no way to tell from the frame.
 *    That is `PROJECT.md` meaning three files, again, with pixels instead of
 *    prose. Detection now *offers* — it ranks the directories that could be
 *    previewed and hands the list up. Nothing is served until
 *    `server.preview` says what to serve.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, HOME_DIR_NAME } from './paths.mjs';

/**
 * Where a browser-facing thing usually lives, most conventional first.
 *
 * These are the directories offered to the human when `server.preview` is
 * unset. Order decides what is listed first and nothing else — no entry here
 * has ever served a byte on its own, and none should. `.` is last because a
 * single-file game at the project root is a real shape, but offering to serve
 * an entire repository should be the last thing suggested, not the first.
 */
export const CANDIDATE_DIRS = ['web', 'public', 'site', 'app', 'game', 'test_project', '.'];

/** Directories a walk must never descend into. */
const IGNORED = new Set([HOME_DIR_NAME, 'node_modules', '.git', '.studio', 'test', 'src']);

/** What a browser is allowed to be handed from the preview root. */
export const PREVIEW_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function hasIndex(dir) {
  return fs.existsSync(path.join(dir, 'index.html'));
}

/**
 * Decide which directory the preview serves.
 *
 * `configured` is whatever `server.preview` holds — a path relative to the
 * project root, or absolute, or empty for "work it out". A configured path that
 * does not exist is *not* quietly replaced by a detected one: the human asked
 * for that directory, and silently serving a different one is the exact bug
 * this project keeps rediscovering. It comes back as `found: false` with a
 * reason naming the resolved path.
 */
export function resolvePreview(configured = null, projectRoot = PROJECT_ROOT) {
  const want = typeof configured === 'string' ? configured.trim() : '';

  if (want) {
    const root = path.resolve(projectRoot, want);
    const exists = isDir(root);
    const index = exists && hasIndex(root);
    return {
      root: exists ? root : null,
      entry: index ? path.join(root, 'index.html') : null,
      found: exists,
      source: 'configured',
      reason: exists
        ? (index ? `serving ${root}` : `${root} exists but has no index.html in it`)
        : `server.preview is "${want}", which resolves to ${root} — that directory does not exist`,
      configured: want,
      candidates: [{ dir: want, path: root, exists, index }],
    };
  }

  const candidates = CANDIDATE_DIRS.map((dir) => {
    const p = path.resolve(projectRoot, dir);
    const exists = isDir(p);
    return { dir, path: p, exists, index: exists && hasIndex(p) };
  });

  // An offer, never a choice. `offers` is what the pane turns into "point it
  // here" — it is empty when there is genuinely nothing that could be served,
  // which is a different sentence to the human and must stay a different one.
  const offers = candidates.filter((c) => c.index);

  return {
    root: null,
    entry: null,
    found: false,
    source: 'unset',
    reason: offers.length
      ? `server.preview is not set, so nothing is being served. ${offers.length === 1 ? 'One directory' : `${offers.length} directories`} here could be: ${offers.map((o) => o.path).join(', ')}`
      : 'server.preview is not set, and nothing to preview yet — none of the usual directories contains an index.html',
    configured: null,
    offers,
    candidates,
  };
}

/**
 * A number that changes whenever anything under `root` changes.
 *
 * The alternative was `fs.watch`, which on Windows means a recursive watcher
 * held open for the life of the studio, missed events under rename-heavy
 * editors, and a watcher leak every time the preview root moves. A preview
 * directory is small and the poll is once a second from one browser tab, so
 * walking it is cheaper than being wrong about it.
 *
 * The file count is part of the version on purpose: deleting a file usually
 * lowers the maximum mtime rather than raising it, and a version that only ever
 * counts up would not notice.
 */
export function previewVersion(root, { limit = 4000 } = {}) {
  if (!root || !isDir(root)) return { version: '0:0', files: 0, newest: 0 };
  let newest = 0;
  let files = 0;
  const stack = [root];
  while (stack.length && files < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORED.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      files += 1;
      if (files > limit) break;
      try {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* vanished mid-walk; the next poll will see it */ }
    }
  }
  return { version: `${Math.round(newest)}:${files}`, files, newest };
}

/**
 * Turn a request path into a file inside the preview root, or null.
 *
 * The check is on the *real* path, after symlinks: a string prefix test passes
 * happily for a symlink inside the preview root that points somewhere else
 * entirely. A directory resolves to its index.html so `/preview/` and
 * `/preview/levels/` both behave the way a static host behaves.
 */
export function resolvePreviewFile(root, requestPath) {
  if (!root) return null;
  let rel;
  try {
    rel = decodeURIComponent(requestPath || '');
  } catch {
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  if (rel.includes('\0')) return null;

  let file = path.resolve(root, rel || '.');
  if (isDir(file)) file = path.join(file, 'index.html');

  let realRoot;
  let realFile;
  try {
    realRoot = fs.realpathSync(root);
    realFile = fs.realpathSync(file);
  } catch {
    return null; // does not exist, or a broken link — either way, not ours to serve
  }
  const withSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realFile !== realRoot && !realFile.startsWith(withSep)) return null;
  try {
    if (!fs.statSync(realFile).isFile()) return null;
  } catch {
    return null;
  }
  return realFile;
}
