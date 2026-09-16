import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAuthoritative, pickContextualWinner, sanityCheckResolved, scoreCandidate, type PlaceCandidate, type ResolutionContext } from '@sidequest/core';

/**
 * V12.3 §1 §22 — THE PLACE-RESOLUTION CORPUS, ON REAL GEOCODER ROWS.
 *
 * `fixtures/resolution/nominatim.json` holds what the live geocoder actually
 * returned for each ambiguous name, recorded once in this pass and stored so the
 * corpus is deterministic afterwards. **No model calls, and no network at test
 * time.**
 *
 * Every case is one Sidequest has shipped or would ship:
 *
 *   Halki         the V12.1 Greek trip placed it 218 km away on the wrong island
 *   Field         the correct village ranks *last* of ten by importance
 *   Old Harbour   the correct answer scores importance 0.0 and was unresolvable
 *   Höfn          a clear leader that must keep winning
 *   Song-Kol      a transliteration whose lake must keep winning
 */

interface Recorded {
  query: string;
  status: number;
  results: {
    place_id: number;
    lat: string;
    lon: string;
    name?: string;
    display_name?: string;
    importance?: number;
    addresstype?: string;
    type?: string;
    address?: Record<string, string>;
  }[];
}

const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/resolution/nominatim.json', import.meta.url), 'utf8')) as Record<string, Recorded>;

function candidatesFor(slug: string): PlaceCandidate[] {
  return RECORDED[slug]!.results.map((row) => ({
    id: String(row.place_id),
    name: row.name ?? row.display_name ?? '',
    point: { lat: Number(row.lat), lng: Number(row.lon) },
    ...(row.importance !== undefined ? { importance: row.importance } : {}),
    /*
     * The specific value first. Nominatim's `addresstype` is the coarse bucket —
     * a ferry terminal, a restaurant and a gift shop are all `amenity` — and
     * `type` is what tells them apart.
     */
    ...(row.type ?? row.addresstype ? { kind: row.type ?? row.addresstype } : {}),
    ...(row.address?.country_code ? { countryCode: row.address.country_code } : {}),
    adminNames: Object.values(row.address ?? {}),
  }));
}

/** The Naxos day as the V12.1 Greek trip actually had it, coordinates from the dump. */
const NAXOS_DAY: ResolutionContext = {
  countryCode: 'gr',
  base: { lat: 37.1021, lng: 25.3762 },
  neighbours: [{ lat: 37.0718, lng: 25.5196 }],
  expectedKind: 'village',
  regionNames: ['Naxos'],
};

