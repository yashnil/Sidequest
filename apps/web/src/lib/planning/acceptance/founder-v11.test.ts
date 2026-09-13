import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assessLegPlausibility,
  buildNextActions,
  buildReadinessPacket,
  buildTripQualityReport,
  countryFacts,
  deriveChapters,
  normalizeStays,
  readinessShortfalls,
  selectSignatureExperiences,
  type EpisodeInput,
  type SignatureCandidate,
  type StayInput,
  type TransportMode,
  type TripStateGraph,
} from '@sidequest/core';

/**
 * THE TWO V11 FOUNDER CASES — THE PERMANENT FAILURE MATRIX.
 *
 * §1 of the V11 brief: "The two production founder cases must become permanent
 * regression fixtures." These are those. Every figure in `cases.json` is quoted
 * from the traveller-facing PDF the founder exported on 2026-09-12, or derived
 * in `V11-FOUNDER-AUDIT.md` with the derivation shown.
 *
 * This file is deliberately NOT a full replay through the orchestrator — the
 * trips' database rows are not on this machine, so a replay would be a replay of
 * something invented. It is the failure matrix: each defect the traveller
 * actually met, driven through the deterministic module that now prevents it.
 * Every count below must be zero.
 */

interface Measurement {
  label: string;
  minutes: number;
  km: number;
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  mode: TransportMode;
  mustBeRefused: boolean;
}

interface Case {
  tripId: string;
  countryCode: string;
  archetype: 'road_trip' | 'guided_remote';
  bases: StayInput[];
  episodes: EpisodeInput[];
  signatureCandidates: SignatureCandidate[];
  statedSignatures?: string[];
  travellerInterests: string[];
  travellerWantsEffort: boolean;
  shippedSignatures: string[];
  incidentalSignaturesShipped: string[];
  legitimateSignaturesShipped: string[];
  shippedHotelChanges?: number;
  shippedBaseCount?: number;
  completeness: Parameters<typeof readinessShortfalls>[0]['completeness'];
  measurements: Measurement[];
  jurisdictionSentencesShipped?: string[];
}

const cases = JSON.parse(readFileSync(new URL('./fixtures/founder-v11/cases.json', import.meta.url), 'utf8')) as { rockies: Case; kyrgyzstan: Case };

/* ------------------------------------------------------------------ */
/* The matrix                                                          */
/* ------------------------------------------------------------------ */

/**
 * A minimal graph holding one Sidequest-owned dependency per shortfall plus one
 * genuine traveller decision, so §39 is tested on the path that produced the
 * defect rather than on the classifier alone. The traveller's own item must
 * still come through: silencing everything would be a different bug.
 */
function graphOf(details: readonly string[]): TripStateGraph {
  const nodes = [
    ...details.map((detail, index) => ({
      id: `dependency:sidequest:${index}`,
      kind: 'dependency' as const,
      label: detail,
      state: 'needs_decision' as const,
      source: 'sidequest' as const,
      owner: 'sidequest' as const,
      confidence: 'high' as const,
      impact: 'days' as const,
      href: '#before-you-go',
      dependsOn: [],
      scope: { dayNumbers: [], baseIds: [] },
      detail: 'Sidequest is still working this out; nothing for you to do yet.',
    })),
    {
      id: 'dependency:traveller:0',
      kind: 'dependency' as const,
      label: 'Choose which airport you fly into',
      state: 'needs_decision' as const,
      source: 'sidequest' as const,
      owner: 'traveller' as const,
      confidence: 'high' as const,
      impact: 'trip' as const,
      href: '#getting-around',
      dependsOn: [],
      scope: { dayNumbers: [], baseIds: [] },
      detail: 'The plan cannot do without this.',
    },
  ];
  return { version: 1, nodes, counts: {} as TripStateGraph['counts'], dependents: {}, summary: '' } as TripStateGraph;
}

