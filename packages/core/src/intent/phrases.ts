import type { ChipTarget, SuggestedQuestionTopic } from '../schemas/interpretation';

/**
 * FROM WHAT SOMEBODY WROTE TO A CONTROLLED PREFERENCE, WITHOUT A MODEL.
 *
 * The same argument the source-category taxonomy makes, applied to a different
 * vocabulary: asking a language model "does 'no early starts' mean early
 * mornings?" buys an answer a table already knows, at a cost, with a latency,
 * and with a failure mode where the answer is confidently wrong.
 *
 * Three rules keep it honest, and each is checked by a test:
 *
 * - **Every key is a common word.** Not a place, not a region, not a proper
 *   noun of any kind. "hot spring" is here; no destination that has one is.
 * - **Every value is a member of an existing enum.** Nothing here invents a
 *   preference vocabulary; the interest, avoidance, pace, budget, crowd and
 *   discovery-mix sets already exist and are what the scorer reads.
 * - **It is English, and it says so.** A lexicon that silently covered one
 *   language while presenting itself as universal would make "your sentence
 *   produced nothing" indistinguishable from "you wrote nothing".
 *
 * What is deliberately *not* here: any phrase that would produce a mobility,
 * dietary or group constraint. Those are in `SAFETY_ADJACENT` instead, and they
 * raise a question rather than a chip.
 */

export const LEXICON_LOCALE = 'en';

