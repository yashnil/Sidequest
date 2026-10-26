'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AtlasMap } from '../atlas/AtlasMap';
import { planToAtlas, type PlanConnector, type PlanMark } from '../atlas/atlas-model';

/**
 * THE TRIP'S COVER — the whole route, as the ground the title sits on.
 *
 * Every stop and base of the plan on the night atlas, drawn from the same
 * server model as the overview map, the measured legs drawing themselves in
 * once. The title and the day strip sit over the left of it on a wide screen,
 * so the camera keeps that side clear; on a phone the map is a band above them.
 * No controls: the cover is a picture you can read, the Map view is where you
 * work the map.
 */
export function CoverStage({
  marks,
  connectors,
  base,
  ariaLabel,
  fallback,
}: {
  marks: readonly (PlanMark & { dayNumber?: number })[];
  connectors: readonly PlanConnector[];
  base: { name: string; coordinates: { lat: number; lng: number } } | null;
  ariaLabel: string;
  fallback: ReactNode;
}) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const update = () => setWide(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  /*
   * Each stop wears the number of the day it is on, so a pin on the cover and
   * a cell in the day strip under it say the same thing: "that is day 3".
   */
  const { points, lines } = planToAtlas({
    marks: marks.map((mark) => (mark.kind === 'place' || mark.kind === 'stop' || mark.kind === 'signature') && mark.dayNumber !== undefined ? { ...mark, kind: mark.kind === 'place' ? ('stop' as const) : mark.kind, order: mark.dayNumber } : mark),
    connectors,
    base,
    label: (mark) => (mark.order !== undefined ? `Day ${mark.order}: ${mark.name}` : mark.name),
  });
  return (
    <AtlasMap
      /* Transparent until the tiles paint, so the band's contour sheet shows instead of a black slab. */
      className="absolute inset-0 !bg-transparent"
      testId="cover-stage"
      ground="night"
      points={points}
      lines={lines}
      controls={false}
      fitKey={wide ? 'wide' : 'narrow'}
      padding={wide ? { top: 96, right: 72, bottom: 200, left: 700 } : { top: 40, right: 32, bottom: 40, left: 32 }}
      ariaLabel={ariaLabel}
      fallback={fallback}
    />
  );
}
