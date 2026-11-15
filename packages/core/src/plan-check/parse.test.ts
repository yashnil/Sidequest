import { describe, expect, it } from 'vitest';
import { parsePlanText } from './parse';

const NOW = new Date('2026-11-14T12:00:00Z');
const read = (text: string) => parsePlanText(text, NOW);
const shape = (text: string) => read(text).stops.map((s) => [s.label, s.nights, s.nightsBasis] as const);

describe('parsePlanText — a sentence with a length', () => {
  it('reads a list "in N days" as the trip length, keeps the question, spreads nights and says so', () => {
    const plan = read("I'm thinking Tokyo, Kyoto, Osaka, and Hokkaido in 10 days. Is that too much?");
    expect(plan.stops.map((s) => s.label)).toEqual(['Tokyo', 'Kyoto', 'Osaka', 'Hokkaido']);
    expect(plan.totalNights).toBe(9);
    expect(plan.totalBasis).toBe('days');
    expect(plan.question).toBe('Is that too much?');
    expect(plan.stops.every((s) => s.nightsBasis === 'spread')).toBe(true);
    expect(plan.stops.reduce((n, s) => n + (s.nights ?? 0), 0)).toBe(9);
  });

  it('reads weeks and "N-day trip"', () => {
    expect(read('two weeks: Lisbon, Porto').totalNights).toBe(13);
    expect(read('a 7-day trip: Lisbon then Porto').totalNights).toBe(6);
    expect(read('Lisbon, Porto, 5 nights total').totalNights).toBe(5);
  });

  it('reads a leading "10 days in <country>:" as the length and the country as context', () => {
    const plan = read('10 days in Japan: Tokyo, Kyoto, Osaka');
    expect(plan.totalNights).toBe(9);
    expect(plan.contextCountries).toEqual(['JP']);
    expect(plan.stops.map((s) => s.countryCode)).toEqual(['JP', 'JP', 'JP']);
  });

  it('treats a country beside cities as context, never as a stop', () => {
    const plan = read('Rome, Florence and Venice, Italy');
    expect(plan.stops.map((s) => s.label)).toEqual(['Rome', 'Florence', 'Venice']);
    expect(plan.contextCountries).toEqual(['IT']);
  });

  it('keeps a list of countries as the stops', () => {
    expect(read('Kenya and Tanzania in 12 days').stops.map((s) => s.label)).toEqual(['Kenya', 'Tanzania']);
  });
});

describe('parsePlanText — nights per place', () => {
  it('reads "N nights X" with words and digits', () => {
    expect(shape('3 nights Tokyo, two nights Kyoto, 1 night in Osaka')).toEqual([
      ['Tokyo', 3, 'stated'],
      ['Kyoto', 2, 'stated'],
      ['Osaka', 1, 'stated'],
    ]);
    expect(read('3 nights Tokyo, 2 nights Kyoto').totalBasis).toBe('sum_of_stops');
  });

  it('reads "X (N)", "X - N nights", "X for N nights" and arrows', () => {
    expect(shape('Lisbon (3) → Porto (2 nights) → Douro Valley - 2 nights')).toEqual([
      ['Lisbon', 3, 'stated'],
      ['Porto', 2, 'stated'],
      ['Douro Valley', 2, 'stated'],
    ]);
    expect(shape('Tokyo - 4 nights\nKyoto for 3 nights\nOsaka x2')).toEqual([
      ['Tokyo', 4, 'stated'],
      ['Kyoto', 3, 'stated'],
      ['Osaka', 2, 'stated'],
    ]);
  });

  it('marks per-place days as read from days', () => {
    expect(shape('3 days in Kyoto, 2 days Osaka')[0]).toEqual(['Kyoto', 3, 'days_stated']);
  });

  it('spreads only the nights left over, and only over the places without nights', () => {
    const plan = read('Tokyo 4 nights, Kyoto, Osaka in 9 nights total');
    expect(plan.totalNights).toBe(9);
    expect(shape('Tokyo 4 nights, Kyoto, Osaka, 9 nights total')).toEqual([
      ['Tokyo', 4, 'stated'],
      ['Kyoto', 3, 'spread'],
      ['Osaka', 2, 'spread'],
    ]);
  });

  it('says when the nights given do not add up to the trip', () => {
    const plan = read('April 2-12: 3 nights Rome, 3 nights Florence');
    expect(plan.totalNights).toBe(10);
    expect(plan.notes.join(' ')).toMatch(/add up to 6 nights, but the trip is 10 nights/);
  });

  it('reads a day trip as a stop with no bed of its own', () => {
    const plan = read('Inverness 3 nights, Fort William 2 nights, day trip to Glencoe');
    const glencoe = plan.stops.find((s) => s.label === 'Glencoe')!;
    expect(glencoe.dayTrip).toBe(true);
    expect(glencoe.nights).toBe(0);
    expect(plan.totalNights).toBe(5);
  });

  it('merges the same place twice in a row into one stay', () => {
    expect(shape('Tokyo 2 nights, Tokyo 1 night, Kyoto 2 nights')).toEqual([
      ['Tokyo', 3, 'stated'],
      ['Kyoto', 2, 'stated'],
    ]);
  });
});

