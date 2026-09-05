// Dev-only Node ESM loader for hybrid-eval.ts: redirects `server-only`
// imports to a no-op module without touching any other package's export
// conditions (unlike `--conditions=react-server`, which also breaks
// packages such as `hyparquet` that have no react-server export branch).
//
// Self-registering via `module.register`, so it can be loaded with
// `--import` alongside tsx's own loader.
import { register } from 'node:module';

register('./stub-server-only-hook.mjs', import.meta.url);
