import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planTrip } from '@sidequest/planner';
import type { Itinerary } from '@sidequest/core';
import { AUGUST_BASICS, buildScenario } from '../../../../../packages/planner/src/testing/scenario';

/**
 * V9 §24 — THE SHARED COPY CARRIES NO PRIVATE FACT.
 *
 * The share page is rendered here exactly as a reader with a link gets it,
 * over a trip whose owner has written down everything that must not travel:
 * a confirmation reference, a cost, a note, a payment state and a link on a
 * booking; a pending confirmation import; the traveller's own words on a
 * decision and on a skipped booking; a companion's private notes. The
 * markup is then searched for each. The strip happens at the door
 * (`strip.ts`), so no render branch can leak what it is never handed — and
 * the freshness banner, which can spend a request, is never mounted on the
 * shared copy at all.
 */

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  notFound: () => {
    const error = new Error('NEXT_NOT_FOUND') as Error & { digest: string };
    error.digest = 'NEXT_HTTP_ERROR_FALLBACK;404';
    throw error;
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => {
    throw new Error('the share page reads no cookie');
  },
}));
/* The per-stop menu lives beside the server actions it calls; nothing below presses anything. */
vi.mock('@/app/(product)/trips/[id]/itinerary/edit-controls', () => ({ EaseDayButton: () => null, PrintExpand: () => null, StopEditMenu: () => null }));
vi.mock('@/components/PrintButton', () => ({ PrintButton: () => null }));

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-share-privacy-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_WEATHER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
  delete process.env.SIDEQUEST_WEATHER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

const PLAN: Itinerary = (() => {
  const result = planTrip(buildScenario());
  if (!result.ok) throw new Error(`the fixture scenario did not plan: ${result.code}`);
  return result.itinerary;
})();

/** Every string below is unique enough that finding it in the markup means it leaked. */
const SECRETS = {
  confirmationRef: 'QX7-REF-4419-ZZ',
  bookingNotes: 'ask for the quiet room at the back — private note',
  bookingUrl: 'https://booking.example.invalid/reservation/QX7',
  cost: '1234.56',
  importRef: 'IMPORT-REF-88AB',
  importTitle: 'Pending import title Zebra Lodge',
  decisionWhy: 'because Mum cannot do the second drive — decision note',
  resolutionNote: 'we skipped this because my brother is scared of boats',
  partyNotes: 'gets migraines after long drives — party private note',
  travelerName: 'Cousin Ravindra',
};

async function seedSharedTrip(): Promise<{ tripId: string; token: string }> {
  const { createTrip, saveItinerary, ensureShareToken } = await import('@/lib/db/repository');
  const trip = createTrip(AUGUST_BASICS, 'owner-browser');
  saveItinerary({ ...PLAN, tripId: trip.id });

  const { addBookedItem } = await import('@/lib/db/intelligence-repository');
  addBookedItem(trip.id, { type: 'lodging', title: 'Sierra Pines Lodge', date: PLAN.days[0]!.date, endDate: PLAN.days[3]!.date, confirmationRef: SECRETS.confirmationRef, notes: SECRETS.bookingNotes, url: SECRETS.bookingUrl, cost: { amount: 1234.56, currency: 'USD' }, status: 'booked', paid: 'deposit', refundable: 'non_refundable', source: 'imported', replaces: 'The suggested motel', bookingItemId: 'need-lodging-1' } as Parameters<typeof addBookedItem>[1]);

  const { recordImport, recordDecision, setBookingResolution } = await import('@/lib/db/execution-repository');
  recordImport(trip.id, { sourceKind: 'text', modelUsed: false, extracted: { type: 'lodging', typeConfidence: 'high', title: SECRETS.importTitle, confirmationRef: SECRETS.importRef, fields: [], gaps: [] } });
  recordDecision(trip.id, { key: 'route', chosen: 'One base', why: SECRETS.decisionWhy, lock: 'user_explicit', decidedBy: 'traveller' });
  setBookingResolution(trip.id, { bookingItemId: 'need-ferry-1', resolution: 'skipped', note: SECRETS.resolutionNote });

  const { createTraveler, setPartyMember } = await import('@/lib/db/party-repository');
  const traveler = createTraveler(
    { userId: null, ownerToken: 'owner-browser' },
    { displayName: SECRETS.travelerName, diet: { needs: [], strict: false, allergyCrossContamination: false }, needs: ['avoid_steep_descents'], needsNotes: SECRETS.partyNotes, profile: { interests: {}, transportComfort: [], lodgingNeeds: [] }, privacy: { hideFromPrint: false } },
  );
  setPartyMember({ tripId: trip.id, travelerId: traveler.id, role: 'other', preferencesApply: true, constraintsApply: true, participation: 'described', position: 0 });

  const token = ensureShareToken(trip.id);
  if (!token) throw new Error('no share token');
  return { tripId: trip.id, token };
}