function failureMatrix(input: Case) {
  const structure = normalizeStays({ bases: input.bases, episodes: input.episodes });
  const signatures = selectSignatureExperiences({
    candidates: input.signatureCandidates,
    ...(input.statedSignatures ? { statedSignatures: input.statedSignatures } : {}),
    travellerInterests: input.travellerInterests,
    travellerWantsEffort: input.travellerWantsEffort,
  });
  const shortfalls = readinessShortfalls({ archetype: input.archetype, completeness: input.completeness });

  return {
    /* §3 — a measurement no journey takes, reaching the traveller. */
    implausibleMeasurementsAccepted: input.measurements.filter((m) => m.mustBeRefused && assessLegPlausibility(m).ok).length,
    /* §3 — a real measurement wrongly refused. Both directions matter. */
    goodMeasurementsRefused: input.measurements.filter((m) => !m.mustBeRefused && !assessLegPlausibility(m).ok).length,
    /* §5 — two consecutive stays that are the same place. */
    consecutiveDuplicateStays: structure.stays.filter((stay, index) => index > 0 && stay.name === structure.stays[index - 1]!.name).length,
    /* §5 — a night an operator owns, counted as the traveller changing hotel. */
    experienceNightsCountedAsChurn: structure.stays.filter((stay) => stay.withinExperience && stay.countsAsHotelChange).length,
    /*
     * §7 — an INCIDENTAL experience still named as one of the three the trip is
     * built around. Not "anything the old list contained": two of the Rockies'
     * three (Lake Louise, Moraine Lake) are perfectly good answers and keeping
     * them is not a defect. What was wrong was a 90-minute riverside walk taken
     * to fill the arrival evening, and three orientation stops on a trek.
     */
    incidentalSignaturesKept: signatures.filter((signature) => input.incidentalSignaturesShipped.includes(signature.name)).length,
    /* §4 — a trip calling itself ready while its route-critical set is incomplete. */
    readyDespiteShortfalls: shortfalls.length === 0 ? 1 : 0,
    /*
     * §39 — an item of Sidequest's own work reaching the traveller's action list.
     *
     * Driven through the real `buildNextActions`, over a graph built from these
     * shortfalls, rather than asserted against the classifier in the abstract:
     * the founder's three DECIDE items were produced by exactly this path.
     */
    ourWorkAsTravellerDecision: buildNextActions({
      graph: graphOf(shortfalls.map((shortfall) => shortfall.detail)),
      lifecycle: 'planning',
      daysUntilTrip: 300,
      now: new Date('2026-09-13T00:00:00Z'),
      limit: 10,
    }).actions.filter((action) => action.nodeId.startsWith('dependency:sidequest')).length,
    structure,
    signatures,
    shortfalls,
  };
}

