import type { BookingLead, CrowdPeriod, ModeConcept, ModeScope, ModeStatus, RealityFact, RealityTopic } from './schema';

/**
 * JURISDICTION KNOWLEDGE — DATA KEYED BY ISO CODE, WITH PROVENANCE, NEVER A
 * BRANCH IN PLANNING CODE.
 *
 * V7 §3. `if (destination === 'China')` is forbidden; a row keyed `CN` that
 * says "a foreign short-term visitor needs a temporary Chinese driving permit;
 * an International Driving Permit alone is not accepted", with the source and
 * the month it was compiled, is data. The builder reads rows for every country
 * the intent names and merges them; a country with no row produces honest
 * unknowns, never a guess.
 *
 * Provenance: compiled from official transport, immigration and tourism
 * authorities and their published guidance as of 2026-09, alongside widely
 * corroborated traveller-facing reference material. Everything is `reference`
 * authority — shown as "Reference, compiled by Sidequest" and never as an
 * official current source; the readiness layer still links the official page
 * for anything regulatory. Rows are facts, not creative content.
 */

export interface JurisdictionModeRule {
  mode: ModeConcept;
  status: ModeStatus;
  scope?: ModeScope;
  reason: string;
  /** Ids of facts in this jurisdiction's `facts` that support the rule. */
  facts?: string[];
}

export interface JurisdictionSetup {
  id: string;
  title: string;
  why: string;
  when: 'before_you_fly' | 'on_arrival';
  relevance: 'essential' | 'useful';
  topic: RealityTopic;
  /** When set, only trips that read as this urbanity or wider include the item. */
  onlyWhen?: 'regional' | 'rail' | 'self_drive' | 'urban' | 'ferry' | 'safari' | 'remote';
  facts?: string[];
}

export interface Jurisdiction {
  code: string;
  asOf: string;
  /** A city-state: the whole jurisdiction is one urban area, so a trip "to the country" is a city trip. */
  cityState?: boolean;
  facts: Omit<RealityFact, 'countries'>[];
  modes: JurisdictionModeRule[];
  setup: JurisdictionSetup[];
  crowdPeriods?: (Omit<CrowdPeriod, 'countries' | 'movable'> & { movable?: boolean })[];
  bookingLeads?: BookingLead[];
}

const F = (id: string, topic: RealityTopic, statement: string, extra: Partial<Omit<RealityFact, 'id' | 'topic' | 'statement' | 'countries'>> = {}): Omit<RealityFact, 'countries'> => ({
  id,
  topic,
  statement,
  authority: 'reference',
  freshness: 'medium',
  confidence: 'high',
  scope: 'all',
  ...extra,
});

