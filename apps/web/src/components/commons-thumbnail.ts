/**
 * SMALLER COPIES OF A COMMONS THUMBNAIL, FOR `srcset`.
 *
 * Imagery is stored as Wikimedia's 960 px thumbnail (`lib/providers/wikimedia.ts`),
 * and every frame used to download that file whatever it was drawn at: on the
 * Lisbon itinerary a day hero shown about 160 px wide fetched 142 KB where the
 * 330 px copy is 27 KB (Lighthouse `uses-responsive-images`, 2026-11).
 *
 * Wikimedia serves a thumbnail at any *standard* width by rewriting the
 * `/<width>px-` segment of the same URL, and refuses non-standard widths at the
 * edge (a 400 px request answers HTTP 400) — so the candidates are taken from
 * that list only, never computed. A URL that is not a Commons thumbnail (an
 * original file, a fixture, another host) gets no `srcset`, which is exactly the
 * old behaviour.
 *
 * Import-free so it can be asserted in a plain unit test.
 */

/** Standard thumbnail widths Wikimedia serves below the stored 960 px copy. */
export const COMMONS_STANDARD_WIDTHS = [330, 500, 960] as const;

const COMMONS_THUMB = /^https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/thumb\/[^?#]+\/(\d+)px-[^/?#]+(?:[?#].*)?$/;

/**
 * A `srcset` of the standard widths up to the stored one, or `null` when the URL
 * is not a rewritable Commons thumbnail or there is nothing smaller to offer.
 */
export function commonsSrcSet(url: string): string | null {
  const match = COMMONS_THUMB.exec(url);
  if (!match) return null;
  const stored = Number(match[1]);
  const widths = COMMONS_STANDARD_WIDTHS.filter((width) => width < stored);
  if (widths.length === 0) return null;
  const segment = `/${stored}px-`;
  const at = url.lastIndexOf(segment);
  if (at < 0) return null;
  const candidates = widths.map((width) => `${url.slice(0, at)}/${width}px-${url.slice(at + segment.length)} ${width}w`);
  return [...candidates, `${url} ${stored}w`].join(', ');
}
