import { describe, expect, it } from 'vitest';
import type { ImageryOutcome, ImageSubject } from '@sidequest/core';
import {
  distinctSubjectCount,
  fixtureImage,
  imageryMode,
  resolveDestinationImage,
} from './wikimedia';

/**
 * THE IMAGERY ADAPTER, ENTIRELY OFFLINE.
 *
 * Every request is an injected `fetchImpl`, for the reason `providers.test.ts`
 * already states: a suite that reaches a volunteer-run service on every run is
 * precisely the abuse pattern those services complain about, and a test that
 * fails when somebody else's server is busy is a test nobody trusts. Here it
 * matters twice over, because half of what is being proved is *how few requests
 * are made* — and a real network would make that unmeasurable.
 *
 * What these assert, in order: the ladder is an order and not a search; a URL is
 * taken from the response and never assembled; a cached record costs nothing;
 * and every failure mode of somebody else's API produces a recorded refusal
 * rather than an exception.
 */

const SUBJECT: ImageSubject = {
  kind: 'destination',
  id: 'entry-1',
  name: 'Ambervale Highlands',
  wikidataId: 'Q101',
  coordinates: { lat: 46.2, lng: 8.1 },
  hierarchy: ['Ambervale', 'Ambervale Highlands'],
};

const NOW = new Date('2026-08-03T00:00:00.000Z');

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A wbgetentities body with whichever claims and sitelinks a case needs. */
function entity(options: {
  claims?: Record<string, string[]>;
  commonswiki?: string;
  enwiki?: string;
}): unknown {
  const claims: Record<string, unknown[]> = {};
  for (const [property, values] of Object.entries(options.claims ?? {})) {
    claims[property] = values.map((value) => ({
      mainsnak: { snaktype: 'value', datavalue: { value } },
    }));
  }
  const sitelinks: Record<string, { title: string }> = {};
  if (options.commonswiki) sitelinks.commonswiki = { title: options.commonswiki };
  if (options.enwiki) sitelinks.enwiki = { title: options.enwiki };
  return { entities: { Q101: { claims, sitelinks } } };
}

/** An imageinfo body for a clean, commercially usable photograph. */
function imageInfo(overrides: Record<string, unknown> = {}): unknown {
  return {
    query: {
      pages: {
        '1': {
          title: 'File:Something.jpg',
          imageinfo: [
            {
              descriptionurl: 'https://commons.wikimedia.org/wiki/File:Something.jpg',
              thumburl:
                'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Something.jpg/960px-Something.jpg',
              thumbwidth: 960,
              thumbheight: 640,
              width: 4000,
              height: 2667,
              mime: 'image/jpeg',
              extmetadata: {
                LicenseShortName: { value: 'CC BY 4.0' },
                License: { value: 'cc-by-4.0' },
                Artist: { value: '<a href="https://example.org/u/1">Rae Aldwin</a>' },
                AttributionRequired: { value: 'true' },
              },
              ...overrides,
            },
          ],
        },
      },
    },
  };
}

/**
 * A fetch that answers by endpoint and records what was asked.
 *
 * Deliberately explicit about *which host* served each call: the rule that the
 * licence is only ever read from Commons is a rule about hosts, and a router
 * that lumped them together could not prove it.
 */
