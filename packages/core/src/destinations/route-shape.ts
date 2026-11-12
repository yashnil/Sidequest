import type { GeographicScale, GeographicSemanticType } from './semantics';
import { classifyIntentPart } from './intent-graph';

/**
 * ROUTE-SHAPED TRIPS — A RING ROAD IS NOT A PLACE TO STAY.
 *
 * "Iceland Ring Road" resolved to a centre in Reykjavík with no extent and no
 * parts, the scan's proposal covered one coast, and the stay objective — which
 * values a place left unseen at its visit minutes — found eight nights in one
 * town cheaper than following the road. Nothing anywhere knew that the
 * traveller had asked for a journey: a loop around an island, a road from one
 * end of a country to the other, a road trip through a region.
 *
 * This module reads that from the traveller's own words, as patterns over
 * generic travel vocabulary (ring road, loop, circuit, road trip, coast road,
 * "around <a country or island>", "<A> to <B>", a numbered or named road) —
 * never a destination name. The resolved concept only refines a reading
 * ("around Tokyo" means near Tokyo; "around Iceland" means round it) and
 * vetoes one (a street named "… Road" inside a city is not a road trip).
 *
 * The reading travels on the destination envelope, so the scan's one proposal
 * call asks for the whole route, the coverage check can ask the one supplement
 * for the stretch that is missing, and the stay objective treats the bases
 * along the route as the traveller's intent rather than as costs to avoid.
 *
 * Pure: no provider, no model.
 */

export const ROUTE_SHAPE_KINDS = [
  /** Starts and ends in the same place, going round: a ring road, a circuit, "around the island". */
  'loop',
  /** From one end to another: "A to B", "the length of", "end to end". */
  'linear',
  /** A journey along roads whose closure the words do not settle: "road trip", a named scenic road. */
  'touring',
] as const;
export type RouteShapeKind = (typeof ROUTE_SHAPE_KINDS)[number];

export interface RouteShape {
  kind: RouteShapeKind;
  /** The words that made the reading, in the traveller's own spelling, for the record and the prompt. */
  cue: string;
  /** For a linear route the traveller spelled out ("Tokyo to Kyoto to Hiroshima"), the stops in their order. */
  stops?: string[];
}

export interface RouteShapeInput {
  /** What the traveller typed as the destination. */
  phrase: string;
  /** Free words the traveller wrote about the trip (a note), when the caller has them. */
  note?: string | null;
  /** What the destination resolved to, when known: only refines or vetoes a reading. */
  concept?: { type?: GeographicSemanticType | string | null; scale?: GeographicScale | string | null } | null;
}

/* ---------------------------------------------------------------------------------------------
 * Vocabulary — generic travel words only
 * ------------------------------------------------------------------------------------------- */

/** Words that make the trip go round. */
const LOOP_CUES: readonly RegExp[] = [/\bring\s+(?:road|route|highway)\b/, /\bring\s+of\s+\w+/, /\bcircuit\b/, /\bcircular\s+(?:route|tour|trip|drive)\b/, /\b(?:grand\s+)?loop\b/, /\bcircumnavigat\w*/, /\bfull\s+circle\b/];

/** Words that make the trip run from one end to another. */
const LINEAR_CUES: readonly RegExp[] = [/\bthe\s+length\s+of\b/, /\bend\s+to\s+end\b/, /\bcoast\s+to\s+coast\b/, /\btop\s+to\s+bottom\b/, /\bnorth\s+to\s+south\b/, /\bsouth\s+to\s+north\b/, /\beast\s+to\s+west\b/, /\bwest\s+to\s+east\b/];

/** Words that make it a journey by road without saying whether it closes. */
const TOURING_CUES: readonly RegExp[] = [
  /\broad\s*-?\s*trip\b/,
  /\bself\s*-?\s*drive\b/,
  /\bdriving\s+(?:tour|holiday|trip|route)\b/,
  /\b(?:coast|coastal|scenic|mountain|shore)\s+(?:road|route|drive|highway|byway)\b/,
  /\bcamper\s*-?\s*van\b/,
  /\bcampervan\b/,
  /\bmotor\s*-?\s*(?:home|bike)\s+(?:trip|tour)\b/,
  /\bmotorcycle\s+(?:trip|tour)\b/,
  /\bgrand\s+tour\b/,
];

/** A numbered road: "Route 66", "Highway 1", "Interstate 90", "SH 6". */
const NUMBERED_ROAD = /\b(?:route|highway|hwy|interstate|ruta|rota|strada|carretera|autoroute|byway|sh|us)\s*-?\s*\d{1,4}\b/;
/** A route code standing as the whole phrase, or before a road word: "NC500", "NC 500 road trip". */
const ROUTE_CODE = /^\s*[a-z]{2,3}\s?\d{3}\s*$|\b[a-z]{2,3}\s?\d{3}\s+(?:route|road|trip|drive|loop)\b/;
/** A part whose last word names a road: "Great Ocean Road", "Pacific Coast Highway", "Blue Ridge Parkway". */
const NAMED_ROAD_TAIL = /\b(?:road|route|highway|parkway|byway|drive|motorway)\s*$/;

/** "around Iceland", "round the island", "all the way round Ireland". */
const AROUND = /\b(?:all\s+the\s+way\s+)?a?round\s+(?:the\s+)?(.+)$/;

