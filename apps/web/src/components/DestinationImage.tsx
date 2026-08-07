import type { CroppableImage, DestinationImage as ImageRecord, ImageryFallback } from '@sidequest/core';
import { cx } from './ui';

/**
 * A PHOTOGRAPH, OR THE THING THAT IS THERE INSTEAD OF ONE.
 *
 * Reads persisted metadata and renders it. No fetch, no effect, no client state
 * — the identity of the image was decided in a server action or during
 * compilation, written down, and this only draws it. A component that could
 * resolve an image is a component that resolves one per card, on every render,
 * on every back button.
 *
 * ---
 *
 * THE FALLBACK IS ALWAYS DRAWN, EVEN WHEN THERE IS A PHOTOGRAPH.
 *
 * It sits *behind* the `<img>`, and that is the entire mechanism by which this
 * product never shows a broken-image icon. There is no `onError`, no state and
 * no client boundary: if the file fails to load — offline, blocked, deleted
 * upstream, a corporate proxy that eats third-party images — the browser draws
 * nothing over the graphic that was already there, and the card looks
 * *deliberate* rather than damaged. The `<img>` is `alt=""` because the
 * destination's name is always adjacent in the heading; an alt string here would
 * make every screen reader announce the same name twice.
 *
 * ---
 *
 * ATTRIBUTION IS RENDERED VERBATIM AND IS REACHABLE BY KEYBOARD.
 *
 * `attributionText` was assembled once, at ingestion, from the licence and the
 * creator. It is rendered as **that string** rather than reassembled here,
 * because the obligation is to render *those words* and a component that builds
 * its own version of them has quietly stopped complying — the same rule
 * `DataLicence.attribution` already states for place data.
 *
 * Restrained, not hidden. Small type, low contrast, one line. But the file page
 * and the licence are real links, in the tab order, focusable and announced —
 * because a credit nobody can reach is not a credit, and a `title` attribute or
 * a hover tooltip is exactly the version of this that fails on a phone.
 *
 * ---
 *
 * CROPPING IS A LICENCE DECISION, ENFORCED BY THE PROP TYPE.
 *
 * `crop: true` requires a `CroppableImage`, which only `croppable()` can mint
 * and which share-alike files never become. Displaying an unmodified photograph
 * beside our own prose is a collection; cropping it to a wide hero is an
 * adaptation, and an adaptation of a ShareAlike work published without
 * reciprocal terms is a licence breach. So the hero cannot be handed one. Not
 * "should not" — the call does not typecheck.
 */

/**
 * Wide surfaces crop; card surfaces do not.
 *
 * A union rather than two optional props, so that `crop` and the image's use
 * tier cannot be set independently and disagree.
 */
export type DestinationImageProps = {
  fallback: ImageryFallback;
  className?: string;
  /** The aspect ratio of the frame, as a CSS `aspect-ratio` value. */
  ratio?: string;
  /** Rendered above the graphic when there is no photograph. Off for small cards. */
  showLabel?: boolean;
} & (
  | {
      /** The frame is wider than the file, so the file gets cropped to fill it. */
      crop: true;
      image: CroppableImage | null;
    }
  | {
      /** The whole file is shown, rescaled. Rescaling is not an adaptation. */
      crop?: false;
      image: ImageRecord | null;
    }
);

export function DestinationImage({
  image,
  fallback,
  className,
  ratio = '16 / 9',
  crop = false,
  showLabel = false,
}: DestinationImageProps) {
  return (
    <figure className={cx('m-0', className)}>
      <div
        className="relative overflow-hidden rounded-[var(--radius-card)]"
        style={{ aspectRatio: ratio }}
      >
        {/*
          When there is a photograph the graphic is scenery behind it and is
          hidden from assistive technology — a screen reader told "a generated
          graphic; no freely licensed photograph was available" on a card that is
          showing a photograph would be reading out a lie. When there is no
          photograph the graphic *is* the content, and carries the description.
        */}
        <FallbackGraphic
          fallback={fallback}
          showLabel={showLabel && !image}
          decorative={image !== null}
        />
        {image ? (
          <img
            src={image.thumbnailUrl}
            alt=""
            width={image.width}
            height={image.height}
            loading="lazy"
            decoding="async"
            /*
             * No referrer. The URL identifies the file, and the page it is on
             * identifies the traveller's destination and the moment they were
             * looking at it — which is not something to hand to a third party as
             * a side effect of showing a picture.
             */
            referrerPolicy="no-referrer"
            className={cx(
              'absolute inset-0 h-full w-full',
              crop ? 'object-cover' : 'object-contain',
            )}
          />
        ) : null}
      </div>

      {image ? <Credit image={image} /> : null}
    </figure>
  );
}

