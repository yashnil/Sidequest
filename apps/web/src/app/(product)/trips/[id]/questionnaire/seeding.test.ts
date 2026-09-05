import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE CLARIFICATION'S CAR ANSWER REACHES THE QUESTIONNAIRE.
 *
 * `applyComposer` closed this defect for the composer path: somebody who chose
 * "trains, buses and transfers" on the first screen stopped arriving at the
 * questionnaire with "You will have a car" already ticked. But on the ordinary
 * city journey the composer leaves transport undecided and the car question is
 * asked as a *clarification* ("One thing first") — which `applyComposer` never
 * reads. A live car-free trip ended up with `willDrive: true` in its stored
 * profile while its confirmed scope said `carAvailable: false`: the durable
 * record contradicting itself, and the traveller who had answered "No — public
 * transport" minutes earlier shown a car pre-asserted.
 *
 * This drives the questionnaire page itself — the thing that seeds — because
 * the mapping being right in some helper proves nothing about the screen.
 */

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  /* Outside a request scope: the internal-caller path the ownership boundary documents. */
  cookies: async () => {
    throw new Error('cookies() called outside a request scope');
  },
}));

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-questionnaire-seed-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

async function tripWithClarifiedTransport(carAnswer: 'yes' | 'no'): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  const repo = await import('@/lib/db/compiler-repository');

  const trip = createTrip({
    mode: 'known_destination',
    destinationInput: 'Harbour City',
    regionId: 'open-world',
    startDate: '2026-09-01',
    endDate: '2026-09-06',
    arrivalTime: '10:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  });
  repo.saveDestinationQuery(trip.id, 'known_destination', 'Harbour City');
  /*
   * The composer never answered transport — the state the live defect needs.
   * The car question was asked as a clarification instead, and answered.
   */
  repo.saveClarifications(trip.id, {
    schemaVersion: 1,
    questions: [],
    answers: [
      {
        questionId: 'transport.car-available',
        values: [carAnswer],
        answeredAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  });
  return trip.id;
}

/** The wizard element the page renders, with the props the page computed. */
async function renderedWizardProps(tripId: string): Promise<{
  initialAnswers: { willDrive: boolean; willUseShuttles: boolean };
  prefilled: readonly string[];
}> {
  const { default: QuestionnairePage } = await import('./page');
  const element = (await QuestionnairePage({
    params: Promise.resolve({ id: tripId }),
  })) as unknown as {
    props: {
      initialAnswers: { willDrive: boolean; willUseShuttles: boolean };
      context: { traveller: { carried: readonly string[] } };
    };
  };
  /* The interview names carried fields on its context; `prefilled` is the old name for the same list. */
  return { initialAnswers: element.props.initialAnswers, prefilled: element.props.context.traveller.carried };
}

describe('seeding the questionnaire from the clarification transport answer', () => {
  it('does not tick "you will have a car" for somebody who answered no at the clarification', async () => {
    const tripId = await tripWithClarifiedTransport('no');
    const props = await renderedWizardProps(tripId);

    /*
     * The stored answer set — and with it the derived profile — must agree with
     * what the traveller said, not with `defaultAnswers`' hard-coded car.
     */
    expect(props.initialAnswers.willDrive).toBe(false);
    /* No car means shuttles, buses and feet — same rule `applyComposer` states. */
    expect(props.initialAnswers.willUseShuttles).toBe(true);
    /* Answered, so shown as a confirmable assumption rather than asked again. */
    expect(props.prefilled).toContain('willDrive');
  });

  it('keeps the car for somebody who answered yes at the clarification', async () => {
    const tripId = await tripWithClarifiedTransport('yes');
    const props = await renderedWizardProps(tripId);
    expect(props.initialAnswers.willDrive).toBe(true);
    expect(props.prefilled).toContain('willDrive');
  });

  it('leaves the seed alone when nobody answered anywhere', async () => {
    const { createTrip } = await import('@/lib/db/repository');
    const trip = createTrip({
      mode: 'known_destination',
      destinationInput: 'Harbour City',
      regionId: 'open-world',
      startDate: '2026-09-01',
      endDate: '2026-09-06',
      arrivalTime: '10:00',
      departureTime: '18:00',
      adults: 2,
      children: 0,
      travelerNeeds: [],
    });
    const props = await renderedWizardProps(trip.id);
    /* Silence stays the default, and stays askable: no false provenance badge. */
    expect(props.initialAnswers.willDrive).toBe(true);
    expect(props.prefilled).not.toContain('willDrive');
  });
});
