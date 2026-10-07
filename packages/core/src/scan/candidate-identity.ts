/**
 * PRIVATE ALPHA — WHAT TO ASK A MAP FOR, GIVEN WHAT THE MODEL WROTE.
 *
 * The scan asks for one place per candidate, and the model sometimes writes a
 * recommendation instead of a name: "Rifugio Scotoni traditional lunch stop",
 * "Val Fiscalina easy walk", "Passo Falzarego to Lagazuoi sunset viewpoint",
 * "Ortisei funicular and Alpe di Siusi view". A geocoder asked for that text
 * finds nothing, and a live Dolomites scan lost five candidates that way.
 *
 * This reads, deterministically and conservatively, the canonical place to
 * *look up*, and leaves the recommendation itself untouched — the traveller
 * still sees what the model wrote. It never picks one of two genuinely
 * different places: "Tokyo and Kyoto" is ambiguous, and stays as written.
 */

export type CandidateIdentityType = 'unchanged' | 'descriptive_suffix_removed' | 'activity_qualifier_removed' | 'route_anchor' | 'provider_canonicalized' | 'ambiguous';

export interface CandidateIdentity {
  /** What the placement asks the providers for. Equal to the original when nothing was safe to remove. */
  lookupName: string;
  type: CandidateIdentityType;
  /** One line on what was read and why. */
  reason: string;
  /** For a route ("A to B", "A via B"): its two ends, start first. */
  route?: { from: string; to: string };
  /** What was taken off the name for the lookup, kept as activity metadata. */
  qualifier?: string;
}

/** Words that describe an activity at a place rather than name it. */
const ACTIVITY_WORDS = new Set(['walk', 'walks', 'hike', 'hikes', 'hiking', 'loop', 'trail', 'trails', 'circuit', 'trek', 'stroll', 'viewpoint', 'view', 'views', 'drive', 'tour', 'visit', 'ride', 'cruise', 'swim', 'climb', 'picnic', 'sunrise', 'sunset', 'panorama', 'traverse', 'excursion', 'outing']);
/** Words that describe a place's role or character rather than name it. */
const DESCRIPTIVE_WORDS = new Set(['stop', 'break', 'lunch', 'dinner', 'breakfast', 'coffee', 'meal', 'area', 'surroundings', 'district', 'quarter', 'village', 'villages', 'town', 'old', 'centre', 'center', 'traditional', 'local', 'scenic', 'quiet', 'easy', 'gentle', 'short', 'long', 'famous', 'iconic', 'historic', 'classic', 'guided', 'wildlife', 'photo', 'photography', 'golden', 'hour', 'evening', 'morning', 'family', 'panoramic', 'and', 'with', 'at', 'for', 'of', 'the', 'a', 'an']);

const ROUTE = /^(.+?)\s+(?:to|→|->|towards)\s+(.+)$/i;
const VIA = /^(.+?)\s+via\s+(.+)$/i;
const AND = /^(.+?)\s+(?:and|&|\+)\s+(.+)$/i;

const tokens = (text: string) => text.trim().split(/\s+/).filter(Boolean);
const capitalised = (word: string) => /^[\p{Lu}\p{Lt}]/u.test(word);
/** A run of words naming something: at least one capitalised word. */
const namesSomething = (text: string) => tokens(text).some(capitalised);

/**
 * Remove a trailing run of lowercase words when every one of them is an
 * activity or descriptive word, and something capitalised remains. "Musée d'art
 * moderne" keeps its lowercase words (they are not in the vocabulary); "Lago di
 * Braies" keeps everything (it ends capitalised).
 */
function stripTrailing(text: string): { core: string; removed: string; activity: boolean } | null {
  const words = tokens(text);
  let cut = words.length;
  while (cut > 0 && !capitalised(words[cut - 1]!) && (ACTIVITY_WORDS.has(words[cut - 1]!.toLowerCase()) || DESCRIPTIVE_WORDS.has(words[cut - 1]!.toLowerCase()))) cut -= 1;
  if (cut === words.length || cut === 0) return null;
  const core = words.slice(0, cut).join(' ');
  const removed = words.slice(cut).join(' ');
  // Connective words alone are not a description; the run must carry at least one real activity or descriptive word.
  if (!removed.split(' ').some((w) => !['and', 'with', 'at', 'for', 'of', 'the', 'a', 'an'].includes(w.toLowerCase()))) return null;
  if (!namesSomething(core)) return null;
  return { core, removed, activity: removed.split(' ').some((w) => ACTIVITY_WORDS.has(w.toLowerCase())) };
}

