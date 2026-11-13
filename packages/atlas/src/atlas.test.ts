import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ADVISORY_FRESH_DAYS,
  Atlas,
  answerAdvisorQuestion,
  DESTINATION_KINDS,
  EXPERIENCES,
  WORLD_REGIONS,
  atlasTokens,
  buildAdvisorShortlist,
  destinationCatalog,
  emptyComposerAnswers,
  liesWithin,
  overlap,
  parseTravelRequest,
  seasonModelFor,
  type AdvisorShortlist,
  type Destination,
} from '@sidequest/core';
// @ts-expect-error — the build stages are plain JavaScript modules with no declarations.
import { EXPERIENCES as BUILD_EXPERIENCES, tokens as buildTokens } from '../build/lib/vocabulary.mjs';
// @ts-expect-error — as above.
import { WORLD_REGIONS as BUILD_WORLD_REGIONS, worldRegionFor } from '../build/lib/world-regions.mjs';
import { atlasPath, loadAtlas, readAtlasArtifact, resetAtlasForTests } from './load';

/**
 * THE ATLAS THAT SHIPS, TESTED AS IT SHIPS.
 *
 * No mocks: this reads `packages/atlas/data/atlas.json.gz` — the artifact the
 * server loads — and asserts properties of the real world in it. A rebuild
 * that drops a continent, mislabels a hierarchy or breaks a scope fails here
 * before it reaches a traveller. Assertions are properties (where a pick is,
 * what the normals say about it), never a list of expected destinations.
 */

/* Reads and decodes the real 36,000-row artifact, and builds its season table on first use: a time budget for a loaded machine, not a performance claim. */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOW = new Date('2026-11-08T12:00:00Z');
let atlas: Atlas;