describe('parsePlanText — a day-by-day list', () => {
  it('counts the place slept in each day, takes the destination of a move day, and drops activities after a dash', () => {
    const plan = read('Day 1-3: Tokyo\nDay 4: Tokyo to Kyoto\nDay 5: Kyoto - Fushimi Inari\nDay 6: Osaka\nDay 7-10: Sapporo');
    expect(plan.format).toBe('day_list');
    expect(shape('Day 1-3: Tokyo\nDay 4: Tokyo to Kyoto\nDay 5: Kyoto - Fushimi Inari\nDay 6: Osaka\nDay 7-10: Sapporo')).toEqual([
      ['Tokyo', 3, 'day_list'],
      ['Kyoto', 2, 'day_list'],
      ['Osaka', 1, 'day_list'],
      ['Sapporo', 3, 'day_list'],
    ]);
    expect(plan.totalNights).toBe(9);
    expect(plan.totalBasis).toBe('day_list');
  });
});

describe('parsePlanText — dates', () => {
  it('reads ISO ranges and month-name ranges, choosing the next occurrence when no year is given', () => {
    expect(read('Lisbon, Porto from 2027-05-01 to 2027-05-08')).toMatchObject({ startDate: '2027-05-01', endDate: '2027-05-08', totalNights: 7, totalBasis: 'dates' });
    expect(read('Rome and Florence, April 2-12')).toMatchObject({ startDate: '2027-04-02', endDate: '2027-04-12', totalNights: 10 });
    expect(read('Rome and Florence, 28 April – 6 May 2027')).toMatchObject({ startDate: '2027-04-28', endDate: '2027-05-06', totalNights: 8 });
  });

  it('keeps a month named without dates as a month', () => {
    expect(read('Tokyo and Kyoto in April, 8 days')).toMatchObject({ month: 4, startDate: null });
  });
});

describe('parsePlanText — nothing invented', () => {
  it('leaves nights unknown when nobody said anything about length', () => {
    const plan = read('Lisbon, Porto, Douro Valley');
    expect(plan.totalNights).toBeNull();
    expect(plan.stops.every((s) => s.nights === null && s.nightsBasis === null)).toBe(true);
  });

  it('returns no stops for text with no places', () => {
    expect(read('???').stops).toEqual([]);
  });

  it('classifies a landscape by the intent graph, not by name', () => {
    expect(read('Lisbon, Douro Valley').stops[1]!.kind).toBe('natural_region');
  });
});

describe('parsePlanText — what a stated itinerary carries', () => {
  it('keeps "3 nights in Kyoto" as stated, marks a booked stay fixed and reads the way in', () => {
    const plan = read('4 nights Tokyo, 3 nights in Kyoto (booked) by train');
    expect(plan.stops.map((s) => [s.label, s.nights, s.nightsBasis])).toEqual([
      ['Tokyo', 4, 'stated'],
      ['Kyoto', 3, 'stated'],
    ]);
    expect(plan.stops[1]!.fixed).toBe(true);
    expect(plan.stops[1]!.transportIn).toBe('rail');
    expect(plan.totalNights).toBe(7);
  });

  it('reads must-sees in brackets and on a day list, and arrival and departure', () => {
    const list = read('Fly into Rome at 3pm. 3 nights in Rome (Colosseum, Vatican Museums), 2 nights Florence by train, fly home from Florence');
    expect(list.stops.map((s) => [s.label, s.nights])).toEqual([
      ['Rome', 3],
      ['Florence', 2],
    ]);
    expect(list.stops[0]!.mustSee).toEqual(['Colosseum', 'Vatican Museums']);
    expect(list.arrival).toEqual({ place: 'Rome', time: '15:00' });
    expect(list.departure?.place).toBe('Florence');
    const days = read('Day 1-3: Rome - Colosseum, Pantheon\nDay 4: Rome to Florence\nDay 5: Florence');
    expect(days.stops[0]!.mustSee).toEqual(['Colosseum', 'Pantheon']);
  });

  it('reads per-stop date ranges as the stays and the trip', () => {
    const plan = read('Tokyo Apr 1-4, Kyoto Apr 4-7');
    expect(plan.stops.map((s) => [s.label, s.nights, s.dates?.start])).toEqual([
      ['Tokyo', 3, '2027-04-01'],
      ['Kyoto', 3, '2027-04-04'],
    ]);
    expect(plan.startDate).toBe('2027-04-01');
    expect(plan.endDate).toBe('2027-04-07');
  });

  it('reads who is going and never takes it for a place', () => {
    const family = read('Lisbon, Porto for my family of four in 8 days');
    expect(family.stops.map((s) => s.label)).toEqual(['Lisbon', 'Porto']);
    expect(family.party).toMatchObject({ adults: 2, children: 2, complete: true });
    expect(read('Solo: Lisbon and Porto in 6 days').party).toMatchObject({ adults: 1 });
    expect(read('Lisbon and Porto in 6 days').party).toBeNull();
    const couple = read('June 10-15: 3 nights in Rome, 2 nights in Florence by train, for the two of us');
    expect(couple.stops.map((s) => [s.label, s.nights])).toEqual([
      ['Rome', 3],
      ['Florence', 2],
    ]);
    expect(couple.party).toMatchObject({ adults: 2 });
  });

  it('says how much of the plan it understood', () => {
    expect(read('3 nights Lisbon, 2 nights Porto').confidence).toBeGreaterThan(read('Lisbon, Porto in 5 days').confidence);
  });
});