describe('V11 founder case — Canadian Rockies (a14459b9), which called itself "Ready, with cautions"', () => {
  const input = cases.rockies;
  const matrix = failureMatrix(input);

  it('the failure matrix is all zeros', () => {
    expect({
      implausibleMeasurementsAccepted: matrix.implausibleMeasurementsAccepted,
      goodMeasurementsRefused: matrix.goodMeasurementsRefused,
      consecutiveDuplicateStays: matrix.consecutiveDuplicateStays,
      experienceNightsCountedAsChurn: matrix.experienceNightsCountedAsChurn,
      incidentalSignaturesKept: matrix.incidentalSignaturesKept,
      readyDespiteShortfalls: matrix.readyDespiteShortfalls,
      ourWorkAsTravellerDecision: matrix.ourWorkAsTravellerDecision,
    }).toEqual({
      implausibleMeasurementsAccepted: 0,
      goodMeasurementsRefused: 0,
      consecutiveDuplicateStays: 0,
      experienceNightsCountedAsChurn: 0,
      incidentalSignaturesKept: 0,
      readyDespiteShortfalls: 0,
      ourWorkAsTravellerDecision: 0,
    });
  });

  it('§3 — the base placed 200 km away is caught by the leg it produced, not by a name', () => {
    /* Field → Emerald Lake: 6.1 km apart, reported as 208 km of road. */
    const emerald = input.measurements.find((m) => m.label.includes('Emerald Lake'))!;
    const verdict = assessLegPlausibility(emerald);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('distance_exceeds_geometry');
  });

  it('§3 — and the ordinary drives on the same trip are untouched', () => {
    const banffToLouise = input.measurements.find((m) => m.label.includes('Lake Louise'))!;
    expect(assessLegPlausibility(banffToLouise).ok).toBe(true);
  });

  it('§3 — the documented LIMIT of the plausibility guard, pinned rather than glossed', () => {
    /*
     * Jasper → Field came back as 403 km in 313 minutes: 77 km/h over a 2.05x
     * detour ratio. Nothing about that arithmetic is impossible, and it is wrong
     * only because the destination point is 200 km from the village it names. A
     * speed gate cannot catch this class and must not pretend to; what catches
     * it is placement (§41) and the signature/route-critical completeness gate
     * that then refuses to call the trip Ready.
     */
    const jasperToField = input.measurements.find((m) => m.label.includes('Jasper → Field'))!;
    expect(assessLegPlausibility(jasperToField).ok).toBe(true);
    expect(matrix.shortfalls.map((shortfall) => shortfall.requirement)).toContain('route_critical_placed');
  });

  it('§7 — the trip is no longer built around a riverside stroll taken to fill the arrival evening', () => {
    const names = matrix.signatures.map((signature) => signature.name);
    expect(names).not.toContain('Bow Falls');
    expect(names).toContain('Plain of Six Glaciers Trail');
    /* And the two that were always good answers are still allowed to be answers. */
    expect(names.some((name) => input.legitimateSignaturesShipped.includes(name))).toBe(true);
  });

  it('§4 — it does not call itself ready with 12 of 24 route-critical names unplaced and a signature with no position', () => {
    expect(matrix.shortfalls.map((shortfall) => shortfall.requirement)).toEqual(expect.arrayContaining(['route_critical_placed', 'signatures_placed', 'access_requirements', 'route_order']));
  });

  it('§11 — every jurisdiction sentence the founder saw now names Canada', () => {
    const { packet } = buildReadinessPacket({
      destinationName: 'canadian rockies',
      destinationCountry: 'CA',
      destinationFacts: countryFacts('CA'),
      tripStart: '2027-08-05',
      tripEnd: '2027-08-15',
      drives: true,
      remote: true,
      strenuous: true,
      water: false,
      now: new Date('2026-09-13T00:00:00Z'),
    });
    const prose = packet.entries.map((entry) => `${entry.summary} ${entry.action ?? ''}`).join(' ');
    for (const shipped of input.jurisdictionSentencesShipped ?? []) expect(prose).not.toContain(shipped);
    expect(prose).toContain('Canada uses the CAD');
  });
});

