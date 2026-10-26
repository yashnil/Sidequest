'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { JourneyLeg } from '@/lib/journey/model';
import type { JourneyMapHandle } from './JourneyMap';
import { partialPath } from './JourneyMap';

/**
 * REPLAY MY DAY — the day, played back along what is actually known of it.
 *
 * A replay is a list of steps (start, leg, stop, leg, stop…, overview) and a
 * cursor. Entering a step moves the camera; a routed leg is *drawn* along the
 * provider's own polyline with the camera following its head; a leg with no
 * route shape is never animated as if it were travelled — the camera simply
 * moves to the next stop and the controls say "straight line, not the route".
 *
 * Under reduced motion nothing animates: the camera cuts, lines appear whole,
 * and nothing advances on its own — the traveller steps with Next.
 */
export type ReplayStep =
  | { kind: 'stop'; stopId: string; pinId: string; point: { lat: number; lng: number } }
  | { kind: 'leg'; legId: string; leg: JourneyLeg; point: { lat: number; lng: number } }
  | { kind: 'overview' };

const SPEEDS = [1, 2, 0.5] as const;

export function useReplay({ steps, handle, terrainOn, overview }: { steps: readonly ReplayStep[]; handle: RefObject<JourneyMapHandle | null>; terrainOn: boolean; overview: readonly { lat: number; lng: number }[] }) {
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(0);
  const speed = SPEEDS[speedIndex]!;
  const reducedMotion = useMemo(() => typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false), []);
  const frame = useRef(0);
  const timer = useRef(0);

  const step = active ? (steps[index] ?? null) : null;

  const clear = () => {
    cancelAnimationFrame(frame.current);
    window.clearTimeout(timer.current);
  };

  /* Entering a step: move the camera, draw the leg, schedule the next step. */
  useEffect(() => {
    if (!active || !step || !handle.current) return;
    clear();
    const map = handle.current;
    const pitch = terrainOn ? 60 : 0;
    let duration = 2200 / speed;
    if (step.kind === 'stop') {
      map.drawLeg(null, 0);
      map.flyTo(step.point, { zoom: 15.2, pitch, duration: 1500 / speed });
      duration = 2600 / speed;
    } else if (step.kind === 'leg') {
      const leg = step.leg;
      if (leg.shape === 'routed' && !leg.disconnected && !reducedMotion) {
        duration = Math.min(5200, 1800 + leg.coords.length * 6) / speed;
        const started = performance.now();
        map.flyTo({ lat: leg.coords[0]![1], lng: leg.coords[0]![0] }, { zoom: 13.6, pitch, duration: 0 });
        const tick = (now: number) => {
          const t = Math.min(1, (now - started) / (duration * 0.85));
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          map.drawLeg(leg, eased);
          const head = partialPath(leg.coords, eased).at(-1);
          if (head) map.follow({ lat: head[1], lng: head[0] });
          if (t < 1) frame.current = requestAnimationFrame(tick);
        };
        frame.current = requestAnimationFrame(tick);
      } else {
        /* Not a route we hold: no head travels along it. Frame the two ends and move on. */
        map.drawLeg(leg.shape === 'routed' ? leg : null, 1);
        const from = { lat: leg.coords[0]![1], lng: leg.coords[0]![0] };
        map.fit([from, step.point], { duration: 1300 / speed, ...(terrainOn ? { pitch } : {}) });
        duration = 1800 / speed;
      }
    } else {
      map.drawLeg(null, 0);
      map.fit(overview, { duration: 1600 / speed, pitch: terrainOn ? 45 : 0 });
    }
    if (playing && !reducedMotion && step.kind !== 'overview') {
      timer.current = window.setTimeout(() => setIndex((i) => Math.min(i + 1, steps.length - 1)), duration);
    } else if (step.kind === 'overview') {
      /* The day has been told: stop on the overview (deferred, so the effect never sets state synchronously). */
      timer.current = window.setTimeout(() => setPlaying(false), 0);
    }
    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, index, playing, speed, terrainOn]);

  /* A changed day (an edit, another day chosen) ends a replay rather than playing a stale route. */
  const signature = steps.map((s) => (s.kind === 'stop' ? s.stopId : s.kind === 'leg' ? s.legId : 'o')).join('|');
  const [seenSignature, setSeenSignature] = useState(signature);
  if (seenSignature !== signature) {
    setSeenSignature(signature);
    if (active) {
      setActive(false);
      setPlaying(false);
      setIndex(0);
    }
  }
  /* Whenever a replay ends, for whatever reason, its drawn leg goes with it. */
  useEffect(() => {
    if (active) return;
    clear();
    handle.current?.drawLeg(null, 0);
  }, [active, handle]);

  useEffect(() => clear, []);

  const revealedPins = useMemo(() => {
    const out = new Set<string>();
    steps.slice(0, active ? index + 1 : 0).forEach((s) => {
      if (s.kind === 'stop') out.add(s.pinId);
    });
    if (active && steps[index]?.kind === 'overview') steps.forEach((s) => s.kind === 'stop' && out.add(s.pinId));
    return out;
  }, [steps, index, active]);
  const revealedLegs = useMemo(() => {
    const out = new Set<string>();
    steps.slice(0, active ? index + 1 : 0).forEach((s) => {
      if (s.kind === 'leg') out.add(s.legId);
    });
    return out;
  }, [steps, index, active]);

  const start = useCallback(() => {
    setIndex(0);
    setActive(true);
    setPlaying(!reducedMotion);
  }, [reducedMotion]);
  const exit = useCallback(() => {
    clear();
    handle.current?.drawLeg(null, 0);
    setActive(false);
    setPlaying(false);
    if (overview.length > 0) handle.current?.fit(overview, { pitch: terrainOn ? 50 : 0 });
  }, [handle, overview, terrainOn]);

  return {
    active,
    playing,
    index,
    step,
    speed,
    reducedMotion,
    revealedPins,
    revealedLegs,
    start,
    exit,
    pause: () => {
      clear();
      setPlaying(false);
    },
    resume: () => {
      if (index >= steps.length - 1) setIndex(0);
      setPlaying(true);
    },
    next: () => setIndex((i) => Math.min(i + 1, steps.length - 1)),
    previous: () => setIndex((i) => Math.max(i - 1, 0)),
    cycleSpeed: () => setSpeedIndex((i) => (i + 1) % SPEEDS.length),
  };
}
