/**
 * ANCHOR SEMANTICS — NOT EVERY LINE IN A MODEL ITINERARY IS A RESOLVABLE POI.
 *
 * "Kilkenny Castle" is a named place and must resolve. "Temple Bar and
 * Grafton Street walk" is an area experience: real, mappable roughly, but a
 * geocoder cannot confirm it as one venue and should not be asked to. "Slea
 * Head Drive" is a route. "A traditional pub with live music" is an intent
 * until a venue is named. "Killarney town pub dinner" is a meal, and belongs
 * with the day's meals, not at 11:15 as an attraction.
 *
 * Deterministic and text-based on purpose: the reconciler needs the answer
 * before any provider is consulted, and the answer decides whether a provider
 * is consulted at all.
 */
export const ANCHOR_KINDS = ['named_place', 'area_experience', 'route_experience', 'generic_experience', 'meal', 'flex'] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export const ANCHOR_KIND_LABELS: Record<AnchorKind, string> = {
  named_place: 'Place',
  area_experience: 'Area',
  route_experience: 'Route',
  generic_experience: 'Experience',
  meal: 'Meal',
  flex: 'Flexible',
};

const MEAL_WORDS = /\b(breakfast|brunch|lunch|dinner|supper|meal|tasting menu|food stop|coffee stop|café stop|cafe stop|pub grub)\b/i;
const MEAL_INTENT = /\b(pub dinner|pub lunch|seafood dinner|special dinner|special meal|dinner at|lunch at|dinner in|lunch in|breakfast at|breakfast in|food stop)\b/i;
const GENERIC_VENUE = /^(a |an |the )?(traditional |local |cosy |cozy |lively |quiet |seafood |harbour |harbor |old )*(pub|restaurant|café|cafe|bistro|bar|brasserie|trattoria|taverna|izakaya|tapas bar|wine bar|tea room|bakery)( with [a-z ]+| near [a-z ]+| in [a-z ]+)?$/i;
const AREA_WORDS = /\b(walk|stroll|wander|amble|promenade walk|streets|quarter|district|neighbourhood|neighborhood|old town|town walk|city walk|area walk|and .* walk|waterfront|harbour walk|harbor walk|evening walk|evening stroll|sunset walk|market browse|browse)\b/i;
const ROUTE_WORDS = /\b(drive|loop|road|pass|route|way|circuit|scenic drive|coast road|ring|peninsula drive|corridor)\b/i;
const GENERIC_EXPERIENCE = /\b(near (the )?(hotel|base)|near [A-Za-z]+ (base|hotel)|near base|short walk|free afternoon|free morning|rest|leisure|at leisure|check-in|check in|settle in|orientation|local (café|cafe) and|coffee and|explore on foot|wander)\b/i;
/** A proper noun or place marker anywhere in the name: capitalised words beyond the first, or an apostrophe name like "St Canice's". */
const PROPER_NOUN = /(\b[A-Z][a-zÀ-ÿ'’]+\b.*\b[A-Z][a-zÀ-ÿ'’]+\b)|(\b(St|Saint|Mount|Mt|Lake|Lough|Cape|Castle|Abbey|Cathedral|Museum|Park|Fort|Market|Bridge|Palace|Temple|Gardens?|House|Island|Falls|Beach|Cliffs?|Bay|Pier|Tower|Gallery|Distillery|Brewery|Winery|Monastery|Church|Square|Basilica|Mosque|Shrine)\b)/;

export interface AnchorLike {
  name: string;
  category: string;
  role?: 'core' | 'secondary' | 'optional' | 'flex' | string;
}

export function anchorKindOf(anchor: AnchorLike): AnchorKind {
  const name = anchor.name.trim();
  if (anchor.category === 'food') {
    // A named food venue or market stays a place; an intent ("pub dinner") is a meal.
    if (MEAL_INTENT.test(name) || MEAL_WORDS.test(name) || GENERIC_VENUE.test(name)) return 'meal';
    if (PROPER_NOUN.test(name)) return 'named_place';
    return 'meal';
  }
  if (anchor.category === 'market' && PROPER_NOUN.test(name)) return 'named_place';
  if (anchor.category === 'scenic_drive') return 'route_experience';
  if (MEAL_WORDS.test(name) && !PROPER_NOUN.test(name.replace(MEAL_WORDS, ''))) return 'meal';
  if (GENERIC_EXPERIENCE.test(name) && !PROPER_NOUN.test(name.replace(/\b(Local|Short|Free|Evening|Morning|Coffee)\b/g, '').replace(/near [A-Za-z]+ (base|hotel)/, ''))) return anchor.role === 'flex' ? 'flex' : 'generic_experience';
  if (anchor.category === 'neighbourhood' || anchor.category === 'town') {
    if (AREA_WORDS.test(name)) return anchor.role === 'flex' ? 'flex' : 'area_experience';
    if (PROPER_NOUN.test(name)) return 'named_place';
    return anchor.role === 'flex' ? 'flex' : 'area_experience';
  }
  if (ROUTE_WORDS.test(name) && /drive|loop|road|pass|ring|circuit|route/i.test(name) && !/castle|abbey|museum|house|fort/i.test(name)) return 'route_experience';
  if (AREA_WORDS.test(name) && /walk|stroll|wander/i.test(name) && !/castle|abbey|museum|cathedral|fort|park\b/i.test(name)) return 'area_experience';
  if (GENERIC_VENUE.test(name)) return 'generic_experience';
  if (!PROPER_NOUN.test(name) && /^(a |an |the )?[a-z]/.test(name)) return 'generic_experience';
  return 'named_place';
}

/** Kinds a places provider or geocoder should ever be asked about, and in what priority band (lower first). */
export function lookupPriorityFor(kind: AnchorKind, role: string | undefined): number | null {
  if (kind === 'meal' || kind === 'generic_experience' || kind === 'flex') return null;
  if (kind === 'named_place') return role === 'core' ? 1 : 2;
  return 3; // area or route: for the map, when time allows
}

/** Whether the traveller-facing UI may call this "not verified" at all. */
export function verificationApplies(kind: AnchorKind | undefined): boolean {
  return kind === undefined || kind === 'named_place';
}

/** Which meal slot a meal anchor speaks to, from its wording; dinner when it only says "meal". */
export function mealSlotOf(name: string): 'breakfast' | 'lunch' | 'dinner' {
  if (/breakfast|brunch|coffee|morning/i.test(name)) return 'breakfast';
  if (/lunch|midday|noon/i.test(name)) return 'lunch';
  return 'dinner';
}
