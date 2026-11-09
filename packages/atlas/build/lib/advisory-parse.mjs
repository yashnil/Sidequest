/* eslint-disable no-control-regex -- \u0001–\u0003 are private placeholders that mask parentheses and abbreviations while a list is split. */
/**
 * TRAVEL ADVISORIES FROM SEVERAL AUTHORITIES, WITH THEIR REGIONAL SCOPE KEPT.
 *
 * Pure and deterministic: text in, records out. No network, no model, no clock. `advisories.mjs`
 * downloads and caches; this file reads what it saved.
 *
 * What an authority publishes is a national level and, very often, sentences that raise it for
 * part of the country ("Do Not Travel to: …", "FCDO advises against all travel to within 30km of
 * the border with …", a Canadian "Regional advisory"). The first snapshot kept only the national
 * level of one government, so a country whose warning concerns one border lost every destination
 * and a calm national level hid a do-not-travel region. This module keeps the sentences.
 *
 * Rules it holds to:
 *
 *   - Unknown ≠ false. An authority that publishes no warning has said nothing, not "safe": the
 *     FCDO has no level below "all but essential travel", so its level is `null`, never 1.
 *   - Never widen, never narrow. A place name is emitted only when the sentence names one; a
 *     direction ("western Turkana"), a parenthesis ("Kilifi (north of highway C103)") or an
 *     exception ("except the city of Chihuahua") is carried beside the name, not dropped.
 *   - A border strip is not a place. "within 20 km of the border with Colombia" is a
 *     `border_zone` with its neighbour and its distance, never a gazetteer name.
 *   - Whatever the parser could not turn into names is kept as text (`kind: 'described'`) and the
 *     advisory says so (`regionalUnparsed`), so a reader can treat it conservatively.
 *   - The identity of a country is a table, not a guess: every authority's own name or code is
 *     mapped to ISO 3166-1 alpha-2 below, and whatever is not in the table is listed, not dropped.
 */

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * Authorities and their reuse terms (read 2026-11-09; the quoted grant is the authority's wording)
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */

export const AUTHORITIES = {
  us: {
    name: 'U.S. Department of State',
    url: 'https://travel.state.gov/en/international-travel/travel-advisories.html',
    feed: 'https://cadataapi.state.gov/api/TravelAdvisories',
    licence: 'Public domain (work of the United States Government, 17 U.S.C. § 105)',
    licenceUrl: 'https://www.state.gov/copyright-information/',
    grant: '17 U.S.C. § 105(a): "Copyright protection under this title is not available for any work of the United States Government".',
    grantNote: 'state.gov and travel.state.gov refuse this build\'s user agent (HTTP 403), so the department\'s own copyright page could not be re-read on 2026-11-09; the determination rests on the statute. The feed itself (cadataapi.state.gov) answers without a key.',
    attribution: 'U.S. Department of State — travel.state.gov',
    scale: { 1: 'Level 1: Exercise Normal Precautions', 2: 'Level 2: Exercise Increased Caution', 3: 'Level 3: Reconsider Travel', 4: 'Level 4: Do Not Travel' },
  },
  uk: {
    name: 'UK Foreign, Commonwealth & Development Office',
    url: 'https://www.gov.uk/foreign-travel-advice',
    feed: 'https://www.gov.uk/api/content/foreign-travel-advice',
    licence: 'Open Government Licence v3.0',
    licenceUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    grant: 'GOV.UK Content API documentation and every GOV.UK page footer: "All content is available under the Open Government Licence v3.0, except where otherwise stated". The licence: "You are free to: copy, publish, distribute and transmit the Information; adapt the Information; exploit the Information commercially and non-commercially".',
    grantNote: 'Foreign travel advice pages carry no "otherwise stated" notice; the licence\'s exemptions (logos, personal data, third-party rights) do not touch advisory text. The Content API allows 10 requests a second per client; this build uses at most 4.',
    attribution: 'Contains public sector information licensed under the Open Government Licence v3.0. Source: Foreign, Commonwealth & Development Office, GOV.UK foreign travel advice.',
    scale: { 3: 'FCDO advises against all but essential travel', 4: 'FCDO advises against all travel' },
  },
  ca: {
    name: 'Global Affairs Canada',
    url: 'https://travel.gc.ca/travelling/advisories',
    feed: 'https://data.international.gc.ca/travel-voyage/index-alpha-eng.json',
    licence: 'Open Government Licence – Canada',
    licenceUrl: 'https://open.canada.ca/en/open-government-licence-canada',
    grant: 'open.canada.ca dataset "Country Travel Advice and Advisories" (bef2ebb3-ca9a-485f-aaff-5dc36eb89426, Global Affairs Canada) is published under the Open Government Licence – Canada: "You are free to: Copy, modify, publish, translate, adapt, distribute or otherwise use the Information in any medium, mode or format for any lawful purpose."',
    grantNote: 'The dataset\'s listed resources are the very JSON files this build reads. No rate limit is published; this build asks for at most 4 files a second and only for files the index says changed.',
    attribution: 'Contains information licensed under the Open Government Licence – Canada. Source: Global Affairs Canada, Travel Advice and Advisories.',
    scale: { 1: 'Take normal security precautions', 2: 'Exercise a high degree of caution', 3: 'Avoid non-essential travel', 4: 'Avoid all travel' },
  },
};

/** Authorities that were examined and are not in the snapshot, each with the reason. */
export const NOT_INCLUDED = {
  au: {
    name: 'Australia — Smartraveller (DFAT)',
    url: 'https://www.smartraveller.gov.au/destinations',
    reason: 'unreachable: every request to www.smartraveller.gov.au (destinations, /destinations-export, the RSS index, /copyright, robots.txt) timed out with no bytes on 2026-11-09, from this build\'s client and from a second independent reader, so neither a machine-readable feed nor the licence could be confirmed. Nothing was ingested.',
  },
  de: {
    name: 'Germany — Auswärtiges Amt open data',
    url: 'https://www.auswaertiges-amt.de/opendata/travelwarning',
    reason: 'structured (ISO codes, `warning` / `partialWarning` flags) but not an open licence: the interface terms permit reuse only when "Die entsprechenden Informationen werden jeweils komplett übernommen und über die Schnittstelle stets aktuell gehalten" (taken over complete and kept current through the interface) — a dated, reduced offline snapshot is neither — and restrict AI-assisted summarising and paid apps. Not ingested.',
  },
  nz: {
    name: 'New Zealand — SafeTravel (MFAT)',
    url: 'https://www.safetravel.govt.nz/destinations',
    reason: 'open (Crown copyright, "licensed under the Creative Commons Attribution 4.0 International licence", attribute the Ministry of Foreign Affairs and Trade in writing) but not structured: no feed or API was found, so it would mean scraping one HTML page per destination, and the level and any regional advice live in page prose. A worthwhile fourth authority; not built in this pass.',
  },
  ie: {
    name: 'Ireland — Department of Foreign Affairs',
    url: 'https://www.ireland.ie/en/dfa/overseas-travel/advice/',
    reason: 'refuses this build\'s user agent (HTTP 403), so whether it has a feed and on what terms could not be checked. Not ingested.',
  },
};

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * Countries: ISO 3166-1 alpha-2, the names authorities use for them, and demonyms for borders
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */

/** `ISO:Name|alias|alias`. The first name is the one the snapshot prints. XK (Kosovo) is user-assigned, as everywhere. */
const COUNTRY_ROWS = `
AD:Andorra;AE:United Arab Emirates|UAE;AF:Afghanistan;AG:Antigua and Barbuda;AI:Anguilla;AL:Albania;AM:Armenia;AO:Angola;AQ:Antarctica;AR:Argentina;
AS:American Samoa;AT:Austria;AU:Australia;AW:Aruba;AZ:Azerbaijan;BA:Bosnia and Herzegovina|Bosnia;BB:Barbados;BD:Bangladesh;BE:Belgium;BF:Burkina Faso;
BG:Bulgaria;BH:Bahrain;BI:Burundi;BJ:Benin;BL:Saint Barthélemy|Saint Barthelemy|St Barthélemy|Saint-Barthélemy;BM:Bermuda;BN:Brunei|Brunei Darussalam;BO:Bolivia;
BQ:Bonaire, Sint Eustatius and Saba|Caribbean Netherlands;BR:Brazil;BS:Bahamas|The Bahamas;BT:Bhutan;BW:Botswana;BY:Belarus;BZ:Belize;CA:Canada;
CD:Democratic Republic of the Congo|DRC|DR Congo|Democratic Republic of Congo|Democratic Republic of Congo (Kinshasa)|Congo (Kinshasa)|the DRC;
CF:Central African Republic|CAR;CG:Republic of the Congo|Republic of Congo|Congo|Congo (Brazzaville)|Republic of Congo (Brazzaville);CH:Switzerland;
CI:Côte d'Ivoire|Cote d'Ivoire|Ivory Coast|Côte d’Ivoire|Côte d'Ivoire (Ivory Coast);CK:Cook Islands;CL:Chile;CM:Cameroon;CN:China|Mainland China|People's Republic of China;
CO:Colombia;CR:Costa Rica;CU:Cuba;CV:Cabo Verde|Cape Verde;CW:Curaçao|Curacao;CY:Cyprus;CZ:Czechia|Czech Republic;DE:Germany;DJ:Djibouti;DK:Denmark|Kingdom of Denmark;
DM:Dominica;DO:Dominican Republic;DZ:Algeria;EC:Ecuador;EE:Estonia;EG:Egypt;EH:Western Sahara;ER:Eritrea;ES:Spain;ET:Ethiopia;FI:Finland;FJ:Fiji;
FK:Falkland Islands;FM:Federated States of Micronesia|Micronesia|Micronesia (FSM);FO:Faroe Islands;FR:France;GA:Gabon;GB:United Kingdom|UK|Great Britain;GD:Grenada;
GE:Georgia;GF:French Guiana;GH:Ghana;GI:Gibraltar;GL:Greenland;GM:Gambia|The Gambia|Gambia, The;GN:Guinea;GP:Guadeloupe;GQ:Equatorial Guinea;GR:Greece;
GS:South Georgia and the South Sandwich Islands;GT:Guatemala;GU:Guam;GW:Guinea-Bissau;GY:Guyana;HK:Hong Kong;HN:Honduras;HR:Croatia;HT:Haiti;HU:Hungary;
ID:Indonesia;IE:Ireland;IL:Israel;IN:India;IO:British Indian Ocean Territory;IQ:Iraq;IR:Iran;IS:Iceland;IT:Italy;JM:Jamaica;JO:Jordan;JP:Japan;KE:Kenya;
KG:Kyrgyzstan|Kyrgyz Republic|The Kyrgyz Republic;KH:Cambodia;KI:Kiribati;KM:Comoros;KN:Saint Kitts and Nevis|St Kitts and Nevis;
KP:North Korea|Democratic People's Republic of Korea|DPRK;KR:South Korea|Republic of Korea;KW:Kuwait;KY:Cayman Islands;KZ:Kazakhstan;LA:Laos;LB:Lebanon;
LC:Saint Lucia|St Lucia;LI:Liechtenstein;LK:Sri Lanka;LR:Liberia;LS:Lesotho;LT:Lithuania;LU:Luxembourg;LV:Latvia;LY:Libya;MA:Morocco;MC:Monaco;MD:Moldova;
ME:Montenegro;MF:Saint Martin|St Martin|French Saint Martin;MG:Madagascar;MH:Marshall Islands;MK:North Macedonia;ML:Mali;MM:Myanmar|Burma|Myanmar (Burma);MN:Mongolia;
MO:Macao|Macau|Macau SAR;MP:Northern Mariana Islands|Northern Marianas;MQ:Martinique;MR:Mauritania;MS:Montserrat;MT:Malta;MU:Mauritius;MV:Maldives;MW:Malawi;
MX:Mexico;MY:Malaysia;MZ:Mozambique;NA:Namibia;NC:New Caledonia;NE:Niger;NG:Nigeria;NI:Nicaragua;NL:Netherlands|The Netherlands;NO:Norway;NP:Nepal;
NR:Nauru|Naoero;NU:Niue;NZ:New Zealand;OM:Oman;PA:Panama;PE:Peru;PF:French Polynesia;PG:Papua New Guinea;PH:Philippines|The Philippines;PK:Pakistan;PL:Poland;
PM:Saint Pierre and Miquelon|St Pierre & Miquelon|Saint-Pierre-et-Miquelon;PN:Pitcairn Islands|Pitcairn Island;PR:Puerto Rico;
PS:Palestine|Palestinian Territories|The Occupied Palestinian Territories;PT:Portugal;PW:Palau;PY:Paraguay;QA:Qatar;RE:Réunion|Reunion;RO:Romania;RS:Serbia;
RU:Russia|Russian Federation;RW:Rwanda;SA:Saudi Arabia;SB:Solomon Islands;SC:Seychelles;SD:Sudan;SE:Sweden;SG:Singapore;
SH:Saint Helena, Ascension and Tristan da Cunha|St Helena, Ascension and Tristan da Cunha;SI:Slovenia;SK:Slovakia;SL:Sierra Leone;SM:San Marino;SN:Senegal;SO:Somalia;
SR:Suriname;SS:South Sudan;ST:São Tomé and Príncipe|Sao Tome and Principe|São Tomé and Principe;SV:El Salvador;SX:Sint Maarten|St Maarten;SY:Syria;
SZ:Eswatini|Swaziland;TC:Turks and Caicos Islands;TD:Chad;TG:Togo;TH:Thailand;TJ:Tajikistan;TK:Tokelau;TL:Timor-Leste|East Timor|Timor-Leste (East Timor);
TM:Turkmenistan;TN:Tunisia;TO:Tonga;TR:Türkiye|Turkey|Turkiye;TT:Trinidad and Tobago;TV:Tuvalu;TW:Taiwan;TZ:Tanzania;UA:Ukraine;UG:Uganda;
US:United States|USA|United States of America;UY:Uruguay;UZ:Uzbekistan;VA:Vatican City|Holy See;VC:Saint Vincent and the Grenadines|St Vincent and the Grenadines|Saint Vincent & the Grenadines;
VE:Venezuela;VG:British Virgin Islands;VI:U.S. Virgin Islands|Virgin Islands (U.S.);VN:Vietnam;VU:Vanuatu;WF:Wallis and Futuna;WS:Samoa;XK:Kosovo;YE:Yemen;
YT:Mayotte;ZA:South Africa;ZM:Zambia;ZW:Zimbabwe`;

/** How a border is usually named: "the Algerian border", "the Guatemalan border". Only where a neighbour is plausibly meant. */
const DEMONYM_ROWS = `
AF:Afghan;AL:Albanian;DZ:Algerian;AO:Angolan;AM:Armenian;AZ:Azerbaijani|Azeri;BD:Bangladeshi;BY:Belarusian;BJ:Beninese;BO:Bolivian;BR:Brazilian;BF:Burkinabe|Burkinabé;
MM:Burmese;BI:Burundian;KH:Cambodian;CM:Cameroonian;TD:Chadian;CN:Chinese;CO:Colombian;CD:Congolese;CI:Ivorian;DJ:Djiboutian;EC:Ecuadorian|Ecuadorean;EG:Egyptian;
SV:Salvadoran;ER:Eritrean;ET:Ethiopian;GE:Georgian;GH:Ghanaian;GT:Guatemalan;GN:Guinean;HT:Haitian;HN:Honduran;IN:Indian;ID:Indonesian;IR:Iranian;IQ:Iraqi;IL:Israeli;
JO:Jordanian;KZ:Kazakh;KE:Kenyan;KG:Kyrgyz;LA:Lao|Laotian;LB:Lebanese;LR:Liberian;LY:Libyan;MY:Malaysian;ML:Malian;MR:Mauritanian;MX:Mexican;MA:Moroccan;MZ:Mozambican;
NP:Nepalese|Nepali;NI:Nicaraguan;NE:Nigerien;NG:Nigerian;KP:North Korean;PK:Pakistani;PA:Panamanian;PG:Papua New Guinean;PY:Paraguayan;PE:Peruvian;PH:Philippine;RU:Russian;
RW:Rwandan;SA:Saudi;SN:Senegalese;RS:Serbian;SO:Somali;SS:South Sudanese;SD:Sudanese;SY:Syrian;TJ:Tajik;TZ:Tanzanian;TH:Thai;TG:Togolese;TN:Tunisian;TR:Turkish;
TM:Turkmen;UG:Ugandan;UA:Ukrainian;UZ:Uzbek;VE:Venezuelan;VN:Vietnamese;YE:Yemeni;ZM:Zambian;ZW:Zimbabwean`;

/** Lower-case, accents folded, punctuation to spaces, "St"/"St." read as "Saint", "&" as "and". */
export const normName = (name) =>
  String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/\bst\b\.?/g, 'saint')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const ISO_NAME = new Map();
