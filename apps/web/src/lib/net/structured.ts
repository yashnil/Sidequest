import 'server-only';
import { createHash } from 'node:crypto';
import type { SourceAuthorityKind } from '@sidequest/core';

/**
 * TURNING A FETCHED PAGE INTO EVIDENCE, WITHOUT A MODEL WHERE POSSIBLE.
 *
 * Two jobs, in order of preference.
 *
 * The first is **structured data**. A large share of operator sites publish
 * `schema.org` JSON-LD, and an `openingHoursSpecification` is a machine-readable
 * statement of opening hours by the operator themselves. Reading it costs
 * nothing, cannot be misread, and produces a fact with a field pointer rather
 * than a quotation. Every hour we can get this way is an hour we do not pay a
 * model to read.
 *
 * The second is **cleaned text**, for the facts that only exist in prose. Nav
 * menus, cookie banners and footers are stripped first — not for tidiness, but
 * because they are where injected instructions live and because they are the
 * bulk of the tokens on a typical page.
 *
 * Everything here treats the page as hostile. Nothing is executed, JSON is
 * parsed with a depth and size limit, and no value from a page ever becomes a
 * URL we fetch or a field that controls a tool.
 */

/** A JSON-LD blob past this is a payload, not a page. */
const MAX_JSON_LD_BYTES = 200_000;
const MAX_JSON_LD_BLOCKS = 12;
const MAX_JSON_LD_DEPTH = 12;

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Every `application/ld+json` block, parsed and depth-limited.
 *
 * Depth matters: a deeply self-nesting object is a cheap way to make a recursive
 * walk blow the stack, and this walks. Anything past the limit is truncated
 * rather than the whole block being dropped, so a legitimate page with one
 * pathological branch still yields its hours.
 */
export function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (blocks.length >= MAX_JSON_LD_BLOCKS) break;
    const raw = match[1]?.trim();
    if (!raw || raw.length > MAX_JSON_LD_BYTES) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const limited = limitDepth(parsed, 0);
      if (Array.isArray(limited)) blocks.push(...limited.slice(0, MAX_JSON_LD_BLOCKS));
      else blocks.push(limited);
    } catch {
      // Malformed JSON-LD is extremely common and is not an error worth
      // reporting: the page still has prose.
    }
  }
  return blocks.slice(0, MAX_JSON_LD_BLOCKS);
}

function limitDepth(value: unknown, depth: number): unknown {
  if (depth >= MAX_JSON_LD_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => limitDepth(entry, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
      out[key] = limitDepth(entry, depth + 1);
    }
    return out;
  }
  return value;
}

export interface StructuredHours {
  periods: {
    label: string;
    months: number[];
    daysOfWeek?: number[];
    windows: { openMinute: number; closeMinute: number }[];
  }[];
  closedAnnualDates: string[];
}

const SCHEMA_DAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * `openingHoursSpecification` → our calendar shape.
 *
 * Returns `null` rather than a partial calendar whenever anything is unreadable,
 * for the same reason the OSM parser does: a schedule understood in part is a
 * schedule that will be enforced wrongly.
 */
export function hoursFromJsonLd(blocks: readonly unknown[]): StructuredHours | null {
  const specs: Record<string, unknown>[] = [];
  walk(blocks, (node) => {
    const type = String((node as Record<string, unknown>)['@type'] ?? '');
    if (type === 'OpeningHoursSpecification') specs.push(node);
  });
  if (specs.length === 0 || specs.length > 14) return null;

  const periods: StructuredHours['periods'] = [];
  for (const spec of specs) {
    const opens = timeToMinutes(spec.opens);
    const closes = timeToMinutes(spec.closes);
    if (opens === null || closes === null || closes <= opens) return null;

    const dayValues = Array.isArray(spec.dayOfWeek)
      ? spec.dayOfWeek
      : spec.dayOfWeek !== undefined
        ? [spec.dayOfWeek]
        : [];
    const days: number[] = [];
    for (const day of dayValues) {
      if (typeof day !== 'string') return null;
      // Values arrive both bare ("Monday") and as schema.org URLs.
      const name = day.split('/').pop()?.toLowerCase() ?? '';
      const index = SCHEMA_DAYS[name];
      if (index === undefined) return null;
      days.push(index);
    }

    periods.push({
      label: days.length === 0 || days.length === 7 ? 'Published hours' : 'Published hours, selected days',
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      ...(days.length > 0 && days.length < 7 ? { daysOfWeek: [...new Set(days)].sort() } : {}),
      windows: [{ openMinute: opens, closeMinute: closes }],
    });
  }

  const merged = mergeByDays(periods);
  return merged ? { periods: merged, closedAnnualDates: [] } : null;
}