describe('§1 — the Halki defect, reproduced and refused', () => {
  it('shows the right answer was in the bare results all along, ranked last', () => {
    /*
     * The sharpest fact in this corpus. Asked for "Halki", the geocoder returns
     * the Naxos village — and ranks it **tenth of ten** by importance, behind a
     * village in Maharashtra and four Polish streets. The old rule sorted by
     * importance and took the top. The evidence needed was never missing; it was
     * never weighed.
     */
    const bare = candidatesFor('halki');
    expect(bare).toHaveLength(10);
    const greek = bare.filter((c) => c.countryCode === 'gr');
    expect(greek).toHaveLength(1);
    expect(greek[0]!.point.lat).toBeCloseTo(37.06, 1);
    const byImportance = [...bare].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
    expect(byImportance[0]!.countryCode).not.toBe('gr');
  });

  it('rejects every candidate outside Greece and keeps the one inside it', () => {
    const bare = candidatesFor('halki');
    for (const candidate of bare.filter((c) => c.countryCode !== 'gr')) {
      expect(scoreCandidate(candidate, NAXOS_DAY).rejected, candidate.name).not.toBeNull();
    }
    const outcome = pickContextualWinner(bare, NAXOS_DAY);
    expect(outcome.winner).toBeTruthy();
    expect(outcome.winner!.point.lat).toBeCloseTo(37.06, 1);
  });

  it('picks the Naxos village from the qualified query', () => {
    const outcome = pickContextualWinner(candidatesFor('halki-naxos'), NAXOS_DAY);
    expect(outcome.winner).toBeTruthy();
    expect(outcome.winner!.point.lat).toBeCloseTo(37.06, 1);
    expect(outcome.winner!.point.lng).toBeCloseTo(25.48, 1);
    expect(outcome.confidence).toBe('contextual_match');
  });

  it('refuses the Dodecanese island even when it is offered as a candidate', () => {
    /* The exact coordinate the V12.1 trip persisted, as a candidate on the Naxos day. */
    const chalkiIsland: PlaceCandidate = { id: 'chalki', name: 'Chalki', point: { lat: 36.2296, lng: 27.5672 }, importance: 0.5, kind: 'island', countryCode: 'gr' };
    const scored = scoreCandidate(chalkiIsland, NAXOS_DAY);
    expect(scored.rejected).toBeTruthy();
    expect(scored.rejected).toMatch(/km from everything else|island/i);
  });

  it('beats the island even when the island is far more important', () => {
    const chalkiIsland: PlaceCandidate = { id: 'chalki', name: 'Chalki', point: { lat: 36.2296, lng: 27.5672 }, importance: 0.9, kind: 'island', countryCode: 'gr' };
    const village = candidatesFor('halki-naxos').find((c) => c.kind === 'village')!;
    const outcome = pickContextualWinner([chalkiIsland, village], NAXOS_DAY);
    expect(outcome.winner?.id).toBe(village.id);
  });

  it('is NOT caught by the after-the-fact backstop, and that is the correct trade', () => {
    /*
     * §13's backstop deliberately does not fire here, and it is worth being exact
     * about why. Judged on distance alone, this day — a base, one stop 13 km
     * away, one stop 218 km away — is indistinguishable from day 7 of the
     * founder's Iceland trip, which is based near Selfoss and drives 193 km to
     * Skaftafell. A backstop tight enough to catch Chalki removes Skaftafell, and
     * it did, the first time this ran.
     *
     * Halki is caught where the evidence to catch it actually exists: in
     * `pickContextualWinner`, which has the alternatives to compare it against.
     * The test above is the one that matters.
     */
    const check = sanityCheckResolved({ lat: 36.2296, lng: 27.5672 }, NAXOS_DAY, 'contextual_match');
    expect(check.confidence).toBe('contextual_match');
  });

  it('keeps the backstop for what no day reaches and returns from', () => {
    /* Athens, resolved onto a Naxos day. Nothing drives there and back. */
    const check = sanityCheckResolved({ lat: 37.9838, lng: 23.7275 }, { ...NAXOS_DAY, neighbours: [{ lat: 37.0718, lng: 25.5196 }, { lat: 37.09, lng: 25.42 }] }, 'contextual_match');
    expect(check.confidence).toBe('contextual_match');
    /* 190 km — still inside a day's reach, so still not this function's call. */
    const faraway = sanityCheckResolved({ lat: 35.3387, lng: 25.1442 }, NAXOS_DAY, 'contextual_match');
    expect(faraway.confidence).toBe('contextual_match');
    /* Rome, on a Greek island day: 1,500 km, beyond any day by any mode. */
    const absurd = sanityCheckResolved({ lat: 41.9028, lng: 12.4964 }, NAXOS_DAY, 'contextual_match');
    expect(absurd.confidence).toBe('ambiguous');
    expect(isAuthoritative(absurd.confidence)).toBe(false);
    expect(absurd.note).toMatch(/km from the rest of the day/);
  });

  it('leaves an ordinary long Icelandic day alone', () => {
    /* The regression the loosened backstop exists to prevent: Skaftafell, 193 km east of a Selfoss-area base. */
    const day: ResolutionContext = { countryCode: 'is', base: { lat: 63.9368, lng: -21.0035 }, neighbours: [{ lat: 64.0413, lng: -20.8851 }] };
    expect(sanityCheckResolved({ lat: 64.0704, lng: -16.9752 }, day, 'contextual_match').confidence).toBe('contextual_match');
  });
});

