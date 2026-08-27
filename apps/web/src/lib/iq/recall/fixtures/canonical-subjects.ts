/**
 * CANONICAL SUBJECTS — AN EVALUATION FIXTURE, AND NOTHING ELSE.
 *
 * ## What this file is
 *
 * A list of experiences a well-informed traveller would expect a travel product
 * to know about in a given destination: landmarks, museums, sacred sites, parks,
 * markets, districts. It exists so that "did we discover this place" becomes a
 * *measurement* rather than an impression.
 *
 * ## What this file is emphatically not
 *
 * It is not a seed list, a boost table, a whitelist, or an input to anything the
 * product does. Production code may never read it, and
 * `fixture-quarantine.test.ts` fails the build if any production file so much as
 * mentions one of these names. That test is the reason this file can exist at
 * all: a canonical list inside the engine would be the destination-specific
 * behaviour §4 forbids ("Do not fix it with Tokyo-specific names or rules"), and
 * a canonical list inside the *evaluation* is the only way to prove the engine
 * works without one.
 *
 * ## Why each field is here
 *
 * A source does not publish the name a traveller uses. A live pack returned the
 * Tokyo Imperial Palace as `Hoàng cung Tokyo` and as `Императорский дворец
 * Токио`, and Tokyo Disneyland as `東京迪士尼樂園`. Matching on an English string
 * would have scored all three as missing. So a subject carries:
 *
 * - `aliases` — every name a source plausibly publishes, across scripts;
 * - `point` + `radiusMetres` — because position is the one thing every catalogue
 *   agrees on, and a subject can therefore be recognised through a name nobody
 *   anticipated;
 * - `kind` — because proximity alone produces false positives that flatter the
 *   product. A live pack held `浅草寺の神木・いちょう` — *the ginkgo tree outside
 *   Sensō-ji* — 91 m from the temple. Ninety-one metres and not the temple. The
 *   kind is what lets the matcher refuse it.
 * - `sourceEvidence` — how we know the catalogue publishes this at all, since
 *   stage one of the recall report is "present in source", and asserting a
 *   product missed something nobody published would be a lie about the product.
 *
 * ## Choosing subjects
 *
 * Three destination classes, deliberately unlike each other, because §29 opens
 * with *do not judge global quality from one destination*: a dense transit
 * metropolis, a second dense metropolis in the same country (so a fix cannot be
 * one city's), and a sparse road/outdoor country. Subjects are chosen for being
 * obviously significant to a first-time traveller, not for being easy to find.
 *
 * A subject appearing here is **not** a claim that a good itinerary contains it.
 * A traveller who hates crowds should be shown neither Shibuya Crossing nor
 * Times Square, and the gate below is written so that a deliberate exclusion is
 * invisible to it. See `stages.ts` for why the gate sits where it does.
 */

/**
 * What sort of experience a subject is.
 *
 * Coarse on purpose: it exists to reject a tree standing next to a temple, not
 * to describe the temple. Each kind maps to the candidate roles the product's
 * own taxonomy would have to produce for a record to *be* this subject.
 */
export type CanonicalKind =
  | 'landmark'
  | 'museum'
  | 'sacred_site'
  | 'park'
  | 'market'
  | 'district'
  | 'attraction_complex'
  | 'natural_feature';

export interface CanonicalSubject {
  /** Stable, script-free, used in reports and baselines. */
  id: string;
  /** What the interface would call it. */
  name: string;
  /**
   * Every name a catalogue might publish, in any script. Folded before
   * comparison, so accents and punctuation do not matter.
   */
  aliases: readonly string[];
  kind: CanonicalKind;
  point: { lat: number; lng: number };
  /**
   * How far from `point` a record may sit and still be this subject.
   *
   * Sized to the subject rather than to a constant. A tower is a point; an
   * imperial palace is 1.15 km² and its published centroid landed 307 m from
   * the coordinate below in a real pack, so a 350 m constant would have scored
   * a hit as a miss.
   */
  radiusMetres: number;
  /**
   * How we know the source catalogue carries this.
   *
   * `probed` — somebody ran the product's own builder over a small box around
   * this point and saw the record come back. `expected` — no direct probe; the
   * subject is a globally documented place that the underlying open datasets
   * carry, and the fixture says so out loud rather than pretending to a
   * measurement it does not have.
   */
  sourceEvidence: 'probed' | 'expected';
  /** Free text for anything a future reader would otherwise have to rediscover. */
  note?: string;
}

