/**
 * The engine's public surface.
 *
 * One thing is deliberately **not** here: the Eastern Sierra seed data. It used
 * to be, and that single line was the reason a marketing page could reach into
 * the fixture and a "generic" package could ship one region as part of its API.
 * It now lives behind the `@sidequest/core/data` subpath, where importing it is
 * a decision somebody made rather than something that happened to be in scope.
 * `architecture.test.ts` keeps it that way.
 */
export * from './schemas/common';
export * from './schemas/provenance';
export * from './schemas/geography';
export * from './schemas/licence';
export * from './schemas/intent';
export * from './schemas/resolution';
export * from './schemas/destination-index';
export * from './schemas/composer';
export * from './schemas/clarification';
export * from './schemas/scope';
export * from './schemas/region-pack';
export * from './schemas/source-fact';
export * from './schemas/evidence';
export * from './schemas/evidence-store';
export * from './schemas/compiled-region';
export * from './schemas/compilation';
export * from './schemas/progress';
export * from './schemas/supply';
export * from './schemas/preflight';
// `schemas/calendar` is deliberately not re-exported here: `schemas/access`
// already forwards every name in it, and two `export *` sources for one name
// make it ambiguous and therefore invisible to consumers.
export * from './schemas/access';
export * from './schemas/hours';
export * from './schemas/poi';
export * from './schemas/place';
export * from './schemas/food';
export * from './schemas/region';
export * from './schemas/trip';
export * from './schemas/profile';
export * from './schemas/discovery';
export * from './schemas/itinerary';
export * from './schemas/planner-readiness';
export * from './schemas/weather';
export * from './schemas/climate';

export * from './questionnaire/definition';
export * from './questionnaire/transform';

export * from './time/interval';
export * from './time/zone';

export * from './access/feasibility';
export * from './access/provider';

export * from './hours/availability';
export * from './hours/osm';
export * from './hours/provider';

export * from './food/availability';
export * from './food/board';
export * from './food/provider';

export * from './weather/board';
export * from './weather/board-backups';
export * from './weather/conditions';
export * from './weather/provider';
export * from './weather/solar';

export * from './region/season';
export * from './region/expansion';
export * from './region/source';

export * from './evidence/resolve';
export * from './evidence/preparation';
export * from './evidence/identity';
export * from './evidence/claims';
export * from './evidence/freshness';

export * from './dates/windows';
export * from './dates/duration';
export * from './scope/portfolio';
export * from './routing/plan';
export * from './routing/portfolio';

export * from './naming/display-name';

export * from './destinations/normalize';
export * from './destinations/match';
export * from './destinations/provider';

export * from './quality/candidate';

export * from './scoring/fit';

export * from './discovery/board';
export * from './discovery/autoselect';

export * from './profile/personality';

// Seed data is reachable at `@sidequest/core/data`, never from here. See the
// note at the top of this file.
