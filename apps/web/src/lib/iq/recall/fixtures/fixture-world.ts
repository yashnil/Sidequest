import {
  geographicScopeSchema,
  type GeographicScope,
  type RegionPack,
} from '@sidequest/core';
import { createOverturePackProvider } from '@/lib/providers/overture/pack';
import type { scanFile } from '@/lib/providers/overture/scan';
import type { CanonicalDestination, CanonicalSubject } from './canonical-subjects';

/**
 * A DENSE METROPOLIS THAT COSTS NOTHING TO COMPILE.
 *
 * The reality arm of the recall gate needs a live artifact and is therefore
 * unavailable in CI. This is the arm that always runs, and its job is to keep
 * the *mechanism* honest: the acquisition path must reach the whole of a
 * destination, not the corner of it whose row groups happened to be first.
 *
 * It is not a mock of the pack. It drives the real
 * `createOverturePackProvider` — the real budget arithmetic, the real
 * `rowGroupAllowanceFor`, the real `retainAcrossCells`, the real normaliser —
 * through the two seams that module already publishes for exactly this
 * (`fetchOptions.fetchImpl` and `scanImpl`). Only the columnar reader and the
 * catalogue documents are fixtures, because those are the parts that cost money
 * and a network.
 *
 * The world's *shape* is copied from the live failure rather than invented:
 *
 * - the destination's canonical experiences are spread across every partition
 *   cell, so a read that stops in one corner loses most of them;
 * - they live in late row groups, because in the real file they do — parquet is
 *   not sorted by significance;
 * - the early row groups are full of well-catalogued commerce with websites,
 *   because that is what a metropolis's places layer is mostly made of, and
 *   because a retention pass that ranked on metadata richness would keep those
 *   and drop the landmarks.
 *
 * Nothing here is Tokyo. The names are invented, the geography is a square in
 * the Atlantic, and the fixture would behave identically for any dense city —
 * which is the §4 requirement that the failure class be closed without
 * destination-specific rules.
 */

/** A square of ocean, so no real geography can accidentally satisfy a test. */
const CENTER = { lat: 12, lng: -30 };
const HALF_SPAN = 0.11;
const BOUNDS = {
  southWest: { lat: CENTER.lat - HALF_SPAN, lng: CENTER.lng - HALF_SPAN },
  northEast: { lat: CENTER.lat + HALF_SPAN, lng: CENTER.lng + HALF_SPAN },
};

/**
 * The subjects, one per cell of a 3×3 partition and then some.
 *
 * Positions are computed rather than written out, so that a change to how the
 * partition divides a scope moves the fixture with it instead of silently
 * leaving half the subjects in one cell.
 */
function subjectGrid(): CanonicalSubject[] {
  const kinds = ['museum', 'sacred_site', 'park', 'landmark', 'market'] as const;
  const subjects: CanonicalSubject[] = [];
  let index = 0;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const kind = kinds[index % kinds.length]!;
      subjects.push({
        id: `fixture-${row}-${col}`,
        name: `${TITLE_OF[kind]} of Quadrant ${row}${col}`,
        aliases: [`Q${row}${col} ${TITLE_OF[kind]}`],
        kind,
        point: {
          lat: BOUNDS.southWest.lat + ((row + 0.5) * (HALF_SPAN * 2)) / 3,
          lng: BOUNDS.southWest.lng + ((col + 0.5) * (HALF_SPAN * 2)) / 3,
        },
        radiusMetres: 400,
        sourceEvidence: 'probed',
      });
      index += 1;
    }
  }
  return subjects;
}

const TITLE_OF: Record<string, string> = {
  museum: 'Museum',
  sacred_site: 'Great Temple',
  park: 'Public Gardens',
  landmark: 'Signal Tower',
  market: 'Covered Market',
};

/** The source's own category for each subject kind, in the catalogue's vocabulary. */
const SOURCE_CATEGORY_OF: Record<string, { primary: string; hierarchy: string[] }> = {
  museum: { primary: 'museum', hierarchy: ['arts_and_entertainment', 'museum'] },
  sacred_site: { primary: 'temple', hierarchy: ['cultural_and_historic', 'temple'] },
  park: { primary: 'park', hierarchy: ['landmark_and_outdoors', 'park'] },
  landmark: { primary: 'monument', hierarchy: ['cultural_and_historic', 'monument'] },
  market: { primary: 'farmers_market', hierarchy: ['retail', 'farmers_market'] },
};