describe('V11 founder case — Kyrgyzstan (082fc0ad), seven bases and an 87-hour drive', () => {
  const input = cases.kyrgyzstan;
  const matrix = failureMatrix(input);

  it('the failure matrix is all zeros', () => {
    expect({
      implausibleMeasurementsAccepted: matrix.implausibleMeasurementsAccepted,
      goodMeasurementsRefused: matrix.goodMeasurementsRefused,
      consecutiveDuplicateStays: matrix.consecutiveDuplicateStays,
      experienceNightsCountedAsChurn: matrix.experienceNightsCountedAsChurn,
      incidentalSignaturesKept: matrix.incidentalSignaturesKept,
      readyDespiteShortfalls: matrix.readyDespiteShortfalls,
      ourWorkAsTravellerDecision: matrix.ourWorkAsTravellerDecision,
    }).toEqual({
      implausibleMeasurementsAccepted: 0,
      goodMeasurementsRefused: 0,
      consecutiveDuplicateStays: 0,
      experienceNightsCountedAsChurn: 0,
      incidentalSignaturesKept: 0,
      readyDespiteShortfalls: 0,
      ourWorkAsTravellerDecision: 0,
    });
  });

  it('§3 — 434 km in 5209 minutes never reaches a traveller again', () => {
    const leg = input.measurements.find((m) => m.label.includes('Bishkek'))!;
    const verdict = assessLegPlausibility(leg);
    expect(verdict.ok).toBe(false);
    expect(verdict.impliedKmh).toBeCloseTo(5, 1);
  });

  it('§3 — and the same journey at six hours is accepted, so the guard is not a blanket refusal', () => {
    expect(assessLegPlausibility(input.measurements.find((m) => m.label.startsWith('A real'))!).ok).toBe(true);
  });

  it('§5 — "You move from Karakol to Karakol" is not expressible', () => {
    const names = matrix.structure.stays.map((stay) => stay.name);
    expect(names).toEqual(['Bishkek', 'Karakol', 'Ala-Kul trek (camp)', 'Karakol', 'Song-Kol', 'Bishkek']);
    expect(matrix.structure.collapsed).toHaveLength(1);
  });

  it('§5 — six hotel changes become three, and every night is still there', () => {
    expect(input.shippedHotelChanges).toBe(6);
    expect(matrix.structure.hotelChanges).toBe(3);
    expect(matrix.structure.stays.reduce((total, stay) => total + stay.nights, 0)).toBe(10);
  });

  it('§7 — the trip is built around the trek and the yurt expedition, not two markets and a lake view', () => {
    const names = matrix.signatures.map((signature) => signature.name);
    for (const shipped of input.incidentalSignaturesShipped) expect(names).not.toContain(shipped);
    expect(names.some((name) => name.startsWith('Ala-Kul'))).toBe(true);
    expect(names.some((name) => name.startsWith('Song-Kol') || name === 'Jailoo horseback ride')).toBe(true);
  });

  it('§6 — the eleven days read as chapters, with each expedition as one', () => {
    const chapters = deriveChapters({
      days: Array.from({ length: 11 }, (_, index) => ({ dayNumber: index + 1, baseId: input.bases[Math.min(index, input.bases.length - 1)]!.id, items: [], intensity: 'moderate', totals: { strenuousCount: 0, driveMinutes: 0, transitMinutes: 0, unverifiedMinutes: 0 } })) as unknown as Parameters<typeof deriveChapters>[0]['days'],
      stays: matrix.structure.stays,
      episodes: input.episodes,
    });
    const expeditions = chapters.filter((chapter) => chapter.role === 'expedition');
    expect(expeditions.map((chapter) => chapter.title)).toEqual(['Ala-Kul & Altyn-Arashan trek', 'Song-Kol yurt stay']);
    expect(chapters.flatMap((chapter) => chapter.dayNumbers)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('§2 — the quality report would have caught this trip before the traveller did', () => {
    const shipped = normalizeStays({ bases: input.bases, episodes: [] });
    const report = buildTripQualityReport({
      itinerary: { days: [], package: undefined, transportStrategy: { primaryMode: 'private_transfer' } } as unknown as Parameters<typeof buildTripQualityReport>[0]['itinerary'],
      stays: shipped.stays,
      completeness: input.completeness,
      transport: { declared: 'private_transfer', used: ['private_transfer', 'walk', 'public_bus', 'four_wheel_drive'] },
    });
    expect(report.weak).toEqual(expect.arrayContaining(['baseEfficiency', 'transportConsistency', 'measurementIntegrity', 'routeCriticalPlacement']));
  });
});

describe('V11 §39 — silencing our own work does not silence the traveller’s', () => {
  /*
   * The other half of the guarantee. Dropping every Sidequest-owned node would
   * also satisfy the matrix above, and would be a worse product than the one
   * the founder saw: a real choice — which airport, which operator — has to keep
   * reaching the traveller.
   */
  it('a genuine decision still comes through', () => {
    const actions = buildNextActions({
      graph: graphOf(['Something Sidequest is still placing']),
      lifecycle: 'planning',
      daysUntilTrip: 300,
      now: new Date('2026-09-13T00:00:00Z'),
      limit: 10,
    }).actions;
    expect(actions.map((action) => action.nodeId)).toEqual(['dependency:traveller:0']);
    expect(actions[0]!.kind).toBe('decide');
  });
});
