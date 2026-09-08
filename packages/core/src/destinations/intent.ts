import { z } from 'zod';
import { coordinatesSchema } from '../schemas/common';
import { geoBoundsSchema, type ScopeBreadth } from '../schemas/geography';
import {
  destinationFeatureTypeSchema,
  type DestinationFeatureType,
  type SelectedDestination,
} from '../schemas/destination-index';
import {
  normalizeDestinationQuery,
  ambiguityReasonSchema,
  type DestinationResolution,
} from '../schemas/resolution';

/**
 * WHAT THE TRAVELLER MEANT, KEPT AS ONE RECORD FOR THE LIFE OF THE TRIP.
 *
 * MVP V3, Stages 9–13. Before this, "the destination" was three different
 * values living in three places: the string somebody typed, the gazetteer row
 * they may or may not have clicked, and whatever the resolver later decided.
 * Each screen picked whichever one was nearest to hand, and the picking was
 * invisible — which is how "inland Alaska" became a town of nine hundred people
 * with nobody able to point at the line where it happened.
 *
 * One record fixes that by making the three things different **fields** rather
 * than competing answers:
 *
 * - `rawText` is what they typed, verbatim, forever. Nothing overwrites it and
 *   nothing normalises it. It travels into the composition task unchanged.
 * - `interpretedLabel` is what Sidequest thinks that names. It equals `rawText`
 *   whenever the resolver landed on something the phrase does not obviously
 *   name, because a resolution is a *lead*, not a correction.
 * - `anchor` is the resolved place when there is one — a centre to plan around,
 *   explicitly not a redefinition of where the traveller is going.
 *
 * Geocoding **enriches** this record. It cannot empty it, cannot replace the
 * label, and cannot stop a trip: an intent with nothing but `rawText` is a
 * perfectly valid intent, and a composition built from one is a perfectly valid
 * trip. That is the whole of "unknown ≠ false" applied to the first question
 * the product asks.
 *
 * Nothing here knows any destination's name. Every rule below is about the
 * *shape* of a phrase and the *type* of a gazetteer row.
 */

export const DESTINATION_INTENT_VERSION = 1 as const;

/**
 * What kind of thing the phrase names — not which thing.
 *
 * The distinction that matters for planning is how a trip has to be *built*:
 * one base or several, a boundary that exists or one that has to be assumed.
 */
export const DESTINATION_INTERPRETATION_TYPES = [
  /** A city, town or district: one place, one likely base. */
  'locality',
  /** A country, region or county: real boundary, needs a subset chosen. */
  'administrative_area',
  /** A park, island or protected area: a boundary that is not administrative. */
  'natural_area',
  /** A single site somebody named. Almost never the whole trip. */
  'landmark',
  /** The phrase names more than one place ("Tokyo and Kyoto", "Lisbon, Porto"). */
  'multi_area',
  /** A real area no gazetteer publishes: "inland Alaska", "the steppes". */
  'descriptive_area',
  /** Nothing was matched and the phrase's shape says nothing either. */
  'unresolved',
] as const;
export const destinationInterpretationTypeSchema = z.enum(DESTINATION_INTERPRETATION_TYPES);
export type DestinationInterpretationType = z.infer<typeof destinationInterpretationTypeSchema>;

/** Which feature types read as which interpretation. Types, never names. */
const TYPE_FROM_FEATURE: Record<DestinationFeatureType, DestinationInterpretationType> = {
  country: 'administrative_area',
  dependency: 'administrative_area',
  region: 'administrative_area',
  county: 'administrative_area',
  city: 'locality',
  town: 'locality',
  district: 'locality',
  island: 'natural_area',
  national_park: 'natural_area',
  protected_area: 'natural_area',
  landmark: 'landmark',
  other: 'unresolved',
};

/** Where a field came from, so a later reader can tell enrichment from input. */
export const DESTINATION_INTENT_SOURCES = [
  'traveller_text',
  'traveller_selection',
  'destination_index',
  'geocoder',
  'resolution',
] as const;
export const destinationIntentSourceSchema = z.enum(DESTINATION_INTENT_SOURCES);
export type DestinationIntentSource = z.infer<typeof destinationIntentSourceSchema>;

