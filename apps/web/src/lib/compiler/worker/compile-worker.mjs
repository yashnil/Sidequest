#!/usr/bin/env node
/**
 * THE COMPILE WORKER'S BOOTSTRAP — A SEPARATE PROCESS, ON PURPOSE.
 *
 * A compilation used to run inside the request-serving Node process, and one
 * running build froze every route for the length of the build at full CPU: the
 * event loop the compiler was saturating was the same one every page render
 * was queued on. This file is the isolation — `launch.ts` spawns it with plain
 * `node`, detached, so the build has its own process, its own event loop, and
 * a lifetime that does not end with the web server's.
 *
 * It is deliberately a `.mjs` file that Next never imports: the bundler sees
 * only `launch.ts`, which passes this file's *path* to `spawn`. The TypeScript
 * module graph — the same runner, repositories and providers the inline path
 * uses — is loaded through `jiti`, which is already in the tree and handles
 * the extensionless ESM imports this codebase writes and plain Node does not
 * resolve. Nothing is compiled ahead of time and nothing is duplicated: the
 * worker runs the very same source files the web process would have.
 *
 * `server-only` is aliased to an empty shim, the same move `vitest.config.ts`
 * makes and for the same reason: the guard protects client bundles, and this
 * process could not be further from one.
 *
 * The database is the only channel. Everything the worker learns or decides is
 * a row the web process reads; nothing comes back over stdio, so the web
 * process dying mid-build costs the build nothing.
 */
import { createJiti } from 'jiti';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = dirname(fileURLToPath(import.meta.url));
const appsWebSrc = resolve(workerDir, '../../..');

const jiti = createJiti(import.meta.url, {
  alias: {
    'server-only': resolve(workerDir, 'server-only-shim.mjs'),
    '@': appsWebSrc,
  },
  interopDefault: true,
});

try {
  const { workerMain } = await jiti.import(resolve(workerDir, 'main.ts'));
  const code = await workerMain(process.argv.slice(2));
  process.exit(code);
} catch (error) {
  // The job row is the traveller's truth; if we could not even load the graph
  // there is no row we can write, so the orphan reclaim is what recovers this.
  console.error('compile-worker could not start', error);
  process.exit(1);
}