async function renderShare(token: string): Promise<string> {
  const { default: SharedTripPage } = await import('./[token]/page');
  const element = await SharedTripPage({ params: Promise.resolve({ token }) });
  return renderToStaticMarkup(createElement(() => element as React.ReactElement));
}

describe('the shared copy of a plan', () => {
  it('renders the plan and none of the owner’s private facts', async () => {
    const { token } = await seedSharedTrip();
    const html = await renderShare(token);
    expect(html.length).toBeGreaterThan(1000);
    /* The booking itself may show as a fact of the trip; nothing the owner wrote or paid may. */
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(html.includes(secret), `${name} reached the shared markup`).toBe(false);
    }
    for (const word of ['deposit', 'non_refundable', 'Non-refundable', 'need-lodging-1', 'The suggested motel']) {
      expect(html.includes(word), `${word} reached the shared markup`).toBe(false);
    }
  });

  it('never mounts the freshness banner, which is the one surface that can spend a request', async () => {
    const { tripId, token } = await seedSharedTrip();
    const { recordObservations } = await import('@/lib/db/execution-repository');
    recordObservations(tripId, [{ factId: 'fact:forecast:2', kind: 'forecast', observedAt: '2026-08-01T12:00:00.000Z', previous: 'dry', current: 'rain', changed: true, dayNumbers: [2], summary: 'Day 2 now expects rain; it was dry when the plan was built. OBSERVATION-SENTINEL' }]);
    const html = await renderShare(token);
    expect(html).not.toContain('freshness-banner');
    expect(html).not.toContain('freshness-change');
    expect(html).not.toContain('OBSERVATION-SENTINEL');
    expect(html).not.toContain('import-center');
    expect(html).not.toContain('ledger-committed');
  });

  it('strips at the door: the model handed to the render carries none of the private fields', async () => {
    const { tripId, token } = await seedSharedTrip();
    const { tripForShareToken, getItinerary } = await import('@/lib/db/repository');
    const { itineraryViewModel } = await import('@/app/(product)/trips/[id]/itinerary/view-model');
    const { stripForShare } = await import('./[token]/strip');
    const trip = tripForShareToken(token)!;
    const model = await itineraryViewModel(trip, getItinerary(tripId)!);
    const shared = stripForShare(model);
    expect(shared.booked).toHaveLength(1);
    const item = shared.booked[0]! as Record<string, unknown>;
    for (const key of ['confirmationRef', 'notes', 'cost', 'url', 'paid', 'refundable', 'bookingItemId', 'replaces', 'source']) expect(item, `${key} survived the strip`).not.toHaveProperty(key);
    expect(shared.pendingImports).toEqual([]);
    expect(shared.ledger.lines).toEqual([]);
    expect(shared.ledger.committed).toBeNull();
    expect(shared.resolutions.every((r) => !('note' in r))).toBe(true);
    expect(shared.decisions.every((d) => !JSON.stringify(d).includes(SECRETS.decisionWhy))).toBe(true);
    expect(shared.observations).toEqual([]);
    expect(shared.readinessProfile).toBeNull();
    expect(JSON.stringify(shared)).not.toContain(SECRETS.partyNotes);
  });

  it('a revoked link is a 404, and the new link after a rotation opens while the old one does not', async () => {
    const { token } = await seedSharedTrip();
    const { revokeShareToken, rotateShareToken, tripForShareToken } = await import('@/lib/db/repository');
    const tripId = tripForShareToken(token)!.id;
    revokeShareToken(tripId);
    await expect(renderShare(token)).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    const fresh = rotateShareToken(tripId)!;
    expect((await renderShare(fresh)).length).toBeGreaterThan(1000);
    await expect(renderShare(token)).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });
});

/**
 * V1 CONVERGENCE — EVERY PRIVATE SURFACE AT ONCE, AND NO MACHINERY.
 *
 * The owner has filled in everything a traveller can: a companion with a
 * strict diet, an allergy and private words; a nationality that is not the
 * default; the interview's free-text answers. The shared markup is searched
 * for each, and for the names of Sidequest's own machinery — provider names,
 * environment variables, the fixture switch, build-failure references — which
 * belong in logs and never on a page a stranger can open.
 */
const OWNER_WORDS = {
  dietNotes: 'DIET-SENTINEL no sesame at all please',
  privateNotes: 'PRIVATE-SENTINEL recovering from knee surgery',
  dietaryNotes: 'ANSWER-SENTINEL I only eat at places with outdoor seating',
  accessibilityNotes: 'ANSWER-SENTINEL-ACCESS two flights of stairs is my limit',
  groupNotes: 'ANSWER-SENTINEL-GROUP my sister and I are not speaking',
  hardNotes: 'ANSWER-SENTINEL-HARD back at the hotel by nine for the baby',
  preferenceNote: 'ANSWER-SENTINEL-PREF I am very fit but hate early starts',
};

