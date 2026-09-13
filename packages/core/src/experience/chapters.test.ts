import { describe, expect, it } from 'vitest';
import { deriveChapters, normalizeStays, type EpisodeInput, type StayInput } from './chapters';

/**
 * The founder's Kyrgyzstan trip, exactly as it shipped: seven bases for ten
 * nights, two of them inside a three-day operated traverse and two of them the
 * same town twice in a row.
 */
const KYRGYZSTAN_BASES: StayInput[] = [
  { id: 'b1', name: 'Bishkek', nights: 1, baseKind: 'locality', coordinates: { lat: 42.8746, lng: 74.5698 } },
  { id: 'b2', name: 'Karakol', nights: 2, baseKind: 'locality', coordinates: { lat: 42.4907, lng: 78.3936 } },
  { id: 'b3', name: 'Ala-Kul trek (camp)', nights: 2, baseKind: 'lodge' },
  { id: 'b4', name: 'Karakol', nights: 1, baseKind: 'locality', coordinates: { lat: 42.4907, lng: 78.3936 } },
  { id: 'b5', name: 'Karakol', nights: 1, baseKind: 'locality', coordinates: { lat: 42.4907, lng: 78.3936 } },
  { id: 'b6', name: 'Song-Kol', nights: 2, baseKind: 'camp', coordinates: { lat: 41.8386, lng: 75.1361 } },
  { id: 'b7', name: 'Bishkek', nights: 1, baseKind: 'locality', coordinates: { lat: 42.8746, lng: 74.5698 } },
];

const KYRGYZSTAN_EPISODES: EpisodeInput[] = [
  { name: 'Ala-Kul & Altyn-Arashan trek', kind: 'trek', dayNumbers: [4, 5, 6], baseIds: ['b3'], timing: 'operator' },
  { name: 'Song-Kol yurt stay', kind: 'guided_overland', dayNumbers: [8, 9], baseIds: ['b6'], timing: 'operator' },
];

describe('V11 §5 — the stay sequence a traveller actually experiences', () => {
  const result = normalizeStays({ bases: KYRGYZSTAN_BASES, episodes: KYRGYZSTAN_EPISODES });

  it('collapses the two consecutive Karakol stays into one, so "Karakol → Karakol" cannot be a move', () => {
    const karakol = result.stays.filter((stay) => stay.name === 'Karakol');
    expect(karakol).toHaveLength(2); // the first visit, and the return after the trek
    expect(karakol[1]!.nights).toBe(2); // b4 + b5, not two one-night stays
    expect(karakol[1]!.baseIds).toEqual(['b4', 'b5']);
    expect(result.collapsed).toEqual([{ name: 'Karakol', foldedBaseIds: ['b5'], reason: 'same_name' }]);
  });

  it('keeps the two SEPARATE Karakol visits separate, because the route depends on the difference', () => {
    /* Six stays, not five: b2 and b4/b5 are two visits with a trek between them. */
    expect(result.stays.map((stay) => stay.name)).toEqual(['Bishkek', 'Karakol', 'Ala-Kul trek (camp)', 'Karakol', 'Song-Kol', 'Bishkek']);
  });

  it('attributes the trek camp and the yurt camp to their experiences', () => {
    expect(result.stays.find((s) => s.id === 'b3')?.withinExperience).toBe('Ala-Kul & Altyn-Arashan trek');
    expect(result.stays.find((s) => s.id === 'b6')?.withinExperience).toBe('Song-Kol yurt stay');
    expect(result.stays.find((s) => s.id === 'b2')?.withinExperience).toBeUndefined();
  });

  it('does not count a night an experience owns as a hotel change', () => {
    /* Six changes shipped. Bishkek→Karakol, (trek), Karakol, (yurt), Bishkek = three the traveller books. */
    expect(result.hotelChanges).toBe(3);
    expect(result.stays.find((s) => s.id === 'b3')?.countsAsHotelChange).toBe(false);
    expect(result.stays.find((s) => s.id === 'b6')?.countsAsHotelChange).toBe(false);
  });

  it('preserves every night', () => {
    expect(result.stays.reduce((total, stay) => total + stay.nights, 0)).toBe(10);
  });

  it('never collapses two stays that merely sound alike', () => {
    const stays = normalizeStays({
      bases: [
        { id: 'x', name: 'Karakol', nights: 1, coordinates: { lat: 42.4907, lng: 78.3936 } },
        { id: 'y', name: 'Karakul', nights: 1, coordinates: { lat: 39.0167, lng: 73.4 } },
      ],
    });
    expect(stays.stays).toHaveLength(2);
  });

  it('collapses a town and the guesthouse in it, on the coordinate rather than the name', () => {
    const stays = normalizeStays({
      bases: [
        { id: 'x', name: 'Karakol', nights: 1, coordinates: { lat: 42.4907, lng: 78.3936 } },
        { id: 'y', name: 'Green Yard Hotel', nights: 2, coordinates: { lat: 42.4915, lng: 78.3951 } },
      ],
    });
    expect(stays.stays).toHaveLength(1);
    expect(stays.stays[0]!.nights).toBe(3);
    expect(stays.collapsed[0]!.reason).toBe('same_point');
  });

  it('never folds nights belonging to two different experiences together', () => {
    const stays = normalizeStays({
      bases: [
        { id: 'x', name: 'Camp', nights: 1, episode: 'Trek one' },
        { id: 'y', name: 'Camp', nights: 1, episode: 'Trek two' },
      ],
    });
    expect(stays.stays).toHaveLength(2);
  });
});

