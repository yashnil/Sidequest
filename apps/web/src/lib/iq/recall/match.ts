import { classifySourceCategory } from '@sidequest/compiler';
import { foldForMatch, isLatinScript, type SourceRecord } from '@sidequest/core';
import type { CanonicalKind, CanonicalSubject } from './fixtures/canonical-subjects';

/**
 * DECIDING WHETHER A RECORD *IS* A CANONICAL SUBJECT.
 *
 * The hard part of a recall measurement is not counting; it is deciding what
 * counts. Two ways to get it wrong, and the live evidence contains both:
 *
 * **Too strict.** A live pack returned the Tokyo Imperial Palace as
 * `Hoàng cung Tokyo` and `Императорский дворец Токио`. An English-string matcher
 * scores a hit as a miss and reports a product worse than it is.
 *
 * **Too loose.** The same pack held `浅草寺の神木・いちょう` — the ginkgo tree
 * outside Sensō-ji — 91 m from the temple, and `もみじ谷`, a wood, 123 m from
 * Tokyo Tower. A proximity-only matcher scores those as hits and reports a
 * product better than it is. That flattery is the more dangerous error, because
 * it is the one that closes a release blocker without fixing anything.
 *
 * So a match is either:
 *
 * - `name` — a name or alias folds to one the subject declares. Script-agnostic
 *   via `foldForMatch`, which is the product's own folding. A name is strong
 *   evidence and still not proof: a live pack carried とうきょうスカイツリー — the
 *   *railway station* named after the tower it serves, catalogued as
 *   `infrastructure/railway_station` with the alias `Tokyo Skytree` — and a
 *   name-only matcher credited the station as the 634 m tower. Places lend
 *   their names to the stations, piers and stops that serve them, so a name
 *   match is refused when the source *confidently* names the record as a sort
 *   of thing the subject cannot be. Confidently matters: a record the taxonomy
 *   merely failed to recognise is ignorance, not contradiction, and refusing it
 *   would recreate the too-strict error above.
 * - `site` — the record sits inside the subject's own radius **and** the
 *   product's own taxonomy classifies it as the *sort of thing* the subject is,
 *   **from the source's own naming of it** — a leaf or a recognised path
 *   segment, never a branch fallback. A tree beside a temple fails the
 *   archetype half. The branch-fallback half is the Meiji/Mori lesson: a live
 *   pack held `国際交流棟`, an exhibition building 432 m from a shrine, and
 *   `Shimauma`, a wildlife sanctuary 217 m from an art museum, and both were
 *   credited because their unrecognised leaves fell back to the
 *   `arts_and_entertainment` *family*, which guessed `cultural`. A guessed
 *   archetype can gate eligibility; it cannot certify identity.
 *
 * A near record that is plainly a **different entity** but plainly *evidences*
 * the subject — a gateway wearing its name, a building on its grounds whose
 * archetype was guessed from a family — is returned as `proxy`: reported, never
 * counted. Everything else within the radius is recorded as `insteadFound` and
 * reported, never counted. Those columns are where "we got the tree, not the
 * temple" becomes legible instead of anecdotal.
 */

/**
 * The archetypes the product's taxonomy would have to produce for a record to
 * plausibly *be* a subject of this kind.
 *
 * Stated against the taxonomy's `subrole` rather than its `role`, because role
 * is a permission and subrole is a description, and this is a question about
 * description. `civic` appears under sacred sites because the table files
 * congregations there, and a real temple that a source classified as a place of
 * worship must not be scored a miss on our vocabulary rather than its own.
 */
const COMPATIBLE_SUBROLES: Readonly<Record<CanonicalKind, readonly string[]>> = {
  /*
   * `outdoor_nature` is deliberately absent from the built kinds. A wood 123 m
   * from a broadcasting tower and a forested islet 311 m from a palace are both
   * real records in a real pack, and counting either as the landmark is the
   * flattery this matcher exists to refuse.
   */
  landmark: ['cultural', 'scenic', 'urban_place'],
  museum: ['cultural'],
  sacred_site: ['cultural', 'civic'],
  park: ['outdoor_nature', 'urban_place', 'scenic'],
  market: ['market', 'urban_place'],
  district: ['urban_place', 'scenic'],
  attraction_complex: ['urban_place', 'cultural'],
  natural_feature: ['outdoor_nature', 'scenic'],
};

