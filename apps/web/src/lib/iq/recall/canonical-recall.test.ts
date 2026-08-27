import { afterAll, describe, expect, it } from 'vitest';
import type { RegionPack, SourceRecord } from '@sidequest/core';
import { CANONICAL_DESTINATIONS } from './fixtures/canonical-subjects';
import { FIXTURE_METROPOLIS, buildFixturePack, fixtureScope } from './fixtures/fixture-world';
import { openArtifactStore, neutralScopeFor, type ArtifactStore } from './artifacts';
import { renderRecallReport } from './report';
import {
  measureCanonicalRecall,
  neverInTheRoom,
  neverRead,
  shareReaching,
  type CanonicalRecallReport,
} from './stages';

/**
 * THE GATE.
 *
 * Read `stages.ts` first — it holds the stage model and the argument for why
 * the assertions below stop where they stop. In one paragraph: a canonical place
 * left off a board because it suits the traveller badly is the product working;
 * a canonical place absent because its row group was never opened is the product
 * failing, and only the second is asserted here.
 *
 * Two arms.
 *
 * **Fixture arm** — always runs, no network, no database, no money. Drives the
 * real acquisition provider over a synthetic metropolis and asserts full recall
 * through stage 4. Includes its own mutation: the same world with a starved read
 * budget must *fail* the gate, because a gate nobody has seen fail is a gate
 * nobody should trust.
 *
 * **Reality arm** — runs against the real packs and compiled regions in
 * `apps/web/data/sidequest.db` when that file exists. It is gitignored, so this
 * arm is silent in CI and loud on a developer machine that has compiled
 * something. Every destination it finds gets the same assertions.
 *
 * Run both, and see the staged table:
 *
 *   npx vitest run apps/web/src/lib/iq/recall --reporter=verbose
 */

/**
 * How much of a destination's canonical inventory must reach the pack.
 *
 * Not a taste threshold. A subject in this fixture is published by the source
 * and sits inside the resolved scope; the only reasons it can be absent are that
 * the read never reached it, or that a deliberate bound excluded it. The floor
 * leaves room for the second — some subjects are genuinely published under
 * categories a source treats as commerce, and some sit under a polygon nobody
 * catalogued — and no room for the first.
 */
const ACQUISITION_FLOOR = 0.8;

/**
 * How much of what was acquired must survive the admission gates.
 *
 * Lower than acquisition on purpose: admission is a *judgement*, and a source
 * that files a famous crossing as street furniture is a defensible refusal of an
 * indefensible category. What is not defensible is a majority of a destination's
 * canonical inventory being refused, which is the state this floor detects.
 */
const ELIGIBILITY_FLOOR = 0.6;

/**
 * THE LAST TWO RUNGS, FLOORED — FOR THE DESTINATIONS WHERE THEY WERE LOST.
 *
 * The nine gates above floor acquisition and eligibility and stopped there,
 * and the day's own funnels showed why that is one rung short of the product:
 * on artifacts compiled 2026-08-13 the Tokyo funnel read acquired 14/16,
 * eligible 13/16, shortlisted 4/16, board 2/16 — a green gate suite over a
 * served board whose classics were a canal bridge and four cemeteries for a
 * History-80 traveller. Six independent reviewers called the missing floors
 * the release-governing defect. These two assert the rungs the traveller
 * actually sees, for the dense-metro destination class (§29 A) where the
 * losses are concentrated; the country-breadth destination's board failures
 * are scope-derivation defects with their own findings and are not floored
 * here.
 *
 * **The numbers, and why they are defensible.** Ceilings first, measured from
 * today's artifacts with the tightened matcher (no proxy credit):
 *
 * - Tokyo: 14/16 acquirable — the national museum's pack identity is a
 *   temporary exhibition and the art museum's own record is absent (both the
 *   own-record retention class queued for the compiler wave); 13/16 eligible —
 *   the famous crossing normalises to an administrative object. Ceiling ≈0.81.
 * - Osaka: 9/12 acquirable — the castle, the sky building and the national
 *   art museum all lost their own records to ancillary neighbours (same
 *   class). Ceiling 0.75.
 *
 * A shortlist floor of **0.5** says: at least half of a destination's
 * canonical inventory survives the cut. It sits three subjects of headroom
 * under the worse ceiling (Osaka's 0.75), which is room for every legitimate
 * §16 fit exclusion — a gate demanding famous names regardless of fit would be
 * a bug requesting a bug — while today's 4/16 and 2/12 fail it outright. A
 * board floor of **0.3** says: a first-time traveller recognises roughly a
 * third of the canon among the rendered seats (Tokyo ≥5 of 16, Osaka ≥4 of
 * 12, on 19- and 24-card boards). Reviewer-suggested ranges were 0.5–0.6 and
 * 0.25–0.4; both floors sit at the defensible bottom of their range because
 * the ceilings above are real and two-to-three subjects per metro are
 * source-unsupportable until the own-record retention fix lands.
 *
 * **These floors are expected to FAIL on the artifacts of 2026-08-13.** That
 * is what they are for: they hold the release open until the shortlist-seating
 * and retention fixes land and the destinations are recompiled. Do not delete
 * or lower them to get a green run — the boards they are red about are the
 * boards travellers are being served.
 */
