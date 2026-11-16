import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withdrawLocalityOutliers } from './placement';

type Pos = { coordinates: { lat: number; lng: number } };
const at = (lat: number, lng: number) => ({ coordinates: { lat, lng } }) as Pos;

function run(rows: { key: string; locality: string; pos: Pos | null }[], country?: string) {
  const proposal = { candidates: rows.map((r) => ({ key: r.key, locality: r.locality })) } as unknown as Parameters<typeof withdrawLocalityOutliers>[0];
  const positions = new Map(rows.map((r) => [r.key, r.pos] as const)) as unknown as Parameters<typeof withdrawLocalityOutliers>[1];
  return withdrawLocalityOutliers(proposal, positions, country);
}

describe('locality consensus — a candidate far from every other candidate of its own place is misplaced', () => {
  it('the recorded Tanzania scan: the Arusha tour offices standing in for the Serengeti and Ngorongoro are withdrawn, the park corners kept', () => {
    const recorded = JSON.parse(readFileSync(join(__dirname, '../planning/acceptance/fixtures/tanzania/scan-2026-11-10.json'), 'utf8')) as { candidates: { name: string; locality: string; recorded: { lat: number; lng: number } | null }[] };
    const rows = recorded.candidates.map((c) => ({ key: c.name, locality: c.locality, pos: c.recorded ? at(c.recorded.lat, c.recorded.lng) : null }));
    const { withdrawn } = run(rows, 'Tanzania');
    expect(withdrawn).toContain('Serengeti sunrise game drive');
    expect(withdrawn).toContain('Hot air balloon safari');
    expect(withdrawn).toContain('Maasai cultural village visit');
    /* The far west of the same park is still the park. */
    expect(withdrawn).not.toContain('Grumeti River crossing points');
    expect(withdrawn).not.toContain('Retina Hippo Pool');
    expect(withdrawn).not.toContain('Ngorongoro Crater floor game drive');
  });

  it('an unseen analog: a pan safari whose night drive landed at the capital’s booking office', () => {
    const { withdrawn } = run([
      { key: 'okaukuejo', locality: 'Etosha, Okaukuejo', pos: at(-19.18, 15.92) },
      { key: 'halali', locality: 'Central Etosha', pos: at(-19.03, 16.47) },
      { key: 'namutoni', locality: 'Eastern Etosha', pos: at(-18.81, 16.94) },
      { key: 'night-drive', locality: 'Etosha', pos: at(-22.56, 17.08) },
    ], 'Namibia');
    expect(withdrawn).toEqual(['night-drive']);
  });

  it('a compact city keeps everything; a group of two proves nothing; generic words never form a group', () => {
    expect(run([
      { key: 'a', locality: 'Kyoto, Higashiyama', pos: at(34.99, 135.78) },
      { key: 'b', locality: 'Kyoto, Arashiyama', pos: at(35.01, 135.67) },
      { key: 'c', locality: 'Kyoto', pos: at(35.04, 135.73) },
      { key: 'd', locality: 'Northern Kyoto', pos: at(35.12, 135.77) },
    ]).withdrawn).toEqual([]);
    expect(run([
      { key: 'a', locality: 'Ubud', pos: at(-8.51, 115.26) },
      { key: 'b', locality: 'Ubud', pos: at(-8.0, 110.0) },
    ]).withdrawn).toEqual([]);
    expect(run([
      { key: 'a', locality: 'National Park', pos: at(10, 10) },
      { key: 'b', locality: 'National Park', pos: at(10.1, 10.1) },
      { key: 'c', locality: 'National Park', pos: at(10.2, 10) },
      { key: 'd', locality: 'National Park', pos: at(20, 20) },
    ]).withdrawn).toEqual([]);
  });

  it('the far end of a route strung along localities that share a name is a route, not a stray', () => {
    expect(run([
      { key: 'a', locality: 'Lofoten, Reine', pos: at(67.93, 13.09) },
      { key: 'b', locality: 'Lofoten, Leknes', pos: at(68.15, 13.61) },
      { key: 'c', locality: 'Lofoten, Henningsvær', pos: at(68.15, 14.2) },
      { key: 'd', locality: 'Lofoten, Svolvær', pos: at(68.23, 14.57) },
      { key: 'e', locality: 'Lofoten, Stokmarknes', pos: at(68.56, 14.91) },
    ]).withdrawn).toEqual([]);
  });

  it('when the group itself disagrees, nobody is withdrawn', () => {
    expect(run([
      { key: 'a', locality: 'Highlands', pos: at(57, -5) },
      { key: 'b', locality: 'Highlands', pos: at(57, -2) },
      { key: 'c', locality: 'Highlands', pos: at(-6, 145) },
      { key: 'd', locality: 'Highlands', pos: at(-6, 146) },
    ]).withdrawn).toEqual([]);
  });
});
