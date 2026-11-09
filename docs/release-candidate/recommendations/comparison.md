| Set | Requests | Checks before | Checks after | All checks pass | Better | Worse | Identical picks |
|---|---|---|---|---|---|---|---|
| All | 211 | 407/468 | 427/468 | 141 → 158 of 195 | 20 | 2 | 96 |
| First global pass (147) | 147 | 270/300 | 278/300 | 104 → 110 of 131 | 7 | 1 | 68 |
| Release-candidate additions | 64 | 137/168 | 149/168 | 37 → 48 of 64 | 13 | 1 | 28 |

| Category | Requests | Checks before | Checks after | Better | Worse |
|---|---|---|---|---|---|
| access | 5 | 8/9 | 8/9 | 0 | 0 |
| ambiguous | 9 | 1/1 | 1/1 | 0 | 0 |
| beach | 10 | 20/22 | 20/22 | 0 | 0 |
| birding | 2 | 3/6 | 3/6 | 0 | 0 |
| budget | 3 | 7/8 | 7/8 | 0 | 0 |
| city_break | 7 | 23/23 | 22/23 | 0 | 1 |
| coast | 1 | 2/2 | 2/2 | 0 | 0 |
| couple | 1 | 0/0 | 0/0 | 0 | 0 |
| culture | 14 | 35/35 | 35/35 | 0 | 0 |
| desert | 1 | 2/2 | 2/2 | 0 | 0 |
| diving | 5 | 13/16 | 13/16 | 0 | 0 |
| family | 7 | 16/17 | 16/17 | 0 | 0 |
| food | 2 | 4/5 | 4/5 | 0 | 0 |
| hidden | 3 | 6/6 | 6/6 | 0 | 0 |
| hiking | 14 | 36/38 | 36/38 | 0 | 0 |
| hot_springs | 3 | 7/9 | 9/9 | 2 | 0 |
| islands | 7 | 15/18 | 15/18 | 0 | 0 |
| lakes | 2 | 4/4 | 4/4 | 0 | 0 |
| long | 1 | 1/1 | 1/1 | 0 | 0 |
| luxury | 1 | 1/2 | 1/2 | 0 | 0 |
| mountaineering | 2 | 5/5 | 5/5 | 0 | 0 |
| niche | 7 | 1/2 | 2/2 | 1 | 0 |
| rail | 5 | 10/14 | 12/14 | 2 | 0 |
| rainforest | 3 | 5/6 | 5/6 | 0 | 0 |
| reach | 6 | 12/12 | 12/12 | 0 | 0 |
| remote | 3 | 3/5 | 3/5 | 0 | 0 |
| road_trip | 11 | 25/25 | 25/25 | 0 | 0 |
| safari | 6 | 15/20 | 15/20 | 0 | 0 |
| safety | 2 | 2/2 | 2/2 | 0 | 0 |
| seasonality | 15 | 22/29 | 24/29 | 1 | 0 |
| short | 1 | 1/1 | 1/1 | 0 | 0 |
| similar | 5 | 15/15 | 15/15 | 0 | 0 |
| ski | 4 | 12/13 | 12/13 | 0 | 0 |
| specific | 6 | 14/14 | 14/14 | 0 | 0 |
| stargazing | 4 | 5/10 | 9/10 | 4 | 0 |
| trekking | 9 | 25/28 | 28/28 | 3 | 0 |
| vague | 9 | 10/16 | 14/16 | 5 | 1 |
| volcanoes | 1 | 1/1 | 1/1 | 0 | 0 |
| wildlife | 10 | 13/16 | 13/16 | 0 | 0 |
| winter | 4 | 7/10 | 10/10 | 2 | 0 |

Whole countries among primary picks: 29 → 16

## Regressions (fewer checks pass than before)

- **eastern-europe-winter-city** — A cheap, atmospheric Eastern European city in February with thermal baths.
  - before: Budapest · Sofia · Prague
  - after: Budapest · Bulgarian Black Sea Coast · Sofia
  - broke: offers city_life / hot_springs_wellness (not: Bulgarian Black Sea Coast)
- **rc-vague-recharge-february** — I am burnt out and need to switch off for ten days in February, somewhere warm and peaceful.
  - before: Likoma Island · Sri Lanka South Coast · Colon
  - after: Jamaica · Tongariro & Rotorua · Maldives
  - broke: daily highs ≥ 22 °C (not: Tongariro & Rotorua)

## Still failing a check

