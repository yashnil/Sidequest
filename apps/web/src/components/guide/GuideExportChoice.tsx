import { GUIDE_VARIANTS, GUIDE_VARIANT_LABELS } from '@/lib/guide/model';
import { guidePdfPath, guidePrintPath, pdfRendererConfig } from '@/lib/guide/export';
import { buttonClass, cx } from '@/components/ui';

/**
 * THE TWO PAPER COPIES, CHOSEN BY NAME.
 *
 * With a PDF renderer configured each choice is a file (`/api/trips/[id]/guide.pdf`);
 * without one it opens the same dedicated print layout in a new tab and the
 * browser's print dialog — so the choice always does something real, and the
 * pages are the same either way. A server component: whether the renderer
 * exists is read from the environment here, never shipped to the client.
 */
export function GuideExportChoice({ tripId, layout = 'panel' }: { tripId: string; layout?: 'panel' | 'menu' }) {
  const rendered = pdfRendererConfig() !== null;
  const linkProps = (variant: (typeof GUIDE_VARIANTS)[number]) =>
    rendered ? { href: guidePdfPath(tripId, variant), download: '' } : { href: guidePrintPath(tripId, variant, { print: true }), target: '_blank', rel: 'noopener' };

  if (layout === 'menu') {
    return (
      <>
        {GUIDE_VARIANTS.map((variant) => (
          <a key={variant} {...linkProps(variant)} className={buttonClass('ghost', 'sm')} data-testid={`guide-export-${variant}`}>
            {GUIDE_VARIANT_LABELS[variant].title} ({rendered ? 'PDF' : 'print or save as PDF'})
          </a>
        ))}
      </>
    );
  }

  return (
    <ul className="mt-3 grid gap-3 sm:grid-cols-2" data-print="never">
      {GUIDE_VARIANTS.map((variant) => (
        <li key={variant} className="rounded-[var(--radius-card)] border border-rule p-4">
          <p className="type-section text-ink">{GUIDE_VARIANT_LABELS[variant].title}</p>
          <p className="mt-1 type-small text-ink-muted">{GUIDE_VARIANT_LABELS[variant].blurb}</p>
          <a {...linkProps(variant)} className={cx(buttonClass(variant === 'compact' ? 'secondary' : 'ghost', 'sm'), 'mt-3')} data-testid={variant === 'compact' ? 'pack-pdf' : 'pack-pdf-complete'}>
            {rendered ? 'Get the PDF' : 'Print or save as PDF'}
          </a>
        </li>
      ))}
    </ul>
  );
}