/**
 * One period per distinct day-set, with its windows merged.
 *
 * schema.org publishes one specification per day, so a plain mapping produces
 * seven single-day periods for a place open every day — which the calendar
 * schema then rejects for having overlapping periods. Merging is not cosmetic.
 */
function mergeByDays(periods: StructuredHours['periods']): StructuredHours['periods'] | null {
  /**
   * Grouped by the *hours*, not by the days.
   *
   * schema.org's normal shape is one specification per weekday, so grouping by
   * day-set produces seven single-day periods for a place open every day — which
   * the calendar schema then rejects for claiming Monday twice, and a venue open
   * seven days a week ends up with no hours at all. Grouping by the window and
   * unioning the days is the shape the calendar actually wants: "09:00–17:00,
   * every day" rather than seven copies of one sentence.
   */
  const byWindows = new Map<string, StructuredHours['periods'][number]>();
  for (const period of periods) {
    const key = period.windows
      .map((window) => `${window.openMinute}-${window.closeMinute}`)
      .sort()
      .join('|');
    const existing = byWindows.get(key);
    if (!existing) {
      byWindows.set(key, {
        ...period,
        daysOfWeek: [...(period.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6])],
      });
      continue;
    }
    existing.daysOfWeek = [
      ...new Set([...(existing.daysOfWeek ?? []), ...(period.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6])]),
    ].sort((a, b) => a - b);
  }

  const out = [...byWindows.values()].map((period) => ({
    ...period,
    // A period covering the whole week says so by omitting the day list, which
    // is what the calendar schema means by "every day".
    ...(period.daysOfWeek && period.daysOfWeek.length === 7 ? { daysOfWeek: undefined } : {}),
  })) as StructuredHours['periods'];
  if (out.length === 0 || out.length > 6) return null;

  // Two periods claiming the same weekday would give it two schedules. Refuse.
  const claimed = new Set<number>();
  for (const period of out) {
    for (const day of period.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6]) {
      if (claimed.has(day)) return null;
      claimed.add(day);
    }
    period.windows.sort((a, b) => a.openMinute - b.openMinute);
    if (period.windows.length > 4) return null;
    for (let index = 0; index + 1 < period.windows.length; index += 1) {
      if (period.windows[index + 1]!.openMinute < period.windows[index]!.closeMinute) return null;
    }
  }
  return out;
}

function timeToMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 1440 ? minutes : null;
}

