import { describe, expect, it } from 'vitest';
import { tripProgress, type TripProgressFacts } from './trip-progress';

/**
 * THE DEFECT WAS A TERNARY OVER A FOUR-VALUE COLUMN.
 *
 * `trip.status === 'draft' ? 'Not finished' : 'Discovery board ready'` — so a
 * trip whose build died mid-compile was announced on the homepage as a finished
 * discovery board, and the only trip in the database with an actual plan was
 * announced identically to one that had never been researched.
 *
 * Every case below is a row that existed in the live database when this was
 * written.
 */
const base: TripProgressFacts = {
  status: 'draft',
  jobState: null,
  jobLive: false,
  hasCompiledRegion: false,
  hasItinerary: false,
};

describe('a trip is labelled by what has actually happened to it', () => {
  it('does not call a mid-compile trip a finished board', () => {
    const progress = tripProgress({
      ...base,
      status: 'discovering',
      jobState: 'running',
      jobLive: true,
    });
    expect(progress.state).toBe('building');
    expect(progress.label).toBe('Building now');
    expect(progress.path('t1')).toBe('/trips/t1/plan');
  });

  it('does not call a dead build a live one', () => {
    // The exact live row: state `running`, heartbeat eight days cold.
    const progress = tripProgress({ ...base, jobState: 'running', jobLive: false });
    expect(progress.state).toBe('build_failed');
    expect(progress.label).not.toMatch(/Building/);
    expect(progress.action).toBe('Pick it up again');
  });

  it('surfaces a finished plan above everything except a live build', () => {
    const planned = tripProgress({ ...base, status: 'planned', hasItinerary: true });
    expect(planned.state).toBe('plan_ready');
    expect(planned.path('t1')).toBe('/trips/t1/itinerary');

    const nothing = tripProgress(base);
    expect(planned.rank).toBeLessThan(nothing.rank);

    const building = tripProgress({ ...base, jobState: 'running', jobLive: true });
    expect(building.rank).toBeLessThan(planned.rank);
  });

  it('sends a researched trip with no answers to the questions, not the board', () => {
    // The failure this replaced: the board route redirects to the questionnaire
    // when there is no profile, so the label promised a board and the link
    // bounced. The label and the destination now come from one decision.
    const progress = tripProgress({ ...base, status: 'draft', hasCompiledRegion: true });
    expect(progress.state).toBe('needs_answers');
    expect(progress.path('t1')).toBe('/trips/t1/questionnaire');
  });

  it('sends a researched trip with answers to the board', () => {
    const progress = tripProgress({
      ...base,
      status: 'discovering',
      hasCompiledRegion: true,
      jobState: 'partial',
    });
    expect(progress.state).toBe('board_ready');
    expect(progress.path('t1')).toBe('/trips/t1/discover');
  });

  it('tells a build somebody stopped apart from one that broke', () => {
    expect(tripProgress({ ...base, jobState: 'cancelled' }).label).toBe('You stopped this');
    expect(tripProgress({ ...base, jobState: 'failed' }).label).toBe('Research stopped');
  });

  it('never says a trip nobody has researched is ready for anything', () => {
    const progress = tripProgress(base);
    expect(progress.state).toBe('not_started');
    expect(progress.label).not.toMatch(/ready|found/i);
  });
});
