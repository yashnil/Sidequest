import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  advisorShortlistSchema,
  answerAdvisorQuestion,
  emptyAdvisorAnswers,
  emptyComposerAnswers,
  type AdvisorShortlist,
  type TripComposerAnswers,
} from '@sidequest/core';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined }) }));
/* The actions reach a database; these screens are rendered from stored data and call nothing while rendering. */
vi.mock('@/app/(product)/decide/advisor-actions', () => ({
  advisorStepAction: () => new Promise(() => undefined),
  saveAdvisorAnswersAction: async () => ({ ok: true }),
  buildAdvisorShortlistAction: async () => ({ ok: true }),
  refineAdvisorAction: async () => ({ ok: true }),
  adoptAdvisorPickAction: async () => ({ ok: true }),
}));

const { AdvisorShortlistView } = await import('./AdvisorShortlistView');
const { AdvisorInterview } = await import('./AdvisorInterview');
const { WorldDots, worldDotsPath } = await import('./WorldDots');
const { DATA_ATTRIBUTION, EDITORIAL_READING, OPEN_DATA_READING, SUGGESTED_READING } = await import('./advisor-copy');

const text = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

const SEASON = 'The high trails: usually July–September. Walking and day hikes: usually April–October (from 1981–2010 climate normals).';

function pick(overrides: Record<string, unknown>) {
  return {
    id: 'lofoten',
    name: 'Lofoten',
    context: 'Norway',
    kind: 'island_group',
    worldRegion: 'northern_europe',
    countries: ['NO'],
    center: { lat: 68.2, lng: 13.9 },
    radiusKm: 80,
    resolveAs: 'Lofoten, Norway',
    role: 'primary',
    score: 0.81,
    coverage: 0.6,
    match: 'strong',
    pitch: 'Granite peaks out of the sea.',
    why: 'Strong for mountains and hiking, in season in July.',
    experiences: ['Reinebringen at dawn'],
    strongFor: ['Mountains and trekking'],
    window: { months: [6, 7, 8], label: 'June–August' },
    nights: { suggested: 7, min: 5, max: 10 },
    character: 'Active, a few big days',
    gettingThere: 'Fly to Bodø, then a ferry',
    gettingAround: 'A car is the easy way',
    cost: { level: 4, label: 'Expensive', versusBudget: null },
    bases: ['Reine', 'Svolvær'],
    tradeoffs: ['Costs run above your budget.'],
    unverified: ['Prices, opening dates and permits'],
    differsBy: null,
    distanceKm: null,
    factors: [{ id: 'experience', label: 'What you want to do', weight: 0.4, value: 0.9, basis: 'mountains and hiking' }],
    references: ['Visit Norway'],
    ...overrides,
  };
}

function shortlist(): AdvisorShortlist {
  return advisorShortlistSchema.parse({
    kind: 'advisor',
    version: 1,
    catalogVersion: 'atlas-test',
    builtAt: '2026-11-08T12:00:00.000Z',
    elapsedMs: 412,
    picks: [
      pick({}),
      pick({
        id: 'wd:Q5469',
        name: 'Hunza Valley',
        context: 'Gilgit-Baltistan, Pakistan',
        kind: 'mountain_range',
        worldRegion: 'south_asia',
        countries: ['PK'],
        center: { lat: 36.3, lng: 74.6 },
        resolveAs: 'Hunza Valley, Pakistan',
        basis: 'open_data',
        confidence: 0.62,
        measured: true,
        seasonNote: SEASON,
        cost: { level: 1, label: 'Low (estimated from national price levels)', versusBudget: null },
        references: ['Wikivoyage: Hunza Valley', 'Wikidata: Q5469', 'CHELSA climate normals 1981–2010'],
      }),
      pick({
        id: 'wd:Q1234567',
        name: 'Svaneti',
        context: 'Georgia',
        kind: 'protected_area',
        worldRegion: 'caucasus_central_asia',
        countries: ['GE'],
        center: { lat: 43.0, lng: 42.7 },
        resolveAs: 'Svaneti, Georgia',
        basis: 'open_data',
        confidence: 0.4,
        suggested: true,
        references: ['Wikidata: Q1234567'],
      }),
    ],
    alternates: [pick({ id: 'tromso', name: 'Tromsø', role: 'alternate', kind: 'city' })],
    readout: { drivers: ['Mountains and trekking'], assumptions: [], openQuestions: [], spread: null, relaxation: null, closeCalls: [] },
    stats: {
      catalog: 36512,
      considered: 600,
      eligible: 410,
      excluded: { season: 21034 },
      lambda: 0.7,
      climateChecked: 0,
      climateVerified: 0,
      research: { proposed: 4, resolved: 3, shown: 1, note: 'A research model suggested 4 more places; 3 are destinations we hold, and they were ranked like every other.' },
    },
  });
}

