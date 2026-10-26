import { describe, expect, it } from 'vitest';
import { ATLAS_STYLE_IDS, atlasStyle, resolveAtlasStyle } from './atlas-style';
import { OPENFREEMAP_DEFAULT_STYLE, resolveVectorBasemap } from '../map-adapter';

describe('survey atlas style', () => {
  it('asks only the two sources the globe already uses', () => {
    for (const ground of ['survey', 'night'] as const) {
      const style = atlasStyle(ground) as { sources: Record<string, { url?: string; tiles?: string[] }>; glyphs: string };
      const hosts = Object.values(style.sources).flatMap((s) => [s.url, ...(s.tiles ?? [])]).filter(Boolean).map((u) => new URL(u!).host);
      expect(new Set(hosts)).toEqual(new Set(['tiles.openfreemap.org', 's3.amazonaws.com']));
      expect(new URL(style.glyphs.replace('{fontstack}', 'x').replace('{range}', 'y')).host).toBe('tiles.openfreemap.org');
    }
  });

  it('is the default trip basemap, and a hosted OpenFreeMap style can still be named', () => {
    expect(OPENFREEMAP_DEFAULT_STYLE).toBe(ATLAS_STYLE_IDS.survey);
    expect(resolveVectorBasemap({ SIDEQUEST_MAP_PROVIDER: 'openfreemap' })?.styleUrl).toBe('sidequest:survey');
    expect(resolveVectorBasemap({ SIDEQUEST_MAP_PROVIDER: 'openfreemap', SIDEQUEST_MAP_STYLE: 'sidequest:night' })?.styleUrl).toBe('sidequest:night');
    expect(resolveVectorBasemap({ SIDEQUEST_MAP_PROVIDER: 'openfreemap', SIDEQUEST_MAP_STYLE: 'https://evil.example/style.json' })).toBeNull();
  });

  it('resolves its own ids to a style object and leaves a remote URL alone', () => {
    expect(typeof resolveAtlasStyle('sidequest:night')).toBe('object');
    expect(resolveAtlasStyle('https://tiles.openfreemap.org/styles/liberty')).toBe('https://tiles.openfreemap.org/styles/liberty');
  });
});
