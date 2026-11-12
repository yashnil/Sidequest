'use client';

import { useState } from 'react';
import { ErrorNote } from '../ui';
import { CollectionCover } from '../collection/CollectionCover';
import type { DashboardCardRow } from '@/app/(product)/trips/TripCard';

/** The up-next cover inside the night stage, with its own place to say that a menu action failed. */
export function StageCover({ row, catalogue, today }: { row: DashboardCardRow; catalogue: number; today: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <CollectionCover row={row} catalogue={catalogue} today={today} onError={setError} embedded />
      {error ? (
        <div className="pb-6">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
    </>
  );
}