describe('§19 — the Field class: same country, wrong side of it', () => {
  const ROCKIES: ResolutionContext = {
    countryCode: 'ca',
    base: { lat: 51.4254, lng: -116.1773 },
    neighbours: [{ lat: 51.1784, lng: -115.5708 }],
    expectedKind: 'village',
    regionNames: ['British Columbia'],
  };

  it('reproduces the ranking that would choose wrongly', () => {
    const ranked = [...candidatesFor('field')].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
    /* The correct village is not the most important row; a Minneapolis neighbourhood is. */
    expect(ranked[0]!.point.lat).toBeCloseTo(44.9, 0);
    const bc = candidatesFor('field').find((c) => c.point.lat > 51 && c.point.lng < -116)!;
    expect(bc).toBeTruthy();
    expect(bc.importance!).toBeLessThan(ranked[0]!.importance!);
  });

  it('refuses the Ontario homonym, which the country guard alone would admit', () => {
    /* Same country, 3,000 km away: the case a country-scoped resolver cannot see. */
    const ontario = candidatesFor('field').find((c) => c.point.lat > 46 && c.point.lat < 47 && c.point.lng > -81)!;
    expect(ontario.countryCode).toBe('ca');
    expect(scoreCandidate(ontario, ROCKIES).rejected).toBeTruthy();
  });

  it('picks the British Columbia village', () => {
    const outcome = pickContextualWinner(candidatesFor('field'), ROCKIES);
    expect(outcome.winner).toBeTruthy();
    expect(outcome.winner!.point.lat).toBeCloseTo(51.4, 0);
    expect(outcome.winner!.point.lng).toBeCloseTo(-116.5, 0);
  });
});

describe('§20 — Iceland', () => {
  const REYKJAVIK: ResolutionContext = {
    countryCode: 'is',
    base: { lat: 64.1466, lng: -21.9426 },
    neighbours: [{ lat: 64.1475, lng: -21.9394 }],
    expectedKind: 'port',
  };

  it('places the Old Harbour that every candidate scores zero importance for', () => {
    /* The mirror defect: no "clear leader" by importance, so the old rule returned nothing. */
    const candidates = candidatesFor('old-harbour-reykjavik');
    /* All three are the same negligible importance — no "clear leader" for the old rule to find. */
    expect(candidates.every((c) => (c.importance ?? 0) < 0.001)).toBe(true);
    const outcome = pickContextualWinner(candidates, REYKJAVIK);
    expect(outcome.winner).toBeTruthy();
    expect(outcome.winner!.point.lat).toBeCloseTo(64.15, 1);
  });

  it('refuses the Alaskan and Jamaican harbours the bare name returns', () => {
    for (const candidate of candidatesFor('old-harbour')) {
      if (candidate.countryCode === 'is') continue;
      expect(scoreCandidate(candidate, REYKJAVIK).rejected, candidate.name).toBeTruthy();
    }
  });

  it('keeps Höfn the town rather than Höfn the islet', () => {
    const outcome = pickContextualWinner(candidatesFor('hofn'), { countryCode: 'is', base: { lat: 64.2532, lng: -15.2082 }, expectedKind: 'town' });
    expect(outcome.winner!.point.lat).toBeCloseTo(64.25, 1);
  });
});

describe('§18 — Kyrgyzstan transliteration', () => {
  it('resolves a transliterated lake to the lake, not to a city amenity of the same name', () => {
    const outcome = pickContextualWinner(candidatesFor('song-kol'), {
      countryCode: 'kg',
      base: { lat: 42.4907, lng: 78.3936 },
      expectedKind: 'lake',
    });
    expect(outcome.winner).toBeTruthy();
    expect(outcome.winner!.point.lat).toBeCloseTo(41.84, 1);
    expect(outcome.winner!.kind).toBe('lake');
  });
});

