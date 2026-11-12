import type { GuideVariant } from './model';

/**
 * Where the guide lives and whether a PDF renderer is configured. Import-free
 * beyond the variant type, so the export button's server parent can read it.
 *
 *   SIDEQUEST_PDF_RENDERER_URL     the renderer service's base URL (no trailing path)
 *   SIDEQUEST_PDF_RENDERER_SECRET  shared secret, sent as `x-renderer-secret`
 *   SIDEQUEST_PDF_SOURCE_URL       optional: the origin the renderer can reach this
 *                                  app on (e.g. a private network address);
 *                                  defaults to SIDEQUEST_BASE_URL
 */
export function guidePrintPath(tripId: string, variant: GuideVariant, options: { print?: boolean } = {}): string {
  return `/trips/${encodeURIComponent(tripId)}/guide?variant=${variant}${options.print ? '&print=1' : ''}`;
}

export function guidePdfPath(tripId: string, variant: GuideVariant): string {
  return `/api/trips/${encodeURIComponent(tripId)}/guide.pdf?variant=${variant}`;
}

export function pdfRendererConfig(env: NodeJS.ProcessEnv = process.env): { url: string; secret: string; sourceOrigin: string } | null {
  const url = env.SIDEQUEST_PDF_RENDERER_URL?.trim().replace(/\/+$/, '');
  const secret = env.SIDEQUEST_PDF_RENDERER_SECRET?.trim();
  const source = (env.SIDEQUEST_PDF_SOURCE_URL?.trim() || env.SIDEQUEST_BASE_URL?.trim() || '').replace(/\/+$/, '');
  if (!url || !secret || !/^https?:\/\//.test(url) || !/^https?:\/\//.test(source)) return null;
  return { url, secret, sourceOrigin: source };
}