export const JURISDICTIONS: readonly Jurisdiction[] = [
  {
    code: 'CN',
    asOf: '2026-09',
    facts: [
      F('cn-idp', 'driving', 'Mainland China does not recognise the International Driving Permit; a foreign visitor who wants to drive needs a temporary Chinese driving permit issued locally (short-term visitors can apply at designated vehicle-management offices or some airports), which takes paperwork and time.', { freshness: 'regulatory_volatile', sourceName: 'Ministry of Public Security traffic-management rules for foreign drivers, as summarised in official visitor guidance', confidence: 'high' }),
      F('cn-metro', 'transit', 'Major cities run dense, cheap metro networks with English signage; contactless payment or a transit code in a payment app works at the gate.', { scope: 'urban' }),
      F('cn-hsr', 'rail', 'High-speed rail links most cities and is the normal way to move between regions; seats sell out on holidays and popular routes, and foreign passports can book online through the official 12306 app or site after passport registration.', { freshness: 'medium', sourceName: 'China Railway 12306', sourceUrl: 'https://www.12306.cn/' }),
      F('cn-didi', 'ride_hailing', 'Ride-hailing (DiDi) is everywhere in cities and works in English inside the payment apps; street taxis rarely take foreign cards.', { scope: 'urban' }),
      F('cn-pay', 'payment', 'Mobile payment (Alipay, WeChat Pay) is how nearly everything is paid for; both accept foreign Visa/Mastercard linked in the app since 2023, and cash is still legal tender but often inconvenient.', { freshness: 'medium', sourceName: 'Alipay / WeChat Pay international visitor guidance' }),
      F('cn-maps', 'navigation', 'Google Maps is unreliable on the ground; Apple Maps works, and Amap or Baidu Maps are what locals and drivers use (Amap has an English mode).'),
      F('cn-connect', 'connectivity', 'Many Western services (Google, WhatsApp, some Western news and social apps) are blocked on local networks; an international eSIM or roaming plan that routes abroad keeps them working, and is worth arranging before departure.', { freshness: 'medium', confidence: 'medium' }),
      F('cn-lang', 'language', 'English is limited outside hotels and stations; a translation app with offline Chinese and a card with the hotel address in characters are genuinely useful.'),
      F('cn-driver', 'driving', 'Hiring a car with a driver for a day or a regional transfer is common, inexpensive relative to Western prices, and the usual way visitors reach places off the rail network.', { scope: 'regional' }),
      F('cn-holidays', 'holidays', 'National Day Golden Week (1–7 October) and Spring Festival (around Chinese New Year, late January to mid February) move hundreds of millions of people: trains and hotels sell out and major sights are at their busiest.', { freshness: 'stable' }),
      F('cn-permits', 'permits', 'Some sensitive areas (notably Tibet) need separate permits arranged through an operator; ordinary provinces do not.', { freshness: 'regulatory_volatile', confidence: 'medium' }),
    ],
    modes: [
      { mode: 'self_drive', status: 'friction', reason: 'A foreign visitor cannot drive on an International Driving Permit; a temporary local permit is possible but slow to arrange, and city driving and parking are hard.', facts: ['cn-idp'] },
      { mode: 'rental_car', status: 'discouraged', reason: 'Renting without a Chinese permit is not possible, and where it is arranged it rarely beats rail plus a hired driver.', facts: ['cn-idp', 'cn-driver'] },
      { mode: 'private_driver', status: 'recommended', scope: 'regional', reason: 'A car with a driver is the normal way to reach regional sights off the rail network.', facts: ['cn-driver'] },
      { mode: 'metro', status: 'recommended', scope: 'urban', reason: 'Dense, cheap, signed in English.', facts: ['cn-metro'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Neighbourhoods reward walking; distances between districts are metro rides.' },
      { mode: 'rideshare', status: 'recommended', scope: 'urban', reason: 'DiDi fills the gaps between metro stations and is far easier than a street taxi.', facts: ['cn-didi'] },
      { mode: 'taxi', status: 'viable', scope: 'urban', reason: 'Fine when hailed, but cash or local payment is usually needed.', facts: ['cn-pay'] },
      { mode: 'high_speed_rail', status: 'recommended', scope: 'regional', reason: 'The regional backbone; fast, frequent, bookable with a passport.', facts: ['cn-hsr'] },
      { mode: 'intercity_train', status: 'viable', scope: 'regional', reason: 'Slower conventional trains cover what high-speed lines do not.', facts: ['cn-hsr'] },
      { mode: 'flight', status: 'viable', scope: 'regional', reason: 'Useful for the longest legs; rail usually wins under about five hours.' },
      { mode: 'bus', status: 'viable', reason: 'Long-distance coaches reach towns without rail; slower and less legible for visitors.' },
      { mode: 'cruise', status: 'viable', scope: 'regional', reason: 'River cruises are an operator-run, multi-day product with their own timetable and included stops.' },
    ],
    setup: [
      { id: 'cn-setup-pay', title: 'Set up Alipay or WeChat Pay with a foreign card', why: 'Nearly everything is paid by phone; cash is legal but often awkward.', when: 'before_you_fly', relevance: 'essential', topic: 'payment', facts: ['cn-pay'] },
      { id: 'cn-setup-12306', title: 'Register on the 12306 rail app with your passport', why: 'High-speed rail is the way between regions; registration takes a day or two to verify.', when: 'before_you_fly', relevance: 'essential', topic: 'ticketing', onlyWhen: 'rail', facts: ['cn-hsr'] },
      { id: 'cn-setup-maps', title: 'Install Amap (or use Apple Maps) and a translation app with offline Chinese', why: 'Google Maps is unreliable on the ground and English is limited outside hotels.', when: 'before_you_fly', relevance: 'essential', topic: 'navigation', facts: ['cn-maps', 'cn-lang'] },
      { id: 'cn-setup-esim', title: 'Arrange an international eSIM or roaming that keeps Western apps working', why: 'Local networks block many Western services; a plan that routes abroad avoids that.', when: 'before_you_fly', relevance: 'useful', topic: 'connectivity', facts: ['cn-connect'] },
      { id: 'cn-setup-didi', title: 'Add DiDi (inside Alipay or WeChat) for rides', why: 'Ride-hailing fills the gaps between metro stations and is easier than street taxis.', when: 'on_arrival', relevance: 'useful', topic: 'ride_hailing', onlyWhen: 'urban', facts: ['cn-didi'] },
    ],
    crowdPeriods: [
      { name: 'National Day Golden Week', ranges: [{ from: '10-01', to: '10-07' }], effect: 'very_busy', note: 'Trains and hotels sell out; every major sight is at its busiest.', factId: 'cn-holidays' },
      { name: 'Spring Festival', ranges: [{ from: '01-20', to: '02-20' }], effect: 'very_busy', note: 'The largest annual migration; many small businesses close for days.', factId: 'cn-holidays', movable: true },
      { name: 'Labour Day', ranges: [{ from: '05-01', to: '05-05' }], effect: 'busy', note: 'A short national holiday with heavy domestic travel.', factId: 'cn-holidays' },
    ],
    bookingLeads: [
      { kind: 'rail', leadDays: 14, note: 'High-speed rail seats open about two weeks ahead and sell out on popular routes.' },
      { kind: 'cruise', leadDays: 60, note: 'River cruises run on fixed departure dates with limited cabins.' },
    ],
  },
  {
    code: 'JP',
    asOf: '2026-09',
    facts: [
      F('jp-idp', 'driving', 'Visitors from most countries can drive on an International Driving Permit (1949 Convention) with their home licence; a few countries need an official Japanese translation instead. Traffic drives on the left.', { freshness: 'regulatory_volatile', sourceName: 'Japan National Tourism Organization driving guidance' }),
      F('jp-rail', 'rail', 'Rail is the way between regions: the Shinkansen and JR limited expresses are frequent and punctual; regional rail passes can pay off, and reserved seats are worth booking on busy days.', { sourceName: 'JR Group' }),
      F('jp-ic', 'ticketing', 'An IC card (Suica, PASMO, ICOCA) or its phone version pays for metro, buses and convenience stores nationwide.'),
      F('jp-pay', 'payment', 'Cards are widely accepted in cities; cash still matters at small restaurants, shrines and in the countryside, and 7-Eleven ATMs accept foreign cards.'),
      F('jp-maps', 'navigation', 'Google Maps works well and its transit directions are accurate; Japan Transit Planner helps with rail timetables.'),
      F('jp-holidays', 'holidays', 'Golden Week (29 April–5 May), Obon (around 13–16 August) and the New Year period (29 December–3 January) fill trains and hotels.', { freshness: 'stable' }),
      F('jp-connect', 'connectivity', 'A pocket Wi-Fi or eSIM from the airport gives reliable data; free Wi-Fi is patchy.'),
    ],
    modes: [
      { mode: 'high_speed_rail', status: 'recommended', scope: 'regional', reason: 'The Shinkansen is the regional backbone.', facts: ['jp-rail'] },
      { mode: 'intercity_train', status: 'recommended', scope: 'regional', reason: 'Limited expresses and local lines reach most towns.', facts: ['jp-rail'] },
      { mode: 'metro', status: 'recommended', scope: 'urban', reason: 'Dense and legible; an IC card makes it frictionless.', facts: ['jp-ic'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Cities are walked between stations.' },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'Sensible in rural regions (Hokkaido, the mountains) with an IDP; unnecessary and expensive in cities.', facts: ['jp-idp'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Easy to hire with an IDP; tolls add up.', facts: ['jp-idp'] },
      { mode: 'taxi', status: 'viable', scope: 'urban', reason: 'Clean and reliable, but expensive over distance.' },
      { mode: 'rideshare', status: 'friction', scope: 'urban', reason: 'Ride-hailing apps mostly dispatch licensed taxis; availability is thin outside big cities.' },
      { mode: 'bus', status: 'viable', reason: 'Highway buses are the cheap alternative between cities.' },
      { mode: 'ferry', status: 'viable', reason: 'Ferries link the islands and are a scenic, slow option.' },
    ],
    setup: [
      { id: 'jp-setup-ic', title: 'Add a Suica or PASMO card to your phone, or buy one at the airport', why: 'It pays for every train, bus and convenience-store stop.', when: 'before_you_fly', relevance: 'essential', topic: 'ticketing', facts: ['jp-ic'] },
      { id: 'jp-setup-cash', title: 'Carry some yen and note where foreign-card ATMs are', why: 'Small restaurants, shrines and the countryside still run on cash.', when: 'on_arrival', relevance: 'useful', topic: 'payment', facts: ['jp-pay'] },
      { id: 'jp-setup-idp', title: 'Get an International Driving Permit before leaving home', why: 'Rental desks will not release a car without it (or an official translation for some licences).', when: 'before_you_fly', relevance: 'essential', topic: 'driving', onlyWhen: 'self_drive', facts: ['jp-idp'] },
      { id: 'jp-setup-data', title: 'Arrange an eSIM or pocket Wi-Fi', why: 'Free Wi-Fi is patchy and transit directions need data.', when: 'before_you_fly', relevance: 'useful', topic: 'connectivity', facts: ['jp-connect'] },
    ],
    crowdPeriods: [
      { name: 'Golden Week', ranges: [{ from: '04-29', to: '05-05' }], effect: 'very_busy', note: 'Trains and hotels are booked out weeks ahead.', factId: 'jp-holidays' },
      { name: 'Obon', ranges: [{ from: '08-11', to: '08-17' }], effect: 'busy', note: 'Domestic travel peaks; some businesses close.', factId: 'jp-holidays' },
      { name: 'New Year', ranges: [{ from: '12-29', to: '01-03' }], effect: 'closures', note: 'Many shops, restaurants and museums close.', factId: 'jp-holidays' },
    ],
    bookingLeads: [{ kind: 'rail', leadDays: 30, note: 'Reserved Shinkansen seats open a month ahead.' }],
  },
  {
    code: 'KR',
    asOf: '2026-09',
    facts: [
      F('kr-rail', 'rail', 'KTX high-speed trains connect Seoul with Busan and the main cities in under three hours; the Korail app sells tickets to foreign cards.', { sourceName: 'Korail' }),
      F('kr-tmoney', 'ticketing', 'A T-money card pays for metro, buses and taxis nationwide.'),
      F('kr-maps', 'navigation', 'Google Maps cannot route on the ground in Korea; Naver Map or Kakao Map (both with English) are what works.'),
      F('kr-idp', 'driving', 'An International Driving Permit with the home licence is accepted for short stays; driving is on the right.', { freshness: 'regulatory_volatile' }),
      F('kr-holidays', 'holidays', 'Seollal (Lunar New Year) and Chuseok (harvest festival, September or October) empty the cities and fill the roads and trains.', { freshness: 'stable' }),
    ],
    modes: [
      { mode: 'metro', status: 'recommended', scope: 'urban', reason: 'Seoul and Busan run superb metros.', facts: ['kr-tmoney'] },
      { mode: 'high_speed_rail', status: 'recommended', scope: 'regional', reason: 'KTX is fast and frequent.', facts: ['kr-rail'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Neighbourhoods are walked.' },
      { mode: 'taxi', status: 'viable', scope: 'urban', reason: 'Cheap and plentiful; Kakao T is the app.' },
      { mode: 'rideshare', status: 'viable', scope: 'urban', reason: 'Kakao T dispatches licensed taxis.' },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'Fine for Jeju and the countryside with an IDP; pointless in Seoul.', facts: ['kr-idp'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Easy to hire with an IDP.', facts: ['kr-idp'] },
      { mode: 'bus', status: 'viable', reason: 'Express buses reach everywhere rail does not.' },
    ],
    setup: [
      { id: 'kr-setup-maps', title: 'Install Naver Map or Kakao Map', why: 'Google Maps does not route here.', when: 'before_you_fly', relevance: 'essential', topic: 'navigation', facts: ['kr-maps'] },
      { id: 'kr-setup-tmoney', title: 'Buy a T-money card at the airport', why: 'It pays for metro, buses and taxis.', when: 'on_arrival', relevance: 'essential', topic: 'ticketing', facts: ['kr-tmoney'] },
      { id: 'kr-setup-korail', title: 'Book KTX on the Korail app', why: 'Seats on the Seoul–Busan line fill on weekends.', when: 'before_you_fly', relevance: 'useful', topic: 'ticketing', onlyWhen: 'rail', facts: ['kr-rail'] },
    ],
    crowdPeriods: [
      { name: 'Chuseok', ranges: [{ from: '09-10', to: '10-10' }], effect: 'busy', note: 'A three-day harvest holiday; trains sell out and many restaurants close.', factId: 'kr-holidays', movable: true },
      { name: 'Seollal', ranges: [{ from: '01-20', to: '02-20' }], effect: 'busy', note: 'Lunar New Year; heavy domestic travel.', factId: 'kr-holidays', movable: true },
    ],
  },
  {
    code: 'KE',
    asOf: '2026-09',
    facts: [
      F('ke-safari', 'driving', 'Safari is done in a guided 4x4 with a driver-guide, either through a lodge or a tour operator; self-drive safari is possible for experienced 4x4 drivers but is not how most visitors travel the parks.'),
      F('ke-idp', 'driving', 'Visitors can drive on their home licence (an IDP is recommended); traffic drives on the left, and road conditions vary sharply outside the main highways.', { freshness: 'regulatory_volatile' }),
      F('ke-flights', 'gateways', 'Scheduled light aircraft link Nairobi (Wilson Airport) with the Masai Mara, Amboseli and the coast, turning a six-hour drive into an hour.'),
      F('ke-mpesa', 'payment', 'M-Pesa mobile money is used for everything; visitors can register a Safaricom SIM at the airport, and cards work at lodges and city restaurants.'),
      F('ke-eta', 'border', 'Kenya requires an electronic travel authorisation (eTA) applied for online before arrival; check the official portal for current rules and fees.', { freshness: 'regulatory_volatile', authority: 'reference', sourceName: 'Kenya eTA official portal', sourceUrl: 'https://www.etakenya.go.ke/' }),
      F('ke-migration', 'seasonal_access', 'The Great Migration is usually in the Masai Mara from about July to October; the long rains (April–May) close some tracks.', { freshness: 'stable', confidence: 'medium' }),
      F('ke-border-car', 'border', 'Hire cars generally cannot be taken across the Kenya–Tanzania border; itineraries switch vehicles and guides at the crossing, or fly.', { confidence: 'medium' }),
      F('ke-rail', 'rail', 'The Madaraka Express standard-gauge train links Nairobi and Mombasa in about five hours and is bookable online.', { sourceName: 'Kenya Railways' }),
    ],
    modes: [
      { mode: 'guided_transfer', status: 'recommended', reason: 'Parks are visited in a guided 4x4 with a driver-guide.', facts: ['ke-safari'] },
      { mode: 'flight', status: 'recommended', scope: 'regional', reason: 'Bush flights save whole days between parks and the coast.', facts: ['ke-flights'] },
      { mode: 'private_driver', status: 'recommended', scope: 'regional', reason: 'A driver-guide for the overland legs is the norm.', facts: ['ke-safari'] },
      { mode: 'self_drive', status: 'friction', reason: 'Possible for experienced 4x4 drivers, but not how the parks are normally done, and cross-border hire is restricted.', facts: ['ke-idp', 'ke-border-car'] },
      { mode: 'rental_car', status: 'friction', reason: 'Available in Nairobi; rarely the right tool for a safari circuit.', facts: ['ke-idp'] },
      { mode: 'rideshare', status: 'viable', scope: 'urban', reason: 'Uber and Bolt work in Nairobi and Mombasa.' },
      { mode: 'intercity_train', status: 'viable', scope: 'regional', reason: 'Nairobi–Mombasa by rail is comfortable and cheap.', facts: ['ke-rail'] },
      { mode: 'metro', status: 'unavailable', scope: 'urban', reason: 'No metro; matatus and buses are the local transit.' },
    ],
    setup: [
      { id: 'ke-setup-eta', title: 'Apply for the Kenya eTA online before you fly', why: 'Entry needs an electronic authorisation issued in advance; rules and fees change, so use the official portal.', when: 'before_you_fly', relevance: 'essential', topic: 'border', facts: ['ke-eta'] },
      { id: 'ke-setup-mpesa', title: 'Get a Safaricom SIM and register M-Pesa on arrival', why: 'Mobile money pays for taxis, markets and small purchases.', when: 'on_arrival', relevance: 'useful', topic: 'payment', facts: ['ke-mpesa'] },
      { id: 'ke-setup-guide', title: 'Book the safari operator or lodges first', why: 'Camps in the parks have few beds and the guide is the trip.', when: 'before_you_fly', relevance: 'essential', topic: 'booking_lead', onlyWhen: 'safari', facts: ['ke-safari'] },
    ],
    crowdPeriods: [{ name: 'Migration season', ranges: [{ from: '07-01', to: '10-15' }], effect: 'busy', note: 'Mara camps book out months ahead.', factId: 'ke-migration' }],
    bookingLeads: [
      { kind: 'safari_lodge', leadDays: 120, note: 'Park camps have few beds and fill months ahead in season.' },
      { kind: 'internal_flight', leadDays: 45, note: 'Bush flights are small aircraft with limited seats.' },
    ],
  },
  {
    code: 'TZ',
    asOf: '2026-09',
    facts: [
      F('tz-safari', 'driving', 'The northern circuit (Serengeti, Ngorongoro, Tarangire) is done with a driver-guide in a 4x4 arranged through an operator; self-drive is unusual and park fees are paid through operators.'),
      F('tz-flights', 'gateways', 'Light aircraft link Arusha and Kilimanjaro with the Serengeti airstrips and Zanzibar; road transfers between the northern parks take hours on rough tracks.'),
      F('tz-visa', 'border', 'Most visitors need a visa, available online in advance (e-visa) or on arrival at major entry points; check the official immigration portal.', { freshness: 'regulatory_volatile', sourceName: 'Tanzania Immigration e-visa portal', sourceUrl: 'https://visa.immigration.go.tz/' }),
      F('tz-fees', 'permits', 'Park and conservation fees are substantial, priced per person per day, and usually included in an operator quote.', { confidence: 'medium' }),
      F('tz-pay', 'payment', 'Lodges take cards; towns and markets run on cash (shillings, with US dollars accepted for fees and tips) and M-Pesa/Tigo Pesa mobile money.'),
      F('tz-ferry', 'ferry', 'Fast ferries link Dar es Salaam and Zanzibar in about two hours; flights are the alternative.'),
      F('tz-migration', 'seasonal_access', 'The migration herds are in the southern and central Serengeti roughly December–March (calving) and cross the Mara River in the north around July–September; the long rains (March–May) make some tracks impassable.', { freshness: 'stable', confidence: 'medium' }),
      F('tz-border-car', 'border', 'Hire cars generally cannot cross the Kenya–Tanzania border; itineraries switch vehicles and guides at the crossing (Namanga is the usual overland point), or fly.', { confidence: 'medium' }),
    ],
    modes: [
      { mode: 'guided_transfer', status: 'recommended', reason: 'The parks are visited with a driver-guide arranged by an operator.', facts: ['tz-safari'] },
      { mode: 'flight', status: 'recommended', scope: 'regional', reason: 'Airstrips make Serengeti and Zanzibar hours rather than days apart.', facts: ['tz-flights'] },
      { mode: 'private_driver', status: 'recommended', scope: 'regional', reason: 'Overland legs are driven by the guide.', facts: ['tz-safari'] },
      { mode: 'self_drive', status: 'discouraged', reason: 'Unusual in the parks, and hire cars cannot cross the border.', facts: ['tz-safari', 'tz-border-car'] },
      { mode: 'rental_car', status: 'discouraged', reason: 'Not how the circuit is done.', facts: ['tz-safari'] },
      { mode: 'ferry', status: 'viable', scope: 'regional', reason: 'Dar es Salaam–Zanzibar by fast ferry.', facts: ['tz-ferry'] },
      { mode: 'metro', status: 'unavailable', scope: 'urban', reason: 'No metro; dala-dalas and taxis are the local transit.' },
    ],
    setup: [
      { id: 'tz-setup-visa', title: 'Apply for the Tanzania e-visa in advance', why: 'Most passports need a visa; the online route avoids the arrival queue and rules change.', when: 'before_you_fly', relevance: 'essential', topic: 'border', facts: ['tz-visa'] },
      { id: 'tz-setup-cash', title: 'Bring US dollars in good condition and expect cash in towns', why: 'Fees, tips and markets are cash; lodges take cards.', when: 'before_you_fly', relevance: 'useful', topic: 'payment', facts: ['tz-pay'] },
      { id: 'tz-setup-operator', title: 'Book the safari operator, camps and bush flights first', why: 'Everything else in the parks hangs off the operator; seats and beds are limited.', when: 'before_you_fly', relevance: 'essential', topic: 'booking_lead', onlyWhen: 'safari', facts: ['tz-safari', 'tz-flights'] },
    ],
    crowdPeriods: [{ name: 'Northern migration crossings', ranges: [{ from: '07-01', to: '09-30' }], effect: 'busy', note: 'Northern Serengeti camps fill months ahead.', factId: 'tz-migration' }],
    bookingLeads: [
      { kind: 'safari_lodge', leadDays: 150, note: 'Serengeti camps in season are booked months out.' },
      { kind: 'internal_flight', leadDays: 45, note: 'Bush flights have a handful of seats.' },
    ],
  },
  {
    code: 'US',
    asOf: '2026-09',
    facts: [
      F('us-drive', 'driving', 'Most foreign licences are accepted for short visits (an IDP as a translation helps); outside a few dense cities a car is how the country is travelled.', { freshness: 'regulatory_volatile' }),
      F('us-transit', 'transit', 'Usable transit is limited to a handful of cities (New York, Chicago, Washington, Boston, San Francisco); elsewhere ride-hailing and cars fill the gap.'),
      F('us-pay', 'payment', 'Cards and phone payment everywhere; tipping of 18–22% at restaurants and for drivers is expected.'),
      F('us-parks', 'permits', 'Popular national parks run timed-entry or vehicle reservations in peak season; check the park’s official page.', { freshness: 'regulatory_volatile', sourceName: 'National Park Service', sourceUrl: 'https://www.nps.gov/' }),
      F('us-holidays', 'holidays', 'Memorial Day to Labor Day is the busy season for parks; Thanksgiving week and late December are the busiest travel days.', { freshness: 'stable' }),
    ],
    modes: [
      { mode: 'self_drive', status: 'recommended', scope: 'regional', reason: 'The country is built for driving between places.', facts: ['us-drive'] },
      { mode: 'rental_car', status: 'recommended', scope: 'regional', reason: 'Easy and expected outside the densest cities.', facts: ['us-drive'] },
      { mode: 'rideshare', status: 'recommended', scope: 'urban', reason: 'Uber and Lyft everywhere.' },
      { mode: 'metro', status: 'viable', scope: 'urban', reason: 'Good in a few big cities, thin elsewhere.', facts: ['us-transit'] },
      { mode: 'walking', status: 'viable', scope: 'urban', reason: 'The walkable cities are the exception.' },
      { mode: 'intercity_train', status: 'friction', scope: 'regional', reason: 'Amtrak is scenic on a few corridors and slow on most.' },
      { mode: 'flight', status: 'viable', scope: 'regional', reason: 'Distances make flights normal between regions.' },
    ],
    setup: [
      { id: 'us-setup-parks', title: 'Check timed-entry and vehicle reservations for any national park on the plan', why: 'Peak-season parks turn cars away without one.', when: 'before_you_fly', relevance: 'essential', topic: 'permits', onlyWhen: 'remote', facts: ['us-parks'] },
      { id: 'us-setup-ride', title: 'Have Uber or Lyft ready', why: 'Where transit is thin, this is the local transport.', when: 'before_you_fly', relevance: 'useful', topic: 'ride_hailing' },
    ],
    crowdPeriods: [
      { name: 'Summer park season', ranges: [{ from: '05-25', to: '09-05' }], effect: 'busy', note: 'Lodging near parks books out; reservations gate entry.', factId: 'us-holidays' },
      { name: 'Thanksgiving week', ranges: [{ from: '11-22', to: '11-30' }], effect: 'very_busy', note: 'The busiest travel week of the year.', factId: 'us-holidays', movable: true },
    ],
    bookingLeads: [{ kind: 'permit', leadDays: 90, note: 'Park permits and timed entry open months ahead.' }],
  },
  {
    code: 'GB',
    asOf: '2026-09',
    facts: [
      F('gb-drive', 'driving', 'Foreign licences are accepted for visits up to twelve months; driving is on the left and rural roads are narrow.', { freshness: 'regulatory_volatile' }),
      F('gb-rail', 'rail', 'Rail reaches most towns; advance fares are far cheaper than walk-up and go on sale about twelve weeks ahead.'),
      F('gb-pay', 'payment', 'Contactless cards and phones pay for everything, including London transport.'),
      F('gb-eta', 'border', 'Visitors from many countries now need an Electronic Travel Authorisation before travelling; check the official government page.', { freshness: 'regulatory_volatile', sourceName: 'UK Government — Electronic Travel Authorisation', sourceUrl: 'https://www.gov.uk/guidance/apply-for-an-electronic-travel-authorisation-eta' }),
    ],
    modes: [
      { mode: 'intercity_train', status: 'recommended', scope: 'regional', reason: 'Fast between cities; advance fares are cheap.', facts: ['gb-rail'] },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'The right tool for the Highlands, the coasts and the countryside; needless in London.', facts: ['gb-drive'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Easy to hire; left-hand traffic and narrow roads.', facts: ['gb-drive'] },
      { mode: 'metro', status: 'recommended', scope: 'urban', reason: 'London’s network is dense; contactless pays.', facts: ['gb-pay'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Cities are walked.' },
      { mode: 'rideshare', status: 'viable', scope: 'urban', reason: 'Uber and Bolt in most cities.' },
      { mode: 'ferry', status: 'viable', reason: 'Ferries reach the islands; some need booking in summer.' },
    ],
    setup: [
      { id: 'gb-setup-eta', title: 'Check whether you need a UK Electronic Travel Authorisation', why: 'Many nationalities now need one before boarding.', when: 'before_you_fly', relevance: 'essential', topic: 'border', facts: ['gb-eta'] },
      { id: 'gb-setup-rail', title: 'Book advance rail fares early', why: 'Walk-up fares can cost several times the advance price.', when: 'before_you_fly', relevance: 'useful', topic: 'ticketing', onlyWhen: 'rail', facts: ['gb-rail'] },
    ],
    bookingLeads: [{ kind: 'rail', leadDays: 60, note: 'Advance fares release about twelve weeks out and rise as seats sell.' }],
  },
  {
    code: 'IE',
    asOf: '2026-09',
    facts: [
      F('ie-drive', 'driving', 'Foreign licences are accepted for visits; driving is on the left and rural roads are narrow, so a smaller car is easier.', { freshness: 'regulatory_volatile' }),
      F('ie-transit', 'transit', 'Outside Dublin, public transport is thin and the coast is best reached by car or on a guided day tour.'),
      F('ie-pay', 'payment', 'Cards everywhere; a Leap card pays for Dublin transport.'),
    ],
    modes: [
      { mode: 'self_drive', status: 'recommended', scope: 'regional', reason: 'The coasts and the countryside are driven.', facts: ['ie-drive', 'ie-transit'] },
      { mode: 'rental_car', status: 'recommended', scope: 'regional', reason: 'Easy to hire; check excess cover.', facts: ['ie-drive'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Dublin is walked.' },
      { mode: 'bus', status: 'viable', reason: 'Intercity coaches are the cheap link between towns.' },
      { mode: 'intercity_train', status: 'viable', scope: 'regional', reason: 'Trains link the main cities; the coast needs a car or a tour.' },
      { mode: 'guided_transfer', status: 'viable', scope: 'regional', reason: 'Day tours cover the classic coasts for non-drivers.' },
    ],
    setup: [{ id: 'ie-setup-car', title: 'Book the hire car with excess cover you are comfortable with', why: 'Narrow roads and stone walls make damage waivers worth reading.', when: 'before_you_fly', relevance: 'useful', topic: 'driving', onlyWhen: 'self_drive', facts: ['ie-drive'] }],
  },
  {
    code: 'IS',
    asOf: '2026-09',
    facts: [
      F('is-drive', 'driving', 'A hire car is how Iceland is travelled; foreign licences are accepted, F-roads (highland tracks) need a 4x4 and are closed outside summer, and winter driving needs care and a weather check.', { freshness: 'regulatory_volatile', sourceName: 'Icelandic Road Administration (road.is)', sourceUrl: 'https://www.road.is/' }),
      F('is-pay', 'payment', 'Cards are accepted everywhere, including at fuel pumps (a PIN is needed).'),
      F('is-weather', 'seasonal_access', 'Roads and passes close in storms; check road.is and vedur.is daily in winter.', { freshness: 'volatile', sourceName: 'road.is / vedur.is' }),
    ],
    modes: [
      { mode: 'self_drive', status: 'recommended', reason: 'The Ring Road and the regions are driven.', facts: ['is-drive'] },
      { mode: 'rental_car', status: 'recommended', reason: 'Book early in summer; 4x4 for highland tracks.', facts: ['is-drive'] },
      { mode: 'guided_transfer', status: 'viable', reason: 'Day tours from Reykjavík cover the south for non-drivers.' },
      { mode: 'bus', status: 'friction', reason: 'Long-distance buses run but are infrequent.' },
      { mode: 'metro', status: 'unavailable', scope: 'urban', reason: 'No rail or metro anywhere.' },
    ],
    setup: [{ id: 'is-setup-road', title: 'Save road.is and vedur.is and check them each morning', why: 'Road and weather closures decide what a day can hold.', when: 'before_you_fly', relevance: 'essential', topic: 'seasonal_access', onlyWhen: 'self_drive', facts: ['is-weather'] }],
    crowdPeriods: [{ name: 'Summer high season', ranges: [{ from: '06-15', to: '08-31' }], effect: 'busy', note: 'Lodging on the Ring Road sells out months ahead.' }],
    bookingLeads: [{ kind: 'lodging_peak', leadDays: 120, note: 'Ring Road lodging in summer is scarce.' }],
  },
  {
    code: 'FR',
    asOf: '2026-09',
    facts: [
      F('fr-rail', 'rail', 'TGV and regional trains reach almost everywhere; TGV fares are cheapest when booked weeks ahead on SNCF Connect.', { sourceName: 'SNCF' }),
      F('fr-drive', 'driving', 'Foreign licences are accepted for visits; motorways are tolled and old-town parking is difficult.', { freshness: 'regulatory_volatile' }),
      F('fr-pay', 'payment', 'Cards everywhere; some markets and cafés are cash only.'),
    ],
    modes: [
      { mode: 'high_speed_rail', status: 'recommended', scope: 'regional', reason: 'TGV between cities is fast and cheap when booked ahead.', facts: ['fr-rail'] },
      { mode: 'metro', status: 'recommended', scope: 'urban', reason: 'Paris and Lyon are covered by metro.' },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Cities are walked.' },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'The right tool for Provence, the coasts and villages; tolls and parking in cities.', facts: ['fr-drive'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Easy to hire; manual gearboxes are the default.', facts: ['fr-drive'] },
      { mode: 'rideshare', status: 'viable', scope: 'urban', reason: 'Uber in the larger cities.' },
    ],
    setup: [{ id: 'fr-setup-rail', title: 'Book TGV seats on SNCF Connect early', why: 'Fares rise sharply as the date approaches.', when: 'before_you_fly', relevance: 'useful', topic: 'ticketing', onlyWhen: 'rail', facts: ['fr-rail'] }],
    bookingLeads: [{ kind: 'rail', leadDays: 45, note: 'TGV fares are cheapest weeks ahead.' }],
  },
  {
    code: 'IT',
    asOf: '2026-09',
    facts: [
      F('it-rail', 'rail', 'Frecce and Italo high-speed trains link the main cities; regional trains are cheap and need no booking.', { sourceName: 'Trenitalia / Italo' }),
      F('it-ztl', 'driving', 'Historic centres are restricted traffic zones (ZTL) enforced by camera; a hire car is for the countryside, not the cities. An IDP is legally required alongside a non-EU licence.', { freshness: 'regulatory_volatile' }),
      F('it-pay', 'payment', 'Cards are accepted widely; small bars and markets prefer cash.'),
    ],
    modes: [
      { mode: 'high_speed_rail', status: 'recommended', scope: 'regional', reason: 'City to city by train beats driving every time.', facts: ['it-rail'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Historic centres are on foot.' },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'For Tuscany, the lakes and the south; never into a historic centre.', facts: ['it-ztl'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Hire outside the city; IDP required for non-EU licences.', facts: ['it-ztl'] },
      { mode: 'ferry', status: 'viable', reason: 'Ferries and hydrofoils serve the islands and the Amalfi coast.' },
      { mode: 'metro', status: 'viable', scope: 'urban', reason: 'Rome, Milan and Naples run metros; elsewhere buses and feet.' },
    ],
    setup: [{ id: 'it-setup-idp', title: 'Get an International Driving Permit if your licence is non-EU', why: 'Required by law alongside your licence, and rental desks may ask.', when: 'before_you_fly', relevance: 'essential', topic: 'driving', onlyWhen: 'self_drive', facts: ['it-ztl'] }],
  },
  {
    code: 'ES',
    asOf: '2026-09',
    facts: [
      F('es-rail', 'rail', 'AVE high-speed trains link Madrid with Barcelona, Seville, Valencia and Málaga in a few hours; fares are cheapest booked ahead on Renfe or the low-cost operators.', { sourceName: 'Renfe' }),
      F('es-drive', 'driving', 'Foreign licences are accepted for visits (an IDP alongside non-EU licences); old-town parking is scarce.', { freshness: 'regulatory_volatile' }),
    ],
    modes: [
      { mode: 'high_speed_rail', status: 'recommended', scope: 'regional', reason: 'AVE between the big cities is fast.', facts: ['es-rail'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Cities are walked.' },
      { mode: 'metro', status: 'recommended', scope: 'urban', reason: 'Madrid and Barcelona run dense metros.' },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'For Andalusia’s villages, the north and the islands.', facts: ['es-drive'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Easy to hire.', facts: ['es-drive'] },
    ],
    setup: [{ id: 'es-setup-rail', title: 'Book AVE seats ahead', why: 'Fares rise close to the date.', when: 'before_you_fly', relevance: 'useful', topic: 'ticketing', onlyWhen: 'rail', facts: ['es-rail'] }],
  },
  {
    code: 'CH',
    asOf: '2026-09',
    facts: [
      F('ch-rail', 'rail', 'Trains, postbuses, boats and cable cars run as one timetabled network reaching nearly every village; a Swiss Travel Pass or Half Fare Card usually pays off.', { sourceName: 'SBB' }),
      F('ch-drive', 'driving', 'Foreign licences are accepted; motorways need a vignette and mountain passes close in winter.', { freshness: 'regulatory_volatile' }),
    ],
    modes: [
      { mode: 'intercity_train', status: 'recommended', reason: 'The network reaches the mountains; a car is rarely better.', facts: ['ch-rail'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Towns are walked between stations.' },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'Only for remote valleys the postbus reaches slowly.', facts: ['ch-drive'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Vignette included by rental firms; passes close in winter.', facts: ['ch-drive'] },
    ],
    setup: [{ id: 'ch-setup-pass', title: 'Compare a Swiss Travel Pass with point-to-point fares for your route', why: 'The pass often pays off in a few days and includes boats and many cable cars.', when: 'before_you_fly', relevance: 'useful', topic: 'ticketing', onlyWhen: 'rail', facts: ['ch-rail'] }],
  },
  {
    code: 'TH',
    asOf: '2026-09',
    facts: [
      F('th-grab', 'ride_hailing', 'Grab is the ride-hailing app in Bangkok and the main towns; Bangkok’s BTS Skytrain and MRT beat road traffic.'),
      F('th-drive', 'driving', 'An International Driving Permit is required with a foreign licence; traffic drives on the left and motorbike hire without a licence is a common insurance trap.', { freshness: 'regulatory_volatile' }),
      F('th-transport', 'transit', 'Overnight trains, buses and cheap domestic flights link the regions; islands are reached by ferry.'),
      F('th-pay', 'payment', 'Cash is common outside malls and hotels; QR payment is spreading and ATMs charge a fixed fee.'),
      F('th-holidays', 'holidays', 'Songkran (13–15 April) and the New Year period are the busiest domestic travel weeks.', { freshness: 'stable' }),
    ],
    modes: [
      { mode: 'metro', status: 'recommended', scope: 'urban', reason: 'BTS and MRT beat Bangkok traffic.', facts: ['th-grab'] },
      { mode: 'rideshare', status: 'recommended', scope: 'urban', reason: 'Grab everywhere.', facts: ['th-grab'] },
      { mode: 'flight', status: 'recommended', scope: 'regional', reason: 'Cheap domestic flights link the regions.', facts: ['th-transport'] },
      { mode: 'intercity_train', status: 'viable', scope: 'regional', reason: 'Overnight trains north are an experience.', facts: ['th-transport'] },
      { mode: 'ferry', status: 'viable', reason: 'Islands are reached by ferry.', facts: ['th-transport'] },
      { mode: 'self_drive', status: 'friction', reason: 'IDP required; city driving is chaotic; fine for the north with care.', facts: ['th-drive'] },
      { mode: 'rental_car', status: 'friction', reason: 'Possible with an IDP; a driver is often cheaper and easier.', facts: ['th-drive'] },
      { mode: 'private_driver', status: 'viable', scope: 'regional', reason: 'A car with a driver for a day is inexpensive.' },
    ],
    setup: [
      { id: 'th-setup-grab', title: 'Install Grab', why: 'Rides and food delivery in every town.', when: 'before_you_fly', relevance: 'useful', topic: 'ride_hailing', facts: ['th-grab'] },
      { id: 'th-setup-idp', title: 'Get an International Driving Permit if you plan to drive or ride', why: 'Required with a foreign licence and checked by police and insurers.', when: 'before_you_fly', relevance: 'essential', topic: 'driving', onlyWhen: 'self_drive', facts: ['th-drive'] },
    ],
    crowdPeriods: [{ name: 'Songkran', ranges: [{ from: '04-12', to: '04-16' }], effect: 'busy', note: 'Thai New Year water festival; heavy travel and some closures.', factId: 'th-holidays' }],
  },
  {
    code: 'VN',
    asOf: '2026-09',
    facts: [
      F('vn-grab', 'ride_hailing', 'Grab (cars and motorbike taxis) is the way around cities; metros are new and short.'),
      F('vn-drive', 'driving', 'Foreign visitors cannot legally drive on most home licences; an IDP is recognised only from countries party to the 1968 Convention, and traffic is dense. A car with a driver is the norm for regional legs.', { freshness: 'regulatory_volatile' }),
      F('vn-transport', 'transit', 'Sleeper trains, sleeper buses and cheap domestic flights link the long north–south country.'),
      F('vn-visa', 'border', 'Most nationalities need an e-visa applied for online in advance; some are visa-exempt for short stays.', { freshness: 'regulatory_volatile', sourceName: 'Vietnam National Portal on Immigration', sourceUrl: 'https://evisa.gov.vn/' }),
      F('vn-pay', 'payment', 'Cash (dong) dominates outside hotels and malls; cards work in cities.'),
    ],
    modes: [
      { mode: 'rideshare', status: 'recommended', scope: 'urban', reason: 'Grab cars and bikes.', facts: ['vn-grab'] },
      { mode: 'walking', status: 'viable', scope: 'urban', reason: 'Old quarters are walked; crossing roads takes nerve.' },
      { mode: 'private_driver', status: 'recommended', scope: 'regional', reason: 'A car with a driver is how regional legs are done.', facts: ['vn-drive'] },
      { mode: 'flight', status: 'recommended', scope: 'regional', reason: 'The country is long; flights save days.', facts: ['vn-transport'] },
      { mode: 'intercity_train', status: 'viable', scope: 'regional', reason: 'The Reunification line is slow and scenic.', facts: ['vn-transport'] },
      { mode: 'self_drive', status: 'discouraged', reason: 'Licence recognition is limited and traffic is dense.', facts: ['vn-drive'] },
      { mode: 'rental_car', status: 'discouraged', reason: 'Self-drive hire is rare; hire a car with a driver instead.', facts: ['vn-drive'] },
    ],
    setup: [
      { id: 'vn-setup-visa', title: 'Apply for the Vietnam e-visa in advance', why: 'Most passports need one; the official portal takes a few days.', when: 'before_you_fly', relevance: 'essential', topic: 'border', facts: ['vn-visa'] },
      { id: 'vn-setup-grab', title: 'Install Grab', why: 'Cars and motorbike taxis in every city.', when: 'before_you_fly', relevance: 'useful', topic: 'ride_hailing', facts: ['vn-grab'] },
    ],
  },
  {
    code: 'IN',
    asOf: '2026-09',
    facts: [
      F('in-driver', 'driving', 'Visitors almost never self-drive; a car with a driver, booked by the day or for a whole route, is inexpensive and standard.'),
      F('in-rail', 'rail', 'Indian Railways reaches everywhere; foreign-tourist quota seats and the IRCTC site or app (with an international card) are how tickets are booked, often weeks ahead.', { sourceName: 'IRCTC', sourceUrl: 'https://www.irctc.co.in/' }),
      F('in-visa', 'border', 'Most nationalities need an e-visa applied for online before arrival.', { freshness: 'regulatory_volatile', sourceName: 'Indian e-Visa portal', sourceUrl: 'https://indianvisaonline.gov.in/' }),
      F('in-pay', 'payment', 'UPI phone payment is universal for locals; visitors mostly use cash and cards, and some UPI wallets now accept foreign cards.', { confidence: 'medium' }),
      F('in-ride', 'ride_hailing', 'Uber and Ola work in the cities; autorickshaws are hailed and metered or negotiated.'),
    ],
    modes: [
      { mode: 'private_driver', status: 'recommended', reason: 'A car with a driver is the norm for regional travel.', facts: ['in-driver'] },
      { mode: 'intercity_train', status: 'recommended', scope: 'regional', reason: 'Trains reach everywhere and are an experience.', facts: ['in-rail'] },
      { mode: 'flight', status: 'viable', scope: 'regional', reason: 'Cheap flights link the big cities.' },
      { mode: 'rideshare', status: 'recommended', scope: 'urban', reason: 'Uber and Ola in the cities.', facts: ['in-ride'] },
      { mode: 'metro', status: 'viable', scope: 'urban', reason: 'Delhi, Mumbai, Bengaluru and others run metros.' },
      { mode: 'self_drive', status: 'discouraged', reason: 'Traffic and road culture make self-drive unusual for visitors.', facts: ['in-driver'] },
      { mode: 'rental_car', status: 'discouraged', reason: 'Hire a car with a driver instead.', facts: ['in-driver'] },
    ],
    setup: [
      { id: 'in-setup-visa', title: 'Apply for the India e-visa in advance', why: 'Required for most passports; allow several days.', when: 'before_you_fly', relevance: 'essential', topic: 'border', facts: ['in-visa'] },
      { id: 'in-setup-irctc', title: 'Register on IRCTC and book long trains early', why: 'Popular trains sell out weeks ahead; the foreign-tourist quota helps.', when: 'before_you_fly', relevance: 'useful', topic: 'ticketing', onlyWhen: 'rail', facts: ['in-rail'] },
    ],
    bookingLeads: [{ kind: 'rail', leadDays: 45, note: 'Long-distance trains open 60 days ahead and fill fast.' }],
  },
  {
    code: 'NZ',
    asOf: '2026-09',
    facts: [
      F('nz-drive', 'driving', 'Foreign English-language licences are accepted for a year; driving is on the left and distances are longer than the map suggests.', { freshness: 'regulatory_volatile' }),
      F('nz-eta', 'border', 'Visa-waiver visitors need an NZeTA and pay the visitor levy before travelling.', { freshness: 'regulatory_volatile', sourceName: 'Immigration New Zealand', sourceUrl: 'https://www.immigration.govt.nz/new-zealand-visas/preparing-a-visa-application/your-journey-to-new-zealand/before-you-travel-to-new-zealand/nzeta' }),
      F('nz-huts', 'permits', 'Great Walk huts and campsites are booked through the Department of Conservation and sell out on release day for the summer season.', { freshness: 'regulatory_volatile', sourceName: 'Department of Conservation', sourceUrl: 'https://www.doc.govt.nz/' }),
    ],
    modes: [
      { mode: 'self_drive', status: 'recommended', reason: 'Both islands are driven; a campervan is a common alternative.', facts: ['nz-drive'] },
      { mode: 'rental_car', status: 'recommended', reason: 'Easy to hire; book ahead in summer.', facts: ['nz-drive'] },
      { mode: 'flight', status: 'viable', scope: 'regional', reason: 'Domestic flights link the islands quickly.' },
      { mode: 'bus', status: 'viable', reason: 'InterCity coaches for non-drivers.' },
      { mode: 'guided_transfer', status: 'viable', reason: 'Trek shuttles and tour operators reach the trailheads.' },
    ],
    setup: [
      { id: 'nz-setup-eta', title: 'Get the NZeTA and pay the visitor levy', why: 'Required before boarding for visa-waiver countries.', when: 'before_you_fly', relevance: 'essential', topic: 'border', facts: ['nz-eta'] },
      { id: 'nz-setup-huts', title: 'Book Great Walk huts the day bookings open', why: 'They sell out within hours for summer.', when: 'before_you_fly', relevance: 'essential', topic: 'permits', onlyWhen: 'remote', facts: ['nz-huts'] },
    ],
    bookingLeads: [{ kind: 'permit', leadDays: 150, note: 'Great Walk huts release months ahead and sell out.' }],
  },
  {
    code: 'AU',
    asOf: '2026-09',
    facts: [
      F('au-drive', 'driving', 'Foreign English-language licences are accepted for visits; driving is on the left and outback distances are vast.', { freshness: 'regulatory_volatile' }),
      F('au-eta', 'border', 'Most visitors need an ETA or eVisitor visa applied for online before travelling.', { freshness: 'regulatory_volatile', sourceName: 'Australian Department of Home Affairs', sourceUrl: 'https://immi.homeaffairs.gov.au/' }),
      F('au-transit', 'transit', 'Sydney and Melbourne have good transit; elsewhere a car or flights.'),
    ],
    modes: [
      { mode: 'self_drive', status: 'recommended', scope: 'regional', reason: 'Regions are driven; distances are long.', facts: ['au-drive'] },
      { mode: 'rental_car', status: 'recommended', scope: 'regional', reason: 'Easy to hire.', facts: ['au-drive'] },
      { mode: 'flight', status: 'recommended', scope: 'regional', reason: 'The country is continent-sized; flights link the regions.' },
      { mode: 'metro', status: 'viable', scope: 'urban', reason: 'Sydney and Melbourne; thin elsewhere.', facts: ['au-transit'] },
      { mode: 'rideshare', status: 'viable', scope: 'urban', reason: 'Uber in every city.' },
    ],
    setup: [{ id: 'au-setup-eta', title: 'Apply for the ETA or eVisitor before you fly', why: 'Required for nearly every visitor.', when: 'before_you_fly', relevance: 'essential', topic: 'border', facts: ['au-eta'] }],
  },
  {
    code: 'MA',
    asOf: '2026-09',
    facts: [
      F('ma-driver', 'driving', 'Self-drive is possible on a foreign licence and the main roads are good; medina streets are impassable by car, and a driver for the mountain and desert legs is common and inexpensive.', { freshness: 'regulatory_volatile' }),
      F('ma-rail', 'rail', 'Al Boraq high-speed trains link Tangier and Casablanca; ONCF trains reach Marrakech, Fes and Rabat.', { sourceName: 'ONCF' }),
      F('ma-pay', 'payment', 'Cash (dirhams) for souks, taxis and small restaurants; cards in hotels and larger shops.'),
    ],
    modes: [
      { mode: 'private_driver', status: 'recommended', scope: 'regional', reason: 'A driver for the Atlas and desert legs is the norm.', facts: ['ma-driver'] },
      { mode: 'intercity_train', status: 'recommended', scope: 'regional', reason: 'Trains between the imperial cities are easy.', facts: ['ma-rail'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Medinas are on foot.' },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'Fine on main roads; never into a medina.', facts: ['ma-driver'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Easy to hire; parking outside medinas.', facts: ['ma-driver'] },
      { mode: 'taxi', status: 'viable', scope: 'urban', reason: 'Petit taxis in town; grand taxis between towns.' },
    ],
    setup: [{ id: 'ma-setup-cash', title: 'Carry dirhams in small notes', why: 'Souks, taxis and small restaurants are cash.', when: 'on_arrival', relevance: 'useful', topic: 'payment', facts: ['ma-pay'] }],
  },
  {
    code: 'BW',
    asOf: '2026-09',
    facts: [
      F('bw-delta', 'driving', 'The Okavango Delta is reached by light aircraft from Maun to camp airstrips and moved through by boat and mokoro with camp guides; there is no self-drive inside the delta.'),
      F('bw-flights', 'gateways', 'Camp-to-camp flights are scheduled by the operator with the booking; weight limits on bags are strict (soft bags, around 20 kg).'),
      F('bw-selfdrive', 'driving', 'Self-drive 4x4 with camping is a real way to see Chobe, Moremi and the salt pans for experienced drivers with recovery gear; not the delta.'),
    ],
    modes: [
      { mode: 'guided_transfer', status: 'recommended', reason: 'Camps move guests by boat, mokoro and 4x4 with guides.', facts: ['bw-delta'] },
      { mode: 'flight', status: 'recommended', scope: 'regional', reason: 'Light aircraft link Maun with the camps.', facts: ['bw-flights'] },
      { mode: 'self_drive', status: 'friction', reason: 'Only for experienced 4x4 self-drivers outside the delta.', facts: ['bw-selfdrive'] },
      { mode: 'rental_car', status: 'friction', reason: '4x4 hire in Maun for the parks; nothing inside the delta.', facts: ['bw-selfdrive'] },
    ],
    setup: [{ id: 'bw-setup-bags', title: 'Pack in soft bags within the light-aircraft weight limit', why: 'Camp flights refuse hard cases and heavy bags.', when: 'before_you_fly', relevance: 'essential', topic: 'gateways', facts: ['bw-flights'] }],
    bookingLeads: [{ kind: 'safari_lodge', leadDays: 180, note: 'Delta camps have a handful of tents and book far ahead.' }],
  },
  {
    code: 'ZA',
    asOf: '2026-09',
    facts: [
      F('za-drive', 'driving', 'Self-drive is the normal way to travel the Cape, the Garden Route and Kruger; foreign licences in English are accepted, driving is on the left.', { freshness: 'regulatory_volatile' }),
      F('za-safety', 'safety_context', 'Urban driving needs ordinary big-city care: doors locked, nothing visible, no night walking in unfamiliar areas.', { confidence: 'medium' }),
      F('za-ride', 'ride_hailing', 'Uber and Bolt work in the cities and are safer than hailing a taxi.'),
    ],
    modes: [
      { mode: 'self_drive', status: 'recommended', scope: 'regional', reason: 'The Cape and Kruger are driven.', facts: ['za-drive'] },
      { mode: 'rental_car', status: 'recommended', scope: 'regional', reason: 'Easy to hire.', facts: ['za-drive'] },
      { mode: 'rideshare', status: 'recommended', scope: 'urban', reason: 'Uber and Bolt in the cities.', facts: ['za-ride'] },
      { mode: 'guided_transfer', status: 'viable', reason: 'Private reserves run guided drives with the stay.' },
      { mode: 'flight', status: 'viable', scope: 'regional', reason: 'Cape Town–Johannesburg–Kruger by air saves days.' },
    ],
    setup: [{ id: 'za-setup-ride', title: 'Use Uber or Bolt in the cities', why: 'Safer and simpler than hailing.', when: 'before_you_fly', relevance: 'useful', topic: 'ride_hailing', facts: ['za-ride'] }],
  },
  {
    code: 'HK',
    asOf: '2026-09',
    cityState: true,
    facts: [
      F('hk-mtr', 'transit', 'The MTR, trams, buses and ferries cover the territory; an Octopus card (or its phone version) pays for all of them and for convenience stores.'),
      F('hk-drive', 'driving', 'A car is pointless for a visitor: parking is scarce and expensive and transit reaches everywhere.'),
    ],
    modes: [
      { mode: 'metro', status: 'recommended', scope: 'urban', reason: 'The MTR reaches nearly everything.', facts: ['hk-mtr'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Districts are walked between stations.' },
      { mode: 'ferry', status: 'recommended', reason: 'Ferries are transit here.', facts: ['hk-mtr'] },
      { mode: 'taxi', status: 'viable', scope: 'urban', reason: 'Cheap and plentiful; cash or Octopus.' },
      { mode: 'self_drive', status: 'discouraged', reason: 'Nothing about a visit needs a car.', facts: ['hk-drive'] },
      { mode: 'rental_car', status: 'discouraged', reason: 'Nothing about a visit needs a car.', facts: ['hk-drive'] },
    ],
    setup: [{ id: 'hk-setup-octopus', title: 'Add an Octopus card to your phone or buy one at the airport', why: 'It pays for every train, bus, ferry and convenience store.', when: 'before_you_fly', relevance: 'essential', topic: 'ticketing', facts: ['hk-mtr'] }],
  },
  {
    code: 'NO',
    asOf: '2026-09',
    facts: [
      F('no-drive', 'driving', 'Foreign licences are accepted; roads are excellent, tolls are automatic and mountain passes close in winter.', { freshness: 'regulatory_volatile' }),
      F('no-rail', 'rail', 'Trains and coastal ferries link the main cities and fjords; the Bergen line is scenic and worth booking ahead.'),
    ],
    modes: [
      { mode: 'self_drive', status: 'recommended', scope: 'regional', reason: 'The fjords are driven, with ferries as road.', facts: ['no-drive'] },
      { mode: 'rental_car', status: 'recommended', scope: 'regional', reason: 'Easy to hire; tolls billed later.', facts: ['no-drive'] },
      { mode: 'ferry', status: 'recommended', reason: 'Car ferries are part of the road network.', facts: ['no-drive'] },
      { mode: 'intercity_train', status: 'viable', scope: 'regional', reason: 'Oslo–Bergen by rail is a classic.', facts: ['no-rail'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Cities are compact.' },
    ],
    setup: [],
  },
  {
    code: 'KG',
    asOf: '2026-09',
    facts: [
      F('kg-driver', 'driving', 'Visitors mostly travel with a driver (often through a community tourism office) or shared taxis; self-drive is possible on an IDP but mountain roads are rough and unsigned.', { freshness: 'regulatory_volatile' }),
      F('kg-cbt', 'apps', 'Community-based tourism offices arrange yurt stays, horses and drivers in each region; booking is by message rather than an app.'),
      F('kg-pay', 'payment', 'Cash (som) outside Bishkek; cards in the capital.'),
    ],
    modes: [
      { mode: 'private_driver', status: 'recommended', reason: 'A driver arranged locally is the norm.', facts: ['kg-driver'] },
      { mode: 'guided_transfer', status: 'recommended', reason: 'Horse treks and yurt stays are arranged with guides.', facts: ['kg-cbt'] },
      { mode: 'self_drive', status: 'friction', reason: 'Possible with an IDP and a 4x4; rough, unsigned mountain roads.', facts: ['kg-driver'] },
      { mode: 'rental_car', status: 'friction', reason: '4x4 hire exists in Bishkek; a driver usually costs little more.', facts: ['kg-driver'] },
      { mode: 'bus', status: 'viable', reason: 'Shared taxis and marshrutkas link the towns.' },
    ],
    setup: [{ id: 'kg-setup-cash', title: 'Carry som in cash for everything outside Bishkek', why: 'Cards rarely work in the regions.', when: 'on_arrival', relevance: 'essential', topic: 'payment', facts: ['kg-pay'] }],
  },
  {
    code: 'DE',
    asOf: '2026-09',
    facts: [
      F('de-rail', 'rail', 'Deutsche Bahn ICE trains link the cities; the Deutschlandticket covers regional trains and city transit for a month.', { sourceName: 'Deutsche Bahn' }),
      F('de-drive', 'driving', 'Foreign licences are accepted; many cities have low-emission zones needing a sticker.', { freshness: 'regulatory_volatile' }),
    ],
    modes: [
      { mode: 'high_speed_rail', status: 'recommended', scope: 'regional', reason: 'ICE between cities.', facts: ['de-rail'] },
      { mode: 'metro', status: 'recommended', scope: 'urban', reason: 'U-Bahn and S-Bahn in every large city.' },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Cities are walked and cycled.' },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'For the Alps, the Black Forest and villages.', facts: ['de-drive'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Easy to hire.', facts: ['de-drive'] },
    ],
    setup: [],
  },
  {
    code: 'PT',
    asOf: '2026-09',
    facts: [
      F('pt-rail', 'rail', 'Alfa Pendular and Intercidades trains link Lisbon, Porto and the Algarve; regional lines are slow.'),
      F('pt-drive', 'driving', 'Foreign licences are accepted; tolls are electronic and hire cars carry a transponder.', { freshness: 'regulatory_volatile' }),
    ],
    modes: [
      { mode: 'intercity_train', status: 'recommended', scope: 'regional', reason: 'Lisbon–Porto by train.', facts: ['pt-rail'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Hilly, walked cities.' },
      { mode: 'metro', status: 'viable', scope: 'urban', reason: 'Lisbon and Porto run metros.' },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'For the Douro, the Alentejo and the Algarve.', facts: ['pt-drive'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Easy to hire.', facts: ['pt-drive'] },
    ],
    setup: [],
  },
  {
    code: 'GR',
    asOf: '2026-09',
    facts: [
      F('gr-ferry', 'ferry', 'Ferries are the island network; summer sailings between popular islands need booking, and schedules thin out of season.'),
      F('gr-drive', 'driving', 'Foreign licences are accepted (IDP alongside non-EU); island roads are narrow and a small car or scooter is usual.', { freshness: 'regulatory_volatile' }),
    ],
    modes: [
      { mode: 'ferry', status: 'recommended', reason: 'Islands are linked by ferry.', facts: ['gr-ferry'] },
      { mode: 'flight', status: 'viable', scope: 'regional', reason: 'Athens to the bigger islands by air.' },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'A small hire car on each island.', facts: ['gr-drive'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Hire on the island rather than ferrying a car.', facts: ['gr-drive'] },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Old towns are walked.' },
      { mode: 'metro', status: 'viable', scope: 'urban', reason: 'Athens has a metro.' },
    ],
    setup: [{ id: 'gr-setup-ferry', title: 'Book summer ferries between popular islands', why: 'Peak sailings sell out.', when: 'before_you_fly', relevance: 'useful', topic: 'ticketing', onlyWhen: 'ferry', facts: ['gr-ferry'] }],
    bookingLeads: [{ kind: 'ferry', leadDays: 30, note: 'Peak-season island ferries fill.' }],
  },
  {
    code: 'HR',
    asOf: '2026-09',
    facts: [
      F('hr-ferry', 'ferry', 'Jadrolinija and catamarans link the coast and islands; summer car ferries queue.'),
      F('hr-drive', 'driving', 'Foreign licences are accepted; the coastal road is slow and scenic and old towns are car-free.', { freshness: 'regulatory_volatile' }),
    ],
    modes: [
      { mode: 'ferry', status: 'recommended', reason: 'Islands by ferry and catamaran.', facts: ['hr-ferry'] },
      { mode: 'self_drive', status: 'viable', scope: 'regional', reason: 'The coast is driven; park outside old towns.', facts: ['hr-drive'] },
      { mode: 'rental_car', status: 'viable', scope: 'regional', reason: 'Easy to hire.', facts: ['hr-drive'] },
      { mode: 'bus', status: 'viable', reason: 'Coaches link the coastal cities well.' },
      { mode: 'walking', status: 'recommended', scope: 'urban', reason: 'Old towns are on foot.' },
    ],
    setup: [],
  },
];

const BY_CODE = new Map(JURISDICTIONS.map((j) => [j.code, j] as const));

export function jurisdictionFor(code: string | null | undefined): Jurisdiction | null {
  if (!code) return null;
  return BY_CODE.get(code.toUpperCase()) ?? null;
}

export function jurisdictionCodes(): string[] {
  return JURISDICTIONS.map((j) => j.code);
}