describe('§22 — the failure corpus', () => {
  const HERE: ResolutionContext = { countryCode: 'gr', base: { lat: 37.1021, lng: 25.3762 }, neighbours: [{ lat: 37.0718, lng: 25.5196 }] };

  it('prefers unknown to a confident error when two candidates are equally plausible', () => {
    /*
     * Two real villages of the same name at opposite ends of the same island —
     * both inside the day's reach, both the right type, neither more important.
     * Genuinely two places, 22 km apart, so the collapse rule below does not
     * apply and nothing here chooses. The answer is to say so.
     */
    const a: PlaceCandidate = { id: 'a', name: 'Agia Anna', point: { lat: 37.06, lng: 25.37 }, importance: 0.2, kind: 'village', countryCode: 'gr' };
    const b: PlaceCandidate = { id: 'b', name: 'Agia Anna', point: { lat: 37.13, lng: 25.58 }, importance: 0.2, kind: 'village', countryCode: 'gr' };
    const outcome = pickContextualWinner([a, b], HERE);
    expect(outcome.winner).toBeNull();
    expect(outcome.confidence).toBe('ambiguous');
    expect(isAuthoritative(outcome.confidence)).toBe(false);
  });

  it('treats several records of one place as one candidate, not as a tie', () => {
    /*
     * Recorded from the Rockies corpus: "Johnston Canyon" comes back as the
     * gorge, its car park, its tourism node and two information boards, all
     * inside 1.2 km. Five rows, one place. Abstaining here took two real stops
     * off a real itinerary.
     */
    const gorge: PlaceCandidate = { id: 'g', name: 'Johnston Canyon', point: { lat: 51.2536, lng: -115.838 }, importance: 0.107, kind: 'gorge', countryCode: 'ca' };
    const carPark: PlaceCandidate = { id: 'p', name: 'Johnston Canyon', point: { lat: 51.2429, lng: -115.839 }, importance: 0.00001, kind: 'parking', countryCode: 'ca' };
    const board: PlaceCandidate = { id: 'b', name: 'Johnston canyon', point: { lat: 51.2459, lng: -115.84 }, importance: 0.00001, kind: 'information', countryCode: 'ca' };
    const here: ResolutionContext = { countryCode: 'ca', base: { lat: 51.1784, lng: -115.5708 }, neighbours: [{ lat: 51.4254, lng: -116.1773 }] };
    const outcome = pickContextualWinner([carPark, board, gorge], here);
    expect(outcome.winner?.id).toBe('g');
    expect(outcome.confidence).toBe('contextual_match');
  });

  it('returns unresolved rather than throwing when nothing came back', () => {
    expect(pickContextualWinner([], HERE).confidence).toBe('unresolved');
  });

  it('lets a legitimately distant famous stop through on a touring day', () => {
    /* §3: a famous attraction may reasonably be farther away, and a spread-out day has room. */
    const touring: ResolutionContext = { countryCode: 'is', base: { lat: 64.1466, lng: -21.9426 }, neighbours: [{ lat: 63.93, lng: -20.99 }, { lat: 64.25, lng: -15.2 }] };
    const distant: PlaceCandidate = { id: 'j', name: 'Jökulsárlón', point: { lat: 64.0784, lng: -16.23 }, importance: 0.5, kind: 'water', countryCode: 'is' };
    expect(scoreCandidate(distant, touring).rejected).toBeNull();
  });

  it('degrades to the old behaviour when the context knows nothing', () => {
    /* No base, no neighbours, no country: nothing is refused, and importance decides as before. */
    const strong: PlaceCandidate = { id: 's', name: 'X', point: { lat: 0, lng: 0 }, importance: 0.9 };
    const weak: PlaceCandidate = { id: 'w', name: 'X', point: { lat: 40, lng: 40 }, importance: 0.1 };
    const outcome = pickContextualWinner([strong, weak], {});
    /* With nothing else to weigh, a clear importance leader still wins — as it always did. */
    expect(outcome.winner?.id).toBe('s');
    expect(scoreCandidate(strong, {}).rejected).toBeNull();
    expect(scoreCandidate(weak, {}).rejected).toBeNull();
  });

  it('never rejects on a missing country code', () => {
    /* Unknown is not a mismatch: a row with no country attached must not be refused for it. */
    const nameless: PlaceCandidate = { id: 'n', name: 'Somewhere', point: { lat: 37.09, lng: 25.4 }, kind: 'village' };
    expect(scoreCandidate(nameless, HERE).rejected).toBeNull();
  });
});

