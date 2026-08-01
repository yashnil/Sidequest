/**
 * WHO WE SAY WE ARE.
 *
 * Every volunteer-run service this product depends on asks the same thing of a
 * client: identify yourself, and give a contact somebody can reach if you cause
 * a problem. Nominatim's usage policy makes it a requirement; Overpass expects
 * it; a well-behaved fetch of an operator's own page should carry it too.
 *
 * This exists because the placeholder we shipped was actively harmful. The
 * string ended `+https://sidequest.example`, and `.example` is a reserved TLD
 * that resolves nowhere — so it identified nobody and looked, to a filter, like
 * a bot pretending to have a homepage. A live evaluation caught the consequence
 * precisely: `overpass-api.de` returned **406 Not Acceptable** to every request
 * carrying it, and returned 200 to the identical query under any ordinary agent
 * string. Six selector groups of nothing, reported as "this destination has no
 * places in it".
 *
 * So: a real contact is configuration, not a constant. Set
 * `SIDEQUEST_CONTACT_URL` (or `SIDEQUEST_USER_AGENT` to take the whole string
 * over) before any deployment that will be seen by these services at volume.
 * Unset, we identify the product and version and claim nothing else — which is
 * honest, and which is what these services actually accept.
 */

const PRODUCT = 'Sidequest/0.1';

export function providerUserAgent(purpose = 'trip planning'): string {
  const override = process.env.SIDEQUEST_USER_AGENT?.trim();
  if (override) return ascii(override);

  const contact = process.env.SIDEQUEST_CONTACT_URL?.trim();
  if (!contact) return ascii(`${PRODUCT} (${purpose})`);

  /**
   * A contact is only appended when it is a real, reachable-looking URL or a
   * mailto. Appending whatever a variable happens to contain is how the
   * placeholder got shipped in the first place.
   */
  try {
    const url = new URL(contact);
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') {
      return ascii(`${PRODUCT} (${purpose}; +${url.toString()})`);
    }
  } catch {
    /* fall through */
  }
  return ascii(`${PRODUCT} (${purpose})`);
}

/**
 * Header values are latin-1. A curly apostrophe in the product's own copy is an
 * easy way to reach `ERR_INVALID_CHAR` from Node's HTTP client — which fails the
 * request before any of the SSRF checks run, and looks nothing like a header bug.
 */
function ascii(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '');
}
