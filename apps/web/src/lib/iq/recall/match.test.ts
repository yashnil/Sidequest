import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '@sidequest/core';
import { matchSubject, metresBetween } from './match';
import type { CanonicalSubject } from './fixtures/canonical-subjects';

/**
 * THE INSTRUMENT'S OWN INSTRUMENT.
 *
 * A recall report is only worth what its matcher is worth, and the matcher is
 * the one part of this evaluation that is not a production function. Every case
 * below is taken from a real stored pack, because the ways this can be wrong are
 * not hypothetical: a live artifact really does hold a ginkgo tree 91 m from a
 * temple, a neighbourhood polygon 139 m from a theme park, and an imperial
 * palace under a Vietnamese name.
 *
 * The cases are pairs. Each one has a *hit* the matcher must find and a *miss*
 * it must refuse, because a matcher that says yes to everything and a matcher
 * that says no to everything both pass a one-sided test.
 */

function record(overrides: Partial<SourceRecord> & Pick<SourceRecord, 'id' | 'name'>): SourceRecord {
  return {
    layerId: 'places',
    sourceId: overrides.id,
    alternateNames: [],
    coordinates: { lat: 0, lng: 0 },
    sourceCategory: 'museum',
    sourceCategoryPath: [],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { divisionIds: [] },
    attributes: {},
    sources: [],
    cellId: 'g-0-0',
    ...overrides,
  } as SourceRecord;
}

const TEMPLE: CanonicalSubject = {
  id: 'temple',
  name: 'Great Temple',
  aliases: ['大寺院'],
  kind: 'sacred_site',
  point: { lat: 35.7148, lng: 139.7967 },
  radiusMetres: 350,
  sourceEvidence: 'probed',
};

/** ~90 m north of the temple, which is where the real tree stands. */
const NEARBY = { lat: TEMPLE.point.lat + 0.0008, lng: TEMPLE.point.lng };

describe('subject matching', () => {
  it('finds the subject under a name nobody anticipated, by position and archetype', () => {
    const found = matchSubject(TEMPLE, [
      record({ id: 'a', name: 'Chùa lớn', sourceCategory: 'temple', coordinates: NEARBY }),
    ]);
    expect(found.tier).toBe('site');
    expect(found.record?.id).toBe('a');
  });

  it('refuses the tree standing outside it', () => {
    /*
     * The exact record from a live Tokyo pack: `浅草寺の神木・いちょう`, 91 m from
     * Sensō-ji, published by the terrain layer as a tree. A proximity-only
     * matcher scores this as the temple and turns a total acquisition failure
     * into a 6-of-16 success story.
     */
    const found = matchSubject(TEMPLE, [
      record({
        id: 'tree',
        name: 'Sacred ginkgo',
        layerId: 'land',
        sourceCategory: 'tree',
        coordinates: NEARBY,
      }),
    ]);
    expect(found.tier).toBe('none');
    expect(found.insteadFound.map((entry) => entry.id)).toEqual(['tree']);
  });

  it('matches a declared alias in another script', () => {
    const found = matchSubject(TEMPLE, [
      record({ id: 'b', name: '大寺院', sourceCategory: 'temple', coordinates: TEMPLE.point }),
    ]);
    expect(found.tier).toBe('name');
  });

  it('refuses a same-named place in another city', () => {
    /*
     * A live audit produced this false positive on its own: the Ghibli Museum,
     * 15 km west, scoring as the Mori Art Museum. A name match is strong and
     * still has to be bounded by geography.
     */
    const faraway = { lat: TEMPLE.point.lat + 0.15, lng: TEMPLE.point.lng };
    const found = matchSubject(TEMPLE, [
      record({ id: 'c', name: 'Great Temple', sourceCategory: 'temple', coordinates: faraway }),
    ]);
    expect(found.tier).toBe('none');
  });

  it('refuses a boundary polygon for a subject that is not a district', () => {
    const park: CanonicalSubject = {
      id: 'theme-park',
      name: 'Great Amusement Park',
      aliases: [],
      kind: 'attraction_complex',
      point: TEMPLE.point,
      radiusMetres: 900,
      sourceEvidence: 'expected',
    };
    const division = record({
      id: 'division',
      name: 'Riverside district',
      layerId: 'divisions',
      sourceCategory: 'neighborhood',
      planningRole: 'administrative',
      coordinates: NEARBY,
    });

    expect(matchSubject(park, [division]).tier).toBe('none');
    /* And the same record does answer for a subject that genuinely is a district. */
    expect(
      matchSubject({ ...park, kind: 'district', name: 'Riverside district' }, [division]).tier,
    ).toBe('name');
  });

  it('measures distance in metres, so a radius means what it says', () => {
    /* One thousandth of a degree of latitude is about 111 m, everywhere. */
    expect(metresBetween({ lat: 0, lng: 0 }, { lat: 0.001, lng: 0 })).toBeCloseTo(111, 0);
  });
});