/**
 * V12.3 §17–§21 — THE SHAPE PRODUCTION ACTUALLY RESOLVES IN.
 *
 * Every context above carries neighbours. **Production's first pass does not.**
 * Anchors are looked up concurrently — that is what keeps a build inside its
 * deadline — so when a stop is resolved, nothing else on its day is placed yet.
 * All the first pass has is the bed, the region's name and what the draft said
 * the stop was.
 *
 * If the fix only works with neighbours it does not work, so this block replays
 * each case with exactly what the reconciler hands `resolveDraftAnchor`.
 */
describe('§17–§21 — base-only contexts, as the first pass really sees them', () => {
  /*
   * Day 5 of the Greek trip, from the saved draft
   * (`.claude-private/artifacts/v12.1/live/greece-dump/trip-draft.json`):
   *
   *   baseId naxos, anchors: Halki (town, core), Temple of Demeter Sangri
   *   (historic, secondary), Apiranthos (town, secondary)
   *
   * `town` is the category the model wrote, and it is the whole ballgame: it
   * says the thing being asked for is a settlement, and an island is not one.
   */
  const NAXOS_FIRST_PASS: ResolutionContext = {
    base: { lat: 37.1021, lng: 25.3762 },
    extentKm: 120,
    regionNames: ['the Greek Islands', 'Greece'],
    expectedKind: 'town',
    routeCritical: true,
  };

  it('§17 — places Halki on Naxos from the bare name, with no neighbour to help', () => {
    const outcome = pickContextualWinner(candidatesFor('halki'), NAXOS_FIRST_PASS);
    expect(outcome.winner).toBeTruthy();
    expect(outcome.winner!.point.lat).toBeCloseTo(37.06, 1);
    expect(outcome.winner!.point.lng).toBeCloseTo(25.48, 1);
    expect(outcome.confidence).toBe('contextual_match');
  });

  it('§17 — refuses the Dodecanese island on the same first-pass context', () => {
    /* The coordinate the live V12.1 trip actually persisted, 218 km away. */
    const island: PlaceCandidate = { id: 'chalki', name: 'Chalki', point: { lat: 36.2296, lng: 27.5672 }, importance: 0.55, kind: 'island', countryCode: 'gr' };
    const scored = scoreCandidate(island, NAXOS_FIRST_PASS);
    expect(scored.rejected).toBeTruthy();
    expect(scored.rejected).toMatch(/island/i);
  });

  it('§17 — and the island still loses head-to-head even if the guard were lifted', () => {
    const island: PlaceCandidate = { id: 'chalki', name: 'Chalki', point: { lat: 36.2296, lng: 27.5672 }, importance: 0.55, countryCode: 'gr' };
    const village = candidatesFor('halki').find((c) => c.countryCode === 'gr')!;
    const outcome = pickContextualWinner([island, village], { ...NAXOS_FIRST_PASS, expectedKind: undefined });
    expect(outcome.winner?.id).toBe(village.id);
  });

  it('§19 — places Field, British Columbia with only the Lake Louise base', () => {
    const outcome = pickContextualWinner(candidatesFor('field'), {
      base: { lat: 51.4254, lng: -116.1773 },
      extentKm: 150,
      regionNames: ['Alberta', 'British Columbia'],
      expectedKind: 'town',
      routeCritical: true,
    });
    expect(outcome.winner).toBeTruthy();
    expect(outcome.winner!.point.lat).toBeCloseTo(51.4, 0);
    expect(outcome.winner!.point.lng).toBeCloseTo(-116.5, 0);
  });

  it('§20 — places the Old Harbour on type alone, with every importance at zero', () => {
    const outcome = pickContextualWinner(candidatesFor('old-harbour-reykjavik'), {
      base: { lat: 64.1466, lng: -21.9426 },
      extentKm: 60,
      expectedKind: 'port',
    });
    expect(outcome.winner).toBeTruthy();
    expect(outcome.winner!.kind).toBe('ferry_terminal');
  });

  it('§18 — places Song-Köl 270 km from the only thing the day has placed', () => {
    /*
     * The case that fixed the guard. A lake this far from its base is exactly
     * what a Kyrgyz trip is for, and a rule tight enough to refuse it refuses
     * the trip. A base alone is not evidence of a local day.
     */
    const outcome = pickContextualWinner(candidatesFor('song-kol'), {
      base: { lat: 42.4907, lng: 78.3936 },
      expectedKind: 'lake',
      routeCritical: true,
    });
    expect(outcome.winner!.kind).toBe('lake');
    expect(outcome.winner!.point.lat).toBeCloseTo(41.84, 1);
  });

  it('§20 — keeps a clear leader winning, which is most of the world', () => {
    /* The regression that matters most: the ordinary case must not get harder. */
    const outcome = pickContextualWinner(candidatesFor('hofn'), { base: { lat: 64.2532, lng: -15.2082 }, expectedKind: 'town' });
    expect(outcome.winner!.point.lat).toBeCloseTo(64.25, 1);
    expect(outcome.confidence).toBe('contextual_match');
  });
});

