/**
 * The handful of glyphs the Discovery Board uses, drawn inline.
 *
 * Stroke icons on a 16px grid, `currentColor`, always decorative — every one
 * sits beside words that say the same thing, so they are hidden from
 * assistive technology.
 */
import type { ReactNode } from 'react';

function Glyph({ children, className, size = 16 }: { children: ReactNode; className?: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

export const CalendarIcon = (p: { className?: string }) => (
  <Glyph {...p}>
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
  </Glyph>
);

export const PeopleIcon = (p: { className?: string }) => (
  <Glyph {...p}>
    <circle cx="6" cy="5.5" r="2.25" />
    <path d="M1.75 13.5c.5-2.4 2.2-3.75 4.25-3.75s3.75 1.35 4.25 3.75" />
    <path d="M10.5 3.5a2.1 2.1 0 0 1 0 4.1M12 9.9c1.2.5 2 1.7 2.25 3.6" />
  </Glyph>
);

export const HomeIcon = (p: { className?: string }) => (
  <Glyph {...p}>
    <path d="M2.5 7.25 8 2.75l5.5 4.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5z" />
    <path d="M6.5 13.5v-3.5h3v3.5" />
  </Glyph>
);

export const RouteIcon = (p: { className?: string }) => (
  <Glyph {...p}>
    <circle cx="3.5" cy="12.5" r="1.5" />
    <circle cx="12.5" cy="3.5" r="1.5" />
    <path d="M5 12.5h4.25a2.25 2.25 0 0 0 0-4.5h-2.5a2.25 2.25 0 0 1 0-4.5H11" />
  </Glyph>
);

export const SparkIcon = (p: { className?: string }) => (
  <Glyph {...p}>
    <path d="M8 1.75 9.3 6.7l4.95 1.3L9.3 9.3 8 14.25 6.7 9.3 1.75 8 6.7 6.7z" />
  </Glyph>
);

export const CheckIcon = (p: { className?: string; size?: number }) => (
  <Glyph {...p}>
    <path d="m3.25 8.5 3 3 6.5-7" />
  </Glyph>
);

export const InfoIcon = (p: { className?: string }) => (
  <Glyph {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4M8 4.75v.01" />
  </Glyph>
);

export const ArrowRightIcon = (p: { className?: string }) => (
  <Glyph {...p}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </Glyph>
);

export const PencilIcon = (p: { className?: string }) => (
  <Glyph {...p}>
    <path d="M10.75 2.75 13.25 5.25 5.5 13H3v-2.5z" />
  </Glyph>
);

export const ClockIcon = (p: { className?: string }) => (
  <Glyph {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 4.5V8l2.25 1.5" />
  </Glyph>
);

export const ChevronIcon = (p: { className?: string }) => (
  <Glyph {...p}>
    <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
  </Glyph>
);
