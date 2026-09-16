import { describe, expect, it } from 'vitest';
import { DRAFT_TRANSPORT_MODES, TRAVEL_MODES, travelModeFromDraft } from '@sidequest/core';
import { DRAFT_TRANSPORTS } from './trip-draft';

/**
 * V12.1 §2 — THE ONE MAPPING A COMPILER CANNOT CHECK.
 *
 * `core` may not import from the web app, so `DRAFT_TRANSPORT_MODES` is keyed by
 * string rather than by `DraftTransport`. That is the right dependency direction
 * and it means a value added to `DRAFT_TRANSPORTS` compiles perfectly while
 * mapping, at runtime, to `unknown` — which is exactly the silent fall-through
 * §2 exists to forbid.
 *
 * This test is the join. It runs in the web app, where both are importable, and
 * it fails the moment the model is given a word nothing downstream understands.
 */
describe('the draft transport vocabulary', () => {
  it('has a way-of-moving for every word the model may write', () => {
    for (const draft of DRAFT_TRANSPORTS) {
      expect(DRAFT_TRANSPORT_MODES, `the draft may say "${draft}" and the mobility vocabulary does not map it`).toHaveProperty(draft);
    }
  });

  it('never lets a stated transport fall through to unknown', () => {
    for (const draft of DRAFT_TRANSPORTS) {
      if (draft === 'unknown') continue;
      expect(travelModeFromDraft(draft), `"${draft}" maps to unknown, which loses what the model said`).not.toBe('unknown');
    }
  });

  it('maps only into the shared vocabulary', () => {
    for (const mapped of Object.values(DRAFT_TRANSPORT_MODES)) {
      expect(TRAVEL_MODES).toContain(mapped);
    }
  });
});
