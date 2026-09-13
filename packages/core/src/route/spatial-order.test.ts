import { describe, expect, it } from 'vitest';
import { compileSpatialOrder, describeOrderReport, greatCircleKm, type OrderedStop } from './spatial-order';

/**
 * V10 §7 — THE ICELAND ORDERING FAILURES, PINNED.
 *
 * Every coordinate below is the real published location of the real place, so
 * what is asserted is a statement about Iceland's geography and not about a
 * synthetic world built to pass. The first case is reproduced from the founder's
 * own trip (`9c9c7fb8`, itinerary v8, day 3); the other two are the sequences
 * the brief names.
 */
const P = {
  reykjavik: { lat: 64.1460, lng: -21.9422 },
  keflavik: { lat: 63.9850, lng: -22.6056 },
  seljalandsfoss: { lat: 63.6156, lng: -19.9886 },
  skogafoss: { lat: 63.5321, lng: -19.5114 },
  solheimajokull: { lat: 63.5569, lng: -19.3028 },
  vik: { lat: 63.4187, lng: -19.0060 },
  hofn: { lat: 64.2539, lng: -15.2082 },
  skaftafell: { lat: 64.0704, lng: -16.9752 },
  kerid: { lat: 64.0413, lng: -20.8851 },
  selfoss: { lat: 63.9330, lng: -21.0000 },
  jokulsarlon: { lat: 64.0784, lng: -16.2306 },
  stykkisholmur: { lat: 65.0757, lng: -22.7288 },
  borgarnes: { lat: 64.5383, lng: -21.9224 },
  kirkjufell: { lat: 64.9271, lng: -23.3086 },
  thingvellir: { lat: 64.2822, lng: -21.0764 },
  geysir: { lat: 64.3167, lng: -20.2999 },
  gullfoss: { lat: 64.3271, lng: -20.1199 },
};

const stop = (name: string, coordinates: { lat: number; lng: number } | null, pinned?: string): OrderedStop => ({
  id: name.toLowerCase().replace(/\W+/g, '-'),
  name,
  coordinates,
  ...(pinned ? { pinned: true, pinnedReason: pinned } : {}),
});
const at = (name: string, coordinates: { lat: number; lng: number } | null) => ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, coordinates });