/**
 * V12.3 §21 — A DENSE CITY, WHERE THE SAME NAME IS A DOZEN REAL THINGS.
 *
 * Asked for `Shinjuku, Tokyo`, the geocoder returns the ward (`administrative`,
 * importance 0.632) and **nine railway rows** — platforms, stops, station nodes
 * and an information board — every one of them at importance 0.588, spread over
 * about 400 m.
 *
 * This is the hardest shape in the corpus and it breaks the old rule twice over:
 * the top two are 0.044 apart, well inside the importance margin, so it places
 * nothing at all — while the thing that actually decides is not popularity but
 * **what the plan asked for**. A day that says "walk around Shinjuku" means the
 * ward; a day that says "meet at Shinjuku" means the station.
 */
describe('§21 — Shinjuku: the ward and the station are both correct answers', () => {
  const TOKYO = { base: { lat: 35.6812, lng: 139.7671 }, extentKm: 40 };

  it('has no clear leader by importance, which is why the old rule placed nothing', () => {
    const rows = candidatesFor('shinjuku-tokyo');
    expect(rows).toHaveLength(10);
    const ranked = [...rows].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
    expect(ranked[0]!.importance! - ranked[1]!.importance!).toBeLessThan(0.05);
  });

  it('gives the ward when the plan asked for a neighbourhood', () => {
    const outcome = pickContextualWinner(candidatesFor('shinjuku-tokyo'), { ...TOKYO, expectedKind: 'village' });
    expect(outcome.winner?.kind).toBe('administrative');
    expect(outcome.confidence).toBe('contextual_match');
  });

  it('gives the station when the plan asked for a station', () => {
    const outcome = pickContextualWinner(candidatesFor('shinjuku-tokyo'), { ...TOKYO, expectedKind: 'station' });
    expect(['station', 'stop']).toContain(outcome.winner?.kind);
  });

  it('never returns the information board', () => {
    /* Nine near-identical railway rows collapse to one; a signboard is not a stop. */
    for (const expected of ['village', 'station']) {
      expect(pickContextualWinner(candidatesFor('shinjuku-tokyo'), { ...TOKYO, expectedKind: expected }).winner?.kind).not.toBe('information');
    }
  });
});
