/**
 * Atlas stage 01 — wikitext helpers and the article parser.
 *
 * Every fixture below is a snippet copied from the English Wikivoyage dump
 * (the article is named beside it), trimmed for length and nothing else. They
 * are the constructs that actually broke a first attempt, not a tour of
 * MediaWiki syntax.
 */
import { describe, expect, it } from 'vitest';

import { classify, parseArticle, sectionKey } from '../01-wikivoyage.mjs';
import {
  articleLinkTargets,
  decodeXmlEntities,
  firstSentence,
  parseTemplate,
  scanTemplates,
  splitSections,
  toArticleTitle,
  toPlainText,
} from './wikitext.mjs';

describe('decodeXmlEntities', () => {
  it('decodes the export layer in one pass, leaving the wikitext its own entities', () => {
    // Kyrgyzstan, as the dump stores it: the wikitext says `&mdash;`.
    const xml = '* {{marker|name=[[Bishkek]]}} &amp;mdash; The capital &lt;!-- note --&gt; &quot;Frunze&quot; &#39;til 1991';
    expect(decodeXmlEntities(xml)).toBe(`* {{marker|name=[[Bishkek]]}} &mdash; The capital <!-- note --> "Frunze" 'til 1991`);
    // A second pass would have turned this into a real `<`.
    expect(decodeXmlEntities('5 &amp;lt; 6')).toBe('5 &lt; 6');
  });
});

describe('scanTemplates', () => {
  // Alps: a unit template inside a Regionlist parameter.
  const alps = `{{Regionlist
| region1name=[[Swiss Alps]]
| region1items=[[Bernese Highlands]], [[Valais]], and [[Graubünden]]
| region1description=The highest point is Monte Rosa which rises to {{m|4,634}} above sea level.
}}
{{mapshape|type=geoshape|fill=#cfd48c|title=[[Swiss Alps]]|wikidata=Q25220}}`;

  it('finds nested templates and reports their depth', () => {
    const found = scanTemplates(alps).map((t) => [t.name, t.depth]);
    expect(found).toEqual([
      ['regionlist', 0],
      ['m', 1],
      ['mapshape', 0],
    ]);
  });

  it('does not let a stray, never-closed {{ hide the templates after it', () => {
    const found = scanTemplates('Price {{ per night.\n{{usableruralarea}}\n{{isPartOf|Nordland}}\n{{geo|68.333056|14.666389|zoom=8}}');
    expect(found.map((t) => [t.name, t.depth])).toEqual([
      ['usableruralarea', 0],
      ['ispartof', 0],
      ['geo', 0],
    ]);
  });
});

describe('parseTemplate', () => {
  it('reads a multi-line listing, keeping empty parameters empty', () => {
    // Lofoten, "See".
    const see = scanTemplates(`* {{see
| name=Kollhellaren | alt= | url= | email=
| address= |lat=67.8422 | long=12.8263 | directions=south-west coast of Moskenesøya
| hours= | price=With guide only
|wikipedia= |wikidata=Q11981456
| content=A tall cave near the shoreline. Prehistoric paintings were discovered 1989.
}}`)[0];
    const t = parseTemplate(see.inner);
    expect(t.name).toBe('see');
    expect(t.named.name).toBe('Kollhellaren');
    expect(t.named.alt).toBe('');
    expect(t.named.lat).toBe('67.8422');
    expect(t.named.wikidata).toBe('Q11981456');
    expect(t.named.content).toMatch(/^A tall cave .* 1989\.$/);
  });

  it('does not split on the pipe of a link or of a nested template', () => {
    // Kyrgyzstan: a piped link inside a Regionlist name.
    const t = parseTemplate(
      'Regionlist| region3name=[[Ferghana Valley (Kyrgyzstan)|Kyrgyz section of the Ferghana Valley]]| region3description=Hotter, at {{convert|900|m|ft}}.',
    );
    expect(t.named.region3name).toBe('[[Ferghana Valley (Kyrgyzstan)|Kyrgyz section of the Ferghana Valley]]');
    expect(t.named.region3description).toBe('Hotter, at {{convert|900|m|ft}}.');
    // {{geo}} mixes positional and named parameters.
    expect(parseTemplate('geo|68.333056|14.666389|zoom=8')).toMatchObject({
      positional: ['68.333056', '14.666389'],
      named: { zoom: '8' },
    });
  });
});

