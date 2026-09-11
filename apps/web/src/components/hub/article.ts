/**
 * V8 — THE ARTICLE BEFORE A NUMBER IS DECIDED BY HOW THE NUMBER IS SAID.
 *
 * The overview's thesis line is composed as "A {n}-day {destination} trip", and
 * for an eight-day trip that printed "A 8-day" on the founder's own plan. The
 * rule is pronunciation, not spelling: "eight", "eleven", "eighteen" and their
 * hundreds and thousands open on a vowel, so they take "an"; everything else
 * takes "a". Kept as a pure function with its own test so the next sentence
 * that puts a figure after an article can reuse it rather than guess.
 */
export function articleFor(n: number): 'a' | 'an' {
  const digits = String(Math.trunc(Math.abs(n)));
  if (digits.startsWith('8')) return 'an';
  /* "eleven", "eighteen" — and eleven thousand, eighteen million: the leading pair with whole groups of three after it. */
  if ((digits.startsWith('11') || digits.startsWith('18')) && (digits.length - 2) % 3 === 0) return 'an';
  return 'a';
}

/**
 * "A 8-day trip" → "An 8-day trip"; "an 5-day" → "a 5-day". Only a bare article
 * directly before a figure is touched; prose without a number is returned as it
 * came. Case follows the original article.
 */
export function fixNumberArticles(text: string): string {
  return text.replace(/\b([Aa]n?) (\d+)(?=[\s-])/g, (_whole: string, article: string, digits: string) => {
    const wanted = articleFor(Number(digits));
    const cased = article.charAt(0) === 'A' ? wanted.charAt(0).toUpperCase() + wanted.slice(1) : wanted;
    return `${cased} ${digits}`;
  });
}

/**
 * Whether two sentences say the same thing once case, whitespace, trailing
 * punctuation and the article before a figure are set aside — so a purpose
 * that reads "A 8-day…" and a headline corrected to "An 8-day…" count as one
 * sentence, and one page never prints it twice.
 */
export function sameSentence(a: string, b: string): boolean {
  const normalise = (text: string) =>
    fixNumberArticles(text)
      .toLowerCase()
      .replace(/[.!?…]+$/g, '')
      .replace(/[‘’'"]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  return normalise(a) === normalise(b);
}
