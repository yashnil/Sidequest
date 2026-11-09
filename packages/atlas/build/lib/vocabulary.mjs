/**
 * THE WORDS THAT COUNT AS EVIDENCE, AND THE WORDS THAT ARE INDEXED.
 *
 * Shared by the build stages. Two things live here:
 *
 * 1. `EXPERIENCE_PATTERNS` — for each of the advisor's 24 experiences, the
 *    phrases whose presence in a travel guide is evidence the place offers it.
 *    A hit is never a score: the hits are saturated, combined with measured
 *    features and terrain, and fitted against the curated catalog's editorial
 *    labels in stage 06. The list order must match `EXPERIENCES` in
 *    `@sidequest/core` (asserted in `packages/atlas/src/atlas.test.ts`).
 *
 * 2. `stem` / `tokens` — the tokeniser of the lexical index. The runtime has
 *    the same function in TypeScript (`packages/core/src/atlas/lexical.ts`);
 *    the same test holds the two to identical output.
 */

export const EXPERIENCES = [
  'day_hiking',
  'multi_day_trekking',
  'high_mountains',
  'glaciers_ice',
  'volcanoes_geothermal',
  'lakes',
  'beaches_swimming',
  'coastal_scenery',
  'snorkel_dive',
  'paddling_boating',
  'big_game_safari',
  'wildlife_general',
  'marine_wildlife',
  'birding',
  'rainforest_biodiversity',
  'desert_landscapes',
  'scenic_driving',
  'rail_journeys',
  'winter_snow',
  'hot_springs_wellness',
  'villages_culture',
  'food',
  'city_life',
  'night_skies',
];

export const EXPERIENCE_PATTERNS = {
  day_hiking: /\b(hik(e|es|ing|ers?)|trail(s|heads?)?|walking (path|route|trail|track)s?|footpaths?|day walks?|scrambl\w+|rambl\w+|hill ?walking|bushwalk\w*|tramping)\b/g,
  multi_day_trekking: /\b(trek(s|king|kers?)?|multi-?day|backpacking|hut[- ]to[- ]hut|long[- ]distance (trail|path|walk|hike|footpath)s?|thru-?hik\w+|mountain huts?|refug(e|io|es|ios)|base ?camp|tea ?houses?|circuit trek)\b/g,
  high_mountains: /\b(mountain(s|ous|eering)?|peaks?|summits?|alpine|massifs?|glaciated|climb(ing|ers)?|high altitude|high pass(es)?|ridge(s|line)?|above sea level)\b/g,
  glaciers_ice: /\b(glaciers?|glacial|icebergs?|ice ?fields?|ice ?caps?|ice caves?)\b/g,
  volcanoes_geothermal: /\b(volcan(o|oes|os|ic)|craters?|lava|geysers?|geothermal|fumaroles?|calderas?|mud ?pools?)\b/g,
  lakes: /\b(lakes?|lochs?|lagoons?|tarns?)\b/g,
  beaches_swimming: /\b(beach(es)?|swim(ming)?|sunbath\w+|white sand|sandy|bathing|seaside|surf(ing|ers?)?|coves?)\b/g,
  coastal_scenery: /\b(coast(al|line)?|cliffs?|headlands?|sea views?|shore(line)?|bays?|islands?|islets?|peninsulas?|lighthouses?|fjords?|fiords?)\b/g,
  snorkel_dive: /\b(snorkel(l?ing)?|scuba|div(e|es|ing|ers?)|coral|reefs?|liveaboards?|manta rays?|whale sharks?)\b/g,
  paddling_boating: /\b(kayak(s|ing)?|canoe(s|ing)?|raft(ing)?|boat (trips?|tours?|rides?)|sail(ing)?|paddl\w+|cruises?)\b/g,
  big_game_safari: /\b(safaris?|game drives?|game reserves?|big five|lions?|elephants?|leopards?|rhinos?|cheetahs?|giraffes?|wildebeest|zebras?|tigers?|hippos?)\b/g,
  wildlife_general: /\b(wildlife|fauna|bears?|wolves|monkeys?|moose|elk|bison|kangaroos?|koalas?|orangutans?|gorillas?|chimpanzees?|lemurs?|sloths?|jaguars?|nature reserves?|wildlife sanctuar(y|ies))\b/g,
  marine_wildlife: /\b(whales?|dolphins?|seals?|sea lions?|penguins?|sea turtles?|turtles?|sharks?|whale[- ]watching|puffins?|orcas?|dugongs?|manatees?)\b/g,
  birding: /\b(bird(ing|watching|life|watchers?)|birds|flamingos?|eagles?|condors?|pelicans?|ornitholog\w+|migratory)\b/g,
  rainforest_biodiversity: /\b(rain ?forests?|jungles?|cloud ?forests?|tropical forests?|canopy|biodiversity|mangroves?|primary forest)\b/g,
  desert_landscapes: /\b(deserts?|dunes?|oas[ie]s|canyons?|badlands|arid|wadis?|salt (flats?|pans?)|mesas?|camels?)\b/g,
  scenic_driving: /\b(scenic (drive|route|road|byway|highway)s?|road ?trips?|self[- ]drive|coastal road|mountain road|switchbacks?|byways?|panoramic road)\b/g,
  rail_journeys: /\b(scenic (train|railway|rail)|train (journey|ride|trip)s?|railways?|narrow[- ]gauge|steam trains?|funiculars?|rack railway|sleeper trains?)\b/g,
  winter_snow: /\b(ski(ing|ers?)?|ski (resort|area|lift|slope|run)s?|snowboard\w*|pistes?|snowshoe\w*|dog ?sledd?ing|snowmobil\w+|ice skating|northern lights|aurora)\b/g,
  hot_springs_wellness: /\b(hot springs?|thermal (bath|spring|pool|spa)s?|onsens?|spas?|hammams?|saunas?|mineral (springs?|baths?)|geothermal pools?)\b/g,
  villages_culture: /\b(villages?|old town|historic (cent(er|re)|town|quarter|district)|medieval|temples?|monaster(y|ies)|cathedrals?|church(es)?|mosques?|castles?|fort(s|ress(es)?)?|palaces?|ruins?|archaeological|heritage|unesco|traditional|festivals?|bazaars?|souks?|shrines?|pagodas?)\b/g,
  food: /\b(cuisine|restaurants?|street food|food markets?|local dish(es)?|speciall?t(y|ies)|wine(ry|ries|s)?|vineyards?|brewer(y|ies)|seafood|gastronom\w+|delicac(y|ies)|culinary|tastings?)\b/g,
  city_life: /\b(nightlife|bars?|clubs?|pubs?|shopping|malls?|galler(y|ies)|theat(re|er)s?|metro|downtown|neighbou?rhoods?|skyline|museums?|live music|cosmopolitan)\b/g,
  night_skies: /\b(stargaz\w+|dark sk(y|ies)|milky way|northern lights|aurora( borealis| australis)?|observator(y|ies)|night sk(y|ies))\b/g,
};

