/**
 * The fixture proposal: a deterministic candidate pool for the browser suite
 * and integration tests, reached only under the fixture switches. Names are
 * plainly synthetic ("<destination> Old Quarter") so a fixture can never pass
 * for real research, and the token `unscannable` in what the traveller typed
 * makes the scan fail, so the failure screen can be exercised. The token
 * `thinscan` makes the first pass propose only four places, so the bounded
 * supplement can be exercised; the supplement (`already` given) proposes the rest.
 */
const KINDS = [
  ['Old Quarter', 'neighbourhood', 'classic', 120, 'easy', 'mixed', ['neighbourhoods_and_local_life', 'history_and_culture']],
  ['Cathedral', 'religious_site', 'classic', 60, 'none', 'indoor', ['architecture_and_landmarks', 'history_and_culture']],
  ['City Museum', 'museum', 'classic', 120, 'none', 'indoor', ['museums_and_galleries']],
  ['Central Market', 'market', 'classic', 75, 'easy', 'mixed', ['markets_and_street_food']],
  ['Ridge Viewpoint', 'viewpoint', 'hidden_gem', 60, 'easy', 'outdoor', ['scenic_viewpoints', 'photography_golden_hour']],
  ['River Walk', 'easy_walk', 'classic', 90, 'easy', 'outdoor', ['easy_nature_walks', 'lakes_and_rivers']],
  ['Botanic Garden', 'park_or_garden', 'hidden_gem', 90, 'easy', 'outdoor', ['easy_nature_walks']],
  ['Summit Trail', 'day_hike', 'side_quest', 240, 'strenuous', 'outdoor', ['hiking', 'scenic_viewpoints']],
  ['Lake Loop', 'lake_or_river', 'side_quest', 150, 'moderate', 'outdoor', ['lakes_and_rivers', 'hiking']],
  ['Craft Quarter', 'neighbourhood', 'hidden_gem', 90, 'easy', 'mixed', ['neighbourhoods_and_local_life']],
  ['Castle', 'castle_or_palace', 'classic', 120, 'easy', 'mixed', ['history_and_culture', 'architecture_and_landmarks']],
  ['Art Gallery', 'gallery', 'hidden_gem', 90, 'none', 'indoor', ['museums_and_galleries']],
  ['Harbour Boat Trip', 'boat_trip', 'side_quest', 120, 'none', 'outdoor', ['lakes_and_rivers', 'scenic_viewpoints']],
  ['Night Food Street', 'street_food', 'classic', 90, 'easy', 'mixed', ['markets_and_street_food']],
  ['Valley Village', 'small_town', 'side_quest', 180, 'easy', 'mixed', ['food_and_towns', 'history_and_culture']],
  ['Sunset Point', 'viewpoint', 'classic', 45, 'easy', 'outdoor', ['scenic_viewpoints', 'photography_golden_hour']],
  ['Hot Springs', 'hot_spring', 'side_quest', 120, 'none', 'outdoor', ['hot_springs']],
  ['History Museum', 'museum', 'classic', 120, 'none', 'indoor', ['museums_and_galleries', 'history_and_culture']],
] as const;

export function fixtureScanProposal(destinationName: string, typed: string, days: number, options: { already?: readonly string[] } = {}): unknown {
  if (/\bunscannable\b/i.test(typed)) throw new Error('The fixture proposer refused this destination, as asked.');
  const name = destinationName.trim() || 'Destination';
  const second = `${name} Hills`;
  const count = Math.min(KINDS.length, Math.max(12, days * 3));
  return {
    bases: [
      { name, locality: name, nightsHint: Math.max(1, days - 3), why: 'The natural base, with the most within reach.' },
      ...(days >= 5 ? [{ name: second, locality: second, nightsHint: 2, why: 'Closer to the outdoor side quests.' }] : []),
    ],
    candidates: KINDS.slice(0, count).filter((_, i) => (options.already ? true : !/\bthinscan\b/i.test(typed) || i < 4)).map(([label, kind, tier, duration, intensity, exposure, interests], i) => ({
      name: `${name} ${label}`,
      locality: i >= 7 && i % 2 === 1 && days >= 5 ? second : name,
      kind,
      tier,
      durationMinutes: duration,
      intensity,
      costLevel: i % 4 === 0 ? 2 : 1,
      exposure,
      bestTime: label.includes('Sunset') ? 'sunset' : 'any',
      crowd: tier === 'classic' ? 'busy' : 'quiet',
      booking: label.includes('Boat') ? 'recommended' : 'none',
      rainyDayOk: exposure === 'indoor',
      interests,
      why: `A fixture ${kind.replace(/_/g, ' ')} for testing.`,
    })).filter((c) => !options.already?.includes(c.name)),
    foodAreas: [{ name: `${name} Market Hall`, locality: name, specialty: 'local dishes', why: 'Fixture food area.' }],
    skipped: [{ name: `${name} Theme Park`, reason: 'Fixture: not a fit for this traveller.' }],
    package: {
      transportSummary: 'Fixture transport summary.',
      transportNotes: ['Fixture transport note.'],
      beforeYouGo: ['Check opening hours before you go.'],
      packing: ['Comfortable shoes', 'Rain layer'],
      foodStrategy: ['Fixture food strategy.'],
      bookingPriorities: ['Fixture: book the boat trip.'],
    },
  };
}
