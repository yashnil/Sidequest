/**
 * THE PLAN, SAID IN THE TRAVELLER'S LANGUAGE.
 *
 * Two jobs, both presentation-only, and both with the same rule behind them:
 * **nothing here may make the plan claim more than it knows.**
 *
 * ---
 *
 * 1. `travellerVoice` — the same caveat, in words a traveller has a use for.
 *
 * Some of the honesty notices on a finished plan were written for whoever was
 * building the product. Two of them reached a real itinerary:
 *
 *   "Replace with a routing provider before relying on exact times."
 *   "Fixture weather. Not a forecast, and not observed data — for testing only."
 *
 * Both are *true*, and deleting either would turn an honest plan into a
 * confident wrong one — a modelled drive time presented as measured, or stand-in
 * weather presented as a forecast. So neither claim is weakened here. What
 * changes is who the sentence is addressed to: "replace with a routing provider"
 * is an instruction to an engineer, and a traveller reading it on the plan they
 * are about to drive learns nothing except that they are reading somebody's
 * to-do list. The replacement says the same thing — these times are modelled,
 * not measured, so do not plan a connection on them — to the person holding the
 * plan.
 *
 * The strings themselves belong to the planner and the data layer, and a stored
 * itinerary carries whichever one it was built with. That is why this is a
 * translation at the point of render rather than an edit at the source: a plan
 * built last week must read the same way as one built today, and rewriting the
 * fact a stored plan recorded would be editing somebody's trip.
 *
 * Anything not in the table passes through untouched. A notice this file has
 * never seen is shown exactly as written, which is the only safe default for a
 * licence or a caveat.
 *
 * ---
 *
 * 2. `clockAt` / `roundedDuration` — five-minute display precision.
 *
 * The planner works in whole minutes and should keep doing so. What it must not
 * do is *print* them: "18:02", "13:42" and "Free time 4 hr 18 min" claim a
 * precision that a modelled drive time and a typical visit duration cannot
 * support, and a traveller who reads 18:02 plans around 18:02.
 *
 * Rounding a time is not free, though, because some of these times sit against
 * an opening-hours claim. So the direction is a parameter and every caller
 * states it:
 *
 *   - an **arrival** rounds later, so a displayed start is never earlier than
 *     the real one and therefore never lands before a place opens;
 *   - an **opening** time rounds later and a **closing** or last-admission time
 *     rounds earlier, so the stated window is never wider than the real one;
 *   - a **duration** rounds down, so the plan never offers more free time than
 *     it has;
 *   - a **travel** duration rounds up, because that is the same rule and not an
 *     exception to it: travel is time the traveller spends rather than has, so
 *     down is the direction that understates the journey.
 *
 * In every case the rounding moves the number toward the side where being wrong
 * is harmless. Nothing scheduled changes; this is what the page prints.
 */

