/**
 * WHICH ANIMALS COUNT AS "FLAGSHIP", BY SCIENTIFIC NAME.
 *
 * This file holds names only. Every name is resolved to a GBIF backbone key at
 * build time through the species-match API (`10-wildlife.mjs#resolveTaxa`),
 * which refuses anything but an exact match at the stated rank — a key is never
 * typed by hand, for the same reason stage 03 never trusts a remembered QID.
 *
 * A group is a traveller's idea ("big cats", "great apes"), not a clade, so a
 * species may sit in more than one (the polar bear is a bear and is not listed
 * as marine; the African wild dog is megafauna and a wild canid). A higher
 * taxon (`rank` other than SPECIES) stands for every species beneath it, which
 * the build enumerates from the backbone.
 *
 * `land` groups answer "which flagship large mammals are documented here";
 * `marine` groups answer "which marine megafauna are documented near here".
 * Penguins are birds and arrive with the bird list; they are counted separately
 * because a penguin colony is a destination's reason in a way a gull is not.
 */

const species = (names) => names.map((name) => ({ name, rank: 'SPECIES' }));

export const LAND_GROUPS = {
  african_megafauna: [
    ...species([
      'Loxodonta africana',
      'Loxodonta cyclotis',
      'Diceros bicornis',
      'Ceratotherium simum',
      'Syncerus caffer',
      'Hippopotamus amphibius',
      'Equus quagga',
      'Equus grevyi',
      'Equus zebra',
      'Connochaetes taurinus',
      'Connochaetes gnou',
      'Taurotragus oryx',
      'Hippotragus niger',
      'Hippotragus equinus',
      'Oryx gazella',
      'Tragelaphus strepsiceros',
      'Crocuta crocuta',
      'Lycaon pictus',
    ]),
    { name: 'Giraffa', rank: 'GENUS' },
  ],
  asian_megafauna: species([
    'Elephas maximus',
    'Rhinoceros unicornis',
    'Rhinoceros sondaicus',
    'Dicerorhinus sumatrensis',
    /* The backbone files the gaur as a subspecies of Bos frontalis (gaur + the semi-domestic gayal), so the species is asked for whole. */
    'Bos frontalis',
    'Bos javanicus',
    'Tapirus indicus',
    'Equus kiang',
    'Equus hemionus',
    'Budorcas taxicolor',
  ]),
  great_apes: species(['Gorilla gorilla', 'Gorilla beringei', 'Pan troglodytes', 'Pan paniscus', 'Pongo pygmaeus', 'Pongo abelii', 'Pongo tapanuliensis']),
  big_cats: species(['Panthera leo', 'Panthera pardus', 'Panthera tigris', 'Panthera onca', 'Panthera uncia', 'Acinonyx jubatus', 'Puma concolor', 'Neofelis nebulosa', 'Neofelis diardi']),
  bears: species(['Ursus arctos', 'Ursus americanus', 'Ursus maritimus', 'Ursus thibetanus', 'Melursus ursinus', 'Helarctos malayanus', 'Tremarctos ornatus', 'Ailuropoda melanoleuca']),
  wild_canids: species(['Canis lupus', 'Lycaon pictus', 'Cuon alpinus', 'Chrysocyon brachyurus', 'Canis simensis']),
  northern_megafauna: species(['Bison bison', 'Bison bonasus', 'Alces alces', 'Rangifer tarandus', 'Ovibos moschatus', 'Gulo gulo', 'Lynx lynx', 'Oreamnos americanus']),
  neotropical_megafauna: species([
    'Tapirus terrestris',
    'Tapirus bairdii',
    'Tapirus pinchaque',
    'Myrmecophaga tridactyla',
    'Pteronura brasiliensis',
    'Hydrochoerus hydrochaeris',
    'Vicugna vicugna',
    'Blastocerus dichotomus',
    'Priodontes maximus',
  ]),
  australasian_icons: species([
    'Osphranter rufus',
    'Macropus giganteus',
    'Macropus fuliginosus',
    'Phascolarctos cinereus',
    'Vombatus ursinus',
    'Sarcophilus harrisii',
    'Ornithorhynchus anatinus',
    'Tachyglossus aculeatus',
  ]),
  primates_notable: [
    { name: 'Lemuridae', rank: 'FAMILY' },
    { name: 'Indriidae', rank: 'FAMILY' },
    { name: 'Rhinopithecus', rank: 'GENUS' },
    ...species(['Daubentonia madagascariensis', 'Nasalis larvatus', 'Mandrillus sphinx', 'Theropithecus gelada']),
  ],
};

export const MARINE_GROUPS = {
  cetaceans: [{ name: 'Cetacea', rank: 'ORDER' }],
  sea_turtles: [
    { name: 'Cheloniidae', rank: 'FAMILY' },
    { name: 'Dermochelyidae', rank: 'FAMILY' },
  ],
  whale_shark: species(['Rhincodon typus']),
  manta_rays: [{ name: 'Mobula', rank: 'GENUS' }],
  pinnipeds: [
    { name: 'Phocidae', rank: 'FAMILY' },
    { name: 'Otariidae', rank: 'FAMILY' },
    { name: 'Odobenidae', rank: 'FAMILY' },
  ],
  sirenians: [{ name: 'Sirenia', rank: 'ORDER' }],
};

/*
 * Deliberately absent, because the backbone files the wild animal as a
 * subspecies of a species that is mostly livestock or mostly something else,
 * and a species-level facet cannot tell them apart: wild yak (under Bos
 * grunniens), wild water buffalo (under Bubalus bubalis), guanaco (under Lama
 * glama) and wapiti (under Cervus elaphus, the red deer of every European
 * forest). Listing them would report a paddock as megafauna.
 */

/** Birds counted on their own as well as in the bird total. */
export const BIRD_GROUPS = {
  penguins: [{ name: 'Spheniscidae', rank: 'FAMILY' }],
};

/** The classes the occurrence query asks for whole. */
export const WHOLE_CLASSES = { birds: { name: 'Aves', rank: 'CLASS' }, mammals: { name: 'Mammalia', rank: 'CLASS' } };

/**
 * Domestic forms the backbone files as subspecies of a wild flagship species,
 * so their records roll up into the wild species' key. They are counted
 * separately and subtracted: within 25 km of central London every one of the 78
 * "wolf" records since 2000 is a dog.
 */
export const DOMESTIC_FORMS = [
  { of: 'Canis lupus', name: 'Canis lupus familiaris', rank: 'SUBSPECIES' },
  { of: 'Canis lupus', name: 'Canis lupus dingo', rank: 'SUBSPECIES' },
];