/** A publication or update date the page states about itself. */
export function publishedAtFrom(html: string, blocks: readonly unknown[]): string | undefined {
  let found: string | undefined;
  walk(blocks, (node) => {
    if (found) return;
    for (const key of ['dateModified', 'datePublished', 'uploadDate']) {
      const value = (node as Record<string, unknown>)[key];
      if (typeof value === 'string') {
        const date = isoDate(value);
        if (date) found = date;
      }
    }
  });
  if (found) return found;

  const meta =
    /<meta[^>]+property\s*=\s*["']article:modified_time["'][^>]+content\s*=\s*["']([^"']+)["']/i.exec(
      html,
    ) ??
    /<meta[^>]+name\s*=\s*["']last-modified["'][^>]+content\s*=\s*["']([^"']+)["']/i.exec(html);
  return meta?.[1] ? isoDate(meta[1]) : undefined;
}

function isoDate(value: string): string | undefined {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  const date = new Date(parsed).toISOString().slice(0, 10);
  // A "published" date in the future is a template placeholder, not a date.
  return date <= new Date().toISOString().slice(0, 10) ? date : undefined;
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void, depth = 0): void {
  if (depth > MAX_JSON_LD_DEPTH) return;
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    visit(value as Record<string, unknown>);
    for (const entry of Object.values(value as Record<string, unknown>)) {
      walk(entry, visit, depth + 1);
    }
  }
}

/**
 * WHOSE VOICE IS THIS?
 *
 * Deterministic, and deliberately unable to name a place. Three generic signals:
 *
 * 1. **Where the reference came from.** A URL that arrived in an OSM `website`
 *    tag or a Wikidata P856 claim is, by the meaning of those fields, the thing's
 *    own site. That is a stronger signal than anything a page can say about
 *    itself, and it costs nothing.
 * 2. **The DNS namespace.** Government suffixes are reserved and registration is
 *    controlled. A `.gov`, `.gov.uk` or `.go.jp` host is a government host
 *    anywhere on earth — a fact about the namespace, not about a destination.
 * 3. **Name overlap.** A domain whose labels contain the subject's distinctive
 *    words is very likely the subject's own site. Weak on its own, which is why
 *    it only promotes as far as `operator` and never past a namespace signal.
 *
 * Anything with none of these is `unverified_secondary`, which the resolver
 * ranks below every official voice and which can never produce a `verified`
 * fact. A search result is not authority.
 */
const GOVERNMENT_SUFFIXES = [
  '.gov',
  '.gov.uk',
  '.gouv.fr',
  '.go.jp',
  '.gc.ca',
  '.govt.nz',
  '.gov.au',
  '.gob.es',
  '.gov.br',
  '.go.kr',
  '.gov.in',
  '.gov.za',
  '.gov.sg',
  '.gov.it',
  '.bund.de',
  '.overheid.nl',
];

export function classifyAuthority(input: {
  url: string;
  subjectName: string;
  discoveredVia: string;
  expected: SourceAuthorityKind;
}): { authority: SourceAuthorityKind; publisher: string; domain: string } {
  let host: string;
  try {
    host = new URL(input.url).hostname.toLowerCase();
  } catch {
    return { authority: 'unverified_secondary', publisher: 'Unknown', domain: 'unknown' };
  }
  const domain = host.replace(/^www\./, '');

  if (GOVERNMENT_SUFFIXES.some((suffix) => domain === suffix.slice(1) || domain.endsWith(suffix))) {
    return { authority: 'government', publisher: domain, domain };
  }

  if (input.discoveredVia === 'osm_tag' || input.discoveredVia === 'wikidata') {
    return { authority: 'operator', publisher: domain, domain };
  }

  if (sharesDistinctiveName(domain, input.subjectName)) {
    return { authority: 'operator', publisher: domain, domain };
  }

  /**
   * A search result claiming to be official gets no credit for claiming it.
   * The discovery layer's `expectedAuthority` is a hint about what to look for,
   * not a finding, so it is capped here rather than trusted.
   */
  const capped: SourceAuthorityKind =
    input.expected === 'managing_authority' || input.expected === 'operator'
      ? 'unverified_secondary'
      : input.expected;
  return { authority: capped, publisher: domain, domain };
}

/**
 * Whether a domain contains a distinctive word from the subject's name.
 *
 * Short and generic words are excluded because "the", "park" and "museum" match
 * half the web. Four characters is the floor, which keeps out most articles in
 * most languages without needing a language-specific list.
 */
function sharesDistinctiveName(domain: string, subjectName: string): boolean {
  const flattened = domain.replace(/[^a-z0-9]/g, '');
  const words = subjectName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 5 && !GENERIC_WORDS.has(word));
  return words.some((word) => flattened.includes(word));
}

/**
 * Words too common to identify anything. Kinds of place, never names of them —
 * so this is the same list for every destination on earth.
 */
const GENERIC_WORDS = new Set([
  'museum',
  'gallery',
  'garden',
  'gardens',
  'centre',
  'center',
  'national',
  'historic',
  'historical',
  'heritage',
  'monument',
  'memorial',
  'church',
  'cathedral',
  'castle',
  'palace',
  'bridge',
  'tower',
  'market',
  'square',
  'street',
  'island',
  'valley',
  'canyon',
  'beach',
  'temple',
  'shrine',
  'station',
  'visitor',
  'trail',
  'point',
  '公園',
]);

/**
 * Page furniture, removed before anything reads the text.
 *
 * Not cosmetic. A cookie banner and a nav menu are most of the lines on a
 * typical page and none of the facts, and the same regions are where an injected
 * instruction is most likely to sit. Removing them shrinks the prompt and
 * shrinks the attack surface in the same pass.
 */
export function stripBoilerplate(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.length < 3) continue;
    if (BOILERPLATE.test(line)) continue;
    // A line repeated verbatim is navigation, not content.
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }
  return kept.join('\n');
}

const BOILERPLATE =
  /^(accept (all )?cookies|cookie (policy|settings|preferences)|manage (cookies|preferences)|privacy policy|terms (of use|and conditions)|skip to (main )?content|menu|search|sign in|log in|subscribe|newsletter|share this|follow us|back to top|©\s*\d{4}|all rights reserved)\b/i;