export const FIXTURE_METROPOLIS: CanonicalDestination = {
  id: 'fixture-metropolis',
  shape: 'synthetic dense metropolis (fixture arm)',
  destinationCandidateId: 'fixture:metropolis',
  subjects: subjectGrid(),
};

export function fixtureScope(): GeographicScope {
  return geographicScopeSchema.parse({
    schemaVersion: 1,
    revision: 1,
    destinationCandidateId: FIXTURE_METROPOLIS.destinationCandidateId,
    destinationName: 'Quadrant City',
    destinationEntityType: 'city',
    breadth: 'city',
    center: CENTER,
    bounds: BOUNDS,
    timeZones: ['UTC'],
    shape: { kind: 'bounds', bounds: BOUNDS },
    transport: {
      primaryMode: 'walk',
      allowedModes: ['walk', 'rail'],
      carAvailable: false,
      acceptsWaterOrAirTransfers: true,
      basis: 'default',
      note: 'Fixture transport.',
    },
    maxBaseChanges: 0,
    nights: 4,
    rationale: 'Fixture scope for the canonical recall gate.',
    confidence: { level: 'high', signals: [], note: 'Fixture.' },
    confirmedByUser: true,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** One release, one file per theme, all covering the whole fixture box. */
function catalogueFetch(): typeof fetch {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/catalog.json') && url.includes('2026-07-22.0')) {
      return jsonResponse({
        id: '2026-07-22.0',
        'release:version': '2026-07-22.0',
        'schema:version': null,
        links: [{ rel: 'child', href: './places/catalog.json' }],
      });
    }
    if (url.endsWith('/catalog.json')) {
      return jsonResponse({
        type: 'Catalog',
        id: 'Fixture Releases',
        latest: '2026-07-22.0',
        links: [
          { rel: 'root', href: './catalog.json' },
          { rel: 'child', href: './2026-07-22.0/catalog.json', latest: true },
        ],
      });
    }
    if (url.endsWith('collection.json')) {
      return jsonResponse({ links: [{ rel: 'item', href: './00000/00000.json' }] });
    }
    return jsonResponse({
      bbox: [BOUNDS.southWest.lng - 0.1, BOUNDS.southWest.lat - 0.1, BOUNDS.northEast.lng + 0.1, BOUNDS.northEast.lat + 0.1],
      properties: { 'table:row_count': 1_000_000 },
      assets: {
        /*
         * The real host, because `preferredAsset` refuses any other — a
         * deliberate SSRF guard in the adapter. Nothing is fetched from it: the
         * columnar reader is injected and never opens a socket.
         */
        data: {
          href: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/fixture/part-0.zstd.parquet',
          type: 'application/vnd.apache.parquet',
        },
      },
    });
  };
  return impl as unknown as typeof fetch;
}

interface WorldShape {
  /** Row groups the fake file publishes for the places layer. */
  groups: number;
  /** Rows in each. */
  rowsPerGroup: number;
  /** The first group a canonical subject appears in. */
  firstSubjectGroup: number;
}

const DEFAULT_SHAPE: WorldShape = { groups: 36, rowsPerGroup: 220, firstSubjectGroup: 6 };

/**
 * The fake columnar reader.
 *
 * Publishes noise everywhere and the canonical subjects late, one per group from
 * `firstSubjectGroup` onward, cycling through the grid so that consecutive
 * groups land in different cells. Honours the budget it is handed — row groups,
 * retained ceiling — because the whole point is to observe what the *product's*
 * budget does.
 */
function fixtureScan(shape: WorldShape = DEFAULT_SHAPE): typeof scanFile {
  const subjects = FIXTURE_METROPOLIS.subjects;
  const impl = async <T,>(request: {
    budget: { maxRowGroups: number; maxFeaturesRetained: number };
    counters: { rowGroupsRead: number; rowGroupsInspected: number; featuresRead: number };
    requiredColumns: readonly string[];
    accept: (row: Record<string, unknown>) => T | null;
  }): Promise<{ rows: T[]; counters: unknown; stoppedBecause: string }> => {
    const rows: T[] = [];
    /*
     * Only the places layer is populated. `sources` is required by that layer
     * alone, which is the one stable way to tell the layers apart at this seam
     * without the fixture knowing the provider's internal ordering.
     */
    const isPlaces = request.requiredColumns.includes('sources');
    if (!isPlaces) return { rows, counters: request.counters, stoppedBecause: 'complete' };

    let stoppedBecause = 'complete';
    /* Every group the file publishes is inspected; only some are opened. */
    request.counters.rowGroupsInspected += shape.groups;
    for (let group = 0; group < shape.groups; group += 1) {
      if (request.counters.rowGroupsRead >= request.budget.maxRowGroups) {
        stoppedBecause = 'row_group_budget';
        break;
      }
      if (rows.length >= request.budget.maxFeaturesRetained) {
        stoppedBecause = 'retained_budget';
        break;
      }
      request.counters.rowGroupsRead += 1;
      request.counters.featuresRead += shape.rowsPerGroup;

      /*
       * Groups march west to east and then north, so an early stop is a corner
       * exactly as it is in a real file.
       */
      const band = Math.floor(group / 6);
      const lat = BOUNDS.southWest.lat + 0.01 + band * 0.033;

      for (let index = 0; index < shape.rowsPerGroup; index += 1) {
        const subjectIndex = group - shape.firstSubjectGroup;
        const subject =
          index === 0 && subjectIndex >= 0 ? subjects[subjectIndex % subjects.length] : undefined;
        const category = subject
          ? SOURCE_CATEGORY_OF[subject.kind]!
          : NOISE[index % NOISE.length]!;
        const point = subject
          ? subject.point
          : {
              lat,
              lng: BOUNDS.southWest.lng + 0.005 + ((group % 6) * 0.036 + (index % 18) * 0.002),
            };
        const accepted = request.accept({
          id: subject ? `subject-${subject.id}` : `g${group}-r${index}`,
          names: { primary: subject ? subject.name : `${category.primary} ${group}-${index}` },
          taxonomy: { primary: category.primary, hierarchy: category.hierarchy },
          operating_status: 'open',
          sources: [
            { dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: `r-${group}-${index}` },
          ],
          subtype: category.primary,
          class: category.primary,
          /*
           * Noise publishes a website; the landmarks do not. That is the live
           * condition — a metropolis's places theme carried no knowledge-base
           * link for any of 1,840 records, so "has a website" was most of what
           * standing had left to read — and it is what makes this fixture able
           * to fail if retention ever ranks on metadata again.
           */
          ...(subject ? {} : { websites: [`https://example.invalid/${group}-${index}`] }),
          bbox: { xmin: point.lng, xmax: point.lng, ymin: point.lat, ymax: point.lat },
        });
        if (accepted !== null) rows.push(accepted);
      }
    }
    return { rows, counters: request.counters, stoppedBecause };
  };
  return impl as unknown as typeof scanFile;
}

const NOISE: { primary: string; hierarchy: string[] }[] = [
  { primary: 'mortgage_broker', hierarchy: ['financial_service', 'mortgage_broker'] },
  { primary: 'employment_agency', hierarchy: ['services_and_business', 'employment_agency'] },
  { primary: 'condominium', hierarchy: ['real_estate', 'condominium'] },
  { primary: 'atm', hierarchy: ['financial_service', 'atm'] },
  { primary: 'dentist', hierarchy: ['health_and_medical', 'dentist'] },
  { primary: 'parking', hierarchy: ['transportation', 'parking'] },
];

export interface FixturePackOptions {
  /**
   * The read budget, in row groups.
   *
   * Left at the product default for the gate. Lowered by the mutation test to
   * reproduce the live starvation and prove the gate can fail — which is the
   * only evidence that a passing gate means anything.
   */
  maxRowGroups?: number;
}

export async function buildFixturePack(options: FixturePackOptions = {}): Promise<RegionPack> {
  const provider = createOverturePackProvider({
    fetchOptions: { fetchImpl: catalogueFetch() },
    scanImpl: fixtureScan(),
    now: () => new Date('2026-08-12T00:00:00.000Z'),
    ...(options.maxRowGroups === undefined ? {} : { budget: { maxRowGroups: options.maxRowGroups } }),
  });
  const outcome = await provider.getPack({
    scope: fixtureScope(),
    now: new Date('2026-08-12T00:00:00.000Z'),
  });
  if (outcome.kind === 'unavailable') {
    throw new Error(`fixture pack unavailable: ${outcome.message}`);
  }
  return outcome.pack;
}