function ask(text: string): { shortlist: AdvisorShortlist; picks: Destination[]; readings: string[] } {
  const base = { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month' as const, wantsRecommendation: false } };
  const parsed = parseTravelRequest(text, base, NOW, atlas);
  const shortlist = buildAdvisorShortlist({ answers: parsed.answers, catalog: atlas, catalogVersion: atlas.version, now: NOW });
  return { shortlist, picks: shortlist.picks.map((pick) => atlas.byId(pick.id)!), readings: parsed.readings.map((reading) => reading.label) };
}

beforeAll(() => {
  resetAtlasForTests();
  const loaded = loadAtlas({ now: NOW });
  if (!loaded) throw new Error('packages/atlas/data/atlas.json.gz is missing — build it (packages/atlas/README.md)');
  atlas = loaded.atlas;
});

describe('the build and the runtime agree', () => {
  it('on the experience and world-region vocabularies', () => {
    expect(BUILD_EXPERIENCES).toEqual([...EXPERIENCES]);
    expect([...BUILD_WORLD_REGIONS].sort()).toEqual([...WORLD_REGIONS].sort());
  });

  it('on how a text becomes index terms', () => {
    for (const text of ['Tea plantations, misty hills and train rides', 'Monasteries & high passes — Ladakh’s gompas', 'Beaches, churches, glasses; the Séances of Zürich', 'WORLD-CLASS diving in 2026 and 14 reefs']) {
      expect(atlasTokens(text)).toEqual(buildTokens(text));
    }
  });

  it('on where a country is filed, for every curated destination', () => {
    for (const entry of destinationCatalog()) {
      const regions = entry.countries.map((code) => worldRegionFor(code, entry.center.lat, entry.center.lng));
      expect(regions, entry.id).toContain(entry.worldRegion);
    }
  });
});

describe('global coverage', () => {
  it('holds tens of thousands of destinations in every part of the world', () => {
    const coverage = atlas.coverage();
    expect(atlas.size).toBeGreaterThan(30_000);
    expect(coverage.curated).toBe(destinationCatalog().length);
    expect(coverage.countries).toBeGreaterThan(190);
    for (const region of WORLD_REGIONS) expect(coverage.byWorldRegion[region] ?? 0, region).toBeGreaterThan(region === 'polar' ? 20 : 150);
    for (const kind of ['city', 'town', 'travel_region', 'national_park', 'island', 'mountain_range', 'country'] as const) expect(coverage.byKind[kind] ?? 0, kind).toBeGreaterThan(100);
    expect(DESTINATION_KINDS).toEqual(expect.arrayContaining(Object.keys(coverage.byKind)));
  });

  it('keeps every curated destination, once, with its editorial reading intact', () => {
    for (const entry of destinationCatalog()) {
      const held = atlas.byId(entry.id);
      expect(held?.origin, entry.id).toBe('editorial');
      expect(held?.experiences).toEqual(entry.experiences);
    }
    const ids = atlas.all().map((destination) => destination.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lays measured climate beside nearly every curated entry', () => {
    const measured = atlas.curatedDestinations().filter((destination) => destination.measured !== null).length;
    expect(measured / destinationCatalog().length).toBeGreaterThan(0.95);
  });
});

describe('identity and hierarchy', () => {
  it('knows a little-known valley, where it is and what it is part of', () => {
    const hunza = atlas.resolveName('Hunza Valley');
    expect(hunza?.countries).toEqual(['PK']);
    expect(hunza?.origin).toBe('atlas');
    expect(hunza?.parents).toContain('wv:Pakistan');
    expect(hunza?.measured?.high?.elevM ?? 0).toBeGreaterThan(5000);
    expect(hunza?.basis).toMatchObject({ experiences: 'estimated', climate: 'measured', cost: 'estimated' });
    expect(hunza?.evidence.references[0]).toContain('Wikivoyage');
    expect(hunza!.confidence).toBeLessThan(0.9);
  });

  it('samples climate where people stay, not at a region’s geometric centre', () => {
    /* The Big Island's centre is a 2,400 m saddle; its towns are on the coast. */
    const island = atlas.resolveName('Big Island');
    expect(island?.measured?.base.elevM ?? 9999).toBeLessThan(600);
    expect(Math.max(...(island?.measured?.base.tmax ?? [0]))).toBeGreaterThan(26);
    expect(island?.measured?.sst).not.toBeNull();
  });

  it('never labels an estimate as a measurement or the reverse', () => {
    for (const destination of atlas.all().slice(0, 4000)) {
      if (destination.origin === 'editorial') continue;
      expect(destination.basis.experiences).toBe('estimated');
      expect(destination.basis.climate).toBe(destination.measured ? 'measured' : 'estimated');
      expect(destination.evidence.basis).toBe('open_data');
    }
  });
});

describe('reading the places a request names', () => {
  const roles = (text: string) => atlas.findPlaces(text).map((mention) => `${mention.role}:${mention.name}`);

  it('tells a scope from a comparison, a refusal and a starting point', () => {
    expect(roles('Budget trekking in the Karakoram in July')).toEqual(['scope:Karakoram']);
    expect(roles('somewhere like the Dolomites but cheaper')[0]).toMatch(/^similar:.*Dolomites/);
    expect(roles('Tropical islands in Indonesia in July, not Bali')).toEqual(['scope:Indonesia', 'avoid:Bali']);
    expect(roles('quieter than Chamonix and Zermatt').map((role) => role.split(':')[0])).toEqual(['avoid', 'avoid']);
    expect(roles('Mountains not too far from Delhi').map((role) => role.split(':')[0])).toEqual(['origin']);
  });

  it('does not mistake ordinary words for places, whatever their capital letter', () => {
    for (const text of ['Desert trip in July that is not dangerously hot.', 'Nice beaches and good food in spring', 'Mountains, lakes and islands somewhere remote', 'Surprise me. Two weeks in May.', 'A cheap, atmospheric Eastern European city', 'Somewhere nice. Thanks!']) {
      expect(roles(text), text).toEqual([]);
    }
  });

  it('reads a country at the start of a sentence, a demonym and a short form', () => {
    expect(roles('China beyond Beijing and Shanghai in May')[0]).toBe('scope:China');
    expect(atlas.findPlaces('Thai islands in August')[0]?.country).toBe('TH');
    expect(atlas.findPlaces('US national parks in October')[0]?.country).toBe('US');
    expect(atlas.findPlaces('A classic Himalayan trek in October')[0]?.wide).toBe(true);
  });
});

describe('recommendations from the real atlas', () => {
  it('stays inside the geography a request names', () => {
    const karakoram = ask('Budget trekking in the Karakoram in July, two weeks, happy with basic guesthouses.');
    expect(karakoram.picks.length).toBe(3);
    for (const pick of karakoram.picks) {
      expect(pick.center.lat, pick.name).toBeGreaterThan(33);
      expect(pick.center.lat, pick.name).toBeLessThan(38);
      expect(pick.center.lng, pick.name).toBeGreaterThan(72);
      expect(pick.center.lng, pick.name).toBeLessThan(79.5);
    }
    const hawaii = ask('Volcanoes and beaches in Hawaii for ten days in February.');
    for (const pick of hawaii.picks) expect(pick.countries, pick.name).toContain('US');
    for (const pick of hawaii.picks) expect(pick.center.lng, pick.name).toBeLessThan(-154);
  });

  it('never answers a scope with the scope, nor with what was ruled out', () => {
    const indonesia = ask('Tropical islands in Indonesia in July, snorkelling and quiet beaches, not Bali.');
    const bali = atlas.resolveName('Bali')!;
    expect(indonesia.picks.length).toBe(3);
    for (const pick of indonesia.picks) {
      expect(pick.countries, pick.name).toContain('ID');
      expect(pick.kind, pick.name).not.toBe('country');
      expect(liesWithin(pick, bali, true), pick.name).toBe(false);
    }
    const penguins = ask('I want to see penguins in the wild in December without going to Antarctica.');
    expect(penguins.picks.length).toBeGreaterThan(0);
  });

  it('follows the season of the activity, by measured climate', () => {
    const thai = ask('Thai islands in August, which side has good weather? Beaches and snorkelling.');
    for (const pick of thai.picks) expect(seasonModelFor(pick).fit.beach[7]!.value, pick.name).toBeGreaterThanOrEqual(0.5);
    const ski = ask('Skiing in August.');
    expect(ski.picks.length).toBeGreaterThan(0);
    for (const pick of ski.picks) expect(seasonModelFor(pick).fit.ski[7]!.value, pick.name).toBeGreaterThanOrEqual(0.5);
    const alps = ask('Hiking in the Alps in late September, somewhere quieter than Chamonix and Zermatt.');
    for (const pick of alps.picks) expect(Math.max(seasonModelFor(pick).fit.hike_low[8]!.value, seasonModelFor(pick).fit.hike_high[8]!.value), pick.name).toBeGreaterThanOrEqual(0.5);
  });

  it('finds places for words no structured interest holds', () => {
    /* "Caves", "karst" and "underground rivers" are in no interest vocabulary: only the guides' own words can answer. */
    const caves = ask('Caves, karst and underground rivers, in April.');
    expect(caves.picks.length).toBe(3);
    expect(caves.picks.filter((pick) => pick.origin === 'atlas').length).toBeGreaterThanOrEqual(2);
    /* And where an interest *is* read beside them, the words still count: tea country is offered for tea. */
    const tea = ask('Tea plantations, misty hills and train rides, in February.');
    expect(tea.picks.length).toBe(3);
    expect(tea.readings).toContain('Rail journeys');
  });

  it('never offers the same ground twice', () => {
    for (const text of ['A spring cultural trip in Japan, temples, gardens and food, about 12 days in early April.', 'Remote hiking in Central Asia in August, I want to be far from crowds and I am fit.', 'A long weekend city break in Europe in May, good food and museums, flying from London.', 'Patagonia in January: glaciers, granite towers and long day hikes, about 12 nights.']) {
      const { picks, shortlist } = ask(text);
      const all = [...picks, ...shortlist.alternates.map((pick) => atlas.byId(pick.id)!)];
      for (let a = 0; a < all.length; a += 1) for (let b = a + 1; b < all.length; b += 1) expect(overlap(all[a]!, all[b]!), `${all[a]!.name} / ${all[b]!.name}`).toBeLessThan(1);
    }
  });

  it('says where each reading comes from', () => {
    const { shortlist } = ask('Remote monasteries and high passes in October.');
    for (const pick of [...shortlist.picks, ...shortlist.alternates]) {
      expect(pick.references.length, pick.name).toBeGreaterThan(0);
      if (pick.basis === 'editorial') continue;
      expect(pick.cost.label, pick.name).toContain('estimated');
      expect(pick.unverified.join(' '), pick.name).toContain('not checked by an editor');
      expect(pick.seasonNote ?? '', pick.name).toMatch(/usually|all year|no month/);
    }
    expect(shortlist.stats.catalog).toBe(atlas.size);
    expect(shortlist.stats.considered).toBeGreaterThan(50);
  });

  it('is deterministic', () => {
    const text = 'Remote mountains, incredible hiking, beautiful lakes, inexpensive, September, not too cold.';
    expect(ask(text).shortlist.picks.map((pick) => pick.id)).toEqual(ask(text).shortlist.picks.map((pick) => pick.id));
  });
});

describe('travel advisories', () => {
  it('removes a do-not-travel country while the snapshot is fresh, and only cautions once it is stale', () => {
    const manifest = JSON.parse(readFileSync(atlasPath()!.replace('atlas.json.gz', 'manifest.json'), 'utf8')) as { builtAt: string };
    const artifact = readAtlasArtifact(atlasPath()!);
    const level4 = Object.entries(artifact.advisories.levels).find(([, entry]) => entry.level === 4)?.[0];
    expect(level4).toBeDefined();
    const fresh = new Atlas(artifact, destinationCatalog(), { now: new Date(manifest.builtAt) });
    const stale = new Atlas(artifact, destinationCatalog(), { now: new Date(Date.parse(manifest.builtAt) + (ADVISORY_FRESH_DAYS + 30) * 86_400_000) });
    const inCountry = (world: Atlas) => world.all().find((destination) => destination.origin === 'atlas' && destination.countries[0] === level4)!;
    expect(inCountry(fresh).advisory?.level).toBe(4);
    expect(inCountry(stale).advisory?.level).toBe(3);
    expect(inCountry(stale).advisory?.asOf).toBe(inCountry(fresh).advisory?.asOf);
  });
});

describe('a thing the request names', () => {
  const NOW = new Date('2026-11-08T12:00:00Z');
  const picksFor = (text: string) => {
    const { atlas } = loadAtlas({ now: NOW })!;
    const base = { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month' as const, wantsRecommendation: false } };
    const parsed = parseTravelRequest(text, base, NOW, atlas);
    return { parsed, shortlist: buildAdvisorShortlist({ answers: parsed.answers, catalog: atlas, catalogVersion: atlas.version, now: NOW }) };
  };

  it('keeps gorillas to places written up for gorillas, and the general wildlife parks out of the primaries', () => {
    const { parsed, shortlist } = picksFor('Gorilla trekking in the drier months');
    expect(parsed.answers.discovery?.named?.length).toBeGreaterThan(0);
    const continents = shortlist.picks.map((pick) => pick.context);
    expect(continents.join(' ')).not.toMatch(/Alaska|Hokkaido|Australia/);
  });

  it('does not treat a safari as a thing to find in a guide: a zoo’s safari park is not one', () => {
    expect(picksFor('Safari in April').parsed.answers.discovery?.named).toBeUndefined();
  });
});

describe('the primary intent decides what may come first', () => {
  /* A blind evaluation: the advisor put a trekking region first while its own card said trekking "is not what a restful trip is for". */
  const OWNER = 'I want to go on a trip with my family over spring, March 19-29. Preferably a nice retreat. I want to feel good because life has been stressful recently. Outdoors stuff.';
  const RESTFUL_CATCH = /is not what a restful trip is for/;
  const answersFor = (text: string) => {
    const base = { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month' as const, wantsRecommendation: false } };
    return parseTravelRequest(text, base, NOW, atlas).answers;
  };
  const shortlistFor = (answers: ReturnType<typeof answersFor>) => buildAdvisorShortlist({ answers, catalog: atlas, catalogVersion: atlas.version, now: NOW });

  it('never ranks first a place whose own card says it is not what a restful trip is for, with or without the interview', () => {
    const owner = answersFor(OWNER);
    const mountains = answerAdvisorQuestion(owner, 'focus', ['mountains']);
    const variants = [owner, mountains, answerAdvisorQuestion(mountains, 'mountain_style', ['base_day_hikes']), answerAdvisorQuestion(answerAdvisorQuestion(owner, 'focus', ['mountains', 'lakes']), 'mountain_style', ['base_day_hikes'])];
    for (const answers of variants) {
      const shortlist = shortlistFor(answers);
      expect(shortlist.picks.length).toBeGreaterThan(0);
      for (const pick of shortlist.picks) expect(pick.tradeoffs.join(' '), pick.name).not.toMatch(RESTFUL_CATCH);
      /* Rest is the point, so every primary suits it — a mountain base, not a trek. */
      for (const pick of shortlist.picks) expect(pick.feel?.value ?? 0, pick.name).toBeGreaterThanOrEqual(0.75);
    }
  });

  it('answers "Day hikes from a base" for a restful trip with day-hiking places, not trek-built ones', () => {
    const answers = answerAdvisorQuestion(answerAdvisorQuestion(answersFor(OWNER), 'focus', ['mountains']), 'mountain_style', ['base_day_hikes']);
    for (const pick of shortlistFor(answers).picks) {
      const place = atlas.byId(pick.id)!;
      expect(place.experiences.day_hiking ?? 0, pick.name).toBeGreaterThanOrEqual(2);
      expect(place.experiences.multi_day_trekking ?? 0, pick.name).toBeLessThanOrEqual(place.experiences.day_hiking ?? 0);
    }
  });

  it('does not over-correct: a trekking request still leads with trekking regions', () => {
    const shortlist = shortlistFor(answersFor('Two weeks of multi-day trekking, hut to hut, in the high mountains in September.'));
    expect(atlas.byId(shortlist.picks[0]!.id)!.experiences.multi_day_trekking ?? 0).toBeGreaterThanOrEqual(2);
    for (const pick of shortlist.picks) expect(pick.tradeoffs.join(' ')).not.toMatch(RESTFUL_CATCH);
  });
});
