import {
  normaliseGeographicName,
  type GeographicEvidence,
  type SourceRecord,
} from '@sidequest/core';
import { subjectEvidence, type DivisionDirectory, type DivisionEntry } from './containment';
import { boundsContain } from './partition';

/**
 * DOES A RECORD'S ASSERTED KIND AGREE WITH THE GROUND IT STANDS ON?
 *
 * ---
 *
 * ## The defect
 *
 * Every gate before this one asks where a record *is*: the containment overlay
 * decides whether the point falls inside the traveller's destination, the role
 * layer decides what the kind may be used for, the witness gates decide whether
 * anything vouches for it. Not one of them asks whether the record's **asserted
 * kind is compatible with the point it carries**.
 *
 * Live boards from three destinations show what that costs. Measured on the
 * stored packs those boards were built from, one dense-metro pack holds, in its
 * central wards and with no mapped ground of their own: seven records tagged as
 * ski resorts, eight tagged as national parks, three as caves, four as castles.
 * The second metro pack holds the same shapes. Each carries source confidence in
 * the high thirties and a description reading, in full, that nothing beyond its
 * name and position is published about it. One of them — a mountain gondola
 * whose ground is a hundred and fifty kilometres from the ward it was geocoded
 * into — became the sole activity of a day on the flagship journey.
 *
 * These are not exotic. A catalogue row is a name, a point and a category
 * string, and the three are filled in by different people at different times; a
 * tour desk selling trips to a park, a shop named after a famous mountain, a
 * ticket agent for a cave, and a mis-projected coordinate all produce exactly
 * this shape. What was missing was any check that the three agree.
 *
 * ## The rule
 *
 * > A candidate whose identity strongly implies one geography while its
 * > coordinates place it in an incompatible one must not receive high-confidence
 * > admission merely because one source tag looks useful.
 *
 * The kinds this fires for are the ones whose *category alone* is a claim about
 * the size and character of the ground beneath the point: a conferred protected
 * area, a mountain-scale landform, ground whose approach is the hazard. Every
 * one of them is larger than a city block and none of them is a shopfront. The
 * caller composes the set from three flags the taxonomy already owns, so this
 * module holds no category vocabulary and cannot drift from the table that does.
 *
 * ## What resolves the claim, and why each is available
 *
 * Only evidence the records already carry. No network call, no new field, no
 * per-destination list. Any one of these settles it in the record's favour:
 *
 * 1. **Its own mapped extent.** A record that published a real outline is
 *    claiming ground rather than a point, and the outline is the evidence. This
 *    is the same hundred-metre magnitude test the landscape gate already
 *    applies, for the same reason: a bounding box a metre across is a point
 *    with floating-point noise on it.
 * 2. **The divisions layer, by name.** `DivisionDirectory` indexes every
 *    published spelling of every administrative division the pack retained. A
 *    record whose name carries such a name *and* whose own division chain runs
 *    through it, or whose point stands inside its published or measured extent,
 *    is a feature named after ground it is actually on.
 * 3. **Its own containment chain**, which is identity rather than label: two
 *    records sharing a division identifier are in the same published division
 *    whatever either is called, in whatever script.
 *
 * And, at the caller: **anything independent vouching for the identity at all**
 * — a knowledge-base entry, a second catalogue, an authority's own page. That
 * is what separates refusal from demotion, and it is the reason the honest park
 * with a thin record keeps its seat while the ticket agent wearing its name does
 * not.
 *
 * ## What this deliberately does not do
 *
 * It does not compare the record's name against its own address at locality
 * level. That comparison was built, measured over three stored packs, and
 * removed: it books a hundred and twenty-five refusals of which almost every one
 * is a real place standing in the town it is named after, because the two sides
 * describe that town at different administrative granularities — a hotel filed
 * under its rural municipality, a shop under its ward, a berth under its port.
 * The geometry that would have arbitrated does not exist: the divisions layer
 * these packs carry publishes *points*, so every division's own box is a few
 * metres across and "the record is outside it" is true of everything. A gate
 * whose refusals are almost all wrong is worse than the defect it addresses.
 */

/**
 * The longest run of words a division name may occupy inside another name.
 *
 * Four, because administrative names genuinely run that long in several scripts
 * and because the cost of the sweep is linear in this number. Longer matches are
 * not lost so much as unnecessary: a five-word division name that fails to match
 * on four is a name nobody embeds in a feature's.
 */
const MAX_NAME_WORDS = 4;

/**
 * A name so short it is a word before it is a place.
 *
 * Two characters of folded text — after diacritics and punctuation are gone —
 * matches far too much to be evidence of anything, and in a logographic script a
 * two-character run is an ordinary noun. Here the direction of the error is
 * benign either way, because this lookup only ever *supports* a record.
 */
