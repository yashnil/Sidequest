import { useId } from 'react';
import type { PreflightPortfolio } from '@sidequest/core';
import { formatMinutes } from '@/lib/format';
import { buildRegionFigure, type FigureLabel } from './region-figure';
import { tilesForViewport, type MapTileSource } from './map-adapter';

/**
 * WHAT THE TRIP LOOKS LIKE ON THE GROUND.
 *
 * A traveller who has typed a country and been told "we found four areas" has no
 * way to check that against what they pictured. This draws the decision: the
 * bases, the ground a day trip reaches from each, the areas that hang off them,
 * the legs between them with what each one costs in travel, and the areas we are
 * *not* including — which is the half a list of names hides.
 *
 * ---
 *
 * WHY IT IS THIS AND NOT A MAP.
 *
 * §19.2 is explicit that "Relative positions from source coordinates. Not a map."
 * should not be the best visual the product can manage. It is no longer the
 * caption, and the reason is not that a basemap appeared — it is that the old
 * figure was drawing about a tenth of what it held. The portfolio carries a
 * reason for every base, the nights each holds, the areas reachable and back
 * inside a day, the reason each excluded area was excluded, and the radius the
 * structure actually reaches. None of that was on screen. A caption apologising
 * for the absence of tiles was answering the wrong complaint.
 *
 * What *is* still absent is a basemap, and the honest reason is in
 * `map-adapter.ts`: every tile service comes with terms nobody has agreed to on
 * this project, and Google's own terms forbid drawing Places content on a
 * non-Google map at all. So §20's escape clause is taken literally — the
 * visualization is improved and an explicit adapter path is preserved. Pass a
 * `tiles` source and a basemap renders under these same marks, on the same
 * projection, with the provider's attribution; pass nothing, which is every
 * build today, and the data-driven figure stands on its own rather than
 * degrading into an empty grey square.
 *
 * Nothing here is invented geography. Every mark is a coordinate on a
 * `PreflightCluster`; every ring is a real ground distance walked out from one.
 * There is no coastline, border, road or landmass, because we have not read one.
 *
 * ---
 *
 * ACCESSIBILITY. The SVG is `role="img"` with a one-sentence accessible name,
 * and the whole structure is repeated underneath as a real list that screen
 * readers reach and sighted users do not see. That list is generated from the
 * same `buildRegionFigure` result as the drawing, so it cannot describe a mark
 * the picture does not have or omit one it does.
 */

const PAPER = 'var(--color-paper-raised)';
const INK = 'var(--color-ink)';
const FAINT = 'var(--color-ink-faint)';
const PINE = 'var(--color-pine)';

/** A halo behind text so a label stays readable over a ring or an edge. */
const HALO = { stroke: PAPER, strokeWidth: 2.5, paintOrder: 'stroke' } as const;

