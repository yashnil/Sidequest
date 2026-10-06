/** A must-do the traveller typed, matched to board places by name: whole-word containment either way, never a fuzzy guess. */
export function matchNamedMustDos(mustDos: readonly string[], places: readonly { id: string; name: string }[]): string[] {
  const norm = (text: string) => ` ${text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const matched = new Set<string>();
  for (const raw of mustDos) {
    const want = norm(raw);
    if (want.trim().length < 4) continue;
    // One generic word ("Arch") is not a place; a single word must be a place's whole name.
    const singleWord = want.trim().split(' ').length === 1;
    for (const place of places) {
      const have = norm(place.name);
      if (singleWord ? have === want : have.includes(want) || want.includes(have)) matched.add(place.id);
    }
  }
  return [...matched];
}
