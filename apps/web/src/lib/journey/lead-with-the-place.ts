/**
 * RELEASE PASS — A ROW SAYS WHAT THE PLACE IS, NOT HOW IT WAS SCORED.
 *
 * The fit sentence opens by restating the questionnaire — "You marked lakes &
 * rivers as "once or twice", and that is what this delivers: A deep blue lake
 * pinned against Laurel Mountain…". Where there is room for a line or two, the
 * whole of it went to the preamble, on every stop. Rows and the map's stop card
 * lead with the place; the full sentence, preference and all, is still what the
 * stop's own sheet says. Presentation only: the rationale is untouched.
 */
export function leadWithThePlaceOf(sentence: string | undefined): string | undefined {
  if (!sentence) return sentence;
  const match = /^You marked .{1,80}? as [“"][^”"]{1,60}[”"],? and that is what this delivers:\s*(.+)$/i.exec(sentence);
  const offer = match?.[1]?.trim();
  return offer && offer.length > 12 ? offer : sentence;
}
