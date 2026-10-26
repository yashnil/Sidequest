/**
 * PRODUCTION PASS — ONE CORRELATION ID PER REQUEST.
 *
 * Import-free (no `server-only`, no Node built-ins beyond the global Web
 * Crypto) so `proxy.ts` and `instrumentation.ts` can both use it in any runtime.
 */
export const REQUEST_ID_HEADER = 'x-request-id';
export function newRequestId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}
