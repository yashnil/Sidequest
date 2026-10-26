import { describe, expect, it } from 'vitest';
import recorded from '../providers/fixtures/wikidata/lisbon-around-details.json';
import { elementsFromBindings } from '../providers/wikidata-around';
import { detailsFromBindings, parseInception } from '../providers/wikidata-details';
import { composeDescription, datePhrase, describePool, factsFor, tidyDescription } from './open-data-description';
import { proposeFromOpenData, type OpenDataDeps } from './open-data-proposal';

/**
 * OPEN-DATA DESCRIPTIONS, ON ONE RECORDED LISBON ANSWER.
 *
 * `fixtures/wikidata/lisbon-around-details.json` is a single recorded Wikidata
 * Query Service answer: the scan's `around` rows for Lisbon joined with the
 * details query's fields. No network here.
 */

const bindings = (recorded as unknown as { bindings: unknown[] }).bindings;
const LISBON = { lat: 38.7223, lng: -9.1393 };

function recordedDeps(): OpenDataDeps {
  const around = elementsFromBindings(bindings as Parameters<typeof elementsFromBindings>[0]);
  const details = detailsFromBindings(bindings);
  return {
    source: 'openstreetmap+wikidata',
    fetchGroup: async (_box, selector) => ({
      elements: around.elements.filter((e) => selector.values.includes(e.tags?.[selector.key] ?? '')),
      dataTimestamp: null,
      calls: 0,
      cacheHit: false,
      bytes: 0,
      failedGroups: [],
    }),
    fetchSitelinks: async (ids) => new Map(ids.filter((id) => around.sitelinks.has(id)).map((id) => [id, around.sitelinks.get(id)!])),
    fetchDetails: async (ids) => new Map(ids.filter((id) => details.has(id)).map((id) => [id, details.get(id)!])),
  };
}

async function lisbonBoard() {
  const out = await proposeFromOpenData({ envelope: { name: 'Lisbon', center: LISBON, scale: 'city' }, days: 4, priorities: ['history_and_culture'], carAvailable: false, reachKm: 30 }, recordedDeps());
  if (!out.ok) throw new Error(`no board: ${out.reason}`);
  return out;
}

describe('the recorded Lisbon answer', () => {
  it('reads every recorded row into details, with inception at its stated precision', () => {
    const details = detailsFromBindings(bindings);
    const tower = details.get('Q215003')!;
    expect(tower.description).toMatch(/fortified tower/);
    expect(tower.inception).toEqual({ year: 1515, precision: 9 });
    expect(tower.architects).toContain('Francisco de Arruda');
    expect(tower.heritage).toContain('part of UNESCO World Heritage Site');
  });

  it('describes real places in their own facts', async () => {
    const out = await lisbonBoard();
    const why = (name: string) => out.proposal.candidates.find((c) => c.name === name)?.why;
    expect(why('Belém Tower')).toBe(
      'Fortified tower located in the civil parish of Santa Maria de Belém in the municipality of Lisbon. Dates from 1515; Manueline style; designed by Francisco de Arruda; part of a UNESCO World Heritage Site.',
    );
    expect(why('Castle of Saint George')).toBe('Moorish castle in Lisbon. Listed as National Monument of Portugal.');
    expect(why('Calouste Gulbenkian Museum')).toBe('Art museum in Lisbon. Founded in 1969; designed by Rui Jervis Atouguia, Pedro Cid and others.');
    /* "building in Santa Maria de Belém, …" says where, not what: the label and the facts lead instead. */
    expect(why('Jerónimos Monastery')).toBe('Monastery — dates from 1502; Manueline and Renaissance style; designed by Nicolau Chanterene, Diogo de Boitaca and others; part of a UNESCO World Heritage Site.');
    /* Destroyed in 1755, and Wikidata says so: the label is the most important fact on the card. */
    expect(why('Ribeira Palace')).toBe('Destroyed building or structure — Manueline style.');
  });

  it('never prints provenance, distance or a fit clause as a description, and never one sentence on many cards', async () => {
    const out = await lisbonBoard();
    const whys = out.proposal.candidates.map((c) => c.why);
    for (const why of whys) expect(why).not.toMatch(/Wikidata|OpenStreetMap|km from|matches your interest|established names/);
    /* Labels ("Square") may repeat — they are not sentences and no surface prints them as one. */
    const sentences = whys.filter((w) => w.includes(' '));
    expect(new Set(sentences).size).toBe(sentences.length);
    /* A description four palaces shared ("building in Lisbon, Lisbon District, Portugal") leads none of them. */
    expect(whys.filter((w) => /^Building in /.test(w))).toEqual([]);
    expect(out.diagnostics.detailsAnswered).toBe(out.diagnostics.detailsAsked);
  });
});

describe('composition rules', () => {
  it('trims the administrative chain but keeps content clauses', () => {
    expect(tidyDescription('moorish castle in Lisbon, Lisbon District, Portugal')).toBe('Moorish castle in Lisbon');
    expect(tidyDescription('building in Lisbon, Lisbon District, Portugal')).toBeNull();
    expect(tidyDescription('a zoo in Lisbon, Portugal')).toBe('Zoo in Lisbon');
    expect(tidyDescription('palace in Santa Maria de Belém, Lisbon District, Portugal and official residence of the President of the Portuguese Republic')).toBe(
      'Palace in Santa Maria de Belém, Lisbon District, Portugal and official residence of the President of the Portuguese Republic',
    );
    expect(tidyDescription('Wikimedia disambiguation page')).toBeNull();
  });

  it('never states a date sharper than the source did', () => {
    expect(datePhrase({ year: 1147, precision: 9 })).toBe('1147');
    expect(datePhrase({ year: 1150, precision: 7 })).toBe('the 12th century');
    expect(datePhrase({ year: 1890, precision: 8 })).toBe('the 1890s');
    expect(datePhrase({ year: -200, precision: 9 })).toBe('200 BC');
    expect(parseInception('1515-01-01T00:00:00Z/9|1143-10-12T00:00:00Z/11')).toEqual({ year: 1143, precision: 11 });
    expect(parseInception('garbage')).toBeUndefined();
  });

  it('states only listings that are listings', () => {
    const base = { noun: 'castle', kind: 'castle_or_palace', tags: {} };
    expect(factsFor({ ...base, details: { id: 'Q1', heritage: ['heritage without legal protection', 'Pending classification monument'], architects: [], styles: [], instances: [] } })).toEqual([]);
    expect(factsFor({ ...base, tags: { heritage: '2', wheelchair: 'yes' } })).toEqual(['heritage-listed', 'step-free access is mapped']);
  });

  it('falls back to a bare label — never a filler sentence', () => {
    expect(composeDescription({ noun: 'fort', kind: 'historic_site', tags: {} }, null)).toBe('Fort');
    expect(composeDescription({ noun: 'place of worship', kind: 'religious_site', tags: {}, details: { id: 'Q1', heritage: [], architects: [], styles: ['baroque architecture'], instances: ['cultural heritage', 'church'] } }, null)).toBe('Church — baroque style.');
  });

  it('drops a description shared by two places in the pool', () => {
    const d = (id: string) => ({ id, description: 'square in Lisbon, Portugal', heritage: [], architects: [], styles: [], instances: ['square'] });
    const out = describePool([
      { key: 'a', noun: 'tourist attraction', kind: 'landmark', tags: {}, details: d('Q1') },
      { key: 'b', noun: 'tourist attraction', kind: 'landmark', tags: {}, details: d('Q2') },
    ]);
    expect([...out.values()]).toEqual(['Square', 'Square']);
  });
});
