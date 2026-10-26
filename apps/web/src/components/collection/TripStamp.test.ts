import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TripStamp } from './TripStamp';

const render = (shape: Parameters<typeof TripStamp>[0]['shape']) => renderToStaticMarkup(createElement(TripStamp, { id: 'trip-1', name: 'Kyrgyzstan', dates: 'Oct 11–21, 2026', shape, catalogue: 'No. 04' }));

describe('a trip’s stamp', () => {
  it('sets the place and the dates round the ring, and hides itself from assistive technology', () => {
    const html = render(undefined);
    expect(html).toContain('KYRGYZSTAN');
    expect(html).toContain('OCT 11–21, 2026');
    expect(html).toContain('aria-hidden="true"');
  });

  it('draws no route without coordinates, and says so with a dotted inner ring', () => {
    const html = render({ center: null, bases: [], stops: [] });
    expect(html).toContain('data-stamp="empty"');
    expect(html).not.toContain('<polyline');
    expect(html).toContain('stroke-dasharray="1.2 3.2"');
  });

  it('joins the bases in sleeping order with a dotted line — an order, not a road', () => {
    const html = render({ center: null, bases: [{ name: 'Bishkek', lat: 42.87, lng: 74.6 }, { name: 'Karakol', lat: 42.49, lng: 78.39 }], stops: [{ lat: 42.6, lng: 76.2, day: 2 }] });
    expect(html).toContain('data-stamp="drawn"');
    expect(html).toContain('<polyline');
    expect(html).toContain('stroke-dasharray="0.1 3.4"');
    expect((html.match(/<rect /g) ?? []).length).toBe(2);
  });
});