describe('toPlainText', () => {
  it('reads the Lofoten lead: banner, image, bold external link, wikilinks', () => {
    const lead = `{{pagebanner|File:Moskenesøya banner.jpg|caption=}}

[[File:Moskenes Reinebringen lub 2025-07-21 img09 Aussicht.jpg|thumb|350px|Reine, a village in the Lofoten Islands, viewed from above|alt=]]

'''[http://www.lofoten.info/ Lofoten]''' is a group of islands in the northern part of [[Norway]]. With its small fishing villages nestled in [[fjords]], the archipelago is often described as one of the most scenic parts of Norway.`;
    expect(toPlainText(lead)).toBe(
      'Lofoten is a group of islands in the northern part of Norway. With its small fishing villages nestled in fjords, the archipelago is often described as one of the most scenic parts of Norway.',
    );
  });

  it('removes a file whose caption itself contains links, and a comment that splices two lines', () => {
    // Lofoten, "Towns": the comment hides the newline before the image.
    const text = `* {{marker|type=city|name=Henningsvær|lat=|long=|wikidata=Q1605649}} - a very pleasant village reached by a short bus ride from Svolvær.<!--
-->[[File:Henningsvaer Lofoten 22.06.2012 2.jpg|250px|thumbnail|Henningsvaer, seen from [[Svolvær]] ]]
* '''[[Værøy]]''' is a small island around six hours from [[Bodø]] by ferry. Several [[World Heritage Site]]s are nearby; see [[Nordland#Get in|how to arrive]].`;
    expect(toPlainText(text)).toBe(
      'Henningsvær - a very pleasant village reached by a short bus ride from Svolvær. Værøy is a small island around six hours from Bodø by ferry. Several World Heritage Sites are nearby; see how to arrive.',
    );
  });

  it('keeps a listing as "Name (alt). content" and drops every other template around it', () => {
    // Lofoten, "Sleep" — a dead-link tag follows the listing.
    const text = `* {{sleep |name=Kabelvåg Youth Hostel |alt=Vandrerhjem |url=http://www.hihostels.com/ |email= |lat= |long= |price= |content=There is no YHA hostel in Svolvær, but Kabelvåg has a great one, about {{km|5}} west
}} {{Dead link|date=October 2026 |bot=InternetArchiveBot }}

{{usableruralarea}}
{{isPartOf|Nordland}}
{{geo|68.333056|14.666389|zoom=8}}`;
    expect(toPlainText(text)).toBe(
      'Kabelvåg Youth Hostel (Vandrerhjem). There is no YHA hostel in Svolvær, but Kabelvåg has a great one, about 5 km west.',
    );
  });

  it('writes units as a reader sees them and never turns {{geo}} into prose', () => {
    // Karakoram Highway.
    expect(toPlainText('at an elevation of over {{m|4,800}} in the [[Khunjerab Pass]], {{convert|50|km|mi}} northwest')).toBe(
      'at an elevation of over 4,800 m in the Khunjerab Pass, 50 km northwest',
    );
    expect(toPlainText('* Mainland [[Norway]]\n\n{{geo|68.333056|14.666389|zoom=8}}')).toBe('Mainland Norway');
    expect(toPlainText('Entry costs {{EUR|12}}, about {{huf|4,800}}.')).toBe('Entry costs 12 EUR, about 4,800 HUF.');
  });

  it('drops tables, references and Kartographer JSON, whose braces look like template ends', () => {
    const text = `Buses run hourly.<ref name="bus">{{cite web|url=http://example.org|title=Timetable}}</ref>
<maplink zoom="9" text="map">{"type":"Feature","properties":{"stroke":"#f00"}}</maplink>
{| class="wikitable"
! Line !! Fare
|-
| 100 || kr 40
|}
The ferry is free.`;
    expect(toPlainText(text)).toBe('Buses run hourly. The ferry is free.');
  });

  it('renders a Regionlist as its regions and descriptions, and reads four quotes as an apostrophe', () => {
    // Kyoto, "Districts".
    const text = `{{Regionlist
|region1name=[[Kyoto/Central|Central]]
| region1color=#dde390
|region1description=Site of Nijō Castle and the stately grounds of the Imperial Palace.
|region2name=[[Kyoto/Arashiyama|Arashiyama]] (Western Kyoto)
|region2items=[[Sagano]]
|region2description=Set against the beautiful tree-covered hills of Arashiyama
}}`;
    expect(toPlainText(text)).toBe(
      'Central — Site of Nijō Castle and the stately grounds of the Imperial Palace. Arashiyama (Western Kyoto) (Sagano) — Set against the beautiful tree-covered hills of Arashiyama.',
    );
    // 's-Hertogenbosch: the first of four quotes is the apostrophe.
    expect(toPlainText("''''s-Hertogenbosch''', commonly known as '''Den Bosch''', is a city")).toBe(
      "'s-Hertogenbosch, commonly known as Den Bosch, is a city",
    );
  });
});