const ISO_BY_NAME = new Map();
const ISO_BY_DEMONYM = new Map();
for (const row of COUNTRY_ROWS.replace(/\n/g, '').split(';')) {
  const [iso, names] = [row.slice(0, 2), row.slice(3).split('|')];
  ISO_NAME.set(iso, names[0]);
  for (const name of names) {
    const key = normName(name);
    if (ISO_BY_NAME.has(key) && ISO_BY_NAME.get(key) !== iso) throw new Error(`country name "${name}" is claimed by ${ISO_BY_NAME.get(key)} and ${iso}`);
    ISO_BY_NAME.set(key, iso);
  }
}
for (const row of DEMONYM_ROWS.replace(/\n/g, '').split(';')) for (const word of row.slice(3).split('|')) ISO_BY_DEMONYM.set(normName(word), row.slice(0, 2));

/** A country's ISO code from any of its listed names ("the" in front is ignored). Null when the table does not know it. */
export const isoForName = (name) => ISO_BY_NAME.get(normName(name)) ?? ISO_BY_NAME.get(normName(name).replace(/^the /, '')) ?? null;
const isoForDemonym = (word) => ISO_BY_DEMONYM.get(normName(word)) ?? null;

/**
 * Identities that are not one ISO country: a page about several territories is recorded under each
 * (`isos`), and a page about PART of an ISO country (`part`) is recorded under it as a warning that
 * covers only that part — never as the whole country's level.
 */
const SPECIAL_IDENTITY = {
  us: {
    gaza: { isos: ['PS'], part: 'Gaza' },
    'the west bank': { isos: ['PS'], part: 'West Bank' },
    'french west indies': { isos: ['GP', 'MQ', 'MF', 'BL'], subject: 'French West Indies' },
    bonaire: { isos: ['BQ'], part: 'Bonaire' },
    'saba and sint eustatius': { isos: ['BQ'], part: 'Saba and Sint Eustatius' },
  },
  uk: {
    'bonaire saint eustatius saba': { isos: ['BQ'] },
    'cook islands tokelau and niue': { isos: ['CK', 'TK', 'NU'], subject: 'Cook Islands, Tokelau and Niue' },
    'saint martin and saint barthelemy': { isos: ['MF', 'BL'], subject: 'St Martin and St Barthélemy' },
    'antarctica british antarctic territory': { isos: ['AQ'] },
  },
  /* Canada's index is keyed by ISO code; these are its keys that are not one ISO country. */
  ca: {
    'PT-20': { isos: ['PT'], part: 'Azores' },
    IC: { isos: ['ES'], part: 'Canary Islands' },
    IL: { isos: ['IL', 'PS'], subject: 'Israel and Palestine' },
  },
};

/** The ISO countries an authority's own identity stands for, or null when the tables do not know it. */
export function resolveIdentity(authority, identity) {
  const special = authority === 'ca' ? SPECIAL_IDENTITY.ca[identity] : SPECIAL_IDENTITY[authority]?.[normName(identity)];
  if (special) return { isos: special.isos, part: special.part ?? null, subject: special.subject ?? special.part ?? null };
  if (authority === 'ca') return ISO_NAME.has(identity) ? { isos: [identity], part: null, subject: null } : null;
  const iso = isoForName(identity);
  return iso ? { isos: [iso], part: null, subject: null } : null;
}

/**
 * The U.S. feed's `Category` is a FIPS 10-4 code, not ISO — "CH" is China, "AU" is Austria, "IS" is
 * Israel. Identity is resolved by NAME (above); this table is the cross-check, so a row whose name
 * and code disagree is reported instead of trusted. Codes the feed is known to get wrong against
 * FIPS itself (it sends GW for Guinea-Bissau, SR for Switzerland, TA for one Tonga row, A1–A3 for
 * its own groupings, IS for Gaza and the West Bank) simply show up in that report.
 */
const FIPS_ROWS =
  'AF:AF;AL:AL;AG:DZ;AQ:AS;AN:AD;AO:AO;AV:AI;AY:AQ;AC:AG;AR:AR;AM:AM;AA:AW;AS:AU;AU:AT;AJ:AZ;BF:BS;BA:BH;BG:BD;BB:BB;BO:BY;BE:BE;BH:BZ;BN:BJ;BD:BM;BT:BT;BL:BO;BK:BA;BC:BW;BR:BR;VI:VG;BX:BN;BU:BG;UV:BF;BM:MM;BY:BI;CV:CV;CB:KH;CM:CM;CA:CA;CJ:KY;CT:CF;CD:TD;CI:CL;CH:CN;CO:CO;CN:KM;CG:CD;CF:CG;CW:CK;CS:CR;IV:CI;HR:HR;CU:CU;UC:CW;CY:CY;EZ:CZ;DA:DK;DJ:DJ;DO:DM;DR:DO;EC:EC;EG:EG;ES:SV;EK:GQ;ER:ER;EN:EE;WZ:SZ;ET:ET;FK:FK;FO:FO;FJ:FJ;FI:FI;FR:FR;FG:GF;FP:PF;GB:GA;GA:GM;GG:GE;GM:DE;GH:GH;GI:GI;GR:GR;GL:GL;GJ:GD;GP:GP;GT:GT;GV:GN;PU:GW;GY:GY;HA:HT;HO:HN;HK:HK;HU:HU;IC:IS;IN:IN;ID:ID;IR:IR;IZ:IQ;EI:IE;IS:IL;IT:IT;JM:JM;JA:JP;JO:JO;KZ:KZ;KE:KE;KR:KI;KN:KP;KS:KR;KV:XK;KU:KW;KG:KG;LA:LA;LG:LV;LE:LB;LT:LS;LI:LR;LY:LY;LS:LI;LH:LT;LU:LU;MC:MO;MK:MK;MA:MG;MI:MW;MY:MY;MV:MV;ML:ML;MT:MT;RM:MH;MB:MQ;MR:MR;MP:MU;MX:MX;FM:FM;MD:MD;MN:MC;MG:MN;MJ:ME;MH:MS;MO:MA;MZ:MZ;WA:NA;NR:NR;NP:NP;NL:NL;NC:NC;NZ:NZ;NU:NI;NG:NE;NI:NG;NO:NO;MU:OM;PK:PK;PS:PW;PM:PA;PP:PG;PA:PY;PE:PE;RP:PH;PL:PL;PO:PT;QA:QA;RO:RO;RS:RU;RW:RW;SC:KN;ST:LC;RN:MF;TB:BL;VC:VC;WS:WS;SM:SM;TP:ST;SA:SA;SG:SN;RI:RS;SE:SC;SL:SL;SN:SG;NN:SX;LO:SK;SI:SI;BP:SB;SO:SO;SF:ZA;OD:SS;SP:ES;CE:LK;SU:SD;NS:SR;SW:SE;SZ:CH;SY:SY;TW:TW;TI:TJ;TZ:TZ;TH:TH;TT:TL;TO:TG;TN:TO;TD:TT;TS:TN;TU:TR;TX:TM;TK:TC;TV:TV;UG:UG;UP:UA;AE:AE;UK:GB;UY:UY;UZ:UZ;NH:VU;VE:VE;VM:VN;YM:YE;ZA:ZM;ZI:ZW;GZ:PS;WE:PS';
export const FIPS_TO_ISO = new Map(FIPS_ROWS.split(';').map((row) => row.split(':')));

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * HTML → blocks
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', deg: '°', szlig: 'ß', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ', oelig: 'œ', OElig: 'Œ', middot: '·', bull: '•', shy: '', zwj: '', zwnj: '', times: '×', frac12: '½' };
const COMBINING = { acute: '́', grave: '̀', circ: '̂', tilde: '̃', uml: '̈', cedil: '̧', ring: '̊', caron: '̌' };