async function seedEveryPrivateSurface(): Promise<{ tripId: string; token: string }> {
  const seeded = await seedSharedTrip();
  const { tripId } = seeded;
  const { createTraveler, setPartyMember } = await import('@/lib/db/party-repository');
  const companion = createTraveler(
    { userId: null, ownerToken: 'owner-browser' },
    { displayName: 'Companion Sentinel', diet: { needs: ['nut_allergy', 'kosher'], strict: true, allergyCrossContamination: true, notes: OWNER_WORDS.dietNotes }, needs: ['step_free_access'], privateNotes: OWNER_WORDS.privateNotes, profile: { interests: {}, transportComfort: [], lodgingNeeds: [] }, privacy: { hideFromPrint: false } },
  );
  setPartyMember({ tripId, travelerId: companion.id, role: 'other', preferencesApply: true, constraintsApply: true, participation: 'described', position: 1 });

  const { saveReadinessProfile } = await import('@/lib/db/intelligence-repository');
  saveReadinessProfile(tripId, { citizenship: 'IN', residence: 'IN', drivingLicenceCountry: 'IN', transitCountries: [] });

  const { defaultAnswers, buildTravelerProfile } = await import('@sidequest/core');
  const context = { travelerNeeds: [], tripDays: PLAN.days.length };
  const answers = {
    ...defaultAnswers(context),
    dietaryNeeds: ['kosher'],
    dietaryNotes: OWNER_WORDS.dietaryNotes,
    accessibilityNotes: OWNER_WORDS.accessibilityNotes,
    groupNotes: OWNER_WORDS.groupNotes,
    hardNotes: OWNER_WORDS.hardNotes,
    preferenceNotes: { pace: OWNER_WORDS.preferenceNote },
  } as Parameters<typeof buildTravelerProfile>[0];
  const { saveProfile } = await import('@/lib/db/repository');
  saveProfile(tripId, answers, buildTravelerProfile(answers, context));
  return seeded;
}

describe('the shared copy, with every private surface filled in', () => {
  it('carries no party diet or accessibility fact, no nationality, and none of the traveller’s free-text answers', async () => {
    const { tripId, token } = await seedEveryPrivateSurface();
    /* The owner's own view is built first, so an owner-only snapshot exists for the share to (wrongly) copy. */
    const { tripForShareToken, getItinerary } = await import('@/lib/db/repository');
    const { itineraryViewModel } = await import('@/app/(product)/trips/[id]/itinerary/view-model');
    const ownerModel = await itineraryViewModel(tripForShareToken(token)!, getItinerary(tripId)!);
    /* The control: the owner's own model does name the nationality, so its absence below is the strip working. */
    expect(JSON.stringify(ownerModel)).toContain('India');

    const html = await renderShare(token);
    expect(html.length).toBeGreaterThan(1000);
    for (const [name, secret] of Object.entries(OWNER_WORDS)) {
      expect(html.includes(secret), `${name} reached the shared markup`).toBe(false);
    }
    for (const fact of ['Companion Sentinel', 'Nut allergy', 'Kosher', 'kosher', 'step-free', 'Step-free', 'India', 'Indian', 'passport holders']) {
      expect(html.includes(fact), `${fact} reached the shared markup`).toBe(false);
    }
  });

  it('names none of Sidequest’s machinery: providers, environment variables, the fixture switch or failure references', async () => {
    const { token } = await seedEveryPrivateSurface();
    const html = await renderShare(token);
    /*
     * Visible text only: class names and test ids are markup, not words a reader sees.
     * A data provider's own attribution (the weather source, a places licence) is a
     * required credit and stays; this test runs on the offline weather provider, whose
     * attribution says so, which is why a bare "fixture" is not searched for.
     */
    const text = html.replace(/<[^>]+>/g, ' ');
    /* The dev-only badge is a test id, so it is checked in the markup itself. */
    expect(html).not.toContain('fixture-planning-badge');
    expect(html).not.toContain('environment-pill');
    for (const pattern of [/google[-_ ]?places/i, /\bSIDEQUEST_[A-Z_]+/, /fixture (planning|composer)/i, /\bANTHROPIC\b/, /\bopenrouteservice\b/i, /\bvalhalla\b/i, /failure ref/i, /quote this reference/i, /\bstack\b/i]) {
      expect(pattern.test(text), `${pattern} appeared in the shared page's text`).toBe(false);
    }
  });
});
