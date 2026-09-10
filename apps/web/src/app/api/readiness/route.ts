import { NextResponse } from 'next/server';
import { capabilityRegistry } from '@/lib/providers/capabilities.mjs';
import { getDb } from '@/lib/db/client';
import { destinationIndexRelease, destinationIndexSize } from '@/lib/db/destination-index-repository';

/**
 * IS THIS DEPLOYMENT ABLE TO DO THE JOB — NOT MERELY ABLE TO ANSWER.
 *
 * STAGING PARITY §7. `/api/health` returned 200 on the deployment where a
 * traveller typed "Japan" and was shown the empty world, because the database
 * opened and that was all it claimed to check. Liveness is what a platform's
 * restart policy needs; it is not what an operator needs, and conflating the two
 * is how a green dashboard sits above a broken product.
 *
 * So this is the second answer, and the two do not compete: `/api/health` stays
 * narrow and fast for the healthcheck, and this one says what the deployment can
 * actually do. Three rules:
 *
 * - **Every capability the primary product needs has a row.** Present and
 *   degraded are different words, and a capability that is absent says which
 *   variable would provide it.
 * - **No secret, and no value.** Whether a credential is set, never any part of
 *   it; the database is reported by *class* rather than by path, because a path is
 *   infrastructure detail an unauthenticated URL should not hand out.
 * - **`ready` is about the primary flow only.** Compose a trip, place a
 *   destination, keep it. Media, live routing and places are enrichment: their
 *   absence is `degraded`, never `not ready`, because the product is honest and
 *   useful without them and saying otherwise would make the signal useless.
 */
export const dynamic = 'force-dynamic';

type State = 'ready' | 'degraded' | 'unavailable';

interface Row {
  capability: string;
  state: State;
  provider: string | null;
  /** Present only when something is missing, and never a value. */
  note?: string;
}

export async function GET(): Promise<NextResponse> {
  const registry = capabilityRegistry(process.env);
  const byId = registry.byId;
  const rows: Row[] = [];

  const configured = (process.env.SIDEQUEST_DB_PATH ?? '').trim();
  const pathClass = configured === '' ? 'default (inside the working directory)' : configured.startsWith('/') ? 'absolute path' : 'relative to the working directory';
  let database: State = 'unavailable';
  let databaseNote: string | undefined;
  try {
    getDb().prepare('SELECT 1').get();
    database = configured.startsWith('/') ? 'ready' : 'degraded';
    if (!configured.startsWith('/')) databaseNote = 'The database is not on an absolute path, so a redeploy may discard it. Set SIDEQUEST_DB_PATH to a file on a mounted volume.';
  } catch {
    databaseNote = 'The database could not be opened. Check that the volume is mounted and SIDEQUEST_DB_PATH points into it.';
  }
  rows.push({ capability: 'database', state: database, provider: 'sqlite', ...(databaseNote ? { note: databaseNote } : {}) });

  const composition = byId['composition.model'];
  rows.push({
    capability: 'composition',
    state: registry.composition === 'anthropic' ? 'ready' : registry.composition === 'fixture' ? 'degraded' : 'unavailable',
    provider: composition?.provider ?? null,
    ...(registry.composition === 'off'
      ? { note: 'No ANTHROPIC_API_KEY: a trip cannot be composed.' }
      : registry.composition === 'fixture'
        ? { note: 'The fixture composer is on. Travellers would receive a saved draft; unset SIDEQUEST_COMPOSER_PROVIDER in production.' }
        : {}),
  });

  const resolution = byId['destinations.resolution'];
  rows.push({
    capability: 'destination_resolution',
    state: resolution && resolution.limitations.length === 0 ? 'ready' : 'degraded',
    provider: resolution?.provider ?? null,
    ...(resolution && resolution.limitations.length > 0 ? { note: resolution.limitations[0]! } : {}),
  });

  /* The typeahead is database state rather than configuration, so it is read rather than inferred. */
  let suggestions: State = 'degraded';
  let suggestionNote: string | undefined =
    'No destination index on this deployment: the field takes free text, which every step supports. Countries still place from the bundled reference.';
  try {
    if (destinationIndexRelease()) {
      suggestions = 'ready';
      suggestionNote = undefined;
    }
  } catch {
    /* An unreadable index is the same experience as an absent one. */
  }
  rows.push({ capability: 'destination_suggestions', state: suggestions, provider: suggestions === 'ready' ? 'local-index' : null, ...(suggestionNote ? { note: suggestionNote } : {}) });

  const enrichment: { capability: string; id: string }[] = [
    { capability: 'map', id: 'maps.tiles' },
    { capability: 'climate', id: 'weather.climate' },
    { capability: 'weather', id: 'weather.forecast' },
    { capability: 'routing', id: 'routing.drive' },
    { capability: 'routing_global', id: 'routing.global' },
    { capability: 'places', id: 'places.identity' },
    { capability: 'place_hours', id: 'places.hours' },
    { capability: 'photos', id: 'places.photos' },
  ];
  for (const { capability, id } of enrichment) {
    const found = byId[id];
    rows.push({
      capability,
      state: found?.configured ? 'ready' : 'degraded',
      provider: found?.provider ?? null,
      ...(found && !found.configured && found.limitations[0] ? { note: found.limitations[0] } : {}),
    });
  }

  let refinement: State = 'unavailable';
  try {
    const table = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'refinement_versions'").get();
    refinement = table ? 'ready' : 'unavailable';
  } catch {
    /* Already reported by the database row. */
  }
  rows.push({
    capability: 'refinement',
    state: refinement,
    provider: refinement === 'ready' ? 'sqlite' : null,
    ...(refinement === 'ready' ? {} : { note: 'The refinement tables are missing; they are created on first connection.' }),
  });

  const blocking = rows.filter((row) => row.state === 'unavailable' || (row.capability === 'database' && row.state === 'degraded'));
  const degraded = rows.filter((row) => row.state === 'degraded');

  return NextResponse.json(
    {
      ready: blocking.length === 0,
      mode: registry.mode,
      database: { class: pathClass, indexEntries: suggestions === 'ready' ? safeIndexSize() : 0 },
      capabilities: rows,
      blocking: blocking.map((row) => row.capability),
      degraded: degraded.map((row) => row.capability),
    },
    { status: blocking.length === 0 ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}

function safeIndexSize(): number {
  try {
    return destinationIndexSize();
  } catch {
    return 0;
  }
}