function renderShortlist(): string {
  return renderToStaticMarkup(createElement(AdvisorShortlistView, { sessionId: 'session-1', shortlist: shortlist(), images: {}, dots: worldDotsPath([{ lat: 10, lng: 20 }]), sampleComplete: false, summary: [] }));
}

/** The markup of each primary card, in order. */
function cards(html: string): string[] {
  return html.split('data-testid="advisor-pick"').slice(1);
}

describe('a shortlist card', () => {
  const html = renderShortlist();
  const [editorial, openData, suggested] = cards(html).map(text) as [string, string, string];

  it('says what kind of place it is, in words', () => {
    expect(editorial).toContain('Island group · Norway');
    expect(openData).toContain('Mountain range · Gilgit-Baltistan, Pakistan');
    expect(suggested).toContain('Protected area · Georgia');
    expect(text(html)).not.toMatch(/island_group|mountain_range|protected_area|open_data/);
  });

  it('says whose reading it is', () => {
    expect(editorial).toContain(`${EDITORIAL_READING}.`);
    expect(editorial).not.toContain(OPEN_DATA_READING);
    expect(openData).toContain(`${OPEN_DATA_READING} · moderately documented.`);
    expect(openData).not.toContain(SUGGESTED_READING);
    expect(suggested).toContain(`${SUGGESTED_READING}.`);
    expect(suggested).toContain(`${OPEN_DATA_READING} · thinly documented.`);
  });

  it('puts the season by activity beside the timing window', () => {
    const [, card] = cards(html);
    const bestTime = card!.slice(card!.indexOf('Best time'), card!.indexOf('Trip length'));
    expect(text(bestTime)).toContain('June–August');
    expect(text(bestTime)).toContain(SEASON);
    /* A place with no season note still has its window. */
    expect(editorial).toContain('Best time June–August');
  });

  it('links the sources it can and never shows an identifier', () => {
    expect(html).toContain('href="https://en.wikivoyage.org/wiki/Hunza_Valley"');
    expect(html).toContain('href="https://www.wikidata.org/wiki/Q5469"');
    for (const anchor of html.match(/<a [^>]*href="https:[^>]*>/g) ?? []) {
      expect(anchor).toContain('rel="noopener noreferrer"');
      expect(anchor).toContain('target="_blank"');
    }
    expect(openData).toContain('Wikivoyage: Hunza Valley (opens in a new tab)');
    expect(openData).toContain('Wikidata record for Hunza Valley (opens in a new tab)');
    expect(openData).toContain('CHELSA climate normals 1981–2010');
    expect(text(html)).not.toMatch(/Q5469|Q1234567|wd:/);
  });

  it('keeps an estimate labelled as one', () => {
    expect(openData).toContain('Low (estimated from national price levels)');
  });

  it('does not call an unreviewed place editorial', () => {
    expect(openData).toContain('Nobody at Sidequest has reviewed this place');
    expect(openData).not.toContain('is editorial');
    expect(editorial).toContain('Our reading of this place is editorial');
  });
});

describe('the shortlist read-out', () => {
  const html = renderShortlist();
  const words = text(html);

  it('says how wide the comparison was, and what research added', () => {
    expect(words).toContain('We compared 36,512 destinations and read 600 closely.');
    expect(words).toContain('A research model suggested 4 more places; 3 are destinations we hold');
  });

  it('always shows where the data comes from', () => {
    const at = html.indexOf('data-testid="advisor-attribution"');
    const line = html.slice(at, html.indexOf('</p>', at)).replace(/^[^>]*>/, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
    expect(line).toBe(DATA_ATTRIBUTION);
    /* Outside every <details>: visible without opening anything. */
    expect(at).toBeGreaterThan(html.lastIndexOf('</details>'));
  });

  it('marks each pick from its own coordinates, and says the dots are a sample', () => {
    expect(words).toContain('Faint dots are a sample of real destination centres.');
    expect(html).toContain('a sample of the destinations we compared');
    /* Hunza is not in the one-point sample handed in; it is still on the map (x = lng + 180, y = 84 − lat). */
    expect(html).toContain('cx="254.6" cy="47.7"');
  });

  it('keeps the ids the browser suite holds on to', () => {
    expect(html).toContain('data-testid="advisor-shortlist"');
    expect(cards(html)).toHaveLength(3);
    expect(html.match(/data-testid="advisor-provenance"/g)).toHaveLength(4);
  });
});

describe('the world map', () => {
  it('draws any number of sampled centres as one path, not one element each', () => {
    const points = Array.from({ length: 1800 }, (_, index) => ({ lat: ((index * 37) % 140) - 60 + 0.25, lng: ((index * 91) % 360) - 180 + 0.5 }));
    const html = renderToStaticMarkup(createElement(WorldDots, { dots: worldDotsPath(points), highlighted: [], label: 'World map' }));
    expect(html.match(/<path /g)).toHaveLength(2);
    expect(html).not.toContain('<circle');
    expect(html).toContain('aria-label="World map"');
  });

  it('writes one dot per distinct tenth of a degree and skips what is not a coordinate', () => {
    expect(worldDotsPath([{ lat: 0, lng: 0 }])).toBe('M180 84h.01');
    expect(worldDotsPath([{ lat: 10.01, lng: 20.02 }, { lat: 10.02, lng: 20.01 }])).toBe('M200 74h.01');
    expect(worldDotsPath([{ lat: Number.NaN, lng: 5 }])).toBe('');
    /* South of the sheet is clamped to its edge rather than drawn outside it. */
    expect(worldDotsPath([{ lat: -89, lng: 0 }])).toBe('M180 144h.01');
  });

  it('marks a leader that is in no sample', () => {
    const html = renderToStaticMarkup(createElement(WorldDots, { highlighted: [{ id: 'a', lat: 36.3, lng: 74.6 }, { id: 'b', lat: -13.2, lng: -72.5 }], label: 'World map' }));
    expect(html).toContain('cx="254.6" cy="47.7"');
    expect(html).toContain('cx="107.5" cy="97.2"');
    expect(text(html)).toContain('1');
    expect(text(html)).toContain('2');
  });
});

describe('the interview before the server has answered', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  const fresh: TripComposerAnswers = { ...emptyComposerAnswers('help_me_decide', now), dates: { mode: 'month', wantsRecommendation: false }, discovery: emptyAdvisorAnswers() };
  const render = (initial: TripComposerAnswers) =>
    renderToStaticMarkup(createElement(AdvisorInterview, { sessionId: 'session-1', initial, understood: [], dots: '', worldSize: 36512, sampleComplete: false }));

  it('asks the first essential at once and offers rail journeys among the interests', () => {
    const html = render(fresh);
    expect(html).toContain('data-testid="advisor-question-focus"');
    expect(text(html)).toContain('Rail journeys');
    expect(text(html)).toContain('36,512 destinations on every continent.');
    expect(text(html)).toContain('Dots are a sample of real destination centres.');
    /* Nothing is leading until the server says so. */
    expect(text(html)).not.toContain('Leaning towards');
  });

  it('says it is working out the first question when the essentials are already settled', () => {
    const settled = answerAdvisorQuestion(answerAdvisorQuestion(fresh, 'focus', ['mountains']), 'when', ['summer']);
    const html = render(settled);
    expect(html).toContain('data-testid="advisor-opening"');
    expect(html).not.toContain('data-testid="advisor-question-');
    expect(text(html)).toContain('Working out what to ask first…');
    expect(text(html)).toContain('Show me places now');
    expect(text(html)).not.toContain('Comparing');
  });
});

/**
 * THE ATLAS STAYS ON THE SERVER.
 *
 * The interview used to run in the browser by importing the whole catalog. A
 * module that reaches the browser may no longer name anything that ranks or
 * holds destinations. Asserted on the source, because the failure is a bundle
 * that quietly grows by half a megabyte, not a wrong answer.
 */
describe('nothing that reaches the browser holds or ranks destinations', () => {
  const FORBIDDEN = /\b(destinationCatalog|catalogDestinationById|rankCatalog|nextQuestion|shortlistIds|buildAdvisorShortlist|advisorWorld|loadAtlas)\b/;
  const here = import.meta.dirname;
  const decide = join(here, '..', '..', 'app', '(product)', 'decide', '[id]');
  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sources = [
    ...readdirSync(here).map((name) => join(here, name)),
    ...readdirSync(decide).map((name) => join(decide, name)),
  ].filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));

  it('is scanning the files it claims to', () => {
    expect(sources.some((path) => path.endsWith('AdvisorInterview.tsx'))).toBe(true);
    expect(sources.some((path) => path.endsWith('AdvisorResearch.tsx'))).toBe(true);
  });

  it('keeps every such name inside server-only modules', () => {
    for (const path of sources) {
      const source = readFileSync(path, 'utf8');
      const serverOnly = /^import 'server-only';/m.test(source) || path.endsWith(join('[id]', 'page.tsx'));
      if (serverOnly) {
        expect(source, `${path} must not be a client module`).not.toMatch(/^'use client';/m);
        continue;
      }
      expect(strip(source), path).not.toMatch(FORBIDDEN);
    }
  });
});