describe('splitSections', () => {
  it('folds subsections into their parent and tolerates spaced headings', () => {
    const text = `Lead.
==Understand==
Intro.
===Climate===
Mild.
====By season====
Wet in autumn.
===History===
Old.
== See ==
Sights.
=== [[Australia]] ===
Down under.`;
    const { lead, sections } = splitSections(text);
    expect(lead.trim()).toBe('Lead.');
    expect(sections.map((s) => [s.level, s.title])).toEqual([
      [2, 'Understand'],
      [3, 'Climate'],
      [4, 'By season'],
      [3, 'History'],
      [2, 'See'],
      [3, 'Australia'],
    ]);
    const body = (i: number) => text.slice(sections[i]!.bodyStart, sections[i]!.end).trim();
    expect(body(0)).toContain('Wet in autumn.');
    expect(body(0)).toContain('Old.');
    expect(body(0)).not.toContain('Sights.');
    expect(body(1)).toBe('Mild.\n====By season====\nWet in autumn.');
    expect(body(4)).toContain('Down under.');
  });
});

describe('links and sentences', () => {
  it('reads article titles from link targets and refuses everything that is not an article', () => {
    expect(
      articleLinkTargets(
        '[[Narvik]], [[Munich#Oktoberfest|the fest]], [[ipswich (Queensland)|Ipswich]], [[File:X.jpg|thumb|[[Reine]]]], [[Category:Norway]], [[w:Lofoten]], [[:de:Lofoten]], [[#See]], [[Wikivoyage:Star articles]]',
      ),
    ).toEqual(['Narvik', 'Munich', 'Ipswich (Queensland)', 'Reine']);
    expect(toArticleTitle('Bishkek_and_the_Northwest#See')).toBe('Bishkek and the Northwest');
  });

  it('ends the first sentence at a real sentence end', () => {
    expect(
      firstSentence('St. Anton am Arlberg is a village in Tyrol (pop. 2,400 in 2020). It is a ski resort.'),
    ).toBe('St. Anton am Arlberg is a village in Tyrol (pop. 2,400 in 2020).');
    // Kyrgyzstan: quotes and a parenthesis before the stop.
    expect(
      firstSentence(
        'Kyrgyzstan (Kyrgyz and Russian: Кыргызстан), a Central Asian country, is often called as the "Switzerland" of Central Asia due to its mountainous terrain. The country offers breathtaking landscapes.',
      ),
    ).toBe(
      'Kyrgyzstan (Kyrgyz and Russian: Кыргызстан), a Central Asian country, is often called as the "Switzerland" of Central Asia due to its mountainous terrain.',
    );
    expect(firstSentence(`${'word '.repeat(100)}end.`, 300).length).toBeLessThanOrEqual(300);
  });
});

