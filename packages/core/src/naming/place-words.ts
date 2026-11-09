/**
 * THE WORDS A SENTENCE USES FOR PLACES, AS LANGUAGE DATA.
 *
 * Reading "Thai islands", "US national parks", "a Himalayan trek" or "Nice
 * beaches" is a question about English, not about any destination: which
 * adjective belongs to which country, which short form is a country, which
 * place names are also ordinary words. These tables answer that and nothing
 * else. They carry no opinion about a place — nothing here ranks, scores,
 * filters or special-cases a destination — which is why they live with the
 * naming code and not in the atlas, whose guard against destination-specific
 * rules they would otherwise (rightly) trip.
 *
 * A demonym maps to an ISO 3166-1 code and the atlas finds the country row for
 * it; a region adjective maps to the region's own name and is resolved like any
 * typed name. Adding a row teaches the reader a word; it cannot change a result
 * except by letting a named place be recognised.
 */

/**
 * English words that are also place names. As a single word they are words,
 * whatever their case — "Desert trip in July" opens with a capital and names no
 * desert, and "Eastern European" is not the East of England.
 */
export const ORDINARY_WORDS = new Set(
  'nice bath split reading mobile orange hue male man bar deal hell eagle sandy march may august june july april hope union surprise normal street ski surf trek hike cruise resort hotel food wine beer tea coffee market temple castle palace museum garden park forest river valley canyon glacier volcano reef cape bay point harbor harbour port fort mission rainbow sunrise sunset moon sun star light north south east west central upper lower new old big little great grand long short high low hot cold warm cool dry wet green blue red white black golden silver spring summer winter autumn fall beach lake island mountain coast desert jungle safari paradise'.split(
    ' ',
  ),
);
export const AMBIGUOUS_WORDS = new Set(
  'nice bath split reading mobile orange hue male man bar deal hell eagle sandy march may august june july april spring summer winter autumn fall beach lake island mountain coast desert jungle safari paradise hope union victoria georgia jordan chad turkey guinea java china cuba mali niger togo peru bali goa kent essex cork derby lima nancy tours bergen troy rugby buffalo phoenix mesa surprise normal rome paris florence venice sydney perth adelaide darwin wellington nelson hamilton windsor lincoln york boston oxford cambridge dover hull bury ware wells street ski surf trek hike cruise resort hotel food wine beer tea coffee market temple castle palace museum garden park forest river valley canyon glacier volcano reef cape bay point harbor harbour port fort mission rainbow sunrise sunset moon sun star light north south east west central upper lower new old big little great grand long short high low hot cold warm cool dry wet green blue red white black golden silver'.split(
    ' ',
  ),
);
/** Never a place on their own, in any case: directions, landforms, and words people open a sentence with. */
export const NEVER_ALONE = new Set(
  'eastern western northern southern central north south east west upper lower desert deserts mountain mountains island islands beach beaches lake lakes coast coasts jungle safari winter summer spring autumn fall thanks thank please hello tropical alpine remote wild hidden cheap luxury family solo first somewhere anywhere nature culture food hiking trekking skiing diving surfing volcano volcanoes glacier glaciers fjord fjords forest rainforest wildlife city cities town village villages country region honeymoon weekend week month year day night morning evening spring'.split(
    ' ',
  ),
);
/** Words that are a place's name in lower case only when the traveller plainly means it; decided by prominence. */
export const AMBIGUOUS_LOWER = AMBIGUOUS_WORDS;

/** Upper-case short forms a traveller writes for a country. */
export const COUNTRY_ACRONYMS: Record<string, string> = { US: 'US', USA: 'US', 'U.S.': 'US', 'U.S.A.': 'US', UK: 'GB', 'U.K.': 'GB', UAE: 'AE', NZ: 'NZ', DRC: 'CD' };

/** Adjectives and short forms of well-known regions, read as the region. */
export const REGION_ADJECTIVES: Record<string, string> = { amazon: 'Amazonia', himalayan: 'Himalayas', andean: 'Andes', patagonian: 'Patagonia', saharan: 'Sahara', amazonian: 'Amazon rainforest', balkan: 'Balkans', hawaiian: 'Hawaii', sicilian: 'Sicily', tuscan: 'Tuscany', bavarian: 'Bavaria', scandinavian: 'Scandinavia', pyrenean: 'Pyrenees', carpathian: 'Carpathian Mountains', tasmanian: 'Tasmania', balinese: 'Bali', alaskan: 'Alaska', californian: 'California', siberian: 'Siberia', tibetan: 'Tibet', kashmiri: 'Kashmir', cretan: 'Crete', corsican: 'Corsica', sardinian: 'Sardinia', andalusian: 'Andalusia', provencal: 'Provence', caucasian: 'Caucasus' };

/** A nationality or language adjective, as the country it names. */
export const DEMONYMS: Record<string, string> = {
  thai: 'TH', greek: 'GR', japanese: 'JP', italian: 'IT', french: 'FR', spanish: 'ES', swiss: 'CH', norwegian: 'NO', icelandic: 'IS', indonesian: 'ID', indian: 'IN', mexican: 'MX', peruvian: 'PE', moroccan: 'MA', turkish: 'TR', portuguese: 'PT', croatian: 'HR', vietnamese: 'VN', chinese: 'CN', nepali: 'NP', nepalese: 'NP', kenyan: 'KE', tanzanian: 'TZ', canadian: 'CA', australian: 'AU', brazilian: 'BR', chilean: 'CL', argentine: 'AR', argentinian: 'AR', egyptian: 'EG', jordanian: 'JO', philippine: 'PH', filipino: 'PH', malaysian: 'MY', colombian: 'CO', austrian: 'AT', german: 'DE', irish: 'IE', scottish: 'GB', welsh: 'GB', swedish: 'SE', finnish: 'FI', danish: 'DK', dutch: 'NL', polish: 'PL', czech: 'CZ', hungarian: 'HU', romanian: 'RO', bulgarian: 'BG', albanian: 'AL', georgian: 'GE', armenian: 'AM', kyrgyz: 'KG', tajik: 'TJ', uzbek: 'UZ', kazakh: 'KZ', mongolian: 'MN', korean: 'KR', taiwanese: 'TW', cambodian: 'KH', laotian: 'LA', burmese: 'MM', omani: 'OM', namibian: 'NA', ugandan: 'UG', rwandan: 'RW', ethiopian: 'ET', malagasy: 'MG', ecuadorian: 'EC', bolivian: 'BO', cuban: 'CU', american: 'US', british: 'GB', english: 'GB', icelander: 'IS', slovenian: 'SI', montenegrin: 'ME', bosnian: 'BA', serbian: 'RS', pakistani: 'PK', bhutanese: 'BT', tunisian: 'TN',
};
