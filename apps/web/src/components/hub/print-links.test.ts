import { describe, expect, it } from 'vitest';
import { printPacketHref, printWithAppendixHref } from './print-links';

describe('print links', () => {
  it('"Print with evidence appendix" both prints and adds the appendix', () => {
    const url = new URL(printWithAppendixHref('trip-1'), 'http://x');
    expect(url.pathname).toBe('/trips/trip-1/itinerary');
    /* `HubShell` opens the dialog only on print=1; appendix=1 alone reloaded the page and printed nothing. */
    expect(url.searchParams.get('print')).toBe('1');
    expect(url.searchParams.get('appendix')).toBe('1');
  });

  it('the plain packet prints without the appendix', () => {
    const url = new URL(printPacketHref('trip-1'), 'http://x');
    expect(url.searchParams.get('print')).toBe('1');
    expect(url.searchParams.get('appendix')).toBeNull();
  });
});

describe('the PDF is the browser’s print, and the copy says so', () => {
  it('no traveller-facing label promises a generated PDF download', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry !== 'node_modules') walk(path);
        } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) files.push(path);
      }
    };
    walk(join(root, 'app'));
    walk(join(root, 'components'));
    const offenders = files.filter((path) => /Download (the |a |your )?(trip |itinerary |plan )?PDF|Generate (a )?PDF|Export (as |to )?PDF/i.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
    /* The two print doors carry the honest label. */
    expect(readFileSync(join(root, 'components', 'PrintButton.tsx'), 'utf8')).toContain('Print or save as PDF');
    expect(readFileSync(join(root, 'app', '(product)', 'trips', '[id]', 'pack', 'page.tsx'), 'utf8')).toContain('Print or save as PDF');
  });
});