const DENSE_METRO_SHORTLIST_FLOOR = 0.5;
const DENSE_METRO_BOARD_FLOOR = 0.3;

/*
 * THE ROAD/OUTDOOR CLASS GETS ITS OWN FLOORS, AND A SCOPE FLOOR FIRST.
 *
 * An independent adversary showed the gap these close: a country-breadth trip
 * whose derived scope clipped to ~70 km around the capital moved half the
 * canon OUT OF THE DENOMINATOR — six of twelve subjects "outside the pack
 * bounds; not counted" — so a scope regression that halves coverage RAISED
 * every measured share, and the class had no rendered-surface floor at all,
 * so a served board of town squares and empty volcanoes with zero
 * recognisable canon read as green. Out-of-scope canon on a country-breadth
 * trip is a scope-derivation loss, not a measurement exclusion.
 *
 * The scope floor is calibrated to the product's own honest reach arithmetic,
 * measured in code before any recompile was seen: the questionnaire's daily
 * wheel-time slider runs to six hours, and the widening turns a stated N
 * minutes into min(mode cap 220, max(70, (N/2)/60 × 55 km/h)) — a five-hour
 * answer reaches ~137 km, six hours ~165 km. That covers the class fixture's
 * capital cluster, the geothermal lagoon, the crater and the standard
 * day-trip circuit; the farthest one or two subjects (a glacier lagoon
 * ~250 km out) exceed any single-base day answer the product accepts and
 * remain measured as out-of-scope losses in the report rather than
 * disappearing. Two thirds is the floor a mid-scale honest answer clears and
 * a capital-clipped scope cannot. The board floor is deliberately the bottom of the reviewer
 * range (a quarter): the class's boards are smaller and its supply thinner,
 * but zero recognisable canon is not a defensible bottom for any class. Both
 * are expected to FAIL on the 2026-08-21 artifacts; they hold the release
 * open until the scope widening lands and the destination is recompiled.
 * Never delete or lower them to get green.
 */
const ROAD_OUTDOOR_SCOPE_FLOOR = 0.66;
const ROAD_OUTDOOR_BOARD_FLOOR = 0.25;

/** The destination class the two rendered-surface floors bind. */
const isDenseMetro = (destination: { shape: string }): boolean =>
  destination.shape.includes('§29 A');

/** The road/outdoor country class (§29 C/E). */
const isRoadOutdoor = (destination: { shape: string }): boolean =>
  destination.shape.includes('§29 C');

function show(report: CanonicalRecallReport): void {
  /* eslint-disable-next-line no-console -- the report is the deliverable. */
  console.log(renderRecallReport(report));
}

/* Pack record ids are layer-prefixed by the normaliser: `places:subject-fixture-0-0`. */
const ownsRecord = (subject: { id: string }, record: { id: string }): boolean =>
  record.id.endsWith(`subject-${subject.id}`);

const withPlaces = (
  pack: RegionPack,
  edit: (layer: RegionPack['layers'][number]) => RegionPack['layers'][number],
): RegionPack => ({
  ...pack,
  layers: pack.layers.map((layer) => (layer.id === 'places' ? edit(layer) : layer)),
});

/** The subject's own record in the fixture pack's places layer. */
function ownRecordOf(pack: RegionPack, subject: { id: string }): SourceRecord {
  return pack.layers
    .find((layer) => layer.id === 'places')!
    .records.find((record) => ownsRecord(subject, record))!;
}

// ---------------------------------------------------------------------------
// Fixture arm
// ---------------------------------------------------------------------------