/** Signals about getting around and who a place suits, read from the practical sections. */
export const PRACTICAL_PATTERNS = {
  transit: /\b(bus(es)?|metro|trams?|subway|trains?|railway station|public transport(ation)?|minibus(es)?|marshrutkas?|ferr(y|ies)|shared taxis?)\b/g,
  car: /\b(rent(ing)? a car|car (rental|hire)|hire a car|by car|own (car|vehicle)|4x4|4wd|four[- ]wheel|no public transport|self[- ]drive|parking)\b/g,
  walkable: /\b(walkable|on foot|compact|pedestrian(i[sz]ed)?|easily walked|bicycles?|bike (rental|hire))\b/g,
  family: /\b(famil(y|ies)|children|kids|playgrounds?|zoo|aquarium|theme parks?|water ?parks?|child[- ]friendly)\b/g,
  accessible: /\b(wheelchair|accessible|step[- ]free|elevators?|ramps?|paved)\b/g,
  luxury: /\b(luxury|five[- ]star|5[- ]star|boutique hotels?|resorts?|upscale|splurge)\b/g,
  budget: /\b(hostels?|guesthouses?|guest houses?|homestays?|backpackers?|camp(ing|sites?|grounds?)|budget)\b/g,
};

const STOP = new Set(
  'the a an and or of in on at to for from by with as is are was were be been being it its this that these those there here which who whom whose what when where why how not no nor but if then than so such very can could should would may might must will shall do does did done have has had having you your yours we our ours they them their he him his she her i me my also more most some any all each every other others one two three four five six seven eight nine ten first second third many much few several about above below under over between into through during before after again further once only own same too just out up down off near around along across via per etc e.g i.e km m ft miles mile hours hour minutes minute day days week weeks year years time times well good great best nice small large big little long short old new high low main local many there their get go goes going take takes taken make makes made see sees seen visit visits visiting visitor visitors place places area areas town towns city cities region regions country countries part parts side sides end way ways road roads street streets north south east west northern southern eastern western centre center central located location known called named including include includes around within without available open closed daily hotel hotels room rooms price prices phone tel fax email website http https www com org net'.split(
    /\s+/,
  ),
);

/** Folds a word to its index form: lower case, accents off, the commonest English plurals off. Deliberately tiny. */
export function stem(word) {
  let w = word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(ches|shes|sses|xes|zes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  return w;
}

/** The index terms of a text, in order, stopwords and numbers removed. */
export function tokens(text) {
  const out = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (raw.length < 3 || raw.length > 24 || STOP.has(raw)) continue;
    const term = stem(raw);
    if (term.length < 3 || STOP.has(term)) continue;
    out.push(term);
  }
  return out;
}

export const STOPWORDS = STOP;
