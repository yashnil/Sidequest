import {
  DAYLIGHT_END_BUFFER_MINUTES,
  findDayWeather,
  findSolarDay,
  findWeatherLocationForPlace,
  formatMinuteOfDay,
  type ItineraryDay,
  type ValidationIssue,
} from '@sidequest/core';
import type { ValidationInput } from './validate';

/**
 * The weather and daylight half of the check.
 *
 * Same reasoning as its transport and hours counterparts: the scheduler already
 * refuses to build most of this, and "the builder is careful" is an assumption
 * rather than a guarantee. What is different here is the severity split, and it
 * is the most important decision in the file.
 *
 * **Errors** — two, and both are facts rather than opinions:
 *   - a signed daylight-only visit scheduled outside the light;
 *   - a typed weather requirement of the place contradicted on its day.
 * Both block the plan, because both describe something that cannot be done
 * rather than something that would be unpleasant.
 *
 * **Everything else is a caution.** A forecast is a model's opinion about
 * Thursday. Blocking somebody's trip on one — refusing to show them a plan
 * because a number said 62% — would be overreach, and it would train them to
 * ignore the warnings that matter. A plan built on a poor forecast is "ready,
 * with cautions": it works, and there are things worth reading first.
 *
 * A plan resting entirely on historical patterns can also be Ready with
 * cautions, provided every surface says that is what it is. That is the whole
 * point of keeping the evidence kind on the record.
 */