/**
 * PROXY HONESTY — THE THREE SHAPES THAT MIS-ATTRIBUTED A RELEASE BLOCKER.
 *
 * Each of these is a synthetic reproduction of a record in a real stored pack
 * that the matcher used to credit as the subject, booking an acquisition loss
 * against eligibility: a railway station carrying the alias of the 634 m tower
 * it serves; an exhibition building on a shrine's grounds whose archetype was
 * guessed from the `arts_and_entertainment` family; a wildlife sanctuary two
 * hundred metres from an art museum, guessed the same way. Under the old
 * matcher every one of these three tests FAILS — that is the point. The record
 * is a different entity; the honest result is no match plus a reported proxy.
 */
describe('proxy honesty', () => {
  it('refuses a station confidently classified as a gateway, even wearing the tower’s name', () => {
    const tower: CanonicalSubject = {
      id: 'spire',
      name: 'Signal Spire',
      aliases: ['シグナルスパイア'],
      kind: 'landmark',
      point: TEMPLE.point,
      radiusMetres: 300,
      sourceEvidence: 'expected',
    };
    /* The real shape: とうきょうスカイツリー, infrastructure/railway_station, alias `Tokyo Skytree`. */
    const station = record({
      id: 'station',
      name: 'しぐなるすぱいあ',
      alternateNames: ['Signal Spire'],
      layerId: 'infrastructure',
      sourceCategory: 'railway_station',
      sourceCategoryPath: ['transit'],
      planningRole: 'gateway',
      coordinates: NEARBY,
    });

    const found = matchSubject(tower, [station]);
    expect(found.tier).toBe('none');
    expect(found.record).toBeUndefined();
    expect(found.proxy?.id).toBe('station');
    expect(found.proxy?.metres).toBeGreaterThan(0);
  });

  it('still matches the same name when the taxonomy merely does not recognise the category', () => {
    /*
     * The guard against over-tightening: ignorance is not contradiction. A
     * subject published under a leaf nobody mapped must not become a miss.
     */
    const tower: CanonicalSubject = {
      id: 'spire',
      name: 'Signal Spire',
      aliases: [],
      kind: 'landmark',
      point: TEMPLE.point,
      radiusMetres: 300,
      sourceEvidence: 'expected',
    };
    const found = matchSubject(tower, [
      record({
        id: 'odd',
        name: 'Signal Spire',
        sourceCategory: 'unmapped_novelty_structure',
        sourceCategoryPath: [],
        coordinates: NEARBY,
      }),
    ]);
    expect(found.tier).toBe('name');
    expect(found.record?.id).toBe('odd');
  });

  it('refuses an on-grounds building whose archetype was guessed from a family', () => {
    /*
     * The real shape: 国際交流棟, an exhibition building 432 m from Meiji Jingū
     * (`exhibition_and_trade_fair_venue`, leaf unrecognised, branch-guessed
     * `cultural`). The control's leaf is synthetic so the test pins the family
     * guess itself and cannot rot when the vocabulary learns the real leaf.
     */
    const hall = record({
      id: 'hall',
      name: 'Exchange Hall',
      sourceCategory: 'synthetic_exchange_pavilion',
      sourceCategoryPath: ['arts_and_entertainment', 'synthetic_exchange_pavilion'],
      coordinates: { lat: TEMPLE.point.lat + 0.0039, lng: TEMPLE.point.lng },
    });
    const shrine: CanonicalSubject = { ...TEMPLE, id: 'shrine', name: 'Grand Shrine', aliases: [], radiusMetres: 500 };

    const found = matchSubject(shrine, [hall]);
    expect(found.tier).toBe('none');
    expect(found.proxy?.id).toBe('hall');
  });

  it('refuses a neighbour of a different kind whose archetype was guessed from a family', () => {
    /*
     * The real shape: Shimauma, a wildlife sanctuary 217 m from the Mori Art
     * Museum, credited as the museum because its then-unrecognised leaf fell
     * back to the `arts_and_entertainment` family, which guessed `cultural`.
     * The taxonomy has since learnt that particular leaf, so the control uses
     * a leaf it can never learn — the mechanism under test is the family
     * guess, not the vocabulary's coverage of any one category.
     */
    const sanctuary = record({
      id: 'sanctuary',
      name: 'Zebra House',
      sourceCategory: 'synthetic_unmapped_annex',
      sourceCategoryPath: ['arts_and_entertainment', 'synthetic_unmapped_annex'],
      coordinates: { lat: TEMPLE.point.lat + 0.002, lng: TEMPLE.point.lng },
    });
    const museum: CanonicalSubject = {
      id: 'gallery',
      name: 'City Art Gallery',
      aliases: [],
      kind: 'museum',
      point: TEMPLE.point,
      radiusMetres: 350,
      sourceEvidence: 'expected',
    };

    const found = matchSubject(museum, [sanctuary]);
    expect(found.tier).toBe('none');
    expect(found.proxy?.id).toBe('sanctuary');
  });

  it('still accepts a site match when the source named the kind at path level', () => {
    /*
     * The other over-tightening guard: `source_category_path` is the source's
     * own chain naming a kind we recognise — a novel temple subtype under
     * `temple` is a temple — and refusing it would demand leaf-for-leaf
     * vocabulary coverage the taxonomy never promised.
     */
    const found = matchSubject(TEMPLE, [
      record({
        id: 'subtype',
        name: 'Chùa lớn',
        sourceCategory: 'novel_temple_subtype',
        sourceCategoryPath: ['cultural_and_historic', 'temple', 'novel_temple_subtype'],
        coordinates: NEARBY,
      }),
    ]);
    expect(found.tier).toBe('site');
    expect(found.record?.id).toBe('subtype');
  });
});