/**
 * THE CREDIT LINE.
 *
 * Three links, because the licences that require attribution require all three
 * things: who made it, where the original lives, and which terms apply. Wrapping
 * the stored sentence in the file-page link is what makes the exact words and
 * the required link one element rather than two that can drift apart.
 */
function Credit({ image }: { image: ImageRecord }) {
  return (
    <figcaption className="mt-1.5 text-[11px] leading-snug text-ink-faint">
      <a
        href={image.filePageUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:text-ink-muted"
      >
        {image.attributionText}
      </a>
      {image.licenceUrl ? (
        <>
          {' · '}
          <a
            href={image.licenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted underline-offset-2 hover:text-ink-muted"
          >
            licence
          </a>
        </>
      ) : null}
      {image.creatorUrl ? (
        <>
          {' · '}
          <a
            href={image.creatorUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted underline-offset-2 hover:text-ink-muted"
          >
            creator
          </a>
        </>
      ) : null}
    </figcaption>
  );
}

/**
 * THE COORDINATE-DERIVED GRAPHIC.
 *
 * The same idiom as `ScopePreview`: no tiles, no basemap, no dependency, and
 * nothing drawn that was not read from a source record. The latitude sets where
 * the horizon sits, the longitude shifts the bands across the frame, and the
 * subject's identity sets the hue — so two places look different and one place
 * looks the same everywhere it appears.
 *
 * It is deliberately abstract rather than pictorial. A generated silhouette of
 * mountains over a place with no mountains would be a claim about somewhere we
 * have never seen, which is the one thing a stand-in must not be.
 *
 * `aria-hidden` on the SVG with the description on the figure: the graphic is
 * one object with one meaning, and marking up the bands would make a screen
 * reader read a gradient aloud.
 */
function FallbackGraphic({
  fallback,
  showLabel,
  decorative,
}: {
  fallback: ImageryFallback;
  showLabel: boolean;
  /** True when a photograph sits on top of it, making this backdrop rather than content. */
  decorative: boolean;
}) {
  const { hue, horizon, drift, marks, kind } = fallback;
  const y = horizon * 100;
  const x = 12 + drift * 76;

  return (
    <div
      className="absolute inset-0"
      {...(decorative
        ? { 'aria-hidden': true as const }
        : { role: 'img', 'aria-label': fallback.description })}
      style={{
        background: `linear-gradient(${140 + Math.round(drift * 60)}deg, hsl(${hue} 32% 88%), hsl(${(hue + 40) % 360} 28% 76%))`,
      }}
    >
      <svg
        viewBox="0 0 100 60"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        {/* The horizon, from the latitude. */}
        <path
          d={`M0 ${(y * 0.6).toFixed(2)} Q 30 ${(y * 0.6 - 5).toFixed(2)} 55 ${(y * 0.6 + 2).toFixed(2)} T 100 ${(y * 0.6 - 2).toFixed(2)} L100 60 L0 60 Z`}
          fill={`hsl(${hue} 30% 58%)`}
          opacity={0.55}
        />
        <path
          d={`M0 ${(y * 0.6 + 9).toFixed(2)} Q 40 ${(y * 0.6 + 3).toFixed(2)} 70 ${(y * 0.6 + 11).toFixed(2)} T 100 ${(y * 0.6 + 7).toFixed(2)} L100 60 L0 60 Z`}
          fill={`hsl(${(hue + 20) % 360} 34% 44%)`}
          opacity={0.6}
        />

        {/*
          One mark for a place, several for a scope.

          A cluster graphic draws the number of areas the trip covers, evenly
          spaced from the longitude-derived offset — which makes a four-base
          country trip and a one-base city trip visibly different objects before
          anybody has read a word.
        */}
        {kind === 'cluster_graphic'
          ? Array.from({ length: marks }, (_, index) => (
              <circle
                key={index}
                cx={(((x + index * 17) % 84) + 8).toFixed(2)}
                cy={(y * 0.6 - 6 + (index % 2) * 5).toFixed(2)}
                r={1.8}
                fill={`hsl(${hue} 45% 26%)`}
                opacity={0.8}
              />
            ))
          : marks > 0
            ? (
                <circle
                  cx={x.toFixed(2)}
                  cy={(y * 0.6 - 7).toFixed(2)}
                  r={2.4}
                  fill={`hsl(${hue} 45% 26%)`}
                  opacity={0.85}
                />
              )
            : null}
      </svg>

      {/*
        The typographic treatment.

        Shown when the frame is large enough for it to be the point rather than
        clutter — a hero with no photograph should say where it is, and a
        card 96 pixels tall already has the name printed underneath.
      */}
      {showLabel ? (
        <div className="absolute inset-0 flex items-end p-4">
          <span
            className="font-display text-lg leading-tight tracking-tight sm:text-2xl"
            style={{ color: `hsl(${hue} 45% 18%)` }}
          >
            {fallback.label}
          </span>
        </div>
      ) : null}
    </div>
  );
}