describe('classify and sectionKey — the mapping measured on the dump', () => {
  it('reads type and status from the status template', () => {
    expect(classify(['pagebanner', 'usableruralarea', 'ispartof', 'geo'])).toMatchObject({ type: 'ruralarea', status: 'usable' });
    // `informative…` and `useable…` redirect to the `usable…` templates.
    expect(classify(['informativecity'])).toMatchObject({ type: 'city', status: 'usable' });
    expect(classify(['useablecity'])).toMatchObject({ type: 'city', status: 'usable' });
    // A star nomination banner is not a status; the guide tag beside it is.
    expect(classify(['starnomination', 'guideregion'])).toMatchObject({ type: 'region', status: 'guide' });
    // Pyhä-Luosto National Park carries both; the typed status wins.
    expect(classify(['extraregion', 'usablepark'])).toMatchObject({ type: 'park', status: 'usable' });
    expect(classify(['extraregion', 'ispartof'])).toMatchObject({ type: 'extraregion', status: null });
    expect(classify(['pagebanner', 'dab'])).toMatchObject({ type: 'disambiguation', status: null });
    // No atlas type for a railway station: kept as `other`, status preserved.
    expect(classify(['usablestation'])).toMatchObject({ type: 'other', status: 'usable' });
    expect(classify(['stub'])).toMatchObject({ type: 'other', status: 'stub' });
    expect(classify(['pagebanner', 'ispartof', 'geo'])).toMatchObject({ type: 'other', status: null, reason: 'no status template' });
  });

  it('sends a combined heading to one key and keeps logistics out of the body', () => {
    expect(sectionKey('See and do')).toBe('see');
    expect(sectionKey('Eat & drink')).toBe('eat');
    expect(sectionKey('Buy, eat and drink')).toBe('eat');
    expect(sectionKey('Get in and around')).toBe('getin');
    expect(sectionKey('Stay healthy')).toBe('staysafe');
    expect(sectionKey('Fees and permits')).toBe('body');
    expect(sectionKey('Walk')).toBe('body');
    expect(sectionKey('Go next')).toBeNull();
    expect(sectionKey('Connect')).toBeNull();
  });
});