describe('canonical recall over a synthetic metropolis', { timeout: 30_000 }, () => {
  it('acquires the canonical experience in every quadrant of the destination', async () => {
    const pack = await buildFixturePack();
    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack,
      scope: fixtureScope(),
    });
    show(report);

    /*
     * The mechanism assertion, and the one the whole file exists for: not one
     * subject may sit in a partition cell the places layer came back empty from.
     * See `stages.ts` for why an empty cell proves an unread cell.
     */
    expect(neverInTheRoom(report).map((entry) => entry.subject.name)).toEqual([]);

    /* And the counts, so a subject cannot be lost some other way unnoticed. */
    expect(shareReaching(report, 'acquired')).toBe(1);
    expect(shareReaching(report, 'eligible')).toBe(1);

    /*
     * The spread, measured the way the live audit measured it. A pack whose
     * places layer is one corner passes every per-record assertion above only
     * because the fixture plants a subject in that corner too.
     */
    expect(report.read.cellsWithPlaces).toBe(report.read.cells);
    expect(report.read.densestCellShare).toBeLessThan(0.4);
  }, 30_000);

  /**
   * THE MUTATION, RUN AS A TEST RATHER THAN AS A SOURCE EDIT.
   *
   * §30 asks for regressions to be introduced and for the suite to be shown
   * failing on them. Starving the row-group budget is the live defect in one
   * parameter: the reader stops in the first corner it reaches, every landmark
   * beyond it is never decoded, and *nothing downstream can tell*. If this test
   * ever stops seeing `never_read`, the gate above has become decorative.
   */
  it('reports never-read losses when the read is starved, so a pass is falsifiable', async () => {
    const starved = await buildFixturePack({ maxRowGroups: 3 });
    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack: starved,
      scope: fixtureScope(),
    });

    expect(neverRead(report).length).toBeGreaterThan(0);
    expect(shareReaching(report, 'acquired')).toBeLessThan(ACQUISITION_FLOOR);
    /* And it must be diagnosed as unread rather than as a ranking outcome. */
    for (const lost of neverRead(report)) {
      expect(lost.cell?.retainedInCell).toBe(0);
    }

    /*
     * AND THE GATE'S OWN EXPRESSION, WHICH IS THE ONE THAT HAS TO BE ABLE TO
     * FAIL.
     *
     * Everything above this paragraph asserts on `neverRead`. The gate asserts
     * on `neverInTheRoom`. They are different functions, and while the negative
     * control only ever exercised the first, `neverInTheRoom` could have been
     * replaced by `return []` — for a refactor, for a stubbed branch, for any
     * reason at all — and the whole suite would have stayed green while the
     * sentence "16 → 0" rested on a function that could no longer report a
     * fault. An instrument nobody has seen deflect is not an instrument.
     */
    expect(neverInTheRoom(report).map((entry) => entry.subject.name)).not.toEqual([]);
    /* And the union contains the part this arm can produce. */
    expect(neverInTheRoom(report).map((entry) => entry.subject.id)).toEqual(
      expect.arrayContaining(neverRead(report).map((entry) => entry.subject.id)),
    );

    /*
     * And the artifact says which bound did it, named by layer. This is the only
     * signal a count backstop leaves: `shortfallBytes` is computed from what the
     * *plan* could afford and is therefore zero here, so a stored pack cut short
     * by a count and one that read its whole area agree on every byte figure.
     * The reason word is what separates them.
     */
    expect(report.read.budgetsExhausted).toContain('places:row_group_budget');
  }, 30_000);

  /**
   * THE OTHER HALF OF THE UNION, WHICH NO ARM OF THIS GATE COULD REACH.
   *
   * `neverInTheRoom` is `never_read` **or** `outside_partition`, and the second
   * is the worse state: ground that was not merely unread but never scheduled to
   * be read. A stored country-breadth pack dropped 11 of its 35 grid cells,
   * including the one holding the capital — its cathedral, its concert hall, its
   * museum — and every one of those subjects is invisible to `neverRead`,
   * because a cell that does not exist retains nothing and is also not a cell
   * that came back empty.
   *
   * The fixture metropolis has no dropped cells, so this branch of the gate's
   * own subject had never once been evaluated. Rather than assert a hand-written
   * verdict string — which would be a second opinion about what the classifier
   * does — the measured pack has one partition cell removed exactly as
   * `partitionScope` removes them, and the product's own classifier is asked
   * what it makes of the subject standing on that ground.
   */
  it('counts ground that was never scheduled, which `neverRead` alone cannot see', async () => {
    const pack = await buildFixturePack();

    /* A cell some canonical subject actually stands in, so the loss is real. */
    const contains = (cell: (typeof pack.partition.cells)[number], point: { lat: number; lng: number }): boolean =>
      point.lat >= cell.bounds.southWest.lat &&
      point.lat <= cell.bounds.northEast.lat &&
      point.lng >= cell.bounds.southWest.lng &&
      point.lng <= cell.bounds.northEast.lng;
    const orphaned = FIXTURE_METROPOLIS.subjects.filter((subject) =>
      pack.partition.cells.some((cell) => contains(cell, subject.point)),
    );
    const dropped = pack.partition.cells.find((cell) =>
      orphaned.some((subject) => contains(cell, subject.point)),
    )!;
    const lost = FIXTURE_METROPOLIS.subjects.filter((subject) => contains(dropped, subject.point));
    expect(lost.length).toBeGreaterThan(0);

    const unscheduled: RegionPack = {
      ...pack,
      partition: {
        ...pack.partition,
        cells: pack.partition.cells.filter((cell) => cell.id !== dropped.id),
      },
      layers: pack.layers.map((layer) => ({
        ...layer,
        records: layer.records.filter((record) => record.cellId !== dropped.id),
      })),
    };

    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack: unscheduled,
      scope: fixtureScope(),
    });

    /* The classifier's own verdict, on ground that is no longer scheduled. */
    const outside = report.subjects.filter((entry) => entry.verdict === 'outside_partition');
    expect(outside.map((entry) => entry.subject.id).sort()).toEqual(
      lost.map((subject) => subject.id).sort(),
    );

    /* Invisible to `neverRead` — which is precisely why the gate uses the union. */
    expect(neverRead(report).map((entry) => entry.subject.id)).not.toEqual(
      expect.arrayContaining(lost.map((subject) => subject.id)),
    );

    /* And caught by the expression the gate actually asserts on. */
    expect(neverInTheRoom(report).map((entry) => entry.subject.id)).toEqual(
      expect.arrayContaining(lost.map((subject) => subject.id)),
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Attribution arm: the funnel must name the true stage
// ---------------------------------------------------------------------------

/**
 * THE INSTRUMENT'S ATTRIBUTION, PROVEN ON DOCTORED ARTIFACTS.
 *
 * Three real Tokyo losses were booked against eligibility on records that were
 * not the subject — a station wearing the tower's name, a branch-guessed
 * building on a shrine's grounds — and six more hid a retention defect behind
 * "unread or outranked" on a pack whose read plan proves the ground was fully
 * read. An instrument that mis-attributes aims the fix wave at the wrong
 * stage, so each attribution rule below is exercised on a fixture pack doctored
 * the way the real artifacts actually are: same fields, same vocabulary.
 */
describe('stage attribution over a doctored artifact', { timeout: 30_000 }, () => {
  it('books a namesake gateway as proxy_only, and proxy_only is not acquisition', async () => {
    const pack = await buildFixturePack();
    const subject = FIXTURE_METROPOLIS.subjects[0]!;
    /*
     * The Skytree shape, byte for byte in the fields that matter: the subject's
     * own record is gone; what remains at its coordinate carries its name and
     * is confidently classified as a way to reach somewhere, not a thing to be.
     */
    const doctored = withPlaces(pack, (layer) => ({
      ...layer,
      records: layer.records.map((record) =>
        ownsRecord(subject, record)
          ? { ...record, sourceCategory: 'railway_station', sourceCategoryPath: ['transit'] }
          : record,
      ),
    }));

    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack: doctored,
      scope: fixtureScope(),
    });
    const entry = report.subjects.find((candidate) => candidate.subject.id === subject.id)!;

    expect(entry.verdict).toBe('proxy_only');
    expect(entry.passed.acquired).toBe(false);
    expect(entry.lostAt).toBe('acquired');
    expect(entry.match.proxy?.sourceCategory).toBe('railway_station');
    /* The honest sentence: the subject's own record is absent; a proxy exists at N metres. */
    expect(entry.match.proxy?.metres).toBeGreaterThanOrEqual(0);
    /* And it is an acquisition loss in the share the gate asserts on. */
    expect(shareReaching(report, 'acquired')).toBeCloseTo(8 / 9, 10);
    /*
     * But never a gate member: a proxy proves the cell was read, and widening
     * the never-in-the-room blocker would be a contract change, not honesty.
     */
    expect(neverInTheRoom(report).map((lost) => lost.subject.id)).not.toContain(subject.id);
  }, 30_000);

  it('attributes an absence on fully-read ground to retention, as `outranked`', async () => {
    const pack = await buildFixturePack();
    const subject = FIXTURE_METROPOLIS.subjects[1]!;
    /* The pack's own read plan must already prove completeness, as the fresh live pack does. */
    const evicted = withPlaces(pack, (layer) => ({
      ...layer,
      records: layer.records.filter((record) => !ownsRecord(subject, record)),
    }));

    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack: evicted,
      scope: fixtureScope(),
    });
    expect(report.read.placesRead).toBe('complete');
    const entry = report.subjects.find((candidate) => candidate.subject.id === subject.id)!;
    expect(entry.verdict).toBe('outranked');
    expect(entry.lostAt).toBe('acquired');
  }, 30_000);

  it('attributes an absence in a cell the layer names as failed to the read, as `unread`', async () => {
    const pack = await buildFixturePack();
    const subject = FIXTURE_METROPOLIS.subjects[1]!;
    const cellId = pack.layers
      .find((layer) => layer.id === 'places')!
      .records.find((record) => ownsRecord(subject, record))!.cellId;
    const cutShort = withPlaces(pack, (layer) => ({
      ...layer,
      records: layer.records.filter((record) => !ownsRecord(subject, record)),
      failedCellIds: [cellId],
    }));

    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack: cutShort,
      scope: fixtureScope(),
    });
    const entry = report.subjects.find((candidate) => candidate.subject.id === subject.id)!;
    expect(entry.verdict).toBe('unread');
    expect(entry.lostAt).toBe('acquired');
  }, 30_000);

  it('keeps `unread_or_outranked` where a legacy vocabulary genuinely cannot say', async () => {
    const pack = await buildFixturePack();
    const subject = FIXTURE_METROPOLIS.subjects[1]!;
    const legacy: RegionPack = {
      ...withPlaces(pack, (layer) => ({
        ...layer,
        records: layer.records.filter((record) => !ownsRecord(subject, record)),
      })),
      /* The stored v1 packs' exact words: a stop happened, attributable to no layer. */
      diagnostics: { ...pack.diagnostics, budgetsExhausted: ['retained', 'retained_budget'] },
    };

    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack: legacy,
      scope: fixtureScope(),
    });
    expect(report.read.placesRead).toBe('indeterminate');
    const entry = report.subjects.find((candidate) => candidate.subject.id === subject.id)!;
    expect(entry.verdict).toBe('unread_or_outranked');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Survivor crediting: the funnel follows the entity through a linker collapse
