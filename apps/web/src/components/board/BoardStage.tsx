'use client';

import type { ReactNode } from 'react';
import type { DestinationImage as ImageRecord, ImageryFallback, PlaceCategory } from '@sidequest/core';
import { AtlasMap, type AtlasPoint } from '../atlas/AtlasMap';
import { DestinationImage } from '../DestinationImage';
import { cx } from '../ui';

export interface StagePlace {
  id: string;
  number: number;
  name: string;
  coordinates?: { lat: number; lng: number } | undefined;
  chosen: boolean;
  excluded: boolean;
}

export interface StageFeature {
  id: string;
  number: number;
  name: string;
  kind: string;
  meta: string;
  why: string | null;
  chosen: boolean;
  image: ImageRecord | null;
  fallback: ImageryFallback;
  category: PlaceCategory;
}

/**
 * THE BOARD'S STAGE — the place itself, before any list of it.
 *
 * A night atlas the width of the screen with every candidate as a numbered
 * specimen: the number on the pin is the number on the row, so "where is 07"
 * is answered by looking. Chosen places burn flare; skipped ones shrink to a
 * dot rather than vanish, because the traveller's own "no" is still a fact
 * about the map. The place being read rises as a print in the corner — its
 * photograph whole, never cropped (a share-alike file may not be), its kind,
 * how far it is and the one sentence of why.
 *
 * The print is a second rendering of facts the row already states, so it is
 * hidden from assistive technology: a screen reader hears the row once.
 */
export function BoardStage({
  base,
  places,
  focusedId,
  feature,
  onFocus,
  fallback,
}: {
  base: { name: string; coordinates: { lat: number; lng: number } } | null;
  places: readonly StagePlace[];
  focusedId: string | null;
  feature: StageFeature | null;
  onFocus: (placeId: string) => void;
  fallback: ReactNode;
}) {
  const points: AtlasPoint[] = [
    ...(base ? [{ id: 'base', lat: base.coordinates.lat, lng: base.coordinates.lng, label: `${base.name}, where you sleep`, mark: '⌂', state: 'base' as const }] : []),
    ...places
      .filter((place): place is StagePlace & { coordinates: { lat: number; lng: number } } => Boolean(place.coordinates))
      .map((place) => ({
        id: place.id,
        lat: place.coordinates.lat,
        lng: place.coordinates.lng,
        label: `${String(place.number).padStart(2, '0')}, ${place.name}${place.chosen ? ', in your trip' : place.excluded ? ', skipped' : ''}`,
        mark: String(place.number).padStart(2, '0'),
        state: place.chosen ? ('chosen' as const) : place.excluded ? ('muted' as const) : ('idle' as const),
      })),
  ];
  const chosen = places.filter((place) => place.chosen).length;

  return (
    <div className="relative h-full w-full">
      <AtlasMap
        className="absolute inset-0"
        testId="board-stage"
        ground="night"
        points={points}
        focusId={focusedId}
        onSelect={(id) => (id === 'base' ? undefined : onFocus(id))}
        fitKey={places.map((p) => p.id).join('|')}
        padding={{ top: 72, right: 64, bottom: 72, left: 64 }}
        ariaLabel={`Map of ${places.length} places${base ? ` around ${base.name}` : ''}, ${chosen} in your trip. Each number matches a place in the list.`}
        fallback={fallback}
      />
      {feature ? (
        <div
          key={feature.id}
          aria-hidden="true"
          className="pointer-events-none absolute bottom-12 left-4 z-20 w-[min(20rem,calc(100%-2rem))] overflow-hidden rounded-[18px] bg-night/92 text-bone shadow-[0_24px_60px_-24px_rgb(0_0_0/0.7)] ring-1 ring-bone/10 backdrop-blur-md fade-up max-lg:hidden"
          data-testid="board-stage-feature"
        >
          {feature.image ? (
            <div className="relative bg-white">
              <DestinationImage image={feature.image} fallback={feature.fallback} ratio={feature.image.width > 0 && feature.image.height > 0 && feature.image.width / feature.image.height >= 0.62 && feature.image.width / feature.image.height <= 6 ? `${feature.image.width} / ${feature.image.height}` : 'natural'} credit="none" category={feature.category} backdrop="paper" />
            </div>
          ) : null}
          <div className="p-4">
            <p className="flex items-center justify-between gap-3 text-[12px] text-bone/65">
              <span className="inline-flex items-center gap-2">
                <span className={cx('inline-grid h-6 min-w-6 place-items-center rounded-full px-1.5 font-mono text-[10.5px] font-semibold', feature.chosen ? 'bg-flare text-night' : 'bg-bone/12 text-bone')}>
                  {String(feature.number).padStart(2, '0')}
                </span>
                <span className="inline-block first-letter:uppercase">{feature.kind}</span>
              </span>
              {feature.chosen ? <span className="rounded-full bg-flare/15 px-2 py-0.5 font-medium text-flare">In your trip</span> : null}
            </p>
            <p className="mt-2 font-display text-[1.55rem] leading-[1.05] tracking-[-0.02em]">{feature.name}</p>
            <p className="mt-1.5 text-[12.5px] text-bone/65">{feature.meta}</p>
            {feature.why ? <p className="mt-2 text-sm leading-relaxed text-bone/85">{feature.why}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
