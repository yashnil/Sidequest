import { afterEach, describe, expect, it } from 'vitest';
import robots from './robots';
import { sitemapEntries } from './sitemap';

/** PRODUCTION PASS — search engines see the public pages only, and only when indexing is switched on. */
afterEach(() => {
  delete process.env.SIDEQUEST_INDEXABLE;
  delete process.env.SIDEQUEST_BASE_URL;
});

describe('robots and the sitemap', () => {
  it('are closed by default', () => {
    expect(sitemapEntries({})).toEqual([]);
    expect(robots().rules).toEqual({ userAgent: '*', disallow: '/' });
  });

  it('list only public pages once indexing is on, and point robots at the sitemap', () => {
    const env = { SIDEQUEST_INDEXABLE: 'on', SIDEQUEST_BASE_URL: 'https://sidequest.test/' };
    const urls = sitemapEntries(env).map((entry) => entry.url);
    expect(urls).toEqual(['https://sidequest.test/', 'https://sidequest.test/decide', 'https://sidequest.test/privacy', 'https://sidequest.test/terms', 'https://sidequest.test/support']);
    expect(urls.some((url) => /\/(trips|share|api|labs)/.test(url))).toBe(false);
    Object.assign(process.env, env);
    const allowed = robots();
    expect(allowed.sitemap).toBe('https://sidequest.test/sitemap.xml');
    expect(JSON.stringify(allowed.rules)).toContain('/share');
  });
});