// ---------------------------------------------------------------------------

/**
 * THE UNDER-CREDIT THE LIVE FUNNEL PROVED.
 *
 * On the fresh Tokyo pack two canonical subjects were booked "lost at
 * shortlisted" while the entity each stands for sat on the board: the record
 * the matcher chose had been collapsed by the linker into a stronger twin, and
 * the inventory seated the twin. Stages 5 and 6 must follow the survivor —
 * read from the product's own `supersededRecordIds`, never re-decided by the
 * instrument — and must say when credit came that way. And the credit must not
 * be a soft pass: a subject whose survivor also lost its seat still reads
 * lost, which the second test pins as this rule's own negative control.
 */
describe('stage credit follows a linker collapse to its survivor', { timeout: 30_000 }, () => {
  /**
   * A twin the product's own collapse will choose as the survivor: more
   * provenance rows than the subject's record, an eligible identity of its
   * own, a name the subject does not declare, and a position far enough away
   * that no matcher tier can reach it — so any stage-5/6 credit observed can
   * only have travelled through the collapse.
   */
  function survivorTwinOf(own: SourceRecord, overrides: Partial<SourceRecord> = {}): SourceRecord {
    const point = { lat: own.coordinates.lat, lng: own.coordinates.lng + 0.03 };
    return {
      ...structuredClone(own),
      id: 'places:collapse-survivor',
      sourceId: 'collapse-survivor',
      name: 'Eastern Annex Collection',
      alternateNames: [],
      coordinates: point,
      bounds: { southWest: { ...point }, northEast: { ...point } },
      sources: Array.from({ length: 5 }, (_, index) => ({
        ...own.sources[0]!,
        recordId: `survivor-${index}`,
      })),
      ...overrides,
    };
  }

  /** The twin added to the places layer, and the collapsing link that owns it. */
  function collapsedInto(pack: RegionPack, own: SourceRecord, twin: SourceRecord): RegionPack {
    return {
      ...withPlaces(pack, (layer) => ({ ...layer, records: [...layer.records, twin] })),
      links: [
        ...pack.links,
        {
          recordIds: [own.id, twin.id].sort(),
          kind: 'same_entity',
          evidence: ['shared_upstream_record_id'],
          separationMetres: 3_270,
        },
      ],
    };
  }

  it('credits shortlist and board through the collapse survivor when the matched record was superseded', async () => {
    const pack = await buildFixturePack();
    const subject = FIXTURE_METROPOLIS.subjects[0]!;
    const own = ownRecordOf(pack, subject);
    const twin = survivorTwinOf(own);
    const doctored = collapsedInto(pack, own, twin);

    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack: doctored,
      scope: fixtureScope(),
      /* A same-build board carrying the survivor, not the matched record. */
      compiled: { places: [twin], packContentHash: doctored.contentHash },
    });
    const entry = report.subjects.find((candidate) => candidate.subject.id === subject.id)!;

    /* The matcher still names the subject's own record: a name-tier hit. */
    expect(entry.match.tier).toBe('name');
    expect(entry.match.record?.id).toBe(own.id);
    /* The seat moved with the collapse, and the funnel follows it. */
    expect(entry.passed.shortlisted).toBe(true);
    expect(entry.passed.board).toBe(true);
    expect(entry.lostAt).toBeUndefined();
    /* Said as survivor credit, so it cannot read as an own-record seat. */
    expect(entry.survivor?.id).toBe(twin.id);
    expect(entry.survivor?.creditedStages).toEqual(['shortlisted', 'board']);
    expect(renderRecallReport(report)).toContain('credited shortlisted+board via survivor');
  }, 30_000);

  /**
   * THE RULE'S OWN NEGATIVE CONTROL. Following the survivor must make the
   * instrument more accurate, not easier: collapse the subject's record into a
   * survivor that then loses its own seat — here a record the product
   * confidently classifies as a way to reach somewhere, which no inventory
   * shortlist will ever hold — and the funnel must still book the loss. If
   * this test ever passes a subject on a seatless survivor, survivor credit
   * has become flattery.
   */
  it('still books the loss when the collapse survivor itself lost its seat', async () => {
    const pack = await buildFixturePack();
    const subject = FIXTURE_METROPOLIS.subjects[0]!;
    const own = ownRecordOf(pack, subject);
    const twin = survivorTwinOf(own, {
      sourceCategory: 'railway_station',
      sourceCategoryPath: ['transit'],
    });
    const doctored = collapsedInto(pack, own, twin);

    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack: doctored,
      scope: fixtureScope(),
      /* A same-build board that does not carry the survivor either. */
      compiled: { places: [], packContentHash: doctored.contentHash },
    });
    const entry = report.subjects.find((candidate) => candidate.subject.id === subject.id)!;

    /* The survivor is named, and it saved nothing: the loss is still booked. */
    expect(entry.passed.shortlisted).toBe(false);
    expect(entry.passed.board).toBe(false);
    expect(entry.lostAt).toBe('shortlisted');
    expect(entry.survivor?.id).toBe(twin.id);
    expect(entry.survivor?.creditedStages).toEqual([]);
    expect(renderRecallReport(report)).toContain('survivor lost its seat too');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The board stage follows the entity, never the neighbourhood
