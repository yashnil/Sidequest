import 'server-only';
import type { CompilerProviders, SharedEvidenceLayer } from '@sidequest/compiler';
import { packBackedProviders, SYNTHETIC_WORLDS, syntheticCandidate } from '@sidequest/compiler/testing';
import {
  assessConfidence,
  DESTINATION_RESOLUTION_VERSION,
  licence,
  normalizeDestinationQuery,
  type DestinationCandidate,
  type DestinationResolution,
} from '@sidequest/core';
import { createOpenProviders, type LiveDiagnostics } from '../providers/live';
import { withEvidenceStore } from './evidence';

/**
 * The provider switch and the readiness message live in `./readiness`.
 *
 * Re-exported here so every existing caller is unaffected, and *defined* there
 * because this module builds the live stack: a page that only wants to say
 * "compiling is switched off in this build" must be able to ask without pulling
 * Nominatim, Valhalla, Overture and the research model into its import graph.
 */
import { compilerProviderChoice } from './readiness';
export {
  compilerProviderChoice,
  providerReadiness,
  type CompilerProviderChoice,
  type ProviderReadiness,
} from './readiness';

/** How many model calls one compilation may make. */
function maxModelCalls(): number {
  const configured = Number(process.env.SIDEQUEST_COMPILER_MAX_AI_CALLS ?? '');
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 12;
}

/**
 * The provider set, and the counters it will fill in as it runs.
 *
 * The counters come back by reference rather than by return value because they
 * are only meaningful *after* the compilation — which is exactly when the runner
 * folds them into the artifact's diagnostics, so what a region cost is recorded
 * beside what it contains.
 */
export interface ResolvedProviders {
  providers: CompilerProviders;
  live: LiveDiagnostics | null;
  /**
   * The shared evidence layer wrapped around the research funnel.
   *
   * Null only when sharing is explicitly switched off. Like `live`, it is read
   * *after* the compilation, because what it holds is a ledger of what the run
   * avoided rather than an input to any decision it made.
   */
  evidence: SharedEvidenceLayer | null;
}

export function compilerProviders(candidateId?: string): ResolvedProviders {
  const choice = compilerProviderChoice();
  if (choice === 'fixture') {
    // Keyed off the interpretation the traveller picked, so the ambiguous
    // journey compiles the world they actually chose rather than the first one.
    const base = candidateId ? fixtureProvidersForCandidate(candidateId) : fixtureProviders();
    const wrapped = withEvidenceStore(base);
    return { providers: wrapped.providers, live: null, evidence: wrapped.evidence };
  }
  if (choice === 'open') {
    const resolved = createOpenProviders({ maxModelCalls: maxModelCalls() });
    const wrapped = withEvidenceStore(resolved.providers);
    return {
      providers: wrapped.providers,
      live: resolved.diagnostics,
      evidence: wrapped.evidence,
    };
  }
  throw new Error('No compiler providers are configured.');
}

// ---------------------------------------------------------------------------
// Fixture providers
// ---------------------------------------------------------------------------

/**
 * Test destinations, and the only place in the product that maps a string to a
 * world.
 *
 * This is fixture data behind an env switch, exactly like the offline weather
 * generator — not a destination-name conditional in the live path. `open` never
 * reaches this function.
 *
 * The three entries exist to make three journeys reachable in a browser test:
 * one destination that resolves cleanly, one that is genuinely ambiguous, and
 * one that is not a place at all.
 */
const FIXTURE_DESTINATIONS: readonly {
  match: string;
  worlds: (keyof typeof SYNTHETIC_WORLDS)[];
  isPlace: boolean;
}[] = [
  { match: 'harbour', worlds: ['transit_city'], isPlace: true },
  { match: 'outer', worlds: ['ferry_island', 'remote_road'], isPlace: true },
  { match: 'somewhere', worlds: [], isPlace: false },
  /**
   * A region that compiles cleanly and cannot be planned, because everything in
   * it is further out than a day can reach. The one state that used to come back
   * as a finished itinerary with nothing in it.
   */
  { match: 'faraway', worlds: ['unreachable_region'], isPlace: true },
  /**
   * A region whose stops all pass the board and none of which fits in a day.
   * The planner's own refusal, as opposed to the board's.
   */
  { match: 'longday', worlds: ['unplannable_region'], isPlace: true },
];

function fixtureMatch(query: string): (typeof FIXTURE_DESTINATIONS)[number] {
  const needle = query.trim().toLowerCase();
  return (
    FIXTURE_DESTINATIONS.find((entry) => needle.includes(entry.match)) ?? {
      match: needle,
      worlds: ['transit_city'],
      isPlace: true,
    }
  );
}