/** Decodes the entities advisory pages actually use; an unknown one is left as written. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body in NAMED_ENTITIES) return NAMED_ENTITIES[body];
    const accent = /^([a-z])(acute|grave|circ|tilde|uml|cedil|ring|caron)$/i.exec(body);
    return accent ? (accent[1] + COMBINING[accent[2].toLowerCase()]).normalize('NFC') : whole;
  });
}

const squash = (text) => text.replace(/[\s\u00a0]+/g, ' ').trim();

/**
 * Flattens advisory HTML into the blocks a person reads: headings, paragraphs and list items, each
 * with the depth of the list it sits in (0 outside any list). Inline markup is dropped; nothing is
 * reordered. A second paragraph inside one list item is marked `cont`.
 */
export function htmlBlocks(html) {
  const blocks = [];
  let depth = 0;
  let tag = 'p';
  let buffer = '';
  let skip = null;
  const open = []; // per list depth: is an <li> currently open, and has it already produced a block?
  const flush = () => {
    const text = squash(decodeEntities(buffer));
    buffer = '';
    if (!text) return;
    const item = tag === 'li' ? open[depth] : null;
    blocks.push({ tag, depth: tag === 'li' ? depth : 0, text, ...(item?.used ? { cont: true } : {}) });
    if (item) item.used = true;
  };
  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|<!--[\s\S]*?-->/g;
  let last = 0;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (!skip) buffer += html.slice(last, match.index);
    last = pattern.lastIndex;
    if (!match[2]) continue;
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    if (skip) {
      if (closing && name === skip) skip = null;
      continue;
    }
    if (name === 'script' || name === 'style') {
      if (!closing) skip = name;
    } else if (name === 'ul' || name === 'ol') {
      flush();
      depth = Math.max(0, depth + (closing ? -1 : 1));
      if (!closing) open[depth] = null;
      tag = open[depth] ? 'li' : 'p';
    } else if (name === 'li') {
      flush();
      open[depth] = closing ? null : { used: false };
      tag = closing ? 'p' : 'li';
    } else if (/^h[1-6]$/.test(name)) {
      flush();
      tag = closing ? (open[depth] ? 'li' : 'p') : name;
    } else if (name === 'p' || name === 'div' || name === 'br' || name === 'section' || name === 'blockquote' || name === 'tr' || name === 'table') {
      flush();
      if (!/^h[1-6]$/.test(tag)) tag = open[depth] ? 'li' : 'p';
    }
  }
  if (!skip) buffer += html.slice(last);
  flush();
  return blocks;
}

/** The list items that hang under block `index`, as a tree by depth. Stops at the first block that is not a deeper list item. */
function itemsAfter(blocks, index, parentDepth) {
  const roots = [];
  const stack = [];
  let cursor = index + 1;
  for (; cursor < blocks.length; cursor += 1) {
    const block = blocks[cursor];
    if (block.tag !== 'li' || block.depth <= parentDepth) break;
    if (block.cont && stack.length > 0) {
      stack[stack.length - 1].node.notes.push(block.text);
      continue;
    }
    const node = { text: block.text, children: [], notes: [] };
    while (stack.length > 0 && stack[stack.length - 1].depth >= block.depth) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ depth: block.depth, node });
  }
  return { items: roots, next: cursor };
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * Scope text → areas
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */

const TYPE_WORDS =
  'states?|provinces?|regions?|departments?|count(?:y|ies)|districts?|governorates?|cit(?:y|ies)|towns?|villages?|municipalit(?:y|ies)|communes?|oblasts?|islands?|prefectures?|territor(?:y|ies)|neighbou?rhoods?|parish(?:es)?|cantons?|zones?|divisions?|wilayas?|atolls?|emirates?|republics?|townships?|sub-prefectures?|local government areas?|peninsulas?|archipelagos?|national parks?|camps?|settlements?|suburbs?|boroughs?|areas of';
const TYPE_PREFIX = new RegExp(`^(?:the )?((?:[\\p{L}’'()"“”-]+ ){0,4}?)(${TYPE_WORDS})(?: \\([^)]*\\))? of (?:the )?(.+)$`, 'iu');
const TYPE_SUFFIX_PLURAL = /^(.+?) (states|provinces|regions|departments|counties|districts|governorates|cities|towns|municipalities|communes|oblasts|islands|prefectures|territories|parishes|cantons|zones|divisions|neighbou?rhoods)$/i;
const TYPE_SUFFIX_SINGLE = /\b(state|province|region|department|county|district|governorate|city|town|municipality|commune|oblast|island|prefecture|territory|parish|canton|division|peninsula|archipelago|national park)$/i;
const SINGULAR = { counties: 'county', cities: 'city', municipalities: 'municipality', territories: 'territory', parishes: 'parish' };
const singular = (word) => {
  const lower = word.toLowerCase().replace('neighbor', 'neighbour');
  return SINGULAR[lower] ?? lower.replace(/s$/, '');
};

/** Compound proper names a list splitter must not cut at "and". Tokenisation only — it changes no advisory. */
const COMPOUND_NAMES = ['Jammu and Kashmir', 'Trinidad and Tobago', 'Bosnia and Herzegovina', 'Antigua and Barbuda', 'Andaman and Nicobar', 'Turks and Caicos', 'Dadra and Nagar Haveli', 'Wallis and Futuna', 'Saint Kitts and Nevis', 'St Kitts and Nevis', 'São Tomé and Príncipe'];

const DIRECTIONS = 'north|south|east|west|north-?east|north-?west|south-?east|south-?west|northern|southern|eastern|western|central|north-?eastern|north-?western|south-?eastern|south-?western|north-?central|south-?central|far[- ]north|far[- ]south|coastal|upper|lower|inner|outer|rural|remote|mainland';
/** A lower-case direction or "parts of" in front of a name: the warning covers part of the named place. */
const PART_PREFIX = new RegExp(`^(?:the )?((?:(?:${DIRECTIONS})(?:,? (?:and|or) (?:${DIRECTIONS}))? (?:parts?|areas?|regions?|half|portions?|sections?|districts?|provinces?) (?:of|in|within)|(?:certain|specific|some|several|many|other|certain other|remote|rural|parts?|areas?|portions?|sections?|districts?)(?: (?:parts?|areas?|districts?|regions?|provinces?))? (?:of|in|within)|(?:${DIRECTIONS})))\\s+(?:the )?(\\p{Lu}.*)$`, 'u');
/** Words a clean place name does not contain; their presence means the item describes rather than names. */
const DESCRIBING = /\b(areas?|parts?|rest|near|nearby|along|between|towards?|outside|around|surrounding|vicinity|beyond|except|excluding|including|where|which|that|all|any|other|certain|specific|some|remote|rural|informal|designated|located|following|above|below|borders?|bordering|within|off-limits|marked|immediately|directly|north of|south of|east of|west of|up to|from|leading|connecting|access|crossings?|unless|only|especially|particularly|waters?|coast of|kilomet(?:er|re)s?|km|miles?|roads?|highways?|routes?|motorways?|junction|corridor|stretch|line of control|refugee|military|tourist|demonstrations?|travel)\b/i;
const CONNECTORS = new Set(['of', 'de', 'del', 'la', 'las', 'los', 'el', 'al', 'and', 'du', 'des', 'the', 'da', 'do', 'dos', 'di', 'e', 'y', 'wa', 'bin', 'ibn', 'van', 'von', 'le', 'les', 'sur', 'en', 'a', 'd', 'l', 'na', 'ya', 'es', 'ash', 'ad', 'an', 'ar', 'as', 'az', 'et']);
const TYPE_TAIL = new RegExp(`^(?:${TYPE_WORDS}|city|town|valley|desert|sea|gulf|strip|heights|mountains?|river|lake|delta|coast|highlands?|plateau|basin|triangle|trapezoid|reserve|park|forest|special reserve|area|hill tracts|region|sar|administrative|autonomous|special|economic|national|international|airport)$`, 'i');
const ROUTE = /\b(roads?|highways?|motorways?|toll roads?|autopista|carretera|rail(?:way)? routes?|railway|route \d|routes \d|[A-Z]{1,2}-?\d{1,4}[A-Z]?\b(?: (?:road|highway|motorway))?)\b/;
const QUALIFIER_START = /^(?:in|within|from|to|between|along|near|up to|towards?|around|outside|beyond|north|south|east|west|north-?east|north-?west|south-?east|south-?west)\b(?! (?:Kivu|Sinai|Darfur|Kordofan|Korea|Macedonia|Sudan|Africa|Ossetia|Waziristan|Cotabato|Region|Province|Governorate|Department|State|District|County|Bank|Papua|Timor|Java|Nusa|Sumatra|Kalimantan|Sulawesi|Shewa|Wollo|Wollega|Gondar|Hararghe|Omo|Lebanon|Punjab|Bengal|Caribbean))/;

const stripThe = (text) => text.replace(/^(?:the|The)\s+/, '');
const tidy = (text) => squash(text).replace(/^[\s,;:–—-]+|[\s,;:.–—-]+$/g, '');
const KM = { m: 0.001, meter: 0.001, meters: 0.001, metre: 0.001, metres: 0.001, km: 1, kilometer: 1, kilometers: 1, kilometre: 1, kilometres: 1, mile: 1.609344, miles: 1.609344, mi: 1.609344 };
const DISTANCE = /(\d+(?:\.\d+)?)\s*-?\s*(km|kilomet(?:er|re)s?|miles?|mi|met(?:er|re)s?|m)\b/gi;

