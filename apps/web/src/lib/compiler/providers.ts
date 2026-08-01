import 'server-only';
import type { CompilerProviders } from '@sidequest/compiler';
import { fakeProviders, SYNTHETIC_WORLDS, syntheticCandidate } from '@sidequest/compiler/testing';
import {
  assessConfidence,
  DESTINATION_RESOLUTION_VERSION,
  licence,
  normalizeDestinationQuery,
  type DestinationCandidate,
  type DestinationResolution,
} from '@sidequest/core';
import {
  createOpenProviders,
  missingProviderSwitches,
  openProvidersEnabled,
  type LiveDiagnostics,
} from '../providers/live';

/**
 * WHICH PROVIDER SET RUNS.
 *
 * The same three-way switch the weather layer already uses, for the same reason:
 * a browser test must assert against a world it chose rather than against
 * whatever a volunteer-run service was doing that morning, and an outage must be
 * reachable without waiting for one.
 *
 *   open     the live open-licensed stack — Nominatim, Overpass, Valhalla,
 *            Anthropic. Requires all four switches on.
 *   fixture  deterministic synthetic worlds. What the end-to-end suite runs on.
 *   off      no compilation at all, which is the honest default.
 *
 * Unlike the weather switch, an unrecognised value falls through to **off**.
 * Open-Meteo is free and keyless so defaulting to live costs nothing; these
 * reach volunteer services and a billed model, and a typo should cost nothing.
 */
export type CompilerProviderChoice = 'open' | 'fixture' | 'off';

export function compilerProviderChoice(): CompilerProviderChoice {
  const configured = process.env.SIDEQUEST_COMPILER_PROVIDER?.trim().toLowerCase();
  if (configured === 'fixture' || configured === 'off') return configured;
  if (configured === 'open') return 'open';
  // Nothing configured: infer from the four provider switches, so a developer
  // who turned those on does not also have to remember this one.
  return openProvidersEnabled() ? 'open' : 'off';
}

export interface ProviderReadiness {
  ready: boolean;
  choice: CompilerProviderChoice;
  message: string;
}

export function providerReadiness(): ProviderReadiness {
  const choice = compilerProviderChoice();
  if (choice === 'fixture') {
    return { ready: true, choice, message: 'Running against deterministic test data.' };
  }
  if (choice === 'open') {
    if (openProvidersEnabled()) {
      return { ready: true, choice, message: 'Running against the open map data stack.' };
    }
    return {
      ready: false,
      choice,
      // Names the switches, never a value. A developer needs to know which is
      // missing; nobody needs to see what is in it.
      message: `This build is missing: ${missingProviderSwitches().join(', ')}.`,
    };
  }
  return {
    ready: false,
    choice,
    message:
      'Compiling new destinations is switched off in this build, so only regions we already hold can be planned.',
  };
}

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
}

export function compilerProviders(candidateId?: string): ResolvedProviders {
  const choice = compilerProviderChoice();
  if (choice === 'fixture') {
    // Keyed off the interpretation the traveller picked, so the ambiguous
    // journey compiles the world they actually chose rather than the first one.
    return {
      providers: candidateId ? fixtureProvidersForCandidate(candidateId) : fixtureProviders(),
      live: null,
    };
  }
  if (choice === 'open') {
    const resolved = createOpenProviders({ maxModelCalls: maxModelCalls() });
    return { providers: resolved.providers, live: resolved.diagnostics };
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
  const base = withOpenLicences(fakeProviders(SYNTHETIC_WORLDS.transit_city!, FIXTURE_RESEARCH));

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
    ...fakeProviders(world, FIXTURE_RESEARCH),
    resolver: fixtureProviders().resolver,
  });
}

/**
 * Declare the licences an OSM-derived source would.
 *
 * Without this the fixture journey renders no attribution, and a browser test
 * asserting attribution would be asserting nothing. The fixture stands in for
 * Overpass and Valhalla, so it carries what they carry.
 */
function withOpenLicences(providers: CompilerProviders): CompilerProviders {
  const places = licence('ODbL-1.0', ['places', 'geography']);
  const routing = licence('ODbL-1.0', ['routing']);
  const authored = licence('sidequest-authored', ['descriptions', 'classification', 'scoring']);

  return {
    ...providers,
    places: {
      name: providers.places.name,
      async discover(input) {
        const result = await providers.places.discover(input);
        return { ...result, licences: [places, authored] };
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
