import { describe, expect, it } from 'vitest';
import type { ImageryOutcome, ImageSubject } from '@sidequest/core';
import { imagerySubjectKey } from '@sidequest/core';
import { resolveImageryForSubjects } from '@/lib/providers/wikimedia';

/**
 * THE LINK THAT WAS MISSING, TESTED OFFLINE.
 *
 * The imagery pipeline shipped complete except for one thing: nothing anywhere
 * resolved a `kind: 'candidate'` subject. Twelve live compilations left
 * `destination_images` empty and every board card wearing a grey plate, while
 * the board's read path patiently looked photographs up in a table nobody wrote
 * to.
 *
 * These prove the properties the board's bounded pass depends on, with an
 * injected `fetch` and no network. That is not optional here: this is a
 * volunteer-run service, a suite that reaches it on every run is the abuse
 * pattern their API etiquette names, and half of what is being proved is *how
 * many requests are made* — which a real network makes unmeasurable.
 */

const NOW = new Date('2026-08-11T00:00:00.000Z');

function subject(id: string, wikidataId?: string): ImageSubject {
  return {
    kind: 'candidate',
    id,
    name: `Place ${id}`,
    ...(wikidataId ? { wikidataId } : {}),
    coordinates: { lat: 35.68, lng: 139.76 },
    hierarchy: ['Tokyo'],
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A Wikidata entity that names its own photograph. The ladder's strongest rung. */
function entityWithImage(qid: string): unknown {
  return {
    entities: {
      [qid]: {
        claims: {
          P18: [{ mainsnak: { snaktype: 'value', datavalue: { value: `${qid}.jpg` } } }],
        },
        sitelinks: {},
      },
    },
  };
}

function imageInfo(licence: string): unknown {
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
                LicenseShortName: { value: licence },
                Artist: { value: 'A photographer' },
                AttributionRequired: { value: 'true' },
              },
            },
          ],
        },
      },
    },
  };
}

/** The store, in memory, with the same read/write contract the table has. */
function memoryCache() {
  const rows = new Map<string, ImageryOutcome>();
  return {
    rows,
    read: (key: string) => rows.get(key) ?? null,
    write: (_key: string, value: ImageryOutcome) => {
      const stored = value.status === 'accepted' ? value.image.subject : value.rejection.subject;
      // Keyed off the record's own subject, exactly as the repository does: a
      // mismatch would file one place's photograph under another place's key.
      rows.set(imagerySubjectKey(stored), value);
    },
  };
}

function stubFetch(licence = 'CC BY 4.0') {
  let calls = 0;
  const impl = (async (input: URL | RequestInfo) => {
    calls += 1;
    const url = String(input);
    const qid = /Q\d+/.exec(url)?.[0];
    if (url.includes('wbgetentities') && qid) return json(entityWithImage(qid));
    if (url.includes('prop=imageinfo')) return json(imageInfo(licence));
    // Anything else — a category listing, a search — comes back empty, which is
    // what forces the strongest rung to be the one that resolves.
    return json({});
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

describe('the board imagery pass', () => {
  it('resolves candidate subjects and writes what it decided', async () => {
    const cache = memoryCache();
    const { impl } = stubFetch();

    const result = await resolveImageryForSubjects(
      [subject('a', 'Q1'), subject('b', 'Q2')],
      { cache, fetchImpl: impl, now: NOW },
    );

    expect(result.resolved).toBe(2);
    expect(result.accepted).toBe(2);
    expect(cache.rows.size).toBe(2);
    for (const outcome of cache.rows.values()) {
      expect(outcome.status).toBe('accepted');
      if (outcome.status !== 'accepted') continue;
      // Attribution survives the round trip, which is the whole obligation.
      expect(outcome.image.attributionText).toContain('Wikimedia Commons');
      expect(outcome.image.subject.kind).toBe('candidate');
      // Strong enough for a card. A weak match is never displayed.
      expect(outcome.image.subjectConfidence).not.toBe('weak');
    }
  });

  it('stays inside its limit however many cards a board has', async () => {
    /*
     * The board runs this on a page view. Forty candidates times six requests
     * apiece would be a burst nobody asked for at a service that asks clients
     * not to burst.
     */
    const cache = memoryCache();
    const { impl } = stubFetch();
    const many = Array.from({ length: 40 }, (_, index) => subject(`p${index}`, `Q${index + 1}`));

    const result = await resolveImageryForSubjects(many, {
      cache,
      fetchImpl: impl,
      now: NOW,
      limit: 10,
    });

    expect(result.resolved).toBe(10);
    expect(cache.rows.size).toBe(10);
  });

  it('costs nothing the second time, which is what makes the pass terminate', async () => {
    const cache = memoryCache();
    const first = stubFetch();
    const subjects = [subject('a', 'Q1'), subject('b', 'Q2')];

    await resolveImageryForSubjects(subjects, { cache, fetchImpl: first.impl, now: NOW });
    const spent = first.calls();
    expect(spent).toBeGreaterThan(0);

    const second = stubFetch();
    const again = await resolveImageryForSubjects(subjects, {
      cache,
      fetchImpl: second.impl,
      now: NOW,
    });
    expect(second.calls()).toBe(0);
    expect(again.accepted).toBe(2);
  });

  it('records a licence refusal rather than showing the file', async () => {
    /*
     * The refusal is the half that matters for cost as well as for law: a file
     * refused and not written down is a file every subsequent visit fetches,
     * checks and refuses again.
     */
    const cache = memoryCache();
    const { impl } = stubFetch('CC BY-NC 4.0');

    const result = await resolveImageryForSubjects([subject('a', 'Q1')], {
      cache,
      fetchImpl: impl,
      now: NOW,
    });

    expect(result.accepted).toBe(0);
    const stored = cache.rows.get('candidate:Q1');
    expect(stored?.status).toBe('rejected');
    if (stored?.status === 'rejected') {
      expect(stored.rejection.reason).toBe('unsupported_licence');
    }
  });

  it('survives a provider that falls over, and never takes the page with it', async () => {
    const cache = memoryCache();
    const exploding = (async () => {
      throw new Error('connection reset');
    }) as unknown as typeof fetch;

    const result = await resolveImageryForSubjects([subject('a', 'Q1')], {
      cache,
      fetchImpl: exploding,
      now: NOW,
    });

    expect(result.accepted).toBe(0);
    // A transient outage is a fact about this minute. Persisting it would cost a
    // place its photograph for ninety days because of one bad afternoon.
    const stored = cache.rows.get('candidate:Q1');
    if (stored?.status === 'rejected') {
      expect(stored.rejection.reason).toBe('provider_unavailable');
    }
  });
});
