/* eslint-disable @typescript-eslint/no-require-imports */
// Dev-only CJS preload for hybrid-eval.ts: tsx transpiles some files through
// CommonJS `require`, which the ESM `stub-server-only-loader.mjs` hook does
// not intercept (ESM loader hooks and the CJS `require` pipeline are
// separate module systems). This patches `Module._load` to special-case
// `server-only` the same way, without touching resolution for anything else.
const Module = require('node:module');
const path = require('node:path');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'server-only') return {};
  /*
   * `revalidatePath`/`revalidateTag`/etc. invalidate Next's page cache — a
   * concept that only exists inside a running Next server's request
   * lifecycle. Called from a bare script there is no cache to invalidate, and
   * the real implementation throws ("static generation store missing")
   * rather than no-op, which would otherwise abort a production action's
   * database writes after they already happened. No-op only the cache calls;
   * every other export (e.g. `unstable_cache`) stays real.
   */
  if (request === 'next/cache') {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      revalidatePath: () => {},
      revalidateTag: () => {},
      updateTag: () => {},
      refresh: () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

/*
 * `hyparquet` ships ESM-only (no `require` export condition). Its only
 * importer, `overture/scan.ts`, is not on any path this preload is used for
 * — but tsx's tsconfig-paths resolver walks sibling files while resolving an
 * unrelated `@/*` import in the same directory and fails resolving
 * `hyparquet` before that import is even reached. Patching resolution
 * (`_resolveFilename`), not just load, because the failure happens at
 * resolve time.
 */
const originalResolveFilename = Module._resolveFilename;
const hyparquetStubPath = path.join(__dirname, 'hyparquet-stub.cjs');
Module._resolveFilename = function patchedResolveFilename(request, ...rest) {
  if (request === 'hyparquet') return hyparquetStubPath;
  return originalResolveFilename.call(this, request, ...rest);
};
