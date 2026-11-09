import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DATA_ATTRIBUTION,
  EDITORIAL_READING,
  OPEN_DATA_READING,
  SUGGESTED_READING,
  comparedSentence,
  documentationWord,
  formatCount,
  provenanceOf,
  provenanceShort,
  sourceReference,
} from './advisor-copy';
import { DataAttribution } from './DataAttribution';

/**
 * What a card says about where its reading came from is the difference between
 * a place a person wrote up and one nobody has checked. The wording is held
 * here so it cannot drift into a number, a field name or an identifier.
 */
describe('whose reading a card is', () => {
  it('says an editorial reading is ours and adds no caveat about documentation', () => {
    expect(provenanceOf({ basis: 'editorial', confidence: 0.9, suggested: false })).toEqual({ reading: EDITORIAL_READING, documentation: null, suggested: null });
  });

  it('says an open-data reading was not checked by an editor, with how much the sources say', () => {
    expect(provenanceOf({ basis: 'open_data', confidence: 0.8, suggested: false })).toEqual({ reading: OPEN_DATA_READING, documentation: 'well documented', suggested: null });
    expect(provenanceOf({ basis: 'open_data', confidence: 0.6, suggested: false }).documentation).toBe('moderately documented');
    expect(provenanceOf({ basis: 'open_data', confidence: 0.3, suggested: false }).documentation).toBe('thinly documented');
  });

  it('puts the documentation thresholds exactly where they were specified', () => {
    expect(documentationWord(0.75)).toBe('well documented');
    expect(documentationWord(0.7499)).toBe('moderately documented');
    expect(documentationWord(0.55)).toBe('moderately documented');
    expect(documentationWord(0.5499)).toBe('thinly documented');
  });

  it('says when a research model proposed the place, whatever its reading is', () => {
    expect(provenanceOf({ basis: 'open_data', confidence: 0.6, suggested: true }).suggested).toBe(SUGGESTED_READING);
    expect(provenanceOf({ basis: 'editorial', confidence: 0.9, suggested: true })).toEqual({ reading: EDITORIAL_READING, documentation: null, suggested: SUGGESTED_READING });
    /* A record that exists only because research proposed it is never passed off as ours. */
    const research = provenanceOf({ basis: 'research', confidence: 0.4, suggested: false });
    expect(research.suggested).toBe(SUGGESTED_READING);
    expect(research.reading).toBe(OPEN_DATA_READING);
    expect(research.documentation).toBe('thinly documented');
  });

  it('has a short form for a table cell', () => {
    expect(provenanceShort({ basis: 'editorial', confidence: 0.9, suggested: false })).toBe('Our own reading');
    expect(provenanceShort({ basis: 'open_data', confidence: 0.5, suggested: true })).toBe('Open data, thinly documented; suggested by a research model');
  });
});

describe('a stored reference, as something to show', () => {
  it('links a Wikivoyage guide by its title, spaces as underscores and the rest encoded', () => {
    expect(sourceReference('Wikivoyage: Hunza Valley')).toEqual({ text: 'Wikivoyage: Hunza Valley', href: 'https://en.wikivoyage.org/wiki/Hunza_Valley', generic: false });
    expect(sourceReference('Wikivoyage: Côte d’Azur').href).toBe(`https://en.wikivoyage.org/wiki/${encodeURIComponent('Côte_d’Azur')}`);
    expect(sourceReference('Wikivoyage: Trinidad/Tobago?x').href).toBe('https://en.wikivoyage.org/wiki/Trinidad%2FTobago%3Fx');
  });

  it('links a Wikidata record without showing its identifier', () => {
    const source = sourceReference('Wikidata: Q5469');
    expect(source.href).toBe('https://www.wikidata.org/wiki/Q5469');
    expect(source.text).toBe('Wikidata record');
    expect(source.text).not.toMatch(/Q\d/);
  });

  it('never builds a link from anything else', () => {
    expect(sourceReference('CHELSA climate normals 1981–2010')).toEqual({ text: 'CHELSA climate normals 1981–2010', href: null, generic: false });
    expect(sourceReference('Wikidata: javascript:alert(1)').href).toBeNull();
    expect(sourceReference('Lonely Planet: Norway').href).toBeNull();
  });
});

describe('counts and the read-out', () => {
  it('writes a count with thousands separators', () => {
    expect(formatCount(36512)).toBe('36,512');
    expect(formatCount(234)).toBe('234');
    expect(formatCount(-3)).toBe('0');
  });

  it('says how many were compared and how many were read closely', () => {
    expect(comparedSentence({ catalog: 36512, considered: 600 })).toBe('We compared 36,512 destinations and read 600 closely.');
    /* A list stored before the count existed claims nothing about it. */
    expect(comparedSentence({ catalog: 234, considered: 0 })).toBe('We compared 234 destinations.');
    expect(comparedSentence({ catalog: 234, considered: 234 })).toBe('We compared 234 destinations and read every one closely.');
  });
});

describe('the data attribution line', () => {
  it('reads exactly as the licence line is written, with the licence linked', () => {
    const html = renderToStaticMarkup(createElement(DataAttribution, {}));
    const text = html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
    expect(text).toBe(DATA_ATTRIBUTION);
    expect(html).toContain('href="https://creativecommons.org/licenses/by-sa/4.0/"');
    expect(html).toContain('data-testid="advisor-attribution"');
    for (const anchor of html.match(/<a [^>]+>/g) ?? []) expect(anchor).toContain('rel="noopener noreferrer"');
  });
});
