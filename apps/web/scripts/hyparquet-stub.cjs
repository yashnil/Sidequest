// Dev-only stand-in for `hyparquet`, used only so tsx's tsconfig-paths
// resolver can finish resolving unrelated `@/*` imports that happen to sit in
// the same directory as `overture/scan.ts` (which statically imports
// `hyparquet`, an ESM-only package with no `require` export condition — tsx's
// CJS-interop resolver cannot resolve it, even though nothing on this script's
// actual call path ever executes `scan.ts`). Every export here is a stub that
// throws if actually called, so a real, silent use would fail loudly rather
// than pretend to work.
function unreachable(name) {
  return () => {
    throw new Error(`hyparquet-stub: ${name} was actually called — this script's path does not use it.`);
  };
}
module.exports = {
  parquetMetadataAsync: unreachable('parquetMetadataAsync'),
  parquetReadObjects: unreachable('parquetReadObjects'),
};
