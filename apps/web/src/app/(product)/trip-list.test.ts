import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/*
 * The list refreshes the route after a removal. There is no app router in a
 * unit test and no effect runs under `renderToStaticMarkup` anyway; the markup
 * is what is under test.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('./actions', () => ({ deleteTripAction: async () => ({ ok: true }) }));

const { TripList } = await import('./TripList');

/**
 * THE ONLY HORIZONTAL OVERFLOW IN THE PRODUCT, AND WHY A CLASS LIST IS THE TEST.
 *
 * A reviewer measured the homepage at every phone width: **8px of horizontal
 * overflow at 375 (iPhone SE/8), 23px at 360 (most Androids), 63px at 320**, in
 * both colour schemes, on the only route in the product that overflows at all.
 * The offending node was the same at every width — the trip row's action cluster
 * (`Badge` + action link + Remove), carrying `shrink-0`, with a 363px intrinsic
 * floor and a right edge fixed at 383px once the 20px page padding is added.
 *
 * The row *around* it wraps. The cluster could not participate in that, because
 * `shrink-0` forbids it narrowing and nothing let it wrap onto its own lines.
 *
 * Two things this test is honest about:
 *
 * **It is a class-list assertion, and that is a stand-in.** The real assertion
 * is `document.documentElement.scrollWidth <= clientWidth` at 360 and 375, in a
 * browser. The browser suite cannot currently make it: `e2e/support/viewports.ts`
 * declares one mobile width, 390, which is seven pixels above the threshold —
 * so the guard that exists is structurally unable to see this class of failure.
 * Adding a narrow width there is a separate, necessary change.
 *
 * **It asserts the rule, not the fix.** "No island in a wrapping row that can
 * neither shrink nor wrap" is the property; `shrink-0` on a multi-control flex
 * container is the shape it takes. A snapshot of the exact class string would
 * pass forever and mean nothing the moment somebody re-expressed the same
 * mistake with `w-[363px]`, but it would at least fail on the literal
 * regression — which is more than the repository has today.
 */

/** The widest label/action pair `trip-progress.ts` can produce. */
const WORST_CASE = {
  id: 'trip-1',
  destination: 'Santiago Metropolitan Region',
  dates: 'Sat 12 Sep — Sun 20 Sep',
  nights: 8,
  state: 'needs_answers',
  label: 'Waiting on your answers',
  action: 'Answer the questions',
  href: '/trips/trip-1/questionnaire',
  tone: 'amber' as const,
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
 * The distinction is load-bearing and the reason the first draft of the second
 * test below was wrong: `min-w-0` overrides `min-width: auto`, which is a rule
 * about flex **items**. The outermost row is an ordinary block child of an
 * `<li>` and its width is the list's; the clusters inside it are items, and
 * their automatic minimum size is their own content — which is the floor this
 * whole finding is about.
 *
 * A depth walk over the rendered markup rather than a DOM, because
 * `renderToStaticMarkup` gives well-formed output and pulling in a parser to
 * read two levels of nesting would be more machinery than the property needs.
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
    // Void elements never open a scope; `img`/`input` are the ones this markup has.
    if (!selfClosing && !['img', 'input', 'br', 'hr', 'meta', 'link'].includes(tag!)) {
      stack.push(flex);
    }
  }
  return found;
}

describe('the trip list can narrow to a phone', () => {
  it('has no flex island that refuses both to shrink and to wrap', () => {
    const offenders = flexContainers(render()).filter(
      (classes) => classes.includes('shrink-0') && !classes.includes('flex-wrap'),
    );
    expect(
      offenders,
      'a flex container that is `shrink-0` and does not wrap has its content width as a hard floor. ' +
        'That floor was 363px here and overflowed the homepage on every phone under 383px wide',
    ).toEqual([]);
  });

  /**
   * And the other half of the same failure: `flex-wrap` alone is not enough,
   * because a flex item's automatic minimum size is its content. `min-w-0` is
   * what actually permits it to be narrower than the sum of its children.
   */
  it('lets the action cluster be narrower than its contents', () => {
    const wrapping = nestedFlexContainers(render()).filter((classes) =>
      classes.includes('flex-wrap'),
    );
    expect(wrapping.length, 'the row’s clusters must wrap').toBeGreaterThan(0);
    for (const classes of wrapping) {
      expect(
        classes,
        `a wrapping flex container without min-w-0 still cannot go below its content width: "${classes}"`,
      ).toContain('min-w-0');
    }
  });
});
