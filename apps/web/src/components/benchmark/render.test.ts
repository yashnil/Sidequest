import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { toBlindPlan } from '@sidequest/bench';
import {
  failedPlan,
  validBaselineShapedPlan,
  validSidequestShapedPlan,
} from '@sidequest/bench/testing';
import { NeutralPlanView } from './NeutralPlanView';
import { toNeutralPanel, type NeutralPanel, type PanelState } from './neutral-dto';

/**
 * THE SAME PLAN, IN EITHER PANEL, IS THE SAME MARKUP.
 *
 * The property the whole blind renderer rests on, asserted at the level it can
 * actually be broken at. Neutral wording is checked by the token scan; what that
 * scan cannot see is a component that renders one panel slightly differently
 * from the other — an extra wrapper, a section shown only when a field is
 * populated, a class that varies with the label. Any of those would be a rule a
 * reviewer could learn in one sitting without ever noticing they had.
 *
 * So: two panels, one plan, and the markup has to be byte-identical apart from
 * `data-plan-label`, which is the one attribute permitted to differ and exists
 * so the rating form can associate a score with a panel.
 *
 * The absent and failed cases are asserted the same way and matter more, not
 * less. A plan that failed renders a fixed sentence rather than anything the
 * system said about its own failure, because a per-system failure string is the
 * easiest leak in this design.
 */

const LABEL_ATTRIBUTE = /data-plan-label="[AB]"/g;

function panel(label: 'A' | 'B', state: PanelState, plan: NeutralPanel['plan']): NeutralPanel {
  return { label, state, plan };
}

function markup(value: NeutralPanel): string {
  return renderToStaticMarkup(createElement(NeutralPlanView, { panel: value }));
}

function withoutLabel(html: string): string {
  return html.replace(LABEL_ATTRIBUTE, 'data-plan-label="?"');
}

describe('the neutral plan renderer', () => {
  const plan = toBlindPlan(validSidequestShapedPlan);

  it('marks each panel, so the test below is not comparing two unmarked strings', () => {
    expect(markup(panel('A', 'succeeded', plan))).toContain('data-plan-label="A"');
    expect(markup(panel('B', 'succeeded', plan))).toContain('data-plan-label="B"');
  });

  it('renders one plan identically in either panel', () => {
    const a = markup(panel('A', 'succeeded', plan));
    const b = markup(panel('B', 'succeeded', plan));
    expect(a).not.toEqual(b);
    expect(withoutLabel(a)).toEqual(withoutLabel(b));
  });

  it('renders a plan that produced nothing identically in either panel', () => {
    const a = markup(panel('A', 'pending', null));
    const b = markup(panel('B', 'pending', null));
    expect(withoutLabel(a)).toEqual(withoutLabel(b));
  });

  it('renders a failure identically in either panel', () => {
    const failed = toBlindPlan(failedPlan);
    const a = markup(panel('A', 'failed', failed));
    const b = markup(panel('B', 'failed', failed));
    expect(withoutLabel(a)).toEqual(withoutLabel(b));
  });

  /**
   * Every section is present whether or not it has anything in it.
   *
   * A renderer that hid its empty sections would give one plan eleven headings
   * and the other nine, and the count alone would be a fingerprint. Asserted by
   * comparing the *set of sections* across a full plan, an empty one and a
   * failed one rather than by listing the names, so a section added later is
   * covered without anybody remembering to come back here.
   */
  it('shows the same sections for a full plan, an empty one and a failed one', () => {
    const sectionsIn = (html: string) => (html.match(/data-section="[a-z]+"/g) ?? []).join(',');
    const full = sectionsIn(markup(panel('A', 'succeeded', plan)));
    const empty = sectionsIn(markup(panel('A', 'pending', null)));
    const failed = sectionsIn(markup(panel('A', 'failed', toBlindPlan(failedPlan))));

    expect(full.length).toBeGreaterThan(0);
    expect(empty).toEqual(full);
    expect(failed).toEqual(full);
  });

  /**
   * Two plans that describe the same trip in two different idioms are still two
   * different plans, and this renderer does not paper over that.
   *
   * The fixture pair differs in prose, in which optional fields are populated
   * and in array order, and none of that is engineered away here — those are
   * real differences between the two systems and hiding them would be falsifying
   * the thing under comparison. What must match is the frame: same elements,
   * same sections, same order.
   */
  it('keeps the frame identical even when the two plans genuinely differ', () => {
    const one = markup(panel('A', 'succeeded', toBlindPlan(validSidequestShapedPlan)));
    const two = markup(panel('A', 'succeeded', toBlindPlan(validBaselineShapedPlan)));
    expect(one).not.toEqual(two);

    const frameOf = (html: string) => (html.match(/data-(section|field)="[a-z-]+"/g) ?? []).join(',');
    expect(frameOf(two)).toEqual(frameOf(one));
  });

  /**
   * And the projection itself: a stored panel carries a version count and a
   * state, and what comes back is a plan with no producing system on it. The
   * type already guarantees that; this checks the redaction did not lose it.
   */
  it('projects a stored panel without carrying anything identifying', () => {
    const projected = toNeutralPanel({
      label: 'A',
      plan: toBlindPlan(validSidequestShapedPlan),
      version: 2,
      versionCount: 3,
      state: 'succeeded',
    });
    expect(JSON.stringify(projected).toLowerCase()).not.toContain('producedby');
  });

  /**
   * THE VERSION COUNT DOES NOT SURVIVE THE PROJECTION.
   *
   * A per-panel "2 / 3" is a fact about one arm, and one arm producing a revised
   * plan while the other does not labels the two columns for the rest of the
   * sitting. Dropped rather than merely unrendered, because a value handed to a
   * client component travels in the page payload whether or not any element
   * reads it — so the assertion is over the serialised projection, which is what
   * the browser would actually receive.
   */
  it('carries no per-panel version count across the boundary', () => {
    const projected = toNeutralPanel({
      label: 'A',
      plan: toBlindPlan(validSidequestShapedPlan),
      version: 2,
      versionCount: 3,
      state: 'succeeded',
    });
    const serialised = JSON.stringify(projected);
    expect(serialised).not.toContain('versionCount');
    expect(serialised).not.toContain('"version"');
    expect(markup(projected)).not.toContain('2 / 3');
  });

  /**
   * AND THE EMPTY LIST IS THE SAME COLOUR AS A FULL ONE.
   *
   * The empty case used to be greyed, which sounds like a kindness and is a
   * whole-page tell: a plan that states fewer of its sources, exclusions and
   * warnings than the other reads as a wash of grey beside a column of black,
   * and no token scan can see a colour. Asserted by comparing the *class* the
   * list is drawn with across a full plan and an empty one, so the property
   * survives a later restyle rather than being pinned to one utility name.
   */
  it('draws an empty list in the same colour as a populated one', () => {
    const classesOf = (html: string) =>
      (html.match(/class="grid gap-1\.5 text-sm[^"]*"/g) ?? []).join(',');
    const full = classesOf(markup(panel('A', 'succeeded', plan)));
    const empty = classesOf(markup(panel('A', 'pending', null)));

    expect(full.length).toBeGreaterThan(0);
    expect(new Set(empty.split(','))).toEqual(new Set(full.split(',')));
  });
});
