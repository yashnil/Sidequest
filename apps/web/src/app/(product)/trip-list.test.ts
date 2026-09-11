import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/*
 * The list refreshes the route after a removal. There is no app router in a
 * unit test and no effect runs under `renderToStaticMarkup` anyway; the markup
 * is what is under test. The card's own menu actions are never reached from
 * the home strip, but the module imports them, so they are stubbed too.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('./actions', () => ({ deleteTripAction: async () => ({ ok: true }) }));
vi.mock('./trips/dashboard-actions', () => ({
  archiveTripAction: async () => ({ ok: true }),
  duplicateTripAction: async () => ({ ok: true }),
  renameTripAction: async () => ({ ok: true }),
  setLifecycleAction: async () => ({ ok: true }),
}));

const { TripList } = await import('./TripList');

/**
 * THE ONLY HORIZONTAL OVERFLOW IN THE PRODUCT, AND WHY A CLASS LIST IS THE TEST.
 *
 * A reviewer measured the homepage at every phone width: **8px of horizontal
 * overflow at 375 (iPhone SE/8), 23px at 360 (most Androids), 63px at 320**, in
 * both colour schemes, on the only route in the product that overflows at all.
 * The offending node was the trip row's action cluster, carrying `shrink-0`,
 * with a 363px intrinsic floor. The row *around* it wrapped; the cluster could
 * not participate, because `shrink-0` forbids it narrowing and nothing let it
 * wrap onto its own lines.
 *
 * V8 moved the strip onto the shared `TripCard`, and the property carries
 * over unchanged: no flex island inside the card may refuse both to shrink and
 * to wrap, and every wrapping cluster must be allowed narrower than its
 * content (`min-w-0`).
 *
 * **It is a class-list assertion, and that is a stand-in.** The real assertion
 * is `scrollWidth <= clientWidth` at 360 and 375, in a browser the suite does
 * not currently drive at those widths.
 */

/** The widest label/action pair the server can produce, on a card with everything on it. */
const WORST_CASE = {
  id: 'trip-1',
  title: 'Santiago Metropolitan Region',
  destination: 'Santiago Metropolitan Region',
  dates: 'Sat 12 Sep — Sun 20 Sep',
  timing: 'fixed' as const,
  nights: 8,
  party: '2 adults, 2 children',
  lifecycle: 'planning' as const,
  lifecycleBasis: 'inferred' as const,
  bases: ['Santiago', 'Valparaíso', 'Cajón del Maipo', 'Viña del Mar', 'Pirque'],
  itineraryStatus: 'ready_with_cautions' as const,
  feasibilitySummary: '6 things worth reading before you commit.',
  bookedCount: 0,
  nextAction: 'Answer the questions',
  href: '/trips/trip-1/questionnaire',
  progressTone: 'amber' as const,
  progressState: 'needs_answers',
  progressLabel: 'Waiting on your answers',
  progressRank: 3,
  updatedAt: '2026-09-01T00:00:00.000Z',
  startDate: '2026-09-12',
  image: null,
  fallback: { kind: 'regional_graphic' as const, label: 'Santiago Metropolitan Region', hue: 120, horizon: 0.5, drift: 0.5, marks: 1, description: 'A generated graphic for Santiago Metropolitan Region' },
  claimed: false,
  updatedLabel: 'Updated today',
};

function render(): string {
  return renderToStaticMarkup(createElement(TripList, { rows: [WORST_CASE] }));
}

const isFlex = (classes: string) => /(^|\s)(inline-)?flex(\s|$)/.test(classes);

/** Every `class` attribute in the output that describes a flex container. */
function flexContainers(markup: string): string[] {
  return [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]!).filter(isFlex);
}

/**
 * Flex containers that are themselves *items* of another flex container.
 *
 * `min-w-0` overrides `min-width: auto`, which is a rule about flex **items**;
 * the clusters inside the card are items, and their automatic minimum size is
 * their own content — which is the floor this whole finding is about.
 */
function nestedFlexContainers(markup: string): string[] {
  const found: string[] = [];
  const stack: boolean[] = [];
  for (const token of markup.matchAll(/<(\/?)(\w+)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attributes, selfClosing] = token;
    if (closing) {
      stack.pop();
      continue;
    }
    const classes = /class="([^"]*)"/.exec(attributes ?? '')?.[1] ?? '';
    const flex = isFlex(classes);
    if (flex && stack.some(Boolean)) found.push(classes);
    if (!selfClosing && !['img', 'input', 'br', 'hr', 'meta', 'link', 'circle', 'path'].includes(tag!)) {
      stack.push(flex);
    }
  }
  return found;
}

describe('the trip strip can narrow to a phone', () => {
  it('has no flex island that refuses both to shrink and to wrap', () => {
    const offenders = flexContainers(render()).filter((classes) => classes.includes('shrink-0') && !classes.includes('flex-wrap'));
    expect(
      offenders,
      'a flex container that is `shrink-0` and does not wrap has its content width as a hard floor. ' +
        'That floor was 363px here and overflowed the homepage on every phone under 383px wide',
    ).toEqual([]);
  });

  it('lets every wrapping cluster be narrower than its contents', () => {
    const wrapping = nestedFlexContainers(render()).filter((classes) => classes.includes('flex-wrap'));
    expect(wrapping.length, 'the card’s clusters must wrap').toBeGreaterThan(0);
    for (const classes of wrapping) {
      expect(classes, `a wrapping flex container without min-w-0 still cannot go below its content width: "${classes}"`).toContain('min-w-0');
    }
  });
});

/**
 * V8 §8/§9 — the strip is the dashboard's card, and it says what the row says.
 */
describe('the trip strip shows the shared card', () => {
  it('sets the dates as a figure and composes the standing line', () => {
    const markup = render();
    expect(markup).toContain('data-testid="trip-card"');
    expect(markup).toMatch(/type-figure[^>]*>Sat 12 Sep — Sun 20 Sep</);
    expect(markup).toContain('8 nights');
    expect(markup).toContain('2 adults, 2 children');
    expect(markup).toContain('Ready, with cautions');
    expect(markup).toContain('Nothing booked yet');
    /* The route preview folds a long base list rather than wrapping five names. */
    expect(markup).toContain('+1 more');
    expect(markup).not.toContain('Pirque');
  });

  it('draws the atlas route sketch, never a gradient stand-in, when there is no photograph', () => {
    const markup = render();
    expect(markup).toContain('route-draw');
    expect(markup).not.toContain('linear-gradient(');
  });

  it('keeps the remove control named for the trip, and the action as the row’s own', () => {
    const markup = render();
    expect(markup).toContain('aria-label="Remove the Santiago Metropolitan Region trip"');
    expect(markup).toContain('>Answer the questions<');
    expect(markup).toContain('aria-label="Open Santiago Metropolitan Region"');
  });
});