/** The place an end of a route names, without its description. */
const endOf = (text: string) => stripTrailing(text)?.core ?? text.trim();

/** A one-word start that is a common noun ("Road to Hana", "Gateway to the Valley") means the phrase is a name, not a route. */
const GENERIC_STARTS = new Set(['road', 'path', 'trail', 'way', 'gateway', 'stairway', 'highway', 'bridge', 'journey', 'stairs', 'steps', 'door', 'gate', 'portal', 'passage', 'ticket', 'return', 'ascent', 'descent', 'route']);
const isRouteEnd = (text: string) => namesSomething(text) && !(tokens(text).length === 1 && GENERIC_STARTS.has(text.trim().toLowerCase()));

export function normalizeCandidateIdentity(name: string): CandidateIdentity {
  const original = name.trim();

  /* C — a route: anchor at its start, which is where a traveller begins and what routing should reach. */
  const route = ROUTE.exec(original);
  if (route && isRouteEnd(route[1]!) && namesSomething(route[2]!)) {
    const from = endOf(route[1]!);
    const to = endOf(route[2]!);
    return { lookupName: from, type: 'route_anchor', reason: `A route from ${from} to ${to}; looked up at its start.`, route: { from, to } };
  }
  const via = VIA.exec(original);
  if (via && namesSomething(via[1]!) && isRouteEnd(via[2]!)) {
    const to = endOf(via[1]!);
    const from = endOf(via[2]!);
    return { lookupName: from, type: 'route_anchor', reason: `${to}, reached via ${from}; looked up where it starts.`, route: { from, to } };
  }

  /* D/E — "A and B": two names joined is two places, and choosing one would be a guess. */
  const and = AND.exec(original);
  if (and && namesSomething(and[1]!) && capitalised(tokens(and[2]!)[0] ?? '')) {
    return { lookupName: original, type: 'ambiguous', reason: 'Names two places; looked up as written rather than guessing which one is meant.' };
  }

  /* A/B — one place with words about it. */
  const stripped = stripTrailing(original);
  if (stripped) {
    return {
      lookupName: stripped.core,
      type: stripped.activity ? 'activity_qualifier_removed' : 'descriptive_suffix_removed',
      reason: `"${stripped.removed}" describes ${stripped.activity ? 'what to do there' : 'the place'}; looked up as ${stripped.core}.`,
      qualifier: stripped.removed,
    };
  }
  return { lookupName: original, type: 'unchanged', reason: 'Already a place name.' };
}

const meaningful = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !DESCRIPTIVE_WORDS.has(w) && !ACTIVITY_WORDS.has(w)),
  );

/**
 * Whether a provider's own name for its answer is the canonical form of what
 * was asked: every meaningful word of the answer appears in the query, and the
 * answer keeps most of the query's meaningful words. "Rifugio Scotoni" for
 * "Rifugio Scotoni traditional lunch stop" qualifies; "Rifugio Lagazuoi" for
 * "Rifugio Scotoni lunch stop" does not.
 */
export function providerNameIsCanonical(query: string, providerName: string): boolean {
  const asked = meaningful(query);
  const answered = meaningful(providerName);
  if (answered.size === 0 || asked.size === 0) return false;
  for (const word of answered) if (!asked.has(word)) return false;
  return answered.size / asked.size >= 0.6;
}

/**
 * Whether a provider's answer names *everything* an ambiguous phrase names:
 * every meaningful word asked for appears in the answer. "Lewis and Clark
 * Caverns State Park" covers "Lewis and Clark Caverns"; "Tokyo" does not cover
 * "Tokyo and Kyoto", and taking it would pick one of two places by accident.
 */
export function providerNameCoversPhrase(phrase: string, providerName: string): boolean {
  const asked = meaningful(phrase);
  const answered = meaningful(providerName);
  if (asked.size === 0) return false;
  for (const word of asked) if (!answered.has(word)) return false;
  return true;
}