// ---------------------------------------------------------------------------

/**
 * THE ASTERISK ANOMALY, RESOLVED.
 *
 * A live funnel printed "on the board despite being lost earlier" for a park
 * whose *zoo* sat on the board, and credited a palace's board seat to a war
 * cemetery — both via the same mechanism: the board stage re-ran the matcher
 * over the compiled places, and the site tier found a kind-compatible
 * neighbour that was not the record the funnel had been following. For an
 * artifact compiled **from the very pack being measured**, that is never
 * evidence about the subject: the compiled places carry the pack's own record
 * ids, so the honest question is *identity* — is the matched record, or its
 * collapse survivor, among the rendered seats? A different-build artifact
 * keeps the independent matcher, because ids cannot be compared across builds
 * and the provenance footnote already says what the number rests on. A subject
 * with no matched record at all also keeps the independent matcher: a
 * name-bearing record on a same-build board that the pack-side stages cannot
 * account for is a real finding, and the footnote exists to report it.
 */
describe('the board stage follows the entity through a same-build artifact', { timeout: 30_000 }, () => {
  /** A kind-compatible neighbour inside the subject's radius: the zoo shape. */
  function menagerieNear(own: SourceRecord): SourceRecord {
    return {
      ...structuredClone(own),
      id: 'places:menagerie',
      sourceId: 'menagerie',
      name: 'Quadrant Menagerie Gardens',
      alternateNames: [],
      sourceCategory: 'zoo',
      sourceCategoryPath: ['attractions_and_activities', 'zoo'],
    };
  }

  it('refuses same-build board credit through a kind-compatible neighbour that is not the matched record', async () => {
    const pack = await buildFixturePack();
    const subject = FIXTURE_METROPOLIS.subjects.find((entry) => entry.kind === 'park')!;
    const own = ownRecordOf(pack, subject);

    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack,
      scope: fixtureScope(),
      /* Same build; the board seats the zoo, not the park. */
      compiled: { places: [menagerieNear(own)], packContentHash: pack.contentHash },
    });
    const entry = report.subjects.find((candidate) => candidate.subject.id === subject.id)!;

    expect(entry.match.record?.id).toBe(own.id);
    expect(entry.passed.shortlisted).toBe(true);
    /* The zoo is not the park, and identity is checkable here: no credit. */
    expect(entry.passed.board).toBe(false);
    expect(entry.lostAt).toBe('board');
  });

  it('credits the matched record’s own seat by identity', async () => {
    const pack = await buildFixturePack();
    const subject = FIXTURE_METROPOLIS.subjects.find((entry) => entry.kind === 'park')!;
    const own = ownRecordOf(pack, subject);

    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack,
      scope: fixtureScope(),
      compiled: { places: [own], packContentHash: pack.contentHash },
    });
    const entry = report.subjects.find((candidate) => candidate.subject.id === subject.id)!;
    expect(entry.passed.board).toBe(true);
    expect(entry.lostAt).toBeUndefined();
  });

  it('still lets the independent matcher speak for a different-build artifact', async () => {
    /*
     * The scope control: across builds ids do not correspond, so the matcher
     * is the only fair instrument — and the report already footnotes that the
     * number was measured against a differently-built region.
     */
    const pack = await buildFixturePack();
    const subject = FIXTURE_METROPOLIS.subjects.find((entry) => entry.kind === 'park')!;
    const own = ownRecordOf(pack, subject);

    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack,
      scope: fixtureScope(),
      compiled: { places: [menagerieNear(own)], packContentHash: 'not-the-measured-pack' },
    });
    const entry = report.subjects.find((candidate) => candidate.subject.id === subject.id)!;
    expect(entry.passed.board).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The lost-early-yet-on-board footnote must tell the truth about provenance
