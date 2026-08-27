import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EVERY TRIP DOOR ANSWERS TO THE BROWSER THAT MADE THE TRIP.
 *
 * A review opened `/trips/<id>/itinerary` in an anonymous browser and got the
 * full owner view — "Share this plan", "Make this day easier", the lot — while
 * the board, plan, questionnaire and day-edit server actions enforced no
 * ownership at all. The boundary existed on exactly three doors (list, Remove,
 * Share) and on nothing else, so the address-bar URL was a second, mutable
 * share link beside the deliberate read-only one at `/share/<token>`.
 *
 * These tests drive the real doors — the exported pages and server actions —
 * with a foreign cookie, in the pattern `ownership.test.ts` set: the defect
 * worth guarding against is not "the check exists", it is "the door performs
 * it". Every foreign call must be refused; every owner call must get *past*
 * the ownership guard (whatever it then says about the trip's actual state,
 * which is not this file's subject).
 *
 * The two page outcomes are told apart by digest: `notFound()` throws with a
 * 404 digest, while a live owner page either resolves or throws a redirect.
 * Without the guard a foreign visitor gets exactly the owner's outcome, so
 * every case here fails open — which is how this file was first watched red.
 */

const jar = new Map<string, string>();

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
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

/*
 * The worker launcher, stubbed to launch nothing — same reasoning as
 * `actions.guards.test.ts`: no owner-control case here should reach it, and a
 * unit test must not spawn a compile worker if one ever does.
 */
vi.mock('@/lib/compiler/worker/launch', () => ({
  compilerIsolationMode: () => 'process',
  launchCompilationWorker: () => ({ launched: true }),
}));

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-ownership-boundary-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

const OWNER = 'owner-browser';
const INTRUDER = 'intruder-browser';

const BASICS = {
  mode: 'known_destination' as const,
  destinationInput: 'Harbour City',
  regionId: 'open-world',
  startDate: '2026-09-01',
  endDate: '2026-09-04',
  arrivalTime: '10:00',
  departureTime: '18:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

/** A trip the owner browser made, with enough intent rows for every door. */
async function seededTrip(): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  const repo = await import('@/lib/db/compiler-repository');
  const trip = createTrip(BASICS, OWNER);
  repo.saveDestinationQuery(trip.id, 'known_destination', 'Harbour City');
  return trip.id;
}

/** What a page invocation came to: rendered, redirected, or 404. */
async function outcomeOf(run: () => Promise<unknown>): Promise<'rendered' | 'redirect' | 'not_found'> {
  try {
    await run();
    return 'rendered';
  } catch (error) {
    const digest = String((error as { digest?: string })?.digest ?? '');
    if (digest.includes('404') || digest.includes('NOT_FOUND')) return 'not_found';
    if (digest.includes('NEXT_REDIRECT')) return 'redirect';
    throw error;
  }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('the trip pages, opened by a browser that did not make the trip', () => {
  /**
   * One row per page: the module, and what the *owner* legitimately gets on a
   * freshly seeded trip. The pair is the proof — a guard that refused nobody
   * would give the intruder the owner's outcome, and a guard that refused
   * everybody would fail the owner half.
   */
  const PAGES: { name: string; load: () => Promise<{ default: (input: ReturnType<typeof params>) => Promise<unknown> }>; ownerOutcome: 'rendered' | 'redirect' }[] = [
    { name: 'itinerary', load: () => import('./itinerary/page'), ownerOutcome: 'rendered' },
    { name: 'discover', load: () => import('./discover/page'), ownerOutcome: 'redirect' },
    { name: 'plan', load: () => import('./plan/page'), ownerOutcome: 'redirect' },
    { name: 'questionnaire', load: () => import('./questionnaire/page'), ownerOutcome: 'rendered' },
    { name: 'edit', load: () => import('./edit/page'), ownerOutcome: 'rendered' },
    { name: 'provisional', load: () => import('./provisional/page'), ownerOutcome: 'redirect' },
  ];

  for (const page of PAGES) {
    it(`404s the ${page.name} page for a foreign browser, and not for the owner`, async () => {
      const tripId = await seededTrip();
      const { default: Page } = await page.load();

      jar.set('sidequest_session', INTRUDER);
      expect(await outcomeOf(() => Page(params(tripId)))).toBe('not_found');

      jar.set('sidequest_session', OWNER);
      expect(await outcomeOf(() => Page(params(tripId)))).toBe(page.ownerOutcome);
    });
  }

  it('404s every trip page for a browser with no cookie at all', async () => {
    const tripId = await seededTrip();
    const { default: ItineraryPage } = await import('./itinerary/page');
    expect(await outcomeOf(() => ItineraryPage(params(tripId)))).toBe('not_found');
  });

  it('keeps the destination out of a foreign tab title', async () => {
    const tripId = await seededTrip();
    const { generateMetadata } = await import('./itinerary/page');

    jar.set('sidequest_session', INTRUDER);
    const foreign = await generateMetadata(params(tripId));
    expect(String(foreign.title)).not.toContain('Harbour City');

    jar.set('sidequest_session', OWNER);
    const own = await generateMetadata(params(tripId));
    expect(String(own.title)).toContain('Harbour City');
  });
});

describe('the calendar export, which is a trip page in a file extension', () => {
  it('serves the owner a plan-shaped answer and a stranger a no-such-trip', async () => {
    const tripId = await seededTrip();
    const { GET } = await import('./itinerary/calendar/route');
    const request = new Request(`http://localhost/trips/${tripId}/itinerary/calendar`);

    jar.set('sidequest_session', INTRUDER);
    const foreign = await GET(request, params(tripId));
    expect(foreign.status).toBe(404);
    // Indistinguishable from a trip that does not exist — the id is not an oracle.
    expect(await foreign.text()).toBe('No such trip.');

    jar.set('sidequest_session', OWNER);
    const own = await GET(request, params(tripId));
    // The owner gets the trip's actual state: no plan built yet.
    expect(await own.text()).toContain('No plan has been built');
  });
});

describe('the trip-mutating actions, invoked with a foreign cookie', () => {
  /**
   * Every exported trip-scoped action, one row each. `invoke` calls it exactly
   * as a browser would; the foreign case must come back refused with the shared
   * sentence, and the owner case must get past the ownership guard — asserted
   * as "whatever it said, it was not the ownership refusal".
   */
  type Invocation = (tripId: string) => Promise<{ ok: boolean; error?: string }>;
  const ACTIONS: { name: string; invoke: Invocation }[] = [
    {
      name: 'itinerary/buildItineraryAction',
      invoke: async (id) => (await import('./itinerary/actions')).buildItineraryAction(id),
    },
    {
      name: 'itinerary/removeStopAction',
      invoke: async (id) => (await import('./itinerary/actions')).removeStopAction(id, 1, 'p1'),
    },
    {
      name: 'itinerary/swapAlternativesAction',
      invoke: async (id) => (await import('./itinerary/actions')).swapAlternativesAction(id, 1, 'p1'),
    },
    {
      name: 'itinerary/swapStopAction',
      invoke: async (id) => (await import('./itinerary/actions')).swapStopAction(id, 1, 'p1', 'p2'),
    },
    {
      name: 'itinerary/easeDayAction',
      invoke: async (id) => (await import('./itinerary/actions')).easeDayAction(id, 1),
    },
    {
      name: 'itinerary/toggleLockAction',
      invoke: async (id) => (await import('./itinerary/actions')).toggleLockAction(id, 1, 'p1', true),
    },
    {
      name: 'discover/setSelectionAction',
      invoke: async (id) => (await import('./discover/actions')).setSelectionAction(id, 'p1', 'included'),
    },
    {
      name: 'discover/setFoodSelectionAction',
      invoke: async (id) => (await import('./discover/actions')).setFoodSelectionAction(id, 'v1', 'included'),
    },
    {
      name: 'discover/autoPickAction',
      invoke: async (id) => (await import('./discover/actions')).autoPickAction(id),
    },
    {
      name: 'discover/fillBoardImageryAction',
      invoke: async (id) => (await import('./discover/actions')).fillBoardImageryAction(id),
    },
    {
      name: 'discover/refreshWeatherAction',
      invoke: async (id) => (await import('./discover/actions')).refreshWeatherAction(id),
    },
    {
      name: 'discover/acknowledgeRemovalAction',
      invoke: async (id) => (await import('./discover/actions')).acknowledgeRemovalAction(id, 'p1'),
    },
    {
      name: 'plan/resolveDestinationAction',
      invoke: async (id) => (await import('./plan/actions')).resolveDestinationAction(id),
    },
    {
      name: 'plan/selectInterpretationAction',
      invoke: async (id) => (await import('./plan/actions')).selectInterpretationAction(id, 'c1'),
    },
    {
      name: 'plan/saveClarificationAnswersAction',
      invoke: async (id) => (await import('./plan/actions')).saveClarificationAnswersAction(id, []),
    },
    {
      name: 'plan/proposeScopeAction',
      invoke: async (id) => (await import('./plan/actions')).proposeScopeAction(id),
    },
    {
      name: 'plan/confirmScopeAction',
      invoke: async (id) => (await import('./plan/actions')).confirmScopeAction(id),
    },
    {
      name: 'plan/startCompilationAction',
      invoke: async (id) => (await import('./plan/actions')).startCompilationAction(id),
    },
    {
      name: 'plan/retryCompilationAction',
      invoke: async (id) => (await import('./plan/actions')).retryCompilationAction(id),
    },
    {
      name: 'plan/cancelCompilationAction',
      invoke: async (id) => (await import('./plan/actions')).cancelCompilationAction(id),
    },
    {
      name: 'plan/ensurePreflightAction',
      invoke: async (id) => (await import('./plan/actions')).ensurePreflightAction(id),
    },
    {
      name: 'plan/adoptDateWindowAction',
      invoke: async (id) => (await import('./plan/actions')).adoptDateWindowAction(id, 9, 2026),
    },
    {
      name: 'plan/adoptTripLengthAction',
      invoke: async (id) => (await import('./plan/actions')).adoptTripLengthAction(id, 3),
    },
    {
      name: 'plan/applyStrategyAction',
      invoke: async (id) => (await import('./plan/actions')).applyStrategyAction(id, 'one_area'),
    },
    {
      name: 'plan/reopenPreflightAction',
      invoke: async (id) => (await import('./plan/actions')).reopenPreflightAction(id),
    },
    {
      name: 'plan/decideMustDoAction',
      invoke: async (id) => (await import('./plan/must-do-actions')).decideMustDoAction(id, 'r1', 'left_out'),
    },
    {
      /*
       * Shape-valid answers, because request-shape validation legitimately
       * precedes ownership — a malformed body is refused as malformed for
       * anybody. The guard under test is the one that runs after the parse.
       */
      name: 'questionnaire/saveDraftAction',
      invoke: async (id) => {
        const { defaultAnswers } = await import('@sidequest/core');
        const answers = defaultAnswers({ travelerNeeds: [], tripDays: 3 });
        return (await import('./questionnaire/actions')).saveDraftAction(id, answers);
      },
    },
    {
      name: 'questionnaire/completeQuestionnaireAction',
      invoke: async (id) => {
        const { defaultAnswers } = await import('@sidequest/core');
        const answers = defaultAnswers({ travelerNeeds: [], tripDays: 3 });
        return (await import('./questionnaire/actions')).completeQuestionnaireAction(id, answers);
      },
    },
    {
      name: 'questionnaire/confirmInterpretationAction',
      invoke: async (id) => (await import('./questionnaire/actions')).confirmInterpretationAction(id, []),
    },
    {
      name: 'questionnaire/readUnresolvedTextAction',
      invoke: async (id) => (await import('./questionnaire/actions')).readUnresolvedTextAction(id),
    },
    {
      name: 'provisional/setProvisionalIntentAction',
      invoke: async (id) => (await import('./provisional/actions')).setProvisionalIntentAction(id, 'p1', 'pinned'),
    },
    {
      name: 'new/updateTripFromComposer',
      invoke: async (id) => (await import('../new/actions')).updateTripFromComposer(id, {} as never),
    },
  ];

  for (const action of ACTIONS) {
    it(`refuses ${action.name} for a foreign browser, and not for the owner`, async () => {
      const tripId = await seededTrip();
      const { FOREIGN_TRIP_REFUSAL } = await import('@/lib/net/trip-access');

      jar.set('sidequest_session', INTRUDER);
      const foreign = await action.invoke(tripId);
      expect(foreign.ok, `${action.name} let a foreign browser through`).toBe(false);
      expect(foreign.error).toBe(FOREIGN_TRIP_REFUSAL);

      /*
       * The control: the owner clears the ownership guard. The action may still
       * refuse — an unconfirmed scope, an empty questionnaire — but never with
       * the ownership sentence, which is the one thing this file asserts.
       */
      jar.set('sidequest_session', OWNER);
      const own: { ok: boolean; error?: string } = await action
        .invoke(tripId)
        .catch((error) => {
          // `completeQuestionnaireAction` ends in redirect() on success; a
          // thrown control is a control that got past the guard.
          const digest = String((error as { digest?: string })?.digest ?? '');
          if (digest.includes('NEXT_REDIRECT')) return { ok: true };
          throw error;
        });
      expect(own.error, `${action.name} refused its own maker`).not.toBe(FOREIGN_TRIP_REFUSAL);
    });
  }

  it('answers a foreign poll of the compilation snapshot with nothing', async () => {
    const tripId = await seededTrip();
    const { compilationSnapshotAction } = await import('./plan/actions');

    jar.set('sidequest_session', INTRUDER);
    expect(await compilationSnapshotAction(tripId)).toEqual({
      state: 'none',
      stages: [],
      retryable: false,
    });
  });

  it('refuses a mutating action on a trip that belongs to nobody', async () => {
    const { createTrip } = await import('@/lib/db/repository');
    const unowned = createTrip(BASICS, null).id;
    jar.set('sidequest_session', INTRUDER);

    const { setSelectionAction } = await import('./discover/actions');
    expect((await setSelectionAction(unowned, 'p1', 'included')).ok).toBe(false);
  });
});