/**
 * WHICH LAYERS MAY SUPPLY A SUBJECT, BY KIND.
 *
 * The second half of the too-loose problem, and the half a subrole cannot fix.
 * `outdoor_nature` is a perfectly good archetype for a national park and also
 * for a pond, a wood, a stretch of sand and a single named tree — so a park
 * subject matched by subrole alone collects `大噴水` (a fountain pond, 152 m from
 * Ueno Park) and `シラカシ` (an oak, 247 m from Shinjuku Gyoen) and reports them
 * as the garden.
 *
 * What separates them is not the archetype, it is which catalogue published
 * them. `land` and `water` are the *terrain* layers: individual trees, stones,
 * wetlands, ponds. `land_use` is where a park polygon lives, `places` is where a
 * named venue lives, `divisions` is where a neighbourhood lives. So a built
 * subject may be supplied by `places` or `land_use` and never by a tree; a
 * neighbourhood may additionally be supplied by its own boundary; and a natural
 * feature — a waterfall, a glacier lagoon — may of course come from terrain,
 * because that is where waterfalls are published.
 *
 * A live pack matched Tokyo Disneyland to `舞浜(大字)`, the neighbourhood polygon
 * 139 m away. A postcode is not a day out, and this table is what says so.
 */
const SUPPLYING_LAYERS: Readonly<Record<CanonicalKind, readonly string[]>> = {
  landmark: ['places', 'land_use'],
  museum: ['places', 'land_use'],
  sacred_site: ['places', 'land_use'],
  park: ['places', 'land_use'],
  market: ['places', 'land_use'],
  district: ['places', 'land_use', 'divisions'],
  attraction_complex: ['places', 'land_use'],
  natural_feature: ['places', 'land_use', 'land', 'water'],
};

/**
 * POINT VENUES: KINDS WHOSE SITE TIER DEMANDS THE SUBJECT'S OWN NAME.
 *
 * The third instalment of the too-loose lesson, and the one that inflated a
 * release funnel. A landmark or a museum is a *point*, and in a dense
 * metropolis some kind-compatible, confidently-named record sits inside any
 * point's radius: a live funnel credited a war cemetery 759 m away as an
 * imperial palace and `Gallery and Cafe Camelish`, an unrelated business at
 * 261 m, as the Mori Art Museum — and the acquisition floor the release stood
 * on was resting partly on both. So for these kinds, two extra refusals:
 *
 * 1. **A remembrance ground never certifies them.** The taxonomy's own display
 *    vocabulary names cemetery and graveyard leaves `Cemetery`
 *    (`taxonomy.ts`), and a place of rest is a different entity from a palace
 *    or a museum even when it is named for one — memorial grounds usually are.
 *    Read from the product's `displayKind` rather than a leaf list of our own,
 *    for the same drift reason as everything else here.
 * 2. **Site credit requires the subject's name on the record.** An annex, a
 *    wing, a shop *of* the museum wears the museum's name; a neighbour does
 *    not. Latin aliases must match on token boundaries — `norkan` buried
 *    inside `bonorkan` is not a name, it is an accident — while scripts
 *    without word boundaries use containment, mirroring the quarantine test's
 *    own matching rule. The subjects declare no open identifiers today, so a
 *    shared-identifier rung is not implemented rather than implemented
 *    untestably; a subject that gains a `wikidataId` should extend this gate.
 *
 * The other kinds keep the kind-compatibility rule exactly as it was: a
 * market's in-radius stall and a temple under an exotic name are the
 * surrounding ground being the subject, and demanding a name there would
 * recreate the too-strict error the header opens with.
 */
const POINT_VENUE_KINDS: readonly CanonicalKind[] = ['landmark', 'museum'];

const EARTH_RADIUS_METRES = 6_371_000;

/** Equirectangular, which is exact enough at the scale of a city block. */
export function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = Math.PI / 180;
  const meanLat = ((a.lat + b.lat) / 2) * rad;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad * Math.cos(meanLat);
  return EARTH_RADIUS_METRES * Math.hypot(dLat, dLng);
}

export type MatchTier = 'name' | 'site' | 'none';

export interface NearbyRecord {
  id: string;
  layerId: string;
  name: string;
  sourceCategory: string;
  subrole: string;
  metres: number;
}

export interface SubjectMatch {
  tier: MatchTier;
  /** The record we decided *is* the subject, when there is one. */
  record?: SourceRecord;
  metres?: number;
  /**
   * A record that is plainly a *different entity* and still evidences the
   * subject — a station wearing its name, an on-grounds building or a
   * neighbour whose archetype the taxonomy only guessed from a family.
   *
   * Present only when `tier` is `none`. Reported, never counted: the honest
   * sentence it supports is "the subject's own record is absent; a proxy
   * exists at N metres", and crediting it as the subject is exactly the
   * flattery that closed three acquisition losses as eligibility losses.
   */
  proxy?: NearbyRecord;
  /**
   * What was inside the radius and was not the subject, nearest first.
   *
   * Capped at three. Reported, never counted — see the header.
   */
  insteadFound: NearbyRecord[];
}

