import { describe, expect, it } from 'vitest';
import { roundedDuration, roundedMinuteOfDay, travellerVoice } from './plan-language';

/**
 * THE TEST THAT STOPS A REPHRASING FROM BECOMING A DELETION.
 *
 * `travellerVoice` exists to move a caveat out of the engineer's vocabulary and
 * into the traveller's. The failure mode it must never have is the easy one:
 * somebody decides the sentence reads badly and quietly drops the claim inside
 * it, and the plan starts presenting a modelled drive time as a measured one.
 *
 * So these assert on both halves — the provider vocabulary is gone, *and* the
 * claim it carried is still being made.
 */
describe('provider notices become traveller notices', () => {
  it('keeps "not measured" while dropping the instruction to swap providers', () => {
    const original =
      'Driving times are modelled. Modelled from an authored US-395 corridor-and-spur topology, ' +
      'not measured road data. Replace with a routing provider before relying on exact times. ' +
      "Service times come from the operators' published timetables on the dates recorded against " +
      'each one, and are not checked live.';
    const result = travellerVoice(original);

    // The engineer's instructions are gone.
    expect(result).not.toMatch(/routing provider/i);
    expect(result).not.toMatch(/topology/i);
    expect(result).not.toMatch(/US-395/);

    // The claims they carried are not.
    expect(result).toMatch(/not measured road data/i);
    expect(result).toMatch(/modelled/i);
    expect(result).toMatch(/close rather than exact/i);
    // And the sentence nothing needed to change is untouched.
    expect(result).toMatch(/are not checked live/);
  });

  it('keeps stand-in weather marked as neither a forecast nor an observation', () => {
    const result = travellerVoice(
      'Fixture weather. Not a forecast, and not observed data — for testing only.',
    );
    expect(result).not.toMatch(/fixture/i);
    expect(result).not.toMatch(/for testing only/i);
    expect(result).toMatch(/not a forecast/i);
    expect(result).toMatch(/not a real observation/i);
  });

  it('leaves a notice it has never seen exactly as written', () => {
    // Licence text is the case that matters: paraphrasing it is non-compliance,
    // so anything not in the table has to come back byte for byte.
    const licence = 'Weather data by Open-Meteo.com (CC BY 4.0)';
    expect(travellerVoice(licence)).toBe(licence);
  });
});

describe('displayed times round toward the side where being wrong is harmless', () => {
  it('rounds an arrival later, so it can never fall before an opening time', () => {
    expect(roundedMinuteOfDay(9 * 60 + 1, 'later')).toBe(9 * 60 + 5);
    expect(roundedMinuteOfDay(9 * 60, 'later')).toBe(9 * 60);
    expect(roundedMinuteOfDay(18 * 60 + 2, 'later')).toBe(18 * 60 + 5);
  });

  it('rounds a closing time earlier, so the stated window never widens', () => {
    expect(roundedMinuteOfDay(16 * 60 + 34, 'earlier')).toBe(16 * 60 + 30);
    expect(roundedMinuteOfDay(16 * 60 + 30, 'earlier')).toBe(16 * 60 + 30);
  });

  it('never rounds past the end of the day', () => {
    expect(roundedMinuteOfDay(1439, 'later')).toBe(1439);
    expect(roundedMinuteOfDay(-10, 'earlier')).toBe(0);
  });

  it('rounds a span down, so the plan never offers time it does not have', () => {
    expect(roundedDuration(258)).toBe(255);
    expect(roundedDuration(60)).toBe(60);
    // Under five minutes keeps its real value: "0 min free" would be a
    // different and wrong statement.
    expect(roundedDuration(3)).toBe(3);
  });
});