describe('the spatial-order compiler', () => {
  it('rejects Reykjavík → Skógafoss → Seljalandsfoss → Vík: Seljalandsfoss is en route', () => {
    const report = compileSpatialOrder({
      origin: at('Reykjavik', P.reykjavik),
      destination: at('Vík', P.vik),
      stops: [stop('Skógafoss', P.skogafoss), stop('Seljalandsfoss', P.seljalandsfoss), stop('Sólheimajökull', P.solheimajokull)],
    });
    expect(report.verdict).toBe('violation');
    expect(report.violations.some((v) => v.kind === 'reversal' && v.stopName === 'Seljalandsfoss')).toBe(true);
    expect(report.bestOrder).toEqual(['seljalandsfoss', 'sk-gafoss', 's-lheimaj-kull']);
    /* The trip as built: 219 km planned against 170 km best, a 29% excess. */
    expect(Math.round(report.plannedKm)).toBe(219);
    expect(Math.round(report.bestKm)).toBe(170);
    expect(report.excessFraction).toBeGreaterThan(0.25);
    expect(describeOrderReport(report, 3)).toContain('Seljalandsfoss');
  });

  it('accepts the same day once Seljalandsfoss comes first', () => {
    const report = compileSpatialOrder({
      origin: at('Reykjavik', P.reykjavik),
      destination: at('Vík', P.vik),
      stops: [stop('Seljalandsfoss', P.seljalandsfoss), stop('Skógafoss', P.skogafoss), stop('Sólheimajökull', P.solheimajokull)],
    });
    expect(report.verdict).toBe('coherent');
    expect(report.violations).toEqual([]);
    expect(describeOrderReport(report, 3)).toBeNull();
  });

  it('rejects Höfn → Selfoss → Skaftafell → Kerið → Selfoss: the day arrives and leaves again', () => {
    const report = compileSpatialOrder({
      origin: at('Höfn', P.hofn),
      destination: at('Selfoss', P.selfoss),
      stops: [stop('Selfoss town', P.selfoss), stop('Skaftafell', P.skaftafell), stop('Kerið crater', P.kerid)],
    });
    expect(report.verdict).toBe('violation');
    expect(report.violations.some((v) => v.kind === 'arrival_before_en_route' && v.stopName === 'Skaftafell')).toBe(true);
    expect(report.violations.some((v) => v.kind === 'duplicate_crossing')).toBe(true);
  });

  it('accepts Höfn → Jökulsárlón → Skaftafell → Kerið → Selfoss, the same ground in order', () => {
    /*
     * Written the other way round first, and the compiler refused it: driving
     * west out of Höfn you reach Jökulsárlón (−16.23) before Skaftafell
     * (−16.98), so "Skaftafell then Jökulsárlón" is itself a reversal. The
     * check earned its place by catching a geography error in its own test.
     */
    const report = compileSpatialOrder({
      origin: at('Höfn', P.hofn),
      destination: at('Selfoss', P.selfoss),
      stops: [stop('Jökulsárlón', P.jokulsarlon), stop('Skaftafell', P.skaftafell), stop('Kerið crater', P.kerid)],
    });
    expect(report.verdict).toBe('coherent');
  });

  it('rejects Stykkishólmur → Reykjavík → Borgarnes → Reykjavík: Borgarnes is passed on the way', () => {
    const report = compileSpatialOrder({
      origin: at('Stykkishólmur', P.stykkisholmur),
      destination: at('Reykjavik', P.reykjavik),
      stops: [stop('Reykjavík harbour', P.reykjavik), stop('Borgarnes', P.borgarnes)],
    });
    expect(report.verdict).toBe('violation');
    expect(report.violations.some((v) => v.kind === 'reversal' || v.kind === 'arrival_before_en_route')).toBe(true);
    expect(report.bestOrder).toEqual(['borgarnes', 'reykjav-k-harbour']);
  });

  it('does not judge a day whose base was never placed, and says which name is missing', () => {
    const report = compileSpatialOrder({
      origin: at('Reykjavik', P.reykjavik),
      destination: at('Vík', null),
      stops: [stop('Skógafoss', P.skogafoss), stop('Seljalandsfoss', P.seljalandsfoss)],
    });
    expect(report.verdict).toBe('unplaceable');
    expect(report.unplaced).toEqual(['Vík']);
    expect(describeOrderReport(report, 3)).toContain('Vík');
    /* The point of the verdict: silence would have made the Iceland defect invisible. */
    expect(report.violations).toEqual([]);
  });

  it('holds a pinned stop in place rather than optimising over a deliberate decision', () => {
    /* Kirkjufell at sunset is a decision distance may not override, even though it is 70 km back. */
    const report = compileSpatialOrder({
      origin: at('Stykkishólmur', P.stykkisholmur),
      destination: at('Borgarnes', P.borgarnes),
      stops: [stop('Kirkjufell', P.kirkjufell, 'sunset viewpoint'), stop('Borgarnes museum', P.borgarnes)],
    });
    expect(report.bestOrder[0]).toBe('kirkjufell');
  });

  it('leaves a tight urban day alone', () => {
    const report = compileSpatialOrder({
      origin: at('Reykjavik', P.reykjavik),
      destination: at('Reykjavik', P.reykjavik),
      stops: [stop('Hallgrímskirkja', { lat: 64.1418, lng: -21.9267 }), stop('Sun Voyager', { lat: 64.1476, lng: -21.9224 }), stop('Old Harbour', { lat: 64.1508, lng: -21.9410 })],
    });
    expect(report.verdict).toBe('coherent');
  });

  it('calls the Golden Circle loop coherent', () => {
    const report = compileSpatialOrder({
      origin: at('Selfoss', P.selfoss),
      destination: at('Selfoss', P.selfoss),
      stops: [stop('Þingvellir', P.thingvellir), stop('Geysir', P.geysir), stop('Gullfoss', P.gullfoss)],
    });
    expect(report.verdict).toBe('coherent');
  });

  it('measures the arrival gateway as the day-one origin', () => {
    const report = compileSpatialOrder({
      origin: at('Keflavík Airport', P.keflavik),
      destination: at('Reykjavik', P.reykjavik),
      stops: [stop('Hallgrímskirkja', { lat: 64.1418, lng: -21.9267 })],
    });
    expect(report.verdict).toBe('trivial');
    expect(Math.round(greatCircleKm(P.keflavik, P.reykjavik))).toBe(37);
  });
});