/**
 * POINT-VENUE SITE CREDIT — THE FLATTERY THAT INFLATED A RELEASE FUNNEL.
 *
 * Two shapes from live packs, each of which the site tier used to credit as a
 * canonical subject: a war cemetery 759 m inside a palace subject's radius
 * (`land_use/cemetery`, subrole `cultural`, compatible with `landmark`), and
 * `Gallery and Cafe Camelish`, an unrelated business 261 m from an art museum
 * (`places/art_gallery`, also `cultural`). In a dense metropolis *something*
 * kind-compatible sits inside any point venue's radius, so kind-compatibility
 * alone cannot certify identity there. The rules under test:
 *
 * 1. A confidently-named remembrance ground (the taxonomy's own `Cemetery`
 *    display kind) never certifies a landmark or museum subject — at site tier
 *    or name tier. A cemetery named for a palace is a cemetery.
 * 2. Site credit for a landmark or museum requires the record to *wear the
 *    subject's name* — a declared alias on a token boundary for Latin text,
 *    contained for scripts without word boundaries.
 *
 * Under the old matcher every refusal case below FAILS — that is the point.
 */
describe('point-venue site credit', () => {
  const palace: CanonicalSubject = {
    id: 'palace',
    name: 'Old Palace',
    aliases: ['旧宮殿'],
    kind: 'landmark',
    point: TEMPLE.point,
    radiusMetres: 900,
    sourceEvidence: 'probed',
  };
  const museum: CanonicalSubject = {
    id: 'city-art-museum',
    name: 'City Art Museum',
    aliases: ['市美術館', 'Norkan Museum'],
    kind: 'museum',
    point: TEMPLE.point,
    radiusMetres: 350,
    sourceEvidence: 'expected',
  };

  it('refuses a remembrance ground as a landmark, however close', () => {
    /* The real shape: a national cemetery, 759 m from a palace's declared point. */
    const cemetery = record({
      id: 'cemetery',
      name: 'Riverside National Cemetery',
      layerId: 'land_use',
      sourceCategory: 'cemetery',
      coordinates: NEARBY,
    });
    const found = matchSubject(palace, [cemetery]);
    expect(found.tier).toBe('none');
    /* Reported as the nearest coarse-compatible neighbour, never counted. */
    expect(found.proxy?.id).toBe('cemetery');
  });

  it('refuses a remembrance ground even when it wears the landmark’s name', () => {
    /*
     * "Never credit" has to hold at name tier too: memorial grounds are named
     * *for* what they commemorate, and a cemetery carrying the palace's own
     * alias is still a place of rest, not the palace.
     */
    const namesake = record({
      id: 'palace-cemetery',
      name: 'Old Palace Cemetery',
      alternateNames: ['Old Palace'],
      layerId: 'land_use',
      sourceCategory: 'cemetery',
      coordinates: NEARBY,
    });
    const found = matchSubject(palace, [namesake]);
    expect(found.tier).toBe('none');
    expect(found.record).toBeUndefined();
    /* A refused namesake is the strongest proxy there is, and is reported. */
    expect(found.proxy?.id).toBe('palace-cemetery');
  });

  it('refuses a kind-compatible neighbour that does not carry the museum’s name', () => {
    /* The Camelish shape: an unrelated gallery-cafe inside the subject radius. */
    const cafe = record({
      id: 'cafe-gallery',
      name: 'Gallery and Cafe Lakeside',
      sourceCategory: 'art_gallery',
      coordinates: NEARBY,
    });
    const found = matchSubject(museum, [cafe]);
    expect(found.tier).toBe('none');
    expect(found.proxy?.id).toBe('cafe-gallery');
  });

  it('still certifies an on-grounds record wearing the subject’s name at site tier', () => {
    /*
     * The guard against over-tightening, in both scripts. An annex, a wing or a
     * parenthesised bilingual form is the subject's own ground wearing its own
     * name — exactly what the site tier exists to recognise.
     */
    const latin = record({
      id: 'annex',
      name: 'City Art Museum West Wing',
      sourceCategory: 'art_gallery',
      coordinates: NEARBY,
    });
    expect(matchSubject(museum, [latin]).tier).toBe('site');
    expect(matchSubject(museum, [latin]).record?.id).toBe('annex');

    const cjk = record({
      id: 'cjk-annex',
      name: '市美術館別館',
      sourceCategory: 'art_gallery',
      coordinates: NEARBY,
    });
    expect(matchSubject(museum, [cjk]).tier).toBe('site');
  });

  it('requires the Latin name on a token boundary, not as a buried substring', () => {
    /* `norkan` sits inside `bonorkan`; a boundary test is what refuses it. */
    const buried = record({
      id: 'buried',
      name: 'Bonorkan Gallery',
      sourceCategory: 'art_gallery',
      coordinates: NEARBY,
    });
    expect(matchSubject(museum, [buried]).tier).toBe('none');

    const bounded = record({
      id: 'bounded',
      name: 'Norkan Museum Sculpture Court',
      sourceCategory: 'art_gallery',
      coordinates: NEARBY,
    });
    expect(matchSubject(museum, [bounded]).tier).toBe('site');
  });

  it('keeps plain-kind site credit for kinds that are not point venues', () => {
    /*
     * The scope control: a market's in-radius shop, a temple under an exotic
     * name — kinds where the surrounding ground *is* the subject — keep the
     * kind-compatibility rule exactly as it was. Tightening those would score
     * real subjects as misses, the too-strict error the module header opens
     * with.
     */
    const marketSubject: CanonicalSubject = {
      id: 'market',
      name: 'Outer Market',
      aliases: [],
      kind: 'market',
      point: TEMPLE.point,
      radiusMetres: 400,
      sourceEvidence: 'expected',
    };
    const stall = record({
      id: 'stall',
      name: '幸修園本店',
      sourceCategory: 'public_market',
      coordinates: NEARBY,
    });
    expect(matchSubject(marketSubject, [stall]).tier).toBe('site');
  });
});