export const destinationIntentSchema = z.object({
  schemaVersion: z.literal(DESTINATION_INTENT_VERSION),
  /** Exactly what was typed. Never rewritten, never trimmed of meaning. */
  rawText: z.string().min(1),
  /** Case-folded and whitespace-collapsed, for equality only. Never displayed. */
  normalizedText: z.string().min(1),
  /** What Sidequest calls this destination. Equals `rawText` unless a resolution earned better. */
  interpretedLabel: z.string().min(1),
  interpretationType: destinationInterpretationTypeSchema,
  /** ISO 3166-1 alpha-2, as many as the evidence names. Empty is honest. */
  countries: z.array(z.string().length(2)).default([]),
  /**
   * The resolved place, when one was resolved. A centre to plan around and a
   * name to show as *context* — not a replacement for `interpretedLabel`.
   */
  anchor: z
    .object({
      label: z.string().min(1),
      featureType: destinationFeatureTypeSchema,
      center: coordinatesSchema,
      bounds: geoBoundsSchema.optional(),
      entryId: z.string().min(1).optional(),
    })
    .optional(),
  center: coordinatesSchema.optional(),
  bounds: geoBoundsSchema.optional(),
  /** How sure Sidequest is that the label names what the traveller meant. */
  confidence: z.enum(['high', 'medium', 'low']),
  sources: z.array(destinationIntentSourceSchema).default([]),
  ambiguities: z.array(ambiguityReasonSchema).default([]),
  recordedAt: z.string().min(1),
});
export type DestinationIntent = z.infer<typeof destinationIntentSchema>;

/**
 * Does the resolved name plausibly answer the phrase that was typed?
 *
 * Deliberately generous and deliberately structural: a resolution counts as
 * answering the phrase when one contains the other as whole words. "hong kong"
 * answers "Hong Kong"; "Hong Kong Island" answers "hong kong". A town whose
 * name shares nothing with "inland alaska" does not, no matter how confident
 * the geocoder was — and that is the case where the traveller's own words win.
 */
export function labelAnswersPhrase(rawText: string, label: string): boolean {
  const phrase = normalizeDestinationQuery(rawText);
  const resolved = normalizeDestinationQuery(label);
  if (!phrase || !resolved) return false;
  if (phrase === resolved) return true;
  // Split on anything that is not a letter or a digit, so a comma in
  // "Kyoto, Japan" is punctuation rather than part of the city's name.
  const words = (value: string) => value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const contains = (haystack: string[], needle: string[]) =>
    needle.length > 0 &&
    haystack.some((_, index) => needle.every((word, offset) => haystack[index + offset] === word));
  return contains(words(resolved), words(phrase)) || contains(words(phrase), words(resolved));
}

/**
 * More than one place in one phrase.
 *
 * A comma, a slash, an ampersand or the word "and" between two substantial
 * fragments. Punctuation and one conjunction, no gazetteer involved — which is
 * why a comma that is only a qualifier ("Paris, France") has to survive it, and
 * does: the second fragment is checked for being a *place-sized* phrase rather
 * than a country qualifier only in the sense that both sides must be non-empty,
 * so the classifier treats "Paris, France" as multi-area only when nothing
 * resolved it first. A resolved single row always wins over this heuristic.
 */