function namesOf(record: SourceRecord): string[] {
  const names = [record.name, ...record.alternateNames];
  const geography = record.geography;
  if (geography) {
    names.push(...(geography.displayNames ?? []), ...(geography.aliases ?? []));
  }
  return names.filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/**
 * JOINED PRIMARIES — ONE PRIMARY CARRYING TWO RENDERINGS OF ONE NAME.
 *
 * Sources splice a record's renderings into a single primary: `<CJK rendering>
 * / <Latin rendering>`, pipe-joined and middle-dot-joined variants included. A
 * live pack held a canonical subject's *own record* two metres from its
 * declared position under exactly that shape — the subject declares both
 * renderings, the whole-string fold equals neither, and the matcher credited a
 * two-metre own-record only at site tier, understating the product in the
 * funnel.
 *
 * So a joined primary is split at the joiners and each trimmed segment becomes
 * a folded name candidate — with two refusals that keep this from loosening
 * anything:
 *
 * 1. **Script-aware minimum length.** A one-character CJK segment or a
 *    two-letter Latin segment is an abbreviation or noise, not a rendering,
 *    and never qualifies. Two CJK characters are a whole name; two Latin
 *    letters are not — hence the split thresholds, measured on the same fold
 *    the comparison uses.
 * 2. **Every qualifying segment must be this subject's name.** A joined name
 *    matches only when the *whole* primary is renderings of the subject — at
 *    least two qualifying segments, all folding into the declared alias set. A
 *    single matching segment is refused, because a primary that joins this
 *    subject's name to some *other* name is a name about two things: crediting
 *    it to each subject it mentions would count one record as two canonical
 *    subjects, which is flattery by double-booking.
 *
 * The candidates feed the same gates as any other name: the bounded name
 * berth, and the confident-archetype contradiction that keeps a station out of
 * landmark credit. Nothing about distance or archetype is relaxed here.
 */
const JOINED_PRIMARY_DELIMITERS = /[/／|｜・･·•]/u;

/** The trimmed, qualifying renderings of a joined primary; empty when unjoined. */
function joinedRenderingsOf(primary: string): string[] {
  if (!JOINED_PRIMARY_DELIMITERS.test(primary)) return [];
  return primary
    .split(JOINED_PRIMARY_DELIMITERS)
    .map((segment) => segment.trim())
    .filter(
      (segment) =>
        /\p{L}/u.test(segment) &&
        foldForMatch(segment).length >= (isLatinScript(segment) ? 3 : 2),
    );
}

/** Whether a joined primary is, in whole, this subject's own name. */
function joinedPrimaryNamesSubject(primary: string, aliases: ReadonlySet<string>): boolean {
  const renderings = joinedRenderingsOf(primary);
  return (
    renderings.length >= 2 &&
    renderings.every((rendering) => aliases.has(foldForMatch(rendering)))
  );
}

function describe(record: SourceRecord, metres: number): NearbyRecord {
  return {
    id: record.id,
    layerId: record.layerId,
    name: record.name,
    sourceCategory: record.sourceCategory,
    subrole: classifySourceCategory({
      category: record.sourceCategory,
      path: record.sourceCategoryPath,
    }).subrole,
    metres: Math.round(metres),
  };
}

function classificationOf(record: SourceRecord) {
  return classifySourceCategory({
    category: record.sourceCategory,
    path: record.sourceCategoryPath,
  });
}

/**
 * Whether a record's own classification is compatible with the subject's kind.
 *
 * Uses the product's taxonomy rather than a table of our own, so that a change
 * to how the product understands categories moves the measurement with it. An
 * evaluation carrying a second opinion about what a museum is would drift away
 * from the thing it is evaluating, silently, which is how a green suite comes to
 * protect nothing.
 */
export function isCompatibleKind(record: SourceRecord, kind: CanonicalKind): boolean {
  /*
   * A compiled place carries no layer of its own; the artifact adapter recovers
   * one from its `<layer>=<category>` tag and falls back to `places`, which is
   * what a compiled candidate is. So the layer test applies uniformly to pack
   * records and to board places without a second code path.
   */
  if (!SUPPLYING_LAYERS[kind].includes(record.layerId)) return false;
  return COMPATIBLE_SUBROLES[kind].includes(classificationOf(record).subrole);
}

/**
 * Whether the *source* named what this record is, rather than us inferring it.
 *
 * The taxonomy says so itself: a `source_leaf_category` or
 * `source_category_path` match is the source's own vocabulary naming the thing
 * or a specific ancestor of it; a `source_branch` match is a family fallback —
 * "unrecognised leaf, but it lives under arts_and_entertainment" — and
 * `no_recognised_category` is nobody knowing. The taxonomy publishes `match`
 * precisely so a caller can weigh the two apart, and this matcher is the caller
 * with the most to lose: a family guess is good enough to *gate* a record (it
 * errs safe) and not good enough to *identify* one (it errs flattering).
 */
export function sourceNamedItsKind(record: SourceRecord): boolean {
  const kind = classificationOf(record).match.kind;
  return kind === 'source_leaf_category' || kind === 'source_category_path';
}

/**
 * Whether the source confidently classified this record as a remembrance
 * ground — a cemetery or graveyard, in the taxonomy's own display vocabulary.
 *
 * `displayKind` rather than a leaf list written here, so that a new
 * remembrance leaf the taxonomy learns moves the measurement with it.
 */
function confidentlyRemembranceGround(record: SourceRecord): boolean {
  return sourceNamedItsKind(record) && classificationOf(record).displayKind === 'Cemetery';
}

/**
 * Whether one of the record's names wears one of the subject's declared names.
 *
 * Weaker than the name tier's whole-name equality — the record's primary may
 * be `<subject name> West Wing` — and stronger than proximity: the subject's
 * folded alias must appear on a token boundary for Latin text, or be contained
 * for scripts that have no word boundaries. Aliases below the joined-primary
 * length thresholds are skipped: a two-letter fragment matches everywhere and
 * certifies nothing.
 */
function wearsNameOf(record: SourceRecord, subject: CanonicalSubject): boolean {
  const aliases = [subject.name, ...subject.aliases]
    .map(foldForMatch)
    .filter((alias) => alias.length >= (isLatinScript(alias) ? 3 : 2));
  const names = namesOf(record).map(foldForMatch);
  return aliases.some((alias) =>
    names.some((name) =>
      isLatinScript(alias) ? ` ${name} `.includes(` ${alias} `) : name.includes(alias),
    ),
  );
}

/**
 * Whether a record that *carries the subject's name* is refused anyway.
 *
 * Only a confident classification may contradict a name: `railway_station` is
 * the source's own leaf, `gateway_rail` describes a way to reach somewhere and
 * never a landmark, so the station named for the tower is out. An archetype
 * that was guessed from a branch, or never recognised at all, contradicts
 * nothing — refusing on it would score a real temple filed under an exotic
 * leaf as a miss, which is the too-strict error the header opens with.
 *
 * For point-venue kinds a confidently-named remembrance ground contradicts the
 * name even though its `cultural` subrole is compatible: memorial grounds are
 * named for what they commemorate, and a cemetery wearing a palace's name is
 * still a cemetery. See `POINT_VENUE_KINDS`.
 */
function nameContradictedByArchetype(record: SourceRecord, kind: CanonicalKind): boolean {
  if (!sourceNamedItsKind(record)) return false;
  if (!COMPATIBLE_SUBROLES[kind].includes(classificationOf(record).subrole)) return true;
  return POINT_VENUE_KINDS.includes(kind) && confidentlyRemembranceGround(record);
}

/**
 * Whether a site-tier candidate may certify this subject's identity.
 *
 * The kind-compatibility and source-confidence tests have already passed by
 * the time this is asked; this is the point-venue tightening on top of them —
 * see `POINT_VENUE_KINDS` for why those two kinds get extra rules and the
 * others deliberately do not.
 */
function siteTierMayCertify(record: SourceRecord, subject: CanonicalSubject): boolean {
  if (!POINT_VENUE_KINDS.includes(subject.kind)) return true;
  if (confidentlyRemembranceGround(record)) return false;
  return wearsNameOf(record, subject);
}

export function matchSubject(
  subject: CanonicalSubject,
  records: readonly SourceRecord[],
): SubjectMatch {
  const aliases = new Set(
    [subject.name, ...subject.aliases].map(foldForMatch).filter((value) => value.length > 0),
  );

  /**
   * THE NEAREST NAME-BEARER IS NOT ALWAYS THE SUBJECT — PREFER ONE THAT COULD BE.
   *
   * A place lends its name to the furniture that serves it, and some of that
   * furniture is *closer to the subject's declared point than the subject's own
   * record*: a live country pack held a park's own `places` record ~340 m from
   * the fixture point and a *vantage point* wearing the park's bare name at
   * ~110 m, published by the terrain-side infrastructure catalogue — a thing
   * that overlooks the park and cannot be it, exactly as the matcher's own
   * `SUPPLYING_LAYERS` table already says for the site tier. Distance-only
   * selection credited the vantage point, which sits in no collapse component,
   * so the survivor credit that follows the entity never engaged and the funnel
   * booked "lost at shortlisted" over a rendered seat the entity's survivor was
   * holding. Under-credit, the same instrument failure `stages.ts` documents.
   *
   * So the name tier keeps two candidates: the nearest bearer the product's own
   * taxonomy says *could actually be* the subject (`isCompatibleKind` — the site
   * tier's supplying-layer and subrole test), and the nearest bearer of any
   * shape. The compatible one wins when it exists; the unrestricted one remains
   * the fallback, because some subjects genuinely live in a non-supplying layer
   * — a broadcast tower catalogued as infrastructure is the subject, and
   * refusing it outright would recreate the too-strict error the header opens
   * with. Nothing about the berth, the archetype contradiction, or what counts
   * as a name changes here — only which of several accepted bearers stands for
   * the subject.
   */
  let namedCompatible: { record: SourceRecord; metres: number } | undefined;
  let namedAny: { record: SourceRecord; metres: number } | undefined;
  /** Name-bearers the archetype refused: a station wearing the tower's name. */
  const namesakes: { record: SourceRecord; metres: number }[] = [];
  const withinRadius: { record: SourceRecord; metres: number }[] = [];

  for (const record of records) {
    const metres = metresBetween(subject.point, record.coordinates);
    /*
     * A name match is allowed a wider berth than a site match — four times the
     * radius — because a name is far stronger evidence than a position, and a
     * polygon's published centroid can sit well outside the point a traveller
     * would give you. It is still bounded: `Tokyo Tower` in another prefecture
     * is a different tower, and an unbounded name match would quietly import
     * the false positive the report already caught once (a Ghibli museum 15 km
     * west scoring as the Mori Art Museum).
     */
    const wearsSubjectName =
      namesOf(record).some((name) => aliases.has(foldForMatch(name))) ||
      joinedPrimaryNamesSubject(record.name, aliases);
    if (metres <= subject.radiusMetres * 4 && wearsSubjectName) {
      if (nameContradictedByArchetype(record, subject.kind)) {
        namesakes.push({ record, metres });
      } else {
        if (!namedAny || metres < namedAny.metres) {
          namedAny = { record, metres };
        }
        if (isCompatibleKind(record, subject.kind) && (!namedCompatible || metres < namedCompatible.metres)) {
          namedCompatible = { record, metres };
        }
      }
    }
    if (metres <= subject.radiusMetres) withinRadius.push({ record, metres });
  }

  withinRadius.sort((a, b) => a.metres - b.metres);
  namesakes.sort((a, b) => a.metres - b.metres);

  const named = namedCompatible ?? namedAny;
  if (named) {
    return {
      tier: 'name',
      record: named.record,
      metres: Math.round(named.metres),
      insteadFound: [],
    };
  }

  /*
   * A site match must be the source's own naming of the kind. A record whose
   * archetype was guessed from a branch is *coarsely* compatible — good enough
   * to be a proxy, below — and is exactly what credited an exhibition building
   * as a shrine and a wildlife sanctuary as an art museum. For point-venue
   * kinds it must additionally survive `siteTierMayCertify`: no remembrance
   * grounds, and the record must wear the subject's own name.
   */
  const site = withinRadius.find(
    (entry) =>
      isCompatibleKind(entry.record, subject.kind) &&
      sourceNamedItsKind(entry.record) &&
      siteTierMayCertify(entry.record, subject),
  );
  if (site) {
    return {
      tier: 'site',
      record: site.record,
      metres: Math.round(site.metres),
      insteadFound: [],
    };
  }

  /*
   * No record *is* the subject. Two shapes of near-miss still evidence it, and
   * the report owes the reader both: a refused namesake (strongest — sources
   * name stations after what they serve), else the nearest in-radius record
   * that passed the coarse archetype test on a guessed classification.
   */
  const guessedNeighbour = withinRadius.find((entry) => isCompatibleKind(entry.record, subject.kind));
  const proxy = namesakes[0] ?? guessedNeighbour;

  return {
    tier: 'none',
    ...(proxy ? { proxy: describe(proxy.record, proxy.metres) } : {}),
    insteadFound: withinRadius
      .filter((entry) => entry.record.id !== proxy?.record.id)
      .slice(0, 3)
      .map((entry) => describe(entry.record, entry.metres)),
  };
}