/**
 * NAME-TIER BEARER PREFERENCE — THE NEAREST NAMESAKE IS NOT ALWAYS THE SUBJECT.
 *
 * The real shape, from a live country pack, first observed on the first
 * complete (v8) build of a road/outdoor destination: a protected area's own
 * `places` record stood ~340 m from the fixture point, and a *vantage point*
 * wearing the area's bare name stood ~110 m from it, published by the
 * infrastructure catalogue — a thing that overlooks the ground and cannot be
 * it, exactly as `SUPPLYING_LAYERS` already rules for the site tier. The
 * partial (v7) build had read zero infrastructure rows, so the namesake did
 * not exist there and the subject's own record matched; the *complete* build
 * introduced the namesake, distance-only selection credited it, the namesake
 * sat in no collapse component, survivor credit never engaged, and the funnel
 * printed "lost at shortlisted" over a rendered seat the entity's collapse
 * survivor was actually holding. A more complete read must never read as a
 * recall loss.
 */
describe('name-tier bearer preference', () => {
  const PARK_SUBJECT: CanonicalSubject = {
    id: 'stone-valley',
    name: 'Stone Valley National Park',
    aliases: ['Stone Valley'],
    kind: 'park',
    point: { lat: 35.7148, lng: 139.7967 },
    radiusMetres: 1500,
    sourceEvidence: 'expected',
  };

  /** ~110 m from the point: the vantage point wearing the park's bare name. */
  const vantage = record({
    id: 'vantage',
    name: 'Stone Valley',
    layerId: 'infrastructure',
    sourceCategory: 'viewpoint',
    coordinates: { lat: PARK_SUBJECT.point.lat + 0.001, lng: PARK_SUBJECT.point.lng },
  });

  /** ~340 m from the point: the park's own record, in a supplying layer. */
  const own = record({
    id: 'own',
    name: 'Stone Valley',
    sourceCategory: 'national_park',
    sourceCategoryPath: ['sports_and_recreation', 'park', 'national_park'],
    coordinates: { lat: PARK_SUBJECT.point.lat + 0.0031, lng: PARK_SUBJECT.point.lng },
  });

  it('prefers the bearer that could be the subject over a nearer vantage point serving it', () => {
    /*
     * Order-independent on purpose: the defect was distance-only selection,
     * not iteration order.
     */
    for (const pool of [
      [vantage, own],
      [own, vantage],
    ]) {
      const found = matchSubject(PARK_SUBJECT, pool);
      expect(found.tier).toBe('name');
      expect(found.record?.id).toBe('own');
    }
  });

  it('keeps the non-supplying-layer bearer when it is the only record the subject has', () => {
    /*
     * The falsifiability control, and the reason this is a preference rather
     * than a refusal: a broadcast tower catalogued by the infrastructure layer
     * *is* its landmark subject — a live metropolis matches its 634 m tower
     * exactly this way — and refusing the layer outright would trade an
     * under-credit for a miss.
     */
    const towerSubject: CanonicalSubject = {
      id: 'tower',
      name: 'Sky Column',
      aliases: [],
      kind: 'landmark',
      point: PARK_SUBJECT.point,
      radiusMetres: 300,
      sourceEvidence: 'expected',
    };
    const tower = record({
      id: 'tower-record',
      name: 'Sky Column',
      layerId: 'infrastructure',
      sourceCategory: 'communication_tower',
      coordinates: towerSubject.point,
    });
    const found = matchSubject(towerSubject, [tower]);
    expect(found.tier).toBe('name');
    expect(found.record?.id).toBe('tower-record');
  });
});