// ---------------------------------------------------------------------------

/*
 * The instrument's own suites carry a declared budget.
 *
 * Every test below builds a full artifact — a pack, a compiled region and a
 * rendered seat list — and walks the six-stage funnel over it. Measured on an
 * idle machine the whole file is 15.2 s of test time across 30 tests, its
 * slowest single case 2.0 s; measured under a loaded repository the same case
 * took 5.16 s and failed against vitest's five-second default. Nothing here is
 * waiting on anything, so the multiplier is contention alone. The budget is
 * declared per suite rather than raised globally, so an ordinary test that
 * starts taking five seconds still fails the way it should.
 */
describe('the lost-early-yet-on-board footnote', { timeout: 30_000 }, () => {
  /**
   * The footnote used to print unconditionally, asserting "built from a
   * different pack" against a compiled artifact that records the very same
   * pack hash as the one measured — a false sentence in the deliverable the
   * gate exists to produce. The report already computes the comparison
   * (`laterStagesFromSameBuild`); the footnote must read it.
   */
  it('prints the different-pack footnote only when the compiled artifact records a different pack', async () => {
    const pack = await buildFixturePack();
    const subject = FIXTURE_METROPOLIS.subjects[1]!;
    const own = ownRecordOf(pack, subject);
    /* Lost at acquisition in the measured pack, yet standing on the board. */
    const evicted = withPlaces(pack, (layer) => ({
      ...layer,
      records: layer.records.filter((record) => !ownsRecord(subject, record)),
    }));

    const sameBuild = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack: evicted,
      scope: fixtureScope(),
      compiled: { places: [own], packContentHash: evicted.contentHash },
    });
    const entry = sameBuild.subjects.find((candidate) => candidate.subject.id === subject.id)!;
    expect(entry.lostAt).toBe('acquired');
    expect(entry.passed.board).toBe(true);
    expect(sameBuild.laterStagesFromSameBuild).toBe(true);
    /* Same recorded hash: a provenance-mismatch sentence would be false. */
    expect(renderRecallReport(sameBuild)).not.toContain('different pack');
    expect(renderRecallReport(sameBuild)).toContain(
      'the board carries a hit the pack-side stages cannot account for',
    );

    const otherBuild = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack: evicted,
      scope: fixtureScope(),
      compiled: { places: [own], packContentHash: 'not-the-measured-pack' },
    });
    expect(otherBuild.laterStagesFromSameBuild).toBe(false);
    expect(renderRecallReport(otherBuild)).toContain(
      'built from a different pack than the one measured above',
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Reality arm
// ---------------------------------------------------------------------------

const store: ArtifactStore | null = openArtifactStore();

const REALITY = Object.values(CANONICAL_DESTINATIONS)
  .map((destination) => ({ destination, chain: store?.chainFor(destination.destinationCandidateId) ?? null }))
  .flatMap((entry) => (entry.chain ? [{ destination: entry.destination, chain: entry.chain }] : []));

describe.skipIf(REALITY.length === 0)('canonical recall over stored artifacts', () => {
  /* Every read happens at collection; the handle is released once, at the end. */
  afterAll(() => store?.close());

  for (const { destination, chain } of REALITY) {
    describe(destination.id, () => {
      /*
       * The store selects region-first: the newest compiled region for the
       * destination, measured against the very pack that region embeds — the
       * chain a real traveller most recently received. A newer pack compiled
       * under a different scope for a different traveller profile never
       * stands in for it.
       */
      const { stored, compiled } = chain;
      const report = measureCanonicalRecall({
        destination,
        pack: stored.pack,
        scope: compiled?.scope ?? neutralScopeFor(stored.pack),
        compiled: compiled?.view ?? null,
        provenance: { storedSchemaVersion: stored.storedSchemaVersion, relabelled: stored.relabelled },
      });

      if (isDenseMetro(destination)) {
        it('[PHASE-16C BLOCKER] keeps every published metro subject inside the compiled scope', () => {
          /*
           * The denominator guard an adversary asked for: every gated share
           * below is reached/of over IN-SCOPE subjects, so a tighter-scope
           * recompile that pushes subjects out of bounds silently raises every
           * share. A dense metro's canon is inside the city by construction —
           * any out-of-scope subject here is a scope regression, never a
           * measurement exclusion.
           */
          expect(
            report.outOfScope,
            'Published metro subjects outside the compiled bounds. A metro scope that excludes ' +
              'its own canon shrinks every floor denominator below; fix the scope, never the list.',
          ).toEqual([]);
        });
      }

      it('[PHASE-16B BLOCKER] loses no canonical subject to ground that was never read', () => {
        show(report);
        expect(
          neverInTheRoom(report).map((entry) => ({
            subject: entry.subject.name,
            verdict: entry.verdict,
            cells: entry.cell?.cellIds,
          })),
          'Each of these is a canonical experience the source publishes inside the resolved scope, ' +
            'whose partition cell produced no place records at all — so no ranking, fit or ' +
            'preference decision was ever made about it. This is the Phase 16B blocker. Do not ' +
            'weaken this assertion: repair acquisition, or the gate is measuring nothing.',
        ).toEqual([]);
      });

      it('[PHASE-16B BLOCKER] acquires the destination’s canonical inventory into the pack', () => {
        expect(
          shareReaching(report, 'acquired'),
          'Share of in-scope canonical subjects present in the pack in any layer.',
        ).toBeGreaterThanOrEqual(ACQUISITION_FLOOR);
      });

      it('[PHASE-16B BLOCKER] admits what it acquired', () => {
        expect(
          shareReaching(report, 'eligible'),
          'Share of in-scope canonical subjects that passed the role admission gates.',
        ).toBeGreaterThanOrEqual(ELIGIBILITY_FLOOR);
      });

      if (isDenseMetro(destination)) {
        it('[PHASE-16B BLOCKER] keeps at least half of the canonical inventory through the shortlist cut', () => {
          expect(
            shareReaching(report, 'shortlisted'),
            'Share of in-scope canonical subjects the inventory kept a seat for. ' +
              'This floor is expected to fail on the 2026-08-13 artifacts: the cut flushes ' +
              'eligible canonical anchors wholesale, which is the release-governing defect ' +
              'every reviewer named. It goes green when the shortlist seating fix lands and ' +
              'the destination is recompiled — never by lowering the floor.',
          ).toBeGreaterThanOrEqual(DENSE_METRO_SHORTLIST_FLOOR);
        });

        it.skipIf(!report.laterStagesFromSameBuild)(
          '[PHASE-16B BLOCKER] seats a recognisable share of the canon on the rendered board',
          () => {
            expect(
              shareReaching(report, 'board'),
              'Share of in-scope canonical subjects among the seats the discover page renders ' +
                '(same-build seat list, credited by record identity). Expected to fail on the ' +
                '2026-08-13 artifacts for the same reason as the shortlist floor; a pass bought ' +
                'by proxy credit or by measuring a differently-built region does not count and ' +
                'the instrument no longer offers either.',
            ).toBeGreaterThanOrEqual(DENSE_METRO_BOARD_FLOOR);
          },
        );
      }

      if (isRoadOutdoor(destination)) {
        it('[PHASE-16C BLOCKER] compiles a scope that contains the canonical circuit', () => {
          const inScope = destination.subjects.length - report.outOfScope.length;
          expect(
            inScope / destination.subjects.length,
            'Share of the published canon inside the compiled ground. Subjects outside the ' +
              'derived bounds of a country-breadth trip are scope-derivation losses, not ' +
              'measurement exclusions — a narrower scope must never raise a share. Expected to ' +
              'fail on the 2026-08-21 artifacts (6 of 12 outside a ~70 km capital box); goes ' +
              'green when the day-trip scope widening lands and the destination is recompiled — ' +
              'never by lowering the floor.',
          ).toBeGreaterThanOrEqual(ROAD_OUTDOOR_SCOPE_FLOOR);
        });

        it.skipIf(!report.laterStagesFromSameBuild)(
          '[PHASE-16C BLOCKER] seats recognisable canon on the road/outdoor board',
          () => {
            expect(
              shareReaching(report, 'board'),
              'Share of in-scope canonical subjects among the rendered seats, same rules as the ' +
                'dense-metro floor. A served board of town squares and unverified volcanoes with ' +
                'zero recognisable canon read as green before this floor existed. Expected to ' +
                'fail on the 2026-08-21 artifacts; goes green on recompile after the scope and ' +
                'seating fixes — never by lowering the floor.',
            ).toBeGreaterThanOrEqual(ROAD_OUTDOOR_BOARD_FLOOR);
          },
        );
      }
    });
  }
});
