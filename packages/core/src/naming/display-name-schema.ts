import { z } from 'zod';
import { DISPLAY_NAME_VERSION } from './display-name';

/**
 * THE STORED SHAPE OF A DISPLAY NAME, APART FROM THE FUNCTIONS THAT READ ONE.
 *
 * Its own file because `components/ui.tsx` calls `displayNameOf` on every page:
 * while these schemas sat beside that function, importing it put all of zod in
 * the client bundle of every route (performance pass, 2026-11).
 */

/** One name a source published, with whatever metadata it came with. */
export const nameCandidateSchema = z.object({
  value: z.string().min(1),
  /**
   * BCP-47-ish, exactly as the source gave it: `en`, `en-GB`, `ky`, `zh-Hant`.
   * Absent is meaningful — it means the source did not say, not that it is
   * English.
   */
  language: z.string().min(1).optional(),
  /** Where this name came from, so provenance survives the resolution. */
  source: z.string().min(1),
  /** The source's own primary/official name for the entity. */
  primary: z.boolean().optional(),
});
export type NameCandidate = z.infer<typeof nameCandidateSchema>;

export const displayNameSchema = z.object({
  schemaVersion: z.literal(DISPLAY_NAME_VERSION),
  /** What leads on screen. */
  display: z.string().min(1),
  /** IETF tag of `display`, when a source said. */
  displayLanguage: z.string().min(1).optional(),
  /**
   * The native name, when it is genuinely different from `display`.
   *
   * Absent when the official English name *is* the local name — which is common
   * and correct, and rendering it twice would read as a mistake.
   */
  local: z.string().min(1).optional(),
  localLanguage: z.string().min(1).optional(),
  /** What the source called it. Never shown; kept so a record still matches. */
  canonical: z.string().min(1),
  /** Every source that contributed a name, deduplicated and ordered. */
  sources: z.array(z.string().min(1)).default([]),
});
export type DisplayName = z.infer<typeof displayNameSchema>;