function Label({ label, fill, weight }: { label: FigureLabel; fill: string; weight?: number }) {
  return (
    <text
      x={label.x}
      y={label.y}
      textAnchor={label.anchor}
      fontSize={label.fontSize}
      fontWeight={weight}
      fill={fill}
      {...HALO}
    >
      {label.lines.map((line, index) => (
        <tspan key={`${index}:${line}`} x={label.x} dy={index === 0 ? 0 : 10}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

export function ScopePreview({
  portfolio,
  title,
  tiles = null,
}: {
  portfolio: PreflightPortfolio;
  title: string;
  /**
   * A basemap, when one has been configured and its terms accepted.
   *
   * Resolved by a caller from `resolveMapTileSource(process.env)` rather than
   * read here: this component is part of a client tree, and — more to the point
   * — `lib/render-purity.architecture.test.ts` exists to keep environment and
   * provider work out of the render path. A prop is the seam; `null` is the
   * shipped state.
   */
  tiles?: MapTileSource | null;
}) {
  const captionId = useId();
  /*
   * `useId` emits colons, which are legal in an HTML id and awkward inside a
   * `url(#…)` reference. Stripped rather than worked around, so the clip path
   * the basemap needs resolves in every renderer.
   */
  const svgId = captionId.replace(/[^a-zA-Z0-9_-]/g, '');
  const figure = buildRegionFigure(portfolio, title);
  if (!figure) return null;

  const { width, height, marks, edges, rings, scale } = figure;
  const bases = marks.filter((mark) => mark.role === 'base');
  const satellites = marks.filter((mark) => mark.role === 'satellite');
  const excluded = marks.filter((mark) => mark.role === 'excluded');
  const baseNameById = new Map(bases.map((base) => [base.id, base.name]));
  const placedTiles = tiles ? tilesForViewport({ viewport: figure.viewport, source: tiles }) : [];

  return (
    <figure className="m-0" data-testid="scope-preview">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={figure.summary}
        aria-describedby={captionId}
        data-testid="region-figure"
      >
        {/*
          The basemap, when one is configured. Clipped to the frame so a tile can
          never paint over the scale bar or the legend below it.
        */}
        {placedTiles.length > 0 ? (
          <>
            <clipPath id={`${svgId}-frame`}>
              <rect x={0} y={0} width={width} height={height} />
            </clipPath>
            <g clipPath={`url(#${svgId}-frame)`} opacity={0.85}>
              {placedTiles.map((tile) => (
                <image
                  key={`${tile.z}/${tile.x}/${tile.y}`}
                  href={tile.href}
                  x={tile.left}
                  y={tile.top}
                  width={tile.size}
                  height={tile.size}
                />
              ))}
            </g>
          </>
        ) : null}

        {/*
          Distance first, so everything else sits on top of it. The wide ring is
          how far this structure reaches; the small ones are a day out and back
          from each base — and where two of those overlap, the traveller can see
          for themselves that the second base is buying less new ground than it
          costs in packing, which is one of the questions §19.2 asks the preview
          to answer.
        */}
        {rings.map((ring) => (
          <path
            key={ring.id}
            data-ring={ring.kind}
            d={ring.path}
            fill={ring.kind === 'day_reach' ? PINE : 'none'}
            fillOpacity={ring.kind === 'day_reach' ? 0.06 : 0}
            stroke={ring.kind === 'day_reach' ? PINE : FAINT}
            strokeOpacity={ring.kind === 'day_reach' ? 0.35 : 0.5}
            strokeWidth={ring.kind === 'day_reach' ? 0.75 : 1}
            strokeDasharray={ring.kind === 'day_reach' ? '3 3' : '1 4'}
          />
        ))}

        {edges.map((edge) => (
          <line
            key={edge.id}
            x1={edge.from.x}
            y1={edge.from.y}
            x2={edge.to.x}
            y2={edge.to.y}
            stroke={PINE}
            strokeOpacity={edge.kind === 'transfer' ? 1 : 0.4}
            strokeWidth={edge.kind === 'transfer' ? 1.5 : 1}
            strokeDasharray={edge.kind === 'transfer' ? '4 3' : '1.5 2.5'}
            strokeLinecap="round"
          />
        ))}

        {excluded.map((mark) => (
          <circle
            key={mark.id}
            cx={mark.at.x}
            cy={mark.at.y}
            r={mark.radius}
            fill="none"
            stroke={FAINT}
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        ))}

        {satellites.map((mark) => (
          <circle
            key={mark.id}
            cx={mark.at.x}
            cy={mark.at.y}
            r={mark.radius}
            fill={PAPER}
            stroke={PINE}
            strokeWidth={1.5}
          />
        ))}

        {bases.map((mark) => (
          <g key={mark.id}>
            <circle
              cx={mark.at.x}
              cy={mark.at.y}
              r={mark.radius}
              fill={PINE}
              stroke={PAPER}
              strokeWidth={1.5}
            />
            {/* The route order, on the mark, because "which one is first" is the
                first thing anybody asks of a multi-base plan. */}
            <text
              x={mark.at.x}
              y={mark.at.y + 2.6}
              textAnchor="middle"
              fontSize={7.5}
              fontWeight={600}
              fill={PAPER}
            >
              {mark.order}
            </text>
          </g>
        ))}

        {edges.map((edge) =>
          edge.label ? <Label key={`${edge.id}-label`} label={edge.label} fill={FAINT} /> : null,
        )}
        {excluded.map((mark) =>
          mark.label ? <Label key={`${mark.id}-label`} label={mark.label} fill={FAINT} /> : null,
        )}
        {satellites.map((mark) =>
          mark.label ? <Label key={`${mark.id}-label`} label={mark.label} fill={INK} /> : null,
        )}
        {bases.map((mark) =>
          mark.label ? (
            <Label key={`${mark.id}-label`} label={mark.label} fill={INK} weight={600} />
          ) : null,
        )}

        {/*
          A scale bar and a north indicator, so the projection is checkable
          rather than merely asserted. North is up by construction — Web Mercator
          has no rotation — and the bar is exact at the middle of the frame,
          which the caption states rather than glossing over.
        */}
        <g stroke={FAINT} strokeWidth={1} fill="none">
          <line x1={scale.x} y1={scale.y} x2={scale.x + scale.pixels} y2={scale.y} />
          <line x1={scale.x} y1={scale.y - 3} x2={scale.x} y2={scale.y + 3} />
          <line
            x1={scale.x + scale.pixels}
            y1={scale.y - 3}
            x2={scale.x + scale.pixels}
            y2={scale.y + 3}
          />
        </g>
        <text x={scale.x} y={scale.y + 12} fontSize={8.5} fill={FAINT}>
          {scale.km < 1 ? `${scale.km * 1000} m` : `${scale.km} km`}
        </text>

        <g stroke={FAINT} strokeWidth={1} fill="none">
          <line x1={width - 14} y1={26} x2={width - 14} y2={10} />
          <path
            data-role="north"
            d={`M${width - 18} 15 L${width - 14} 9 L${width - 10} 15`}
            strokeLinejoin="round"
          />
        </g>
        <text x={width - 14} y={35} textAnchor="middle" fontSize={8} fill={FAINT}>
          N
        </text>
      </svg>

      {/*
        THE SAME FIGURE, IN WORDS.

        Not a paraphrase and not a caption: every mark drawn above appears here
        with the thing it is carrying — the reason a base was chosen and how long
        it holds, the base a day trip hangs off and how far out it is, and the
        reason each excluded area was excluded. A picture whose text alternative
        is "a map of the region" is a picture that excludes people from the
        decision it is explaining.
      */}
      {/*
        THE KEY, VISIBLE — WHICH ALSO FIXES THE FIGURE.

        This list was `sr-only`, and that was two mistakes rather than one.

        The first: the marks carry truncated names, and a review found four
        separate marks all rendering as "Ambervale Coast T…" — the figure could
        not be read at all, by anyone. A drawing whose labels collide needs a
        key, and the key already existed; it was just hidden.

        The second: the *reasons* were sighted-user-inaccessible. The figure
        shows a dashed circle for an area we left out and says nothing about
        why, while the text alternative said exactly why. Section 19.2 asks the
        preview to answer "what is being left out, and why" — and it was
        answering it only for people who could not see the picture.

        So one list, visible, doing the job for everybody. `aria-label` on the
        figure still carries the summary, and the figure itself is
        `aria-hidden` from this list's point of view because the list is now the
        readable version rather than a duplicate of it.
      */}
      <div className="mt-3 border-t border-rule pt-3">
        <ul className="space-y-1.5 text-[13px] leading-relaxed text-ink-muted">
          {bases.map((mark) => (
            <li key={mark.id} className="flex gap-2">
              <span
                aria-hidden="true"
                className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-pine text-[10px] font-semibold text-paper-raised"
              >
                {mark.order}
              </span>
              <span>
                <span className="font-medium text-ink">{mark.name}</span>
                {mark.nights ? ` · ${mark.nights} night${mark.nights === 1 ? '' : 's'}` : ''}
                {mark.transferMinutes
                  ? ` · about ${formatMinutes(mark.transferMinutes)} from the previous base (estimated)`
                  : ''}
                {mark.note ? <span className="block text-ink-faint">{mark.note}</span> : null}
              </span>
            </li>
          ))}
          {satellites.map((mark) => (
            <li key={mark.id} className="flex gap-2">
              <span
                aria-hidden="true"
                className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-pine bg-paper-raised"
              />
              <span>
                <span className="font-medium text-ink">{mark.name}</span>
                {` · about ${formatMinutes(mark.transferMinutes ?? 0)} from ${
                  baseNameById.get(mark.baseId ?? '') ?? 'its base'
                }, there and back in a day (estimated)`}
              </span>
            </li>
          ))}
          {excluded.map((mark) => (
            <li key={mark.id} className="flex gap-2">
              <span
                aria-hidden="true"
                className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-ink-faint"
              />
              <span>
                <span className="font-medium text-ink">{mark.name}</span>
                {mark.note ? <span className="block text-ink-faint">{mark.note}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <figcaption
        id={captionId}
        className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-ink-faint"
      >
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-pine" /> Base
          </span>
          {satellites.length > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full border-[1.5px] border-pine bg-paper-raised"
              />{' '}
              Day trip, no move
            </span>
          ) : null}
          {excluded.length > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full border border-dashed border-ink-faint"
              />{' '}
              Left out
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-pine/10 ring-1 ring-pine/40" />{' '}
            {figure.dayReachKm} km — a day out and back
          </span>
          {/*
            The structure's own reach. Drawn when it fits and stated in words
            when it does not — a legend swatch beside a circle that is off the
            canvas points at nothing, which is how a legend teaches somebody to
            stop reading legends.
          */}
          {figure.regionReachKm && figure.regionRingDrawn ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 rounded-full ring-1 ring-ink-faint/60"
              />{' '}
              {figure.regionReachKm} km — the whole region
            </span>
          ) : figure.regionReachKm ? (
            <span>Region reach ≈{figure.regionReachKm} km, wider than this frame</span>
          ) : null}
        </span>
        {/*
          What this figure IS, stated positively. The old caption said only what
          it was not, which told a traveller nothing they could use and told them
          it in a tone of apology.
        */}
        <span className="block">
          Every mark is one source coordinate, drawn on a Web Mercator grid with north up; the bar
          is exact at {Math.abs(figure.scaleLatitude).toFixed(0)}°
          {figure.scaleLatitude >= 0 ? 'N' : 'S'}. Travel times are straight-line estimates, not
          routed. Nothing else is drawn — no coastline, border or road — because we have not read
          one.
          {tiles ? ` Basemap: ${tiles.attribution}.` : ''}
        </span>
      </figcaption>
    </figure>
  );
}
