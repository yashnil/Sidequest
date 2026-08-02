import { describe, expect, it } from 'vitest';
import {
  assessFreshness,
  canonicalizeUrl,
  changeClassFor,
  discoveryKeyFor,
  extractionKeyFor,
  fastestClass,
  isSameSite,
  isUsableDigest,
  isVaryCompatible,
  needsFullReread,
  needsRevalidation,
  normaliseName,
  representationEnvelope,
  reuseShare,
  sourceIdFor,
  stableHash,
  subjectKeyFor,
  emptyReuseReport,
  REDACTED_PARAM_VALUE,
  type ExtractionKeyInput,
  type DiscoveryKeyInput,
} from '../index';
import { FACT_PATHS, type FactPath } from '../schemas/source-fact';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const TRIP = ['2026-09-10', '2026-09-11', '2026-09-12'];

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

describe('canonicalizeUrl', () => {
  it('normalises scheme, host and default port without touching meaningful query keys', () => {
    const canonical = canonicalizeUrl('HTTPS://Www.Museum.ORG:443/visit//plan?lang=ja&date=2026-09-10#tickets');
    expect(canonical?.url).toBe('https://www.museum.org/visit/plan?date=2026-09-10&lang=ja');
    expect(canonical?.host).toBe('www.museum.org');
    expect(canonical?.origin).toBe('https://www.museum.org');
  });

  it('drops tracking parameters and keeps everything else', () => {
    const canonical = canonicalizeUrl('https://a.example/p?utm_source=x&fbclid=y&ticket=adult');
    expect(canonical?.url).toBe('https://a.example/p?ticket=adult');
    expect(canonical?.droppedParams.sort()).toEqual(['fbclid', 'utm_source']);
  });

  it('never drops a parameter that selects a representation', () => {
    // The tempting global rule — strip the query — would merge these two.
    const a = canonicalizeUrl('https://ferry.example/timetable?service=summer');
    const b = canonicalizeUrl('https://ferry.example/timetable?service=winter');
    expect(a?.url).not.toBe(b?.url);
  });

  it('redacts secret-bearing values but keeps the key', () => {
    const canonical = canonicalizeUrl('https://a.example/p?token=super-secret&page=2');
    expect(canonical?.url).toContain(`token=${REDACTED_PARAM_VALUE}`);
    expect(canonical?.url).not.toContain('super-secret');
    expect(canonical?.redactedParams).toEqual(['token']);
  });

  it('strips credentials and says so', () => {
    const canonical = canonicalizeUrl('https://user:pass@a.example/p');
    expect(canonical?.url).toBe('https://a.example/p');
    expect(canonical?.warnings.join(' ')).toContain('Credentials');
  });

  it('flags punycode and non-default ports rather than silently accepting them', () => {
    const puny = canonicalizeUrl('https://xn--mller-kva.example/');
    expect(puny?.warnings.join(' ')).toContain('internationalised');
    const port = canonicalizeUrl('https://a.example:8443/p');
    expect(port?.warnings.join(' ')).toContain('8443');
  });

  it('refuses anything that is not http(s)', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('file:///etc/passwd')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
  });

  it('gives one id to two orderings of the same query', () => {
    const a = canonicalizeUrl('https://a.example/p?b=2&a=1')!;
    const b = canonicalizeUrl('https://a.example/p?a=1&b=2')!;
    expect(sourceIdFor(a)).toBe(sourceIdFor(b));
  });
});

describe('isSameSite', () => {
  it('accepts a www prefix and a subdomain, and refuses a lookalike', () => {
    expect(isSameSite('www.museum.org', 'museum.org')).toBe(true);
    expect(isSameSite('tickets.museum.org', 'museum.org')).toBe(true);
    // The canonical-poisoning case: a page claiming another domain is canonical.
    expect(isSameSite('museum.org', 'museum-tickets.example')).toBe(false);
    expect(isSameSite('museum.org', 'evil.example')).toBe(false);
  });
});

describe('content digests', () => {
  it('accepts a supported algorithm and refuses an unknown one', () => {
    expect(isUsableDigest(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isUsableDigest(`blake3:${'a'.repeat(64)}`)).toBe(false);
    expect(isUsableDigest('sha256:NOTHEX')).toBe(false);
    expect(isUsableDigest(undefined)).toBe(false);
  });

  it('makes a truncated read a different representation from a whole one', () => {
    const whole = representationEnvelope({
      text: 'open daily',
      structuredData: [],
      truncated: false,
      mimeType: 'text/html',
    });
    const cut = representationEnvelope({
      text: 'open daily',
      structuredData: [],
      truncated: true,
      mimeType: 'text/html',
    });
    expect(whole).not.toBe(cut);
  });

  it('survives unserialisable structured data rather than throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      representationEnvelope({
        text: 'x',
        structuredData: [circular],
        truncated: false,
        mimeType: 'text/html',
      }),
    ).not.toThrow();
  });
});

