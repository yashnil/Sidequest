import type { MetadataRoute } from 'next';

/**
 * PRIVATE ALPHA — NOT FOR SEARCH ENGINES.
 *
 * An alpha deployment's URLs (and its share links, which are capability URLs)
 * should never appear in a search index. Indexing is an explicit opt-in for a
 * public launch: `SIDEQUEST_INDEXABLE=on`.
 */
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const indexable = (process.env.SIDEQUEST_INDEXABLE ?? '').trim().toLowerCase() === 'on';
  return indexable ? { rules: { userAgent: '*', allow: '/', disallow: ['/labs', '/api', '/share', '/trips'] } } : { rules: { userAgent: '*', disallow: '/' } };
}
