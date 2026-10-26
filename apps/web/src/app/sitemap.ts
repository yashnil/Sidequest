import type { MetadataRoute } from 'next';

/**
 * PRODUCTION PASS — THE PUBLIC PAGES, AND ONLY WHEN INDEXING IS ON.
 *
 * Empty unless `SIDEQUEST_INDEXABLE=on` and `SIDEQUEST_BASE_URL` is set (a
 * sitemap of relative URLs is not a sitemap). Lists the marketing and legal
 * pages only: trips and share links are private or capability URLs and are
 * `noindex` by header (`next.config.ts#NOINDEX_SOURCES`).
 */
export const dynamic = 'force-dynamic';

export const PUBLIC_PATHS = ['/', '/decide', '/privacy', '/terms', '/support'] as const;

export function sitemapEntries(env: Record<string, string | undefined> = process.env): MetadataRoute.Sitemap {
  const indexable = (env.SIDEQUEST_INDEXABLE ?? '').trim().toLowerCase() === 'on';
  const base = (env.SIDEQUEST_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!indexable || !/^https?:\/\//.test(base)) return [];
  return PUBLIC_PATHS.map((path) => ({ url: `${base}${path}`, changeFrequency: 'weekly' as const, priority: path === '/' ? 1 : 0.5 }));
}

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries();
}
