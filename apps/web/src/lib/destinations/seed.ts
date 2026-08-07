import 'server-only';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { destinationIndexRelease } from '../db/destination-index-repository';
import { importDestinationIndex } from './import';

/**
 * A DESTINATION INDEX FOR AN ENVIRONMENT THAT HAS NO CATALOGUE.
 *
 * The end-to-end suite runs against fixture providers and no network, so it has
 * never had an index — and the specs were written around that, exercising the
 * typed-text fallback deliberately. That was the right trade while the index only
 * powered a dropdown.
 *
 * It stops being the right trade once "where should I go" exists, because a
 * shortlist with no index has nothing to rank: the browser test would assert
 * only that we degrade honestly, and the feature itself would be covered by unit
 * tests alone. So this loads a *synthetic* index — five invented countries, ten
 * invented regions, eighty invented towns — from a committed file.
 *
 * Three properties make it safe:
 *
 * - **It is opt-in.** Without `SIDEQUEST_DESTINATION_INDEX_SEED` nothing happens,
 *   so no development or production database is ever touched by it.
 * - **It names nowhere real.** Inventing the geography is not laziness; a fixture
 *   that named real places would be authored destination knowledge living in the
 *   test suite, which is the thing the architecture tests exist to prevent.
 * - **It is the real import path.** The same parser, the same extents-from-
 *   children measurement, the same release row. A seeding shortcut that wrote
 *   rows directly would test a code path nobody runs.
 */
export function seedDestinationIndexIfRequested(): void {
  const source = process.env.SIDEQUEST_DESTINATION_INDEX_SEED?.trim();
  if (!source) return;
  if (destinationIndexRelease()) return;

  try {
    const ndjson = readFileSync(resolve(process.cwd(), source), 'utf8');
    importDestinationIndex({ ndjson, releaseId: 'fixture-1', now: new Date() });
  } catch (error) {
    // Never fatal. A missing seed file must degrade to "no index", which the
    // product already renders honestly, rather than taking the app down.
    console.error('Destination index seed could not be loaded', error);
  }
}
