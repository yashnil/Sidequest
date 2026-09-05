import { z } from 'zod';
import type { Itinerary, TripPackage } from '../schemas/itinerary';
import type { TravelerProfile } from '../schemas/profile';
import type { BookingItem } from './booking';
import type { TransportLeg } from './transport';

/**
 * MODE 3: OPTIMISE MY EXISTING PLAN — A DETERMINISTIC CRITIQUE.
 *
 * The traveller's plan came in as named places, dates and bookings. The model
 * composed around them and the reconciler verified what it could. This reads
 * the result back against the traveller's own intent and answers the questions
 * a friend who knows the region would answer: too rushed? geography wrong?
 * transfers unreasonable? anything of yours missing? what should move, what
 * should go, what is already good. It never throws the plan away.
 */
export const CRITIQUE_TOPICS = ['pace', 'geography', 'transfers', 'must_do', 'driving', 'hotel_changes', 'timing', 'bookings', 'good'] as const;
export const critiqueTopicSchema = z.enum(CRITIQUE_TOPICS);
export type CritiqueTopic = z.infer<typeof critiqueTopicSchema>;

export const critiqueFindingSchema = z.object({
  topic: critiqueTopicSchema,
  severity: z.enum(['fine', 'note', 'concern']),
  title: z.string().min(1),
  detail: z.string().min(1),
  suggestion: z.string().min(1).optional(),
  dayNumbers: z.array(z.number().int().min(1)).default([]),
});
export type CritiqueFinding = z.infer<typeof critiqueFindingSchema>;

export const planCritiqueSchema = z.object({
  verdict: z.enum(['works', 'works_with_changes', 'needs_rethink']),
  headline: z.string().min(1),
  findings: z.array(critiqueFindingSchema),
  move: z.array(z.string().min(1)).default([]),
  cut: z.array(z.string().min(1)).default([]),
  keep: z.array(z.string().min(1)).default([]),
  userPlaces: z.array(z.object({ name: z.string().min(1), outcome: z.enum(['kept', 'moved', 'dropped', 'not_found']), detail: z.string().min(1) })).default([]),
});
export type PlanCritique = z.infer<typeof planCritiqueSchema>;

