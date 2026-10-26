import { describe, expect, it } from 'vitest';
import { advance, CHOSEN, HOW_STEPS, HOW_TOUR, STEP_SECONDS, STILL, stageAt, stagePins, straightLineKm, STAGE_H, STAGE_W, targetFor } from './how-sequence';

describe('the how-it-works sequence', () => {
  it('is complete standing still: the still frame shows every part at once', () => {
    expect(STILL.chars).toBe(HOW_TOUR.prompt.length);
    expect(STILL.question && STILL.answered && STILL.chosen && STILL.day).toBe(true);
    expect(STILL.pins).toBe(HOW_TOUR.stops.length);
    expect(STILL.route).toBe(1);
  });

  it('starts empty and only ever adds while reading forward', () => {
    const start = stageAt(0);
    expect(start.chars).toBe(0);
    expect(start.pins).toBe(0);
    expect(start.route).toBe(0);
    let last = stageAt(0);
    for (let i = 1; i <= 200; i++) {
      const frame = stageAt(i / 200);
      expect(frame.chars).toBeGreaterThanOrEqual(last.chars);
      expect(frame.pins).toBeGreaterThanOrEqual(last.pins);
      expect(frame.route).toBeGreaterThanOrEqual(last.route);
      expect(frame.step).toBeGreaterThanOrEqual(last.step);
      if (last.chosen) expect(frame.chosen).toBe(true);
      if (last.day) expect(frame.day).toBe(true);
      last = frame;
    }
  });

  it('reaches each step in order, one per caption', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 600; i++) seen.add(stageAt(i / 600).step);
    expect([...seen]).toEqual(HOW_STEPS.map((_, i) => i));
  });

  it('puts the example’s real towns the right way up inside the stage', () => {
    const pins = stagePins();
    const by = Object.fromEntries(pins.map((p) => [p.name, p]));
    expect(by['Reykjavík']!.x).toBeLessThan(by['Höfn']!.x);
    expect(by['Akureyri']!.y).toBeLessThan(by['Vík']!.y);
    for (const p of pins) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(STAGE_W);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(STAGE_H);
    }
  });

  it('never sets a town’s name on top of another town’s pin', () => {
    const pins = stagePins();
    const by = Object.fromEntries(pins.map((p) => [p.name, p]));
    /* Borgarnes sits just north of Reykjavík: its name goes above. */
    expect(by['Borgarnes']!.labelAbove).toBe(true);
    expect(by['Reykjavík']!.labelAbove).toBe(false);
  });

  it('leaves at least one candidate unchosen, and computes the one distance as a straight line', () => {
    expect(CHOSEN.length).toBeLessThan(HOW_TOUR.stops.length);
    const km = straightLineKm(HOW_TOUR.stops[1]!, HOW_TOUR.stops[2]!);
    expect(km).toBeGreaterThan(150);
    expect(km).toBeLessThan(260);
  });
});

describe('the sequence’s pacing', () => {
  it('targets the end of the step being read, and nothing before the first', () => {
    expect(targetFor(0)).toBe(0);
    expect(targetFor(0.01)).toBeCloseTo(1 / HOW_STEPS.length);
    expect(targetFor(0.5)).toBeCloseTo(4 / HOW_STEPS.length);
    expect(targetFor(1)).toBe(1);
  });

  it('types at a steady pace with the scroll standing still', () => {
    const target = targetFor(0.01);
    let shown = 0;
    let ticks = 0;
    let lastChars = 0;
    while (shown < target && ticks < 1000) {
      shown = advance(shown, target, 1 / 60);
      const chars = stageAt(shown).chars;
      expect(chars - lastChars).toBeLessThanOrEqual(1);
      lastChars = chars;
      ticks++;
    }
    expect(stageAt(shown).chars).toBe(HOW_TOUR.prompt.length);
    // A step plays in about STEP_SECONDS at 60 fps.
    expect(ticks).toBeGreaterThan(STEP_SECONDS * 60 * 0.9);
    expect(ticks).toBeLessThan(STEP_SECONDS * 60 * 1.1);
  });

  it('catches up after a fast scroll without ever overshooting', () => {
    let shown = 0;
    let ticks = 0;
    while (shown < 1 && ticks < 1000) {
      const next = advance(shown, 1, 1 / 60);
      expect(next).toBeLessThanOrEqual(1);
      expect(next).toBeGreaterThan(shown);
      shown = next;
      ticks++;
    }
    expect(ticks).toBeLessThan(STEP_SECONDS * 60 * 2 * 1.5);
  });
});
