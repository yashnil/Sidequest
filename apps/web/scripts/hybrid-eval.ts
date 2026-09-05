/*
 * Phase 17 live evaluation driver — NOT part of the app build.
 *
 * Creates a trip row directly (bypassing the browser/composer UI) and runs it
 * through `buildHybridItinerary`, then writes the resulting plan/report/
 * metrics to a JSON file for inspection. Run with:
 *
 *   npx tsx apps/web/scripts/hybrid-eval.ts <destination> <startDate> <nights> <outFile>
 */
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

async function main() {
  const [destination, startDate, nightsRaw, outFile] = process.argv.slice(2);
  if (!destination || !startDate || !nightsRaw || !outFile) {
    console.error('Usage: hybrid-eval.ts <destination> <startDate YYYY-MM-DD> <nights> <outFile>');
    process.exit(1);
  }
  const nights = Number(nightsRaw);
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(start.getTime() + nights * 86_400_000);
  const endDate = end.toISOString().slice(0, 10);

  const { createTrip } = await import('../src/lib/db/repository');
  const { buildHybridItinerary } = await import('../src/lib/planning/hybrid');

  const trip = createTrip({
    mode: 'known_destination',
    destinationInput: destination,
    regionId: 'dynamic',
    startDate,
    endDate,
    arrivalTime: '15:00',
    departureTime: '10:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  });

  console.log(`Created trip ${trip.id} for ${destination}, ${startDate} -> ${endDate} (${nights} nights)`);
  console.log('Running the hybrid build...');
  const startedAt = Date.now();
  const result = await buildHybridItinerary(trip.id);
  const elapsedMs = Date.now() - startedAt;

  const fs = await import('node:fs');
  fs.writeFileSync(outFile, JSON.stringify({ tripId: trip.id, elapsedMs, result }, null, 2));

  if (!result.ok) {
    console.error('FAILED:', result.error);
    process.exit(1);
  }

  console.log(`OK in ${elapsedMs}ms. Days: ${result.plan?.days.length}. Written to ${outFile}`);
  console.log('Report counts:', result.report?.counts);
  console.log('Model calls:', result.metrics?.modelCalls, 'Repair calls:', result.metrics?.repairCalls);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
