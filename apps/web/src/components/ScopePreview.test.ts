import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PreflightCluster, PreflightPortfolio } from '@sidequest/core';
import { ScopePreview } from './ScopePreview';
import type { MapTileSource } from './map-adapter';

/**
 * WHAT THE REGION PANEL ACTUALLY PUTS ON SCREEN.
 *
 * Three things are asserted here that no geometry test can see:
 *
 *   1. **The testid other specs select on still exists.** `scope-preview` is
 *      used by browser specs this slice does not own, and a rename would break
 *      them somewhere far from the change.
 *   2. **Nothing is drawn that we did not read.** §32 forbids a fake map visual
 *      labelled as a real one. The strongest available form of that is a scan of
 *      the emitted markup for the primitives a fake basemap would need —
 *      background fills, landmasses, decorative paths — and a check that the
 *      caption states what the figure *is* rather than only what it is not.
 *   3. **The text alternative carries the same structure as the picture.** A
 *      figure whose accessible name is "a map of the region" excludes a screen
 *      reader user from the decision the figure exists to explain.
 */

function cluster(id: string, name: string, lat: number, lng: number): PreflightCluster {
  return {
    id,
    name,
    center: { lat, lng },
    memberCount: 3,
    memberNames: [],
    distanceFromGatewayKm: 0,
    transferMinutesFromGateway: 0,
  };
}

const PORTFOLIO: PreflightPortfolio = {
  gateway: { name: 'Harbourmouth', center: { lat: 38.72, lng: -9.14 } },
  route: [
    cluster('harbour', 'Harbourmouth', 38.72, -9.14),
    cluster('ridge', 'Ridgeford', 39.6, -8.4),
  ],
  baseReasons: [
    { clusterId: 'harbour', reason: 'The densest part of the region.', nights: 3, transferMinutes: 0 },
    {
      clusterId: 'ridge',
      reason: 'Too far to reach and come back in a day.',
      nights: 2,
      transferMinutes: 125,
    },
  ],
  satellites: [
    { cluster: cluster('spur', 'Spurwater', 38.95, -9.0), baseId: 'harbour', transferMinutes: 34 },
  ],
  excluded: [
    {
      cluster: cluster('far', 'Farfield', 41.8, -6.2),
      reason: 'Further out than this trip has days for.',
    },
  ],
  basesProposed: 2,
  transferDays: 0.5,
  mode: 'drive',
  reachRadiusKm: 200,
  rationale: 'Four areas found; this route uses two bases.',
  estimated: true,
};

function markup(portfolio: PreflightPortfolio, tiles?: MapTileSource | null): string {
  return renderToStaticMarkup(
    createElement(ScopePreview, { portfolio, title: 'Testland', tiles: tiles ?? null }),
  );
}