describe('subject identity', () => {
  it('is the same for two compilations of the same place', () => {
    const a = subjectKeyFor({ name: 'Musée d’Orsay', coordinates: { lat: 48.86, lng: 2.3266 } });
    const b = subjectKeyFor({ name: 'Musee d Orsay', coordinates: { lat: 48.86001, lng: 2.32661 } });
    expect(a).toBe(b);
  });

  it('distinguishes two neighbouring venues', () => {
    const a = subjectKeyFor({ name: 'Cafe One', coordinates: { lat: 48.86, lng: 2.3266 } });
    const b = subjectKeyFor({ name: 'Cafe Two', coordinates: { lat: 48.86, lng: 2.3266 } });
    expect(a).not.toBe(b);
  });

  it('prefers a stable external id when there is one', () => {
    const key = subjectKeyFor({
      name: 'Anything',
      coordinates: { lat: 0, lng: 0 },
      externalId: '08f2a3b4c5',
    });
    expect(key).toBe('subj:ext:08f2a3b4c5');
  });

  it('folds diacritics and punctuation but not distinct words', () => {
    expect(normaliseName('Château d’If')).toBe('chateau-d-if');
    expect(normaliseName('Chateau dIf')).not.toBe(normaliseName('Chateau d If'));
  });
});

describe('cache keys', () => {
  const baseDiscovery: DiscoveryKeyInput = {
    subjectKey: 'subj:geo:museum@1.0000,2.0000',
    wantedPaths: ['hours.weekly', 'cost.admission'],
    provider: 'search',
    providerVersion: 'v1',
  };

  it('is insensitive to the order of wanted paths', () => {
    expect(discoveryKeyFor(baseDiscovery)).toBe(
      discoveryKeyFor({ ...baseDiscovery, wantedPaths: ['cost.admission', 'hours.weekly'] }),
    );
  });

  it('changes when any input changes', () => {
    const base = discoveryKeyFor(baseDiscovery);
    expect(discoveryKeyFor({ ...baseDiscovery, subjectKey: 'other' })).not.toBe(base);
    expect(discoveryKeyFor({ ...baseDiscovery, wantedPaths: ['hours.weekly'] })).not.toBe(base);
    expect(discoveryKeyFor({ ...baseDiscovery, locale: 'ja' })).not.toBe(base);
    expect(discoveryKeyFor({ ...baseDiscovery, provider: 'other' })).not.toBe(base);
    expect(discoveryKeyFor({ ...baseDiscovery, providerVersion: 'v2' })).not.toBe(base);
  });

  const baseExtraction: ExtractionKeyInput = {
    operation: 'extract-planning-facts',
    contentDigests: [`sha256:${'a'.repeat(64)}`],
    schemaVersion: 'planning-extraction/1',
    promptVersion: 'extract-facts/2026-08-01.1',
    modelId: 'claude-opus-5',
    parserVersion: 'parsers/1',
    wantedPaths: ['hours.weekly'],
  };

  it('every extraction input participates in the key', () => {
    const base = extractionKeyFor(baseExtraction);
    const variants: ExtractionKeyInput[] = [
      { ...baseExtraction, operation: 'other' },
      { ...baseExtraction, contentDigests: [`sha256:${'b'.repeat(64)}`] },
      { ...baseExtraction, schemaVersion: 'planning-extraction/2' },
      { ...baseExtraction, promptVersion: 'extract-facts/2026-09-01.1' },
      { ...baseExtraction, modelId: 'claude-sonnet-5' },
      { ...baseExtraction, parserVersion: 'parsers/2' },
      { ...baseExtraction, wantedPaths: ['cost.admission'] },
    ];
    for (const variant of variants) {
      expect(extractionKeyFor(variant)).not.toBe(base);
    }
  });

  it('is stable across digest ordering', () => {
    const a = extractionKeyFor({
      ...baseExtraction,
      contentDigests: [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`],
    });
    const b = extractionKeyFor({
      ...baseExtraction,
      contentDigests: [`sha256:${'b'.repeat(64)}`, `sha256:${'a'.repeat(64)}`],
    });
    expect(a).toBe(b);
  });

  it('hashes distinctly enough for a development store', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 5_000; index += 1) seen.add(stableHash(`key-${index}`));
    expect(seen.size).toBe(5_000);
  });
});

describe('Vary compatibility', () => {
  const pinned = ['accept', 'accept-encoding', 'user-agent'];

  it('reuses when Vary names only headers we pin', () => {
    expect(isVaryCompatible(undefined, pinned)).toBe(true);
    expect(isVaryCompatible('Accept-Encoding', pinned)).toBe(true);
    expect(isVaryCompatible('Accept, Accept-Encoding', pinned)).toBe(true);
  });

  it('refuses to reuse a negotiated representation we cannot reproduce', () => {
    expect(isVaryCompatible('Accept-Language', pinned)).toBe(false);
    expect(isVaryCompatible('*', pinned)).toBe(false);
    expect(isVaryCompatible('Cookie', pinned)).toBe(false);
  });
});

describe('freshness', () => {
  it('assigns every fact path a change class', () => {
    for (const path of FACT_PATHS) {
      expect(() => changeClassFor(path as FactPath)).not.toThrow();
    }
  });

  it('is fresh when recently observed', () => {
    const result = assessFreshness({
      factPath: 'hours.weekly',
      contentObservedAt: daysAgo(2),
      travelDates: TRIP,
      now: NOW,
    });
    expect(result.state).toBe('fresh');
    expect(result.enforceable).toBe(true);
  });

  it('asks for a recheck before it calls anything stale', () => {
    // hours.weekly has a 90-day shelf life; moderate rechecks at 60%.
    const result = assessFreshness({
      factPath: 'hours.weekly',
      contentObservedAt: daysAgo(70),
      travelDates: TRIP,
      now: NOW,
    });
    expect(result.state).toBe('due_recheck');
    expect(result.enforceable).toBe(true);
  });

  it('never enforces a fast-changing fact past its window', () => {
    const closure = assessFreshness({
      factPath: 'hours.closure',
      contentObservedAt: daysAgo(60),
      travelDates: TRIP,
      now: NOW,
    });
    expect(closure.state).toBe('stale');
    expect(closure.enforceable).toBe(false);
    expect(closure.rationale).toContain('not planning around it');
  });

  it('treats a closure that ends before the trip as over, not as stale evidence', () => {
    const result = assessFreshness({
      factPath: 'hours.closure',
      contentObservedAt: daysAgo(3),
      appliesFrom: '2026-07-01',
      appliesTo: '2026-08-15',
      travelDates: TRIP,
      now: NOW,
    });
    expect(result.state).toBe('expired');
    expect(result.enforceable).toBe(false);
  });

  it('treats a closure that starts after the trip as not yet applicable', () => {
    const result = assessFreshness({
      factPath: 'hours.closure',
      contentObservedAt: daysAgo(3),
      appliesFrom: '2026-11-01',
      appliesTo: '2026-12-01',
      travelDates: TRIP,
      now: NOW,
    });
    expect(result.state).toBe('not_yet_applicable');
    expect(result.enforceable).toBe(false);
  });

  it('lets a source-declared validity window beat the shelf life', () => {
    const result = assessFreshness({
      factPath: 'cost.admission',
      contentObservedAt: daysAgo(400),
      validFrom: '2026-01-01',
      validThrough: '2026-12-31',
      travelDates: TRIP,
      now: NOW,
    });
    expect(result.state).toBe('fresh');
    expect(result.rationale).toContain('2026-12-31');
  });

  it('judges against the trip rather than against today', () => {
    // Applicable today, over by the time they travel.
    const result = assessFreshness({
      factPath: 'hours.closure',
      contentObservedAt: daysAgo(1),
      appliesFrom: '2026-08-01',
      appliesTo: '2026-08-20',
      travelDates: TRIP,
      now: NOW,
    });
    expect(result.state).toBe('expired');
  });

  it('treats an unparseable timestamp as maximally old rather than as fresh', () => {
    const result = assessFreshness({
      factPath: 'hours.weekly',
      contentObservedAt: 'not a date',
      travelDates: TRIP,
      now: NOW,
    });
    expect(result.state).toBe('stale');
  });
});

describe('revalidation windows', () => {
  it('forces a full re-read once a document outlives its class window', () => {
    expect(needsFullReread({ contentObservedAt: daysAgo(20), changeClass: 'fast', now: NOW })).toBe(true);
    expect(needsFullReread({ contentObservedAt: daysAgo(20), changeClass: 'slow', now: NOW })).toBe(false);
  });

  it('revalidates on a much shorter clock than it re-reads', () => {
    const recent = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    expect(needsRevalidation({ lastCheckedAt: recent, changeClass: 'fast', now: NOW })).toBe(false);
    const older = new Date(NOW.getTime() - 12 * 3_600_000).toISOString();
    expect(needsRevalidation({ lastCheckedAt: older, changeClass: 'fast', now: NOW })).toBe(true);
    expect(needsRevalidation({ lastCheckedAt: older, changeClass: 'slow', now: NOW })).toBe(false);
  });

  it('governs a document by its fastest-changing wanted fact', () => {
    expect(fastestClass(['identity.officialSite', 'hours.closure'])).toBe('fast');
    expect(fastestClass(['identity.officialSite', 'hours.weekly'])).toBe('moderate');
    expect(fastestClass(['identity.officialSite'])).toBe('slow');
    expect(fastestClass([])).toBe('slow');
  });
});

describe('reuse reporting', () => {
  it('refuses to claim a share when nothing was eligible', () => {
    expect(reuseShare(emptyReuseReport())).toBeNull();
  });

  it('counts reused operations against attempted ones', () => {
    const report = {
      ...emptyReuseReport(),
      discoveryHits: 3,
      discoveryMisses: 1,
      documentsReused: 4,
      documentsFetched: 2,
      extractionsReused: 1,
      extractionsPerformed: 1,
    };
    expect(reuseShare(report)).toBeCloseTo(8 / 12, 5);
  });
});