interface Translation {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const TRANSLATIONS: readonly Translation[] = [
  {
    /*
     * The instruction to whoever maintains the routing layer. The claim it
     * carries — these are not measured times — is restated for the person
     * driving, along with what they should actually do about it.
     */
    pattern: /Replace with a routing provider before relying on exact times\./g,
    replacement: 'Treat every time here as close rather than exact, and leave slack for anything you have to catch.',
  },
  {
    /*
     * "an authored <name> corridor-and-spur topology" is how the road model
     * describes itself to its own authors. "not measured road data" is the part
     * a traveller needs and is kept verbatim.
     */
    pattern: /Modelled from an authored [^.]*?topology, not measured road data\./g,
    replacement: 'Worked out from a model of the roads here, not measured road data.',
  },
  {
    /*
     * Stand-in weather. It must keep saying it is not a forecast and not an
     * observation — that is the whole point of the notice — without asking a
     * traveller to know what a fixture is.
     */
    pattern: /Fixture weather\. Not a forecast, and not observed data — for testing only\./g,
    replacement:
      'This is stand-in weather: not a forecast, not a real observation, and not a claim about your dates.',
  },
  {
    /*
     * The access layer's recheck note, verbatim from a live itinerary's "check
     * before you go" line. "A routing engine can reach this" is the data
     * layer talking about its own tooling; what the traveller needs from the
     * sentence is the claim — the way there exists, its being open is not
     * established — and that survives whole.
     */
    pattern:
      /We know a routing engine can reach this, not that it is open to the public on your dates\./g,
    replacement:
      'We know the road or path reaches this, not that it is open to the public on your dates.',
  },
  {
    /*
     * The travel-time attribution. OpenStreetMap stays by name — that half is
     * the attribution the licence is about — while the name of our own
     * routing software is infrastructure a traveller has no use for. The
     * claim ("measured", and from what data) is untouched.
     */
    pattern: /Measured (driving|walking) times from a Valhalla routing engine over OpenStreetMap data\./g,
    replacement: 'Measured $1 times, worked out over OpenStreetMap road data.',
  },
  {
    /*
     * The routing planner's own note about a cluster it could not fully
     * measure, stored in the artifact's diagnostics and rendered under "How
     * travel times were measured". "Candidates" and "unrouted reserve" are
     * §26 vocabulary; the fact — some places there have no measured times —
     * is kept exactly.
     */
    pattern:
      /has more candidates than one local routing pass covers; the rest are kept as unrouted reserve\./g,
    replacement:
      'has more places than one measuring pass covers; the rest were set aside without measured travel times.',
  },
];

/**
 * A WEATHER POINT LABEL A TRAVELLER CANNOT USE, RECOGNISED.
 *
 * The forecast layer names its points `Forecast point 3` — an index into a
 * list nobody outside the build can see. On a live itinerary that rendered as
 * "Taken at 2 separate points: Forecast point 3, Forecast point 4" and a day
 * badge reading "Historical pattern Forecast point 3". The index carries no
 * geography a traveller could act on, and no locality name exists at render
 * time to translate it into — so the honest treatment is to keep the *count*
 * (which is real information: the region was not measured as one number) and
 * drop the machine index. A label that names an actual place passes this test
 * and is shown.
 */
export function isMachineWeatherLabel(label: string): boolean {
  return /^Forecast point \d+$/.test(label);
}

/**
 * Rewrite provider-facing sentences into traveller-facing ones.
 *
 * Never weakens a claim, never removes one, and never invents one. A string with
 * nothing to translate is returned unchanged, including its own identity — so a
 * caller can compare the result to the input to find out whether anything moved.
 */
export function travellerVoice(text: string): string {
  let result = text;
  for (const { pattern, replacement } of TRANSLATIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Which way a rounded clock time is allowed to move. See the header. */
export type ClockEdge =
  /** An arrival, or an opening time: later, so it is never before the real one. */
  | 'later'
  /** A closing time, or a last admission: earlier, so the window never widens. */
  | 'earlier';

const STEP = 5;

/**
 * A minute-of-day rounded to five minutes, in the safe direction.
 *
 * Exported alongside `formatMinuteOfDay` rather than replacing it: the raw
 * formatter is still correct, and the rounding is a display decision the caller
 * has to be explicit about.
 */
export function roundedMinuteOfDay(minute: number, edge: ClockEdge): number {
  const rounded =
    edge === 'later' ? Math.ceil(minute / STEP) * STEP : Math.floor(minute / STEP) * STEP;
  // A day is 1440 minutes; rounding the last few minutes of one up must not
  // produce a 24:00 that reads as the next morning.
  return Math.max(0, Math.min(1439, rounded));
}

/**
 * A span in minutes, rounded down to five.
 *
 * Down, always: this number is used for "free", "at stops" and how long a leg
 * takes, and every one of those is a promise about time the traveller has.
 * Anything under five minutes keeps its exact value rather than collapsing to
 * zero — "0 min free" would be a different and wrong statement.
 */
export function roundedDuration(minutes: number): number {
  if (minutes < STEP) return minutes;
  return Math.floor(minutes / STEP) * STEP;
}

/**
 * A span of *travel*, rounded up to five.
 *
 * Up, always, and that is the same rule as `roundedDuration` rather than an
 * exception to it: both round in the direction that cannot make a claim false,
 * and travel time is the one span on this page that the traveller spends rather
 * than has. Flooring it understates the journey — a rendered day printed
 *
 *     11:00  10 min   Walk back to Osaka
 *                     14 min back to Osaka.
 *
 * where the row header and the sentence under it disagreed by forty per cent
 * about the same walk, and the smaller of the two was the one in the schedule
 * column. A traveller reading the column budgets ten minutes for a fourteen
 * minute walk; a traveller reading the sentence wonders which half to believe.
 *
 * Under five minutes keeps its exact value, for the same reason it does above:
 * a two-minute hop printed as five is a different and wrong statement.
 */
export function roundedTravel(minutes: number): number {
  if (minutes < STEP) return minutes;
  return Math.ceil(minutes / STEP) * STEP;
}
