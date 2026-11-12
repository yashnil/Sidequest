import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SelectedMedia } from '@/lib/media/select';
import { MediaImage, mediaPresentation } from './MediaImage';
import { coordinateLabel, isLand, plateGeometry } from './plate-geometry';

const MEDIA: SelectedMedia = {
  status: 'selected',
  version: 1,
  context: 'card',
  wikidataId: 'Q42',
  image: {
    schemaVersion: 1,
    fileTitle: 'File:Valley at dawn.jpg',
    filePageUrl: 'https://commons.wikimedia.org/wiki/File:Valley_at_dawn.jpg',
    thumbnailUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Valley_at_dawn.jpg/1280px-Valley_at_dawn.jpg',
    width: 1280,
    height: 853,
    mediaType: 'image/jpeg',
    subject: { kind: 'destination', id: 'media:Q42', name: 'Somewhere', wikidataId: 'Q42', hierarchy: [] },
    matchBasis: 'wikidata_image_property',
    subjectConfidence: 'strong',
    relationship: 'Q42|P18',
    licenceId: 'CC-BY-SA-4.0',
    licenceName: 'Creative Commons Attribution-ShareAlike 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    useTier: 'display_unmodified',
    creator: 'A. Photographer',
    attributionText: 'A. Photographer, Creative Commons Attribution-ShareAlike 4.0, Wikimedia Commons',
    provider: 'test',
    contractVersion: 'wikimedia-commons/v1',
    retrievedAt: '2026-11-12T00:00:00Z',
  },
  origin: 'P18',
  original: { width: 4000, height: 2667 },
  sources: [
    { width: 330, url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Valley_at_dawn.jpg/330px-Valley_at_dawn.jpg' },
    { width: 1280, url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Valley_at_dawn.jpg/1280px-Valley_at_dawn.jpg' },
  ],
  focal: { x: 0.5, y: 0.1 },
  focalBasis: 'attention',
  shareAlike: true,
  score: 0.8,
  rejected: [],
};

const PLACE = { name: 'Svaneti', lat: 43.0, lng: 42.8, radiusKm: 50 };

describe('photo or plate', () => {
  it('draws a gated photograph, and falls back when it would be stretched or the wrong shape', () => {
    expect(mediaPresentation(MEDIA, 'card').kind).toBe('photo');
    expect(mediaPresentation(MEDIA, 'hero').kind).toBe('photo');
    expect(mediaPresentation(null, 'card')).toEqual({ kind: 'plate', reason: 'none' });
    expect(mediaPresentation({ ...MEDIA, original: { width: 1300, height: 866 } }, 'hero')).toEqual({ kind: 'plate', reason: 'too_small' });
    expect(mediaPresentation({ ...MEDIA, original: { width: 2000, height: 3000 } }, 'card')).toEqual({ kind: 'plate', reason: 'wrong_shape' });
  });

  it('crops a file whose licence allows it on its focal point', () => {
    const html = renderToStaticMarkup(createElement(MediaImage, { media: { ...MEDIA, shareAlike: false }, context: 'card', place: PLACE }));
    expect(html).toContain('object-cover');
    expect(html).toMatch(/object-position:50% 0%/);
  });

  it('crops a share-alike file only with its conditions met: the change said and the crop offered under the same licence', () => {
    const html = renderToStaticMarkup(createElement(MediaImage, { media: MEDIA, context: 'card', place: PLACE }));
    expect(MEDIA.shareAlike).toBe(true);
    expect(html).toContain('object-cover');
    expect(html).toContain('data-crop="with_notice"');
    expect(html).toContain('Cropped; this crop is shared under CC BY-SA 4.0');
    expect(html).toContain('href="https://creativecommons.org/licenses/by-sa/4.0/"');
    expect(html).toContain('330px-Valley_at_dawn.jpg 330w');
    expect(html).toContain('aspect-ratio:3 / 2');
    expect(html).toContain('A. Photographer, CC BY-SA 4.0');
    expect(html).toContain('href="https://commons.wikimedia.org/wiki/File:Valley_at_dawn.jpg"');
    // The plate under the photograph is scenery, not content.
    expect(html).not.toContain('A map, not a photograph');
    expect(html).toContain('data-media="photo"');
  });

  it('with no photograph, the frame is an honestly labelled map of the real place and carries no credit', () => {
    const html = renderToStaticMarkup(createElement(MediaImage, { media: null, context: 'hero', place: PLACE }));
    expect(html).toContain('data-media="plate"');
    expect(html).toContain('Map · no photograph');
    expect(html).toContain('A map, not a photograph: Svaneti at 43.00° N · 42.80° E');
    expect(html).toContain('about 100 km across');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Photo ·');
  });
});

describe('plate geometry', () => {
  it('reads real land from Natural Earth', () => {
    expect(isLand(43, 42.8)).toBe(true); // the Caucasus
    expect(isLand(0, -140)).toBe(false); // the Pacific
  });

  it('puts the place at its waypoint and draws real graticule and extent', () => {
    const geometry = plateGeometry({ lat: 43, lng: 42.8, radiusKm: 50, context: 'card' });
    expect(geometry.width / geometry.height).toBeCloseTo(1.5, 1);
    expect(geometry.landDots).toBeGreaterThan(100);
    expect(geometry.graticule.some((line) => line.kind === 'lng' && line.label === '40°E')).toBe(true);
    expect(geometry.graticule.some((line) => line.kind === 'lat' && line.label === '40°N')).toBe(true);
    // 50 km at this scale is smaller than a lattice cell: no ring rather than a misleading one.
    expect(plateGeometry({ lat: 64.9, lng: -18.6, radiusKm: 250, context: 'card' }).ring).not.toBeNull();
    const ocean = plateGeometry({ lat: -20, lng: -140, context: 'thumb' });
    expect(ocean.landDots).toBe(0);
    expect(coordinateLabel(-33.9, 18.4)).toBe('33.90° S · 18.40° E');
  });
});