describe('the region panel', () => {
  const html = markup(PORTFOLIO);

  it('keeps the handle other specifications select on', () => {
    expect(html).toContain('data-testid="scope-preview"');
    expect(html).toContain('data-testid="region-figure"');
  });

  it('renders nothing at all when there is no route', () => {
    expect(markup({ ...PORTFOLIO, route: [], baseReasons: [] })).toBe('');
  });

  it('names every area it drew', () => {
    for (const name of ['Harbourmouth', 'Ridgeford', 'Spurwater', 'Farfield']) {
      expect(html).toContain(name);
    }
  });

  it('prints the travel cost of the move, marked as an estimate', () => {
    expect(html).toContain('≈2 hr 5 min');
    expect(html).toContain('straight-line estimates');
  });

  it('shows a scale bar and a north indicator so the projection is checkable', () => {
    expect(html).toContain('>N<');
    expect(html).toMatch(/>\d+ km</);
    expect(html).toContain('Web Mercator');
  });

  /**
   * §32: no fake map visuals. The figure may draw marks, rings, legs and its own
   * furniture — and nothing that would read as terrain.
   */
  it('draws no geography it did not read', () => {
    // A basemap needs a filled backdrop. There is none: no full-frame rect, no
    // painted background, no landmass polygon.
    expect(html).not.toMatch(/<rect[^>]*width="320"[^>]*height="250"[^>]*fill=/);
    expect(html).not.toMatch(/<polygon/);
    // No image is loaded when no tile source is configured — which is every
    // build, so this is the shipped state rather than a fallback.
    expect(html).not.toContain('<image');
    /*
     * Every `<path>` in the figure is accounted for: it is either a distance
     * ring — a closed loop of 72 vertices walked out from a real coordinate — or
     * the north indicator. Anything else appearing here would be a shape nobody
     * can trace back to a number we hold, which is the definition of a fake map.
     */
    const paths = [...html.matchAll(/<path[^>]*?>/g)].map((match) => match[0]);
    expect(paths.length).toBeGreaterThan(2);
    for (const path of paths) {
      if (path.includes('data-role="north"')) continue;
      expect(path, path.slice(0, 60)).toContain('data-ring=');
      expect(/\sd="([^"]*)"/.exec(path)![1]!.split('L')).toHaveLength(72);
    }
  });

  it('says what the figure is, not only what it is not', () => {
    expect(html).toContain('Every mark is one source coordinate');
    expect(html).toContain('no coastline, border or road');
    // The sentence the phase brief singled out as the thing to stop settling for.
    expect(html).not.toContain('Relative positions from source coordinates. Not a map.');
  });

  it('legends the day reach it draws', () => {
    expect(html).toContain('a day out and back');
  });

  /**
   * The structure reach is stated either way, and the legend only claims a
   * swatch when there is a circle to point at.
   */
  it('says the structure reach in words when the ring will not fit', () => {
    expect(html).toContain('Region reach ≈200 km, wider than this frame');
    expect(html).not.toContain('— the whole region');
  });

  it('legends the structure reach when the ring is on the canvas', () => {
    const compact = markup({
      ...PORTFOLIO,
      route: [PORTFOLIO.route[0]!],
      baseReasons: [PORTFOLIO.baseReasons[0]!],
      satellites: [],
      excluded: [],
      mode: 'walk',
      reachRadiusKm: 15,
    });
    expect(compact).toContain('15 km — the whole region');
  });

  /**
   * The text alternative. Not a caption — the same structure, in words.
   */
  it('describes the structure in text, for everybody', () => {
    /*
     * This written key used to be `sr-only`, and that was two mistakes.
     *
     * The marks carry truncated names — a review found four separate marks all
     * rendering as "Ambervale Coast T…", so the figure could not be read by
     * anyone. And the *reasons* were reaching only people who could not see the
     * picture: the figure draws a dashed circle for an excluded area and says
     * nothing about why, while the hidden text said exactly why.
     *
     * One list, visible, doing the job for everybody. Asserted without the
     * `sr-only` class, because whether it is hidden is now the thing that
     * changed and pinning it would pin the defect.
     */
    expect(html).toMatch(/aria-label="Testland: 2 bases, 1 area reachable in a day, 1 area left out/);
    expect(html).toContain('Harbourmouth');
    expect(html).toContain('The densest part of the region.');
    expect(html).toContain('Ridgeford');
    expect(html).toContain('about 2 hr 5 min from the previous base');
    expect(html).toContain('Spurwater');
    expect(html).toContain('there and back in a day');
    expect(html).toContain('Farfield');
    expect(html).toContain('Further out than this trip has days for.');
  });

  it('shows every name in full, whatever the figure had room to draw', () => {
    /*
     * The property the truncated labels broke. A name the figure had to shorten
     * must still be readable somewhere, or the drawing is a set of anonymous
     * dots — which is what a review found on a live capture.
     */
    for (const name of ['Harbourmouth', 'Ridgeford', 'Spurwater', 'Farfield']) {
      expect(html).toContain(name);
      /* And not only as the elided form the SVG may have used. */
      expect(html).toContain(`>${name}<`);
    }
  });
});

/**
 * THE ADAPTER SEAM, EXERCISED.
 *
 * Not because a basemap ships — none does — but because "we preserved a path" is
 * a claim that has to be true. Passing a source draws tiles under the same marks
 * and prints the provider's attribution, which is what the terms of every tile
 * service require and what an unconfigured build must never silently omit.
 */
describe('with a basemap configured', () => {
  const source: MapTileSource = {
    urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png',
    attribution: '© Example contributors',
    tileSize: 256,
    maxZoom: 19,
  };
  const html = markup(PORTFOLIO, source);

  it('draws the tiles', () => {
    expect(html).toContain('<image');
    expect(html).toMatch(/href="https:\/\/tiles\.example\/\d+\/\d+\/\d+\.png"/);
  });

  it('keeps the marks, so the figure is still the decision rather than a map', () => {
    expect(html).toContain('Harbourmouth');
    expect(html).toContain('a day out and back');
  });

  it('credits the provider, because every one of them requires it', () => {
    expect(html).toContain('Basemap: © Example contributors.');
  });
});
