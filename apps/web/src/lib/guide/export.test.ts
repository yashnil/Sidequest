import { describe, expect, it } from 'vitest';
import { guidePdfPath, guidePrintPath, pdfRendererConfig } from './export';

describe('guide export configuration', () => {
  it('is off unless the renderer URL, the secret and a source origin are all set', () => {
    expect(pdfRendererConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(pdfRendererConfig({ SIDEQUEST_PDF_RENDERER_URL: 'http://r:8080' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(pdfRendererConfig({ SIDEQUEST_PDF_RENDERER_URL: 'http://r:8080', SIDEQUEST_PDF_RENDERER_SECRET: 's' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(pdfRendererConfig({ SIDEQUEST_PDF_RENDERER_URL: 'http://r:8080/', SIDEQUEST_PDF_RENDERER_SECRET: 's', SIDEQUEST_BASE_URL: 'https://app.example/' } as unknown as NodeJS.ProcessEnv)).toEqual({ url: 'http://r:8080', secret: 's', sourceOrigin: 'https://app.example' });
    expect(pdfRendererConfig({ SIDEQUEST_PDF_RENDERER_URL: 'http://r:8080', SIDEQUEST_PDF_RENDERER_SECRET: 's', SIDEQUEST_BASE_URL: 'https://app.example', SIDEQUEST_PDF_SOURCE_URL: 'http://web.internal:3000' } as unknown as NodeJS.ProcessEnv)?.sourceOrigin).toBe('http://web.internal:3000');
  });

  it('names the print layout and the file', () => {
    expect(guidePrintPath('t1', 'complete', { print: true })).toBe('/trips/t1/guide?variant=complete&print=1');
    expect(guidePdfPath('t1', 'compact')).toBe('/api/trips/t1/guide.pdf?variant=compact');
  });
});
