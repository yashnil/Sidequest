import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }), usePathname: () => '/trips/abc123/questionnaire' }));

const { RouteFailure, tripIdFromPath } = await import('./RouteFailure');

/**
 * V8 §1.8 — the boundary's promises are behaviourally true, and the copy is
 * the traveller's: what is preserved first, "Retry this page" and a way back to
 * the journey, a reference — and never a bare "Try again", never internals.
 */
describe('RouteFailure', () => {
  it('says what is preserved, offers Retry this page and Return to trip review, and shows a reference', () => {
    const html = renderToStaticMarkup(
      createElement(RouteFailure, {
        error: Object.assign(new Error('ZodError at bases[0]: expected string'), { digest: 'digest-1234' }),
        reset: () => undefined,
        route: 'product',
        eyebrow: 'Your trip is safe',
        heading: 'This page hit a problem.',
        preserved: 'Your trip answers are saved.',
        secondary: { href: '/trips/abc123/questionnaire', label: 'Return to trip review' },
      }),
    );
    expect(html).toContain('This page hit a problem.');
    expect(html).toContain('Your trip answers are saved.');
    expect(html).toContain('Retry this page');
    expect(html).toContain('Return to trip review');
    expect(html).toContain('digest-1234');
    expect(html).not.toMatch(/Try again/);
    /* The error's own words never reach the traveller. */
    expect(html).not.toMatch(/Zod|bases\[0\]|expected string/);
  });

  it('mints a reference for a browser-side fault that has no digest', () => {
    const html = renderToStaticMarkup(
      createElement(RouteFailure, {
        error: new TypeError('Failed to fetch'),
        reset: () => undefined,
        route: 'product',
        eyebrow: 'Your trip is safe',
        heading: 'This page hit a problem.',
        preserved: 'Your trip answers are saved.',
        secondary: { href: '/trips', label: 'Back to your trips' },
      }),
    );
    expect(html).toMatch(/quote this reference: <span[^>]*>[a-f0-9]{8}</);
    expect(html).not.toContain('Failed to fetch');
  });

  it('knows which trip a path is inside, and that /trips/new is not one', () => {
    expect(tripIdFromPath('/trips/abc-123/questionnaire')).toBe('abc-123');
    expect(tripIdFromPath('/trips/abc-123')).toBe('abc-123');
    expect(tripIdFromPath('/trips/new')).toBeNull();
    expect(tripIdFromPath('/trips')).toBeNull();
    expect(tripIdFromPath(null)).toBeNull();
  });
});
