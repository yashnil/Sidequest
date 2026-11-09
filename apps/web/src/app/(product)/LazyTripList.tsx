'use client';

import dynamic from 'next/dynamic';

/**
 * The returning traveller's trip list, in a chunk of its own.
 *
 * A first-time visitor has no trips, and `TripCard` brings `@sidequest/core`'s
 * lifecycle tables and zod with it (32 KB gzipped). This file exists because
 * `next/dynamic` only code-splits when it is called from a Client Component.
 * Still server-rendered: someone with trips sees them in the document.
 */
export const LazyTripList = dynamic(() => import('./TripList').then((module) => module.TripList));
