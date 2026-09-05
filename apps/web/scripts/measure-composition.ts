import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());
import { readFileSync } from 'node:fs';
import path from 'node:path';

async function main() {
  const { SKELETON_GENERATE_INSTRUCTION, buildSkeletonTask, skeletonUntrustedPayload, tripSkeletonSchema } =
    await import('../src/lib/benchmark/baseline/skeleton');
  const { UNTRUSTED_POLICY } = await import('../src/lib/providers/anthropic').catch(() => ({ UNTRUSTED_POLICY: null }));
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  const { getTrip, getProfile } = await import('../src/lib/db/repository');
  const { getIntent } = await import('../src/lib/db/compiler-repository');
  const { buildHybridTripRequest } = await import('../src/lib/planning/hybrid-request');

  const TRIP_ID = '64bc0495-370f-42ad-950d-12d1c0a10317';
  const trip = getTrip(TRIP_ID)!;
  const profile = getProfile(TRIP_ID);
  const intent = getIntent(TRIP_ID);
  const request = buildHybridTripRequest({ trip, composer: intent?.composer ?? null, profile, now: new Date('2026-09-01T15:25:00Z') });

  const REPO = path.resolve(__dirname, '../../..');
  const packet = JSON.parse(readFileSync(path.join(REPO, '.claude-private/benchmark/iceland-skeleton-generation-2026-08-29/skeleton-evidence-packet.json'), 'utf8'));

  const untrusted = skeletonUntrustedPayload({ request, packet });
  const task = buildSkeletonTask({ request, packet });
  const schema = zodOutputFormat(tripSkeletonSchema).schema;

  const b = (v: unknown) => (typeof v === 'string' ? v.length : JSON.stringify(v).length);
  const t = (n: number) => Math.round(n / 4);

  const instrBytes = b(SKELETON_GENERATE_INSTRUCTION);
  const policyBytes = UNTRUSTED_POLICY ? b(UNTRUSTED_POLICY) : -1;
  const untrustedWire = JSON.stringify({ trust: 'untrusted', source: 'retrieved', payload: untrusted });
  const u = untrusted as { retrievedContent: { packet: Record<string, unknown> }; travellerOwnWords: unknown };
  const placesBytes = b(u.retrievedContent.packet.places);
  const clustersBytes = b(u.retrievedContent.packet.clusters);
  const basesBytes = b(u.retrievedContent.packet.baseCandidates);
  const travellerBytes = b(u.retrievedContent.packet.traveller);
  const ownWordsBytes = b(u.travellerOwnWords);

  console.log('=== CURRENT-CODE RECONSTRUCTION (saved 2026-08-29 packet, 43 places; live packet was slightly larger) ===');
  console.log(`instruction: ${instrBytes} B (~${t(instrBytes)} tok)`);
  console.log(`untrusted policy: ${policyBytes} B (~${t(policyBytes)} tok)`);
  console.log(`task: ${b(task)} B (~${t(b(task))} tok)`);
  console.log(`untrusted wire total: ${b(untrustedWire)} B (~${t(b(untrustedWire))} tok)`);
  console.log(`  travellerOwnWords: ${ownWordsBytes} B`);
  console.log(`  packet.places: ${placesBytes} B (~${t(placesBytes)} tok)  <-- dominant`);
  console.log(`  packet.clusters: ${clustersBytes} B`);
  console.log(`  packet.baseCandidates: ${basesBytes} B`);
  console.log(`  packet.traveller: ${travellerBytes} B`);
  console.log(`schema (grammar): ${b(schema)} B (~${t(b(schema))} tok)`);
  const total = instrBytes + (policyBytes > 0 ? policyBytes : 0) + b(task) + b(untrustedWire) + b(schema);
  console.log(`SUM (request-side text+schema): ${total} B (~${t(total)} tok)  | live recorded: requestBytes 33232, inputTokens 9363`);
  console.log(`request.taste.mustDo: ${JSON.stringify(request.taste.mustDo)}`);
  console.log(`request.taste.dislikes: ${JSON.stringify(request.taste.dislikes)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
