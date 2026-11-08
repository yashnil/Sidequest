import { describe, expect, it } from 'vitest';
import { validateCompiledRegion } from '../region/source';
import { scanBaseUpgrade } from './base-staleness';
import { TENERIFE_BASES, tenerifeStoredScan } from './tenerife-fixture.test-support';

describe('scanBaseUpgrade — whether a stored scan would get fewer bases today', () => {
  it('flags the three-hotel island trip as improvable', () => {
    const region = validateCompiledRegion(tenerifeStoredScan());
    expect(new Set(region.basePortfolio!.bases.map((b) => b.baseId)).size).toBe(3);
    const upgrade = scanBaseUpgrade(region);
    expect(upgrade).not.toBeNull();
    expect(upgrade!.storedBaseCount).toBe(3);
    expect(upgrade!.currentBaseCount).toBeLessThan(3);
    expect(upgrade!.storedBaseNames).toEqual(expect.arrayContaining(Object.values(TENERIFE_BASES).map((b) => b.name)));
  });

  it('says nothing about a trip already on one base', () => {
    const region = tenerifeStoredScan();
    const one = { ...region, basePortfolio: { ...region.basePortfolio!, bases: [{ ...region.basePortfolio!.bases[0]!, toDate: '2026-12-09', nights: 8 }] } };
    expect(scanBaseUpgrade(one)).toBeNull();
  });

  it('says nothing when the current rule keeps every stored base', () => {
    const region = tenerifeStoredScan();
    /* Each town's own sights stay close and everything else is far: every base earns its place. */
    const far = { ...region, travelTimes: { ...region.travelTimes, minutes: region.travelTimes.minutes.map((row) => row.map((m) => (m <= 40 ? m : 150))) } };
    expect(scanBaseUpgrade(far)).toBeNull();
  });

  it('ignores artifacts that are not discovery scans', () => {
    expect(scanBaseUpgrade({ ...tenerifeStoredScan(), compilerVersion: 'overture/9' })).toBeNull();
  });
});
