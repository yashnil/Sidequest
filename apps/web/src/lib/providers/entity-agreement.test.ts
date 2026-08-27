import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assessEntityAgreement } from './entity-agreement';
import { createOpenProviders } from './live';

/**
 * THE NAMESAKE GATE: WRONG-ENTITY FACTS MAY NOT BECOME '(VERIFIED)'.
 *
 * The live defect these shapes are drawn from: the research funnel bound the
 * official-city-site page of the **Borgir community and cultural centre** — a
 * municipal seniors' facility — to the record of **Borgir**, a protected
 * nature-reserve headland, because the join keyed on the bare name. The
 * centre's weekday hours, weekend closures and lunch-ordering rules shipped on
 * the reserve's card labelled Verified, and the planner refused to schedule an
 * outdoor headland on weekends.
 *
 * The fixtures are shapes, not places — synthetic records and pages with the
 * exact structure the live join had. No network, no model: the conflicted page
 * must be refused before either would be reached.
 */

beforeAll(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-test-placeholder');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

/** A protected headland: outdoor ground, in our vocabulary. */
const RESERVE_SUBJECT = {
  id: 'land_use:reserve-1',
  name: 'Borgheim',
  kind: 'wildlife_area',
  locality: 'Testland',
  coordinates: { lat: 64.1123, lng: -21.913 },
  wantedPaths: ['hours.weekly'] as const,
};

/** The namesake: a municipal community centre's page on the city's own site. */
const CENTRE_PAGE_TEXT = [
  'Borgheim | Testville',
  'Borgheim',
  'Community and cultural center',
  'Sample Street 43',
  '112 Testville',
  'Opening hours',
  'Borgheim is open weekdays between 8 a.m. and 4 p.m.',
  'Lunch is served between 11:30 a.m. to 12:30 p.m. (orders must be received by 1pm the day before)',
  'Program',
  'The winter program has commenced with a diverse selection. There will be many special events held',
  'throughout the winter. This is a service open to all residents regardless of age. To participate in',
  'social activities, you do not need to apply - just show up on site.',
].join('\n');

/** The centre states its own hours in machine-readable form, like the live page could. */
const CENTRE_HOURS_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'CivicStructure',
  name: 'Borgheim community and cultural center',
  openingHoursSpecification: [
    {
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      opens: '08:00',
      closes: '16:00',
    },
  ],
};

function documentFor(subjectId: string, over: Partial<{ text: string; structuredData: unknown[]; title: string }> = {}) {
  return {
    subjectId,
    url: 'https://city.example/en/borgheim',
    title: over.title ?? 'Borgheim | Testville',
    text: over.text ?? CENTRE_PAGE_TEXT,
    structuredData: over.structuredData ?? [CENTRE_HOURS_JSONLD],
    contentHash: 'test-hash',
    contentBytes: 1024,
    retrievedAt: new Date().toISOString(),
    robotsAllowed: true,
    authority: 'government' as const,
    publisher: 'city.example',
    domain: 'city.example',
  };
}

describe('entity agreement between a page and a research subject', () => {
  it('refuses a facility page for an outdoor record: the community centre is not the headland', () => {
    const verdict = assessEntityAgreement({
      subject: RESERVE_SUBJECT,
      document: { title: 'Borgheim | Testville', text: CENTRE_PAGE_TEXT, structuredData: [CENTRE_HOURS_JSONLD] },
    });
    expect(verdict.agreement).toBe('namesake_conflict');
  });

  it('keeps the visitor-centre exception: a facility page that evidences the ground may attach', () => {
    const verdict = assessEntityAgreement({
      subject: RESERVE_SUBJECT,
      document: {
        title: 'Borgheim Nature Reserve — visitor centre',
        text: 'The visitor centre for the Borgheim nature reserve is open daily. Trails across the headland start here, and wildlife can be seen year round.',
        structuredData: [],
      },
    });
    expect(verdict.agreement).toBe('compatible');
  });

  it('does not gate operated premises: a museum keeps its operator page', () => {
    const verdict = assessEntityAgreement({
      subject: { name: 'Borgheim Museum', kind: 'museum', coordinates: RESERVE_SUBJECT.coordinates },
      document: { title: 'Borgheim | Testville', text: CENTRE_PAGE_TEXT, structuredData: [] },
    });
    expect(verdict.agreement).toBe('compatible');
  });

  it('refuses a page whose own coordinates place its subject elsewhere, whatever the kind', () => {
    const verdict = assessEntityAgreement({
      subject: { name: 'Borgheim Museum', kind: 'museum', coordinates: { lat: 64.1123, lng: -21.913 } },
      document: {
        title: 'Borgheim',
        text: 'A museum of local history.',
        structuredData: [
          {
            '@type': 'Museum',
            geo: { '@type': 'GeoCoordinates', latitude: 64.2523, longitude: -21.7 },
          },
        ],
      },
    });
    expect(verdict.agreement).toBe('namesake_conflict');
    if (verdict.agreement === 'namesake_conflict') {
      expect(verdict.reason).toBe('page_locates_elsewhere');
    }
  });

  it('agreeing coordinates are not a conflict', () => {
    const verdict = assessEntityAgreement({
      subject: { name: 'Borgheim Museum', kind: 'museum', coordinates: { lat: 64.1123, lng: -21.913 } },
      document: {
        title: 'Borgheim',
        text: 'A museum of local history.',
        structuredData: [
          { '@type': 'Museum', geo: { '@type': 'GeoCoordinates', latitude: 64.113, longitude: -21.915 } },
        ],
      },
    });
    expect(verdict.agreement).toBe('compatible');
  });

  it('"the reservation desk" is not evidence of a reserve: ground words match whole words only', () => {
    const verdict = assessEntityAgreement({
      subject: RESERVE_SUBJECT,
      document: {
        title: 'Borgheim | Testville',
        text: `${CENTRE_PAGE_TEXT}\nContact the reservation desk for trailer parking beside the community center.`,
        structuredData: [],
      },
    });
    expect(verdict.agreement).toBe('namesake_conflict');
  });
});

describe('the extraction provider drops a namesake join instead of minting claims from it', () => {
  it('emits no hours claim for the outdoor record from the centre’s structured data, and records the gap', async () => {
    const { providers } = createOpenProviders({ maxModelCalls: 0 });
    const result = await providers.extraction.extract({
      subjects: [RESERVE_SUBJECT],
      documents: [documentFor(RESERVE_SUBJECT.id)],
      dates: ['2026-10-16', '2026-10-17'],
      maxCalls: 0,
    });

    /* Pre-fix this held a verified-track hours.weekly claim for the reserve. */
    expect(result.claims).toHaveLength(0);
    const gap = result.gaps.find((entry) => entry.subjectId === RESERVE_SUBJECT.id);
    expect(gap?.reason).toBe('insufficient_evidence');
    expect(gap?.detail).toContain('namesake');
  });

  it('control: the same structured hours attach when the subject is compatible premises', async () => {
    const { providers } = createOpenProviders({ maxModelCalls: 0 });
    const subject = {
      ...RESERVE_SUBJECT,
      id: 'places:museum-1',
      name: 'Borgheim Museum',
      kind: 'museum',
    };
    const result = await providers.extraction.extract({
      subjects: [subject],
      documents: [documentFor(subject.id)],
      dates: ['2026-10-16'],
      maxCalls: 0,
    });

    const hours = result.claims.find((claim) => claim.factPath === 'hours.weekly');
    expect(hours).toBeDefined();
    expect(hours?.subjectId).toBe(subject.id);
    expect(result.gaps.filter((entry) => entry.subjectId === subject.id)).toHaveLength(0);
  });
});
