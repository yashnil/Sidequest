import type { TravelerNeed } from '@sidequest/core';

/**
 * RELEASE CANDIDATE — THE TRAVELLERS THE ITINERARY EVALUATION PLANS FOR.
 *
 * One dimension changes per case against the default traveller, so a difference
 * in the trip's structure can be read against the one answer that differed.
 * Each case is written as the questionnaire's own answers and the trip's own
 * party facts, and reaches the planner through `buildTravelerProfile` and
 * `buildCanonicalTripBuildInput` exactly as a real traveller's answers do.
 */
export interface ProfileCase {
  key: string;
  label: string;
  pace: 'slow' | 'balanced' | 'fast';
  /** The questionnaire's hotel-switching answer. */
  hotelMoves: 'stay_put' | 'move_once' | 'move_if_it_saves_time' | 'move_freely';
  car: boolean;
  children: number;
  needs: TravelerNeed[];
  /** Calendar days, when the case is about trip length; otherwise the board's own. */
  days?: number;
  /** The traveller's stated daily travel ceiling; otherwise the questionnaire default (150). */
  maxDailyTravelMinutes?: number;
}

const base: Omit<ProfileCase, 'key' | 'label'> = { pace: 'balanced', hotelMoves: 'move_if_it_saves_time', car: true, children: 0, needs: [] };

export const PROFILE_CASES: readonly ProfileCase[] = [
  { ...base, key: 'default', label: 'Balanced pace, a car, moves hotels when it saves time' },
  { ...base, key: 'pace-slow', label: 'Slow pace', pace: 'slow' },
  { ...base, key: 'pace-fast', label: 'Fast pace', pace: 'fast' },
  { ...base, key: 'hotels-stay-put', label: 'One base for the whole trip', hotelMoves: 'stay_put' },
  { ...base, key: 'hotels-move-once', label: 'Will change hotels once', hotelMoves: 'move_once' },
  { ...base, key: 'hotels-move-freely', label: 'Happy to move with the route', hotelMoves: 'move_freely' },
  { ...base, key: 'no-car', label: 'No car: public transport and walking', car: false },
  { ...base, key: 'family-young-children', label: 'A family with two young children', children: 2, needs: ['kids_under_12'] },
  { ...base, key: 'low-mobility', label: 'Someone with limited mobility in the group', needs: ['mobility_limited'] },
  { ...base, key: 'short-3-days', label: 'A three-day trip', days: 3 },
  { ...base, key: 'long-12-days', label: 'A twelve-day trip', days: 12 },
  { ...base, key: 'low-drive-limit', label: 'At most 90 minutes of travel a day', maxDailyTravelMinutes: 90 },
];
