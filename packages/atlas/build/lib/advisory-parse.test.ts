/**
 * Advisory parsing, on saved real responses.
 *
 * `fixtures/advisories/*.json` are real answers from the U.S. State Department feed, the GOV.UK
 * Content API and Global Affairs Canada, saved on 2026-11-09 and reduced to the countries and
 * fields used here. The advisory text itself is untouched. If an authority rewords a page these
 * tests keep passing until the fixture is refreshed; that is the point of saving them.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON fixtures read through an untyped .mjs parser. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FIPS_TO_ISO, buildSnapshot, htmlBlocks, isoForName, parseCaAdvice, parseLead, parseScope, parseUkAdvice, parseUsAdvisory, parseUsTitle, resolveIdentity } from './advisory-parse.mjs';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/advisories/${name}.json`, import.meta.url), 'utf8'));
const usRows: any[] = fixture('us');
const ukDocs: Record<string, any> = fixture('uk');
const caDocs: Record<string, any> = fixture('ca');

const context = (iso: string, ...names: string[]) => ({ iso, names: new Set(names.map((name) => name.toLowerCase())) });
const us = (name: string, iso: string) => parseUsAdvisory(usRows.find((row) => row.Title.startsWith(`${name} `)), context(iso, name))!;
const uk = (slug: string, iso: string) => parseUkAdvice(ukDocs[slug], context(iso, ukDocs[slug].details.country.name));
const ca = (key: string, name: string) => parseCaAdvice(caDocs[key].index, caDocs[key].doc, context(key, name));

type Advisory = ReturnType<typeof us>;
const areas = (advisory: Advisory, level?: number) => advisory.regional.filter((entry: any) => level === undefined || entry.level === level).flatMap((entry: any) => entry.areas);
const named = (advisory: Advisory, level?: number) => areas(advisory, level).filter((area: any) => area.kind === 'place').map((area: any) => area.name);
const find = (advisory: Advisory, name: string) => areas(advisory).find((area: any) => area.name === name);
const borders = (advisory: Advisory) => areas(advisory).filter((area: any) => area.kind === 'border_zone');

describe('whole-country level 4', () => {
  it('U.S.: the title level covers the country, with no invented regions', () => {
    const libya = us('Libya', 'LY');
    expect(libya).toMatchObject({ level: 4, label: 'Level 4: Do Not Travel', wholeCountry: true });
    expect(libya.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(libya.regional).toEqual([]);
  });
  it('UK: the FCDO status says whole country; "to Belarus" is not a region', () => {
    expect(uk('belarus', 'BY')).toMatchObject({ level: 4, nationalLevel: 4, wholeCountry: true, regional: [], regionalUnparsed: false });
  });
  it('Canada: advisory-state 3 is level 4', () => {
    expect(ca('AF', 'Afghanistan')).toMatchObject({ level: 4, label: 'Avoid all travel', wholeCountry: true, regional: [], regionalUnparsed: false });
  });
  it('UK: a whole-country warning with a stated carve-out is not whole-country', () => {
    const sudan = uk('sudan', 'SD');
    expect(sudan.wholeCountry).toBe(false);
    expect(areas(sudan, 4)[0]).toMatchObject({ kind: 'rest_of_country' });
    expect(sudan.regional[0].exceptions[0]).toContain('Hala’ib Triangle');
    expect(named(sudan, 3)).toEqual(['Hala’ib Triangle', 'Bir Tawil Trapezoid']);
  });
  it('UK: a list of reasons after "including:" is not a list of places', () => {
    const list = [{ text: 'security incidents, such as drone attacks', children: [], notes: [] }];
    expect(parseLead('Russia due to the risks of its invasion of Ukraine, including:', list, context('RU', 'Russia')).areas).toEqual([{ kind: 'whole_country', name: 'Russia' }]);
  });
});

describe('regional level 4 inside a lower national level', () => {
  it('U.S. Philippines: the list under "Do Not Travel to:" keeps its places and its level', () => {
    const philippines = us('Philippines', 'PH');
    expect(philippines).toMatchObject({ level: 2, wholeCountry: true });
    expect(named(philippines, 4)).toEqual(expect.arrayContaining(['Sulu Archipelago', 'Marawi City']));
    expect(find(philippines, 'Marawi City')).toMatchObject({ within: 'Mindanao', type: 'city' });
  });
  it('U.S. Colombia: a list set as paragraphs is still a list', () => {
    const colombia = us('Colombia', 'CO');
    expect(named(colombia, 4)).toEqual(['Arauca', 'Cauca', 'Valle del Cauca', 'Norte de Santander']);
    expect(find(colombia, 'Cauca')).toMatchObject({ type: 'department', except: ['Popayán'] });
    expect(find(colombia, 'Valle del Cauca')).toMatchObject({ except: ['Cali'] });
  });
  it('Canada Mexico: a state list keeps each exception on its own state', () => {
    const mexico = ca('MX', 'Mexico');
    expect(mexico.level).toBe(2);
    expect(find(mexico, 'Chihuahua')).toMatchObject({ type: 'state', except: ['Chihuahua City'] });
    expect(find(mexico, 'Zacatecas')).toMatchObject({ except: ['the city of Zacatecas'] });
    expect(areas(mexico, 3).length).toBeGreaterThan(8);
  });
  it('UK Mexico: the national top is the regional top, and is not whole-country', () => {
    const mexico = uk('mexico', 'MX');
    expect(mexico).toMatchObject({ level: 3, nationalLevel: null, wholeCountry: false });
    const chihuahua = mexico.regional.find((entry: any) => entry.areas[0]?.name === 'Chihuahua');
    expect(chihuahua.areas[0]).toMatchObject({ type: 'state' });
    expect(chihuahua.exceptions[0]).toBe('the city of Chihuahua');
  });
  it('UK Chad: "the rest of Chad" sets the floor', () => {
    const chad = uk('chad', 'TD');
    expect(chad).toMatchObject({ level: 4, nationalLevel: 3, wholeCountry: false });
    expect(areas(chad, 3)).toEqual([expect.objectContaining({ kind: 'rest_of_country' })]);
  });
  it('UK Bolivia: a region of a department is the region, never the department', () => {
    expect(areas(uk('bolivia', 'BO'))[0]).toMatchObject({ name: 'Chapare', type: 'region', within: 'Cochabamba Department' });
  });
  it('UK Nigeria: a partitive governs every name in its list', () => {
    const delta = areas(uk('nigeria', 'NG'), 4).filter((area: any) => /riverine/.test(area.qualifier ?? ''));
    expect(delta.map((area: any) => area.name)).toEqual(['Delta', 'Bayelsa', 'Rivers', 'Akwa Ibom', 'Cross River']);
    expect(delta.every((area: any) => area.scope === 'part')).toBe(true);
  });
});

describe('border zones are strips, not places', () => {
  it('U.S. Tunisia: neighbour from a demonym, distance, exception', () => {
    expect(borders(us('Tunisia', 'TN'))[0]).toMatchObject({ kind: 'border_zone', neighbour: [{ name: 'Algeria', iso: 'DZ' }], distanceKm: 16 });
  });
  it('U.S. Israel: reads the metric figure of a two-unit distance', () => {
    expect(borders(us('Israel', 'IL'))[0]).toMatchObject({ neighbour: [{ iso: 'EG' }], distanceKm: 2.4 });
    expect(areas(us('Israel', 'IL')).find((area: any) => area.kind === 'proximity')).toMatchObject({ reference: 'Gaza Strip', distanceKm: 11.3 });
  });
  it('UK Algeria: "borders with:" + bullets is one strip per neighbour', () => {
    const zones = borders(uk('algeria', 'DZ')).filter((area: any) => area.distanceKm === 30);
    expect(zones.flatMap((area: any) => area.neighbour.map((n: any) => n.iso))).toEqual(expect.arrayContaining(['LY', 'MR', 'ML', 'NE', 'TN']));
  });
  it('UK Cameroon: a border exception stays on that border', () => {
    expect(borders(uk('cameroon', 'CM')).find((area: any) => area.neighbour[0]?.iso === 'NG')).toBeDefined();
    expect(uk('cameroon', 'CM').regional.find((entry: any) => entry.areas[0]?.neighbour?.[0]?.iso === 'NG' && entry.exceptions)?.exceptions[0]).toContain('Garoua');
  });
  it('UK Saudi Arabia: "FCDO advises against:" + bullets', () => {
    const saudi = uk('saudi-arabia', 'SA');
    expect(saudi).toMatchObject({ level: 4, nationalLevel: 3, wholeCountry: false });
    expect(borders(saudi)[0]).toMatchObject({ neighbour: [{ iso: 'YE' }], distanceKm: 10 });
  });
  it('Canada India: a strip "in the following states" never becomes the states', () => {
    const india = ca('IN', 'India');
    const strips = borders(india).filter((area: any) => area.distanceKm === 10);
    expect(strips.map((area: any) => area.within)).toEqual(['Gujarat', 'Punjab', 'Rajasthan']);
    expect(named(india, 4)).not.toContain('Gujarat');
  });
  it('Canada Honduras: an excluding list under a strip is its exceptions', () => {
    expect(borders(ca('HN', 'Honduras'))[0]).toMatchObject({ neighbour: [{ iso: 'GT' }], distanceKm: 20 });
    expect(borders(ca('HN', 'Honduras'))[0].except).toEqual(expect.arrayContaining(['Copán Ruinas']));
  });
  it('a land border with one named neighbour is not every border', () => {
    expect(parseScope('within 20km from the land border with Thailand', context('KH', 'Cambodia')).areas[0]).not.toHaveProperty('allBorders');
    expect(parseScope('within 25km of all of Eritrea’s land borders', context('ER', 'Eritrea')).areas[0]).toMatchObject({ allBorders: true, distanceKm: 25, neighbour: [] });
  });
  it('a stated distance in metres stays metres', () => {
    expect(parseScope('within 500m of the border with Gaza', context('IL', 'Israel')).areas[0]).toMatchObject({ kind: 'border_zone', distanceKm: 0.5 });
  });
});

describe('lists with "and", commas and parentheses', () => {
  it('U.S. Kenya: parentheses qualify their own county', () => {
    const kenya = us('Kenya', 'KE');
    expect(find(kenya, 'Tana River')).toMatchObject({ type: 'county', except: ['Tsavo National Park'] });
    expect(find(kenya, 'Kilifi')).toMatchObject({ type: 'county', scope: 'part', qualifier: 'north of highway C103' });
    expect(find(kenya, 'Garissa')).not.toHaveProperty('scope');
    expect(find(kenya, 'Turkana County')).toMatchObject({ scope: 'part', qualifier: 'western' });
    expect(find(kenya, 'Eastleigh')).toMatchObject({ within: 'Nairobi', type: 'neighbourhood' });
  });
  it('U.S. Nigeria: "(with the exception of …)" and "northern" are kept', () => {
    const nigeria = us('Nigeria', 'NG');
    expect(find(nigeria, 'Adamawa')).toMatchObject({ scope: 'part', qualifier: 'northern', type: 'state' });
    expect(find(nigeria, 'Rivers')!.except[0]).toContain('Port Harcourt');
  });
  it('U.S. Ethiopia: a region and a border in one bullet are two areas', () => {
    const entry = us('Ethiopia', 'ET').regional[0];
    expect(entry.areas).toEqual([expect.objectContaining({ kind: 'place', name: 'Tigray region' }), expect.objectContaining({ kind: 'border_zone', neighbour: [expect.objectContaining({ iso: 'ER' })] })]);
  });
  it('a compound name survives the splitter', () => {
    expect(parseScope('the Union Territory of Jammu and Kashmir', context('IN', 'India')).areas).toEqual([expect.objectContaining({ name: 'Jammu and Kashmir', type: 'territory' })]);
  });
  it('the two ends of a road are one thing', () => {
    expect(parseScope('the M16/H26 road between the cities of Ijevan and Noyemberyan', context('AM', 'Armenia')).areas).toEqual([expect.objectContaining({ kind: 'route' })]);
  });
  it('Canada Egypt: "This advisory excludes" reaches every entry of its container', () => {
    expect(ca('EG', 'Egypt').regional.find((entry: any) => entry.heading === 'Northern Sinai').exceptions[0]).toContain('Al Qantra');
  });
  it('a sentence it cannot read stays words and raises the flag', () => {
    const uneasy = parseScope('the areas south-west of road 45D', context('MX', 'Mexico'));
    expect(uneasy.areas).toEqual([{ kind: 'described', name: 'the areas south-west of road 45D' }]);
  });
  it('a location after a comma is never promoted to a warning of its own', () => {
    expect(parseScope('Limbé and the 35km stretch of the N3 road in Fako Division, South-West Region', context('CM', 'Cameroon')).areas.map((area: any) => area.name)).not.toContain('South-West Region');
    expect(parseScope('Bangoka International Airport, Kisangani', context('CD')).areas).toEqual([expect.objectContaining({ name: 'Bangoka International Airport', within: 'Kisangani' })]);
  });
});

describe('no regional advice, and silence', () => {
  it('U.S. Japan: nothing regional, nothing flagged', () => {
    expect(us('Japan', 'JP')).toMatchObject({ level: 1, regional: [], regionalUnparsed: false });
  });
  it('Canada Japan: the same', () => {
    expect(ca('JP', 'Japan')).toMatchObject({ level: 1, regional: [], regionalUnparsed: false });
  });
  it('UK France: no FCDO warning is a null level, never level 1', () => {
    expect(uk('france', 'FR')).toMatchObject({ level: null, nationalLevel: null, label: null, regional: [], regionalUnparsed: false });
  });
  it('U.S. Mexico: "Some areas have increased risk" with the list elsewhere is flagged, not read as none', () => {
    expect(us('Mexico', 'MX')).toMatchObject({ level: 2, regional: [], regionalUnparsed: true });
  });
  it('a UK sentence that refers to a warning does not make one', () => {
    const doc = { base_path: '/x', public_updated_at: '2026-01-01T00:00:00Z', details: { alert_status: [], parts: [{ slug: 'warnings-and-insurance', body: '<p>Attacks also happen in regions where FCDO advises against all travel, to the west.</p>' }] } };
    expect(parseUkAdvice(doc, context('XX')).regional).toEqual([]);
  });
});

describe('country identity', () => {
  it('reads every authority’s names', () => {
    for (const [name, iso] of [['Burma', 'MM'], ['The Bahamas', 'BS'], ['Côte d’Ivoire', 'CI'], ['Gambia, The', 'GM'], ['The Kyrgyz Republic', 'KG'], ['St Kitts and Nevis', 'KN'], ['Cape Verde', 'CV'], ['Turkey', 'TR'], ['Türkiye', 'TR'], ['Congo', 'CG'], ['Macau', 'MO'], ['USA', 'US'], ['Naoero', 'NR']]) expect(isoForName(name), name).toBe(iso);
  });
  it('the FIPS table is not read as ISO', () => {
    expect([FIPS_TO_ISO.get('CH'), FIPS_TO_ISO.get('AU'), FIPS_TO_ISO.get('IS'), FIPS_TO_ISO.get('UP')]).toEqual(['CN', 'AT', 'IL', 'UA']);
  });
  it('a page about part of a country never stands for the country', () => {
    expect(resolveIdentity('us', 'Gaza')).toMatchObject({ isos: ['PS'], part: 'Gaza' });
    expect(resolveIdentity('ca', 'IC')).toMatchObject({ isos: ['ES'], part: 'Canary Islands' });
    const snapshot = buildSnapshot({ us: { rows: [{ Title: 'Gaza - Level 4: Do Not Travel', Summary: '', Updated: '2026-01-01', Link: 'x' }] }, uk: null, ca: null }, { fetchedAt: 'now' });
    expect(snapshot.countries.PS.advisories[0]).toMatchObject({ subject: 'Gaza', level: 4, wholeCountry: false, nationalLevel: null });
  });
  it('lists what it cannot map instead of dropping it', () => {
    const snapshot = buildSnapshot({ us: { rows: [{ Title: 'Atlantis - Level 1: Exercise Normal Precautions', Summary: '' }] }, uk: null, ca: null }, {});
    expect(snapshot.unmapped.us).toEqual(['Atlantis']);
    expect(snapshot.countries).toEqual({});
  });
  it('parses the feed title', () => {
    expect(parseUsTitle('Mexico Travel Advisory - Level 2: Exercise Increased Caution')).toEqual({ name: 'Mexico', level: 2, label: 'Level 2: Exercise Increased Caution' });
  });
});

describe('html', () => {
  it('keeps depth for lists nested inside and beside an item, and decodes entities', () => {
    const blocks = htmlBlocks('<ul><li>Chiapas, excluding:</li><ul><li>Palenque</li></ul><li>Nuevo Le&oacute;n</li></ul>');
    expect(blocks.map((block: any) => [block.depth, block.text])).toEqual([[1, 'Chiapas, excluding:'], [2, 'Palenque'], [1, 'Nuevo León']]);
  });
});
