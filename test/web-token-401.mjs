/**
 * The 401 half of web-token.mjs, in its own process.
 *
 * app.js can only be imported once per process and this needs it to meet a
 * refusal on its very first fetch — the exact moment the page used to die.
 * Prints what the page ended up showing; the parent asserts against that.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installStubBrowser } from './stub-browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-401-'));
fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# Locked\n');
process.env.STUDIO_PROJECT_ROOT = tmp;
process.env.STUDIO_STATE_DIR = path.join(tmp, 'state');

const stub = installStubBrowser({ status: 401, href: 'http://127.0.0.1:4173/' });

try {
  await import(pathToFileURL(path.resolve(HERE, '..', 'src', 'web', 'app.js')).href);
} catch (e) {
  console.log(`THREW: ${e.message}`);
  process.exit(1);
}

console.log(`title: ${stub.doc.title}`);
console.log(`banner: ${stub.byId('liveness').innerHTML}`);
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* leftover */ }
process.exit(0);
