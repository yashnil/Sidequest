import {
  REGIONAL_EXPANSION_LABELS,
  type Interest,
  type InterestLevel,
} from '../schemas/common';
import type { TravelerProfile } from '../schemas/profile';

const LEVEL_WEIGHT: Record<InterestLevel, number> = {
  avoid: 0,
  low: 0.25,
  occasional: 0.5,
  frequent: 0.8,
  core: 1,
};

export interface PersonalityDimension {
  id: string;
  label: string;
  /** 0-100. A shape of the trip, not a measurement. */
  value: number;
}

export interface TripPersonality {
  headline: string;
  dimensions: PersonalityDimension[];
  traits: { label: string; value: string }[];
  topInterests: Interest[];
}

const DIMENSIONS: { id: string; label: string; interests: Interest[] }[] = [
  { id: 'outdoors', label: 'Outdoors', interests: ['hiking', 'easy_nature_walks', 'lakes_and_rivers'] },
  {
    id: 'scenery',
    label: 'Scenery',
    interests: ['scenic_viewpoints', 'scenic_drives', 'photography_golden_hour'],
  },
  {
    id: 'curiosity',
    label: 'Odd & geological',
    interests: ['geology_and_geothermal', 'hot_springs', 'stargazing'],
  },
  { id: 'culture', label: 'History', interests: ['history_and_culture'] },
  { id: 'food', label: 'Food & towns', interests: ['food_and_towns'] },
  { id: 'wildlife', label: 'Wildlife', interests: ['wildlife'] },
];

/**
 * A readable shape of the profile, shown back to the traveller so they can catch
 * a wrong answer before it quietly shapes the whole board.
 */
export function tripPersonality(profile: TravelerProfile, tripDays: number): TripPersonality {
  const dimensions = DIMENSIONS.map((dimension) => {
    const total = dimension.interests.reduce(
      (sum, interest) => sum + LEVEL_WEIGHT[profile.interests[interest] ?? 'low'],
      0,
    );
    return {
      id: dimension.id,
      label: dimension.label,
      value: Math.round((total / dimension.interests.length) * 100),
    };
  }).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  const topInterests = (Object.entries(profile.interests) as [Interest, InterestLevel][])
    .filter(([, level]) => LEVEL_WEIGHT[level] >= 0.8)
    .sort(
      (a, b) => LEVEL_WEIGHT[b[1]] - LEVEL_WEIGHT[a[1]] || a[0].localeCompare(b[0]),
    )
    .map(([interest]) => interest)
    .slice(0, 4);

  const mixWord =
    profile.discoveryMix === 'mostly_classics'
      ? 'headline-first'
      : profile.discoveryMix === 'balanced'
        ? 'a mix of famous and quiet'
        : profile.discoveryMix === 'mostly_hidden'
          ? 'hidden-gem leaning'
          : 'deep-cut';

  const lead = dimensions[0];
  const headline = `${lead && lead.value > 0 ? `${lead.label}-led` : 'Open-ended'}, ${mixWord}, ${profile.pace} pace over ${tripDays} ${tripDays === 1 ? 'day' : 'days'}.`;

  const traits: { label: string; value: string }[] = [
    { label: 'Pace', value: capitalize(profile.pace) },
    { label: 'Daily effort', value: capitalize(profile.dailyIntensity) },
    { label: 'Budget', value: budgetLabel(profile) },
    { label: 'Crowds', value: crowdLabel(profile) },
    {
      label: 'Getting around',
      value: profile.transport.willDrive
        ? `Driving, up to ${profile.transport.maxDailyTravelMinutes} min a day`
        : 'No car — town and trolley only',
    },
    { label: 'Range', value: REGIONAL_EXPANSION_LABELS[profile.regionalExpansion] },
    { label: 'Detour limit', value: `${profile.derived.effectiveDetourMinutes} min from base` },
  ];

  if (profile.accessibility.mobilityLimited) {
    traits.push({ label: 'Access', value: 'Low-effort terrain only' });
  }

  return { headline, dimensions, traits, topInterests };
}

function budgetLabel(profile: TravelerProfile): string {
  switch (profile.budgetStyle) {
    case 'budget':
      return 'Budget — free stops preferred';
    case 'midrange':
      return 'Mid-range';
    case 'premium':
      return 'Premium';
    case 'luxury':
      return 'Cost is not a filter';
  }
}

function crowdLabel(profile: TravelerProfile): string {
  switch (profile.crowdTolerance) {
    case 'avoid_crowds':
      return 'Route around them';
    case 'mild':
      return 'Some is fine';
    case 'dont_mind':
      return 'Not a factor';
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
