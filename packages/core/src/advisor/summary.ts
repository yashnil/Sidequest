import type { TripComposerAnswers } from '../schemas/composer';
import { ADVENTURE_LABELS, FOCUS_LABELS, REFINEMENT_LABELS } from './answers';
import { monthsLabel } from './advise';
import { originPointFromText } from './origin';
import { COUNTRY_GROUPS } from './parse';
import { focusOf, seasonMonthsForTraveller } from './profile';
import type { QuestionId } from './questions';
import { REGION_GROUPS, REGION_GROUP_LABELS } from './questions';

/**
 * "WHAT WE KNOW SO FAR", AS CHIPS.
 *
 * The forming profile the interview shows beside each question. Derived from
 * the stored answers every time, so it can never disagree with what the ranker
 * reads, and each chip names the question that changes it.
 */
export interface ProfileChip {
  question: QuestionId;
  label: string;
  /** True when Sidequest assumed it rather than the traveller saying it. */
  assumed?: boolean;
}

export function profileChips(answers: TripComposerAnswers): ProfileChip[] {
  const chips: ProfileChip[] = [];
  const discovery = answers.discovery;
  const origin = originPointFromText(answers.origin, answers.originCountry);
  const focus = focusOf(answers);
  if (focus.length > 0) {
    chips.push({ question: 'focus', label: focus.map((key, index) => (index === 0 && discovery?.focusRanked && focus.length > 1 ? `${FOCUS_LABELS[key]} first` : FOCUS_LABELS[key])).join(' · ') });
  }
  const dates = answers.dates;
  if (dates.mode === 'season' && dates.season) {
    chips.push({ question: 'when', label: `${dates.season[0]!.toUpperCase()}${dates.season.slice(1)} · ${monthsLabel(seasonMonthsForTraveller(dates.season, origin))}`, assumed: !origin });
  } else if (dates.mode === 'month' && dates.month) chips.push({ question: 'when', label: monthsLabel([dates.month]) });
  else if (dates.mode === 'months' && dates.months?.length) chips.push({ question: 'when', label: monthsLabel(dates.months) });
  else if (dates.startDate) chips.push({ question: 'when', label: dates.endDate ? `${dates.startDate} → ${dates.endDate}` : dates.startDate });
  else if (dates.mode === 'flexible' && dates.wantsRecommendation) chips.push({ question: 'when', label: 'Any time' });

  const duration = answers.duration;
  if (duration.mode === 'fixed' && duration.nights) chips.push({ question: 'length', label: `${duration.nights} nights` });
  else if (duration.mode === 'range' && duration.minNights && duration.maxNights) chips.push({ question: 'length', label: `${duration.minNights}–${duration.maxNights} nights` });
  else if (duration.wantsRecommendation) chips.push({ question: 'length', label: 'Length flexible' });

  if (discovery?.adventure) chips.push({ question: 'adventure', label: ADVENTURE_LABELS[discovery.adventure] });
  else if (answers.outdoorIntensity) chips.push({ question: 'adventure', label: { gentle: 'Gentle', moderate: 'Active', strenuous: 'Strenuous' }[answers.outdoorIntensity] });
  if (answers.budget && answers.budget !== 'unstated') chips.push({ question: 'budget', label: { budget: 'Budget-conscious', mid_range: 'Moderate budget', premium: 'Comfortable budget', luxury: 'Luxury' }[answers.budget] });
  if (answers.budget === 'unstated') chips.push({ question: 'budget', label: 'Budget flexible' });
  if (origin) chips.push({ question: 'reach', label: `From ${origin.label}` });
  if (answers.flightTolerance) chips.push({ question: 'reach', label: { short: 'Close to home', moderate: 'Within my region', long: 'Long-haul is fine', any: 'Anywhere' }[answers.flightTolerance] });
  if (discovery?.regions?.length) {
    const group = Object.entries(REGION_GROUPS).find(([, regions]) => regions.length === discovery.regions!.length && regions.every((region) => discovery.regions!.includes(region)));
    chips.push({ question: 'region', label: group ? REGION_GROUP_LABELS[group[0]]! : `${discovery.regions.length} regions` });
  }
  if (discovery?.countries?.length) {
    const named = COUNTRY_GROUPS.find(([, codes]) => codes.length === discovery.countries!.length && codes.every((code) => discovery.countries!.includes(code)));
    chips.push({ question: 'region', label: named ? named[2] : `${discovery.countries.length} countries` });
  }
  if (answers.children > 0) chips.push({ question: 'party', label: 'With children' });
  if (answers.travelerNeeds.includes('seniors_in_group')) chips.push({ question: 'party', label: 'Older travellers' });
  if (answers.travelerNeeds.includes('mobility_limited')) chips.push({ question: 'party', label: 'Limited mobility' });
  if (answers.transport === 'drive') chips.push({ question: 'getting_around', label: 'Happy to drive' });
  if (answers.transport === 'public_transport') chips.push({ question: 'getting_around', label: 'No car' });
  if (answers.crowdTolerance === 'avoid') chips.push({ question: 'crowds', label: 'Away from crowds' });
  if (answers.surpriseAppetite === 'surprise_me') chips.push({ question: 'novelty', label: 'Somewhere unexpected' });
  if (answers.surpriseAppetite === 'familiar') chips.push({ question: 'novelty', label: 'The classics' });
  if (answers.climatePreference && answers.climatePreference !== 'any') chips.push({ question: 'climate', label: { warm: 'Warm', mild: 'Mild', cold: 'Cool' }[answers.climatePreference] });
  if (discovery?.wildlifeKind && discovery.wildlifeKind !== 'any') chips.push({ question: 'wildlife_kind', label: { safari: 'Safari', marine: 'Marine life', birds: 'Birds' }[discovery.wildlifeKind] });
  if (discovery?.mountainStyle) chips.push({ question: 'mountain_style', label: { base_day_hikes: 'Day hikes from a base', hut_to_hut: 'Hut-to-hut', high_altitude: 'High and wild' }[discovery.mountainStyle] });
  if (discovery?.swimStyle && discovery.swimStyle !== 'either') chips.push({ question: 'swim', label: discovery.swimStyle === 'warm_sea' ? 'Warm sea' : 'Lake swimming' });
  for (const refinement of discovery?.refinements ?? []) chips.push({ question: 'focus', label: REFINEMENT_LABELS[refinement] });
  return chips;
}
