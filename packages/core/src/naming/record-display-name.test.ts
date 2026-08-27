import { describe, expect, it } from 'vitest';
import { resolveRecordDisplayName } from '../index';

/**
 * WHAT A CARD CALLS A RECORD WHOSE ALTERNATES CARRY NO LANGUAGE TAGS.
 *
 * The live regression these shapes are drawn from: an English-interface Tokyo
 * board rendered "Zoo de Ueno", "Cimetière d'Aoyama", "Parc Yoyogi", "Parque
 * Shinkiba" and "Parc national pour l'étude de la nature" — each record holding
 * a source-published English name that lost to a *shorter* French or Spanish
 * alternate, because the picker ordered Latin-script candidates by length and
 * knew nothing about language.
 *
 * The fixtures below are shapes, not places — invented names with the exact
 * alternate structure the live records had. The pack's normaliser keeps only
 * the values of the source's language-keyed name map, so every alternate here
 * is untagged, exactly as production sees them.
 */

describe('an English-shaped alternate outranks a shorter Romance one', () => {
  it('prefers the English zoo name over the shorter French "Zoo de …"', () => {
    /* The "Zoo de Ueno" shape: French alternate shortest, English longest. */
    const resolved = resolveRecordDisplayName({
      name: '青浜動物園',
      alternateNames: [
        'Aohama Zoological Gardens',
        'Zoológico Imperial de Aohama',
        'Zoo de Aohama',
        'あおはまどうぶつえん',
      ],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Zoological Gardens');
    /* §8.6: the native name is never erased — it stays secondary. */
    expect(resolved.local).toBe('青浜動物園');
    expect(resolved.canonical).toBe('青浜動物園');
    /*
     * No language is claimed for what leads: the alternate was untagged, and
     * surviving a refusal filter is not an identification of English.
     */
    expect(resolved.displayLanguage).toBeUndefined();
  });

  it('breaks a same-length tie away from the Romance alternate', () => {
    /* The "Parc Yoyogi" shape: "Parc X" and "X Park" tie on length, and the
     * old lexicographic tiebreak handed the heading to the French form. */
    const resolved = resolveRecordDisplayName({
      name: '桜木公園',
      alternateNames: ['Sakuragi Park', 'Parc Sakuragi', 'Parco Sakuragi', 'Parque Sakuragi'],
      source: 'test',
    });
    expect(resolved.display).toBe('Sakuragi Park');
    expect(resolved.local).toBe('桜木公園');
  });

  it('prefers the English name even when the Spanish one is shorter', () => {
    /* The "Parque Shinkiba" shape: two alternates only, Spanish shorter. */
    const resolved = resolveRecordDisplayName({
      name: '青浜緑道公園',
      alternateNames: ['Aohama Greenway', 'Parque Aohama'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Greenway');
    expect(resolved.local).toBe('青浜緑道公園');
  });

  it('refuses a hybrid alternate that mixes English words with Romance markers', () => {
    /* The "Parc national pour l'étude de la nature" shape: the only clean
     * English name is the *longest* candidate; a Spanish-English hybrid and a
     * French name are both shorter. */
    const resolved = resolveRecordDisplayName({
      name: '国立青浜自然研究園',
      alternateNames: [
        'Institute for Nature Study, National Museum of Aohama',
        'Institute for Nature Study, Museo Nacional de Aohama',
        "Parc national pour l'étude de la nature",
        'こくりつあおはましぜんけんきゅうえん',
      ],
      source: 'test',
    });
    expect(resolved.display).toBe('Institute for Nature Study, National Museum of Aohama');
    expect(resolved.local).toBe('国立青浜自然研究園');
  });
});

describe('honest fallbacks when no English-shaped alternate exists', () => {
  it('lets the local name lead as local rather than dressing a Romance name as the heading', () => {
    /*
     * A name the net can positively classify as another language is never the
     * display: a reader shown a French heading on an English surface believes
     * that is what the place is called. With nothing readable and unrefused,
     * the source's own name leads — as itself, in its own script.
     */
    const resolved = resolveRecordDisplayName({
      name: '青浜霊園',
      alternateNames: ['Cimetière de Aohama', 'あおはまれいえん'],
      source: 'test',
    });
    expect(resolved.display).toBe('青浜霊園');
    expect(resolved.local).toBeUndefined();
    expect(resolved.displayLanguage).toBeUndefined();
  });

  it('prefers a romanisation of the local name over a shorter French alternate', () => {
    /* The record publishes its own romanisation; the elided French form is
     * shorter and used to win on length alone. */
    const resolved = resolveRecordDisplayName({
      name: '青浜第二霊園',
      alternateNames: ['Cimetière d’Aohama', 'あおはまだいにれいえん', 'Aohama dai ni reien'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama dai ni reien');
    expect(resolved.local).toBe('青浜第二霊園');
  });

  it('passing the refusal filter is not a certificate of English', () => {
    /*
     * A Malay alternate trips no marker and may lead — which is the honest
     * outcome: the filter refuses what it can recognise as not-English, and
     * identifies nothing positively. (The fixture was once German, but the
     * net now reads German too, so the untouched language moved further out.)
     */
    const resolved = resolveRecordDisplayName({
      name: '青浜城',
      alternateNames: ['Istana Aohama', 'Château de Aohama'],
      source: 'test',
    });
    expect(resolved.display).toBe('Istana Aohama');
    expect(resolved.displayLanguage).toBeUndefined();
  });
});

describe('the refusal net reads German and Dutch, compounds included', () => {
  it('prefers the English freight-line name over the shorter German compound', () => {
    /*
     * The live shape: a freight rail line whose alternates carry a German
     * compound, the source's own English name, and two Romance forms. The
     * German name is two characters shorter, so shortest-first handed an
     * English board a German heading while "… Freight Line" sat unused.
     */
    const resolved = resolveRecordDisplayName({
      name: '青浜貨物線',
      alternateNames: [
        'Aohama-Güterlinie',
        'Aohama Freight Line',
        'Línea de carga Aohama',
        'Ligne de fret Aohama',
      ],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Freight Line');
    expect(resolved.local).toBe('青浜貨物線');
  });

  it('refuses the umlaut-transliterated spelling of the same compound', () => {
    /* Sources also publish 'ue' for 'ü'; both spellings must trip. */
    const resolved = resolveRecordDisplayName({
      name: '青浜貨物線',
      alternateNames: ['Aohama-Gueterlinie', 'Aohama Freight Line'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Freight Line');
  });

  it('keeps a Dutch compound off an English heading when anything cleaner exists', () => {
    /* The 'Speciaal natuurmonument …' class: Dutch shorter, English longer. */
    const resolved = resolveRecordDisplayName({
      name: '青浜原生地',
      alternateNames: ['Aohama Natuurmonument', 'Aohama Nature Reserve and Meadows'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Nature Reserve and Meadows');
    expect(resolved.local).toBe('青浜原生地');
  });

  it('never leads with a Germanic-only alternate: the local name stands as itself', () => {
    const resolved = resolveRecordDisplayName({
      name: '青浜大橋',
      alternateNames: ['Aohama-Brücke'],
      source: 'test',
    });
    expect(resolved.display).toBe('青浜大橋');
    expect(resolved.local).toBeUndefined();
    expect(resolved.displayLanguage).toBeUndefined();
  });
});

describe('the refusal net reads orthography, not vocabularies', () => {
  it('refuses a tone-marked Southeast-Asian alternate the word lists cannot see', () => {
    /*
     * The live shape: a palace record whose shortest Latin alternate was a
     * Vietnamese translation, led an anonymous share page under it. No word
     * list can catch it — every word is a proper noun to the net — but the
     * grave tone mark is not something English print writes.
     */
    const resolved = resolveRecordDisplayName({
      name: '青浜宮殿',
      alternateNames: ['Hoàng cung Aohama', 'The Aohama Imperial Residence'],
      source: 'test',
    });
    expect(resolved.display).toBe('The Aohama Imperial Residence');
    expect(resolved.local).toBe('青浜宮殿');
  });

  it('refuses an acute-accented Romance alternate whose words are all proper nouns', () => {
    /* The "Río …" shape: a Spanish variant two characters shorter than the
     * record's own English river name, no listed word anywhere in it. */
    const resolved = resolveRecordDisplayName({
      name: '旧青浜川',
      alternateNames: ['Río Kyu-Aohama', 'Kyu-Aohama River'],
      source: 'test',
    });
    expect(resolved.display).toBe('Kyu-Aohama River');
    expect(resolved.local).toBe('旧青浜川');
  });

  it('refuses a tone-marked transcription in favour of the plain romanisation', () => {
    const resolved = resolveRecordDisplayName({
      name: '青浜宝塔',
      alternateNames: ['Bǎotǎ', 'Aohama Pagoda'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Pagoda');
  });

  it('a diacritic-classified alternate with no rival leaves the local name leading as local', () => {
    const resolved = resolveRecordDisplayName({
      name: '青浜宮殿',
      alternateNames: ['Hoàng cung Aohama'],
      source: 'test',
    });
    expect(resolved.display).toBe('青浜宮殿');
    expect(resolved.local).toBeUndefined();
  });

  it('does not refuse the macron, which is how romanised long vowels arrive', () => {
    const resolved = resolveRecordDisplayName({
      name: '青浜川',
      alternateNames: ['Ōhama-gawa'],
      source: 'test',
    });
    expect(resolved.display).toBe('Ōhama-gawa');
    expect(resolved.local).toBe('青浜川');
  });

  it('does not refuse the diaeresis, which English borrowings keep', () => {
    const resolved = resolveRecordDisplayName({
      name: '青浜丘',
      alternateNames: ['Bürgel Hill'],
      source: 'test',
    });
    expect(resolved.display).toBe('Bürgel Hill');
    expect(resolved.local).toBe('青浜丘');
  });
});

describe('multi-value names split on the separator before selection', () => {
  it('selects one part of a semicolon-joined Latin primary instead of printing both', () => {
    /* The live shape: an amusement-park heading rendered as
     * "…Park;… (Park)" — the source's multi-value field, verbatim. */
    const resolved = resolveRecordDisplayName({
      name: 'Aohama Yuen Amusement Park;Aohama Yuen (Amusement Park)',
      alternateNames: [],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Yuen Amusement Park');
    /* Provenance keeps the source's field verbatim, selection does not. */
    expect(resolved.canonical).toBe('Aohama Yuen Amusement Park;Aohama Yuen (Amusement Park)');
    expect(resolved.local).toBeUndefined();
  });

  it('reads a mixed-script multi-value primary as a name and its own romanisation', () => {
    const resolved = resolveRecordDisplayName({
      name: '青浜園;Aohama-en',
      alternateNames: [],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama-en');
    expect(resolved.local).toBe('青浜園');
  });

  it('splits a multi-value alternate and refuses only the part that earns it', () => {
    const resolved = resolveRecordDisplayName({
      name: '青浜園',
      alternateNames: ['Parque Aohama;Aohama Gardens'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Gardens');
    expect(resolved.local).toBe('青浜園');
  });
});

describe('names the source positively tagged as English outrank everything', () => {
  it('prefers the tagged spelling over a collapse survivor’s variant primary', () => {
    /*
     * The brand shape: the linker's collapse kept a record whose Latin primary
     * carries a worse spelling, while the tagged English name — held by the
     * caller that still has the source's language-keyed map — carries the
     * canonical one. The tag wins; the variant is not paraded as a local name,
     * because loosely it is the same name.
     */
    const resolved = resolveRecordDisplayName({
      name: 'Aohama Wonder Land',
      alternateNames: ['あおはまワンダーランド'],
      englishNames: ['Aohama Wonderland'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Wonderland');
    expect(resolved.canonical).toBe('Aohama Wonder Land');
    expect(resolved.local).toBeUndefined();
  });

  it('a tagged English name beats refused alternates and keeps the native name beside it', () => {
    const resolved = resolveRecordDisplayName({
      name: '青浜宮殿',
      alternateNames: ['Hoàng cung Aohama'],
      englishNames: ['Aohama Palace'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Palace');
    expect(resolved.local).toBe('青浜宮殿');
  });
});

describe('the local slot refuses a third-script transcription', () => {
  it('omits the local clause when a collapse left a Korean transcription on top of a Latin-language place', () => {
    /*
     * The live shape, verbatim in structure: a national park whose collapse
     * survivor's only name was a Korean transcription, with the Latin twins —
     * carrying Icelandic's own thorn — inherited as alternates. The heading
     * resolved right; the card then said "Known locally as 싱벨리어 국립공원",
     * which is false (locals write Latin) and unreadable. The thorn in the
     * Latin renderings is the proof the local language writes Latin, so the
     * non-Latin primary is a transcription and the local clause is omitted.
     */
    const resolved = resolveRecordDisplayName({
      name: '싱벨리어 국립공원',
      alternateNames: ['Þingvellir', 'Þingvellir National Park', 'Thingvellir', 'Tingvellir'],
      source: 'test',
    });
    expect(resolved.display).toBe('Þingvellir');
    expect(resolved.local).toBeUndefined();
    /* Provenance is untouched: the record still matches its source. */
    expect(resolved.canonical).toBe('싱벨리어 국립공원');
  });

  it('keeps a genuine non-Latin local name when nothing anchors the place to Latin', () => {
    /*
     * The control: the same structural shape in a place whose language really
     * does write its own script. Plain-ASCII and mark-stripped alternates
     * (é → e, ü → u) anchor nothing, so the local clause stays.
     */
    const resolved = resolveRecordDisplayName({
      name: '青浜動物園',
      alternateNames: ['Müller-Zoo Aohama', 'Zoológico de Aohama', 'Aohama Zoological Gardens'],
      source: 'test',
    });
    expect(resolved.display).toBe('Müller-Zoo Aohama');
    expect(resolved.local).toBe('青浜動物園');
  });

  it('translation-fan letters do not anchor: a Vietnamese đ or German ß is not a local orthography', () => {
    /* Đền = "temple" in Vietnamese; a translation of a Japanese place. The
     * eszett arrives the same way. Neither may delete a true local name. */
    const resolved = resolveRecordDisplayName({
      name: '青浜神社',
      alternateNames: ['Đền Aohama', 'Aohama-Schloß', 'Aohama Shrine'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Shrine');
    expect(resolved.local).toBe('青浜神社');
  });
});

describe('a tie between alternates goes to the record’s own rendering, not the alphabet', () => {
  it('does not let a collapsed twin’s name contradict the record’s own local name', () => {
    /*
     * The live shape: two airport observation decks — North and South
     * Terminal — collapse into one record. The survivor is the South deck;
     * its own alternate renders it in English, and the twin's English name
     * arrives after it, tied on length to the letter. The lexicographic
     * tiebreak shipped a card headed "Observation Deck (North Terminal)"
     * whose own local name said 南 (South). Ties now keep arrival order, and
     * the caller puts the record's own alternates first — so the record
     * cannot be renamed to its neighbour by the alphabet.
     */
    const resolved = resolveRecordDisplayName({
      name: '展望デッキ (南ターミナル)',
      alternateNames: [
        'Observation Deck (South Terminal)',
        'Observation Deck (North Terminal)',
        '展望デッキ (北ターミナル)',
      ],
      source: 'test',
    });
    expect(resolved.display).toBe('Observation Deck (South Terminal)');
    expect(resolved.local).toBe('展望デッキ (南ターミナル)');
  });

  it('a genuinely shorter alternate still wins: length stays the first criterion', () => {
    /* The tie rule must not become a first-wins rule: "City of X" shapes
     * still lose to the bare form wherever the source listed them. */
    const resolved = resolveRecordDisplayName({
      name: '青浜市',
      alternateNames: ['City of Aohama', 'Aohama'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama');
  });
});

describe('shapes the language preference must not disturb', () => {
  it('an English primary is untouched, whatever the alternates say', () => {
    const resolved = resolveRecordDisplayName({
      name: 'Aohama Pavilion',
      alternateNames: ['Pavillon de Aohama', 'Pabellón de Aohama'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Pavilion');
    expect(resolved.local).toBeUndefined();
    expect(resolved.canonical).toBe('Aohama Pavilion');
  });

  it('a local-script record with no usable alternate stays in its script', () => {
    const bare = resolveRecordDisplayName({
      name: '白金自然教育園',
      alternateNames: [],
      source: 'test',
    });
    expect(bare.display).toBe('白金自然教育園');
    expect(bare.local).toBeUndefined();

    /* Kana-only alternates are not Latin script and change nothing. */
    const kanaOnly = resolveRecordDisplayName({
      name: '青浜神社',
      alternateNames: ['あおはまじんじゃ'],
      source: 'test',
    });
    expect(kanaOnly.display).toBe('青浜神社');
    expect(kanaOnly.local).toBeUndefined();
  });
});

/**
 * §8.6 / GROUP H — A HEADING IS A NAME, NOT AN INDEX ENTRY.
 *
 * ---
 *
 * **The live evidence class.** Three delivered boards and their itineraries,
 * 2026-08-26. A destination's largest attraction was carded, scheduled and
 * printed as three capital letters, because the alternate tier breaks ties on
 * *shortest* and an acronym is by construction the shortest string anyone
 * publishes for a place. Two cards led with a ward name in brackets after the
 * place's name — a catalogue's own row disambiguator — on cards whose next line
 * already printed the locality. And the acronym card's "known locally as"
 * clause held the entire joined field `"<local> / <roman> (<initials>)"`, so one
 * card printed a three-letter name at the top and a different, fuller name
 * underneath, neither of them the name the source published as the place's own.
 *
 * All three fall out of `resolveRecordDisplayName`, which is what every compiled
 * board card, itinerary stop and PDF heading resolves through.
 */
describe('§8.6 — an unreadable, abbreviated or borrowed heading', () => {
  it('splits a slash-joined name field instead of choosing between its halves', () => {
    const survivor = resolveRecordDisplayName({
      name: 'フェルンヴォルト遊園地 / Fernwold Fairground (FFG)',
      alternateNames: ['FFG', 'Fernwold Fairground'],
      source: 'test',
    });
    /* The readable half of the source's own primary leads... */
    expect(survivor.display).toBe('Fernwold Fairground');
    /* ...and the local slot is one name, not the joined field. */
    expect(survivor.local).toBe('フェルンヴォルト遊園地');
    /* Provenance keeps the field verbatim, so the record still matches. */
    expect(survivor.canonical).toBe('フェルンヴォルト遊園地 / Fernwold Fairground (FFG)');
  });

  it('prefers a spelled-out name over an initialism, whatever the lengths', () => {
    const resolved = resolveRecordDisplayName({
      name: '青浜近代美術館',
      alternateNames: ['AMMA', 'Aohama Museum of Modern Art'],
      source: 'test',
    });
    expect(resolved.display).toBe('Aohama Museum of Modern Art');
  });

  /**
   * REFUSAL RANKS, IT NEVER DELETES.
   *
   * The initialism test is a refusal signal like the language nets, and the
   * same rule applies: where the initialism is the only readable name the
   * record has, it still leads. Nothing is invented to replace it, and the
   * heading is not thrown back into a script the reader cannot read on the
   * strength of a rule about capitals.
   */
  it('still leads with an initialism when the record publishes nothing else readable', () => {
    const resolved = resolveRecordDisplayName({
      name: '青浜近代美術館',
      alternateNames: ['AMMA'],
      source: 'test',
    });
    expect(resolved.display).toBe('AMMA');
    expect(resolved.local).toBe('青浜近代美術館');
  });

  it('drops a bracket that only repeats what the card already prints', () => {
    const disambiguated = resolveRecordDisplayName({
      name: '湊野 (青浜市)',
      alternateNames: [],
      source: 'test',
      redundantParentheticals: ['青浜市中央区', '青浜市', '青浜府'],
    });
    expect(disambiguated.display).toBe('湊野');
    /* And the same bracket does not reappear as a local name. */
    expect(disambiguated.local).toBeUndefined();
    expect(disambiguated.canonical).toBe('湊野 (青浜市)');

    /* Full-width brackets are the same statement in another script's punctuation. */
    const fullWidth = resolveRecordDisplayName({
      name: '淀野河川公園（守川）',
      alternateNames: [],
      source: 'test',
      redundantParentheticals: ['守川市'],
    });
    expect(fullWidth.display).toBe('淀野河川公園');
  });

  /**
   * WHERE THE BRACKET CARRIES MEANING, IT STAYS — INCLUDING WHERE WE CANNOT
   * TELL.
   *
   * The strip is evidence-driven: it fires only on text the caller has shown to
   * be redundant. A bracket that distinguishes one thing from another — a
   * terminal, a wing, a numbered section — is the only thing separating two
   * cards, and a caller that passes no containment has established nothing, so
   * nothing is removed. Saying less is not the same as guessing less.
   */
  it('keeps a bracket that distinguishes one thing from another', () => {
    const distinguishing = resolveRecordDisplayName({
      name: '展望デッキ (南ターミナル)',
      alternateNames: ['Observation Deck (South Terminal)'],
      source: 'test',
      redundantParentheticals: ['青浜郡田尻町', '青浜府'],
    });
    expect(distinguishing.display).toBe('Observation Deck (South Terminal)');
    expect(distinguishing.local).toBe('展望デッキ (南ターミナル)');

    /* And with no containment supplied, nothing is stripped on that ground. */
    const unknown = resolveRecordDisplayName({
      name: 'Flatholm (fridland)',
      alternateNames: [],
      source: 'test',
    });
    expect(unknown.display).toBe('Flatholm (fridland)');
  });
});