/** Longest first, so "hot spring" wins over "spring" and "long drive" over "drive". */
export const PHRASES: readonly (readonly [string, ChipTarget])[] = [
  // --- Interests ----------------------------------------------------------
  ['easy nature walk', { kind: 'interest', value: 'easy_nature_walks' }],
  ['nature walk', { kind: 'interest', value: 'easy_nature_walks' }],
  ['gentle walk', { kind: 'interest', value: 'easy_nature_walks' }],
  ['short walk', { kind: 'interest', value: 'easy_nature_walks' }],
  ['boardwalk', { kind: 'interest', value: 'easy_nature_walks' }],
  ['stroll', { kind: 'interest', value: 'easy_nature_walks' }],

  ['hiking', { kind: 'interest', value: 'hiking' }],
  ['hike', { kind: 'interest', value: 'hiking' }],
  ['trail', { kind: 'interest', value: 'hiking' }],
  ['trek', { kind: 'interest', value: 'hiking' }],
  ['summit', { kind: 'interest', value: 'hiking' }],
  ['backpacking', { kind: 'interest', value: 'hiking' }],

  ['scenic viewpoint', { kind: 'interest', value: 'scenic_viewpoints' }],
  ['viewpoint', { kind: 'interest', value: 'scenic_viewpoints' }],
  ['lookout', { kind: 'interest', value: 'scenic_viewpoints' }],
  ['overlook', { kind: 'interest', value: 'scenic_viewpoints' }],
  ['panorama', { kind: 'interest', value: 'scenic_viewpoints' }],
  ['vista', { kind: 'interest', value: 'scenic_viewpoints' }],
  ['views', { kind: 'interest', value: 'scenic_viewpoints' }],

  ['waterfall', { kind: 'interest', value: 'lakes_and_rivers' }],
  ['lake', { kind: 'interest', value: 'lakes_and_rivers' }],
  ['river', { kind: 'interest', value: 'lakes_and_rivers' }],
  ['swimming', { kind: 'interest', value: 'lakes_and_rivers' }],
  ['swim', { kind: 'interest', value: 'lakes_and_rivers' }],
  ['kayak', { kind: 'interest', value: 'lakes_and_rivers' }],
  ['paddle', { kind: 'interest', value: 'lakes_and_rivers' }],
  ['beach', { kind: 'interest', value: 'lakes_and_rivers' }],

  ['scenic drive', { kind: 'interest', value: 'scenic_drives' }],
  ['road trip', { kind: 'interest', value: 'scenic_drives' }],
  ['byway', { kind: 'interest', value: 'scenic_drives' }],
  ['coastal road', { kind: 'interest', value: 'scenic_drives' }],

  ['wildlife', { kind: 'interest', value: 'wildlife' }],
  ['birdwatching', { kind: 'interest', value: 'wildlife' }],
  ['birding', { kind: 'interest', value: 'wildlife' }],
  ['whales', { kind: 'interest', value: 'wildlife' }],
  ['safari', { kind: 'interest', value: 'wildlife' }],
  ['animals', { kind: 'interest', value: 'wildlife' }],

  ['geothermal', { kind: 'interest', value: 'geology_and_geothermal' }],
  ['volcano', { kind: 'interest', value: 'geology_and_geothermal' }],
  ['geyser', { kind: 'interest', value: 'geology_and_geothermal' }],
  ['glacier', { kind: 'interest', value: 'geology_and_geothermal' }],
  ['caves', { kind: 'interest', value: 'geology_and_geothermal' }],
  ['geology', { kind: 'interest', value: 'geology_and_geothermal' }],

  ['hot spring', { kind: 'interest', value: 'hot_springs' }],
  ['thermal bath', { kind: 'interest', value: 'hot_springs' }],
  ['onsen', { kind: 'interest', value: 'hot_springs' }],
  ['hot pool', { kind: 'interest', value: 'hot_springs' }],

  ['museum', { kind: 'interest', value: 'history_and_culture' }],
  ['gallery', { kind: 'interest', value: 'history_and_culture' }],
  ['history', { kind: 'interest', value: 'history_and_culture' }],
  ['historic', { kind: 'interest', value: 'history_and_culture' }],
  ['castle', { kind: 'interest', value: 'history_and_culture' }],
  ['temple', { kind: 'interest', value: 'history_and_culture' }],
  ['cathedral', { kind: 'interest', value: 'history_and_culture' }],
  ['ruins', { kind: 'interest', value: 'history_and_culture' }],
  ['architecture', { kind: 'interest', value: 'history_and_culture' }],

  ['street food', { kind: 'interest', value: 'food_and_towns' }],
  ['local food', { kind: 'interest', value: 'food_and_towns' }],
  ['restaurant', { kind: 'interest', value: 'food_and_towns' }],
  ['markets', { kind: 'interest', value: 'food_and_towns' }],
  ['market', { kind: 'interest', value: 'food_and_towns' }],
  ['bakery', { kind: 'interest', value: 'food_and_towns' }],
  ['coffee', { kind: 'interest', value: 'food_and_towns' }],
  ['eating', { kind: 'interest', value: 'food_and_towns' }],
  ['food', { kind: 'interest', value: 'food_and_towns' }],

  ['golden hour', { kind: 'interest', value: 'photography_golden_hour' }],
  ['sunrise', { kind: 'interest', value: 'photography_golden_hour' }],
  ['sunset', { kind: 'interest', value: 'photography_golden_hour' }],
  ['photography', { kind: 'interest', value: 'photography_golden_hour' }],

  ['northern lights', { kind: 'interest', value: 'stargazing' }],
  ['milky way', { kind: 'interest', value: 'stargazing' }],
  ['stargazing', { kind: 'interest', value: 'stargazing' }],
  ['night sky', { kind: 'interest', value: 'stargazing' }],
  ['aurora', { kind: 'interest', value: 'stargazing' }],

  // --- Avoidances ---------------------------------------------------------
  ['tourist trap', { kind: 'avoidance', value: 'crowds_and_tourist_traps' }],
  ['crowds', { kind: 'avoidance', value: 'crowds_and_tourist_traps' }],
  ['crowded', { kind: 'avoidance', value: 'crowds_and_tourist_traps' }],
  ['queues', { kind: 'avoidance', value: 'crowds_and_tourist_traps' }],
  ['queueing', { kind: 'avoidance', value: 'crowds_and_tourist_traps' }],

  ['all day hike', { kind: 'avoidance', value: 'long_hikes' }],
  ['long hike', { kind: 'avoidance', value: 'long_hikes' }],
  ['big hike', { kind: 'avoidance', value: 'long_hikes' }],

  ['strenuous', { kind: 'avoidance', value: 'strenuous_activity' }],
  ['exhausting', { kind: 'avoidance', value: 'strenuous_activity' }],
  ['gruelling', { kind: 'avoidance', value: 'strenuous_activity' }],
  ['grueling', { kind: 'avoidance', value: 'strenuous_activity' }],

  ['hours in the car', { kind: 'avoidance', value: 'long_drives' }],
  ['lots of driving', { kind: 'avoidance', value: 'long_drives' }],
  ['long drive', { kind: 'avoidance', value: 'long_drives' }],

  ['gravel road', { kind: 'avoidance', value: 'rough_or_gravel_roads' }],
  ['dirt road', { kind: 'avoidance', value: 'rough_or_gravel_roads' }],
  ['unpaved', { kind: 'avoidance', value: 'rough_or_gravel_roads' }],
  ['rough road', { kind: 'avoidance', value: 'rough_or_gravel_roads' }],

  ['high altitude', { kind: 'avoidance', value: 'high_altitude_exertion' }],
  ['thin air', { kind: 'avoidance', value: 'high_altitude_exertion' }],
  ['altitude', { kind: 'avoidance', value: 'high_altitude_exertion' }],

  ['early start', { kind: 'avoidance', value: 'early_mornings' }],
  ['early morning', { kind: 'avoidance', value: 'early_mornings' }],
  ['crack of dawn', { kind: 'avoidance', value: 'early_mornings' }],
  ['alarm', { kind: 'avoidance', value: 'early_mornings' }],

  ['middle of nowhere', { kind: 'avoidance', value: 'remote_areas_without_services' }],
  ['no services', { kind: 'avoidance', value: 'remote_areas_without_services' }],
  ['off grid', { kind: 'avoidance', value: 'remote_areas_without_services' }],
  ['remote', { kind: 'avoidance', value: 'remote_areas_without_services' }],

  ['overpriced', { kind: 'avoidance', value: 'expensive_activities' }],
  ['expensive', { kind: 'avoidance', value: 'expensive_activities' }],
  ['pricey', { kind: 'avoidance', value: 'expensive_activities' }],

  ['freezing water', { kind: 'avoidance', value: 'cold_water' }],
  ['cold water', { kind: 'avoidance', value: 'cold_water' }],

  ['extreme heat', { kind: 'avoidance', value: 'extreme_heat' }],
  ['humid', { kind: 'avoidance', value: 'extreme_heat' }],
  ['heat', { kind: 'avoidance', value: 'extreme_heat' }],

  ['extreme cold', { kind: 'avoidance', value: 'extreme_cold' }],
  ['freezing', { kind: 'avoidance', value: 'extreme_cold' }],

  // --- Shape of the days --------------------------------------------------
  ['take it slow', { kind: 'pace', value: 'slow' }],
  ['slow down', { kind: 'pace', value: 'slow' }],
  ['unwind', { kind: 'pace', value: 'slow' }],
  ['relax', { kind: 'pace', value: 'slow' }],
  ['see everything', { kind: 'pace', value: 'fast' }],
  ['pack it in', { kind: 'pace', value: 'fast' }],
  ['cover ground', { kind: 'pace', value: 'fast' }],

  ['sleep in', { kind: 'day_start', value: 'relaxed' }],
  ['lie in', { kind: 'day_start', value: 'relaxed' }],
  ['slow morning', { kind: 'day_start', value: 'relaxed' }],

  ['off the beaten path', { kind: 'discovery_mix', value: 'mostly_hidden' }],
  ['hidden gem', { kind: 'discovery_mix', value: 'mostly_hidden' }],
  ['touristy', { kind: 'discovery_mix', value: 'mostly_hidden' }],
  ['the classics', { kind: 'discovery_mix', value: 'mostly_classics' }],
  ['the highlights', { kind: 'discovery_mix', value: 'mostly_classics' }],

  ['treat ourselves', { kind: 'budget', value: 'premium' }],
  ['splurge', { kind: 'budget', value: 'premium' }],
  ['on a budget', { kind: 'budget', value: 'budget' }],
  ['cheap', { kind: 'budget', value: 'budget' }],
];

