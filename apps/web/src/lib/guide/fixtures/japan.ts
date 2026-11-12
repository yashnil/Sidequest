import type { GuideDay, GuideMap, GuideModel, GuideVariant } from '../model';

/**
 * A GUIDE WITH JAPANESE PLACE NAMES, FOR RENDERING TESTS ONLY.
 *
 * No fixture trip produces Japanese names, and the print layout has to prove
 * it sets them in a Japanese face (not a Chinese fallback), keeps them on one
 * line in tables and maps, and mixes them with Latin text cleanly. This is a
 * hand-written GuideModel — test data, never shown to a traveller: the print
 * route serves it only under the fixture composer at `/trips/fixture-japan/guide`.
 * Coordinates are approximate public positions of the named places.
 */

const P = {
  kyotoStation: { lat: 34.9858, lng: 135.7588 },
  fushimi: { lat: 34.9671, lng: 135.7727 },
  kiyomizu: { lat: 34.9949, lng: 135.785 },
  tanabe: { lat: 33.7337, lng: 135.3781 },
  takijiri: { lat: 33.7885, lng: 135.5135 },
  chikatsuyu: { lat: 33.8106, lng: 135.5707 },
  hongu: { lat: 33.8402, lng: 135.7731 },
  yunomine: { lat: 33.8301, lng: 135.7493 },
  nachi: { lat: 33.6687, lng: 135.8889 },
  hayatama: { lat: 33.7276, lng: 135.9895 },
};