export interface CanonicalDestination {
  id: string;
  /** The trip *shape* this destination stands for. See §29's matrix. */
  shape: string;
  /**
   * How to find this destination's stored artifacts offline.
   *
   * The catalogue identifier the scope was built from, so the reality arm can
   * pick the right pack out of a database holding several destinations without
   * matching on a human name.
   */
  destinationCandidateId: string;
  subjects: readonly CanonicalSubject[];
}

/* -------------------------------------------------------------------------- */
/* A. Dense transit metropolis                                                */
/* -------------------------------------------------------------------------- */

const TOKYO: CanonicalDestination = {
  id: 'tokyo',
  shape: 'dense transit metropolis (§29 A)',
  destinationCandidateId: 'overture:798895d4-5005-4b1d-b805-ee44a1f99a54',
  subjects: [
    {
      id: 'imperial-palace',
      name: 'Imperial Palace',
      aliases: ['皇居', 'Kokyo', 'Tokyo Imperial Palace', 'Hoàng cung Tokyo', 'Императорский дворец Токио'],
      kind: 'landmark',
      point: { lat: 35.6852, lng: 139.7528 },
      radiusMetres: 900,
      sourceEvidence: 'probed',
      note: 'Returned as Vietnamese and Russian names in a live pack; centroid 307 m off centre.',
    },
    {
      id: 'tokyo-national-museum',
      name: 'Tokyo National Museum',
      aliases: ['東京国立博物館', 'Tokyo Kokuritsu Hakubutsukan', 'Honkan'],
      kind: 'museum',
      point: { lat: 35.7188, lng: 139.7766 },
      radiusMetres: 350,
      sourceEvidence: 'probed',
    },
    {
      id: 'shinjuku-gyoen',
      name: 'Shinjuku Gyoen',
      aliases: ['新宿御苑', 'Shinjuku Gyoen National Garden'],
      kind: 'park',
      point: { lat: 35.6852, lng: 139.71 },
      radiusMetres: 700,
      sourceEvidence: 'probed',
    },
    {
      id: 'yoyogi-park',
      name: 'Yoyogi Park',
      aliases: ['代々木公園', 'Yoyogi Koen'],
      kind: 'park',
      point: { lat: 35.6712, lng: 139.6949 },
      radiusMetres: 700,
      sourceEvidence: 'probed',
    },
    {
      id: 'hamarikyu-gardens',
      name: 'Hamarikyu Gardens',
      aliases: ['浜離宮恩賜庭園', 'Hama-rikyu Gardens', 'Hamarikyu Onshi Teien'],
      kind: 'park',
      point: { lat: 35.6597, lng: 139.7634 },
      radiusMetres: 500,
      sourceEvidence: 'probed',
    },
    {
      id: 'tokyo-disneyland',
      name: 'Tokyo Disneyland',
      aliases: ['東京ディズニーランド', '東京迪士尼樂園', 'Tokyo Disney Resort'],
      kind: 'attraction_complex',
      point: { lat: 35.6329, lng: 139.8804 },
      radiusMetres: 900,
      sourceEvidence: 'probed',
    },
    {
      id: 'senso-ji',
      name: 'Sensō-ji',
      aliases: ['浅草寺', 'Sensoji', 'Asakusa Kannon Temple'],
      kind: 'sacred_site',
      point: { lat: 35.7148, lng: 139.7967 },
      radiusMetres: 350,
      sourceEvidence: 'probed',
      note: 'A live pack held the ginkgo tree outside it at 91 m and not the temple.',
    },
    {
      id: 'tokyo-skytree',
      name: 'Tokyo Skytree',
      aliases: ['東京スカイツリー', 'Tokyo Sky Tree'],
      kind: 'landmark',
      point: { lat: 35.7101, lng: 139.8107 },
      radiusMetres: 350,
      sourceEvidence: 'expected',
    },
    {
      id: 'meiji-jingu',
      name: 'Meiji Jingū',
      aliases: ['明治神宮', 'Meiji Jingu', 'Meiji Shrine'],
      kind: 'sacred_site',
      point: { lat: 35.6764, lng: 139.6993 },
      radiusMetres: 500,
      sourceEvidence: 'probed',
    },
    {
      id: 'tokyo-tower',
      name: 'Tokyo Tower',
      aliases: ['東京タワー', 'Tōkyō Tawā'],
      kind: 'landmark',
      point: { lat: 35.6586, lng: 139.7454 },
      radiusMetres: 300,
      sourceEvidence: 'probed',
      note: "The product's own builder over a 1 km box returns it twice, as historic_site and observatory. It is in the source and was never decoded.",
    },
    {
      id: 'shibuya-crossing',
      name: 'Shibuya Scramble Crossing',
      aliases: ['渋谷スクランブル交差点', 'Shibuya Crossing', 'Shibuya Scramble'],
      kind: 'district',
      point: { lat: 35.6595, lng: 139.7005 },
      radiusMetres: 400,
      sourceEvidence: 'expected',
    },
    {
      id: 'ueno-park',
      name: 'Ueno Park',
      aliases: ['上野公園', 'Ueno Onshi Koen'],
      kind: 'park',
      point: { lat: 35.7156, lng: 139.7745 },
      radiusMetres: 600,
      sourceEvidence: 'probed',
    },
    {
      id: 'tsukiji-outer-market',
      name: 'Tsukiji Outer Market',
      aliases: ['築地場外市場', 'Tsukiji Jogai Shijo', 'Tsukiji Market'],
      kind: 'market',
      point: { lat: 35.6654, lng: 139.7707 },
      radiusMetres: 400,
      sourceEvidence: 'expected',
    },
    {
      id: 'teamlab-planets',
      name: 'teamLab Planets',
      aliases: ['チームラボプラネッツ', 'teamLab Planets TOKYO'],
      kind: 'museum',
      point: { lat: 35.6486, lng: 139.7899 },
      radiusMetres: 350,
      sourceEvidence: 'expected',
    },
    {
      id: 'zojo-ji',
      name: 'Zōjō-ji',
      aliases: ['増上寺', 'Zojoji', 'Zojo-ji Temple'],
      kind: 'sacred_site',
      point: { lat: 35.6574, lng: 139.7486 },
      radiusMetres: 350,
      sourceEvidence: 'expected',
    },
    {
      id: 'mori-art-museum',
      name: 'Mori Art Museum',
      aliases: ['森美術館', 'Mori Bijutsukan', 'Roppongi Hills Mori Tower'],
      kind: 'museum',
      point: { lat: 35.6606, lng: 139.7298 },
      radiusMetres: 350,
      sourceEvidence: 'expected',
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* B. A second dense metropolis, so no fix can be one city's                   */
/* -------------------------------------------------------------------------- */

const OSAKA: CanonicalDestination = {
  id: 'osaka',
  shape: 'dense transit metropolis, second instance (§29 A, anti-overfit)',
  destinationCandidateId: 'overture:5e3f1304-64a4-49b7-9bcd-756c96466144',
  subjects: [
    {
      id: 'osaka-castle',
      name: 'Osaka Castle',
      aliases: ['大阪城', 'Osakajo', 'Ōsaka-jō'],
      kind: 'landmark',
      point: { lat: 34.6873, lng: 135.5259 },
      radiusMetres: 500,
      sourceEvidence: 'probed',
      note: 'Named in the phase report as absent from the Osaka board.',
    },
    {
      id: 'dotonbori',
      name: 'Dōtonbori',
      aliases: ['道頓堀', 'Dotonbori'],
      kind: 'district',
      point: { lat: 34.6687, lng: 135.5013 },
      radiusMetres: 500,
      sourceEvidence: 'expected',
    },
    {
      id: 'umeda-sky-building',
      name: 'Umeda Sky Building',
      aliases: ['梅田スカイビル', 'Kuchu Teien Observatory'],
      kind: 'landmark',
      point: { lat: 34.7053, lng: 135.4903 },
      radiusMetres: 300,
      sourceEvidence: 'expected',
    },
    {
      id: 'shitenno-ji',
      name: 'Shitennō-ji',
      aliases: ['四天王寺', 'Shitennoji'],
      kind: 'sacred_site',
      point: { lat: 34.6544, lng: 135.5165 },
      radiusMetres: 400,
      sourceEvidence: 'expected',
    },
    {
      id: 'sumiyoshi-taisha',
      name: 'Sumiyoshi Taisha',
      aliases: ['住吉大社', 'Sumiyoshi Grand Shrine'],
      kind: 'sacred_site',
      point: { lat: 34.6122, lng: 135.4933 },
      radiusMetres: 400,
      sourceEvidence: 'expected',
    },
    {
      id: 'kuromon-market',
      name: 'Kuromon Ichiba Market',
      aliases: ['黒門市場', 'Kuromon Market'],
      kind: 'market',
      point: { lat: 34.6656, lng: 135.5062 },
      radiusMetres: 350,
      sourceEvidence: 'expected',
    },
    {
      id: 'osaka-aquarium',
      name: 'Osaka Aquarium Kaiyukan',
      aliases: ['海遊館', 'Kaiyukan'],
      kind: 'museum',
      point: { lat: 34.6545, lng: 135.4289 },
      radiusMetres: 300,
      sourceEvidence: 'expected',
    },
    {
      id: 'tsutenkaku',
      name: 'Tsūtenkaku',
      aliases: ['通天閣', 'Tsutenkaku Tower'],
      kind: 'landmark',
      point: { lat: 34.6525, lng: 135.5063 },
      radiusMetres: 250,
      sourceEvidence: 'expected',
    },
    {
      id: 'shinsekai',
      name: 'Shinsekai',
      aliases: ['新世界'],
      kind: 'district',
      point: { lat: 34.6521, lng: 135.5058 },
      radiusMetres: 500,
      sourceEvidence: 'expected',
    },
    {
      id: 'nakanoshima-park',
      name: 'Nakanoshima Park',
      aliases: ['中之島公園', 'Nakanoshima Koen'],
      kind: 'park',
      point: { lat: 34.6929, lng: 135.5106 },
      radiusMetres: 500,
      sourceEvidence: 'expected',
    },
    {
      id: 'national-museum-of-art-osaka',
      name: 'National Museum of Art, Osaka',
      aliases: ['国立国際美術館', 'Kokuritsu Kokusai Bijutsukan'],
      kind: 'museum',
      point: { lat: 34.6917, lng: 135.4919 },
      radiusMetres: 300,
      sourceEvidence: 'expected',
    },
    {
      id: 'universal-studios-japan',
      name: 'Universal Studios Japan',
      aliases: ['ユニバーサル・スタジオ・ジャパン', 'USJ'],
      kind: 'attraction_complex',
      point: { lat: 34.6654, lng: 135.4323 },
      radiusMetres: 900,
      sourceEvidence: 'expected',
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* C. Sparse road / outdoor country                                            */
/* -------------------------------------------------------------------------- */

const ICELAND: CanonicalDestination = {
  id: 'iceland',
  shape: 'road and outdoor region, country breadth (§29 C/E)',
  destinationCandidateId: 'overture:911c2bdf-e87d-4b11-9aa7-162dcf129c7c',
  subjects: [
    {
      id: 'hallgrimskirkja',
      name: 'Hallgrímskirkja',
      aliases: ['Hallgrimskirkja', 'Hallgrímskirkja Church'],
      kind: 'sacred_site',
      point: { lat: 64.1417, lng: -21.9266 },
      radiusMetres: 250,
      sourceEvidence: 'expected',
    },
    {
      id: 'harpa',
      name: 'Harpa Concert Hall',
      aliases: ['Harpa', 'Harpa tónlistarhús'],
      kind: 'landmark',
      point: { lat: 64.1504, lng: -21.9327 },
      radiusMetres: 250,
      sourceEvidence: 'expected',
    },
    {
      id: 'blue-lagoon',
      name: 'Blue Lagoon',
      aliases: ['Bláa lónið', 'Blaa lonid'],
      kind: 'natural_feature',
      point: { lat: 63.8804, lng: -22.4495 },
      radiusMetres: 700,
      sourceEvidence: 'expected',
    },
    {
      id: 'thingvellir',
      name: 'Þingvellir National Park',
      aliases: ['Thingvellir', 'Þingvellir', 'Þingvellir þjóðgarður'],
      kind: 'park',
      point: { lat: 64.2559, lng: -21.1301 },
      radiusMetres: 1500,
      sourceEvidence: 'expected',
    },
    {
      id: 'gullfoss',
      name: 'Gullfoss',
      aliases: ['Gullfoss waterfall'],
      kind: 'natural_feature',
      point: { lat: 64.3271, lng: -20.1199 },
      radiusMetres: 600,
      sourceEvidence: 'expected',
    },
    {
      id: 'geysir',
      name: 'Geysir',
      aliases: ['Haukadalur', 'Strokkur', 'Great Geysir'],
      kind: 'natural_feature',
      point: { lat: 64.3104, lng: -20.3024 },
      radiusMetres: 600,
      sourceEvidence: 'expected',
    },
    {
      id: 'seljalandsfoss',
      name: 'Seljalandsfoss',
      aliases: ['Seljalandsfoss waterfall'],
      kind: 'natural_feature',
      point: { lat: 63.6156, lng: -19.9885 },
      radiusMetres: 400,
      sourceEvidence: 'expected',
    },
    {
      id: 'skogafoss',
      name: 'Skógafoss',
      aliases: ['Skogafoss', 'Skógafoss waterfall'],
      kind: 'natural_feature',
      point: { lat: 63.5321, lng: -19.5114 },
      radiusMetres: 400,
      sourceEvidence: 'expected',
    },
    {
      id: 'jokulsarlon',
      name: 'Jökulsárlón',
      /*
       * "Glacier lagoon" on its own is deliberately not an alias. It is a
       * *kind* of thing before it is a name — a benchmark traveller asks for
       * "a glacier lagoon" the way they ask for "a hot spring" — and an alias
       * that matches a common noun makes both the matcher and the quarantine
       * test noisy, which is how a guard gets switched off.
       */
      aliases: ['Jokulsarlon', 'Jökulsárlón glacier lagoon'],
      kind: 'natural_feature',
      point: { lat: 64.0784, lng: -16.2306 },
      radiusMetres: 1500,
      sourceEvidence: 'expected',
    },
    {
      id: 'dyrholaey',
      name: 'Dyrhólaey',
      aliases: ['Dyrholaey'],
      kind: 'natural_feature',
      point: { lat: 63.4022, lng: -19.126 },
      radiusMetres: 900,
      sourceEvidence: 'expected',
      note: 'Sits marginally south of some resolved country boxes; the instrument reports out-of-scope rather than counting it as a miss.',
    },
    {
      id: 'kerid',
      name: 'Kerið',
      aliases: ['Kerid', 'Kerid crater'],
      kind: 'natural_feature',
      point: { lat: 64.0411, lng: -20.8853 },
      radiusMetres: 400,
      sourceEvidence: 'expected',
    },
    {
      id: 'perlan',
      name: 'Perlan',
      aliases: ['Perlan Museum', 'The Pearl'],
      kind: 'museum',
      point: { lat: 64.1288, lng: -21.9187 },
      radiusMetres: 300,
      sourceEvidence: 'expected',
    },
  ],
};

export const CANONICAL_DESTINATIONS: Readonly<Record<string, CanonicalDestination>> = {
  tokyo: TOKYO,
  osaka: OSAKA,
  iceland: ICELAND,
};

/**
 * Every string in this file that must never appear in production code.
 *
 * Read by `fixture-quarantine.test.ts`. Names and aliases only — the ids are
 * deliberately excluded, because a slug like `harpa` is a common substring and
 * a quarantine test that cries wolf gets deleted.
 */
export function quarantinedNames(): string[] {
  const names = new Set<string>();
  for (const destination of Object.values(CANONICAL_DESTINATIONS)) {
    for (const subject of destination.subjects) {
      names.add(subject.name);
      for (const alias of subject.aliases) names.add(alias);
    }
  }
  return [...names].sort();
}
