// THE PROVIDER CAPABILITY REGISTRY — one pure function of the environment.
//
// Plain ESM on purpose: `scripts/doctor.mjs` and the TypeScript app both import
// this file, so the doctor can never disagree with the app about what is
// configured. No secrets are read beyond "is this set"; nothing here makes a
// network call.

/** @typedef {'free'|'metered'|'self_hosted'|'none'} CostClass */
/** @typedef {{ id: string; group: string; configured: boolean; available: boolean; provider: string|null; costClass: CostClass; freshness: string; coverage: string; limitations: string[]; fixture: boolean }} Capability */

const read = (env, name) => (env[name] ?? '').trim();
const eq = (env, name, value) => read(env, name).toLowerCase() === value;
const set = (env, name) => read(env, name).length > 0;

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{ mode: 'fixture'|'mixed'|'live'|'off'; composition: 'anthropic'|'fixture'|'off'; capabilities: Capability[]; byId: Record<string, Capability> }}
 */
/**
 * CAPABILITY → CANONICAL CONSUMER. A capability is advertised as available
 * only when the canonical runtime reaches the named seam; `null` means the
 * adapter exists but nothing on the product path consumes it (reported as
 * adapter-only). `capability-consumers.test.ts` holds this table to the code.
 */
export const CONSUMERS = {
  'composition.model': 'planning/production-plan.ts#generateSidequestPlanForTrip (one model call)',
  'places.identity': 'planning/place-identity.ts#placesIdentitySeam → reconcile.ts#resolveDraftAnchor',
  'places.details': 'planning/place-identity.ts#operationalEvidenceSeam → reconcile.ts (status, website not persisted)',
  'places.hours': 'planning/place-identity.ts#operationalEvidenceSeam → reconcile.ts hours pass + layout (item.operational)',
  'places.photos': 'providers/wikimedia.ts#imageryMode → imagery table → ItineraryView',
  'places.business_status': 'planning/place-identity.ts#operationalEvidenceSeam → reconcile.ts (closed_permanently contradiction)',
  'routing.drive': 'planning/route-selection.ts#policyConfirmRoute + skeleton-orchestrator.ts#productionRouteMatrix',
  'routing.walk': 'planning/route-selection.ts#policyConfirmRoute + skeleton-orchestrator.ts#productionRouteMatrix',
  'routing.transit': 'planning/route-selection.ts#policyConfirmRoute (transit mode) → reconcile.ts transitSummary',
  'routing.bicycle': null,
  'routing.traffic': 'providers/routing-policy.ts#decideRouting (high-value drive inside 48 h) → route-selection.ts',
  'routing.geometry': 'reconcile.ts#pushLeg (encoded polyline) → InteractiveMap',
  'routing.global': 'providers/routing-composite.ts#createCompositeRouting ← planning/verification-providers.ts (local coverage → openrouteservice)',
  'lodging.area': 'core/intelligence/lodging.ts#buildLodgingIntelligence → TripHub StaysSection',
  'lodging.discovery': 'providers/discovery.ts#discoverStaysNear ← itinerary/actions.ts#discoverStaysAction (display only)',
  'lodging.live_price': null,
  'lodging.availability': null,
  'food.discovery': 'providers/discovery.ts#discoverFoodNear ← itinerary/actions.ts#discoverFoodAction (display only)',
  'weather.forecast': 'weather/refresh.ts#ensureWeatherForPlanning → reconcile.ts day weather',
  'weather.climate': 'lib/capabilities.ts (climate_normals) → destinations/recommend.ts + composer date guidance',
  'currency.fx': 'planning/production-plan.ts (fetchReferenceRate → trip_fx_rates) → intelligence/load.ts budget',
  'readiness.entry': 'core/intelligence/readiness.ts#OfficialTravelSourceRegistry → intelligence/build.ts',
  'readiness.advisory': 'core/intelligence/readiness.ts#OfficialTravelSourceRegistry → intelligence/build.ts',
  'readiness.health': 'core/intelligence/readiness.ts#OfficialTravelSourceRegistry → intelligence/build.ts',
  'maps.tiles': 'components/map-adapter.ts#resolveMapTileSource → InteractiveMap',
  'destinations.resolution': 'trips/new/place-actions.ts#placeDestinationAction (index → bundled country reference → geocoder) → the setup canvas and the timing recommendation, then plan/actions.ts#resolveDestinationAction once the trip exists',
  'destinations.suggestions': 'api/destinations/suggest → destinations/provider.ts#localSuggestionProvider (the local index only, never a network call while typing)',
};

