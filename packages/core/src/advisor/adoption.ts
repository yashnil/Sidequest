/**
 * WHAT A CHOSEN REGION BECOMES WHEN IT IS PLANNED (audit pass, 2026-11).
 *
 * A pick enters planning as the phrase a traveller would have typed
 * (`resolveAs`). For a region whose `resolveAs` is one of its own towns — "Fes &
 * Chefchaouen" resolving as "Fes, Morocco", "Kyoto & Nara" as "Kyoto, Japan",
 * 48 curated regions in all — that phrase was a single city: the trip resolved
 * at city breadth, the journey became an urban single base, and a traveller who
 * chose a region and asked to move by train got ten nights in one riad.
 *
 * Here such a pick is planned as its own places — "Fes, Chefchaouen and Meknes,
 * Morocco" — the and-list-in-a-container shape the intent graph reads as parts
 * inside one country. The stays then decide whether one bed covers them or a
 * move is worth it; nothing forces a move. A region whose `resolveAs` is the
 * region itself ("Lofoten, Norway") is left exactly as it was, and so is a
 * city, and so is a pick whose country the bundled reference does not know
 * (it falls through to the geocoder as before). Only the pick's own data is
 * read; no place is named here.
 */
import { countryFromText } from '../reference/countries';

export interface AdoptablePick {
  kind: string;
  resolveAs: string;
  bases: readonly string[];
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase();
/** "San Pedro (Ambergris Caye)" → "San Pedro"; a base's own note is not part of its name. */
const bareName = (s: string) => s.replace(/\s*\([^)]*\)\s*/g, ' ').split(',')[0]!.trim();

export function adoptionPhrase(pick: AdoptablePick, nights: number): string {
  if (pick.kind === 'city' || pick.kind === 'town' || pick.bases.length < 2) return pick.resolveAs;
  const segments = pick.resolveAs.split(',').map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return pick.resolveAs;
  const head = fold(segments[0]!);
  const own = pick.bases.map(bareName).filter(Boolean);
  if (!own.some((b) => fold(b) === head)) return pick.resolveAs;
  /* The town the region resolved as leads; then the others in the curator's order. */
  const leading = own.find((b) => fold(b) === head)!;
  const ordered = [leading, ...own.filter((b) => fold(b) !== head)];
  const listed = [...new Map(ordered.map((b) => [fold(b), b] as const)).values()].slice(0, nights >= 6 ? 3 : 2);
  if (listed.length < 2) return pick.resolveAs;
  const country = segments[segments.length - 1]!;
  /* The closing country must be one the intent graph reads as a country; otherwise it would become a part of its own, and the pick is left as it was. */
  if (countryFromText(country)?.how !== 'name') return pick.resolveAs;
  const list = listed.length === 2 ? `${listed[0]} and ${listed[1]}` : `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}`;
  return `${list}, ${country}`;
}