/** The place a typed lead sits in — "the Nairobi neighbourhoods of" → Nairobi — and nothing for "the Nigerian states of". */
function properLead(lead) {
  if (new RegExp(`\\b(?:${DIRECTIONS})\\b`, 'i').test(lead)) return '';
  const words = tidy(lead).split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3 || words.some((word) => /^(?:Union|Autonomous|Federal|Special|Capital|National|Administrative|Region)$/.test(word))) return '';
  if (!words.every((word) => /^\p{Lu}[\p{L}’']*$/u.test(word)) || words.some((word) => isoForDemonym(word))) return '';
  return words.join(' ');
}

/** The distance a phrase states, in kilometres. A phrase that gives both units is read in kilometres as written. */
function distanceKm(phrase) {
  const found = [...phrase.matchAll(DISTANCE)].map((match) => ({ value: Number(match[1]), unit: match[2].toLowerCase() }));
  if (found.length === 0) return null;
  const metric = found.find((entry) => KM[entry.unit] <= 1) ?? found[0];
  return Math.round(metric.value * KM[metric.unit] * 10) / 10;
}

/** Cuts the reason off a scope: "… due to crime", "… for any reason", "…, owing to". Parentheses are already masked. */
const REASON = /\s*[,;]?\s*(?:\b(?:due to|owing to|because of|because|as a result of|for any reason|given the|following (?:the|a|an|recent)|as there (?:is|are)|where there (?:is|are)|in response to|after (?:the|a)|as it is|even if|even when)\b|(?<!\b(?:St|Mt|Dr|Gen|Ft|No|Av|Ave))\.[”"]?\s+(?=\p{Lu})|\.$).*$/su;
const EXCEPTION = /\s*[,;(]?\s*\b(except(?:ing)?(?: for| at| to| in| on)?|excluding|with the exception of|other than|apart from|not including|but not|unless)\b:?\s*(.*)$/is;
const ELABORATION = /\s*[,;]?\s*\b(?:including|particularly|especially|specifically|in particular|notably|namely|such as|which includes?|also known as|known as|made up of|consisting of|comprising)\b:?\s*(.*)$/is;

function maskParens(text) {
  const held = [];
  const masked = text.replace(/\(([^()]*)\)/g, (_, inner) => {
    held.push(inner);
    return `\u0001${held.length - 1}\u0001`;
  });
  return { masked, held };
}
const unmask = (text, held) => text.replace(/\u0001(\d+)\u0001/g, (_, index) => `(${held[Number(index)]})`);
const maskOf = (text) => [...text.matchAll(/\u0001(\d+)\u0001/g)].map((match) => Number(match[1]));
const dropMasks = (text) => squash(text.replace(/\u0001\d+\u0001/g, ' '));

/** Splits "A, B and C" into its items. Parentheses are masked by the caller, compound names protected here. */
function splitPieces(text) {
  let guarded = text.replace(/,?\s+or\s+[“"]([^”"]+?),?[”"],?/g, ' ');
  COMPOUND_NAMES.forEach((name, index) => {
    guarded = guarded.split(name).join(`\u0002${index}\u0002`);
  });
  const parts = guarded.split(/(\s*;\s*(?:and\s+|or\s+)?|\s*,\s*(?:and\s+|or\s+|as well as\s+)?|\s+(?:and|or|as well as)\s+|\s*&\s*)/);
  const pieces = [];
  let separator = '';
  for (let index = 0; index < parts.length; index += 2) {
    const piece = tidy(parts[index].replace(/\u0002(\d+)\u0002/g, (_, held) => COMPOUND_NAMES[Number(held)]));
    if (index > 0) separator += parts[index - 1];
    if (!piece) continue;
    /* The separator is kept as written so that pieces which belong together can be put back exactly. */
    pieces.push({ text: piece, separator: pieces.length === 0 ? '' : separator });
    separator = '';
  }
  return pieces;
}
const splitList = (text) => splitPieces(text).map((piece) => piece.text);

/** Is this a name a gazetteer could be asked for: capitalised words, a few connectors, an optional kind of place? */
function isCleanName(text) {
  const name = stripThe(text);
  if (!/^[\p{Lu}]/u.test(name) && !/^\d+\s?\p{Lu}/u.test(name) && !/^(?:al|el|as|ad|an|ar|ash|az)-\p{L}/iu.test(name)) return false;
  if (name.length > 70 || DESCRIBING.test(name) || /[:;!?“”"]/.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 8) return false;
  return words.every((word, index) => {
    const bare = word.replace(/[’'.,-]/g, '');
    if (bare === '') return true;
    if (/^\p{Lu}/u.test(word) || /^\d/.test(word) || /^[dlDL][’']\p{L}/u.test(word)) return true;
    if (index > 0 && CONNECTORS.has(bare.toLowerCase())) return true;
    return index > 0 && TYPE_TAIL.test(bare);
  });
}

/** The neighbours a border phrase names, each resolved to an ISO country when it is one. The page's own country is left out. */
function neighboursOf(reference, context) {
  const own = context?.iso ?? null;
  const candidates = [];
  const clean = dropMasks(reference);
  const push = (list) => {
    for (const raw of splitList(list)) {
      let name = tidy(stripThe(raw.replace(/\b(?:land |international |entire |shared )?borders?\b.*$/i, '')));
      const typed = isoForName(name) ? null : TYPE_PREFIX.exec(name);
      if (typed) name = tidy(typed[3]);
      name = tidy(name.replace(/^(?:all of |neighbou?ring |the )+/i, '').replace(/(?:’s|'s)$/, ''));
      if (name) candidates.push({ name, strict });
    }
  };
  let strict = false;
  const tail = (text) => text.replace(/\s+(?:in|between|from|up to|where|which|that|at|on|north|south|east|west|towards?)\b.*$/s, '');
  const withList = /\b(?:borders?|boundar(?:y|ies)|frontiers?)(?: areas?| regions?| zones?| lines?)?\s+(?:with|of)\s+(.+)$/is.exec(clean);
  const between = /\bborders?(?: areas?| regions?)?\s+between\s+(.+)$/is.exec(clean);
  const bordering = /\b(?:bordering|that border|which border|adjacent to|neighbou?ring)\s+(.+)$/is.exec(clean);
  strict = Boolean(between);
  if (between) push(between[1].replace(/\s+(?:in|from|up to|where|which|that|at|on)\b.*$/s, ''));
  else if (withList) { strict = false; push(tail(withList[1])); }
  else if (bordering) push(tail(bordering[1]));
  const before = /((?:\p{Lu}[\p{L}’'.]*(?:\s+(?:and|of|the|d’|d'))?[\s–/-]*)+?)(?:’s|'s)?\s*(?:[–/-]\s*)?(?:(?:entire|international|land|eastern|western|northern|southern|other|shared)\s+)*(?:borders?|frontiers?)\b/u.exec(clean);
  /* Words in FRONT of "border" count only when they are a country or its adjective: "the Algerian border", never "The border". */
  strict = true;
  if (before) push(before[1].replace(/[–/]/g, ', ').replace(/\b-\b/g, ', '));
  const seen = new Set();
  const neighbours = [];
  for (const { name, strict: needsCountry } of candidates) {
    const iso = isoForName(name) ?? isoForDemonym(name);
    if ((iso && iso === own) || seen.has(iso ?? normName(name))) continue;
    if (!iso && (needsCountry || !isCleanName(name))) continue;
    seen.add(iso ?? normName(name));
    neighbours.push(iso ? { name: ISO_NAME.get(iso), iso } : { name });
  }
  return neighbours;
}

const WITHIN_ZONE = /^(.*?)\s*[,;]?\s*(?:\b(?:the |all |any )?(?:areas?|zones?|regions?|locations?|land) (?:that (?:is|are) )?)?(?:\bto )?\bwithin (?:a |an )?(?:radius of )?(?:approximately |about |roughly )?(\d+(?:\.\d+)?\s*-?\s*(?:km|kilomet(?:er|re)s?|miles?|mi|met(?:er|re)s?|m)\b(?:\s*(?:\/|or|\u0001\d+\u0001)\s*(?:\d+(?:\.\d+)?\s*-?\s*(?:km|kilomet(?:er|re)s?|miles?|mi)\b)?)?)\s*(?:radius )?(?:of|from)\s+(.+)$/is;
const BORDER_WORD = /\b(?:borders?|bordering|frontiers?|boundary lines?|administrative boundary|line of control)\b/i;
/** A phrase that IS a border ("the Yemen border area", "areas bordering Eritrea"), as against one that merely mentions it. */
const BORDER_PHRASE = new RegExp(`^(?:(?:the|all|entire|immediate|international|land|its|whole|${DIRECTIONS})\\s+)*(?:areas?(?: of \\p{Lu}[\\p{L} ’'-]*?)? (?:immediately )?(?:near|along|bordering|next to|adjacent to|close to|on)(?: the)?\\s+)?(?:(?:\\p{Lu}[\\p{L}’'.]*(?:’s|'s)?(?:\\s*[–/-]\\s*|\\s+(?:and\\s+)?))){0,5}(?:(?:entire|international|land|${DIRECTIONS})\\s+)*(?:borders?|bordering|frontiers?)\\b`, 'iu');

/**
 * One list item → one area.
 *
 * `place` only when the words are a name; `border_zone` / `proximity` when it is a strip measured
 * from something; `route` for a road; otherwise `described`, with the words kept.
 */
function classifyItem(rawItem, held, context) {
  const parens = maskOf(rawItem).map((index) => held[index]);
  let text = tidy(dropMasks(rawItem));
  const area = {};
  const except = [];
  let alias = null;
  let parenQualifier = null;
  for (const inner of parens) {
    const exception = /^(?:except(?:ing)?(?: for)?|excluding|with the exception of|other than|not including)\s+(.+)$/i.exec(inner);
    if (exception) except.push(tidy(exception[1]));
    else if (/^(?:[\p{Lu}0-9]{2,8}|(?:also |formerly |previously )?(?:known as|called|or) .+|“.+”|".+")$/u.test(inner.trim()) || (isCleanName(inner) && distanceKm(inner) === null)) alias = tidy(inner.replace(/^(?:also |formerly |previously )?(?:known as|called|or)\s+/i, ''));
    else parenQualifier = tidy(inner);
  }
  const written = tidy(unmask(rawItem, held));
  const finish = (fields) => ({ ...fields, ...(except.length ? { except } : {}) });

  /* A strip measured from something. */
  const zone = WITHIN_ZONE.exec(rawItem);
  const parenDistance = parenQualifier && /\b(?:from|of) the border\b/i.test(parenQualifier) ? distanceKm(parenQualifier) : null;
  if (zone) {
    const reference = tidy(dropMasks(zone[3]));
    const prefix = tidy(dropMasks(zone[1]).replace(/^(?:in|the|all|any)\s+/i, '').replace(/^(?:the )?(?:parts?|areas?) of (?:the )?/i, '').replace(/\s+(?:which|that) (?:is|are)$/i, ''));
    const km = distanceKm(unmask(zone[2], held));
    const within = prefix && !/^(?:areas?|the areas?|locations?|land|all areas?|places?)$/i.test(prefix) ? { within: prefix } : {};
    if (BORDER_WORD.test(reference)) return finish({ kind: 'border_zone', name: written, neighbour: neighboursOf(zone[3], context), distanceKm: km, ...(/\b(?:all|any|every)\b[^.]*\bborders?\b|\binternational (?:land )?borders?\b|\bland borders?\b|\bother borders\b/i.test(reference) && neighboursOf(zone[3], context).length === 0 ? { allBorders: true } : {}), ...within });
    return finish({ kind: 'proximity', name: written, reference: stripThe(reference), distanceKm: km, ...within });
  }
  if (BORDER_WORD.test(text)) {
    if (BORDER_PHRASE.test(stripThe(text)) || /^(?:the )?(?:areas?|regions?|zones?|parts?)(?: of \p{Lu}[\p{L} ’'-]*?)? (?:that |which )?border(?:ing|s)?\b/iu.test(text)) {
      const inPlace = /\s+in (?:the )?(\p{Lu}[^,]*)$/u.exec(text);
      return finish({ kind: 'border_zone', name: written, neighbour: neighboursOf(rawItem, context), distanceKm: parenDistance, ...(/\b(?:all|any|every)\b[^.]*\bborders?\b|\binternational (?:land )?borders?\b|\bland borders?\b|\bborder areas$/i.test(text) && neighboursOf(rawItem, context).length === 0 ? { allBorders: true } : {}), ...(inPlace && isCleanName(inPlace[1]) ? { within: tidy(inPlace[1]) } : {}) });
    }
    return finish({ kind: 'described', name: written });
  }

  /* "the rest of <this country>" / "the whole of <this country>": the national floor, stated in passing. */
  const isOwn = (name) => context?.names?.has(normName(name)) || context?.names?.has(normName(name).replace(/^the /, '')) || (isoForName(name) !== null && isoForName(name) === context?.iso);
  const rest = /^(?:the )?(rest|remainder|whole|entirety|all other (?:parts|areas|regions)|all (?:other )?parts|any (?:other )?part|every part|all areas|all|anywhere in|any area) (?:of |in )?(?:the )?(.+)$/i.exec(text);
  if (rest && /^(?:rest|remainder|whole|entirety|all|any|every|anywhere)/i.test(rest[1])) {
    if (isOwn(rest[2])) return finish({ kind: /^(?:rest|remainder|all other|any other)/i.test(rest[1]) ? 'rest_of_country' : 'whole_country', name: written });
    if (/^(?:rest|remainder|whole|entirety)/i.test(rest[1])) return finish({ kind: 'described', name: written });
  }
  if (isOwn(text)) return finish({ kind: 'whole_country', name: written });
  const allOf = /^(?:all|the whole|the entirety) of (?:the )?(\p{Lu}.*)$/iu.exec(text);
  if (allOf && isCleanName(allOf[1])) text = tidy(allOf[1]);
  const restOf = /^(?:the )?(rest|remainder) of (?:the )?(\p{Lu}.*)$/iu.exec(text);
  if (restOf && isCleanName(restOf[2])) {
    const type = TYPE_SUFFIX_SINGLE.exec(restOf[2]);
    return finish({ kind: 'place', name: tidy(restOf[2]), ...(type ? { type: type[1].toLowerCase() } : {}), scope: 'part', qualifier: `the ${restOf[1].toLowerCase()} of` });
  }
  /* A name that is also a country's ("Puerto Rico" in Caquetá, "Niger" state) stays one name, not "the republic of Congo". */
  if (isoForName(text)) return finish({ kind: 'place', name: tidy(stripThe(text)) });

  /* "X in Y", "X, in Y": the name with where it is. */
  const located = /^(.+?),?\s+(?:with)?in (?:the )?(\p{Lu}.+)$/su.exec(text);
  if (located && isCleanName(located[1]) && isCleanName(located[2]) && !isCleanName(text)) {
    text = tidy(located[1]);
    if (/^(?:\p{Ll}+) of /u.test(located[2])) {
      parenQualifier = [parenQualifier, `in the ${tidy(located[2])}`].filter(Boolean).join('; ');
    } else {
      area.within = tidy(located[2]);
    }
  }

  /* "the city of X", "the Nairobi neighbourhoods of X". */
  const typed = TYPE_PREFIX.exec(text);
  if (typed && isCleanName(typed[3]) && !/\b(?:areas?|parts?|rest|border)\b/i.test(typed[1])) {
    const proper = properLead(typed[1]);
    /* "the Chapare region of Cochabamba Department" is Chapare, inside Cochabamba — never all of Cochabamba. */
    if (proper && !/s$/i.test(typed[2])) return finish({ kind: 'place', name: proper, type: singular(typed[2]), within: tidy(typed[3]), ...(alias ? { alias } : {}), ...(parenQualifier ? { scope: 'part', qualifier: parenQualifier } : {}) });
    return finish({ kind: 'place', name: tidy(typed[3]), type: singular(typed[2]), ...(alias ? { alias } : {}), ...(proper ? { within: proper } : area.within ? { within: area.within } : {}), ...(parenQualifier ? { scope: 'part', qualifier: parenQualifier } : {}) });
  }

  /* "western Turkana County", "parts of the Darién Region": part of a named place. */
  const part = PART_PREFIX.exec(text);
  if (part && isCleanName(part[2]) && /^[\p{Ll}]/u.test(part[1])) {
    const type = TYPE_SUFFIX_SINGLE.exec(part[2]);
    return finish({ kind: 'place', name: tidy(part[2]), ...(type ? { type: type[1].toLowerCase() } : {}), scope: 'part', qualifier: [tidy(part[1]), parenQualifier].filter(Boolean).join('; '), ...(alias ? { alias } : {}), ...(area.within ? { within: area.within } : {}) });
  }
  /* The same, at the start of a bullet where the direction is capitalised only by position: "Parts of the Darién Region". */
  const leadPart = /^(Parts?|Certain (?:parts|areas|districts)|Specific areas|Some (?:parts|areas)|Areas|Remote areas|Rural areas) (?:of|in|within) (?:the )?(\p{Lu}.*)$/u.exec(text);
  if (leadPart && isCleanName(leadPart[2])) {
    const type = TYPE_SUFFIX_SINGLE.exec(leadPart[2]);
    return finish({ kind: 'place', name: tidy(leadPart[2]), ...(type ? { type: type[1].toLowerCase() } : {}), scope: 'part', qualifier: [`${leadPart[1].toLowerCase()} of`, parenQualifier].filter(Boolean).join('; '), ...(area.within ? { within: area.within } : {}) });
  }

  if (isCleanName(text)) {
    const name = tidy(stripThe(text));
    const type = TYPE_SUFFIX_SINGLE.exec(name);
    return finish({ kind: 'place', name, ...(type ? { type: type[1].toLowerCase() } : {}), ...(alias ? { alias } : {}), ...(area.within ? { within: area.within } : {}), ...(parenQualifier ? { scope: 'part', qualifier: parenQualifier } : {}) });
  }
  if (ROUTE.test(text) && !/\b(?:areas?|regions?|parts?)\b/i.test(text.split(ROUTE)[0])) return finish({ kind: 'route', name: written });
  return finish({ kind: 'described', name: written });
}

/**
 * A scope phrase → its areas and its exceptions.
 *
 *   "the counties of Garissa, Wajir and Lamu, due to …"       three places
 *   "within 16 km of the Algerian border, except …"            one border zone with its exception
 *   "the areas south-west of road 45D"                         one described area (kept as text)
 */
export function parseScope(raw, context = {}) {
  const { masked, held } = maskParens(squash(raw).replace(/^(?:to\s+)+/i, ''));
  let scope = masked;
  const exceptions = [];
  const notes = [];
  let listType = null;
  let listWithin = null;
  let outer = null;

  /* "The following territories due to landmines: Aghdam, Aghdara, …": a lead and its list on one line. */
  const inline = /^(?:the |these )?following ([\p{L} -]+?)(?:\s+(?:due to|for)\b[^:]*)?:\s*(\S.+)$/isu.exec(scope);
  if (inline) {
    const kind = new RegExp(`^(?:${TYPE_WORDS})$`, 'i').test(inline[1].trim()) ? singular(inline[1].trim()) : null;
    if (kind && !/^area/.test(kind)) listType = kind;
    scope = inline[2];
  }

  /* The exception before the reason, because the reason often stands between: "… due to terrorism, except for the cities of …". */
  const exception = EXCEPTION.exec(scope);
  if (exception) {
    const tail = tidy(unmask(exception[2].replace(REASON, ''), held));
    if (tail) exceptions.push(tail);
    scope = scope.slice(0, exception.index).replace(/\($/, '');
  }
  scope = scope.replace(REASON, '');
  const elaboration = ELABORATION.exec(scope);
  if (elaboration) {
    const tail = tidy(unmask(elaboration[1], held));
    if (tail) notes.push(tail);
    scope = scope.slice(0, elaboration.index);
  }
  scope = tidy(scope.replace(/^(?:to\s+)+/i, ''));
  if (!scope) return { areas: [], exceptions, notes };

  /* "Mandera, Wajir, Garissa and Lamu counties bordering Somalia": the counties are named; the tail describes them. */
  const tailOfKind = new RegExp(`^(.*\\b(?:states|provinces|regions|departments|counties|districts|governorates)) (?:bordering|along|next to|adjacent to)\\b.*$`, 'i').exec(scope);
  if (tailOfKind) scope = tidy(tailOfKind[1]);
  /* "100 km of the Somali region border": the bullet under "within the following distances" dropped its "within". */
  if (/^\d+(?:\.\d+)?\s*-?\s*(?:km|kilomet(?:er|re)s?|miles?)\s+(?:of|from)\b/i.test(scope)) scope = `within ${scope}`;

  /* One measured strip is one area however many neighbours it lists. */
  if (WITHIN_ZONE.test(scope)) return { areas: [classifyItem(scope, held, context)], exceptions, notes };

  /* "In Guayaquil, A and B districts": everything that follows is inside the first place. */
  const inside = /^[Ii]n (?:the )?(\p{Lu}[^,:]*?)[,:]\s+(.+)$/su.exec(scope);
  if (inside && isCleanName(inside[1])) {
    outer = tidy(inside[1]);
    scope = inside[2];
  }
  /* "A and B, in El Oro province" / "A, B and C within the regions of X, Y and Z": the list, then where it is. */
  const trailing = new RegExp(`^(.+?),?\\s+(?:with)?in ((?:the )?(?:(?:${TYPE_WORDS}) of .+|\\p{Lu}[^,]*))$`, 'su').exec(scope);
  const eachTyped = trailing && splitList(trailing[1]).length > 1 && splitList(trailing[1]).every((piece) => TYPE_SUFFIX_SINGLE.test(dropMasks(piece)));
  if (!outer && trailing && !eachTyped && splitList(trailing[1]).every((piece) => isCleanName(dropMasks(piece))) && splitList(trailing[2].replace(new RegExp(`^(?:the )?(?:${TYPE_WORDS}) of `, 'i'), '')).every((piece) => isCleanName(piece))) {
    outer = tidy(stripThe(trailing[2]));
    scope = trailing[1];
  }
  /* "the riverine areas of Delta, Bayelsa and Rivers states": the partitive governs every name, never just the first. */
  const partitive = /^((?:the )?(?:[\p{Ll}-]+ )*(?:areas?|parts?)(?: \u0001\d+\u0001)?) (?:of|in) (?:the )?(\p{Lu}.*)$/u.exec(scope);
  if (partitive && !/^(?:the )?following\b/i.test(partitive[1]) && splitList(dropMasks(partitive[2])).every((piece) => isCleanName(piece))) {
    const inner = parseScope(unmask(partitive[2], held), context);
    const qualifier = tidy(unmask(partitive[1], held));
    for (const area of inner.areas) if (area.kind === 'place') Object.assign(area, { scope: 'part', qualifier: [qualifier, area.qualifier].filter(Boolean).join('; ') });
    return { areas: inner.areas, exceptions: [...exceptions, ...inner.exceptions], notes: [...notes, ...inner.notes] };
  }
  /* "St. Ann’s Parish - Steer Town": a named division, then the places in it. */
  const dashed = /^(\p{Lu}[^,–—]*?\b(?:Parish|Province|Department|Region|State|District|County|Governorate|Municipality))\s+[–—-]\s+(.+)$/u.exec(scope);
  if (!outer && dashed && isCleanName(dashed[1])) {
    outer = tidy(dashed[1]);
    scope = dashed[2];
  }

  /* A typed list: "the states of A, B and C", "the Nairobi neighbourhoods of A and B". */
  const typed = TYPE_PREFIX.exec(scope);
  if (typed && /s$/i.test(typed[2]) && !/\b(?:areas?|parts?|rest|border)\b/i.test(typed[1]) && /^[\p{Lu}\u0001]/u.test(typed[3])) {
    listType = singular(typed[2]);
    listWithin = properLead(typed[1]) || null;
    scope = typed[3];
  }

  /* "Valley of the Apurímac, Ene and Mantaro Rivers" is one name with a list inside it. */
  const compound = /^(?:the )?\p{Lu}\p{L}+ of (?:the )?\p{Lu}.*,.*\b(?:Rivers|Mountains|Lakes|Hills|Valleys)$/u.test(dropMasks(scope));
  const pieces = compound ? [{ text: scope, separator: '' }] : splitPieces(scope);
  /* Put back what the splitter must not have cut: a border's neighbours, a bare direction, a qualifier that trails a name. */
  const items = [];
  /* Adjectives only: "Northern and Middle Sinai" is one phrase, while "Southwest, Northwest and Far North Regions" are three names. */
  const directionOnly = /^(?:the )?(?:(?:north|south)?-?(?:north|south|east|west)ern|central|coastal|upper|lower)$/i;
  const neighbourPiece = (bare, previous) => {
    const head = bare.replace(/\s+in (?:the )?\p{Lu}.*$/u, '');
    if (isoForName(head) || isoForDemonym(head)) return true;
    return previous.subnational === true && isCleanName(head);
  };
  for (const piece of pieces) {
    /* "X and to Y": the second "to" repeats the verb; Y is a warning in its own right. */
    piece.text = piece.text.replace(/^to (?=(?:the )?\p{Lu})/u, '');
    const previous = items[items.length - 1];
    const bare = dropMasks(piece.text);
    if (previous && /\bbetween\b(?!.*\band\b)/.test(dropMasks(previous.text)) && /\band\b/.test(piece.separator)) {
      /* "the road between Ijevan and Noyemberyan": the two ends of one thing, not a second warning. */
      previous.text += piece.separator + piece.text;
    } else if (previous && previous.partitive) {
      previous.text += piece.separator + piece.text;
      previous.ambiguous = true;
    } else if (previous && /\bAirport$/.test(previous.text) && isCleanName(bare) && !piece.separator.includes('and')) {
      /* "Bangoka International Airport, Kisangani": where the airport is, not a second warning for the whole city. */
      previous.text += ` in ${piece.text}`;
    } else if (previous && !previous.qualified && TYPE_SUFFIX_SINGLE.test(bare) && isCleanName(bare) && /,/.test(piece.separator) && !/\band\b/.test(piece.separator) && /\b(?:in|within) (?:the )?\p{Lu}[^,]*$/u.test(previous.text)) {
      /* "… in Fako Division, South-West Region" — one location or two warnings? It cannot be told, so it stays words. */
      previous.text += piece.separator + piece.text;
      previous.ambiguous = true;
    } else if (previous && previous.direction) {
      previous.text += piece.separator + piece.text;
      previous.direction = false;
    } else if (previous && previous.qualified) {
      previous.text += piece.separator + piece.text;
    } else if (previous && previous.border && !BORDER_WORD.test(bare) && (neighbourPiece(bare, previous) || /^(?:the )?\p{Lu}\p{L}+ (?:states|provinces|regions) of \p{Lu}/u.test(bare))) {
      /* "bordering Burkina Faso; Niger; and the Nigerian states of Kebbi, Niger, and Kwara": neighbours, not separate warnings. */
      if (/ (?:states|provinces|regions) of /.test(bare)) previous.subnational = true;
      previous.text += piece.separator + piece.text;
    } else if (previous && QUALIFIER_START.test(bare)) {
      previous.text += piece.separator + piece.text;
      previous.qualified = true;
      previous.cut = previous.cut ?? previous.text.length - piece.text.length - piece.separator.length;
    } else {
      items.push({ text: piece.text, border: BORDER_WORD.test(bare) && /\b(?:with|between|bordering|borders? of)\b/i.test(bare), qualified: false, direction: directionOnly.test(bare) || /\b(?:(?:north|south)?-?(?:north|south|east|west)ern)$/.test(bare), partitive: items.length > 0 && /^(?:the )?(?:[\p{Ll}-]+ )*(?:areas?|parts?) of \p{Lu}/u.test(bare) });
    }
  }

  const areas = [];
  for (const item of items) {
    if (item.ambiguous) {
      areas.push({ kind: 'described', name: tidy(unmask(item.text, held)) });
      continue;
    }
    if (item.qualified) {
      /* "Guanajuato, in all areas south of highway 45D": the name, and the words that say which part of it. */
      const head = classifyItem(item.text.slice(0, item.cut), held, context);
      const qualifier = tidy(unmask(item.text.slice(item.cut), held));
      if (head.kind === 'place') areas.push({ ...head, scope: 'part', qualifier: [head.qualifier, qualifier].filter(Boolean).join('; ') });
      else areas.push({ kind: 'described', name: tidy(unmask(item.text, held)) });
      continue;
    }
    areas.push(classifyItem(item.text, held, context));
  }

  /* "Marsabit and Turkana Counties": the plural kind at the end belongs to the names before it too. */
  for (let index = 0; index < areas.length; index += 1) {
    const area = areas[index];
    if (area.kind !== 'place') continue;
    const plural = TYPE_SUFFIX_PLURAL.exec(area.name);
    if (!plural) continue;
    const shared = index > 0 && areas[index - 1].kind === 'place' && !areas[index - 1].type;
    if (!shared && !listType) {
      /* One "name" ending in a plural kind names a group, not a place: "Brasilia’s satellite cities". */
      areas[index] = { kind: 'described', name: tidy(unmask(items[index]?.text ?? area.name, held)) };
      continue;
    }
    area.name = tidy(plural[1]);
    area.type = singular(plural[2]);
    for (let back = index - 1; back >= 0 && areas[back].kind === 'place' && !areas[back].type; back -= 1) areas[back].type = area.type;
  }
  for (const area of areas) {
    if (area.kind === 'place') {
      if (listType && !area.type) area.type = listType;
      if (listWithin && !area.within) area.within = listWithin;
    }
    if (outer && !area.within) area.within = outer;
  }
  return { areas, exceptions, notes };
}

/** The words of a list-item tree, flat, for an exception or a sentence that must be kept whole. */
const flatten = (items) => items.flatMap((item) => [item.text, ...item.notes, ...flatten(item.children)]);

/**
 * A lead sentence with the list under it → areas.
 *
 *   "… to the following states:" + [Chiapas, excluding: [..], Chihuahua, …]
 *   "… to within 30km of Algeria’s borders with:" + [Libya, Mauritania, Mali, Niger]
 *   "… to the state of Chihuahua, except:" + [the city of Chihuahua, …]
 */
export function parseLead(lead, items, context = {}) {
  const head = squash(lead).replace(/:\s*$/, '');
  if (items.length === 0) return parseScope(head, context);
  /* "… to Russia due to the risks of its war, including:" — the list is the reasons, not the places. */
  if (/\b(?:due to|because of|owing to)\b.*\b(?:including|such as)\s*$/i.test(head)) return parseScope(head, context);

  const { masked, held } = maskParens(head.replace(/^(?:to\s+)+/i, ''));
  /* "X, except:" — the list is what is left out. */
  const exception = /^(.*?)\s*[,;]?\s*\b(?:except(?:ing)?(?: for| the| these| in)?|excluding(?: the following(?: areas)?)?|with the exception of|other than)\b[^:]*$/is.exec(masked);
  if (exception && tidy(exception[1])) {
    const parsed = parseScope(unmask(exception[1], held), context);
    return { ...parsed, exceptions: [...parsed.exceptions, ...flatten(items).map(tidy)] };
  }

  const stem = tidy(masked.replace(REASON, ''));
  /* "the Chittagong Hill Tracts, an area made up of the districts of:" — the area is named; the list spells it out. */
  const madeOf = /^(.+?),?\s+(?:an area |a region |which is |which are )?(?:made up of|consisting of|comprising|which includes?|including)\b/i.exec(stem);
  if (madeOf && !/^(?:the )?following\b/i.test(madeOf[1])) {
    const parsed = parseScope(unmask(madeOf[1], held), context);
    return { ...parsed, notes: [...parsed.notes, ...flatten(items).map(tidy)] };
  }

  /* "within 10 km of the border with Pakistan in the following states:" — a strip IN each state, never the whole state. */
  const stripIn = /^(.*\bwithin\b.*?)\s+in the following\b[^:]*$/i.exec(stem);
  if (stripIn) {
    const base = unmask(stripIn[1], held);
    const strip = parseScope(base, context).areas[0];
    const areas = items.map((item) => {
      const place = parseScope(item.text, context).areas[0];
      const name = place?.name ?? tidy(item.text);
      return { ...strip, name: `${base} in ${name}`, within: name, ...(place?.except ? { except: place.except } : {}) };
    });
    return { areas, exceptions: [], notes: [] };
  }

  /* A stem the items complete: "within 30km of Algeria’s borders with" + "Libya"; "the provinces of" + "Borkou". */
  const completes = /\b(?:with|of|within|from|bordering|between|in)$/i.test(stem) && !/^(?:the )?following\b.* in$/i.test(stem);
  const generic = /^(?:(?:the|these|those|all|any of the)\s+)?(?:following\s+)?((?:\p{L}+[ -]){0,3}?)(areas?|locations?|places?|regions?|states?|provinces?|departments?|districts?|counties|cities|towns|municipalities|governorates?|zones?|territories|parts|border areas|neighbou?rhoods)?(?: and (?:regions?|cities|towns|border areas|areas))*(?: of (?:the )?\p{Lu}[\p{L} ’'-]*| in (?:the )?\p{Lu}[\p{L} ’'-]*)?$/iu.exec(stem);
  const defaultType = generic?.[2] && !/^(?:areas?|locations?|places?|parts|border areas)$/i.test(generic[2]) && !/ and /.test(stem) ? singular(generic[2]) : null;
  const outerMatch = /\b(?:of|in) (?:the )?(\p{Lu}[\p{L} ’'-]*)$/u.exec(stem);
  const outer = !completes && generic && outerMatch && isCleanName(outerMatch[1]) && !(isoForName(outerMatch[1]) && isoForName(outerMatch[1]) === context.iso) ? tidy(outerMatch[1]) : null;

  const areas = [];
  const exceptions = [];
  const notes = [];
  const unparsed = [];
  for (const item of items) {
    const text = squash(item.text);
    let parsed;
    if (item.children.length > 0) {
      const nested = completes ? `${unmask(stem, held)} ${text}` : text;
      /* "in the province of El Oro:" + towns → the towns, inside El Oro. */
      const within = /\d|\bexclud|\bexcept/i.test(text) ? null : /^(?:in|within) (?:the )?(.+?):?$/i.exec(text);
      if (within && !completes) {
        const inner = parseLead('', item.children, context);
        const place = parseScope(within[1], context).areas.find((area) => area.kind === 'place');
        for (const area of inner.areas) if (place && !area.within) area.within = place.type && !TYPE_SUFFIX_SINGLE.test(place.name) ? `${place.name} ${place.type}` : place.name;
        parsed = inner;
      } else {
        parsed = parseLead(nested, item.children, context);
      }
    } else {
      parsed = parseScope(completes ? `${unmask(stem, held)} ${text}` : text, context);
    }
    if (item.notes.length > 0) notes.push(...item.notes.map(tidy));
    /* An exception stated on one bullet belongs to that bullet's areas, not to its neighbours'. */
    if (parsed.exceptions.length > 0) {
      if (items.length === 1) exceptions.push(...parsed.exceptions);
      else for (const area of parsed.areas) area.except = [...(area.except ?? []), ...parsed.exceptions];
      if (parsed.areas.length === 0) unparsed.push(text);
    }
    notes.push(...parsed.notes);
    for (const area of parsed.areas) {
      if (area.kind === 'place' && defaultType && !area.type) area.type = defaultType;
      if (outer && !area.within) area.within = outer;
      areas.push(area);
    }
    if (parsed.areas.length === 0 && parsed.exceptions.length === 0) unparsed.push(text);
  }
  for (const text of unparsed) areas.push({ kind: 'described', name: tidy(text) });
  return { areas, exceptions, notes };
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * Regional entries
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */

const clip = (text, limit = 300) => (text.length <= limit ? text : `${text.slice(0, limit - 1).replace(/\s+\S*$/, '')}…`);

/** One regional statement, in the snapshot's shape. `unparsed` is true when any of it stayed as words. */
function regionalEntry({ level, label, parsed, sentence, heading }) {
  const areas = parsed.areas.filter((area) => area.kind !== 'whole_country');
  const unparsed = areas.length === 0 || areas.some((area) => area.kind === 'described');
  return {
    level,
    label,
    areas,
    ...(parsed.exceptions.length > 0 ? { exceptions: parsed.exceptions.map((text) => clip(text, 300)) } : {}),
    ...(heading ? { heading } : {}),
    text: clip(squash(sentence)),
    ...(unparsed ? { unparsed: true } : {}),
  };
}

const sentenceWithItems = (lead, items) => (items.length === 0 ? lead : `${lead} ${flatten(items).join('; ')}`);

/** Splits a paragraph into sentences without breaking "St. Catherine" or "Mt. Hagen". */
export function sentences(text) {
  const guarded = text.replace(/\b(St|Mt|Dr|Gen|Ft|No|approx|Av|Ave|Blvd|U\.S|U\.K|e\.g|i\.e)\.\s/g, '$1\u0003 ');
  return guarded
    .split(/(?<=[.!?])\s+(?=[\p{Lu}“"(])/u)
    .map((sentence) => sentence.replace(/\u0003/g, '.').trim())
    .filter(Boolean);
}

const dedupe = (entries) => {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.level}|${normName(entry.areas.map((area) => area.name).join('|') || entry.text)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/* ── U.S. Department of State ─────────────────────────────────────────────────────────────────── */

const US_LEVELS = [
  { level: 4, label: 'Do Not Travel', pattern: /^do not travel\b/i },
  { level: 3, label: 'Reconsider Travel', pattern: /^reconsider travel\b/i },
];
const US_MARKER = /\bsome areas have (?:an? )?(?:increased|higher|specific|elevated|heightened)(?: \w+)? risks?\b/i;
const US_HEADING = /^(.{3,160}?)\s*[–—-]\s*Level ([34])\s*:\s*(Do Not Travel|Reconsider Travel)\s*$/i;

/** `{ name, level, label }` from "Mexico Travel Advisory - Level 2: Exercise Increased Caution", or null. */
export function parseUsTitle(title) {
  const match = /^(.*?)\s*(?:Travel Advisory\s*)?-\s*Level\s*(\d)\s*:\s*(.+?)\s*$/.exec(title ?? '');
  return match ? { name: squash(match[1]), level: Number(match[2]), label: `Level ${match[2]}: ${squash(match[3])}` } : null;
}

/**
 * One row of the State Department feed → one advisory.
 *
 * The national level is the title's and applies to the whole country. Regional advice is whatever
 * the summary says in "Do Not Travel to …" / "Reconsider Travel to …" sentences and lists. The feed
 * often says only "Some areas have increased risk" and leaves the list on the web page: that is
 * `regionalUnparsed`, never "no regional advice".
 */
export function parseUsAdvisory(row, context = {}) {
  const title = parseUsTitle(row.Title);
  if (!title) return null;
  const blocks = htmlBlocks(row.Summary ?? '');
  const regional = [];
  const consumed = new Set();
  for (let index = 0; index < blocks.length; index += 1) {
    if (consumed.has(index)) continue;
    const block = blocks[index];
    const heading = US_HEADING.exec(block.text);
    if (heading) {
      const parsed = parseScope(heading[1], context);
      const level = Number(heading[2]);
      if (!parsed.areas.every((area) => area.kind === 'whole_country')) regional.push(regionalEntry({ level, label: level === 4 ? 'Do Not Travel' : 'Reconsider Travel', parsed, sentence: block.text }));
      continue;
    }
    const kind = US_LEVELS.find((entry) => entry.pattern.test(block.text));
    if (!kind) continue;
    const rest = block.text.replace(kind.pattern, '').trim();
    if (!rest || !/^(?:to|within|in|for|near|along)\b|^:/i.test(rest)) continue;
    const isLead = /:\s*$/.test(block.text);
    let { items, next } = isLead ? itemsAfter(blocks, index, block.tag === 'li' ? block.depth : 0) : { items: [], next: index + 1 };
    if (isLead && items.length === 0) {
      /* Some advisories set the list as paragraphs: "Do Not Travel to:" then one "<place> due to <reason>." per paragraph. */
      for (; next < blocks.length && blocks[next].tag === 'p' && /\bdue to\b/i.test(blocks[next].text) && blocks[next].text.length < 400 && !US_LEVELS.some((entry) => entry.pattern.test(blocks[next].text)); next += 1) items.push({ text: blocks[next].text, children: [], notes: [] });
    }
    for (let used = index + 1; used < next; used += 1) consumed.add(used);
    const first = sentences(rest)[0] ?? rest;
    if (isLead && items.length === 0) {
      regional.push(regionalEntry({ level: kind.level, label: kind.label, parsed: { areas: [], exceptions: [], notes: [] }, sentence: block.text }));
      continue;
    }
    /* Each bullet under "Do Not Travel to:" is its own sentence with its own reason; keep them apart. */
    if (isLead && /^(?:to|in)?\s*(?:these areas|the following(?: areas| locations| regions)?)?(?:\s+for any reason)?\s*:?$/i.test(rest.replace(REASON, '').trim() || rest)) {
      for (const item of items) {
        const parsed = parseLead(item.text, item.children, context);
        if (parsed.areas.length > 0 && parsed.areas.every((area) => area.kind === 'whole_country')) continue;
        regional.push(regionalEntry({ level: kind.level, label: kind.label, parsed, sentence: `${block.text} ${sentenceWithItems(item.text, item.children)}` }));
      }
      continue;
    }
    const parsed = isLead ? parseLead(rest, items, context) : parseScope(first, context);
    if (parsed.areas.length > 0 && parsed.areas.every((area) => area.kind === 'whole_country')) continue;
    /* "Reconsider travel due to …" with no place at all restates the national level. */
    if (!isLead && parsed.areas.length === 0 && /^(?:to\s+)?(?:due to|for any reason|because)\b/i.test(first)) continue;
    regional.push(regionalEntry({ level: kind.level, label: kind.label, parsed, sentence: isLead ? sentenceWithItems(block.text, items) : `${kind.label} ${first}` }));
  }
  const entries = dedupe(regional);
  const marker = US_MARKER.test(squash(decodeEntities((row.Summary ?? '').replace(/<[^>]+>/g, ' '))));
  return {
    authority: 'us',
    level: title.level,
    label: title.label,
    updatedAt: (row.Updated ?? row.Published ?? '').slice(0, 10) || null,
    url: row.Link ?? null,
    wholeCountry: true,
    nationalLevel: title.level,
    regional: entries,
    regionalUnparsed: entries.some((entry) => entry.unparsed) || (marker && entries.length === 0),
    ...(marker && entries.length === 0 ? { regionalNote: 'The feed says "Some areas have increased risk" and does not carry the list; it is on the advisory page.' } : {}),
  };
}

/* ── UK FCDO ──────────────────────────────────────────────────────────────────────────────────── */

const UK_ADVICE = /\b(?:FCDO|Foreign, Commonwealth (?:&|and) Development Office(?: \(FCDO\))?|[Ww]e)(?:\s+(?:also|currently|now|still|continues? to|therefore))*\s+advises?\s+against\s+(all but essential|all)\s+travel\b\s*(.*)$/s;
const UK_LABEL = { 4: 'FCDO advises against all travel', 3: 'FCDO advises against all but essential travel' };
const UK_STATUS = {
  avoid_all_travel_to_whole_country: { level: 4, whole: true, label: 'FCDO advises against all travel to the whole country' },
  avoid_all_travel_to_parts: { level: 4, whole: false, label: 'FCDO advises against all travel to parts of the country' },
  avoid_all_but_essential_travel_to_whole_country: { level: 3, whole: true, label: 'FCDO advises against all but essential travel to the whole country' },
  avoid_all_but_essential_travel_to_parts: { level: 3, whole: false, label: 'FCDO advises against all but essential travel to parts of the country' },
};

/**
 * One GOV.UK foreign-travel-advice document → one advisory.
 *
 * `details.alert_status` is the FCDO's own machine-readable headline (whole country or parts, all
 * travel or all but essential). The named areas are in the "Warnings and insurance" part, as
 * "FCDO advises against all travel to …" sentences. The FCDO has no level below "all but essential
 * travel": a country with no alert status gets `level: null`, which is silence, not safety.
 */
/** "FCDO advises against:" + bullets that each begin "all travel to …": rewritten as one statement per bullet. */
function expandUkBareLeads(blocks) {
  const out = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    out.push(block);
    if (!/\badvises? against:\s*$/i.test(block.text)) continue;
    out.pop();
    const stem = block.text.replace(/:\s*$/, '');
    for (index += 1; index < blocks.length && blocks[index].tag === 'li'; index += 1) {
      const item = blocks[index];
      out.push(item.depth === 1 && !item.cont ? { tag: 'p', depth: 0, text: `${stem} ${item.text}` } : item);
    }
    index -= 1;
  }
  return out;
}

/** A lead set over plain paragraphs instead of a list: the paragraphs up to the next statement or heading. */
function paragraphItems(blocks, start) {
  const items = [];
  let next = start;
  for (; next < blocks.length && items.length < 20; next += 1) {
    const block = blocks[next];
    if (block.tag !== 'p' || /\badvises? against\b/i.test(block.text) || /^(?:find out|see |read |there (?:is|are)|you should)/i.test(block.text) || block.text.length > 400) break;
    items.push({ text: block.text, children: [], notes: [] });
  }
  return { items, next };
}

export function parseUkAdvice(doc, context = {}) {
  const statuses = (doc.details?.alert_status ?? []).map((status) => UK_STATUS[status] ?? { unknown: status });
  const known = statuses.filter((status) => !status.unknown);
  const level = known.reduce((highest, status) => Math.max(highest, status.level), 0) || null;
  let nationalLevel = known.filter((status) => status.whole).reduce((highest, status) => Math.max(highest, status.level), 0) || null;

  let carvedOut = false;
  const part = (doc.details?.parts ?? []).find((entry) => entry.slug === 'warnings-and-insurance') ?? (doc.details?.parts ?? [])[0];
  const blocks = expandUkBareLeads(htmlBlocks(part?.body ?? ''));
  const regional = [];
  const consumed = new Set();
  let heading = null;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (/^h[1-6]$/.test(block.tag)) {
      heading = block.tag === 'h2' ? null : block.text;
      continue;
    }
    if (consumed.has(index)) continue;
    const parts = sentences(block.text);
    for (let position = 0; position < parts.length; position += 1) {
      const sentence = parts[position];
      const advice = UK_ADVICE.exec(sentence);
      if (!advice) continue;
      /* "… regions where FCDO advises against all travel" refers to a warning; it does not make one. */
      if (/\bwhere\s+(?:the\s+)?$/i.test(sentence.slice(0, advice.index)) || !/^(?:to|within|on|along|in|:)/i.test(advice[2].trim())) continue;
      /* "Find out more about why FCDO advises against travel" and its kin name no place. */
      if (/^(?:find out|see|read)\b/i.test(sentence) && !/\btravel (?:to|within|on|along|in)\b/i.test(sentence.slice(advice.index))) continue;
      const entryLevel = /all but essential/i.test(advice[1]) ? 3 : 4;
      const rest = advice[2].trim();
      const isLead = position === parts.length - 1 && /:\s*$/.test(sentence);
      let { items, next } = isLead ? itemsAfter(blocks, index, block.tag === 'li' ? block.depth : 0) : { items: [], next: index + 1 };
      if (isLead && items.length === 0) ({ items, next } = paragraphItems(blocks, index + 1));
      for (let used = index + 1; used < next; used += 1) consumed.add(used);
      const onRoad = /^(?:on|along)\b/i.test(rest);
      let parsed;
      if (onRoad) parsed = { areas: [{ kind: 'route', name: tidy(rest.replace(/^(?:on|along)\s+/i, '').replace(REASON, '')) }], exceptions: [], notes: [] };
      else parsed = isLead ? parseLead(rest.replace(/^(?:to|in)\b\s*:?\s*/i, ''), items, context) : parseScope(rest.replace(/^(?:to|in)\b\s*:?\s*/i, ''), context);
      const whole = parsed.areas.length > 0 && parsed.areas.every((area) => area.kind === 'whole_country');
      const restOf = parsed.areas.some((area) => area.kind === 'rest_of_country');
      /* "… to the rest of Chad" sets the floor for everywhere not named above it. */
      if ((whole || restOf) && parsed.exceptions.length === 0 && parsed.areas.every((area) => !area.except)) nationalLevel = Math.max(nationalLevel ?? 0, entryLevel);
      /* "… to Sudan …. This does not include the Hala’ib Triangle … where FCDO advises against all but essential travel." */
      const carve = whole ? /^This does not include (.+?),?\s+where\s+(?:we|FCDO)\s+advises?\s+against\s+(all but essential|all)\s+travel\b/i.exec(parts[position + 1] ?? '') : null;
      if (carve) {
        const lower = /all but essential/i.test(carve[2]) ? 3 : 4;
        carvedOut = true;
        regional.push(regionalEntry({ level: entryLevel, label: UK_LABEL[entryLevel], parsed: { areas: parsed.areas.map((area) => ({ ...area, kind: 'rest_of_country' })), exceptions: [carve[1]], notes: [] }, sentence: `${sentence} ${parts[position + 1]}`, heading }));
        regional.push(regionalEntry({ level: lower, label: UK_LABEL[lower], parsed: parseScope(carve[1], context), sentence: parts[position + 1], heading }));
        position += 1;
        continue;
      }
      if (whole && parsed.exceptions.length === 0) continue;
      if (!isLead && parsed.areas.length === 0 && parsed.exceptions.length === 0) continue;
      const kept = whole ? { ...parsed, areas: parsed.areas.map((area) => ({ ...area, kind: 'rest_of_country' })) } : parsed;
      regional.push(regionalEntry({ level: entryLevel, label: UK_LABEL[entryLevel], parsed: kept, sentence: isLead ? sentenceWithItems(sentence, items) : sentence, heading }));
      /* "…, except the town of El Salloum, where we advise against all but essential travel": the exception is itself a warning. */
      for (const text of [...parsed.exceptions, ...parsed.areas.flatMap((area) => area.except ?? [])]) {
        const inner = /^(.+?),?\s+where\s+(?:we|FCDO)\s+advises?\s+against\s+(all but essential|all)\s+travel\b/i.exec(text);
        if (!inner) continue;
        const innerLevel = /all but essential/i.test(inner[2]) ? 3 : 4;
        regional.push(regionalEntry({ level: innerLevel, label: UK_LABEL[innerLevel], parsed: parseScope(inner[1], context), sentence, heading }));
      }
    }
  }
  const entries = dedupe(regional);
  const partsDeclared = known.some((status) => !status.whole);
  const wholeCountry = level === null ? true : nationalLevel === level && !carvedOut;
  return {
    authority: 'uk',
    level,
    label: known.length > 0 ? known.map((status) => status.label).join('; ') : null,
    updatedAt: (doc.public_updated_at ?? doc.details?.updated_at ?? '').slice(0, 10) || null,
    url: doc.base_path ? `https://www.gov.uk${doc.base_path}` : null,
    wholeCountry,
    nationalLevel,
    regional: entries,
    regionalUnparsed: entries.some((entry) => entry.unparsed) || (partsDeclared && entries.length === 0) || statuses.some((status) => status.unknown),
    ...(statuses.some((status) => status.unknown) ? { regionalNote: `Unrecognised alert status: ${statuses.filter((status) => status.unknown).map((status) => status.unknown).join(', ')}` } : {}),
  };
}

/* ── Global Affairs Canada ────────────────────────────────────────────────────────────────────── */

const CA_LEVEL = [
  { level: 4, pattern: /^avoid all travel\b/i, label: 'Avoid all travel' },
  { level: 3, pattern: /^avoid non-essential travel\b/i, label: 'Avoid non-essential travel' },
  { level: 2, pattern: /^exercise a high degree of caution\b/i, label: 'Exercise a high degree of caution' },
  { level: 1, pattern: /^(?:take|exercise) normal security precautions\b/i, label: 'Take normal security precautions' },
];
const caLevel = (text) => CA_LEVEL.find((entry) => entry.pattern.test(text.trim())) ?? null;

/**
 * One Canadian country file (with its index entry) → one advisory.
 *
 * `advisory-state` (0–3) is the national risk level; each further "AdvisoryContainer" is a
 * regional advisory whose heading reads "<area> - <level>" and whose body names the places.
 */
export function parseCaAdvice(indexEntry, doc, context = {}) {
  const state = Number(doc?.data?.['advisory-state'] ?? indexEntry?.['advisory-state']);
  const level = Number.isInteger(state) && state >= 0 && state <= 3 ? state + 1 : null;
  const english = doc?.data?.eng ?? {};
  const containers = String(english.advisories ?? '')
    .split(/<div class="AdvisoryContainer\b/)
    .slice(1)
    .map((chunk) => `<div class="AdvisoryContainer${chunk}`);
  const regional = [];
  let unreadable = false;
  containers.forEach((container, position) => {
    const blocks = htmlBlocks(container);
    const headingBlock = blocks.find((block) => /^h[1-6]$/.test(block.tag));
    if (!headingBlock) return;
    const cut = headingBlock.text.lastIndexOf(' - ');
    const headingName = cut > 0 ? headingBlock.text.slice(0, cut).trim() : headingBlock.text;
    const headingLevel = caLevel(cut > 0 ? headingBlock.text.slice(cut + 3) : '');
    /* The first container restates the national level ("Mexico - Exercise a high degree of caution"). */
    if (position === 0 && !/\bRegionalAdv\b/.test(container.slice(0, 80))) return;
    if (!headingLevel) {
      unreadable = true;
      return;
    }
    const body = blocks.slice(blocks.indexOf(headingBlock) + 1);
    let found = false;
    const startedAt = regional.length;
    const consumed = new Set();
    const excluded = [];
    for (let index = 0; index < body.length; index += 1) {
      if (consumed.has(index)) continue;
      const block = body[index];
      const parts = sentences(block.text);
      for (let cursor = 0; cursor < parts.length; cursor += 1) {
        const sentence = parts[cursor];
        const isLead = cursor === parts.length - 1 && /:\s*$/.test(sentence);
        const excludes = /^This (?:advisory|warning|regional advisory) (?:excludes|does not (?:include|apply to))\b:?\s*(.*)$/i.exec(sentence);
        if (excludes) {
          const { items, next } = isLead ? itemsAfter(body, index, block.tag === 'li' ? block.depth : 0) : { items: [], next: index + 1 };
          for (let used = index + 1; used < next; used += 1) consumed.add(used);
          excluded.push(tidy(sentenceWithItems(excludes[1], items)));
          continue;
        }
        const own = caLevel(sentence);
        if (!own || own.level !== headingLevel.level) continue;
        const rest = sentence.replace(own.pattern, '').trim();
        if (!/^(?:to|in|within)\b/i.test(rest)) continue;
        const { items, next } = isLead ? itemsAfter(body, index, block.tag === 'li' ? block.depth : 0) : { items: [], next: index + 1 };
        for (let used = index + 1; used < next; used += 1) consumed.add(used);
        const scope = rest.replace(/^(?:(?:to|in)\s+)+/i, '');
        const parsed = isLead ? parseLead(scope, items, context) : parseScope(scope, context);
        const whole = parsed.areas.length > 0 && parsed.areas.every((area) => area.kind === 'whole_country');
        if (whole && parsed.exceptions.length === 0) {
          found = true;
          continue;
        }
        regional.push(regionalEntry({ level: own.level, label: own.label, parsed, sentence: isLead ? sentenceWithItems(sentence, items) : sentence, heading: headingName }));
        found = true;
      }
    }
    if (!found) {
      /* The heading named an area and a level but the body did not say it in the usual sentence: keep the heading. */
      regional.push(regionalEntry({ level: headingLevel.level, label: headingLevel.label, parsed: parseScope(headingName, context), sentence: squash(`${headingBlock.text}. ${body.map((block) => block.text).join(' ')}`), heading: headingName }));
    }
    /* "This advisory excludes …" is said of the whole container, so it rides on every entry the container produced. */
    if (excluded.length > 0) {
      const own = regional.slice(startedAt);
      if (own.length === 0) unreadable = true;
      for (const entry of own) entry.exceptions = [...(entry.exceptions ?? []), ...excluded.map((text) => clip(text, 300))];
    }
  });
  const entries = dedupe(regional);
  const declared = Number(doc?.data?.['has-regional-advisory'] ?? indexEntry?.['has-regional-advisory']) === 1;
  const published = indexEntry?.['date-published']?.date ?? null;
  const slug = english['url-slug'] ?? indexEntry?.eng?.['url-slug'] ?? null;
  return {
    authority: 'ca',
    level,
    label: level ? AUTHORITIES.ca.scale[level] && squash(String(english['advisory-text'] ?? indexEntry?.eng?.['advisory-text'] ?? AUTHORITIES.ca.scale[level])) : null,
    updatedAt: published ? published.slice(0, 10) : null,
    url: slug ? `https://travel.gc.ca/destinations/${slug}` : null,
    wholeCountry: level !== null,
    nationalLevel: level,
    regional: entries,
    regionalUnparsed: entries.some((entry) => entry.unparsed) || (declared && entries.length === 0) || unreadable,
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * The snapshot
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */

/** The names a page's own country goes by, so "to Afghanistan" is read as the whole country and not as a region. */
function contextFor(isos, extraNames = []) {
  const names = new Set();
  for (const iso of isos) names.add(normName(ISO_NAME.get(iso) ?? iso));
  for (const name of extraNames) if (name) names.add(normName(name));
  for (const [key, iso] of ISO_BY_NAME) if (isos.includes(iso)) names.add(key);
  return { iso: isos.length === 1 ? isos[0] : null, names };
}

/**
 * A page about part of an ISO country (Gaza, the Azores, the Canary Islands) is filed under that
 * country as a warning for the named part only: its level is never the whole country's.
 */
function asPartOnly(advisory, part) {
  const label = advisory.label ?? '';
  return {
    ...advisory,
    subject: part,
    wholeCountry: false,
    nationalLevel: null,
    regional: [{ level: advisory.level, label, areas: [{ kind: 'place', name: part }], text: clip(`${part}: ${label}`) }, ...advisory.regional.map((entry) => ({ ...entry, heading: entry.heading ?? part }))],
  };
}

/**
 * Everything the authorities published → `advisories-v2.json`.
 *
 * `raw` is what `advisories.mjs` cached: `{ us: { rows }, uk: { index, pages }, ca: { index, pages } }`,
 * any of them null when that authority has never been fetched.
 */
export function buildSnapshot(raw, { fetchedAt, fetchErrors = {} } = {}) {
  const countries = {};
  const unmapped = { us: [], uk: [], ca: [] };
  const codeDisagreements = [];
  const authorities = {};
  const add = (iso, advisory) => {
    countries[iso] ??= { name: ISO_NAME.get(iso) ?? iso, advisories: [] };
    /* The U.S. feed carries Tonga twice (codes TA and TN), same level and date. One country, one advisory. */
    if (countries[iso].advisories.some((other) => other.authority === advisory.authority && !other.subject && !advisory.subject && other.level === advisory.level && other.updatedAt === advisory.updatedAt)) return;
    countries[iso].advisories.push(advisory);
  };
  const file = (authority, identity, displayName, make) => {
    const resolved = resolveIdentity(authority, identity);
    if (!resolved) {
      unmapped[authority].push(displayName);
      return;
    }
    const advisory = make(contextFor(resolved.isos, [displayName]));
    if (!advisory) return;
    for (const iso of resolved.isos) {
      if (resolved.part) add(iso, asPartOnly(advisory, resolved.part));
      else add(iso, resolved.subject ? { ...advisory, subject: resolved.subject } : advisory);
    }
  };

  if (raw.us?.rows) {
    authorities.us = publicAuthority('us');
    for (const row of raw.us.rows) {
      const title = parseUsTitle(row.Title);
      if (!title) {
        unmapped.us.push(row.Title ?? '(untitled)');
        continue;
      }
      file('us', title.name, title.name, (context) => parseUsAdvisory(row, context));
      const resolved = resolveIdentity('us', title.name);
      const code = Array.isArray(row.Category) ? row.Category[0] : null;
      if (resolved && code && !resolved.isos.includes(FIPS_TO_ISO.get(code))) codeDisagreements.push({ authority: 'us', name: title.name, code, codeReadsAs: FIPS_TO_ISO.get(code) ?? null, filedUnder: resolved.isos });
    }
  }
  if (raw.uk?.index) {
    authorities.uk = publicAuthority('uk');
    for (const child of raw.uk.index.links?.children ?? []) {
      const slug = child.base_path.split('/').pop();
      const name = child.details?.country?.name ?? slug;
      const doc = raw.uk.pages?.[slug];
      if (!doc) {
        unmapped.uk.push(`${name} (page not cached)`);
        continue;
      }
      file('uk', name, name, (context) => parseUkAdvice(doc, context));
    }
  }
  if (raw.ca?.index) {
    authorities.ca = publicAuthority('ca');
    for (const [key, entry] of Object.entries(raw.ca.index.data ?? {})) {
      const doc = raw.ca.pages?.[key];
      const name = entry['country-eng'] ?? key;
      if (!doc) {
        unmapped.ca.push(`${name} (file not cached)`);
        continue;
      }
      file('ca', key, name, (context) => parseCaAdvice(entry, doc, context));
    }
  }

  const sorted = Object.fromEntries(
    Object.keys(countries)
      .sort()
      .map((iso) => [iso, { name: countries[iso].name, advisories: countries[iso].advisories.sort((a, b) => a.authority.localeCompare(b.authority) || (a.subject ?? '').localeCompare(b.subject ?? '')) }]),
  );
  return {
    schema: 2,
    fetchedAt: fetchedAt ?? null,
    levels: { 1: 'exercise normal care', 2: 'increased caution', 3: 'reconsider travel / all but essential travel', 4: 'do not travel / against all travel', null: 'the authority publishes no warning for this country — silence, never "safe"' },
    areaKinds: {
      place: 'a named place a gazetteer can be asked for; `scope: "part"` + `qualifier` when the warning covers only part of it; `except` lists what the authority leaves out',
      border_zone: 'a strip along a border: `neighbour` (ISO when it is a country), `distanceKm` when stated, `within` when limited to a named region',
      proximity: 'within a stated distance of something that is not a border',
      route: 'a road or rail route',
      rest_of_country: 'the whole country, or everything not named by a stricter statement',
      described: 'the authority\'s words, kept because the parser could not turn them into names (sets `regionalUnparsed`)',
    },
    authorities,
    notIncluded: NOT_INCLUDED,
    ...(Object.keys(fetchErrors).length > 0 ? { fetchErrors } : {}),
    unmapped,
    codeDisagreements,
    countries: sorted,
  };
}

function publicAuthority(key) {
  const { name, url, feed, licence, licenceUrl, grant, grantNote, attribution, scale } = AUTHORITIES[key];
  return { name, url, feed, licence, licenceUrl, grant, grantNote, attribution, scale };
}

/** Per-authority coverage lines for the command's output. */
export function summarise(snapshot) {
  const lines = [];
  for (const key of Object.keys(snapshot.authorities)) {
    const rows = Object.values(snapshot.countries).flatMap((country) => country.advisories.filter((advisory) => advisory.authority === key));
    const dates = rows.map((row) => row.updatedAt).filter(Boolean).sort();
    const withRegional = rows.filter((row) => row.regional.length > 0 || row.regionalUnparsed);
    const named = withRegional.filter((row) => row.regional.length > 0 && !row.regionalUnparsed);
    const levels = [1, 2, 3, 4, null].map((level) => `${level ?? 'none'}:${rows.filter((row) => row.level === level).length}`).join(' ');
    lines.push(`${key}  ${rows.length} advisories, levels ${levels}, updated ${dates[0] ?? '?'} … ${dates[dates.length - 1] ?? '?'}; regional advice in ${withRegional.length} (${named.length} fully named, ${withRegional.length - named.length} with unparsed text)${snapshot.unmapped[key].length ? `; UNMAPPED: ${snapshot.unmapped[key].join(', ')}` : ''}`);
  }
  if (snapshot.codeDisagreements.length > 0) lines.push(`us  feed code ≠ name for: ${snapshot.codeDisagreements.map((entry) => `${entry.name} (${entry.code})`).join(', ')}`);
  return lines;
}