export function phraseNamesSeveralPlaces(rawText: string): boolean {
  const parts = rawText
    .split(/\s*(?:,|\/|&|\band\b|\bthen\b|\bplus\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 && parts.every((part) => part.length >= 3);
}

export interface DestinationIntentInput {
  rawText: string;
  /** The row the traveller pointed at, when they pointed at one. */
  selected?: SelectedDestination | null;
  /** Whatever the resolver made of the text. Enriches; never gates. */
  resolution?: DestinationResolution | null;
  now: Date;
}

/**
 * Build the intent from whatever evidence exists, in that order of authority.
 *
 * A traveller's own selection outranks a resolution, a resolution outranks
 * silence, and silence is still a usable intent. Nothing in here can throw and
 * nothing in here can return null: the first question of the product must not
 * be answerable only by people whose phrasing happens to be in a catalogue.
 */
export function buildDestinationIntent(input: DestinationIntentInput): DestinationIntent {
  const rawText = input.rawText.trim();
  const normalizedText = normalizeDestinationQuery(rawText) || rawText.toLowerCase();
  const recordedAt = input.now.toISOString();
  const base = {
    schemaVersion: DESTINATION_INTENT_VERSION,
    rawText,
    normalizedText,
    recordedAt,
  } as const;

  const selected = input.selected ?? null;
  if (selected) {
    /*
     * They pointed at a row. There is nothing to interpret, and the label is
     * the qualified name because that is what they saw when they pointed.
     */
    return destinationIntentSchema.parse({
      ...base,
      /*
       * The display name rather than the qualified one. This label is what the
       * product *calls* the destination — on screen, in the composition task
       * and in every place query built from it — and "Kyoto, Japan" is a
       * disambiguation, not a name. The qualified form is still on the anchor
       * and still travels to the model beside it.
       */
      interpretedLabel: selected.displayName,
      interpretationType: TYPE_FROM_FEATURE[selected.featureType] ?? 'locality',
      countries: selected.countryCode ? [selected.countryCode.toUpperCase()] : [],
      anchor: {
        label: selected.displayName,
        featureType: selected.featureType,
        center: selected.center,
        ...(selected.bounds ? { bounds: selected.bounds } : {}),
        entryId: selected.entryId,
      },
      center: selected.center,
      ...(selected.bounds ? { bounds: selected.bounds } : {}),
      confidence: 'high',
      sources: ['traveller_text', 'traveller_selection'],
      ambiguities: [],
    });
  }

  const resolution = input.resolution ?? null;
  const candidates = resolution?.candidates ?? [];
  const countries = [
    ...new Set(
      candidates
        .map((candidate) => candidate.countryCode?.toUpperCase())
        .filter((code): code is string => typeof code === 'string' && code.length === 2),
    ),
  ];
  const chosen =
    resolution && resolution.unambiguousCandidateId
      ? candidates.find((candidate) => candidate.id === resolution.unambiguousCandidateId)
      : candidates.length === 1
        ? candidates[0]
        : undefined;

  if (!chosen) {
    /*
     * Nothing single came back. The phrase is still the destination — it is a
     * lead for the composition, and the model is far better at "inland Alaska"
     * than any gazetteer is. The countries the candidates agreed on are kept,
     * because that much *is* evidence.
     */
    return destinationIntentSchema.parse({
      ...base,
      interpretedLabel: rawText,
      interpretationType: phraseNamesSeveralPlaces(rawText)
        ? 'multi_area'
        : candidates.length > 1
          ? 'descriptive_area'
          : resolution
            ? 'descriptive_area'
            : 'unresolved',
      countries,
      confidence: 'low',
      sources: resolution ? ['traveller_text', 'resolution'] : ['traveller_text'],
      ambiguities: resolution?.ambiguityReasons ?? [],
    });
  }

  /*
   * One candidate. Whether it gets to *name* the destination depends on
   * whether it answers the phrase: a row called something the traveller never
   * wrote becomes the anchor, and their words stay the label. This is the
   * single line that stops a broad phrase being silently narrowed to a city.
   */
  const answers = labelAnswersPhrase(rawText, chosen.qualifiedName ?? chosen.displayName) || labelAnswersPhrase(rawText, chosen.displayName);
  return destinationIntentSchema.parse({
    ...base,
    interpretedLabel: answers ? chosen.displayName : rawText,
    interpretationType: answers
      ? BREADTH_TO_TYPE[chosen.breadth]
      : phraseNamesSeveralPlaces(rawText)
        ? 'multi_area'
        : 'descriptive_area',
    countries: chosen.countryCode ? [chosen.countryCode.toUpperCase()] : countries,
    anchor: {
      label: chosen.displayName,
      featureType: FEATURE_FROM_BREADTH[chosen.breadth],
      center: chosen.center,
      ...(chosen.bounds ? { bounds: chosen.bounds } : {}),
    },
    center: chosen.center,
    ...(chosen.bounds ? { bounds: chosen.bounds } : {}),
    confidence: answers ? (chosen.confidence.level === 'high' ? 'high' : 'medium') : 'low',
    sources: ['traveller_text', 'resolution'],
    ambiguities: resolution?.ambiguityReasons ?? [],
  });
}

/** A resolver's breadth, read back as an interpretation type. */
const BREADTH_TO_TYPE: Record<ScopeBreadth, DestinationInterpretationType> = {
  multi_country: 'multi_area',
  country: 'administrative_area',
  region: 'administrative_area',
  subregion: 'administrative_area',
  city: 'locality',
  local: 'locality',
};

/** And as a feature type, for the anchor. Coarse on purpose. */
const FEATURE_FROM_BREADTH: Record<ScopeBreadth, DestinationFeatureType> = {
  multi_country: 'other',
  country: 'country',
  region: 'region',
  subregion: 'county',
  city: 'city',
  local: 'district',
};