/**
 * What the fixture research funnel does.
 *
 * Chosen so the evidence surfaces are reachable in a browser test: a booking
 * requirement makes the "book before you leave" path real, and partial official
 * coverage means some cards carry citations and some honestly do not — which is
 * the mix a live compilation actually produces and the one the UI has to read
 * well under.
 */
const FIXTURE_RESEARCH = { bookingRequired: true, officialSourceCoverage: 0.6 } as const;

function fixtureProviders(): CompilerProviders {
  // Every non-resolver provider comes from the first world a query names, so a
  // compilation in a browser test produces a real region with real coverage.
  const base = withOpenLicences(packBackedProviders(SYNTHETIC_WORLDS.transit_city!, FIXTURE_RESEARCH));

  return {
    ...base,
    resolver: {
      name: 'fixture-resolver',
      async resolve({ query }): Promise<DestinationResolution> {
        const entry = fixtureMatch(query);

        if (!entry.isPlace) {
          return {
            schemaVersion: DESTINATION_RESOLUTION_VERSION,
            query,
            normalizedQuery: normalizeDestinationQuery(query),
            candidates: [],
            ambiguityReasons: ['query_is_not_a_place'],
            providersConsulted: ['fixture-resolver'],
            resolvedAt: '2026-07-31T00:00:00.000Z',
          };
        }

        const candidates: DestinationCandidate[] = entry.worlds.map((key) => {
          const candidate = syntheticCandidate(SYNTHETIC_WORLDS[key]!);
          return {
            ...candidate,
            confidence: assessConfidence(
              entry.worlds.length > 1
                ? ['exact_name_match', 'single_provider_only']
                : ['exact_name_match', 'administrative_hierarchy_match', 'boundary_available'],
            ),
          };
        });

        const ambiguityReasons: DestinationResolution['ambiguityReasons'] =
          candidates.length > 1 ? ['multiple_matching_places'] : [];

        return {
          schemaVersion: DESTINATION_RESOLUTION_VERSION,
          query,
          normalizedQuery: normalizeDestinationQuery(query),
          candidates,
          ambiguityReasons,
          ...(candidates.length === 1 && candidates[0]
            ? { unambiguousCandidateId: candidates[0].id }
            : {}),
          providersConsulted: ['fixture-resolver'],
          resolvedAt: '2026-07-31T00:00:00.000Z',
        };
      },
    },
  };
}

/**
 * The providers a synthetic world needs, once an interpretation is chosen.
 *
 * Keyed off the candidate the traveller picked rather than off the query, so the
 * ambiguous journey compiles the world they actually selected.
 */
export function fixtureProvidersForCandidate(candidateId: string): CompilerProviders {
  const world =
    Object.values(SYNTHETIC_WORLDS).find((spec) => spec.id === candidateId) ??
    SYNTHETIC_WORLDS.transit_city!;
  return withOpenLicences({
    ...packBackedProviders(world, FIXTURE_RESEARCH),
    resolver: fixtureProviders().resolver,
  });
}

/**
 * Add the licences a routing engine and our own prose would carry.
 *
 * Without this the fixture journey renders no attribution, and a browser test
 * asserting attribution would be asserting nothing.
 *
 * The place licences are **unioned rather than replaced**, because the pack the
 * fixture is built on already declares its own — a permissive primary layer and
 * a share-alike geographic one, which is the shape a live build produces and
 * therefore the shape the attribution surfaces have to read well under.
 */
function withOpenLicences(providers: CompilerProviders): CompilerProviders {
  const routing = licence('ODbL-1.0', ['routing']);
  const authored = licence('sidequest-authored', ['descriptions', 'classification', 'scoring']);

  return {
    ...providers,
    places: {
      name: providers.places.name,
      async discover(input) {
        const result = await providers.places.discover(input);
        const declared = result.licences ?? [];
        const merged = new Map(declared.map((entry) => [entry.id, entry]));
        if (!merged.has('sidequest-authored')) merged.set('sidequest-authored', authored);
        if (!merged.has('ODbL-1.0')) {
          merged.set('ODbL-1.0', licence('ODbL-1.0', ['places', 'geography']));
        }
        return { ...result, licences: [...merged.values()] };
      },
    },
    routing: {
      name: providers.routing.name,
      supportedModes: () => providers.routing.supportedModes(),
      async matrix(input) {
        const result = await providers.routing.matrix(input);
        return { ...result, licences: [routing] };
      },
    },
  };
}