const MIN_ASSERTED_NAME_LENGTH = 3;

export type IdentityGroundVerdict =
  | { kind: 'consistent' }
  | {
      /**
       * The kind claims ground; nothing on the record, and nothing the pack
       * publishes about where it stands, supports the claim.
       */
      kind: 'unsupported_ground_claim';
      /** The category string that made the claim, verbatim. */
      asserted: string;
      /** Where the record says it is, for the diagnostic. */
      found: string;
    };

export interface IdentityGroundInput {
  record: SourceRecord;
  directory: DivisionDirectory;
  /**
   * True for kinds whose category alone claims regional ground. Supplied by the
   * caller from the taxonomy rather than read here.
   */
  regionalExtentKind: boolean;
  /** Metres across the record's own mapped outline, where it published one. */
  mappedExtentMetres: number | undefined;
}

export function identityGroundVerdict(input: IdentityGroundInput): IdentityGroundVerdict {
  if (!input.regionalExtentKind) return { kind: 'consistent' };
  if (input.mappedExtentMetres !== undefined) return { kind: 'consistent' };
  if (standsOnGroundItNames(input)) return { kind: 'consistent' };
  const evidence = evidenceOf(input.record);
  return {
    kind: 'unsupported_ground_claim',
    asserted: input.record.sourceCategory,
    found:
      input.record.containment.neighbourhoodName ??
      input.record.containment.localityName ??
      evidence.localityNames[0] ??
      `${input.record.coordinates.lat},${input.record.coordinates.lng}`,
  };
}

/**
 * Whether the pack's own geography places this record on ground its name names.
 *
 * The corroborating half, and it can only ever say yes. Both kinds of division
 * extent are read, and the asymmetry is the one `DivisionDirectory` documents: a
 * measured extent over-approximates at its corners, which is admissible where
 * geometry *supports* a record and inadmissible where it would refuse one.
 */
function standsOnGroundItNames(input: IdentityGroundInput): boolean {
  const { record, directory } = input;
  const chain = new Set([
    ...record.containment.divisionIds,
    ...(record.geography?.divisionIds ?? []),
  ]);
  for (const entry of namedDivisions(record, directory)) {
    if (relatedByAncestry(chain, entry, directory)) return true;
    if (entry.bounds && boundsContain(entry.bounds, record.coordinates)) return true;
    if (
      directory
        .coveringMeasured(record.coordinates)
        .some((measured) => measured.id === entry.id || measured.chain.includes(entry.id))
    ) {
      return true;
    }
  }
  return false;
}

/** Whether the record's own division chain and the named division are relatives. */
function relatedByAncestry(
  chain: ReadonlySet<string>,
  entry: DivisionEntry,
  directory: DivisionDirectory,
): boolean {
  if (chain.has(entry.id)) return true;
  if (entry.chain.some((id) => chain.has(id))) return true;
  for (const id of chain) {
    const own = directory.entry(id);
    if (own?.chain.includes(entry.id)) return true;
  }
  return false;
}

/**
 * The administrative divisions a record's own name names.
 *
 * Every word run up to `MAX_NAME_WORDS` long, from the primary name and from
 * every alternate spelling, looked up in the pack's own division index. Word
 * runs rather than a substring scan for one reason worth stating: a substring
 * scan matches a division name buried inside a longer word, which in a
 * space-free script is most of the time, and the resulting match would be an
 * accident of orthography.
 */
function namedDivisions(record: SourceRecord, directory: DivisionDirectory): DivisionEntry[] {
  const seen = new Set<string>();
  const found: DivisionEntry[] = [];
  for (const name of [record.name, ...record.alternateNames]) {
    for (const run of wordRuns(name)) {
      if (run.length < MIN_ASSERTED_NAME_LENGTH || seen.has(run)) continue;
      seen.add(run);
      found.push(...directory.named(run));
    }
  }
  return found;
}

/** Folded word runs of up to `MAX_NAME_WORDS`, longest first. */
function wordRuns(name: string): string[] {
  const words = normaliseGeographicName(name)
    .split(' ')
    .filter((word) => word.length > 0);
  const runs: string[] = [];
  for (let length = Math.min(MAX_NAME_WORDS, words.length); length >= 1; length -= 1) {
    for (let start = 0; start + length <= words.length; start += 1) {
      runs.push(words.slice(start, start + length).join(' '));
    }
  }
  return runs;
}

/** The record's typed evidence, from whichever shape the pack carries it in. */
function evidenceOf(record: SourceRecord): GeographicEvidence {
  return (
    record.geography ??
    subjectEvidence({
      coordinates: record.coordinates,
      containment: record.containment,
      planningRole: record.planningRole,
    })
  );
}
