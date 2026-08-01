import { haversineKm } from '@sidequest/geo';
import type { DiscoveredCandidate } from './providers';

/**
 * One site, one record.
 *
 * Discovery runs several queries on purpose — a category sweep, an
 * interest-led sweep, a hidden-gem sweep — so the same lake comes back three
 * times under three names. Left alone, the Discovery Board shows it three times
 * and the frequency caps count it three times.
 *
 * The hard part is not finding duplicates; it is not merging things that are
 * merely close. A trailhead and the car park it starts from share a coordinate
 * and are two different experiences. A cathedral and its treasury share a
 * building. So proximity alone is never enough: two records merge only when a
 * provider says they are the same thing, or when the names agree *and* they are
 * close enough that two distinct sites could not both be there.
 */

/** Below this, two same-named records are the same place rather than neighbours. */
const SAME_PLACE_METRES = 120;

/** Punctuation, articles and the generic nouns that vary between sources. */
const NOISE = /\b(the|a|an|le|la|les|el|los|las|il|de|di|du|des|van|von)\b/g;

/**
 * Letters whose diacritic lives inside the glyph, so NFKD does not separate it.
 *
 * Small and explicit rather than a transliteration dependency: this is eighteen
 * characters with a well-understood behaviour, and the alternative is a library
 * whose full behaviour would have to be reasoned about at a deduplication
 * boundary where a false merge silently deletes a place.
 */
const FOLDED_LETTERS: Record<string, string> = {
  ø: 'o', Ø: 'o', å: 'a', Å: 'a', æ: 'ae', Æ: 'ae',
  œ: 'oe', Œ: 'oe', ð: 'd', Ð: 'd', þ: 'th', Þ: 'th',
  ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', ı: 'i', İ: 'i',
  ß: 'ss',
};

export function normalizeName(name: string): string {
  return name
    // Letters that carry their diacritic inside the glyph rather than as a
    // combining mark, so NFKD leaves them alone. Without this pass "Sørvágsvatn"
    // and "Sorvagsvatn" are two different lakes.
    .replace(/[^\u0020-\u007e]/g, (char) => FOLDED_LETTERS[char] ?? char)
    .normalize('NFKD')
    // Then the combining marks, which NFKD has just separated out.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function providerKeys(candidate: DiscoveredCandidate): string[] {
  return candidate.providerRefs.map((ref) => `${ref.provider}:${ref.externalId}`);
}

export interface DedupeResult {
  candidates: DiscoveredCandidate[];
  /** How many records were folded away. Reported, never silent. */
  mergedCount: number;
}

/**
 * Merge, preserving evidence.
 *
 * The surviving record keeps the first candidate's `Place` — order is the
 * caller's ranking, so the better-evidenced one arrives first — and gains every
 * provider reference, fact and signal from the ones folded into it. That matters
 * for confidence: two independent providers finding the same lake is exactly the
 * `multiple_providers_agree` signal, and it only exists after the merge.
 */
export function dedupeCandidates(candidates: readonly DiscoveredCandidate[]): DedupeResult {
  const kept: DiscoveredCandidate[] = [];
  const byProviderKey = new Map<string, number>();
  const byName = new Map<string, number[]>();
  let mergedCount = 0;

  for (const candidate of candidates) {
    let targetIndex: number | undefined;

    for (const key of providerKeys(candidate)) {
      const found = byProviderKey.get(key);
      if (found !== undefined) {
        targetIndex = found;
        break;
      }
    }

    if (targetIndex === undefined) {
      const name = normalizeName(candidate.place.name);
      for (const index of byName.get(name) ?? []) {
        const other = kept[index];
        if (!other) continue;
        const metres =
          haversineKm(
            { id: 'a', lat: candidate.place.coordinates.lat, lng: candidate.place.coordinates.lng },
            { id: 'b', lat: other.place.coordinates.lat, lng: other.place.coordinates.lng },
          ) * 1000;
        if (metres <= SAME_PLACE_METRES) {
          targetIndex = index;
          break;
        }
      }
    }

    if (targetIndex === undefined) {
      const index = kept.length;
      kept.push({
        ...candidate,
        providerRefs: [...candidate.providerRefs],
        facts: [...candidate.facts],
        confidenceSignals: [...candidate.confidenceSignals],
      });
      for (const key of providerKeys(candidate)) byProviderKey.set(key, index);
      const name = normalizeName(candidate.place.name);
      byName.set(name, [...(byName.get(name) ?? []), index]);
      continue;
    }

    const target = kept[targetIndex];
    if (!target) continue;
    mergedCount += 1;

    const seenRefs = new Set(providerKeys(target));
    for (const ref of candidate.providerRefs) {
      const key = `${ref.provider}:${ref.externalId}`;
      if (!seenRefs.has(key)) {
        target.providerRefs.push(ref);
        seenRefs.add(key);
        byProviderKey.set(key, targetIndex);
      }
    }

    const seenFacts = new Set(target.facts.map((fact) => fact.id));
    for (const fact of candidate.facts) {
      if (!seenFacts.has(fact.id)) {
        target.facts.push(fact);
        seenFacts.add(fact.id);
      }
    }

    const signals = new Set([...target.confidenceSignals, ...candidate.confidenceSignals]);
    // Two providers that independently found the same site is the strongest
    // corroboration available here, and it is only observable after a merge.
    const distinctProviders = new Set(target.providerRefs.map((ref) => ref.provider));
    if (distinctProviders.size > 1) {
      signals.add('multiple_providers_agree');
      signals.delete('single_provider_only');
    }
    target.confidenceSignals = [...signals];
  }

  return { candidates: kept, mergedCount };
}