export function validateDayWeather(
  day: ItineraryDay,
  input: ValidationInput,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { weather, placesById } = input;
  const now = input.now;

  if (!day.weather.attribution) {
    issues.push({
      code: 'weather_evidence_inconsistent',
      severity: 'warning',
      message: `Day ${day.dayNumber} shows weather with no attribution. Rebuild this plan.`,
      dayNumber: day.dayNumber,
    });
  }

  if (day.weather.evidence === 'unavailable' && day.totals.activityMinutes > 0) {
    issues.push({
      code: 'weather_unavailable',
      severity: 'warning',
      message: `We could not get weather for day ${day.dayNumber}, so nothing on it was placed against a forecast. Check conditions yourself before you commit to it.`,
      dayNumber: day.dayNumber,
    });
  }

  // A day whose block claims a forecast must carry the two things only a
  // forecast has. Without this, a historical pattern relabelled by a bug would
  // render as a prediction, which is the failure this slice exists to prevent.
  if (day.weather.evidence === 'forecast') {
    if (!day.weather.fetchedAt) {
      issues.push({
        code: 'historical_pattern_used_as_forecast',
        severity: 'error',
        message: `Day ${day.dayNumber} is presented as a forecast but records no time it was read. Rebuild this plan.`,
        dayNumber: day.dayNumber,
      });
    } else if (now && day.weather.staleAfterMinutes) {
      const age = now.getTime() - Date.parse(day.weather.fetchedAt);
      if (age > day.weather.staleAfterMinutes * 60_000) {
        issues.push({
          code: 'weather_evidence_stale',
          severity: 'warning',
          message: `The forecast behind day ${day.dayNumber} was read more than ${Math.round(day.weather.staleAfterMinutes / 60)} hours ago. Rebuild to check it against the latest one.`,
          dayNumber: day.dayNumber,
        });
      }
    }
  }

  const scheduled = new Set<string>();

  for (const item of day.items) {
    if (item.kind !== 'activity' || !item.placeId) continue;
    scheduled.add(item.placeId);
    const place = placesById.get(item.placeId);
    const name = place?.name ?? item.title;

    // --- Daylight: the one hard weather-adjacent constraint ----------------
    if (item.daylightOnly && item.daylight) {
      const latestEnd = item.daylight.sunsetMinute - DAYLIGHT_END_BUFFER_MINUTES;
      if (item.startMinute < item.daylight.sunriseMinute || item.endMinute > latestEnd) {
        issues.push({
          code: 'scheduled_outside_daylight',
          severity: 'error',
          message: `${name} is signed for daylight use and day ${day.dayNumber} has you there ${formatMinuteOfDay(item.startMinute)}–${formatMinuteOfDay(item.endMinute)}, outside the ${formatMinuteOfDay(item.daylight.sunriseMinute)}–${formatMinuteOfDay(latestEnd)} the light allows.`,
          dayNumber: day.dayNumber,
          placeId: item.placeId,
        });
      }
    }

    if (!item.weather) continue;

    // --- The evidence on the item against the dataset it claims to come from
    const location = findWeatherLocationForPlace(weather, item.placeId);
    if (!location) {
      issues.push({
        code: 'weather_evidence_inconsistent',
        severity: 'error',
        message: `Day ${day.dayNumber} quotes weather against ${name}, which no weather point covers. Rebuild this plan.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
      continue;
    }
    if (location.id !== item.weather.locationId) {
      issues.push({
        code: 'weather_evidence_inconsistent',
        severity: 'error',
        message: `Day ${day.dayNumber} quotes ${item.weather.locationLabel}'s weather against ${name}, which now belongs to ${location.label}. Rebuild this plan.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
      continue;
    }

    const evidence = findDayWeather(weather, location.id, day.date);
    if (evidence && evidence.kind !== item.weather.evidence) {
      issues.push({
        code: 'historical_pattern_used_as_forecast',
        severity: 'error',
        message: `Day ${day.dayNumber} labels ${name}'s weather as a ${item.weather.evidence.replace('_', ' ')} when the data behind it is a ${evidence.kind.replace('_', ' ')}. Rebuild this plan.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
    }

    if (item.weather.suitability === 'incompatible') {
      issues.push({
        code: 'weather_incompatible_scheduled',
        severity: 'error',
        message: `${name} is scheduled on day ${day.dayNumber} and cannot be done in that day's weather. ${item.weather.summary}`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
    } else if (item.weather.suitability === 'poor') {
      issues.push({
        code: 'poor_weather_scheduled',
        severity: 'warning',
        message: `${name} is on day ${day.dayNumber} and the weather works against it. ${item.weather.summary} This was the best day for it once everything else was fitted in.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
    }

    // A daylight-only visit whose solar record disappeared between building and
    // reading is a plan asserting something it can no longer support.
    if (item.daylightOnly && item.daylight && !findSolarDay(weather, location.id, day.date)) {
      issues.push({
        code: 'weather_evidence_inconsistent',
        severity: 'error',
        message: `Day ${day.dayNumber} states sunrise and sunset for ${name} that the current data does not hold. Rebuild this plan.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
    }
  }

  issues.push(...validateBackups(day, input, scheduled));

  return issues;
}

/**
 * Every promise a backup makes, checked against the data that has to keep it.
 *
 * A backup is offered to somebody who will act on it with no slack left, so each
 * of these is a way of making the day worse rather than better: sending them to
 * a locked door, to a road they told us they would not drive, to a place they
 * already said no to, or to the same exposed afternoon in a different car park.
 */
function validateBackups(
  day: ItineraryDay,
  input: ValidationInput,
  scheduledToday: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { placesById, hours } = input;
  const seen = new Set<string>();

  for (const backup of day.weather.backups) {
    if (seen.has(backup.placeId)) {
      issues.push({
        code: 'backup_not_usable',
        severity: 'warning',
        message: `Day ${day.dayNumber} offers ${backup.name} as a fallback twice.`,
        dayNumber: day.dayNumber,
        placeId: backup.placeId,
      });
      continue;
    }
    seen.add(backup.placeId);

    if (scheduledToday.has(backup.placeId)) {
      issues.push({
        code: 'backup_not_usable',
        severity: 'warning',
        message: `Day ${day.dayNumber} offers ${backup.name} as a fallback and already visits it.`,
        dayNumber: day.dayNumber,
        placeId: backup.placeId,
      });
    }

    const place = placesById.get(backup.placeId);
    if (!place) {
      issues.push({
        code: 'backup_not_usable',
        severity: 'warning',
        message: `Day ${day.dayNumber} offers a fallback we hold no record for.`,
        dayNumber: day.dayNumber,
        placeId: backup.placeId,
      });
      continue;
    }

    if (!place.weather.poorWeatherBackup && place.weather.exposure !== 'indoor') {
      issues.push({
        code: 'backup_not_usable',
        severity: 'warning',
        message: `Day ${day.dayNumber} offers ${place.name} as a fallback, and it is no better in this weather than what it replaces.`,
        dayNumber: day.dayNumber,
        placeId: backup.placeId,
      });
    }

    const calendar = hours.calendars.find((entry) => entry.placeId === backup.placeId);
    if (!calendar) {
      issues.push({
        code: 'backup_not_usable',
        severity: 'warning',
        message: `Day ${day.dayNumber} offers ${place.name} as a fallback with no opening hours on record.`,
        dayNumber: day.dayNumber,
        placeId: backup.placeId,
      });
    }
  }

  // Not having a fallback is a legitimate outcome and is reported as one. What
  // would not be legitimate is silence: a day the weather threatens, with
  // nothing offered and nothing said, reads as a day nobody looked at.
  const threatened = day.weather.cautions.length > 0;
  if (threatened && day.weather.backups.length === 0 && !day.weather.noBackupReason) {
    issues.push({
      code: 'no_weather_backup',
      severity: 'warning',
      message: `Day ${day.dayNumber} has weather working against it and no fallback recorded.`,
      dayNumber: day.dayNumber,
    });
  }

  return issues;
}
