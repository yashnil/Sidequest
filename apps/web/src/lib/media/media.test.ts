import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cropLoss, objectPositionFor, srcsetWidthsFor, standardWidthAtMost, COMMONS_STANDARD_WIDTHS } from './frame';
import { attentionFocal, candidatesFromInfoResponse, resolveMediaLive } from './resolve';
import { creditLine, locationVerdict, looksLikeNotAPhotograph, selectMedia, visualVerdict, type MediaCandidate, type MediaSubject } from './select';

/**
 * MEDIA SELECTION, ON RECORDED WIKIMEDIA ANSWERS (2026-11-12), FULLY OFFLINE.
 *
 * `fixtures/commons-media.json` holds the three responses `resolve.ts` asks for
 * (item statements, file info for stated files, depicts search) for four real
 * items, plus one unfiltered depicts answer that contains real flag maps. Image
 * downloads answer 404 here, so focal points are the assumed centre unless a
 * test injects one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(readFileSync(join(HERE, 'fixtures', 'commons-media.json'), 'utf8')) as Record<string, { claims: unknown; info?: unknown; depicts?: unknown }>;

const SVANETI: MediaSubject = { wikidataId: 'Q19044', name: 'Svaneti', center: { lat: 43.0, lng: 42.8 }, radiusKm: 50, scale: 'region' };
const ICELAND: MediaSubject = { wikidataId: 'Q189', name: 'Iceland', center: { lat: 64.96, lng: -19.02 }, radiusKm: 250, scale: 'region' };
const KAZBEGI: MediaSubject = { wikidataId: 'Q16508549', name: 'Kazbegi', center: { lat: 42.66, lng: 44.6 }, radiusKm: 30, scale: 'region' };
const TUSHETI: MediaSubject = { wikidataId: 'Q1142561', name: 'Tusheti', center: { lat: 42.4, lng: 45.6 }, radiusKm: 35, scale: 'region' };
const NOW = new Date('2026-11-12T12:00:00Z');

function recordedFetch(calls: string[] = []): typeof fetch {
  let qid = '';
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    const json = (body: unknown) => new Response(JSON.stringify(body ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'www.wikidata.org') {
      qid = url.searchParams.get('ids') ?? '';
      return json(FIXTURES[qid]?.claims);
    }
    if (url.hostname === 'commons.wikimedia.org') {
      const search = url.searchParams.get('gsrsearch');
      if (search) {
        const depicted = /P180=(Q\d+)/.exec(search)?.[1] ?? '';
        return json(FIXTURES[depicted]?.depicts ?? { batchcomplete: '' });
      }
      return json(FIXTURES[qid]?.info ?? {});
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
}

let previousMode: string | undefined;
beforeEach(() => {
  previousMode = process.env.SIDEQUEST_IMAGERY_PROVIDER;
});
afterEach(() => {
  if (previousMode === undefined) delete process.env.SIDEQUEST_IMAGERY_PROVIDER;
  else process.env.SIDEQUEST_IMAGERY_PROVIDER = previousMode;
});

describe('selection on recorded answers', () => {
  it('Svaneti: the portrait P18 cannot be a hero; the depicts photograph is; the banner is the strip', async () => {
    const calls: string[] = [];
    const { selections, calls: count } = await resolveMediaLive(SVANETI, { fetchImpl: recordedFetch(calls), now: NOW });
    expect(count).toBe(calls.length);
    // Three API questions, then one rendition per distinct selected file.
    expect(calls.filter((url) => url.includes('/w/api.php'))).toHaveLength(3);
    // Never a free-text search: the only search is the depicts statement on the QID.
    for (const url of calls) {
      const params = new URL(url).searchParams;
      expect(params.has('srsearch')).toBe(false);
      if (params.has('gsrsearch')) expect(params.get('gsrsearch')).toMatch(/^haswbstatement:P180=Q19044\b/);
    }

    const hero = selections.hero;
    expect(hero.status).toBe('selected');
    if (hero.status !== 'selected') return;
    expect(hero.image.fileTitle).toBe('File:Svaneti, Georgia. 2018 117.jpg');
    expect(hero.origin).toBe('P180');
    expect(hero.image.licenceName).toMatch(/Attribution 2\.0/);
    expect(hero.rejected.find((entry) => entry.fileTitle === 'File:Svanetiskt torn.jpg')?.reason).toBe('wrong_shape');
    // Standard widths only, none above the original, the hero served up to 1920.
    expect(hero.sources.map((source) => source.width)).toEqual([330, 500, 960, 1280, 1920]);
    for (const source of hero.sources) expect(source.url).toMatch(new RegExp(`/${source.width}px-`));
    expect(hero.focalBasis).toBe('centre');

    // The banner's recorded credit carries markup the shared licence gate refuses, so the strip falls to the photograph.
    const strip = selections.strip;
    expect(strip.rejected.find((entry) => entry.fileTitle === 'File:Ushguli (Svaneti, Georgia) banner.jpg')?.detail).toMatch(/^active_content/);
    expect(strip.status === 'selected' && strip.image.fileTitle).toBe('File:Svaneti, Georgia. 2018 117.jpg');

    // The portrait is the right shape for a square, but its page names no author the gate can credit.
    const thumb = selections.thumb;
    expect(thumb.rejected.find((entry) => entry.fileTitle === 'File:Svanetiskt torn.jpg')?.detail).toMatch(/^incomplete_attribution|^missing_licence|^unsupported_licence/);
    expect(thumb.status === 'selected' && thumb.image.fileTitle).toBe('File:Svaneti, Georgia. 2018 117.jpg');
  });

  it('Iceland: a depicts file taken in another country is refused as outside the place', async () => {
    const { selections } = await resolveMediaLive(ICELAND, { fetchImpl: recordedFetch(), now: NOW, measureFocal: false });
    const hero = selections.hero;
    const rejected = hero.rejected;
    const lighthouse = rejected.find((entry) => entry.fileTitle.includes('Kjeungskjær'));
    expect(lighthouse?.reason).toBe('outside_place');
    expect(hero.status).toBe('selected');
    if (hero.status === 'selected') {
      expect(hero.image.fileTitle).not.toContain('Kjeungskjær');
      // Share-alike, accepted and flagged so print shows it whole.
      expect(hero.shareAlike).toBe(true);
      expect(hero.image.useTier).toBe('display_unmodified');
      expect(hero.image.attributionText).toMatch(/ShareAlike/);
    }
    // The travel-guide banner, cut 7:1 for exactly this use, is the strip.
    const strip = selections.strip;
    expect(strip.status === 'selected' && strip.origin).toBe('P948');
  });

  it('Tusheti: an 800 px original is a thumbnail, never a card or a hero; a PNG banner is never anything', async () => {
    const { selections } = await resolveMediaLive(TUSHETI, { fetchImpl: recordedFetch(), now: NOW, measureFocal: false });
    expect(selections.hero.status).toBe('none');
    expect(selections.card.status).toBe('none');
    if (selections.card.status === 'none') {
      expect(selections.card.reason).toBe('all_rejected');
      expect(selections.card.rejected.find((entry) => entry.fileTitle === 'File:Tusheti, kvavlo.jpg')?.reason).toBe('too_small');
    }
    expect(selections.strip.rejected.find((entry) => entry.fileTitle.endsWith('.png'))?.reason).toBe('not_jpeg');
    const thumb = selections.thumb;
    expect(thumb.status).toBe('selected');
    if (thumb.status === 'selected') {
      expect(thumb.sources).toEqual([{ width: 330, url: expect.stringContaining('/330px-') }]);
      expect(thumb.image.width).toBe(330);
    }
  });

  it('Kazbegi: the item’s own CC BY panorama leads the hero and the card', async () => {
    const { selections } = await resolveMediaLive(KAZBEGI, { fetchImpl: recordedFetch(), now: NOW, measureFocal: false });
    for (const context of ['hero', 'card'] as const) {
      const selection = selections[context];
      expect(selection.status).toBe('selected');
      if (selection.status === 'selected') {
        expect(selection.origin).toBe('P18');
        expect(selection.shareAlike).toBe(false);
      }
    }
  });

  it('flag maps and ethnic maps that really carry a depicts statement are refused as not photographs', () => {
    const candidates = candidatesFromInfoResponse(FIXTURES['unfiltered-depicts-Q19044'], 'P180');
    const maps = candidates.filter((candidate) => /map/i.test(candidate.fileTitle));
    expect(maps.length).toBeGreaterThanOrEqual(3);
    for (const map of maps) expect(visualVerdict(map, 'thumb')?.reason).toBe('not_a_photograph');
    const selection = selectMedia(SVANETI, candidates, 'hero', { retrievedAt: NOW.toISOString(), provider: 'test' });
    expect(selection.status === 'selected' && selection.image.fileTitle).toBe('File:Svaneti, Georgia. 2018 117.jpg');
  });

  it('a 429 is provider_unavailable everywhere, which the repository never stores', async () => {
    const busy = (async () => new Response('You are making too many requests', { status: 429 })) as typeof fetch;
    const { selections } = await resolveMediaLive(SVANETI, { fetchImpl: busy, now: NOW });
    for (const selection of Object.values(selections)) {
      expect(selection.status).toBe('none');
      if (selection.status === 'none') expect(selection.reason).toBe('provider_unavailable');
    }
  });

  it('no identity is a typed none, with no request made', async () => {
    const calls: string[] = [];
    const { selections } = await resolveMediaLive({ wikidataId: '', name: 'Somewhere' }, { fetchImpl: recordedFetch(calls) });
    expect(calls).toHaveLength(0);
    expect(selections.card.status === 'none' && selections.card.reason).toBe('no_identity');
  });

  it('an injected focal point is recorded as measured', async () => {
    const { selections } = await resolveMediaLive(SVANETI, {
      fetchImpl: (async (input: string | URL | Request) => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (href.includes('/500px-')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
        return recordedFetch()(input);
      }) as typeof fetch,
      focalOf: async () => ({ x: 0.8, y: 0.3 }),
      now: NOW,
    });
    const hero = selections.hero;
    expect(hero.status === 'selected' && hero.focalBasis).toBe('attention');
    expect(hero.status === 'selected' && hero.focal).toEqual({ x: 0.8, y: 0.3 });
  });
});

describe('the gate, case by case', () => {
  const base: MediaCandidate = {
    fileTitle: 'File:Valley at dawn.jpg',
    source: 'P18',
    order: 0,
    filePageUrl: 'https://commons.wikimedia.org/wiki/File:Valley_at_dawn.jpg',
    originalUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Valley_at_dawn.jpg',
    thumbUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Valley_at_dawn.jpg/330px-Valley_at_dawn.jpg',
    width: 4000,
    height: 2667,
    mediaType: 'image/jpeg',
    metadata: { licenceShortName: 'CC BY-SA 4.0', artist: 'A. Photographer', attributionRequired: 'true' },
    categories: ['Valleys in Somewhere', 'Files with coordinates missing SDC location of creation'],
    coordinates: [],
  };
  const options = { retrievedAt: NOW.toISOString(), provider: 'test' };
  const subject: MediaSubject = { wikidataId: 'Q42', name: 'Somewhere', center: { lat: 10, lng: 10 }, radiusKm: 20 };

  it('words that mean "not a photograph" match whole words only, and skip maintenance categories', () => {
    expect(looksLikeNotAPhotograph('File:Coat of arms of Somewhere.jpg', [])).toMatch(/coat of arms/i);
    expect(looksLikeNotAPhotograph('File:Somewhere locator map.jpg', [])).toBeTruthy();
    expect(looksLikeNotAPhotograph('File:Flag of Somewhere.jpg', [])).toBeTruthy();
    expect(looksLikeNotAPhotograph('File:Planet rise over the plantation.jpg', [])).toBeNull();
    expect(looksLikeNotAPhotograph('File:Lake.jpg', ['Maps of Somewhere'])).toMatch(/Maps of Somewhere/);
    expect(looksLikeNotAPhotograph('File:Lake.jpg', ['Pages with maps'])).toBeNull();
  });

  it('too small and wrong shape are separate, honest reasons', () => {
    expect(visualVerdict({ ...base, width: 1600, height: 1000 }, 'hero')?.reason).toBe('too_small');
    expect(visualVerdict({ ...base, width: 2000, height: 3000 }, 'hero')?.reason).toBe('wrong_shape');
    expect(visualVerdict({ ...base, mediaType: 'image/png' }, 'card')?.reason).toBe('not_jpeg');
    expect(visualVerdict(base, 'hero')).toBeNull();
  });

  it('a share-alike photograph is accepted, credited and flagged', () => {
    const selection = selectMedia(subject, [base], 'card', options);
    expect(selection.status).toBe('selected');
    if (selection.status !== 'selected') return;
    expect(selection.shareAlike).toBe(true);
    expect(selection.image.attributionText).toBe('A. Photographer, Creative Commons Attribution-ShareAlike 4.0, Wikimedia Commons');
    expect(creditLine(selection.image)).toBe('A. Photographer · CC BY-SA 4.0');
    // Card frames are drawn up to 640 CSS px: renditions stop at 1280.
    expect(selection.sources.map((source) => source.width)).toEqual([330, 500, 960, 1280]);
  });

  it('a non-commercial file never passes, however good it looks', () => {
    const selection = selectMedia(subject, [{ ...base, metadata: { ...base.metadata, licenceShortName: 'CC BY-NC 4.0' } }], 'hero', options);
    expect(selection.status).toBe('none');
    if (selection.status === 'none') expect(selection.rejected[0]?.reason).toBe('licence_gate');
  });

  it('ranks the item’s own image over a depicts file, and a free licence over share-alike at equal quality', () => {
    const depicts: MediaCandidate = { ...base, fileTitle: 'File:Somewhere ridge.jpg', source: 'P180', categories: ['Somewhere'] };
    expect(selectMedia(subject, [depicts, base], 'hero', options)).toMatchObject({ status: 'selected', origin: 'P18' });
    const free: MediaCandidate = { ...base, fileTitle: 'File:Valley at noon.jpg', metadata: { ...base.metadata, licenceShortName: 'CC BY 4.0' } };
    expect(selectMedia(subject, [base, free], 'hero', options)).toMatchObject({ status: 'selected', shareAlike: false });
  });

  it('location: outside the extent is refused; a depicts file with no location must name the place', () => {
    expect(locationVerdict({ ...base, coordinates: [{ lat: 30, lng: 30 }] }, subject)?.reason).toBe('outside_place');
    expect(locationVerdict({ ...base, coordinates: [{ lat: 10.1, lng: 10.1 }] }, subject)).toBeNull();
    expect(locationVerdict({ ...base, source: 'P180', categories: ['Valleys'] }, subject)?.reason).toBe('unverified_location');
    expect(locationVerdict({ ...base, source: 'P180', categories: ['Valleys in Somewhere'] }, subject)).toBeNull();
    // The item's own statement is not second-guessed when it states no location.
    expect(locationVerdict({ ...base, categories: [] }, subject)).toBeNull();
  });

  it('an empty pool and a missing identity are different nones', () => {
    expect(selectMedia(subject, [], 'card', options)).toMatchObject({ status: 'none', reason: 'no_candidates' });
    expect(selectMedia({ wikidataId: 'nope', name: 'x' }, [base], 'card', options)).toMatchObject({ status: 'none', reason: 'no_identity' });
  });
});

describe('frame arithmetic', () => {
  it('only standard widths, never above the original', () => {
    expect(standardWidthAtMost(1000)).toBe(960);
    expect(standardWidthAtMost(10)).toBeNull();
    expect(srcsetWidthsFor('hero', 1500)).toEqual([330, 500, 960, 1280]);
    for (const width of srcsetWidthsFor('strip', 99999)) expect(COMMONS_STANDARD_WIDTHS).toContain(width);
  });

  it('object-position keeps the focal point in view and clamps at the edges', () => {
    // 3:2 photograph in a 16:9 frame overflows vertically.
    expect(objectPositionFor({ x: 0.5, y: 0.5 }, 1.5, 16 / 9)).toBe('50% 50%');
    expect(objectPositionFor({ x: 0.5, y: 0 }, 1.5, 16 / 9)).toBe('50% 0%');
    expect(objectPositionFor({ x: 0.5, y: 1 }, 1.5, 16 / 9)).toBe('50% 100%');
    // 7:1 banner in a 16:9 frame overflows horizontally; a subject at 90 % pins the right edge.
    expect(objectPositionFor({ x: 0.9, y: 0.5 }, 7, 16 / 9)).toBe('100% 50%');
    // A focal point a quarter of the way across a wide file.
    const position = objectPositionFor({ x: 0.25, y: 0.5 }, 3, 1);
    expect(Number.parseFloat(position)).toBeCloseTo(12.5, 0);
    expect(cropLoss(4 / 3, 16 / 9)).toBeCloseTo(0.25, 2);
  });

  it('sharp attention finds a saturated subject away from the centre', async () => {
    const sharp = (await import('sharp')).default;
    const width = 500;
    const height = 333;
    const pixels = Buffer.alloc(width * height * 3, 128);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 3;
        const noise = ((x * 7 + y * 13) % 17) - 8;
        pixels[index] = 120 + noise;
        pixels[index + 1] = 122 + noise;
        pixels[index + 2] = 125 + noise;
        if ((x - 420) ** 2 + (y - 90) ** 2 < 40 ** 2) {
          pixels[index] = 230;
          pixels[index + 1] = 150;
          pixels[index + 2] = 110;
        }
      }
    }
    const jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
    const focal = await attentionFocal(new Uint8Array(jpeg));
    expect(focal).not.toBeNull();
    expect(focal!.x).toBeGreaterThan(0.6);
  });
});
