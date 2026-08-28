import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* The home page reads the visitor's cookie to list their own trips. */
const jar = new Map<string, string>([['sidequest_session', 'owner-token']]);
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('../../app/(product)/actions', () => ({ deleteTripAction: async () => ({ ok: true }) }));

/**
 * TWO ROWS ANSWER "DOES THIS TRIP HAVE A BOARD", AND THE LIST READ THE WRONG ONE.
 *
 * `compilation_jobs.compiled_region_id` records what a build produced.
 * `trip_intents.selected_compiled_region_id` records what the trip currently
 * stands on. `invalidateDependentStages` clears the second when an edit moves
 * the ground under it, and deliberately leaves the first — a job is a record of
 * work done, and editing a trip does not un-do it.
 *
 * The trip list read the job. So after an ordinary edit — change the dates on a
 * trip whose region was already built — the row still said "Places found" and
 * linked to `/discover`, which resolves the *adopted* region, finds none, and
 * renders "We cannot find that trip. The link may be old, or the trip may have
 * been removed." over a trip that was neither. That page links only to the home
 * page and a new trip, so the row looped.
 *
 * Driven through the real repository writes rather than a stubbed row, because
 * the defect is the disagreement between two real columns.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-adopted-region-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

async function tripWithAdoptedRegion() {
  const { createTrip } = await import('./repository');
  const { saveDestinationQuery, saveSelectedCompiledRegion, adoptedCompiledRegionId } =
    await import('./compiler-repository');
  const trip = createTrip({
    mode: 'known_destination',
    destinationInput: 'Harbour City',
    regionId: 'dynamic',
    startDate: '2026-09-01',
    endDate: '2026-09-05',
    arrivalTime: '10:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  }, 'owner-token');
  saveDestinationQuery(trip.id, 'known_destination', 'Harbour City');
  saveSelectedCompiledRegion(trip.id, 'region-harbour-1');
  expect(adoptedCompiledRegionId(trip.id)).toBe('region-harbour-1');
  return trip.id;
}

describe('what the trip list asks about a trip that has been edited', () => {
  it('sees the adopted region while the trip still stands on one', async () => {
    /* The witness: without this the assertion below could pass on an empty db. */
    const tripId = await tripWithAdoptedRegion();
    const { adoptedCompiledRegionId } = await import('./compiler-repository');
    expect(adoptedCompiledRegionId(tripId)).not.toBeNull();
  });

  it('sees no region once an edit has cleared what the trip stood on', async () => {
    const tripId = await tripWithAdoptedRegion();
    const { adoptedCompiledRegionId, invalidateDependentStages } = await import(
      './compiler-repository'
    );

    const cleared = invalidateDependentStages(tripId, {
      destinationChanged: false,
      datesChanged: true,
      scopeInputsChanged: false,
    });
    expect(cleared).toContain('build');

    /*
     * The whole finding, in one line: this is what `/discover` will resolve, so
     * this is what the row that links there has to be built from.
     */
    expect(adoptedCompiledRegionId(tripId)).toBeNull();
  });

  it('reports the row as pre-board rather than as a board to open', async () => {
    /*
     * The traveller-facing end of it, through the same function the page uses.
     */
    const tripId = await tripWithAdoptedRegion();
    const { adoptedCompiledRegionId, invalidateDependentStages } = await import(
      './compiler-repository'
    );
    const { tripProgress } = await import('../format/trip-progress');

    invalidateDependentStages(tripId, {
      destinationChanged: false,
      datesChanged: true,
      scopeInputsChanged: false,
    });

    const progress = tripProgress({
      status: 'profiled',
      jobState: 'ready',
      jobLive: false,
      hasCompiledRegion: adoptedCompiledRegionId(tripId) !== null,
      hasItinerary: false,
    });
    expect(progress.state).not.toBe('board_ready');
    expect(progress.path(tripId)).not.toContain('/discover');
  });

  it('renders the row from the adopted region, on the real page', async () => {
    /**
     * The mutation `hasCompiledRegion: Boolean(job?.compiledRegionId)` lives on
     * the page, so the assertion has to run the page. Everything above tests
     * the rule; this tests that the screen asks it.
     */
    const tripId = await tripWithAdoptedRegion();
    const { invalidateDependentStages, startJob } = await import('./compiler-repository');
    const { getDb } = await import('./client');
    const { saveProfile } = await import('./repository');
    const { buildTravelerProfile, defaultAnswers } = await import('@sidequest/core');

    /* A finished build, recorded on the job row exactly as a real one would be. */
    const answers = defaultAnswers({ travelerNeeds: [], tripDays: 4 });
    saveProfile(tripId, answers, buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 4 }));

    /*
     * A finished build, as one is left on disk: the job row keeps the region it
     * produced. That is the row the page used to read, and it is the whole
     * point — the two columns have to be able to disagree for this to assert
     * anything.
     */
    const started = startJob({ tripId, scopeFingerprint: 'fp-1', now: new Date('2026-08-11T09:00:00.000Z') });
    const jobId = started.job.id;
    getDb()
      .prepare("UPDATE compilation_jobs SET state = 'ready', compiled_region_id = ? WHERE id = ?")
      .run('region-harbour-1', jobId);

    invalidateDependentStages(tripId, {
      destinationChanged: false,
      datesChanged: true,
      scopeInputsChanged: false,
    });

    const HomePage = (await import('../../app/(product)/page')).default;
    const markup = renderToStaticMarkup(await HomePage());

    expect(markup).toContain('Harbour City');
    expect(markup, 'an edited trip must not be linked to a board it no longer has').not.toContain(
      `/trips/${tripId}/discover`,
    );
  });
});
