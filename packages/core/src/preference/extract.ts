import { INTEREST_LABELS, INTERESTS, type Interest } from '../schemas/common';
import { featureIsLearnable, type EvidenceSignal, type PreferenceEvidenceRow } from './evidence';

/**
 * PREFERENCE FEATURES FROM A REFINEMENT REQUEST, DETERMINISTICALLY.
 *
 * V6 §31. "Fewer temples, more neighbourhoods" is two signals: temples ↓,
 * neighbourhoods ↑. The extractor is a keyword table over the interest
 * vocabulary and a handful of place kinds, with a direction read from the
 * words around the match. No model; a request the table cannot read produces
 * no evidence, which is the honest outcome — a wrong signal is worse than
 * none. Hard constraints never come from here (`featureIsLearnable`).
 */

const LESS = /\b(fewer|less|no more|drop|remove|cut|skip|without|too many|too much|not so many|fewer of|stop)\b/i;
const MORE = /\b(more|add|another|extra|prefer|love|want|include|focus on|lean towards|keep|slower|gentler|easier|calmer|always)\b/i;

const KIND_KEYWORDS: { feature: string; pattern: RegExp }[] = [
  { feature: 'theme:temples', pattern: /\btemples?\b|\bshrines?\b/i },
  { feature: 'theme:neighbourhoods', pattern: /\bneighbou?rhoods?\b|\bdistricts?\b|\bquarters?\b/i },
  { feature: 'theme:museums', pattern: /\bmuseums?\b|\bgaller(y|ies)\b/i },
  { feature: 'theme:markets', pattern: /\bmarkets?\b|\bbazaars?\b/i },
  { feature: 'theme:viewpoints', pattern: /\bviewpoints?\b|\blookouts?\b|\bvistas?\b/i },
  { feature: 'theme:hikes', pattern: /\bhik(e|es|ing)\b|\btrek(s|king)?\b|\btrails?\b/i },
  { feature: 'theme:beaches', pattern: /\bbeach(es)?\b|\bswim(ming)?\b/i },
  { feature: 'theme:driving', pattern: /\bdriv(e|es|ing)\b|\bon the road\b/i },
  { feature: 'theme:early_starts', pattern: /\bearly (start|morning)s?\b|\bsunrise\b/i },
  { feature: 'theme:nightlife', pattern: /\bnightlife\b|\bbars?\b|\bclubs?\b|\blate nights?\b/i },
  { feature: 'theme:food', pattern: /\brestaurants?\b|\bfood\b|\beat(ing)?\b|\bdinners?\b/i },
  { feature: 'theme:rest', pattern: /\brest (day|days)\b|\bslow(er)? days?\b|\bdowntime\b|\bfree time\b|\bgentle(r)?\b|\bunhurried\b|\b(easy|easier|slower|quiet|relaxed) (final|last|first) (full )?(day|morning)\b|\b(final|last) (full )?day (is |be |to be )?(slower|easier|gentle|quiet)\b/i },
  { feature: 'pace:fast', pattern: /\bpack(ed)? (more|it) in\b|\bbusier\b|\bmore stops\b/i },
];

function interestKeywords(): { feature: string; pattern: RegExp }[] {
  return INTERESTS.map((interest: Interest) => {
    const label = INTEREST_LABELS[interest].toLowerCase().replace(/[^a-z ]/g, ' ').trim();
    const words = label.split(/\s+and\s+|\s+/).filter((w) => w.length > 3 && !['with', 'street', 'towns', 'easy'].includes(w));
    return { feature: `interest:${interest}`, pattern: new RegExp(`\\b(${words.map((w) => w.replace(/s$/, '')).join('|')})`, 'i') };
  });
}

export interface ExtractedPreference {
  feature: string;
  polarity: 1 | -1;
  /** The words that produced it, for the ledger's context. */
  evidence: string;
}

/** Split on clause boundaries so "fewer temples, more neighbourhoods" reads as two directions. */
function clauses(text: string): string[] {
  return text
    .split(/[,;.]|\band\b|\bbut\b/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

export function extractPreferences(request: string): ExtractedPreference[] {
  const found: ExtractedPreference[] = [];
  const seen = new Set<string>();
  const tables = [...KIND_KEYWORDS, ...interestKeywords()];
  for (const clause of clauses(request)) {
    const polarity: 1 | -1 | null = LESS.test(clause) ? -1 : MORE.test(clause) ? 1 : null;
    if (polarity === null) continue;
    for (const entry of tables) {
      if (!entry.pattern.test(clause) || !featureIsLearnable(entry.feature) || seen.has(entry.feature)) continue;
      seen.add(entry.feature);
      found.push({ feature: entry.feature, polarity, evidence: clause.slice(0, 120) });
    }
  }
  return found.slice(0, 6);
}

/** Turn an extraction into ledger rows, trip-scoped by default (V6 §31: a refinement is trip-local until repeated). */
export function evidenceRowsFromRequest(input: { request: string; tripId: string; userId: string | null; ownerToken: string | null; signal?: EvidenceSignal; now: Date; idFor: () => string }): PreferenceEvidenceRow[] {
  return extractPreferences(input.request).map((entry) => ({
    id: input.idFor(),
    userId: input.userId,
    ownerToken: input.userId ? null : input.ownerToken,
    travelerId: null,
    tripId: input.tripId,
    scope: 'trip',
    signal: input.signal ?? 'refinement_requested',
    feature: entry.feature,
    polarity: entry.polarity,
    strength: 0.5,
    source: 'behaviour',
    context: { evidence: entry.evidence },
    createdAt: input.now.toISOString(),
  }));
}