describe('parseArticle', () => {
  // Lofoten and Kyrgyzstan, cut down to the constructs under test.
  const lofoten = `{{pagebanner|File:Moskenesøya banner.jpg|caption=}}
:''For other places with the same name, see [[Lofoten (disambiguation)]].''
'''Lofoten''' is a group of islands in the northern part of [[Norway]]. It is scenic.

==Towns==
{{mapframe}}
* {{marker|type=city|name=Svolvær|lat=|long=|wikidata=Q145948}} — the largest settlement in the [[Lofoten]] archipelago.
* {{marker|type=city|name=[[Leknes]]|lat=68.147|long=13.611|wikidata=Q1993766}} — a crossroads.

==Other destinations==
* <!--{{marker|type=vicinity|name=Røst}} -->Røst – the southernmost island in the [[Lofoten]] archipelago.
* '''[[Værøy]]''' is a small island around six hours from [[Bodø]] by ferry.
* {{marker|name=[[Nordland#See|Trollfjord]]|wikidata=Q1140383}} — a narrow fjord.

==Understand==
At 68°N it is well above the Arctic Circle.
===Climate===
Mild for the latitude, thanks to the Gulf Stream.

== See ==
The main attraction is its '''majestic scenery'''.
* {{see
| name=Kollhellaren | alt= | lat=67.8422 | long=12.8263
|wikidata=Q11981456
| content=A tall cave near the shoreline.
}}
* {{listing | type=see | name=[[Lofotr Viking Museum]] | lat= | long= | content=A reconstructed longhouse.}}

==Sleep==
* {{sleep |name=Svinøya Rorbuer |content=Excellent rorbuer.}}

== Cope ==
There are churches in the villages.

==Go next==
* [[Narvik]] — about the size of [[Bodø]], on the mainland.
* Mainland [[Norway]]

{{routebox
| majorr1=[[Harstad]]
}}

{{usableruralarea}}
{{isPartOf|Nordland}}

{{geo|68.333056|14.666389|zoom=8}}`;

  const { record } = parseArticle({ title: 'Lofoten', pageId: 20009, text: lofoten, qid: 'Q186822' });

  it('reads identity, hierarchy and coordinates', () => {
    expect(record).toMatchObject({
      title: 'Lofoten',
      pageId: 20009,
      qid: 'Q186822',
      type: 'ruralarea',
      status: 'usable',
      parent: 'Nordland',
      geo: { lat: 68.333056, lng: 14.666389, zoom: 8, source: 'geo' },
    });
    expect(record.headings).toEqual(['Towns', 'Other destinations', 'Understand', 'See', 'Sleep', 'Cope', 'Go next']);
  });

  it('drops the hatnote from the lead and files each section under its key', () => {
    expect(record.lead).toBe('Lofoten is a group of islands in the northern part of Norway. It is scenic.');
    expect(record.firstSentence).toBe('Lofoten is a group of islands in the northern part of Norway.');
    expect(record.sections.see).toBe(
      'The main attraction is its majestic scenery. Kollhellaren. A tall cave near the shoreline. Lofotr Viking Museum. A reconstructed longhouse.',
    );
    expect(record.sections.climate).toBe('Mild for the latitude, thanks to the Gulf Stream.');
    expect(record.sections.understand).toContain('Mild for the latitude');
    // Towns and Other destinations are "everything else"; Cope and Go next are not.
    expect(record.sections.body).toContain('Svolvær — the largest settlement');
    expect(record.sections.body).not.toContain('churches');
    expect(record.sections.body).not.toContain('Narvik');
  });

  it('counts listings and keeps the first sights with their coordinates', () => {
    expect(record.listings).toEqual({ see: 2, do: 0, eat: 0, drink: 0, sleep: 1, buy: 0, go: 0, other: 0 });
    expect(record.top.see).toEqual([
      { name: 'Kollhellaren', lat: 67.8422, lng: 12.8263, wikidata: 'Q11981456' },
      { name: 'Lofotr Viking Museum', lat: null, lng: null, wikidata: null },
    ]);
  });

  it('lists children by what opens a bullet, never by a link further along it', () => {
    // "Røst – … in the [[Lofoten]] archipelago" must not list Lofoten (itself),
    // and "[[Bodø]] by ferry" is not a destination of this page.
    expect(record.listed).toEqual({ regions: [], cities: ['Svolvær', 'Leknes'], other: ['Værøy'] });
    expect(record.listedDetail).toEqual([
      { group: 'cities', name: 'Svolvær', title: 'Svolvær', linked: false, anchor: null, wikidata: 'Q145948', lat: null, lng: null },
      { group: 'cities', name: 'Leknes', title: 'Leknes', linked: true, anchor: null, wikidata: 'Q1993766', lat: 68.147, lng: 13.611 },
      // A link into a section of another article: reported, not listed.
      { group: 'other', name: 'Trollfjord', title: 'Nordland', linked: true, anchor: 'See', wikidata: 'Q1140383', lat: null, lng: null },
    ]);
  });

  it('keeps every Go next link, and separately the ones that open a bullet', () => {
    expect(record.goNext).toEqual(['Narvik', 'Bodø', 'Norway', 'Harstad']);
    expect(record.goNextPrimary).toEqual(['Narvik']);
  });

  it('falls back to the mapframe centre and reads Regionlist children', () => {
    // Scandinavia (an extraregion with no {{geo}}) and Alps.
    const page = parseArticle({
      title: 'Alps',
      pageId: 807,
      text: `{{mapframe|63.01|13.98|zoom=4}}
The '''Alps''' are a range of mountains in [[Europe]].
==Regions==
{{Regionlist
| region1name=[[Swiss Alps]]
| region1items=[[Bernese Highlands]], [[Valais]], and [[Graubünden]]
| region2name= Austrian Alps
| region2items= [[Vorarlberg]], [[Tyrol]]
| region3name=[[Bavarian Alps]] (Germany)
}}
{{IsPartOf|Europe}}
{{extraregion}}`,
    }).record;
    expect(page.type).toBe('extraregion');
    expect(page.status).toBeNull();
    expect(page.geo).toEqual({ lat: 63.01, lng: 13.98, zoom: 4, source: 'mapframe' });
    // "Austrian Alps" is not linked: there is no such article to list.
    expect(page.listed.regions).toEqual(['Swiss Alps', 'Bavarian Alps']);
    expect(page.regionItems).toEqual(['Bernese Highlands', 'Valais', 'Graubünden', 'Vorarlberg', 'Tyrol']);
  });

  it('never throws on malformed markup', () => {
    const broken = "{{see|name=[[Unclosed|content={{nested\n==Heading\n[[File:x.jpg|thumb|[[a]]\n{|\n| cell\n'''''";
    expect(() => parseArticle({ title: 'Broken', pageId: 1, text: broken })).not.toThrow();
    expect(parseArticle({ title: 'Empty', pageId: 2, text: '' }).record).toMatchObject({ type: 'other', status: null, lead: '', geo: null });
  });
});
