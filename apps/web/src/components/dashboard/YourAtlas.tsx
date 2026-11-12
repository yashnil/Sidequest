import Link from 'next/link';
import { WorldDots } from '../advisor/WorldDots';
import { atlasPosition } from './stage-model';

export interface AtlasTrip {
  id: string;
  title: string;
  href: string;
  lat: number;
  lng: number;
  /** The trip's catalogue number, so a mark and its entry below say the same thing. */
  catalogue: number;
  upNext: boolean;
  past: boolean;
}

/**
 * YOUR ATLAS — every trip somebody has made, as a flare mark on the world.
 *
 * The same dotted Natural Earth sheet the advisor draws (`WorldDots`, pure SVG,
 * no map library and no request), with the traveller's own trips laid over it
 * at their persisted centres. Each mark is a link to its trip; its name shows
 * on hover and focus. The trip about to happen breathes (`mark-sonar`); trips
 * that are over are drawn hollow. Trips at the same spot share one mark, which
 * names how many. A trip with no placed centre is simply not on the sheet.
 */
export function YourAtlas({ trips }: { trips: readonly AtlasTrip[] }) {
  const groups = new Map<string, AtlasTrip[]>();
  for (const trip of trips) {
    const key = `${Math.round(trip.lat * 2) / 2},${Math.round(trip.lng * 2) / 2}`;
    groups.set(key, [...(groups.get(key) ?? []), trip]);
  }
  const marks = [...groups.values()]
    .map((group) => {
      const lead = group.find((t) => t.upNext) ?? group.find((t) => !t.past) ?? group[0]!;
      const at = atlasPosition(lead.lat, lead.lng);
      return at ? { lead, group, at } : null;
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  return (
    <figure className="relative m-0 min-w-0" aria-label={`Your atlas: ${marks.length} ${marks.length === 1 ? 'place' : 'places'} on the map`} data-testid="dashboard-atlas">
      <div className="relative">
        <WorldDots highlighted={[]} tone="night" className="block h-auto w-full" label="The world, dotted" />
        <ul className="absolute inset-0 m-0 list-none p-0">
          {marks.map(({ lead, group, at }, index) => {
            const flipLeft = at.left > 70;
            const name = group.length > 1 ? `${lead.title} · ${group.length} trips` : lead.title;
            return (
              <li key={lead.id} className="absolute" style={{ left: `${at.left}%`, top: `${at.top}%` }}>
                <Link
                  href={lead.href}
                  className="group/mark fade-up absolute -translate-x-1/2 -translate-y-1/2 rounded-full p-2.5 focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)]"
                  style={{ ['--d' as string]: `${380 + index * 70}ms` }}
                  aria-label={`Open ${name}`}
                  data-testid="dashboard-atlas-mark"
                >
                  <span aria-hidden="true" className="relative block h-3 w-3">
                    {lead.upNext ? <span className="mark-sonar absolute inset-0 rounded-full bg-[var(--color-flare)]" /> : null}
                    <span className={`absolute inset-0 rounded-full transition-transform duration-[var(--motion-fast)] group-hover/mark:scale-150 group-focus-visible/mark:scale-150 ${lead.past ? 'border-2 border-[var(--color-flare)] bg-[var(--color-night)]' : 'bg-[var(--color-flare)] shadow-[0_0_0_3px_rgb(13_26_31/0.9)]'}`} />
                  </span>
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap border border-white/15 bg-[var(--color-night)]/95 px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-atlas-ink)] opacity-0 transition-opacity duration-[var(--motion-fast)] group-hover/mark:opacity-100 group-focus-visible/mark:opacity-100 ${flipLeft ? 'right-full mr-1' : 'left-full ml-1'}`}
                  >
                    <span className="text-[var(--color-flare)]">{String(lead.catalogue).padStart(2, '0')}</span>
                    {name}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      <figcaption className="coordbar mt-3 flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 !whitespace-normal text-[var(--color-atlas-muted)]">
        <span>Your atlas · {marks.length} {marks.length === 1 ? 'place' : 'places'}</span>
        <span className="inline-flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--color-flare)]" /> ahead
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-full border-[1.5px] border-[var(--color-flare)]" /> been
          </span>
        </span>
      </figcaption>
    </figure>
  );
}
