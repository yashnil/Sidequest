'use client';

import { useState } from 'react';
import type {
  CroppableImage,
  DestinationImage as ImageRecord,
  ImageryFallback,
  PlaceCategory,
} from '@sidequest/core';
import { PLATE_HUE, cx } from './ui';

/**
 * A PHOTOGRAPH, OR THE THING THAT IS THERE INSTEAD OF ONE.
 *
 * Reads persisted metadata and renders it. **No fetch** — the identity of the
 * image was decided in a server action or during compilation, written down, and
 * this only draws it. A component that could resolve an image is a component
 * that resolves one per card, on every render, on every back button.
 *
 * ---
 *
 * THE FALLBACK IS ALWAYS DRAWN, EVEN WHEN THERE IS A PHOTOGRAPH.
 *
 * It sits *behind* the `<img>`, so a frame is never empty: a slot holds either a
 * photograph over a graphic, or the graphic alone. The `<img>` is `alt=""`
 * because the destination's name is always adjacent in the heading; an alt string
 * here would make every screen reader announce the same name twice.
 *
 * ---
 *
 * A LAYER BEHIND THE `<img>` IS NOT ENOUGH, AND THIS WAS MEASURED.
 *
 * The graphic underneath was the whole mechanism, on the belief that a browser
 * handed a failing `alt=""` image draws nothing. It does not. Chromium paints
 * its broken-file glyph in the top-left of the frame — over the graphic, at every
 * size — and it does so for **every** way a load can fail: an aborted request, an
 * HTTP 404 that still carries an image content type, and a 200 whose bytes are
 * not an image. All three were reproduced against this exact markup; all three
 * produced the same 16px chip of grey paper with a torn corner, on a card that is
 * otherwise a designed object.
 *
 * That is not a hypothetical. Wikimedia files are deleted after upload — a
 * licence review, a deletion request, a re-upload under a new name — and when one
 * is, every stored `thumbnailUrl` pointing at it starts answering 404 while the
 * row in `destination_images` still says there is a picture. Board, itinerary and
 * both shortlist layouts would all show the chip.
 *
 * So the element is *removed* when its file fails, which is the only thing that
 * stops a browser drawing a placeholder for it, and the graphic that was already
 * behind it becomes what the frame shows. Two triggers rather than one, because
 * they cover different halves of the page's life:
 *
 * - `onError` catches a failure after this component is listening;
 * - the ref catches one that already happened. The markup is server-rendered, so
 *   an image can finish failing before React hydrates — and `error` does not
 *   bubble and is not replayed, so a handler attached afterwards never hears it.
 *   `complete && naturalWidth === 0` is the DOM's own record of that outcome.
 *
 * Keyed by URL rather than a boolean so that navigating a card to a different
 * photograph clears the verdict about the previous one.
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
  /**
   * The aspect ratio of the frame, as a CSS `aspect-ratio` value, or
   * `'natural'` to take the file's own.
   *
   * `'natural'` exists because a licensing rule had been implemented as a layout
   * rule. Share-alike files must not be cropped, so the frame and the file were
   * allowed to disagree by any amount — and on a real board that produced a
   * photograph sitting as a letterboxed sliver in the middle of a coloured band,
   * a different sliver in every card, which reads as a rendering fault rather
   * than as a picture. Filling the frame is not the only way out of that: giving
   * the frame the file's shape shows the whole unmodified file with no bands at
   * all, and cropping never enters the question.
   *
   * Bounded, because a panorama would otherwise be six hundred pixels of sky in
   * a card and a tall portrait would push everything under it off the screen.
   * Outside the bounds the frame keeps its own shape and the file is letterboxed
   * as before — which is the honest outcome for a file that genuinely is that
   * shape.
   */
  ratio?: string | 'natural';
  /** Rendered above the graphic when there is no photograph. Off for small cards. */
  showLabel?: boolean;
  /**
   * What kind of place this is, where the caller knows.
   *
   * The generated graphic's hue comes from `ImageryFallback.hue`, which is
   * derived from the subject's *identity* — so a row of three lakes came out
   * orange, purple and green. A colour difference reads as a meaning difference,
   * and identity is not a meaning anybody can act on. Where the caller knows the
   * category, the hue is taken from the same `PLATE_HUE` table the category
   * plates use, so a lake looks like a lake wherever it appears.
   *
   * Optional, because destinations and regions have no place category. Absent,
   * the identity-derived hue is used exactly as before.
   */
  category?: PlaceCategory;
  /**
   * Where the credit goes.
   *
   * `'below'` — under the frame, the default, and right for a hero where the
   * picture is the subject. `'none'` — the caller renders `<ImageCredit>` itself
   * somewhere further down.
   *
   * The second exists for one measured defect: on a board card the credit is two
   * to four lines of dotted-underlined links sitting *above* the place's name,
   * so the loudest text on a card about Sumida River was the name of a
   * photographer. Attribution is an obligation to render those words reachably,
   * not an instruction to lead with them, and a card that inverts its own
   * hierarchy to comply has complied with the letter and broken the card.
   */
  credit?: 'below' | 'none';
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