/**
 * Phrases that must never become a chip, whatever they look like.
 *
 * Each raises a question instead. The asymmetry is deliberate and it is the most
 * important rule in this directory: a wrong casual preference costs one mediocre
 * suggestion, and a wrong safety constraint either strands somebody at a
 * trailhead or tells them a kitchen is safe. Neither is recoverable from a chip
 * in a row, and neither is a thing to infer from a sentence.
 */
export const SAFETY_ADJACENT: readonly (readonly [string, SuggestedQuestionTopic])[] = [
  ['wheelchair', 'mobility'],
  ['mobility', 'mobility'],
  ['bad knee', 'mobility'],
  ['knees', 'mobility'],
  ['knee', 'mobility'],
  ['hip replacement', 'mobility'],
  ['walking stick', 'mobility'],
  ['cannot walk far', 'mobility'],
  ['can’t walk far', 'mobility'],
  ["can't walk far", 'mobility'],
  ['bad back', 'mobility'],

  ['gluten free', 'dietary'],
  ['gluten-free', 'dietary'],
  ['coeliac', 'dietary'],
  ['celiac', 'dietary'],
  ['nut allergy', 'dietary'],
  ['allergic', 'dietary'],
  ['allergy', 'dietary'],
  ['vegetarian', 'dietary'],
  ['vegan', 'dietary'],
  ['halal', 'dietary'],
  ['kosher', 'dietary'],
  ['dairy free', 'dietary'],
  ['lactose', 'dietary'],

  ['pregnant', 'group_needs'],
  ['toddler', 'group_needs'],
  ['pushchair', 'group_needs'],
  ['stroller', 'group_needs'],
  ['my mother', 'group_needs'],
  ['my father', 'group_needs'],
  ['grandparents', 'group_needs'],
  ['elderly', 'group_needs'],
];

