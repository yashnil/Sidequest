'use client';

import { useState } from 'react';
import { MEDIA_CONTEXT_SPECS, objectPositionFor, type MediaContext } from '@/lib/media/frame';
import type { SelectedMedia } from '@/lib/media/select';
import { ImageCredit } from '../DestinationImage';
import { cx } from '../ui';
import { CartographicPlate } from './CartographicPlate';

/**
 * ONE FRAME, ONE CONTEXT: A PHOTOGRAPH WE TRUST, OR A MAP THAT SAYS IT IS ONE.
 *
 * Reads a stored `SelectedMedia` (decided server-side by `lib/media/select.ts`,
 * persisted by `lib/media/repository.ts`) and draws it. No fetch.
 *
 * - The frame has the context's aspect (hero 16:9, card 3:2, thumb 1:1,
 *   strip 7:2). The photograph fills it with `object-fit: cover`, positioned
 *   by its stored focal point — so a 4:3 file in a 16:9 hero keeps the subject
 *   rather than its centre line. Never letterboxed into a strip.
 * - Never upscaled: a selection whose original is narrower than this context
 *   needs (`mediaPresentation`) is not drawn here; the plate is.
 * - `srcSet` is the selection's standard Commons widths, none wider than the
 *   original, so the browser picks the smallest file that fills the frame.
 * - When the file fails to load, the `<img>` is removed and the plate behind
 *   it is what the frame shows (see `DestinationImage.tsx` for why removal,
 *   not layering, is the only thing that stops a broken-image glyph).
 * - Credit is the existing one-line "Photo · author · licence" with links to
 *   the file page and the licence, reachable by keyboard.
 *
 * On screen the crop is a CSS viewport onto the unmodified file; print uses
 * the file's own aspect for share-alike files (`selection.shareAlike`), which
 * the print route reads from the same record.
 */

export type MediaPresentation = { kind: 'photo'; media: SelectedMedia } | { kind: 'plate'; reason: 'none' | 'too_small' | 'wrong_shape' };

/**
 * Photo or plate, for this context. Pure, so the fallback choice is testable.
 *
 * A selection made for another context is accepted only when its original
 * clears this context's own size and shape bounds — a card's 1280 px file is
 * not stretched across a hero.
 */
export function mediaPresentation(media: SelectedMedia | null | undefined, context: MediaContext): MediaPresentation {
  if (!media) return { kind: 'plate', reason: 'none' };
  const spec = MEDIA_CONTEXT_SPECS[context];
  const { width, height } = media.original;
  if (width < spec.minSourceWidth || Math.min(width, height) < spec.minSourceShortEdge) return { kind: 'plate', reason: 'too_small' };
  const aspect = width / height;
  if (aspect < spec.sourceAspect[0] || aspect > spec.sourceAspect[1]) return { kind: 'plate', reason: 'wrong_shape' };
  return { kind: 'photo', media };
}

const DEFAULT_SIZES: Record<MediaContext, string> = {
  hero: '100vw',
  card: '(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw',
  thumb: '200px',
  strip: '100vw',
};

export interface MediaPlace {
  name: string;
  lat: number;
  lng: number;
  radiusKm?: number;
}

export function MediaImage({
  media,
  context,
  place,
  credit = 'below',
  showName,
  sizes,
  className,
  frameClassName,
  eager = false,
}: {
  media: SelectedMedia | null | undefined;
  context: MediaContext;
  /** The place, for the plate when there is no photograph. Real coordinates only. */
  place: MediaPlace;
  /** `below` renders the credit under the frame; `none` when the caller places `<ImageCredit>` itself. */
  credit?: 'below' | 'none';
  /** Set the name on the plate (defaults on for hero/strip). Never drawn over a photograph. */
  showName?: boolean;
  sizes?: string;
  className?: string;
  /** Classes for the frame itself (e.g. a radius override when the frame sits flush in a card). */
  frameClassName?: string;
  /** Above-the-fold heroes load eagerly; everything else lazily. */
  eager?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const presentation = mediaPresentation(media, context);
  const spec = MEDIA_CONTEXT_SPECS[context];
  const photo = presentation.kind === 'photo' && presentation.media.image.thumbnailUrl !== failed ? presentation.media : null;

  return (
    <figure className={cx('m-0 min-w-0', className)} data-testid="media-image" data-context={context} data-media={photo ? 'photo' : 'plate'}>
      <div className={cx('relative overflow-hidden rounded-[var(--radius-card)] bg-night', frameClassName)} style={{ aspectRatio: spec.cssAspect }}>
        <CartographicPlate
          name={place.name}
          lat={place.lat}
          lng={place.lng}
          {...(place.radiusKm ? { radiusKm: place.radiusKm } : {})}
          context={context}
          rounded={false}
          decorative={presentation.kind === 'photo'}
          className="absolute inset-0 h-full w-full"
          {...(showName === undefined ? {} : { showName })}
        />
        {photo ? (
          <img
            src={photo.image.thumbnailUrl}
            srcSet={photo.sources.map((source) => `${source.url} ${source.width}w`).join(', ')}
            sizes={sizes ?? DEFAULT_SIZES[context]}
            alt=""
            width={photo.image.width}
            height={photo.image.height}
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailed(photo.image.thumbnailUrl)}
            ref={(element) => {
              if (element?.complete && element.naturalWidth === 0) setFailed(photo.image.thumbnailUrl);
            }}
            /*
             * A share-alike file is shown whole, at its own aspect, on the plate:
             * cropping it — even as a CSS window — is treated as an adaptation,
             * the rule `DestinationImage` already keeps (and that print keeps).
             * Only a file whose licence allows modification is cropped on its
             * focal point to fill the frame.
             */
            className={cx('absolute inset-0 h-full w-full', photo.shareAlike ? 'object-contain' : 'object-cover')}
            data-share-alike={photo.shareAlike ? 'true' : undefined}
            style={photo.shareAlike ? undefined : { objectPosition: objectPositionFor(photo.focal, photo.original.width / photo.original.height, spec.aspect) }}
          />
        ) : null}
      </div>
      {presentation.kind === 'photo' && credit === 'below' ? <ImageCredit image={presentation.media.image} as="figcaption" /> : null}
    </figure>
  );
}

export { ImageCredit };