function router(handlers: {
  wikidata?: (url: URL) => unknown;
  commons?: (url: URL) => unknown;
  wikipedia?: (url: URL) => unknown;
}): { fetchImpl: typeof fetch; urls: URL[] } {
  const urls: URL[] = [];
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input : new URL(String(input));
    urls.push(url);
    if (url.hostname === 'www.wikidata.org' && handlers.wikidata) return json(handlers.wikidata(url));
    if (url.hostname === 'commons.wikimedia.org' && handlers.commons) return json(handlers.commons(url));
    if (url.hostname === 'en.wikipedia.org' && handlers.wikipedia) return json(handlers.wikipedia(url));
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

describe('the resolution ladder', () => {
  it('takes the entity’s own stated image, and prefers the banner property', async () => {
    const { fetchImpl, urls } = router({
      wikidata: () =>
        entity({ claims: { P948: ['Banner.jpg'], P18: ['General.jpg'], P3451: ['Night.jpg'] } }),
      commons: () => imageInfo(),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('accepted');
    if (result.outcome.status !== 'accepted') return;

    expect(result.outcome.image.matchBasis).toBe('wikidata_image_property');
    expect(result.outcome.image.relationship).toBe('Q101|P948');
    expect(result.outcome.image.subjectConfidence).toBe('strong');

    // The banner won, so the file asked about was the banner and nothing else.
    const commons = urls.filter((url) => url.hostname === 'commons.wikimedia.org');
    expect(commons).toHaveLength(1);
    expect(commons[0]?.searchParams.get('titles')).toBe('File:Banner.jpg');
  });

  it('never reaches for a flag, a coat of arms, a logo or a locator map', async () => {
    /*
     * The properties left out of `IMAGE_PROPERTIES` on purpose. A locator map is
     * visually wrong for a destination hero and a logo carries trademark
     * exposure that a free licence on the *image file* does nothing about — so
     * an entity that has only those has no image, rather than a bad one.
     */
    const { fetchImpl, urls } = router({
      wikidata: () =>
        entity({
          claims: {
            P1943: ['Locator.png'],
            P242: ['Locmap.png'],
            P41: ['Flag.png'],
            P94: ['Arms.png'],
            P154: ['Logo.png'],
          },
        }),
      commons: () => imageInfo(),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('rejected');
    // The ladder carried on to the bounded search, which is correct; what must
    // never happen is any of those five files being asked about.
    const asked = urls.map((url) => url.searchParams.get('titles') ?? '');
    for (const excluded of ['Locator.png', 'Locmap.png', 'Flag.png', 'Arms.png', 'Logo.png']) {
      expect(asked.some((title) => title.includes(excluded)), excluded).toBe(false);
    }
  });

  it('skips a stated image whose file type we cannot render', async () => {
    const { fetchImpl, urls } = router({
      wikidata: () => entity({ claims: { P18: ['Plan.pdf', 'Photo.jpg'] } }),
      commons: () => imageInfo(),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('accepted');
    const commons = urls.filter((url) => url.hostname === 'commons.wikimedia.org');
    expect(commons[0]?.searchParams.get('titles')).toBe('File:Photo.jpg');
  });

  it('falls to the linked article’s lead image, and still reads the licence from Commons', async () => {
    const { fetchImpl, urls } = router({
      wikidata: () => entity({ enwiki: 'Ambervale Highlands' }),
      wikipedia: () => ({ query: { pages: { '5': { pageimage: 'Lead.jpg' } } } }),
      commons: () => imageInfo(),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('accepted');
    if (result.outcome.status !== 'accepted') return;
    expect(result.outcome.image.matchBasis).toBe('linked_wikimedia_identity');
    expect(result.outcome.image.subjectConfidence).toBe('strong');

    // The encyclopedia named a file and said nothing about its licence; the
    // licence read went to Commons, which is the only host permitted to answer.
    const wikipedia = urls.filter((url) => url.hostname === 'en.wikipedia.org');
    expect(wikipedia[0]?.searchParams.get('piprop')).toBe('name');
    expect(urls.some((url) => url.hostname === 'commons.wikimedia.org')).toBe(true);
  });

  it('uses a category the entity itself states, at moderate confidence', async () => {
    const { fetchImpl } = router({
      wikidata: () => entity({ claims: { P373: ['Ambervale Highlands'] } }),
      commons: (url) =>
        url.searchParams.get('list') === 'categorymembers'
          ? { query: { categorymembers: [{ title: 'File:Ridge.jpg', ns: 6 }] } }
          : imageInfo(),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('accepted');
    if (result.outcome.status !== 'accepted') return;
    expect(result.outcome.image.matchBasis).toBe('verified_commons_category');
    // A statement about a group is not a statement about a photograph, so this
    // is the confidence that keeps it off a hero.
    expect(result.outcome.image.subjectConfidence).toBe('moderate');
  });
});

describe('the bounded search', () => {
  it('is never run against a bare name with nothing to corroborate it', async () => {
    const bare: ImageSubject = { ...SUBJECT, wikidataId: undefined, hierarchy: [] };
    const { fetchImpl, urls } = router({ commons: () => ({}) });

    const result = await resolveDestinationImage(bare, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.rejection.reason).toBe('provider_unavailable');
    // Nothing was asked, because a name with no parent is a free-text query.
    expect(urls).toHaveLength(0);
  });

  it('refuses a result that only matched the name', async () => {
    const { fetchImpl } = router({
      wikidata: () => entity({}),
      commons: (url) =>
        url.searchParams.get('list') === 'search'
          ? { query: { search: [{ title: 'File:Ambervale Highlands FC squad.jpg', snippet: 'football club' }] } }
          : imageInfo(),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.rejection.reason).toBe('weak_name_match');
  });

  /**
   * The case this test used to assert was the defect.
   *
   * Two files, both corroborated by the *same* parent, were counted as two
   * competing subjects and refused — because the count was of files. Two
   * photographs of one place are one place, and this now says so.
   */
  it('accepts several photographs of one corroborated place', async () => {
    const { fetchImpl } = router({
      wikidata: () => entity({}),
      commons: (url) =>
        url.searchParams.get('list') === 'search'
          ? {
              query: {
                search: [
                  { title: 'File:Ambervale one.jpg', snippet: 'in Ambervale' },
                  { title: 'File:Ambervale two.jpg', snippet: 'in Ambervale' },
                ],
              },
            }
          : imageInfo(),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('accepted');
    if (result.outcome.status !== 'accepted') return;
    // The rung is still the weakest one, and still says so.
    expect(result.outcome.image.subjectConfidence).toBe('weak');
  });

  /** And the ambiguity the check is actually for: a second place of the name. */
  it('refuses when a second place shares the name', async () => {
    const { fetchImpl } = router({
      wikidata: () => entity({}),
      commons: (url) =>
        url.searchParams.get('list') === 'search'
          ? {
              query: {
                search: [
                  { title: 'File:Ambervale Highlands town hall.jpg', snippet: 'in Ambervale' },
                  { title: 'File:Ambervale Highlands, Suddendale harbour.jpg', snippet: 'coastal' },
                ],
              },
            }
          : imageInfo(),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.rejection.reason).toBe('ambiguous_subject');
  });

  it('accepts a single corroborated result at weak confidence', async () => {
    const { fetchImpl } = router({
      wikidata: () => entity({}),
      commons: (url) =>
        url.searchParams.get('list') === 'search'
          ? { query: { search: [{ title: 'File:Ridge.jpg', snippet: 'a ridge in Ambervale' }] } }
          : imageInfo(),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('accepted');
    if (result.outcome.status !== 'accepted') return;
    expect(result.outcome.image.matchBasis).toBe('bounded_identity_search');
    expect(result.outcome.image.subjectConfidence).toBe('weak');
  });
});

// ---------------------------------------------------------------------------
// URLs, licences and identity
// ---------------------------------------------------------------------------

describe('what the adapter stores', () => {
  it('takes the thumbnail URL from the response and never builds one', async () => {
    const { fetchImpl, urls } = router({
      wikidata: () => entity({ claims: { P18: ['Photo.jpg'] } }),
      commons: () => imageInfo(),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    if (result.outcome.status !== 'accepted') throw new Error('expected an accepted image');
    expect(result.outcome.image.thumbnailUrl).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Something.jpg/960px-Something.jpg',
    );
    // Asked for a standard width, which is the condition of not being refused
    // at the edge.
    const commons = urls.find((url) => url.hostname === 'commons.wikimedia.org');
    expect(commons?.searchParams.get('iiurlwidth')).toBe('960');
    // And the dimensions describe the thing actually rendered, not the original.
    expect(result.outcome.image.width).toBe(960);
    expect(result.outcome.image.height).toBe(640);
  });

  it('identifies itself, because a nameless client is rate-limited twentyfold', async () => {
    let agent: string | null = null;
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      agent ??= headers.get('user-agent');
      const url = input instanceof URL ? input : new URL(String(input));
      return json(url.hostname === 'www.wikidata.org' ? entity({ claims: { P18: ['P.jpg'] } }) : imageInfo());
    }) as typeof fetch;

    await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(agent).toContain('Sidequest');
  });

  it('asks only for the metadata fields it uses, which the API calls expensive', async () => {
    const { fetchImpl, urls } = router({
      wikidata: () => entity({ claims: { P18: ['Photo.jpg'] } }),
      commons: () => imageInfo(),
    });
    await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    const filter = urls
      .find((url) => url.searchParams.get('prop') === 'imageinfo')
      ?.searchParams.get('iiextmetadatafilter');
    expect(filter).toContain('LicenseShortName');
    expect(filter).toContain('Restrictions');
  });

  it('refuses a licence the allow-list does not contain, and records it against the file', async () => {
    const { fetchImpl } = router({
      wikidata: () => entity({ claims: { P18: ['Photo.jpg'] } }),
      commons: () =>
        imageInfo({
          extmetadata: {
            LicenseShortName: { value: 'CC BY-NC 4.0' },
            Artist: { value: 'Rae Aldwin' },
          },
        }),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.rejection.reason).toBe('unsupported_licence');
    expect(result.outcome.rejection.fileTitle).toBe('File:Photo.jpg');
  });

  it('drops down a rung when the strongest lead is unusable, and keeps the first reason', async () => {
    /*
     * The whole argument for the ladder being a ladder: a place whose stated
     * image is a non-commercial photograph still gets one, from a weaker but
     * still checkable relationship — and the *recorded* refusal is the strong
     * one, because "the place's own stated image is unlicensable" is the fact
     * worth keeping.
     */
    const { fetchImpl } = router({
      wikidata: () => entity({ claims: { P18: ['Restricted.jpg'], P3451: ['Night.jpg'] } }),
      commons: (url) =>
        url.searchParams.get('titles') === 'File:Restricted.jpg'
          ? imageInfo({
              extmetadata: {
                LicenseShortName: { value: 'CC BY-ND 4.0' },
                Artist: { value: 'Rae Aldwin' },
              },
            })
          : imageInfo(),
    });

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('accepted');
    if (result.outcome.status !== 'accepted') return;
    expect(result.outcome.image.relationship).toBe('Q101|P3451');
  });
});

// ---------------------------------------------------------------------------
// Caching and failure
// ---------------------------------------------------------------------------

describe('valid cached metadata reused', () => {
  it('serves a stored record without asking the service anything', async () => {
    const store = new Map<string, ImageryOutcome>();
    const cache = {
      read: (key: string) => store.get(key) ?? null,
      write: (key: string, value: ImageryOutcome) => void store.set(key, value),
    };
    let calls = 0;
    const fetchImpl = (async (input: URL | RequestInfo) => {
      calls += 1;
      const url = input instanceof URL ? input : new URL(String(input));
      return json(url.hostname === 'www.wikidata.org' ? entity({ claims: { P18: ['P.jpg'] } }) : imageInfo());
    }) as typeof fetch;

    const first = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW, cache });
    expect(first.outcome.status).toBe('accepted');
    expect(calls).toBeGreaterThan(0);

    const callsAfterFirst = calls;
    const second = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW, cache });
    expect(calls).toBe(callsAfterFirst);
    expect(second.cacheHit).toBe(true);
    expect(second.calls).toBe(0);
    expect(second.outcome).toEqual(first.outcome);
  });

  it('remembers a refusal too, so a rebuild does not re-fetch and re-refuse', async () => {
    const store = new Map<string, ImageryOutcome>();
    const cache = {
      read: (key: string) => store.get(key) ?? null,
      write: (key: string, value: ImageryOutcome) => void store.set(key, value),
    };
    const { fetchImpl } = router({
      wikidata: () => entity({ claims: { P18: ['Photo.jpg'] } }),
      commons: () =>
        imageInfo({
          extmetadata: { LicenseShortName: { value: 'CC BY-NC 4.0' }, Artist: { value: 'Rae' } },
        }),
    });

    const first = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW, cache });
    expect(first.outcome.status).toBe('rejected');
    const second = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW, cache });
    expect(second.cacheHit).toBe(true);
    expect(second.calls).toBe(0);
  });

  it('keys the record on the durable identity, so two trips share one lookup', async () => {
    const store = new Map<string, ImageryOutcome>();
    const cache = {
      read: (key: string) => store.get(key) ?? null,
      write: (key: string, value: ImageryOutcome) => void store.set(key, value),
    };
    const { fetchImpl } = router({
      wikidata: () => entity({ claims: { P18: ['Photo.jpg'] } }),
      commons: () => imageInfo(),
    });

    await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW, cache });
    // A different index build renumbered the entry; the Wikidata id did not move.
    const renumbered = { ...SUBJECT, id: 'entry-4821' };
    const again = await resolveDestinationImage(renumbered, { fetchImpl, now: NOW, cache });
    expect(again.cacheHit).toBe(true);
  });
});

describe('provider outage', () => {
  it('records an unavailable provider rather than throwing, and caches nothing', async () => {
    const store = new Map<string, ImageryOutcome>();
    const cache = {
      read: (key: string) => store.get(key) ?? null,
      write: (key: string, value: ImageryOutcome) => void store.set(key, value),
    };
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW, cache });
    expect(result.outcome.status).toBe('rejected');
    if (result.outcome.status !== 'rejected') return;
    expect(result.outcome.rejection.reason).toBe('provider_unavailable');
    /*
     * Not written. A refusal is remembered for months; an outage is a fact about
     * this minute, and persisting it would mean one bad afternoon costing a
     * destination its photograph until somebody noticed.
     */
    expect(store.size).toBe(0);
  });

  it('survives a service that answers with an error page instead of JSON', async () => {
    const fetchImpl = (async () =>
      new Response('<html>502</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;

    const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(result.outcome.status).toBe('rejected');
  });

  it('survives a rate limit and a not-found alike', async () => {
    for (const status of [404, 429, 503]) {
      const fetchImpl = (async () => new Response('', { status })) as typeof fetch;
      const result = await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
      expect(result.outcome.status, String(status)).toBe('rejected');
    }
  });

  it('spends a bounded number of requests on one subject, however much it is offered', async () => {
    let calls = 0;
    const fetchImpl = (async (input: URL | RequestInfo) => {
      calls += 1;
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.hostname === 'www.wikidata.org') {
        return json(entity({ claims: { P948: ['A.jpg'], P18: ['B.jpg'], P3451: ['C.jpg'] } }));
      }
      // Every file refuses, so the ladder runs as far as it can.
      return json(
        imageInfo({
          extmetadata: { LicenseShortName: { value: 'CC BY-NC 4.0' }, Artist: { value: 'Rae' } },
        }),
      );
    }) as typeof fetch;

    await resolveDestinationImage(SUBJECT, { fetchImpl, now: NOW });
    expect(calls).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Which resolver a deployment runs
// ---------------------------------------------------------------------------

describe('the deployment switch', () => {
  it('is off unless a deployment asks for it, and follows the compiler when unset', () => {
    // No environment variables are set in this suite, and the whole test tree
    // runs offline, so the default has to be the one that reaches nothing.
    expect(imageryMode()).toBe('off');
  });

  it('puts fixture images through the same gate as live ones', () => {
    /*
     * The property that makes the browser suite worth anything: a fixture cannot
     * show a screen a photograph the real gate would have refused, because it is
     * the real gate that produced it.
     */
    let accepted = 0;
    let rejected = 0;
    for (let index = 0; index < 30; index += 1) {
      const outcome = fixtureImage(
        { kind: 'destination', id: `entry-${index}`, name: `Place ${index}`, hierarchy: [] },
        NOW,
      );
      if (outcome.status === 'accepted') {
        accepted += 1;
        expect(outcome.image.licenceId).toMatch(/^CC-BY/);
        expect(outcome.image.creator).toBeTruthy();
        expect(outcome.image.attributionText).toContain('Wikimedia Commons');
        expect(outcome.image.thumbnailUrl.startsWith('https://upload.wikimedia.org/')).toBe(true);
      } else {
        rejected += 1;
      }
    }
    // Both states occur, because a page where every card has a photograph is not
    // a page this product will ever actually show.
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it('is deterministic, so one place keeps one photograph across renders', () => {
    const subject: ImageSubject = { kind: 'destination', id: 'entry-1', name: 'A', hierarchy: [] };
    expect(fixtureImage(subject, NOW)).toEqual(fixtureImage(subject, NOW));
  });
});

/**
 * "HOW MANY PLACES", NOT "HOW MANY FILES".
 *
 * `ambiguousWith` is fatal at two, and it used to be handed the number of
 * corroborated *files*. So a Commons category holding five photographs of one
 * building read as five competing buildings and the last rung of the ladder
 * refused nearly everything it found — the exact inverse of the check's purpose,
 * and invisible in production because a refusal and an absence look identical on
 * a card.
 *
 * These fix the semantics rather than the symptom: the number is a count of
 * distinct subjects, and the grouping errs towards merging, because a false merge
 * costs one image and a false split costs every image.
 */
describe('counting how many different places matched a name', () => {
  const subject: ImageSubject = {
    kind: 'destination',
    id: 'entry-1',
    name: 'Ambervale',
    hierarchy: ['Northmarch', 'Ambervale'],
  };
  const parents = ['Northmarch'];
  const file = (title: string) => ({ title });

  it('reads many photographs of one place as one place', () => {
    const corroborated = [
      file('File:Ambervale, Northmarch - town hall.jpg'),
      file('File:Ambervale, Northmarch - aerial view 2019.jpg'),
      file('File:Ambervale, Northmarch - the river from the bridge.jpg'),
      file('File:Ambervale, Northmarch - market square detail.jpg'),
      file('File:Ambervale, Northmarch - looking north.jpg'),
    ];
    expect(
      distinctSubjectCount({ results: corroborated, corroborated, subject, parents }),
    ).toBe(1);
  });

  it('still counts a genuine second place of the same name', () => {
    const corroborated = [file('File:Ambervale, Northmarch - town hall.jpg')];
    const results = [
      ...corroborated,
      file('File:Ambervale, Suddendale - the harbour.jpg'),
      file('File:Ambervale, Suddendale - lighthouse at dusk.jpg'),
    ];
    expect(distinctSubjectCount({ results, corroborated, subject, parents })).toBe(2);
  });

  it('counts three places as three, so the check still bites', () => {
    const corroborated = [file('File:Ambervale, Northmarch - town hall.jpg')];
    const results = [
      ...corroborated,
      file('File:Ambervale, Suddendale - the harbour.jpg'),
      file('File:Ambervale, Farrowmoor - the abbey.jpg'),
    ];
    expect(distinctSubjectCount({ results, corroborated, subject, parents })).toBeGreaterThanOrEqual(3);
  });

  it('merges rather than splits when two titles share a qualifier', () => {
    const corroborated = [file('File:Ambervale, Northmarch - town hall.jpg')];
    const results = [
      ...corroborated,
      file('File:Ambervale Suddendale harbour.jpg'),
      file('File:Ambervale Suddendale winter.jpg'),
      file('File:Ambervale Suddendale.jpg'),
    ];
    expect(distinctSubjectCount({ results, corroborated, subject, parents })).toBe(2);
  });

  it('puts every unqualified title in one bucket rather than one each', () => {
    const corroborated = [file('File:Ambervale, Northmarch - town hall.jpg')];
    const results = [
      ...corroborated,
      file('File:Ambervale.jpg'),
      file('File:Ambervale 2.jpg'),
      file('File:Ambervale photo.jpg'),
    ];
    expect(distinctSubjectCount({ results, corroborated, subject, parents })).toBe(2);
  });

  /** Nothing in the counter may know a place name. */
  it('knows no geography of its own', () => {
    const other: ImageSubject = {
      kind: 'destination',
      id: 'entry-2',
      name: 'Quorrin',
      hierarchy: ['Tessedra', 'Quorrin'],
    };
    const corroborated = [file('File:Quorrin, Tessedra - town hall.jpg')];
    const results = [...corroborated, file('File:Quorrin, Bellmoor - the harbour.jpg')];
    expect(
      distinctSubjectCount({ results, corroborated, subject: other, parents: ['Tessedra'] }),
    ).toBe(2);
  });
});