export function capabilityRegistry(env = process.env) {
  const compilerChoice = read(env, 'SIDEQUEST_COMPILER_PROVIDER').toLowerCase();
  const fixtureCompiler = compilerChoice === 'fixture';
  const fixtureComposer = eq(env, 'SIDEQUEST_COMPOSER_PROVIDER', 'fixture');
  const anthropic = set(env, 'ANTHROPIC_API_KEY');
  const googleKey = set(env, 'GOOGLE_MAPS_API_KEY');
  /* Recorded Google responses (`SIDEQUEST_PLACES_FIXTURE=<file>`): the real adapter runs against saved JSON. Free, offline, marked fixture. */
  const placesRecorded = set(env, 'SIDEQUEST_PLACES_FIXTURE');
  const google = googleKey || placesRecorded;
  const nominatim = eq(env, 'SIDEQUEST_GEOCODER_PROVIDER', 'nominatim');
  const overture = eq(env, 'SIDEQUEST_PLACE_BACKBONE', 'overture');
  const overpass = eq(env, 'SIDEQUEST_POI_PROVIDER', 'overpass');
  const valhalla = eq(env, 'SIDEQUEST_ROUTES_PROVIDER', 'valhalla');
  /*
   * Google Routes is never inferred from the presence of a Maps key. The
   * repository's own terms review (`.claude-private/BLOCKER-google-terms.md`)
   * finds no clause allowing Routes durations or polylines to be persisted,
   * and Sidequest persists every measured leg. An operator who has settled
   * that question opts in explicitly; the default backbone stays Valhalla.
   */
  const googleRoutes = google && (eq(env, 'SIDEQUEST_ROUTES_PROVIDER', 'google') || eq(env, 'SIDEQUEST_TRANSIT_PROVIDER', 'google') || eq(env, 'SIDEQUEST_TRAFFIC_PROVIDER', 'google'));
  const googleTraffic = google && eq(env, 'SIDEQUEST_TRAFFIC_PROVIDER', 'google');
  const googleTransit = google && eq(env, 'SIDEQUEST_TRANSIT_PROVIDER', 'google');
  const valhallaUrl = read(env, 'SIDEQUEST_ROUTES_URL');
  const valhallaSelfHosted = valhalla && /127\.0\.0\.1|localhost|\.internal|:8002/.test(valhallaUrl);
  /* PRODUCT RECOVERY V1 — declared coverage of the local router, and the optional global router behind it. */
  const routesCoverage = read(env, 'SIDEQUEST_ROUTES_COVERAGE');
  const orsChosen = eq(env, 'SIDEQUEST_ROUTES_GLOBAL_PROVIDER', 'openrouteservice');
  const orsRecorded = set(env, 'SIDEQUEST_ROUTES_FIXTURE');
  const ors = orsChosen && (set(env, 'OPENROUTESERVICE_API_KEY') || orsRecorded);
  const transitValhalla = eq(env, 'SIDEQUEST_TRANSIT_PROVIDER', 'valhalla');
  const weatherRaw = read(env, 'SIDEQUEST_WEATHER_PROVIDER').toLowerCase();
  const weather = weatherRaw === '' ? 'openmeteo' : weatherRaw;
  const climate = !eq(env, 'SIDEQUEST_CLIMATE_PROVIDER', 'off');
  const fxRaw = read(env, 'SIDEQUEST_FX_PROVIDER').toLowerCase();
  const fx = fxRaw === 'frankfurter' || fxRaw === 'fixture' ? fxRaw : 'off';
  const imageryRaw = read(env, 'SIDEQUEST_IMAGERY_PROVIDER').toLowerCase();
  const imagery = imageryRaw === '' ? 'wikimedia' : imageryRaw;
  const openFreeMap = eq(env, 'SIDEQUEST_MAP_PROVIDER', 'openfreemap');
  const tiles = set(env, 'SIDEQUEST_MAP_TILES') || openFreeMap;
  const placesLive = !fixtureCompiler && (nominatim || overture || overpass || google);

  /** @type {Capability[]} */
  const capabilities = [];
  const add = (id, group, cfg) => {
    capabilities.push({ id, group, configured: cfg.configured, available: cfg.available ?? cfg.configured, provider: cfg.provider ?? null, costClass: cfg.costClass ?? 'none', freshness: cfg.freshness ?? 'stable', coverage: cfg.coverage ?? '', limitations: cfg.limitations ?? [], fixture: cfg.fixture ?? false, consumer: CONSUMERS[id] ?? null, adapterOnly: cfg.adapterOnly ?? false });
  };

  add('composition.model', 'composition', fixtureComposer ? { configured: true, provider: 'fixture', costClass: 'free', fixture: true, coverage: 'Saved fixture drafts; no model call.' } : anthropic ? { configured: true, provider: 'anthropic', costClass: 'metered', coverage: 'One model call per generation.' } : { configured: false, provider: null, limitations: ['No model credential: nothing can compose a draft.'] });

  const placeProvider = fixtureCompiler ? 'fixture' : google ? 'google-places' : overture ? 'overture' : nominatim ? 'nominatim' : overpass ? 'overpass' : null;
  add('places.identity', 'places', { configured: placesLive || fixtureCompiler || placesRecorded, provider: placesRecorded ? 'google-places' : placeProvider, costClass: fixtureCompiler || placesRecorded ? 'free' : google ? 'metered' : 'free', fixture: fixtureCompiler || placesRecorded, freshness: 'stable', coverage: fixtureCompiler ? 'Synthetic worlds.' : [nominatim && 'Nominatim', overture && 'Overture', overpass && 'Overpass', google && 'Google Places (identity level)'].filter(Boolean).join(', '), limitations: placesLive || fixtureCompiler ? [] : ['Every model anchor stays unverified.'] });
  add('places.details', 'places', { configured: fixtureCompiler || google, provider: google ? 'google-places' : fixtureCompiler ? 'fixture' : null, costClass: googleKey ? 'metered' : 'free', fixture: fixtureCompiler || placesRecorded, freshness: 'medium', coverage: google ? 'Website, address, price level, business status for scheduled venues.' : '', limitations: google || fixtureCompiler ? [] : ['Details stay as the model proposed them.'] });
  add('places.hours', 'places', { configured: fixtureCompiler || google, provider: google ? 'google-places' : fixtureCompiler ? 'fixture' : null, costClass: googleKey ? 'metered' : 'free', fixture: fixtureCompiler || placesRecorded, freshness: 'volatile', coverage: 'Regular hours for business venues and controlled sites only; never for open ground.', limitations: google || fixtureCompiler ? [] : ['Unknown hours are shown as unknown, never as closed.'] });
  /*
   * Photos come from Wikimedia (licensed, attributed, persistable) or fixture plates.
   * The Google media adapter (`google-places.ts#mediaFacts`) exists and is contract-tested but is NOT canonical: photos are
   * Google Maps Content, and the imagery table persists what it shows. It is reported as adapter-only, never as a provider.
   */
  add('places.photos', 'places', { configured: imagery !== 'off', provider: imagery === 'fixture' ? 'fixture' : imagery === 'wikimedia' ? 'wikimedia' : null, costClass: 'free', fixture: imagery === 'fixture', freshness: 'stable', coverage: imagery === 'wikimedia' ? 'Licensed Wikimedia photographs with attribution.' : imagery === 'fixture' ? 'Generated plates.' : '', limitations: ['Google photos: adapter implemented, intentionally not canonical (Maps Content is not persisted).'], adapterOnly: imagery === 'off' && google });
  add('places.business_status', 'places', { configured: google, provider: google ? 'google-places' : null, costClass: googleKey ? 'metered' : 'free', fixture: placesRecorded, freshness: 'medium', coverage: google ? 'Operational / temporarily closed / permanently closed.' : '', limitations: google ? [] : ['Closures are only known from official evidence the compiler found.'] });

  const driveProvider = fixtureCompiler ? 'fixture' : valhalla ? 'valhalla' : ors ? 'openrouteservice' : googleRoutes ? 'google-routes' : null;
  const roadConfigured = fixtureCompiler || valhalla || ors || googleRoutes;
  add('routing.drive', 'routing', { configured: roadConfigured, provider: driveProvider, costClass: fixtureCompiler ? 'free' : valhalla ? (valhallaSelfHosted ? 'self_hosted' : 'free') : ors ? (orsRecorded ? 'free' : 'metered') : 'metered', fixture: fixtureCompiler || (!valhalla && orsRecorded), freshness: 'stable', coverage: valhalla ? `Valhalla at ${valhallaSelfHosted ? 'a self-hosted endpoint' : 'a public endpoint'}${routesCoverage ? `, coverage ${routesCoverage}` : ', coverage not declared'}${ors ? '; openrouteservice beyond it' : ''}` : ors ? 'openrouteservice (global)' : googleRoutes ? 'Google Routes (DRIVE)' : '', limitations: roadConfigured ? (valhalla && !routesCoverage && !ors ? ['Coverage not declared and no global router: a leg outside the local tile build is attempted once, learned from (error_code 171), and then estimated. Set SIDEQUEST_ROUTES_COVERAGE to skip the first request, and SIDEQUEST_ROUTES_GLOBAL_PROVIDER=openrouteservice to measure beyond the tiles.'] : valhalla && !routesCoverage ? ['Coverage not declared: a leg outside the local tile build costs one request before openrouteservice answers it. Set SIDEQUEST_ROUTES_COVERAGE to skip it.'] : []) : ['Every leg is estimated from map distance or held as an allowance.'] });
  add('routing.walk', 'routing', { configured: roadConfigured, provider: driveProvider, costClass: fixtureCompiler ? 'free' : valhalla ? 'free' : ors ? (orsRecorded ? 'free' : 'metered') : 'metered', fixture: fixtureCompiler || (!valhalla && orsRecorded), freshness: 'stable', coverage: valhalla ? 'Valhalla pedestrian' : ors ? 'openrouteservice foot-walking' : googleRoutes ? 'Google Routes (WALK)' : '', limitations: [] });
  add('routing.global', 'routing', { configured: ors, provider: ors ? 'openrouteservice' : null, costClass: ors ? (orsRecorded ? 'free' : 'metered') : 'none', fixture: Boolean(orsRecorded), freshness: 'stable', coverage: ors ? `openrouteservice at api.heigit.org (global OpenStreetMap graph); direct legs only, no matrices${valhalla ? '; used where the local router\'s coverage ends' : ''}` : '', limitations: ors ? ['Hosted quota applies; legs are requested one at a time.'] : ['No global router: legs outside the local router\'s coverage are estimated from map distance.'] });
  add('routing.transit', 'routing', { configured: fixtureCompiler || transitValhalla || googleTransit, provider: fixtureCompiler ? 'fixture' : transitValhalla ? 'valhalla-multimodal' : googleTransit ? 'google-routes' : null, costClass: fixtureCompiler ? 'free' : transitValhalla ? 'self_hosted' : 'metered', fixture: fixtureCompiler, freshness: 'date_bound', coverage: transitValhalla ? 'Valhalla multimodal (needs transit tiles)' : googleTransit ? 'Google Routes (TRANSIT) with timetables' : '', limitations: fixtureCompiler || transitValhalla || googleTransit ? [] : ['Public-transport legs stay as unverified schedules.'] });
  /* The draft transport vocabulary has no bicycle mode, so no canonical path asks for it: the adapter exists, the capability is not offered. */
  add('routing.bicycle', 'routing', { available: false, adapterOnly: true, configured: fixtureCompiler || valhalla || googleRoutes, provider: driveProvider, costClass: valhalla ? 'free' : 'metered', fixture: fixtureCompiler, coverage: valhalla ? 'Valhalla bicycle' : googleRoutes ? 'Google Routes (BICYCLE, preview)' : '', limitations: googleRoutes && !valhalla ? ['Google bicycle routing is a preview feature.'] : [] });
  add('routing.traffic', 'routing', { configured: googleTraffic, provider: googleTraffic ? 'google-routes' : null, costClass: 'metered', freshness: 'very_volatile', coverage: googleTraffic ? 'TRAFFIC_AWARE for departures inside 48 hours, high-value legs only.' : '', limitations: googleTraffic ? ['Never applied to far-future trips; static durations are kept.'] : ['Static durations only; nothing is labelled live traffic.'] });
  add('routing.geometry', 'routing', { configured: roadConfigured, provider: driveProvider, costClass: 'free', fixture: fixtureCompiler, coverage: 'Encoded polylines on measured legs.', limitations: [] });

  add('lodging.area', 'lodging', { configured: true, provider: 'sidequest', costClass: 'free', coverage: 'Area and base intelligence from the plan and the profile.', limitations: [] });
  add('lodging.discovery', 'lodging', { configured: google, provider: google ? 'google-places' : null, costClass: googleKey ? 'metered' : 'free', fixture: placesRecorded, freshness: 'medium', coverage: google ? 'Up to 3 real properties per base.' : '', limitations: google ? ['Properties are discovered, not quoted.'] : ['Areas only.'] });
  add('lodging.live_price', 'lodging', { configured: false, available: false, provider: null, costClass: 'none', freshness: 'very_volatile', limitations: ['No accommodation inventory provider; prices are never shown.'] });
  add('lodging.availability', 'lodging', { configured: false, available: false, provider: null, costClass: 'none', freshness: 'very_volatile', limitations: ['No accommodation inventory provider; availability is never shown.'] });

  add('food.discovery', 'food', { configured: !eq(env, 'SIDEQUEST_FOOD_PROVIDER', 'off') && (fixtureCompiler || google || overpass || overture), provider: fixtureCompiler ? 'fixture' : google ? 'google-places' : overture ? 'overture' : overpass ? 'overpass' : null, costClass: google ? 'metered' : 'free', fixture: fixtureCompiler, freshness: 'medium', coverage: google ? 'One targeted lookup per meal that needs a named venue.' : 'Region food data.', limitations: [] });

  add('weather.forecast', 'weather', { configured: weather !== 'off', provider: weather, costClass: 'free', fixture: weather === 'fixture', freshness: 'very_volatile', coverage: weather === 'openmeteo' ? 'Open-Meteo, 16-day horizon.' : weather === 'fixture' ? 'Fixture weather.' : '', limitations: [] });
  add('weather.climate', 'weather', { configured: climate && weather !== 'off', provider: climate ? weather : null, costClass: 'free', fixture: weather === 'fixture', freshness: 'stable', coverage: climate ? 'Historical normals for dates beyond the forecast.' : '', limitations: climate ? [] : ['Climate is switched off; far-future days show no weather.'] });

  add('currency.fx', 'currency', { configured: fx !== 'off', provider: fx === 'off' ? null : fx, costClass: 'free', fixture: fx === 'fixture', freshness: 'date_bound', coverage: fx === 'frankfurter' ? 'ECB reference rates via Frankfurter, dated.' : fx === 'fixture' ? 'Fixture rates.' : '', limitations: fx === 'off' ? ['Budgets stay in the local currency; no conversion shown.'] : ['Reference rates, not what a card will charge.'] });

  add('readiness.entry', 'readiness', { configured: true, provider: 'official-source-registry', costClass: 'free', freshness: 'regulatory_volatile', coverage: 'Official entry-point links; nothing legal is confirmed by Sidequest.', limitations: ['No Timatic licence; the public IATA checker is the neutral entry point.'] });
  add('readiness.advisory', 'readiness', { configured: true, provider: 'official-source-registry', costClass: 'free', freshness: 'regulatory_volatile', coverage: 'Traveller-country advisories for US, GB, CA, AU, NZ, IE, DE, FR.', limitations: ['Other passport countries get the generic official entry points and are told so.'] });
  add('readiness.health', 'readiness', { configured: true, provider: 'official-source-registry', costClass: 'free', freshness: 'regulatory_volatile', coverage: 'CDC, NHS Fit for Travel, WHO links.', limitations: [] });

  /*
   * STAGING PARITY §2, §8 — THE CAPABILITY THAT FAILED WAS NOT IN THE REGISTRY.
   *
   * A traveller typed "Japan" on a fresh deployment and got the empty-world map
   * captioned ANYWHERE, and neither the doctor nor the registry had a row that
   * could have predicted it: destination resolution was not a capability here, so
   * "configured" said nothing about whether a typed name could become a place.
   *
   * It is `configured: true` unconditionally and that is not a cheat: the bundled
   * country reference ships with the app, needs no network and no database, and
   * places every country the app holds facts for — including inside a phrase. What
   * the geocoder adds is everything smaller than a country, which is why its
   * absence is a limitation rather than an outage.
   */
  add('destinations.resolution', 'destinations', {
    configured: true,
    /*
     * The provider named here is the *external* one, when there is one, because
     * that is what `mode` is computed from. The bundled reference is Sidequest's
     * own data — the same class as `lodging.area` — so with nothing configured
     * this is `sidequest` and the deployment is not thereby "live".
     */
    provider: nominatim ? 'nominatim' : google ? 'google-places' : 'sidequest',
    costClass: nominatim ? 'free' : google ? (placesRecorded ? 'free' : 'metered') : 'none',
    fixture: !nominatim && placesRecorded,
    freshness: 'stable',
    coverage: nominatim || google
      ? 'The bundled country reference answers first, offline, for any country the app holds facts for — including one named inside a phrase. The geocoder answers everything smaller: cities, regions, parks, deltas.'
      : 'Bundled country reference only: a country places offline, anything smaller stays unplaced until the trip is created.',
    limitations: nominatim || google
      ? []
      : ['No geocoder: a city, region or park typed as free text is not placed before the trip exists. Set SIDEQUEST_GEOCODER_PROVIDER=nominatim (keyless) to place them.'],
  });
  add('destinations.suggestions', 'destinations', {
    configured: set(env, 'SIDEQUEST_DESTINATION_INDEX_SEED'),
    provider: set(env, 'SIDEQUEST_DESTINATION_INDEX_SEED') ? 'sidequest' : null,
    costClass: 'none',
    freshness: 'stable',
    coverage: 'As-you-type suggestions from the local destination index. Never a network call, by policy.',
    limitations: set(env, 'SIDEQUEST_DESTINATION_INDEX_SEED')
      ? []
      : ['No index seed configured: the field takes free text, which every downstream step already supports. A database that already holds a release keeps using it.'],
  });

  add('maps.tiles', 'maps', { configured: tiles, provider: openFreeMap ? 'openfreemap' : tiles ? 'tiles' : null, costClass: openFreeMap ? 'free' : tiles ? 'metered' : 'none', coverage: openFreeMap ? 'OpenFreeMap vector basemap (OpenMapTiles / OpenStreetMap), rendered in the browser.' : tiles ? 'Basemap tiles.' : 'Positions and geometry only, no basemap.', limitations: openFreeMap ? ['Public instance, no SLA; attribution rendered under every map.'] : tiles ? [] : ['Maps draw positions and routes without a basemap.'] });

  const byId = Object.fromEntries(capabilities.map((c) => [c.id, c]));
  const realProviders = capabilities.some((c) => c.group !== 'composition' && c.configured && !c.fixture && c.provider && c.provider !== 'sidequest' && c.provider !== 'official-source-registry' && c.costClass !== 'none');
  const composition = fixtureComposer ? 'fixture' : anthropic ? 'anthropic' : 'off';
  const mode = composition === 'off' ? 'off' : composition === 'fixture' && !realProviders ? 'fixture' : composition === 'anthropic' && realProviders ? 'live' : 'mixed';
  return { mode, composition, capabilities, byId };
}

/** Short traveller-safe words for the dev-only environment pill. */
export function modeLabel(mode) {
  return mode === 'fixture' ? 'Fixture' : mode === 'live' ? 'Live' : mode === 'mixed' ? 'Mixed' : 'Off';
}

/** What a mode will actually do on the network, for the pill's tooltip. */
export function modeExplanation(registry) {
  const model = registry.composition === 'anthropic' ? 'one Anthropic model call per generation' : registry.composition === 'fixture' ? 'no model call (saved fixture draft)' : 'no model configured';
  const metered = registry.capabilities.filter((c) => c.configured && c.costClass === 'metered').map((c) => c.provider).filter((p, i, all) => all.indexOf(p) === i);
  return `${model}; ${metered.length > 0 ? `metered providers: ${metered.join(', ')}` : 'no metered providers'}.`;
}
