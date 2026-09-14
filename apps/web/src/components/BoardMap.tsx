'use client';

import { useMemo, useState } from 'react';
import { PLACE_CATEGORY_LABELS, type PlaceCategory } from '@sidequest/core';
import { InteractiveMap, type MapMarker } from './InteractiveMap';
import type { MapBasemap } from './map-adapter';
import { cx, FOCUS_RING, OVERLAY_INPUT } from './ui';

/**
 * THE BOARD, ON THE GROUND.
 *
 * Every place the board shows, drawn where it is relative to the bed, with
 * the two-way selection the board depends on (§10.5): pressing a pin focuses
 * the card, focusing a card lights its pin. The map's own controls — a
 * category filter, "chosen only", zoom, fit — never remove a place from the
 * board; they change what the drawing shows, and the caption accounts for
 * whatever has no published position.
 *
 * On a phone the map sits above the cards and can be folded away; on a wide
 * screen it is the sticky column beside them.
 */
export interface BoardMapPlace {
  id: string;
  name: string;
  coordinates?: { lat: number; lng: number } | undefined;
  chosen: boolean;
  travelMinutes: number | null;
  category?: PlaceCategory;
}

export function BoardMap({
  base,
  places,
  focusedId,
  onFocus,
  tiles = null,
  className,
}: {
  base: { name: string; coordinates: { lat: number; lng: number } } | null;
  places: readonly BoardMapPlace[];
  focusedId: string | null;
  onFocus: (placeId: string) => void;
  tiles?: MapBasemap | null;
  className?: string;
}) {
  const [chosenOnly, setChosenOnly] = useState(false);
  const [category, setCategory] = useState<PlaceCategory | 'all'>('all');
  const [open, setOpen] = useState(true);

  const categories = useMemo(() => {
    const seen = new Map<PlaceCategory, number>();
    for (const place of places) if (place.category) seen.set(place.category, (seen.get(place.category) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value);
  }, [places]);

  const shown = places.filter((place) => (!chosenOnly || place.chosen) && (category === 'all' || place.category === category));
  const placed: MapMarker[] = shown
    .filter((place): place is BoardMapPlace & { coordinates: { lat: number; lng: number } } => Boolean(place.coordinates))
    .map((place) => ({ id: place.id, name: place.name, coordinates: place.coordinates, kind: 'place', chosen: place.chosen, travelMinutes: place.travelMinutes, ...(place.category ? { category: place.category } : {}) }));
  const unplaced = shown.filter((place) => !place.coordinates);
  if (places.every((place) => !place.coordinates)) return null;

  const chosenCount = placed.filter((pin) => pin.chosen).length;
  const summary = `${[
    `${placed.length} ${placed.length === 1 ? 'place' : 'places'} on the map`,
    base ? `around ${base.name}` : null,
    chosenCount > 0 ? `${chosenCount} of them chosen` : null,
    unplaced.length > 0 ? `${unplaced.length} more with no published position` : null,
  ]
    .filter(Boolean)
    .join(', ')}.`;

  return (
    <div className={cx('min-w-0', className)} data-testid="board-map-panel">
      <div className="mb-2 flex items-center justify-between lg:hidden">
        <span className="text-sm font-medium text-ink">Map</span>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="board-map-body" className={cx('min-h-11 px-2 text-sm text-accent underline underline-offset-2', FOCUS_RING)} data-testid="board-map-toggle">
          {open ? 'Hide map' : 'Show map'}
        </button>
      </div>
      <div id="board-map-body" className={cx(!open && 'hidden lg:block')}>
        {placed.length > 0 ? (
          <InteractiveMap
            testId="board-map"
            markers={placed}
            base={base}
            focusedId={focusedId}
            onFocus={onFocus}
            tiles={tiles}
            summary={summary}
          />
        ) : (
          <p className="rounded-[var(--radius-card)] border border-dashed border-rule bg-paper-sunk p-4 text-sm text-ink-muted" data-testid="board-map">
            Nothing to draw with these map filters — every place is still on the board below.
          </p>
        )}
        {unplaced.length > 0 ? (
          <p className="mt-1 text-[11px] leading-snug text-ink-faint" data-testid="board-map-unplaced">
            Not on the map, because nobody publishes where {unplaced.length === 1 ? 'it is' : 'they are'}:{' '}
            {unplaced
              .slice(0, 4)
              .map((place) => place.name)
              .join(', ')}
            {unplaced.length > 4 ? ` and ${unplaced.length - 4} more` : ''}.
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Map filters">
          <label className={cx('relative inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs', FOCUS_RING, chosenOnly ? 'border-accent bg-accent-soft text-accent-strong' : 'border-rule text-ink-muted')}>
            <input type="checkbox" className={OVERLAY_INPUT} checked={chosenOnly} onChange={(event) => setChosenOnly(event.target.checked)} data-testid="board-map-chosen-only" />
            <span aria-hidden="true">{chosenOnly ? '✓ ' : ''}</span>
            Chosen only
          </label>
          {categories.length > 1 ? (
            <label className="inline-flex min-h-9 items-center gap-1.5 text-xs text-ink-muted">
              <span>Show</span>
              <select value={category} onChange={(event) => setCategory(event.target.value as PlaceCategory | 'all')} className="rounded-[var(--radius-control)] border border-rule bg-paper px-2 py-1 text-xs text-ink" aria-label="Filter the map by kind of place" data-testid="board-map-category">
                <option value="all">every kind of place</option>
                {categories.map((value) => (
                  <option key={value} value={value}>
                    {PLACE_CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>
    </div>
  );
}