/**
 * The shapes a card frame will take on.
 *
 * A landscape file wider than 16:9 is letterboxed rather than given the frame,
 * because a 3:1 panorama across a card column is a strip nobody can read a
 * subject out of. A portrait taller than 4:5 likewise: the card below it would
 * start a screen further down than its neighbours.
 */
const MIN_NATURAL_RATIO = 4 / 5;
const MAX_NATURAL_RATIO = 16 / 9;

function frameRatio(ratio: string, image: ImageRecord | null): string {
  if (ratio !== 'natural') return ratio;
  if (!image || image.width <= 0 || image.height <= 0) return '16 / 9';
  const natural = image.width / image.height;
  if (natural < MIN_NATURAL_RATIO || natural > MAX_NATURAL_RATIO) return '16 / 9';
  return `${image.width} / ${image.height}`;
}

export function DestinationImage({
  image,
  fallback,
  className,
  ratio = '16 / 9',
  crop = false,
  showLabel = false,
  category,
  credit = 'below',
  livePhoto = null,
}: DestinationImageProps & {
  /**
   * MVP V3 — a request-time photograph, used only when there is no durable one.
   *
   * `href` points at this origin (`/api/place-photo`), which resolves and
   * streams the picture server-side; nothing about it is stored, and the
   * credential never reaches the browser. See that route for the terms this
   * shape exists to satisfy. A failure is a missing picture and the designed
   * graphic underneath is what the frame shows.
   */
  livePhoto?: { href: string; credit: string } | null;
}) {
  /** The one file this frame has already watched fail. See the note at the top. */
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [liveFailed, setLiveFailed] = useState(false);
  const loadable = image !== null && image.thumbnailUrl !== failedUrl;
  const live = !image && livePhoto && !liveFailed ? livePhoto : null;

  return (
    <figure className={cx('m-0', className)}>
      <div
        className="relative overflow-hidden rounded-[var(--radius-card)]"
        style={{ aspectRatio: frameRatio(ratio, image) }}
      >
        {/*
          When there is a photograph the graphic is scenery behind it and is
          hidden from assistive technology — a screen reader told "a generated
          graphic; no freely licensed photograph was available" on a card that is
          showing a photograph would be reading out a lie. When there is no
          photograph the graphic *is* the content, and carries the description.

          Keyed on the *record*, not on whether its bytes arrived. A file that
          404s does not make that sentence true — a freely licensed photograph of
          this place was found, and the copy would be claiming otherwise — and a
          transient network failure has no business changing what a screen reader
          hears, when the name is in the heading beside it either way.
        */}
        <FallbackGraphic
          fallback={fallback}
          showLabel={showLabel && !image && !live}
          decorative={image !== null || live !== null}
          {...(category ? { category } : {})}
        />
        {live ? (
          /*
            A plain `img`, deliberately. The bytes are streamed by this app's own
            route at request time and there is no durable URL for an image
            optimizer to work from — and putting one in front of it would be the
            caching the terms forbid.
          */
          <img
            src={live.href}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setLiveFailed(true)}
            className="absolute inset-0 h-full w-full object-cover"
            data-testid="live-place-photo"
          />
        ) : null}
        {image && loadable ? (
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
            onError={() => setFailedUrl(image.thumbnailUrl)}
            ref={(element) => {
              /*
               * The failure that happened before anybody was listening. Server
               * markup starts loading immediately; `error` neither bubbles nor
               * replays, so a load that finished failing before hydration is
               * only visible as the state it left behind on the element.
               */
              if (element?.complete && element.naturalWidth === 0) {
                setFailedUrl(image.thumbnailUrl);
              }
            }}
            className={cx(
              'absolute inset-0 h-full w-full',
              crop ? 'object-cover' : 'object-contain',
            )}
          />
        ) : null}
      </div>

      {/*
        The credit follows the *record*, not the load.

        Attribution is owed for the file this product chose to publish, and the
        traveller's proxy dropping the bytes does not undo that choice — it also
        does not tell us the file is gone, since offline, blocked and deleted look
        identical from here. Dropping the credit on a failed load would take the
        only reachable statement of the licence off the page on exactly the
        connections least able to ask for it a second time.
      */}
      {image && credit === 'below' ? <ImageCredit image={image} as="figcaption" /> : null}
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
 *
 * Exported so a card can place it at its own foot — see `credit` above. `as`
 * exists because a `<figcaption>` outside a `<figure>` is invalid markup, and
 * the whole point of moving it is that it no longer sits inside the picture's
 * figure.
 */
export function ImageCredit({
  image,
  as: Tag = 'p',
  className,
}: {
  image: ImageRecord;
  /*
   * `span` exists because a credit can sit inside a caption that is itself a
   * paragraph, and HTML forbids <p> inside <p> — the browser's parser hoists
   * the inner one out and every server-rendered itinerary then fails React
   * hydration (#418) and re-renders client-side. Measured live on the day-card
   * hero caption.
   */
  as?: 'figcaption' | 'p' | 'span';
  className?: string;
}) {
  return (
    <Tag className={cx('mt-1.5 text-[11px] leading-snug text-ink-faint', className)}>
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
    </Tag>
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
  category,
}: {
  fallback: ImageryFallback;
  showLabel: boolean;
  /** True when a photograph sits on top of it, making this backdrop rather than content. */
  decorative: boolean;
  /** See `DestinationImageProps.category`: a meaning for the hue, where there is one. */
  category?: PlaceCategory;
}) {
  const { horizon, drift, marks, kind } = fallback;
  /*
   * Category first, identity second.
   *
   * The identity-derived hue is kept for subjects that have no category — a
   * destination, a region, a shortlist entry — because two *destinations* that
   * look different is useful and two lakes that look different is not.
   */
  const hue = category ? PLATE_HUE[category] : fallback.hue;
  const y = horizon * 100;
  const x = 12 + drift * 76;

  return (
    <div
      className="absolute inset-0"
      {...(decorative
        ? { 'aria-hidden': true as const }
        : { role: 'img', 'aria-label': fallback.description })}
      style={{
        /*
         * Saturation held down and the second stop kept on the *same* hue.
         *
         * The old form rotated 40° between the two stops, which on a 96px card
         * turned every plate into a two-colour object and made a row of them
         * read as a paint chart. One hue, two lightnesses: the graphic reads as
         * material rather than as a signal competing with the semantic colours
         * on the same card.
         */
        background: `linear-gradient(${140 + Math.round(drift * 60)}deg, hsl(${hue} 24% 88%), hsl(${hue} 20% 74%))`,
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
          fill={`hsl(${hue} 22% 58%)`}
          opacity={0.55}
        />
        <path
          d={`M0 ${(y * 0.6 + 9).toFixed(2)} Q 40 ${(y * 0.6 + 3).toFixed(2)} 70 ${(y * 0.6 + 11).toFixed(2)} T 100 ${(y * 0.6 + 7).toFixed(2)} L100 60 L0 60 Z`}
          fill={`hsl(${hue} 26% 44%)`}
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
                fill={`hsl(${hue} 34% 26%)`}
                opacity={0.8}
              />
            ))
          : marks > 0
            ? (
                <circle
                  cx={x.toFixed(2)}
                  cy={(y * 0.6 - 7).toFixed(2)}
                  r={2.4}
                  fill={`hsl(${hue} 34% 26%)`}
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