const day = (dayNumber: number, baseId: string, intensity: 'light' | 'moderate' | 'intense', strenuousCount = 0, driveMinutes = 0) =>
  ({ dayNumber, baseId, items: [], intensity, totals: { strenuousCount, driveMinutes, transitMinutes: 0, unverifiedMinutes: 0 } }) as unknown as Parameters<typeof deriveChapters>[0]['days'][number];

describe('V11 §6 — the trip reads as chapters', () => {
  const { stays } = normalizeStays({ bases: KYRGYZSTAN_BASES, episodes: KYRGYZSTAN_EPISODES });
  const chapters = deriveChapters({
    days: [
      day(1, 'b1', 'light'),
      day(2, 'b2', 'moderate'),
      day(3, 'b2', 'moderate'),
      day(4, 'b3', 'intense', 1),
      day(5, 'b3', 'intense', 2),
      day(6, 'b4', 'intense', 1),
      day(7, 'b4', 'light'),
      day(8, 'b6', 'moderate'),
      day(9, 'b6', 'intense', 1),
      day(10, 'b7', 'moderate'),
      day(11, 'b7', 'light'),
    ],
    stays,
    episodes: KYRGYZSTAN_EPISODES,
  });

  it('gives the trip a small number of named chapters instead of eleven undifferentiated days', () => {
    expect(chapters.length).toBeGreaterThanOrEqual(4);
    expect(chapters.length).toBeLessThanOrEqual(7);
  });

  it('makes each multi-day experience one chapter, under its own name', () => {
    const expeditions = chapters.filter((chapter) => chapter.role === 'expedition');
    expect(expeditions.map((chapter) => chapter.title)).toEqual(['Ala-Kul & Altyn-Arashan trek', 'Song-Kol yurt stay']);
    expect(expeditions[0]!.dayNumbers).toEqual([4, 5, 6]);
    expect(expeditions[1]!.dayNumbers).toEqual([8, 9]);
  });

  it('opens with arrival and closes with the finale', () => {
    expect(chapters[0]!.role).toBe('arrival');
    expect(chapters[chapters.length - 1]!.role).toBe('finale');
  });

  it('covers every day exactly once, in order', () => {
    expect(chapters.flatMap((chapter) => chapter.dayNumbers)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('names a quiet chapter after an expedition "recovery", and only when nothing in it is strenuous', () => {
    const afterTrek = chapters.find((chapter) => chapter.dayNumbers.includes(7));
    expect(afterTrek?.role).toBe('recovery');
  });

  it('does not call a chapter recovery when it contains a strenuous day', () => {
    const busy = deriveChapters({
      days: [day(1, 'b2', 'moderate'), day(2, 'b3', 'intense', 1), day(3, 'b4', 'intense', 2), day(4, 'b4', 'moderate')],
      stays,
      episodes: [{ name: 'Trek', kind: 'trek', dayNumbers: [2], baseIds: ['b3'], timing: 'operator' }],
    });
    expect(busy.every((chapter) => chapter.role !== 'recovery')).toBe(true);
  });

  it('refuses to call a day of driving "recovery", however quiet it looks', () => {
    /* §9 — the recovery day that is secretly four hours of transfers is the defect, not the fix. */
    const driven = deriveChapters({
      days: [day(1, 'b2', 'moderate'), day(2, 'b3', 'intense', 2), day(3, 'b4', 'light', 0, 260), day(4, 'b6', 'moderate')],
      stays,
      episodes: [{ name: 'Trek', kind: 'trek', dayNumbers: [2], baseIds: ['b3'], timing: 'operator' }],
    });
    expect(driven.find((chapter) => chapter.dayNumbers.includes(3))?.role).not.toBe('recovery');
  });

  it('never folds an unplaced stay into a neighbouring chapter, because unknown is not nearby', () => {
    const unplaced = deriveChapters({
      days: [day(1, 'p1', 'light'), day(2, 'p2', 'moderate')],
      stays: [
        { id: 'p1', baseIds: ['p1'], name: 'Placed', nights: 1, coordinates: { lat: 51, lng: -115 }, countsAsHotelChange: false },
        { id: 'p2', baseIds: ['p2'], name: 'Unplaced', nights: 1, countsAsHotelChange: true },
      ],
    });
    expect(unplaced).toHaveLength(2);
  });
});

describe('V11 §42 — the stay labels are compared with the accents folded away', () => {
  it('treats an accented and unaccented spelling of one place as one stay', () => {
    const stays = normalizeStays({
      bases: [
        { id: 'a', name: 'Reykjavík', nights: 2 },
        { id: 'b', name: 'Reykjavik', nights: 1 },
      ],
    });
    expect(stays.stays).toHaveLength(1);
    expect(stays.stays[0]!.nights).toBe(3);
  });

  it('and still keeps two genuinely different names apart', () => {
    const stays = normalizeStays({
      bases: [
        { id: 'a', name: 'Höfn', nights: 1 },
        { id: 'b', name: 'Hafn', nights: 1 },
      ],
    });
    expect(stays.stays).toHaveLength(2);
  });
});

describe('V11 §5 — a relocation is a change of place, not a change of row', () => {
  /*
   * The founder's day 7 read "You move from Karakol to Karakol today" with a
   * 0-minute base-to-base leg, because two distinct base ROWS naming the same
   * town were compared by object identity. `normalizeStays` is the derivation
   * the surfaces read; `reconcile.ts#sameOvernightPlace` is the same question
   * asked at the source so the leg is never created at all.
   */
  it('collapses so no consecutive pair of stays names the same place', () => {
    const { stays } = normalizeStays({ bases: KYRGYZSTAN_BASES, episodes: KYRGYZSTAN_EPISODES });
    const consecutiveSame = stays.filter((stay, index) => index > 0 && stay.name === stays[index - 1]!.name);
    expect(consecutiveSame).toEqual([]);
  });

  it('leaves a genuine one-night stop between two different places alone', () => {
    const { stays, hotelChanges } = normalizeStays({
      bases: [
        { id: 'a', name: 'A', nights: 2, coordinates: { lat: 51, lng: -115 } },
        { id: 'b', name: 'B', nights: 1, coordinates: { lat: 52, lng: -116 } },
        { id: 'c', name: 'C', nights: 2, coordinates: { lat: 53, lng: -117 } },
      ],
    });
    expect(stays).toHaveLength(3);
    expect(hotelChanges).toBe(2);
  });
});