/** An "X to Y" whose X is a kind of trip rather than a place ("trip to Japan"). */
const NOT_A_START = /^(?:a\s+|my\s+|our\s+|the\s+)?(?:trip|holiday|vacation|honeymoon|journey|visit|getaway|weekend|escape|flight|drive|fly|walk|hike|sail|travel|go|going|moving|move|return|back|day|days|week|weeks|\d+\s*(?:days?|weeks?|nights?))$/;

/** Kinds of destination a traveller can go round. */
const ROUNDABLE_TYPES = new Set(['country', 'island', 'island_group', 'admin_area', 'natural_region', 'mountain_region', 'coast', 'informal_region', 'protected_area', 'multi_country']);
const ROUNDABLE_KINDS = new Set(['country', 'island', 'island_chain', 'admin_region', 'natural_region', 'mountain_range', 'coast', 'vague_region', 'park']);
/** Scales at which a "… Road" or "… Drive" is a street, not a journey. */
const STREET_SCALES = new Set(['point', 'neighbourhood', 'settlement', 'district']);

function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[–—→]/g, ' to ')
    .replace(/->/g, ' to ')
    .replace(/[^a-z0-9\s'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchOf(patterns: readonly RegExp[], text: string): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return null;
}

/** "Tokyo to Kyoto to Hiroshima", "from Lisbon to Porto": the stops, or null when the phrase is not a journey. */
function journeyStops(text: string): string[] | null {
  const body = text.replace(/^from\s+/, '');
  if (!/\s(?:to|via)\s/.test(body)) return null;
  const stops = body.split(/\s+(?:to|via)\s+/).map((s) => s.trim()).filter(Boolean);
  if (stops.length < 2) return null;
  if (NOT_A_START.test(stops[0]!)) return null;
  /* "coast to coast", "end to end": a linear cue, already read; never two places called "north" and "south". */
  if (stops.some((s) => /^(?:coast|end|top|bottom|north|south|east|west)$/.test(s))) return null;
  return stops;
}

/**
 * Whether what the traveller typed is a journey rather than a place, and what
 * kind. Null when it is a place (or several named places): "Tokyo", "Kyoto and
 * Nara", "the Dolomites".
 */
export function readRouteShape(input: RouteShapeInput): RouteShape | null {
  const phrase = fold(input.phrase ?? '');
  const note = fold(input.note ?? '');
  if (!phrase && !note) return null;
  const scale = input.concept?.scale ?? null;
  const type = input.concept?.type ?? null;
  const streetScale = scale !== null && STREET_SCALES.has(String(scale));

  const fromWords = (text: string): RouteShape | null => {
    const loop = matchOf(LOOP_CUES, text);
    /* "The Loop" inside a city is a district, not a circuit. */
    if (loop && !(streetScale && /^(?:grand\s+)?loop$/.test(loop))) return { kind: 'loop', cue: loop };
    const linear = matchOf(LINEAR_CUES, text);
    if (linear) return { kind: 'linear', cue: linear };
    const around = AROUND.exec(text);
    if (around) {
      const target = around[1]!.replace(/\s+(?:road\s*-?\s*trip|by\s+car|in\s+\w+\s+days?)$/, '').trim();
      const touring = matchOf(TOURING_CUES, text) !== null;
      const roundable = (type !== null && ROUNDABLE_TYPES.has(String(type))) || ROUNDABLE_KINDS.has(classifyIntentPart(target).kind);
      if (target && (touring || (roundable && !streetScale))) return { kind: 'loop', cue: around[0].trim() };
    }
    const touring = matchOf(TOURING_CUES, text);
    if (touring) return { kind: 'touring', cue: touring };
    return null;
  };

  const worded = fromWords(phrase);
  if (worded) return worded;

  const stops = journeyStops(phrase);
  if (stops) return { kind: 'linear', cue: stops.join(' to '), stops: stops.map((s) => titleOf(input.phrase, s)) };

  const numbered = NUMBERED_ROAD.exec(phrase) ?? ROUTE_CODE.exec(phrase);
  if (numbered && !streetScale) return { kind: 'touring', cue: numbered[0].trim() };
  const tail = NAMED_ROAD_TAIL.exec(phrase);
  /* A road named as the whole destination is a journey along it, unless what it resolved to is a street in a town. */
  if (tail && phrase.split(' ').length >= 2 && !streetScale) return { kind: 'touring', cue: phrase };

  /* The traveller's note can make it a journey ("we want to do it as a road trip"), never unmake one. */
  const fromNote = note ? fromWords(note) : null;
  if (fromNote) return fromNote;
  return null;
}

/** The stop as the traveller spelled it, found again in their original phrase (case kept). */
function titleOf(original: string, folded: string): string {
  const words = folded.split(' ');
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^A-Za-z0-9]+'), 'i');
  const hit = re.exec(original.normalize('NFKD').replace(/[̀-ͯ]/g, ''));
  return hit ? hit[0] : folded;
}

/** One sentence for the scan's task and the record. Never a place the traveller did not type. */
export function describeRouteShape(shape: RouteShape): string {
  switch (shape.kind) {
    case 'loop':
      return `A loop ("${shape.cue}"): the trip goes round and ends where it began.`;
    case 'linear':
      return shape.stops && shape.stops.length >= 2 ? `A journey from ${shape.stops[0]} to ${shape.stops[shape.stops.length - 1]}${shape.stops.length > 2 ? ` by way of ${shape.stops.slice(1, -1).join(', ')}` : ''}.` : `A journey from one end to the other ("${shape.cue}").`;
    case 'touring':
      return `A journey by road ("${shape.cue}"): the trip follows the route rather than staying in one place.`;
  }
}