function normalise(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function buildPlanCritique(input: { itinerary: Itinerary; pkg: TripPackage | undefined; profile: TravelerProfile; userPlaces: readonly string[]; legs: readonly TransportLeg[]; bookings: readonly BookingItem[]; bookedConflicts: readonly string[] }): PlanCritique {
  const { itinerary, pkg, profile } = input;
  const findings: (Omit<CritiqueFinding, 'dayNumbers'> & { dayNumbers?: number[] })[] = [];
  const move: string[] = [];
  const cut: string[] = [];
  const keep: string[] = [];

  // Pace ----------------------------------------------------------------------
  const days = itinerary.days;
  const busy = days.filter((d) => d.totals.activityMinutes + d.totals.travelMinutes > d.window.usableMinutes * 0.9 && d.window.usableMinutes > 0);
  const intense = days.filter((d) => d.intensity === 'intense');
  const paceLimit = profile.pace === 'slow' ? 0 : profile.pace === 'balanced' ? Math.ceil(days.length / 3) : days.length;
  if (busy.length > 0 || intense.length > paceLimit) {
    findings.push({ topic: 'pace', severity: intense.length > paceLimit + 1 || busy.length >= 2 ? 'concern' : 'note', title: `${busy.length > 0 ? `${busy.length} day${busy.length === 1 ? '' : 's'} run to the edge of the window` : `${intense.length} intense days against a ${profile.pace} pace`}`, detail: busy.length > 0 ? `Day${busy.length === 1 ? '' : 's'} ${busy.map((d) => d.dayNumber).join(', ')} ${busy.length === 1 ? 'has' : 'have'} almost no slack between stops and travel.` : `You said ${profile.pace}; days ${intense.map((d) => d.dayNumber).join(', ')} are intense.`, suggestion: 'Drop the lowest-role stop on the fullest day rather than shortening every stop.', dayNumbers: (busy.length > 0 ? busy : intense).map((d) => d.dayNumber) });
    for (const day of busy.length > 0 ? busy : intense.slice(paceLimit)) {
      const optional = (pkg?.anchors ?? []).find((a) => (a.scheduledDayNumber ?? a.dayNumber) === day.dayNumber && (a.role === 'optional' || a.role === 'flex'));
      if (optional) cut.push(`${optional.name} (day ${day.dayNumber}) — optional, and the day is full.`);
    }
  } else findings.push({ topic: 'pace', severity: 'fine', title: 'The pace matches what you asked for', detail: `${days.length} days at a ${profile.pace} pace with slack on every day.` });

  // Driving --------------------------------------------------------------------
  const cap = profile.transport.maxDailyDriveMinutes;
  const longDrives = days.filter((d) => d.totals.driveMinutes > Math.max(cap, 1));
  if (longDrives.length > 0) findings.push({ topic: 'driving', severity: 'concern', title: `${longDrives.length} day${longDrives.length === 1 ? '' : 's'} over your driving limit`, detail: `Day${longDrives.length === 1 ? '' : 's'} ${longDrives.map((d) => `${d.dayNumber} (${Math.round(d.totals.driveMinutes / 60 * 10) / 10} h)`).join(', ')} exceed the ${Math.round(cap / 60 * 10) / 10} h a day you set.`, suggestion: 'Add a night between the two bases, or cut the farthest stop on that day.', dayNumbers: longDrives.map((d) => d.dayNumber) });
  else if (itinerary.transportStrategy.totals.driveMinutes > 0) findings.push({ topic: 'driving', severity: 'fine', title: 'Driving stays inside your limit', detail: `The longest driving day is ${Math.round(Math.max(...days.map((d) => d.totals.driveMinutes)) / 60 * 10) / 10} h against your ${Math.round(cap / 60 * 10) / 10} h cap.` });

  // Hotel changes --------------------------------------------------------------
  const bases = pkg?.bases.length ?? new Set(days.map((d) => d.baseId)).size;
  const tolerance = profile.interview.baseMoveTolerance;
  const allowed = tolerance === 'stay_put' ? 1 : tolerance === 'move_once' ? 2 : 99;
  if (bases > allowed) findings.push({ topic: 'hotel_changes', severity: 'concern', title: `${bases - 1} hotel changes against "${tolerance.replace(/_/g, ' ')}"`, detail: `The plan sleeps in ${bases} places; you said you would rather ${tolerance === 'stay_put' ? 'stay put' : 'move once'}.`, suggestion: 'Merge the two closest bases and make the far stop a long day out, or accept the moves for the sake of the route.' });
  else findings.push({ topic: 'hotel_changes', severity: 'fine', title: bases === 1 ? 'One base for the whole trip' : `${bases} bases, within what you accept`, detail: bases === 1 ? 'Unpack once.' : 'Each move is on a day marked as a transfer.' });

  // Transfers / geography --------------------------------------------------------
  const unmeasured = input.legs.filter((l) => l.durationBasis === 'unmeasured');
  const nonRoad = unmeasured.filter((l) => l.unmeasuredReason === 'mode_not_road_routable');
  if (unmeasured.length > 0) findings.push({ topic: 'transfers', severity: unmeasured.length - nonRoad.length > 2 ? 'note' : 'fine', title: `${unmeasured.length} transfer${unmeasured.length === 1 ? '' : 's'} could not be timed`, detail: nonRoad.length > 0 ? `${nonRoad.length} of them ${nonRoad.length === 1 ? 'is' : 'are'} a ${[...new Set(nonRoad.map((l) => l.mode))].join('/')} leg the road router does not cover; ${nonRoad.length === 1 ? 'it is' : 'they are'} plausible, not impossible.` : 'The router had no answer for them; the plan keeps them as estimates.', suggestion: 'Check the operator’s timetable for the untimed legs before you fix the days around them.' });
  const backtracks = days.filter((d, i) => i > 0 && d.baseId !== days[i - 1]!.baseId && days.slice(0, i - 1).some((p) => p.baseId === d.baseId));
  if (backtracks.length > 0) findings.push({ topic: 'geography', severity: 'note', title: 'The route returns to a base it already left', detail: `Day${backtracks.length === 1 ? '' : 's'} ${backtracks.map((d) => d.dayNumber).join(', ')} go back to ${[...new Set(backtracks.map((d) => d.baseName))].join(', ')}.`, suggestion: 'That is fine for a loop that starts and ends at the airport; otherwise reorder the bases.', dayNumbers: backtracks.map((d) => d.dayNumber) });
  else findings.push({ topic: 'geography', severity: 'fine', title: 'The bases follow one direction of travel', detail: pkg?.routeRationale ?? 'No base is visited twice.' });

  // Your places ----------------------------------------------------------------------
  const userPlaces = input.userPlaces.map((name) => {
    const key = normalise(name);
    const anchor = (pkg?.anchors ?? []).find((a) => normalise(a.name) === key || normalise(a.name).includes(key) || key.includes(normalise(a.name)));
    const unscheduled = itinerary.unscheduled.find((u) => normalise(u.name) === key || normalise(u.name).includes(key));
    if (anchor && (anchor.disposition === 'preserved' || anchor.disposition === 'preserved_with_verified_facts' || anchor.disposition === 'retained_unverified')) return { name, outcome: 'kept' as const, detail: `On day ${anchor.scheduledDayNumber ?? anchor.dayNumber}${anchor.verification === 'verified' ? ', confirmed on the map' : ''}.` };
    if (anchor && (anchor.disposition === 'moved_same_day' || anchor.disposition === 'moved_other_day' || anchor.disposition === 'substituted')) return { name, outcome: 'moved' as const, detail: anchor.note ?? `Moved to day ${anchor.scheduledDayNumber ?? anchor.dayNumber} to make the route work.` };
    if (anchor || unscheduled) return { name, outcome: 'dropped' as const, detail: unscheduled?.reason ?? anchor?.note ?? 'Could not be scheduled as things stand.' };
    return { name, outcome: 'not_found' as const, detail: 'Sidequest could not match this name to anything on the plan.' };
  });
  const missing = userPlaces.filter((p) => p.outcome === 'dropped' || p.outcome === 'not_found');
  if (input.userPlaces.length > 0) {
    findings.push({ topic: 'must_do', severity: missing.length > 0 ? 'concern' : 'fine', title: missing.length > 0 ? `${missing.length} of your ${input.userPlaces.length} places ${missing.length === 1 ? 'is' : 'are'} not on the plan` : `All ${input.userPlaces.length} of your places are on the plan`, detail: missing.length > 0 ? missing.map((m) => `${m.name}: ${m.detail}`).join(' ') : userPlaces.map((p) => `${p.name} — ${p.detail}`).join(' '), ...(missing.length > 0 ? { suggestion: 'Add a night near the missing place, or trade it for the optional stop on the nearest day.' } : {}) });
    for (const m of userPlaces.filter((p) => p.outcome === 'moved')) move.push(`${m.name} — ${m.detail}`);
  }

  // Timing / bookings ----------------------------------------------------------------
  if (input.bookedConflicts.length > 0) findings.push({ topic: 'timing', severity: 'concern', title: `${input.bookedConflicts.length} conflict${input.bookedConflicts.length === 1 ? '' : 's'} with what you have booked`, detail: input.bookedConflicts.join(' '), suggestion: 'Sidequest kept your bookings fixed; move or drop the model stops named here.' });
  else findings.push({ topic: 'timing', severity: 'fine', title: 'Nothing collides with a booking', detail: 'Booked items are fixed and the plan fits around them.' });
  const bookFirst = input.bookings.filter((b) => b.priority === 'book_first' && b.status === 'open');
  if (bookFirst.length > 0) findings.push({ topic: 'bookings', severity: 'note', title: `${bookFirst.length} thing${bookFirst.length === 1 ? '' : 's'} to book before the plan is real`, detail: bookFirst.map((b) => b.title).join(', ') + '.', suggestion: 'See Book first.' });

  // Good --------------------------------------------------------------------------
  const verified = pkg?.verification.verified ?? 0;
  const total = pkg?.verification.anchors ?? 0;
  if (total > 0) {
    findings.push({ topic: 'good', severity: 'fine', title: `${verified} of ${total} stops confirmed as real places`, detail: `${pkg!.verification.legsMeasured} transfers measured on the road network. Nothing you asked for was dropped silently.` });
    for (const a of (pkg?.anchors ?? []).filter((x) => x.role === 'core' && x.verification === 'verified').slice(0, 4)) keep.push(`${a.name} (day ${a.scheduledDayNumber ?? a.dayNumber})`);
  }

  const concerns = findings.filter((f) => f.severity === 'concern').length;
  const verdict: PlanCritique['verdict'] = concerns === 0 ? 'works' : concerns <= 2 ? 'works_with_changes' : 'needs_rethink';
  return planCritiqueSchema.parse({
    verdict,
    headline: verdict === 'works' ? 'Your plan works as it stands.' : verdict === 'works_with_changes' ? `Your plan works with ${concerns === 1 ? 'one change' : `${concerns} changes`}.` : 'Your plan needs a rethink in a few places — the pieces are good.',
    findings: findings.map((f) => critiqueFindingSchema.parse({ dayNumbers: [], ...f })),
    move,
    cut,
    keep,
    userPlaces,
  });
}