/**
 * THE TWO SIGNALS THAT SAY "THIS IS NOT THE LANGUAGE WE READ".
 *
 * The lexicon is English. It has always said so on every result, and until now
 * the screen still told a French speaker "we have no setting that means this" —
 * which names the wrong cause. It is not that their preference has no home in
 * the taxonomy; it is that our reader does not speak their language. So the
 * detector below exists to earn a *different sentence*, and it is deliberately
 * conservative in both directions: it never says "not our language" about text
 * that might be English, and it does not pretend to identify which language it
 * actually is, because naming a language we cannot read would be a claim we
 * cannot support.
 *
 * Two signals, and the first is much the stronger:
 *
 * 1. **Script.** Text whose letters are mostly outside the Latin script cannot
 *    be English. That covers Japanese, Chinese, Korean, Arabic, Hebrew, Greek,
 *    Cyrillic, Thai, Devanagari and the rest, and it is a fact about characters
 *    rather than a guess about words.
 * 2. **Function words.** Latin-script languages share our alphabet, so the only
 *    honest test is lexical: a clause containing a function word from another
 *    language and *no* English function word at all is not English. Every entry
 *    below is at least three characters and is not also an English word —
 *    `die`, `sin`, `per`, `come` and `a` are all excluded for exactly that
 *    reason, and the list stays short because a false positive here tells
 *    somebody writing English that we cannot read English.
 */
export const NON_LEXICON_FUNCTION_WORDS = [
  // French
  'nous', 'vous', 'avec', 'sans', 'pour', 'dans', 'mais', 'très', 'beaucoup', 'voudrais', 'aimerions', 'quelque',
  // German
  'wir', 'ich', 'und', 'nicht', 'oder', 'sehr', 'ohne', 'mit', 'keine', 'kein', 'das', 'der', 'ist', 'möchten', 'wollen',
  // Spanish
  'nosotros', 'queremos', 'pero', 'para', 'muy', 'también', 'nada', 'algo', 'donde',
  // Italian
  'vogliamo', 'molto', 'senza', 'anche', 'però', 'qualcosa', 'niente',
  // Portuguese
  'muito', 'sem', 'não', 'nós', 'algum',
];

