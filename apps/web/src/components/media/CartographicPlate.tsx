import { cx } from '../ui';
import { MEDIA_CONTEXT_SPECS, type MediaContext } from '@/lib/media/frame';
import { coordinateLabel, plateGeometry } from './plate-geometry';

/**
 * THE PLATE: WHAT A FRAME SHOWS WHEN THERE IS NO PHOTOGRAPH WE TRUST.
 *
 * A Field Atlas sheet — night ground, the contour texture, bone ink, one flare
 * waypoint — cut around the place's real coordinates: Natural Earth land as a
 * dot lattice, real graticule lines, the extent ring at its true radius. It is
 * labelled as what it is ("Map · no photograph"), because a stand-in that
 * could be mistaken for a photograph would be the one thing worse than a
 * wrong photograph. The contour texture is texture only and never presented
 * as terrain (design-system.md).
 *
 * Server-renderable SVG with no fetch. Scales from a 200 px thumbnail to a
 * full-width hero; the typography is only drawn where there is room for it.
 */
export function CartographicPlate({
  name,
  lat,
  lng,
  radiusKm,
  context,
  showName = context === 'hero' || context === 'strip',
  className,
  rounded = true,
  decorative = false,
}: {
  name: string;
  lat: number;
  lng: number;
  radiusKm?: number;
  context: MediaContext;
  /** Set the place's name on the plate. Off where the card already prints it beside the frame. */
  showName?: boolean;
  className?: string;
  rounded?: boolean;
  /** True when a photograph sits on top: the plate is then scenery, hidden from assistive technology. */
  decorative?: boolean;
}) {
  const valid = Number.isFinite(lat) && Number.isFinite(lng);
  const geometry = valid ? plateGeometry({ lat, lng, ...(radiusKm ? { radiusKm } : {}), context }) : null;
  const small = context === 'thumb';
  const description = valid
    ? `A map, not a photograph: ${name} at ${coordinateLabel(lat, lng)}, drawn from its coordinates. No freely licensed photograph we could verify was available.`
    : `${name}. No freely licensed photograph we could verify was available.`;

  return (
    <div
      {...(decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': description })}
      data-testid="media-plate"
      data-context={context}
      className={cx('topo relative isolate overflow-hidden bg-night text-bone', rounded && 'rounded-[var(--radius-card)]', className)}
      style={{
        aspectRatio: MEDIA_CONTEXT_SPECS[context].cssAspect,
        ['--topo-opacity' as string]: '0.06',
        ['--topo-size' as string]: small ? '480px 320px' : '960px 640px',
        backgroundImage:
          'radial-gradient(ellipse 70% 90% at 88% 0%, rgb(255 90 31 / 0.14), transparent 60%), radial-gradient(ellipse 60% 80% at 0% 100%, rgb(127 209 224 / 0.10), transparent 62%)',
      }}
    >
      {geometry ? (
        <svg
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          preserveAspectRatio="xMidYMid slice"
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
          focusable="false"
        >
          <g stroke="rgb(241 235 223 / 0.10)" strokeWidth={geometry.width / 1200} fill="none">
            {geometry.graticule.map((line) =>
              line.kind === 'lng' ? (
                <line key={`g-lng-${line.value}`} x1={line.at} y1={0} x2={line.at} y2={geometry.height} />
              ) : (
                <line key={`g-lat-${line.value}`} x1={0} y1={line.at} x2={geometry.width} y2={line.at} />
              ),
            )}
          </g>
          <path
            d={geometry.land}
            fill="none"
            stroke="rgb(241 235 223 / 0.42)"
            strokeWidth={geometry.step * 0.34}
            strokeLinecap="round"
          />
          {!small ? (
            <g fill="rgb(241 235 223 / 0.42)" fontFamily="var(--font-mono)" fontSize={geometry.width / 80} letterSpacing="0.06em">
              {geometry.graticule.map((line) =>
                line.kind === 'lng' ? (
                  line.at > 24 && line.at < geometry.width - 40 ? (
                    <text key={`t-lng-${line.value}`} x={line.at + 4} y={geometry.width / 70}>
                      {line.label}
                    </text>
                  ) : null
                ) : line.at > 24 && line.at < geometry.height - 12 ? (
                  <text key={`t-lat-${line.value}`} x={geometry.width - 6} y={line.at - 4} textAnchor="end">
                    {line.label}
                  </text>
                ) : null,
              )}
            </g>
          ) : null}
          {geometry.ring ? (
            <circle
              cx={geometry.point.x}
              cy={geometry.point.y}
              r={geometry.ring}
              fill="rgb(127 209 224 / 0.07)"
              stroke="var(--color-glacier)"
              strokeOpacity={0.7}
              strokeWidth={geometry.width / 700}
              strokeDasharray={`${geometry.width / 160} ${geometry.width / 240}`}
            />
          ) : null}
          <circle cx={geometry.point.x} cy={geometry.point.y} r={geometry.step * 0.95} fill="var(--color-flare)" opacity={0.18} />
          <circle cx={geometry.point.x} cy={geometry.point.y} r={geometry.step * 0.36} fill="var(--color-flare)" stroke="var(--color-night)" strokeWidth={geometry.step * 0.12} />
        </svg>
      ) : null}

      {/* Bottom scrim so the type always sits on night, whatever the land does. */}
      {!small ? <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-night/85 via-night/30 to-transparent" /> : null}

      {!small ? (
        <div className="absolute inset-0 flex flex-col justify-between p-4 sm:p-5">
          <p className="font-mono text-[0.625rem] font-medium tracking-[0.14em] text-bone/70 uppercase">
            <span aria-hidden="true" className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-flare align-middle" />
            Map · no photograph
          </p>
          <div className="min-w-0">
            {showName ? (
              <p className="font-display text-[clamp(1.5rem,1rem+2.4vw,3rem)] leading-[1] font-[360] tracking-[-0.02em] [overflow-wrap:anywhere] text-bone">
                {name}
              </p>
            ) : null}
            {valid ? (
              <p className={cx('font-mono text-[0.6875rem] tracking-[0.04em] text-bone/65', showName && 'mt-2')}>
                {coordinateLabel(lat, lng)}
                {radiusKm && radiusKm >= 5 ? ` · about ${Math.round(radiusKm * 2)} km across` : ''}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