- **africa-safari-february** — Rajasthan · Kruger & Sabi Sand · Sri Lanka South Coast — in the named countries: not: Rajasthan, Sri Lanka South Coast; feasible (safari) by climate normals: not: Kruger & Sabi Sand
- **africa-safari-budget** — Kruger & Sabi Sand · Zambia · Okavango-Chobe — offers big_game_safari: not: Zambia, Okavango-Chobe
- **rainforest-borneo-like** — Olympic Peninsula · Madagascar's RN7 · Ordesa & the Aragonese Pyrenees — offers rainforest_biodiversity: not: Ordesa & the Aragonese Pyrenees
- **rail-multi-country** — Switzerland · The Italian Lakes · England — offers rail_journeys: not: The Italian Lakes, England
- **rail-asia** — Kyoto & Nara · Yunnan: Lijiang & Tiger Leaping Gorge · Rajasthan — offers rail_journeys: not: Rajasthan
- **winter-sun-walking** — Phoenix · São Tomé & Príncipe · Nantou County — within 5000 km of Manchester: not: Phoenix, São Tomé & Príncipe, Nantou County
- **pacific-islands** — Ningaloo Coast · Taveuni & Vanua Levu · Great Barrier Reef & Daintree — inside the named area: not: Ningaloo Coast
- **indian-ocean-honeymoon** — Lakshadweep · Mamoudzou · Christmas Island — inside the named area: not: Christmas Island
- **surf-winter** — Krabi & the Andaman Coast · Lake Atitlán & Antigua · Isla Holbox — feasible (beach) by climate normals: not: Lake Atitlán & Antigua
- **greek-islands-october** — Rhodes · The Cyclades · Corfu Town — feasible (beach) by climate normals: not: The Cyclades, Corfu Town
- **atlantic-islands-winter** — Tayrona & the Sierra Nevada Coast · Wild Coast · Maui — within 4500 km of Madrid: not: Tayrona & the Sierra Nevada Coast, Wild Coast, Maui
- **gorillas** — Volcanoes National Park · Denali · Shiretoko — in the named countries: not: Denali, Shiretoko
- **birding-neotropics** — Sabah, Borneo · Osa Peninsula · Seychelles — inside the named area: not: Sabah, Borneo, Seychelles
- **penguins** — Kangaroo Island · Galápagos Islands · Laikipia & Samburu — inside the named area: not: Galápagos Islands, Laikipia & Samburu
- **eastern-europe-winter-city** — Budapest · Bulgarian Black Sea Coast · Sofia — offers city_life / hot_springs_wellness: not: Bulgarian Black Sea Coast
- **cheap-anywhere-warm-feb** — Malaysia · Yucatán & the Riviera Maya · Maharashtra — price level ≤ 0.5: not: Yucatán & the Riviera Maya
- **luxury-safari-beach** — South Luangwa · Crete · Great Barrier Reef & Daintree — offers big_game_safari: not: Crete, Great Barrier Reef & Daintree
- **beach-europe-april** — Crete · Dalmatian Coast & Islands · Corsica — feasible (beach) by climate normals: not: Crete, Dalmatian Coast & Islands, Corsica
- **himalaya-monsoon** — Annapurna Circuit · Bhutan · Uttarakhand — feasible (trek_high) by climate normals: not: Annapurna Circuit, Uttarakhand
- **patagonia-winter** — Península Valdés · El Impenetrable National Park · Viedma — inside the named area: not: El Impenetrable National Park
- **japan-summer-cool** — Hokkaido · Tokyo · Tohoku — daily highs ≤ 29 °C: not: Tokyo
- **rc-vague-scenery-cheap** — Crete · Wind River Range · High Atlas — price level ≤ 0.85: not: Wind River Range
- **rc-vague-recharge-february** — Jamaica · Tongariro & Rotorua · Maldives — daily highs ≥ 22 °C: not: Tongariro & Rotorua
- **rc-astro-southern** — Sossusvlei & the Namib · Cordillera Huayhuash · Tenerife & La Gomera — inside the named area: not: Tenerife & La Gomera
- **rc-birding-south-america** — Tambopata & Manu · Manaus · French Guiana — in the named countries: not: French Guiana; offers birding: not: Manaus, French Guiana
- **rc-birding-europe-spring** — Białowieża Forest · Transylvania & the Carpathians · Salt Pans of Trapani and Paceco — offers birding: not: Transylvania & the Carpathians, Salt Pans of Trapani and Paceco
- **rc-safari-green-season** — South Luangwa · Mana Pools · Hwange National Park — offers big_game_safari: not: Hwange National Park
- **rc-safari-india** — Jim Corbett National Park · Bannerghatta National Park · Bandhavgarh National Park — offers big_game_safari / wildlife_general: not: Jim Corbett National Park
- **rc-snorkel-family-easter** — Turks & Caicos · Crete · Seychelles — feasible (beach or dive) by climate normals: not: Crete; offers snorkel_dive: not: Crete
- **rc-dive-red-sea-or-similar** — Baja California Sur · Seychelles · Raja Ampat — within 4500 km of London: not: Baja California Sur, Seychelles, Raja Ampat
- **rc-ski-family-february** — Tyrolean Alps · Québec City & Charlevoix · Tohoku — within 3000 km of London: not: Québec City & Charlevoix, Tohoku
- **rc-hike-winter-sun** — Santo Antão · Cradle Mountain & Tasmania’s West · Tenerife & La Gomera — within 4500 km of Berlin: not: Santo Antão, Cradle Mountain & Tasmania’s West
- **rc-access-seniors-warm** — Butare · Yountville · Cahors — daily highs ≥ 18 °C: not: Yountville, Cahors
- **rc-family-toddler-easy** — Waterford · Ploiești · Oltrepò Pavese — suits children: not: Oltrepò Pavese
- **rc-food-asia-street** — Kyoto & Nara · Istanbul · Hong Kong — inside the named area: not: Istanbul
- **rc-remote-islands** — Turks & Caicos · Krabi & the Andaman Coast · Maui — of the requested kind: not: Krabi & the Andaman Coast; at least 2 little-known: 0
- **rc-season-gorillas** — Volcanoes National Park · Kangaroo Island · Denali — in the named countries: not: Kangaroo Island, Denali