/**
 * English function words. Their presence vetoes the lexical signal above.
 *
 * A clause containing any of these is treated as English even if it also
 * contains a borrowed word, because a borrowing is not a language.
 */
export const LEXICON_FUNCTION_WORDS = [
  'the', 'and', 'but', 'not', 'with', 'without', 'would', 'want', 'like', 'love', 'some', 'any',
  'our', 'we', 'you', 'they', 'for', 'from', 'that', 'this', 'have', 'are', 'is', 'was', 'too',
  'lot', 'lots', 'nothing', 'anything', 'something', 'somewhere', 'rather', 'please', 'day', 'days',
];

/** Words that flip a clause. Applied to the clause, never to the sentence. */
export const NEGATORS = [
  'rather not',
  'would rather avoid',
  'not into',
  'not big on',
  'no more',
  'do not',
  "don't",
  'don’t',
  'cannot',
  "can't",
  'can’t',
  'without',
  'nothing',
  'never',
  'avoid',
  'skip',
  'hate',
  'not',
  'no ',
];

/**
 * Words that make something firmer than a mention and softer than a demand.
 *
 * The rung between `preference` and `must_have` on the affirming side, and
 * between `dislike` and `hard_avoid` on the refusing one. It exists because
 * "we'd love a hot spring" and "hot springs" are not the same sentence, and
 * neither is "we hate crowds" and "crowds, ideally not".
 *
 * Matched on word boundaries rather than by substring, which the two older lists
 * are not: `includes('love')` matches "lovely", and a marker that fires on the
 * wrong word is a strength the traveller did not express.
 */
export const EMPHATIC_AFFIRMING_MARKERS = [
  'really want',
  'big fans of',
  'main reason',
  'desperate to',
  'dying to',
  'cannot wait',
  'love',
  'loves',
  'adore',
];

/**
 * The refusing half, kept in its own list rather than shared.
 *
 * One list read for both directions is how "not really into museums" became a
 * *strong* dislike: the clause contains "really into", the polarity is negative,
 * and a shared list has no way to know the marker was the thing being negated.
 * Splitting them means the affirming list is never consulted for a negative
 * clause and vice versa, so a negated emphatic falls through to the ordinary
 * rung — which is what "not really into" means.
 */
export const EMPHATIC_REFUSING_MARKERS = [
  'hate',
  'hates',
  'loathe',
  'cannot stand',
  "can't stand",
  'can’t stand',
  'sick of',
  'fed up with',
];

/**
 * Words that make something explicitly conditional. The weakest rung.
 *
 * Below `preference`, and distinct from it: "a hot spring if it's on the way" is
 * an offer to take one, not a wish for one, and a trip built to satisfy it would
 * be spending days on something nobody asked for.
 */
export const TENTATIVE_MARKERS = [
  'if it works out',
  'if it is on the way',
  "if it's on the way",
  'if we happen to',
  'not fussed',
  'not bothered',
  'take it or leave it',
  'no big deal',
  'at a push',
  'only if',
  'wouldn’t say no',
  "wouldn't say no",
];

/** Words that make something a requirement rather than a wish. */
export const STRONG_MARKERS = [
  'non-negotiable',
  'would regret',
  'the whole point',
  'top of the list',
  'came here for',
  'came for',
  'absolutely',
  'definitely',
  'must be',
  'have to',
  'need to',
  'must ',
];

/** Words that make something explicitly tentative. Never a requirement. */
export const SOFT_MARKERS = [
  'would be nice',
  'would like',
  'if we can',
  'if possible',
  'lean towards',
  'ideally',
  'hoping',
  'prefer',
  'maybe',
  'keen on',
];
