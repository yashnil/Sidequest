/**
 * THE TOKENISER OF THE ATLAS'S LEXICAL INDEX, AT QUERY TIME.
 *
 * The index is built offline (`packages/atlas/build/lib/vocabulary.mjs`); a
 * query must be folded to terms by exactly the same rules or it will not find
 * them. The two implementations are held to identical output by
 * `packages/atlas/src/atlas.test.ts`. Deliberately tiny: lower case, accents
 * off, the commonest English plurals off. No stemmer worth the name — a wrong
 * conflation ("general" / "generous") costs more here than a missed one.
 */

const STOP_WORDS =
  'the a an and or of in on at to for from by with as is are was were be been being it its this that these those there here which who whom whose what when where why how not no nor but if then than so such very can could should would may might must will shall do does did done have has had having you your yours we our ours they them their he him his she her i me my also more most some any all each every other others one two three four five six seven eight nine ten first second third many much few several about above below under over between into through during before after again further once only own same too just out up down off near around along across via per etc e.g i.e km m ft miles mile hours hour minutes minute day days week weeks year years time times well good great best nice small large big little long short old new high low main local many there their get go goes going take takes taken make makes made see sees seen visit visits visiting visitor visitors place places area areas town towns city cities region regions country countries part parts side sides end way ways road roads street streets north south east west northern southern eastern western centre center central located location known called named including include includes around within without available open closed daily hotel hotels room rooms price prices phone tel fax email website http https www com org net';

export const ATLAS_STOP_WORDS: ReadonlySet<string> = new Set(STOP_WORDS.split(/\s+/));

/** Folds a word to its index form. */
export function atlasStem(word: string): string {
  let w = word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(ches|shes|sses|xes|zes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  return w;
}

/** The index terms of a text, in order, stop words and numbers removed. */
export function atlasTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (raw.length < 3 || raw.length > 24 || ATLAS_STOP_WORDS.has(raw)) continue;
    const term = atlasStem(raw);
    if (term.length < 3 || ATLAS_STOP_WORDS.has(term)) continue;
    out.push(term);
  }
  return out;
}

/** A name folded for matching: lower case, accents off, punctuation to spaces. */
export function foldPlaceName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
