import type { CostLevel, PhysicalIntensity } from '@sidequest/core';

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function formatCost(level: CostLevel): string {
  return (['Free', 'Cheap', 'Moderate', 'Pricey'] as const)[level] ?? 'Unknown';
}

export function formatIntensity(intensity: PhysicalIntensity): string {
  return {
    none: 'No effort',
    easy: 'Easy',
    moderate: 'Moderate effort',
    strenuous: 'Strenuous',
  }[intensity];
}

export function formatDistance(km: number): string {
  return km < 1 ? 'On the doorstep' : `${Math.round(km)} km`;
}

export function formatDateRange(start: string, end: string): string {
  const format = (value: string) =>
    new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  return `${format(start)} – ${format(end)}`;
}
