/**
 * DESTINATION RECALL: PLACES A WELL-TRAVELLED PERSON WOULD NAME.
 *
 * A list of real destinations by name and country — some world-famous, most
 * not — written down independently of the atlas, to answer one question: when
 * a traveller (or a research model) names a place, does the system hold it?
 * The 234-entry catalog is measured against the same list, so "global
 * coverage" is a number and not a claim. Nothing in the product reads this
 * file; it is evaluation data only.
 */
export const NAMED_DESTINATIONS: readonly [name: string, country: string][] = [
  /* Central & South Asia */
  ['Hunza Valley', 'PK'], ['Skardu', 'PK'], ['Fairy Meadows', 'PK'], ['Chitral', 'PK'], ['Karakoram', 'PK'], ['Fann Mountains', 'TJ'], ['Pamir Highway', 'TJ'], ['Khorog', 'TJ'],
  ['Karakol', 'KG'], ['Song Kul', 'KG'], ['Arslanbob', 'KG'], ['Samarkand', 'UZ'], ['Bukhara', 'UZ'], ['Khiva', 'UZ'], ['Almaty', 'KZ'], ['Ladakh', 'IN'], ['Spiti', 'IN'],
  ['Munnar', 'IN'], ['Hampi', 'IN'], ['Darjeeling', 'IN'], ['Sikkim', 'IN'], ['Andaman Islands', 'IN'], ['Pokhara', 'NP'], ['Annapurna', 'NP'], ['Langtang', 'NP'], ['Mustang', 'NP'],
  ['Paro', 'BT'], ['Ella', 'LK'], ['Sigiriya', 'LK'], ['Sylhet', 'BD'], ['Bamyan', 'AF'],
  /* East & Southeast Asia */
  ['Kyoto', 'JP'], ['Kanazawa', 'JP'], ['Takayama', 'JP'], ['Yakushima', 'JP'], ['Shikoku', 'JP'], ['Niseko', 'JP'], ['Hokkaido', 'JP'], ['Jeju', 'KR'], ['Gyeongju', 'KR'],
  ['Guilin', 'CN'], ['Yangshuo', 'CN'], ['Lijiang', 'CN'], ['Zhangjiajie', 'CN'], ['Taroko', 'TW'], ['Luang Prabang', 'LA'], ['Ha Giang', 'VN'], ['Hoi An', 'VN'], ['Sapa', 'VN'],
  ['Siem Reap', 'KH'], ['Koh Rong', 'KH'], ['Bagan', 'MM'], ['Koh Lipe', 'TH'], ['Ko Samui', 'TH'], ['Chiang Mai', 'TH'], ['Pai', 'TH'], ['Langkawi', 'MY'], ['Cameron Highlands', 'MY'],
  ['Raja Ampat', 'ID'], ['Flores', 'ID'], ['Lombok', 'ID'], ['Sumba', 'ID'], ['Togian Islands', 'ID'], ['Banda Islands', 'ID'], ['Bali', 'ID'], ['Palawan', 'PH'], ['Siargao', 'PH'],
  ['Batanes', 'PH'], ['Ulaanbaatar', 'MN'],
  /* Middle East & Caucasus */
  ['Svaneti', 'GE'], ['Kazbegi', 'GE'], ['Tusheti', 'GE'], ['Dilijan', 'AM'], ['Sheki', 'AZ'], ['Cappadocia', 'TR'], ['Kas', 'TR'], ['Wadi Rum', 'JO'], ['Petra', 'JO'], ['Musandam', 'OM'],
  ['Salalah', 'OM'], ['AlUla', 'SA'], ['Socotra', 'YE'], ['Dahab', 'EG'], ['Siwa', 'EG'],
  /* Europe */
  ['Dolomites', 'IT'], ['Cinque Terre', 'IT'], ['Matera', 'IT'], ['Puglia', 'IT'], ['Sardinia', 'IT'], ['Lofoten', 'NO'], ['Senja', 'NO'], ['Faroe Islands', 'FO'], ['Westfjords', 'IS'],
  ['Lake Bled', 'SI'], ['Soca Valley', 'SI'], ['Durmitor', 'ME'], ['Kotor', 'ME'], ['Theth', 'AL'], ['Berat', 'AL'], ['Ohrid', 'MK'], ['Plovdiv', 'BG'], ['Rila', 'BG'], ['Maramures', 'RO'],
  ['High Tatras', 'SK'], ['Zakopane', 'PL'], ['Cesky Krumlov', 'CZ'], ['Tallinn', 'EE'], ['Curonian Spit', 'LT'], ['Azores', 'PT'], ['Madeira', 'PT'], ['Alentejo', 'PT'], ['Picos de Europa', 'ES'],
  ['La Gomera', 'ES'], ['Menorca', 'ES'], ['Corsica', 'FR'], ['Annecy', 'FR'], ['Chamonix', 'FR'], ['Engadin', 'CH'], ['Grindelwald', 'CH'], ['Hallstatt', 'AT'], ['Isle of Skye', 'GB'],
  ['Snowdonia', 'GB'], ['Connemara', 'IE'], ['Zagori', 'GR'], ['Naxos', 'GR'], ['Milos', 'GR'], ['Mostar', 'BA'], ['Sarajevo', 'BA'], ['Plitvice Lakes', 'HR'], ['Vis', 'HR'],
  /* Africa */
  ['Serengeti', 'TZ'], ['Zanzibar', 'TZ'], ['Kilimanjaro', 'TZ'], ['Maasai Mara', 'KE'], ['Lamu', 'KE'], ['Bwindi', 'UG'], ['Volcanoes National Park', 'RW'], ['Simien Mountains', 'ET'],
  ['Lalibela', 'ET'], ['Okavango Delta', 'BW'], ['Etosha', 'NA'], ['Sossusvlei', 'NA'], ['Kruger National Park', 'ZA'], ['Drakensberg', 'ZA'], ['Garden Route', 'ZA'], ['South Luangwa', 'ZM'],
  ['Victoria Falls', 'ZW'], ['Lake Malawi', 'MW'], ['Bazaruto', 'MZ'], ['Chefchaouen', 'MA'], ['Essaouira', 'MA'], ['Toubkal', 'MA'], ['Djerba', 'TN'], ['Sao Tome', 'ST'], ['Nosy Be', 'MG'],
  ['Praslin', 'SC'], ['Rodrigues', 'MU'], ['Saint-Louis', 'SN'], ['Cape Coast', 'GH'], ['Lope', 'GA'],
  /* Americas */
  ['Banff', 'CA'], ['Tofino', 'CA'], ['Gaspe', 'CA'], ['Haida Gwaii', 'CA'], ['Yukon', 'CA'], ['Kauai', 'US'], ['Maui', 'US'], ['Big Island', 'US'], ['Moab', 'US'], ['Sedona', 'US'],
  ['Glacier National Park', 'US'], ['Olympic National Park', 'US'], ['Asheville', 'US'], ['Acadia National Park', 'US'], ['Kenai Peninsula', 'US'], ['Oaxaca', 'MX'], ['San Cristobal de las Casas', 'MX'],
  ['Bacalar', 'MX'], ['Lake Atitlan', 'GT'], ['Caye Caulker', 'BZ'], ['Monteverde', 'CR'], ['Osa Peninsula', 'CR'], ['Bocas del Toro', 'PA'], ['Salento', 'CO'], ['Cartagena', 'CO'],
  ['Banos', 'EC'], ['Galapagos Islands', 'EC'], ['Huaraz', 'PE'], ['Cusco', 'PE'], ['Arequipa', 'PE'], ['Uyuni', 'BO'], ['Atacama', 'CL'], ['Torres del Paine', 'CL'], ['Chiloe', 'CL'],
  ['El Chalten', 'AR'], ['Bariloche', 'AR'], ['Ushuaia', 'AR'], ['Salta', 'AR'], ['Chapada Diamantina', 'BR'], ['Lencois Maranhenses', 'BR'], ['Fernando de Noronha', 'BR'], ['Pantanal', 'BR'],
  ['Colonia del Sacramento', 'UY'], ['Kaieteur Falls', 'GY'], ['Dominica', 'DM'], ['Saba', 'BQ'], ['Vinales', 'CU'],
  /* Oceania & Pacific */
  ['Queenstown', 'NZ'], ['Fiordland', 'NZ'], ['Abel Tasman', 'NZ'], ['Tasmania', 'AU'], ['Kangaroo Island', 'AU'], ['Kakadu', 'AU'], ['Ningaloo', 'AU'], ['Lord Howe Island', 'AU'],
  ['Taveuni', 'FJ'], ['Moorea', 'PF'], ['Aitutaki', 'CK'], ['Tanna', 'VU'], ['Savaii', 'WS'], ['Palau', 'PW'], ['Svalbard', 'SJ'], ['Ilulissat', 'GL'],
];
