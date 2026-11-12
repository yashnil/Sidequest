/**
 * THE PRINTED GUIDE, AS DATA.
 *
 * `assembleGuide` turns a finished plan into this shape and the print route
 * renders it; nothing on the page reads the itinerary directly. Keeping the
 * decisions here — what each variant carries, which sentence is said once and
 * where, what the public copy may never hold — makes them testable without a
 * browser, and keeps the components dumb enough that a layout change cannot
 * quietly change what a stranger can read.
 */

export const GUIDE_VARIANTS = ['compact', 'complete'] as const;
export type GuideVariant = (typeof GUIDE_VARIANTS)[number];
export type GuideAudience = 'owner' | 'public';

export function guideVariantOf(value: string | null | undefined): GuideVariant {
  return value === 'complete' ? 'complete' : 'compact';
}

export const GUIDE_VARIANT_LABELS: Record<GuideVariant, { title: string; blurb: string }> = {
  compact: {
    title: 'Compact travel itinerary',
    blurb: 'The route, every day on a page or less, where you sleep, what to book and the numbers to keep.',
  },
  complete: {
    title: 'Complete travel guide',
    blurb: 'Everything in the compact copy, plus day maps, photographs, backups, packing and the planning notes.',
  },
};

export interface GuidePhoto {
  src: string;
  alt: string;
  /** The credit line, in the words the licence requires. Always printed. */
  credit: string;
  /** Whether the frame may crop it (`imageCropPolicy`); a share-alike crop carries its notice in `credit`. */
  crop: boolean;
}

export interface GuideMapPoint {
  lat: number;
  lng: number;
  /** "1", "2" … for stops; a letter for bases. */
  label: string;
  name: string;
  kind: 'stop' | 'base';
}

export type GuideLineStyle = 'measured' | 'estimated' | 'unmeasured' | 'rail' | 'boat' | 'flight' | 'trail';

export interface GuideMapLine {
  points: { lat: number; lng: number }[];
  style: GuideLineStyle;
}

export interface GuideMap {
  points: GuideMapPoint[];
  lines: GuideMapLine[];
  /** Stops the plan names but has no position for; said under the map, never drawn. */
  unplaced: number;
}

export type GuideItemKind = 'stop' | 'meal' | 'travel' | 'rest' | 'free';

export interface GuideItem {
  kind: GuideItemKind;
  /** A wall-clock time ("09:30"), a part of the day ("Morning"), or null. */
  time: string | null;
  approx: boolean;
  title: string;
  /** One sentence at most. */
  detail?: string;
  duration?: string;
  /** The stop's number on the day map, when it has a position. */
  pin?: string;
  /** "Book ahead", "Timed entry" … when the stop needs arranging. */
  flag?: string;
}

export interface GuideDay {
  number: number;
  isoDate: string;
  weekday: string;
  dateLabel: string;
  base: string;
  /** Set on a day that changes where you sleep. */
  move?: { from: string; to: string };
  theme: string;
  intensity: 'Light' | 'Moderate' | 'Full';
  items: GuideItem[];
  notes: string[];
  backup?: string;
  photo?: GuidePhoto;
  map?: GuideMap;
  /** Total travel time for the day, as a phrase, when there is any. */
  travel?: string;
}

export interface GuideStay {
  name: string;
  area?: string;
  nights: number;
  dates: string;
  why?: string;
  /** Owner only: what is booked there. */
  booked?: string;
  /** Owner only. */
  status?: 'Booked' | 'To book';
}

export interface GuideBooking {
  title: string;
  when?: string;
  action: string;
  priority: 'Essential' | 'Recommended' | 'Optional';
  deadline?: string;
  /** Owner only. */
  status?: string;
}

export interface GuideLink {
  label: string;
  note?: string;
  url: string;
  /** Short, typeable text printed beside the QR code; never the raw URL. */
  short?: string;
}

export interface GuideCountry {
  name: string;
  emergency: string;
  emergencyNotes?: string;
  drivingSide: 'left' | 'right';
  currency: string;
  plugs: string[];
  voltage: number;
  callingCode: string;
  languages: string[];
}

export interface GuideModel {
  variant: GuideVariant;
  audience: GuideAudience;
  /** BCP 47 tag for place names the destination writes in its own script. */
  placeLang?: string;
  identity: {
    title: string;
    thesis?: string;
    dateRange: string;
    dayCount: number;
    nightCount: number;
    route: string[];
    /** Owner only. */
    party?: string;
    timeZone?: { id: string; abbreviation: string };
    generatedOn: string;
  };
  cover: { photo?: GuidePhoto };
  glance: {
    map?: GuideMap;
    stays: GuideStay[];
    highlights: { name: string; dayNumber: number; why?: string }[];
    getAround?: string;
    /** Warnings true on most days, said once here rather than on every day. */
    throughout: string[];
    figures: { label: string; value: string }[];
  };
  days: GuideDay[];
  stays: GuideStay[];
  transport: { headline?: string; points: string[]; moves: { day: number; from: string; to: string; how: string }[] };
  bookings: GuideBooking[];
  prep: {
    beforeYouGo: string[];
    packing: { category: string; items: string[] }[];
  };
  reference: {
    country?: GuideCountry;
    links: GuideLink[];
  };
  appendix?: {
    planning: string[];
    budget?: { currency: string; lines: { label: string; range: string; basis: string }[]; total: string; note: string };
    positions: { day: number; name: string; coordinates: string }[];
    skip: { name: string; reason: string }[];
  };
  credits: { photos: string[]; data: string[] };
}