/**
 * JOINED PRIMARIES — ONE RECORD WEARING TWO RENDERINGS OF ITS ONE NAME.
 *
 * The real shape, from a live pack: a canonical subject's own record, retained
 * two metres from its declared position, whose primary is `<CJK rendering> /
 * <Latin rendering>` — two scripts, one entity, spliced into a single string.
 * The subject declares *both* renderings, and the whole-string fold matches
 * neither, so the matcher credited the subject's own record only at site tier:
 * a two-metre own-record reading as a site proxy, understating the product.
 *
 * The rule under test: a joined primary matches at name tier exactly when the
 * *whole* primary is renderings of this subject — every qualifying segment
 * folds into the subject's declared names. One matching segment is not enough,
 * and the negative control below is why: a joined name whose segments name two
 * different subjects is a name about two things, and crediting it to each would
 * count one record as two canonical subjects.
 */
describe('joined dual-script primaries', () => {
  const spire: CanonicalSubject = {
    id: 'spire',
    name: 'Signal Spire',
    aliases: ['シグナルスパイア'],
    kind: 'landmark',
    point: TEMPLE.point,
    radiusMetres: 300,
    sourceEvidence: 'probed',
  };
  /*
   * An unrecognised leaf on purpose: ignorance is not contradiction (see proxy
   * honesty above), so the name path is open and the site path is closed —
   * whatever these tests observe at name tier came from the primary alone.
   */
  const joined = (id: string, name: string, overrides: Partial<SourceRecord> = {}) =>
    record({ id, name, sourceCategory: 'synthetic_beacon_structure', coordinates: NEARBY, ...overrides });

  it('matches a slash-joined primary whose renderings are both declared', () => {
    /* Trimming is part of the claim: sources put spaces around the joiner. */
    const found = matchSubject(spire, [joined('slash', 'シグナルスパイア / Signal Spire')]);
    expect(found.tier).toBe('name');
    expect(found.record?.id).toBe('slash');
  });

  it('matches pipe- and middle-dot-joined primaries the same way', () => {
    expect(matchSubject(spire, [joined('pipe', 'シグナルスパイア｜Signal Spire')]).tier).toBe('name');
    expect(matchSubject(spire, [joined('dot', 'シグナルスパイア・Signal Spire')]).tier).toBe('name');
  });

  it('does not cross-match a joined name whose segments are two different subjects', () => {
    /*
     * THE NEGATIVE CONTROL. Both segments are canonical names — of different
     * subjects. A single-segment rule would credit this one record to both, so
     * neither may see it at name tier.
     */
    const gallery: CanonicalSubject = {
      id: 'gallery',
      name: 'City Art Gallery',
      aliases: ['シティアートギャラリー'],
      kind: 'museum',
      point: TEMPLE.point,
      radiusMetres: 350,
      sourceEvidence: 'expected',
    };
    const walkway = joined('walkway', 'Signal Spire / City Art Gallery');
    expect(matchSubject(spire, [walkway]).tier).not.toBe('name');
    expect(matchSubject(gallery, [walkway]).tier).not.toBe('name');
  });

  it('keeps the script-aware minimum: a stub segment blocks rather than carries the match', () => {
    /*
     * One CJK character and two Latin letters are abbreviations or noise, not
     * renderings. A stub neither becomes a candidate nor lets the remaining
     * lone segment speak for the whole joined name.
     */
    expect(matchSubject(spire, [joined('cjk-stub', 'シ / Signal Spire')]).tier).not.toBe('name');
    expect(
      matchSubject({ ...spire, aliases: [...spire.aliases, 'SS'] }, [
        joined('latin-stub', 'シグナルスパイア / SS'),
      ]).tier,
    ).not.toBe('name');
  });

  it('does not loosen the distance rule for joined primaries', () => {
    const faraway = { lat: TEMPLE.point.lat + 0.15, lng: TEMPLE.point.lng };
    expect(
      matchSubject(spire, [joined('far', 'シグナルスパイア / Signal Spire', { coordinates: faraway })])
        .tier,
    ).toBe('none');
  });

  it('still refuses a joined namesake the archetype confidently contradicts', () => {
    /* The station shape again, now wearing the joined form of the name. */
    const station = joined('joined-station', 'シグナルスパイア / Signal Spire', {
      layerId: 'infrastructure',
      sourceCategory: 'railway_station',
      sourceCategoryPath: ['transit'],
      planningRole: 'gateway',
    });
    const found = matchSubject(spire, [station]);
    expect(found.tier).toBe('none');
    expect(found.proxy?.id).toBe('joined-station');
  });
});
