import type { ReactNode } from 'react';

/**
 * PRODUCTION PASS — THE SHAPE OF A LEGAL PAGE (PRIVACY, TERMS, SUPPORT).
 *
 * Structured content, minimal styling from the existing type utilities; the
 * visual design is the lead's. Every page carries the draft notice until an
 * owner and a lawyer have reviewed the words.
 */
export interface LegalSection {
  id: string;
  heading: string;
  body: ReactNode;
}

export function LegalDocument({ eyebrow, title, updated, intro, sections }: { eyebrow: string; title: string; updated: string; intro: ReactNode; sections: LegalSection[] }) {
  return (
    <article className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14" data-testid="legal-document">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="type-title mt-3 text-ink">{title}</h1>
      <p role="note" className="mt-4 rounded-[var(--radius-card)] border border-rule bg-paper-sunk/60 px-4 py-3 type-small text-ink" data-testid="legal-draft-note">
        <span className="font-semibold">Draft — requires owner/legal review before public launch.</span> This text describes what the software does today; it has not been reviewed by a lawyer and is not yet a binding policy.
      </p>
      <p className="mt-2 type-small text-ink-muted">Last updated {updated}</p>
      <div className="measure mt-6 type-body text-ink">{intro}</div>
      <nav aria-label="On this page" className="mt-6">
        <p className="label">On this page</p>
        <ol className="mt-2 grid gap-1 type-small">
          {sections.map((section) => (
            <li key={section.id}>
              <a className="underline" href={`#${section.id}`}>
                {section.heading}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {sections.map((section) => (
        <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`} className="mt-8">
          <h2 id={`${section.id}-heading`} className="type-section text-ink">
            {section.heading}
          </h2>
          <div className="measure mt-2 grid gap-3 type-body text-ink [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mt-1">{section.body}</div>
        </section>
      ))}
    </article>
  );
}