/** Real Wikimedia Commons files, credited as their licences require. */
const PHOTO = {
  oyunohara: { src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2a/Torii_at_Oyunohara_01.jpg/960px-Torii_at_Oyunohara_01.jpg', alt: '大斎原 Ōyunohara torii', credit: 'Douglas Perkins, CC BY 4.0, via Wikimedia Commons', crop: true },
  fushimi: { src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0e/Torii_path_with_lantern_at_Fushimi_Inari_Taisha_Shrine%2C_Kyoto%2C_Japan.jpg/960px-Torii_path_with_lantern_at_Fushimi_Inari_Taisha_Shrine%2C_Kyoto%2C_Japan.jpg', alt: '伏見稲荷大社 Fushimi Inari-taisha', credit: 'Basile Morin, CC BY-SA 4.0, via Wikimedia Commons', crop: false },
  nakahechi: { src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b0/Kumano_Kodo_stairs.jpg/960px-Kumano_Kodo_stairs.jpg', alt: '熊野古道 Kumano Kodo stairs', credit: 'VKaeru, CC BY-SA 3.0, via Wikimedia Commons', crop: false },
  nachi: { src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7f/Nachikatsuura_Seiganto-ji_Three-Storied_Pagoda_%26_Nachi_Falls_07.jpg/960px-Nachikatsuura_Seiganto-ji_Three-Storied_Pagoda_%26_Nachi_Falls_07.jpg', alt: '那智の滝 Nachi Falls', credit: 'Zairon, CC BY 4.0, via Wikimedia Commons', crop: true },
};

function dayMap(points: GuideMap['points'], trail = false): GuideMap {
  return { points, lines: points.slice(1).map((point, index) => ({ points: [points[index]!, point], style: trail ? 'trail' : 'estimated' })), unplaced: 0 };
}

const DAYS: GuideDay[] = [
  {
    number: 1,
    isoDate: '2027-04-08',
    weekday: 'Thursday',
    dateLabel: '8 April',
    base: '京都 Kyoto',
    theme: 'Arrive and walk the shrine gates at dusk',
    intensity: 'Light',
    items: [
      { kind: 'stop', time: '14:00', approx: false, title: '京都駅 Kyoto Station', detail: 'Leave bags at the hotel near the station; trains south leave from here tomorrow.', duration: '30 min', pin: '1' },
      { kind: 'travel', time: null, approx: false, title: 'JR Nara Line to Inari', duration: '6 min' },
      { kind: 'stop', time: '15:15', approx: false, title: '伏見稲荷大社 Fushimi Inari-taisha', detail: 'The gates thin out after the Yotsutsuji crossroads, about forty minutes up.', duration: '2 hr', pin: '2' },
      { kind: 'travel', time: null, approx: true, title: 'Keihan Line to Kiyomizu-Gojō', duration: '≈ 20 min' },
      { kind: 'stop', time: '18:00', approx: true, title: '清水寺 Kiyomizu-dera', detail: 'Evening opening in spring; the stage faces west over the city.', duration: '1 hr 15 min', pin: '3' },
      { kind: 'meal', time: '19:30', approx: true, title: 'Dinner in 先斗町 Pontochō' },
    ],
    notes: ['Spring evening openings change year to year; check the temple’s own calendar the week before.'],
    map: dayMap([
      { ...P.kyotoStation, label: 'A', name: '京都 Kyoto', kind: 'base' },
      { ...P.kyotoStation, label: '1', name: '京都駅', kind: 'stop' },
      { ...P.fushimi, label: '2', name: '伏見稲荷大社', kind: 'stop' },
      { ...P.kiyomizu, label: '3', name: '清水寺', kind: 'stop' },
    ]),
    travel: '50 min on the move',
    photo: PHOTO.fushimi,
  },
  {
    number: 2,
    isoDate: '2027-04-09',
    weekday: 'Friday',
    dateLabel: '9 April',
    base: '近露 Chikatsuyu',
    move: { from: '京都 Kyoto', to: '近露 Chikatsuyu' },
    theme: 'Down to the Kii Peninsula and onto the Nakahechi trail',
    intensity: 'Full',
    items: [
      { kind: 'travel', time: null, approx: false, title: 'Limited express Kuroshio to 紀伊田辺 Kii-Tanabe', duration: '2 hr 50 min' },
      { kind: 'travel', time: null, approx: false, title: 'Ryūjin bus to 滝尻 Takijiri', duration: '40 min' },
      { kind: 'stop', time: '11:30', approx: false, title: '滝尻王子 Takijiri-ōji', detail: 'The traditional entrance to the sacred mountains; the climb starts steeply behind the shrine.', duration: '20 min', pin: '1' },
      { kind: 'stop', time: '12:00', approx: true, title: '熊野古道 中辺路 Nakahechi: Takijiri → Chikatsuyu', detail: 'About 13 km of forest trail and stone steps; carry lunch, there is nowhere to buy it.', duration: '6 hr', pin: '2', flag: 'Book ahead' },
      { kind: 'meal', time: '18:30', approx: true, title: 'Dinner at the minshuku (included)' },
    ],
    notes: ['Luggage transfer to Chikatsuyu must be booked two days ahead with the Kumano Travel desk.'],
    backup: 'Heavy rain: take the bus to 近露 Chikatsuyu and walk the short loop to 箸折峠 Hashiori-tōge instead.',
    map: dayMap(
      [
        { ...P.takijiri, label: '1', name: '滝尻王子', kind: 'stop' },
        { ...P.chikatsuyu, label: '2', name: '近露', kind: 'stop' },
      ],
      true,
    ),
    travel: '3 hr 30 min on the move',
    photo: PHOTO.nakahechi,
  },
  {
    number: 3,
    isoDate: '2027-04-10',
    weekday: 'Saturday',
    dateLabel: '10 April',
    base: '湯の峰温泉 Yunomine Onsen',
    move: { from: '近露 Chikatsuyu', to: '湯の峰温泉 Yunomine Onsen' },
    theme: 'The long day to the Grand Shrine',
    intensity: 'Full',
    items: [
      { kind: 'stop', time: '07:30', approx: false, title: '近露 → 発心門王子 Hosshinmon-ōji', detail: 'Bus the first section if your legs are tired; the final 7 km are the most beautiful.', duration: '5 hr', pin: '1' },
      { kind: 'stop', time: '13:30', approx: true, title: '熊野本宮大社 Kumano Hongū Taisha', detail: 'Walk on to 大斎原 Ōyunohara, the old shrine site, under the largest torii in Japan.', duration: '1 hr 30 min', pin: '2' },
      { kind: 'travel', time: null, approx: true, title: 'Bus to 湯の峰温泉 Yunomine Onsen', duration: '≈ 15 min' },
      { kind: 'stop', time: '16:00', approx: true, title: 'つぼ湯 Tsuboyu', detail: 'A one-family cabin bath in the river; take a numbered ticket at the shop.', duration: '30 min', pin: '3', flag: 'Timed entry' },
      { kind: 'meal', time: '18:30', approx: true, title: 'Kaiseki dinner at the ryokan (included)' },
    ],
    notes: [],
    backup: 'Bus all the way to 本宮 Hongū and spend the afternoon at the shrine and the onsen.',
    map: dayMap(
      [
        { ...P.chikatsuyu, label: '1', name: '近露', kind: 'stop' },
        { ...P.hongu, label: '2', name: '熊野本宮大社', kind: 'stop' },
        { ...P.yunomine, label: '3', name: 'つぼ湯', kind: 'stop' },
      ],
      true,
    ),
    travel: '15 min on the move',
  },
  {
    number: 4,
    isoDate: '2027-04-11',
    weekday: 'Sunday',
    dateLabel: '11 April',
    base: '湯の峰温泉 Yunomine Onsen',
    theme: 'Nachi Falls and the coast',
    intensity: 'Moderate',
    items: [
      { kind: 'travel', time: null, approx: false, title: 'Bus to 那智山 Nachisan via 新宮 Shingū', duration: '1 hr 50 min' },
      { kind: 'stop', time: '10:30', approx: false, title: '大門坂 Daimon-zaka', detail: 'Six hundred metres of cedar-lined stone stairs up to the shrine.', duration: '45 min', pin: '1' },
      { kind: 'stop', time: '11:30', approx: false, title: '那智の滝 Nachi Falls', detail: 'The three-storey pagoda frames the 133 m fall; the classic view is from the path below it.', duration: '1 hr 30 min', pin: '2' },
      { kind: 'meal', time: '13:00', approx: true, title: 'Lunch: maguro-don in 勝浦 Katsuura' },
      { kind: 'stop', time: '15:00', approx: true, title: '熊野速玉大社 Kumano Hayatama Taisha', duration: '45 min', pin: '3' },
    ],
    notes: [],
    map: dayMap([
      { ...P.nachi, label: '1', name: '大門坂', kind: 'stop' },
      { ...P.nachi, label: '2', name: '那智の滝', kind: 'stop' },
      { ...P.hayatama, label: '3', name: '熊野速玉大社', kind: 'stop' },
    ]),
    travel: '3 hr 20 min on the move',
    photo: PHOTO.nachi,
  },
  {
    number: 5,
    isoDate: '2027-04-12',
    weekday: 'Monday',
    dateLabel: '12 April',
    base: '湯の峰温泉 Yunomine Onsen',
    theme: 'Back to Kyoto',
    intensity: 'Light',
    items: [
      { kind: 'travel', time: null, approx: false, title: 'Bus to 紀伊田辺 Kii-Tanabe', duration: '1 hr 40 min' },
      { kind: 'travel', time: null, approx: false, title: 'Limited express Kuroshio to 京都 Kyoto', duration: '2 hr 50 min' },
      { kind: 'free', time: '15:00', approx: true, title: 'Time in Kyoto before your onward journey' },
    ],
    notes: [],
    travel: '4 hr 30 min on the move',
  },
];

export function japanGuideFixture(variant: GuideVariant): GuideModel {
  const complete = variant === 'complete';
  return {
    variant,
    audience: 'owner',
    placeLang: 'ja',
    identity: {
      title: '熊野古道 Kumano Kodo & Kyoto',
      thesis: 'Two days on the pilgrim trail through the Kii mountains, bookended by Kyoto’s shrines and a night in a river onsen.',
      dateRange: '8 Apr – 12 Apr 2027',
      dayCount: 5,
      nightCount: 4,
      route: ['京都 Kyoto', '近露 Chikatsuyu', '湯の峰温泉 Yunomine Onsen'],
      party: '2 adults',
      timeZone: { id: 'Asia/Tokyo', abbreviation: 'JST' },
      generatedOn: '12 November 2026',
    },
    cover: { photo: PHOTO.oyunohara },
    glance: {
      map: {
        points: [
          { ...P.kyotoStation, label: 'A', name: '京都 Kyoto', kind: 'base' },
          { ...P.chikatsuyu, label: 'B', name: '近露 Chikatsuyu', kind: 'base' },
          { ...P.yunomine, label: 'C', name: '湯の峰温泉', kind: 'base' },
          { ...P.fushimi, label: '1', name: '伏見稲荷大社', kind: 'stop' },
          { ...P.takijiri, label: '2', name: '滝尻王子', kind: 'stop' },
          { ...P.hongu, label: '3', name: '熊野本宮大社', kind: 'stop' },
          { ...P.nachi, label: '4', name: '那智の滝', kind: 'stop' },
        ],
        lines: [
          { points: [P.kyotoStation, P.tanabe, P.takijiri], style: 'rail' },
          { points: [P.takijiri, P.chikatsuyu, P.hongu], style: 'trail' },
          { points: [P.yunomine, P.nachi, P.hayatama], style: 'estimated' },
        ],
        unplaced: 0,
      },
      stays: [
        { name: '京都 Kyoto', nights: 1, dates: 'Thu 8 Apr – Fri 9 Apr' },
        { name: '近露 Chikatsuyu', nights: 1, dates: 'Fri 9 Apr – Sat 10 Apr' },
        { name: '湯の峰温泉 Yunomine Onsen', nights: 2, dates: 'Sat 10 Apr – Mon 12 Apr' },
      ],
      highlights: [
        { name: '熊野古道 中辺路 Nakahechi', dayNumber: 2, why: 'The classic two-day walk between the trail’s entrance and the Grand Shrine.' },
        { name: '熊野本宮大社 Kumano Hongū Taisha', dayNumber: 3 },
        { name: '那智の滝 Nachi Falls', dayNumber: 4 },
      ],
      getAround: 'Trains and the Ryūjin and Meikō buses; no car is needed and the trail sections are on foot.',
      throughout: [],
      figures: [
        { label: 'Days', value: '5' },
        { label: 'Stays', value: '3' },
        { label: 'Stops', value: '12' },
        { label: 'On foot', value: '≈ 26 km' },
      ],
    },
    days: complete ? DAYS : DAYS.map(({ map: _map, backup: _backup, photo: _photo, ...day }) => day),
    stays: [
      { name: '京都 Kyoto', area: '京都駅 near Kyoto Station', nights: 1, dates: 'Thu 8 Apr – Fri 9 Apr', why: 'Trains south to the peninsula leave from the station.', status: 'Booked', booked: 'Hotel near Hachijō exit' },
      { name: '近露 Chikatsuyu', nights: 1, dates: 'Fri 9 Apr – Sat 10 Apr', why: 'The end of the first trail day; minshuku dinners are included.', status: 'To book' },
      { name: '湯の峰温泉 Yunomine Onsen', nights: 2, dates: 'Sat 10 Apr – Mon 12 Apr', why: 'A short bus from the Grand Shrine, with the river bath on the doorstep.', status: 'To book' },
    ],
    transport: {
      headline: 'Trains and the Ryūjin and Meikō buses; no car is needed and the trail sections are on foot.',
      points: ['Buses on the peninsula run a few times a day; the last one from Hongū leaves in the late afternoon.', 'Send luggage ahead with the Kumano Travel transfer instead of carrying it on the trail.'],
      moves: [
        { day: 2, from: '京都 Kyoto', to: '近露 Chikatsuyu', how: 'Rail, bus and trail · ≈ 9 hr' },
        { day: 3, from: '近露 Chikatsuyu', to: '湯の峰温泉 Yunomine Onsen', how: 'Trail and bus · ≈ 7 hr' },
      ],
    },
    bookings: [
      { title: '近露 Chikatsuyu minshuku', when: 'Fri 9 Apr', action: 'Reserve through Kumano Travel; rooms in the village are few.', priority: 'Essential', status: 'To book' },
      { title: '湯の峰温泉 Yunomine ryokan', when: 'Sat 10 Apr', action: 'Reserve two nights with dinner.', priority: 'Essential', status: 'To book' },
      { title: 'Luggage transfer', when: 'Fri 9 Apr', action: 'Book two days ahead with the Kumano Travel desk.', priority: 'Recommended', deadline: 'Wed 7 Apr', status: 'To book' },
      { title: 'Limited express Kuroshio', when: 'Fri 9 Apr', action: 'Reserve seats from Kyoto to Kii-Tanabe.', priority: 'Recommended', status: 'Booked' },
    ],
    prep: {
      beforeYouGo: ['Download the Kumano Kodo trail map for offline use.', 'Carry cash: many minshuku and buses take yen only.', 'Get a Suica or ICOCA card for trains in Kyoto.'],
      packing: complete
        ? [
            { category: 'Footwear', items: ['Broken-in trail shoes', 'Sandals for the ryokan'] },
            { category: 'Weather', items: ['Rain shell', 'Pack cover'] },
            { category: 'Essential documents', items: ['Passport', 'Rail reservations'] },
          ]
        : [],
    },
    reference: {
      country: { name: 'Japan', emergency: '110', emergencyNotes: '119 for fire and ambulance', drivingSide: 'left', currency: 'JPY', plugs: ['A', 'B'], voltage: 100, callingCode: '+81', languages: ['ja'] },
      links: [
        { label: 'Read-only copy for companions', note: 'Anyone with this link can read the plan.', url: 'https://sidequest.example/share/fixtureJapanToken123', short: 'sidequest.example/share/fixtureJapanToken123' },
        { label: 'Day 2 in Google Maps', note: '2 stops, in order', url: 'https://www.google.com/maps/dir/?api=1&origin=33.7885,135.5135&destination=33.8106,135.5707&travelmode=walking' },
        { label: 'Day 3 in Google Maps', note: '3 stops, in order', url: 'https://www.google.com/maps/dir/?api=1&origin=33.8106,135.5707&destination=33.8301,135.7493&waypoints=33.8402,135.7731&travelmode=walking' },
      ],
    },
    ...(complete
      ? {
          appendix: {
            planning: ['The trail days are placed mid-trip so a late arrival or a jet-lagged first morning never falls on a mountain.', 'Kyoto is one night only: the trip is built around the peninsula.'],
            positions: [
              { day: 1, name: '伏見稲荷大社 Fushimi Inari-taisha', coordinates: '34.96710, 135.77270' },
              { day: 2, name: '滝尻王子 Takijiri-ōji', coordinates: '33.78850, 135.51350' },
              { day: 3, name: '熊野本宮大社 Kumano Hongū Taisha', coordinates: '33.84020, 135.77310' },
              { day: 4, name: '那智の滝 Nachi Falls', coordinates: '33.66870, 135.88890' },
            ],
            skip: [],
          },
        }
      : {}),
    credits: {
      photos: [`${PHOTO.oyunohara.alt}: ${PHOTO.oyunohara.credit}`, ...(complete ? [PHOTO.fushimi, PHOTO.nakahechi, PHOTO.nachi].map((p) => `${p.alt}: ${p.credit}`) : [])],
      data: ['Test fixture: hand-written for rendering checks.'],
    },
  };
}
