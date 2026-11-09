#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
/**
 * Atlas build, stage 01 — English Wikivoyage → structured NDJSON.
 *
 *   node packages/atlas/build/01-wikivoyage.mjs
 *
 * Reads (under `$ATLAS_CACHE`, default `.atlas-cache`):
 *   raw/wikivoyage/enwikivoyage-latest-pages-articles.xml.bz2   MediaWiki XML export
 *   raw/wikivoyage/enwikivoyage-latest-page_props.sql.gz        page id → Wikidata item
 *
 * Writes:
 *   work/wikivoyage.ndjson            one object per main-namespace article
 *   work/wikivoyage-redirects.ndjson  {"from","to"[,"anchor"]} per main-namespace redirect
 *   work/wikivoyage-stats.json        counts, and the evidence the type/status mapping rests on
 *
 * How it works
 * ------------
 * `bzcat` decompresses to a pipe; the script cuts the stream on `</page>` and
 * handles one page at a time, so memory stays flat however large the dump is.
 * No XML parser is needed: the export is line-regular and the only fields read
 * are `<title>`, `<ns>`, the page `<id>`, `<redirect title>` and `<text>`.
 *
 * Every article is parsed inside a try/catch. A page that throws is counted in
 * the stats and skipped — one malformed article never stops the run.
 *
 * What a Wikivoyage article tells us (all established by counting the dump,
 * see `STATUS` below, never assumed):
 *   - its last status template, `{{<status><type>}}` — `{{usablecity}}`,
 *     `{{outlineregion}}`, `{{guidepark}}` — gives both type and status;
 *   - `{{IsPartOf|X}}` gives the parent in the geographic hierarchy;
 *   - `{{geo|lat|long|zoom=N}}` gives a coordinate, with `{{mapframe|lat|long}}`
 *     as a weaker fallback (it is a map viewport centre, not a place);
 *   - level-2 headings follow a fixed vocabulary (Understand, See, Do, …).
 *
 * The dump is untrusted data: nothing in it is executed, evaluated or used as
 * a path.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  LISTING_TEMPLATES,
  articleLinkTargets,
  clip,
  countWikilinks,
  decodeXmlEntities,
  firstSentence,
  normaliseTitle,
  parseTemplate,
  scanTemplates,
  splitSections,
  stripComments,
  toArticleTitle,
  toPlainText,
} from './lib/wikitext.mjs';

/* ------------------------------------------------------------------------ */
/* Type and status                                                           */
/* ------------------------------------------------------------------------ */

/**
 * `{{<status><type>}}`. Measured on the dump (frequencies in the stats file
 * under `statusTemplates`):
 *
 *   - names are one word — no `{{outline city}}` or `{{outline_city}}` occurs;
 *   - `useable…` (20 pages) and `informative…` (~75 pages) are redirects to
 *     the `usable…` templates, so both mean `usable`;
 *   - `{{stub}}` and a bare `{{outline}}` carry a status and no type;
 *   - `…station` exists (9 pages, experimental) and has no place in the atlas
 *     vocabulary: it is kept as type `other` with its status;
 *   - `{{starnomination}}` is a banner, not a status.
 */
const STATUS = /^(stub|outline|usable|useable|guide|star|informative)([a-z]*)$/;
const STATUS_ALIAS = { useable: 'usable', informative: 'usable' };
const NOT_A_STATUS = new Set(['starnomination']);

/**
 * `continentalsection` is in the output vocabulary but has no template: the
 * sections of a continent ("Central Asia", "Caribbean") are tagged
 * `…region`. It is derived after the pass — see `main`.
 */
const TYPES = new Set([
  'country', 'region', 'city', 'park', 'ruralarea', 'district', 'itinerary', 'diveguide', 'airport',
  'continent', 'continentalsection', 'topic', 'phrasebook', 'event',
]);
const DISAMBIGUATION = new Set(['disamb', 'disambig', 'disambiguation', 'dab']);
/** Templates that mark a page as deliberately not a destination article. */
const OTHER_MARKERS = new Set(['title-index page', 'historical', 'gallerypageof', 'joke']);

/**
 * Decide type and status from the template names of an article, in document
 * order. Precedence: the last `<status><type>` template, then a
 * disambiguation tag, then `{{extraregion}}`, then the "not an article"
 * markers; a page with none of them is `other` with no status.
 */
export function classify(names) {
  let typed = null;
  let disambiguation = null;
  let extraregion = false;
  let marker = null;
  for (const name of names) {
    if (DISAMBIGUATION.has(name)) disambiguation = name;
    else if (name === 'extraregion') extraregion = true;
    else if (OTHER_MARKERS.has(name)) marker = name;
    else if (!NOT_A_STATUS.has(name)) {
      const m = STATUS.exec(name);
      if (m) typed = { name, status: STATUS_ALIAS[m[1]] ?? m[1], suffix: m[2] };
    }
  }
  if (typed) {
    const known = TYPES.has(typed.suffix);
    return {
      type: known ? typed.suffix : 'other',
      status: typed.status,
      template: typed.name,
      reason: known ? null : typed.suffix ? `unknown type "${typed.suffix}"` : 'status without a type',
    };
  }
  if (disambiguation) return { type: 'disambiguation', status: null, template: disambiguation, reason: null };
  if (extraregion) return { type: 'extraregion', status: null, template: 'extraregion', reason: null };
  if (marker) return { type: 'other', status: null, template: marker, reason: `marked {{${marker}}}` };
  return { type: 'other', status: null, template: null, reason: 'no status template' };
}

/* ------------------------------------------------------------------------ */
/* Sections                                                                  */
/* ------------------------------------------------------------------------ */

const SECTION_CAPS = {
  understand: 6000, see: 8000, do: 8000, eat: 2500, drink: 1500, buy: 1500, sleep: 1500,
  getin: 3000, getaround: 2500, staysafe: 2000, climate: 2000, body: 8000,
};
const SECTION_ORDER = Object.keys(SECTION_CAPS);

/** Level-2 sections that are neither evidence nor body. */
const NOT_BODY = new Set(['go next', 'connect', 'cope', 'respect', 'talk', 'learn', 'work']);
const ACTIVITY_WORDS = ['see', 'do', 'eat', 'drink', 'buy', 'sleep'];

/**
 * Which output key a level-2 heading feeds; `null` drops the section.
 *
 * Combined headings are common ("See and do" 558 pages, "Eat and drink" 813,
 * "Buy, eat and drink" 87). They go to ONE key, the first of see › do › eat ›
 * drink › buy › sleep that the heading names — duplicating the text under
 * each would double-count every keyword in it. "Stay healthy" (altitude,
 * water, malaria) is folded into `staysafe`.
 */
export function sectionKey(title) {
  const t = title.toLowerCase().replace(/\s+/g, ' ').trim();
  if (NOT_BODY.has(t)) return null;
  if (/^understand\b/.test(t)) return 'understand';
  if (/^get in\b/.test(t)) return 'getin';
  if (/^get around\b/.test(t)) return 'getaround';
  if (/^stay (safe|healthy)\b/.test(t)) return 'staysafe';
  if (/^climate\b/.test(t)) return 'climate';
  const words = t.split(/[\s,&/]+/).filter((w) => w && w !== 'and');
  if (words.length > 0 && words.every((w) => ACTIVITY_WORDS.includes(w))) {
    return ACTIVITY_WORDS.find((w) => words.includes(w)) ?? 'body';
  }
  return 'body';
}

/** Level-2 headings under which a page lists its notable children. */
const OTHER_HEADING = /^other destinations\b/i;
const CITY_HEADING = /^(cities|towns|villages|settlements|municipalities|communities|hamlets|localities)\b/i;
const REGION_HEADING =
  /^(regions?|subregions|countries|states|provinces|islands|island groups|counties|departments|prefectures|territories|districts|cantons|atolls|emirates|governorates|oblasts)\b/i;

/* ------------------------------------------------------------------------ */
/* Small readers                                                             */
/* ------------------------------------------------------------------------ */

function parseCoordinate(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim().replace(/−/g, '-');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A usable coordinate pair, or null. `0, 0` is an unfilled placeholder. */
function point(latRaw, lngRaw) {
  const lat = parseCoordinate(latRaw);
  const lng = parseCoordinate(lngRaw);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

function parseZoom(value) {
  return typeof value === 'string' && /^\d{1,2}$/.test(value.trim()) ? Number(value.trim()) : null;
}

const QID = /^Q[1-9]\d*$/;
const asQid = (value) => (typeof value === 'string' && QID.test(value.trim()) ? value.trim() : null);

/**
 * `{{geo|lat|long|zoom=N}}` first; `{{mapframe|lat|long|zoom=N}}` only when
 * no geo template gives a usable pair (320 articles, mostly extraregions and
 * itineraries). `source` says which, because a mapframe centre is where the
 * map happens to be framed.
 */
function readGeo(templates) {
  for (const source of ['geo', 'mapframe']) {
    for (const t of templates) {
      if (t.name !== source) continue;
      const p = parseTemplate(t.inner);
      const at = point(p.positional[0] || p.named.lat, p.positional[1] || p.named.long || p.named.lon);
      if (at) return { lat: at.lat, lng: at.lng, zoom: parseZoom(p.named.zoom), source };
    }
  }
  return null;
}

/** First unnamed parameter of the last `{{name|X}}`, as an article title. */
function lastTemplateTitle(templates, name) {
  for (let k = templates.length - 1; k >= 0; k--) {
    if (templates[k].name !== name) continue;
    const title = normaliseTitle(toPlainText(parseTemplate(templates[k].inner).positional[0] ?? ''));
    if (title) return title;
  }
  return null;
}

const TAIL_GAP = /^(?:\s|\[\[\s*[a-z-]{2,12}\s*:[^\]]*\]\]|__[A-Z]+__)*$/i;

/**
 * The run of top-level templates at the very end of the article — nothing
 * between them and the end but whitespace and categories. Last first. This is
 * where status templates live, so its frequency table is how an unrecognised
 * one gets noticed.
 */
function trailingTemplates(text, templates) {
  const names = [];
  let cursor = text.length;
  for (let k = templates.length - 1; k >= 0 && names.length < 12; k--) {
    const t = templates[k];
    if (t.depth !== 0 || t.end > cursor) continue;
    if (!TAIL_GAP.test(text.slice(t.end, cursor))) break;
    names.push(t.name);
    cursor = t.start;
  }
  return names;
}

function unique(values, limit = Infinity) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Listings                                                                  */
/* ------------------------------------------------------------------------ */

const LISTING_BUCKETS = ['see', 'do', 'eat', 'drink', 'sleep', 'buy', 'go', 'other'];
/** `{{listing|type=…}}` values that mean one of the named buckets. */
const LISTING_TYPE_BUCKET = {
  see: 'see', do: 'do', eat: 'eat', drink: 'drink', sleep: 'sleep', buy: 'buy', go: 'go',
  restaurant: 'eat', hotel: 'sleep', stay: 'sleep',
};
/** Pre-2013 XML-style listings, `<see name="…">`. Four survive in the whole dump. */
const LEGACY_LISTING = /<(see|do|eat|drink|sleep|buy|listing)\s[^<>]*\bname\s*=/gi;
const TOP_LIMIT = 15;

function readListings(text, templates) {
  const counts = Object.fromEntries(LISTING_BUCKETS.map((b) => [b, 0]));
  const top = { see: [], do: [] };
  for (const t of templates) {
    if (!LISTING_TEMPLATES.has(t.name)) continue;
    let bucket = t.name;
    let parsed = null;
    if (t.name === 'listing') {
      parsed = parseTemplate(t.inner);
      bucket = LISTING_TYPE_BUCKET[(parsed.named.type ?? '').toLowerCase()] ?? 'other';
    }
    counts[bucket]++;
    if ((bucket === 'see' || bucket === 'do') && top[bucket].length < TOP_LIMIT) {
      parsed ??= parseTemplate(t.inner);
      const name = clip(toPlainText(parsed.named.name ?? ''), 120);
      if (!name) continue;
      const at = point(parsed.named.lat, parsed.named.long);
      top[bucket].push({ name, lat: at?.lat ?? null, lng: at?.lng ?? null, wikidata: asQid(parsed.named.wikidata) });
    }
  }
  if (text.indexOf('<') >= 0) {
    LEGACY_LISTING.lastIndex = 0;
    let m;
    while ((m = LEGACY_LISTING.exec(text))) {
      const tag = m[1].toLowerCase();
      counts[tag === 'listing' ? 'other' : tag]++;
    }
  }
  return { counts, top };
}

/* ------------------------------------------------------------------------ */
/* What a page lists as its children                                         */
/* ------------------------------------------------------------------------ */

const MARKER_LIKE = new Set(['marker', 'mapgroup-item']);
const BULLET = /^[ \t]*[*#]+[ \t]*/gm;

const FIRST_LINK = /\[\[([^[\]|\n]+)/;

/**
 * A wikilink as a child reference. `anchor` matters: `[[Naryn Region#See|Tash
 * Rabat]]` is not the Naryn Region article listed as a destination, it is a
 * sight that has no article of its own and lives in a section of that one.
 */
function childFromLink(rawTarget, name) {
  const title = toArticleTitle(rawTarget);
  if (!title) return null;
  const hash = rawTarget.indexOf('#');
  const anchor = hash < 0 ? null : rawTarget.slice(hash + 1).replace(/_/g, ' ').trim() || null;
  return { name: name || title, title, linked: true, anchor, wikidata: null, lat: null, lng: null };
}

/**
 * A marker or listing as a child reference: the wikilink in its `name=` when
 * there is one, otherwise the plain name. Plain names are kept on purpose —
 * `{{marker|type=city|name=Svolvær|wikidata=Q145948}}` (Lofoten) names a real
 * article without linking it — so a consumer must resolve `listed` entries
 * through titles and redirects, and `linked: false` says which ones.
 *
 * The marker's `wikidata` is the QID of the thing *named*, which is not
 * always the article linked: `name=[[Ferghana Valley (Kyrgyzstan)|Sary-Chelek
 * Nature Reserve]]|wikidata=Q4408855` carries the reserve's item. Only a
 * consumer that knows the article's own QID can tell the two apart, so both
 * facts are passed on as found.
 */
function childFromTemplate(t) {
  const p = parseTemplate(t.inner);
  const raw = p.named.name ?? '';
  const name = clip(toPlainText(raw), 120);
  const link = FIRST_LINK.exec(raw);
  let child = link ? childFromLink(link[1], name) : null;
  if (!child) {
    const title = normaliseTitle(name);
    if (!title || title.length > 80) return null;
    child = { name, title, linked: false, anchor: null, wikidata: null, lat: null, lng: null };
  }
  const at = point(p.named.lat, p.named.long);
  child.wikidata = asQid(p.named.wikidata);
  child.lat = at?.lat ?? null;
  child.lng = at?.lng ?? null;
  return child;
}

/**
 * Children named in one section (subsections included): every marker in it,
 * and every bullet that *begins* with a wikilink or a listing. "Begins" is
 * the point — in `* Røst – the southernmost island in the [[Lofoten]]
 * archipelago` the first link is the page itself, not a child.
 */
function childrenOfSection(text, section, templates, templateAt) {
  const found = [];
  for (const t of templates) {
    if (t.start < section.bodyStart || t.end > section.end || !MARKER_LIKE.has(t.name)) continue;
    const child = childFromTemplate(t);
    if (child) found.push({ at: t.start, child });
  }
  BULLET.lastIndex = section.bodyStart;
  let m;
  while ((m = BULLET.exec(text)) && m.index < section.end) {
    let p = m.index + m[0].length;
    while (text.charCodeAt(p) === 39 /* ' */) p++;
    if (text.startsWith('{{', p)) {
      const t = templateAt.get(p);
      if (t && LISTING_TEMPLATES.has(t.name)) {
        const child = childFromTemplate(t);
        if (child) found.push({ at: p, child });
      }
      continue;
    }
    const article = /^the\s+/i.exec(text.slice(p, p + 6));
    if (article) p += article[0].length;
    while (text.charCodeAt(p) === 39) p++;
    if (!text.startsWith('[[', p)) continue;
    const link = /^\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/.exec(text.slice(p, p + 400));
    const child = link ? childFromLink(link[1], clip(toPlainText(link[2] ?? ''), 120)) : null;
    if (child) found.push({ at: p, child });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.child);
}

function readListed(text, title, level2, templates) {
  const groups = { regions: [], cities: [], other: [] };
  const detail = [];
  const regionItems = [];

  // {{Regionlist|region1name=[[X]]|region1items=[[A]], [[B]]|…}} — wherever it
  // sits. Huge cities use it for districts, so `regions` can hold `City/District`.
  for (const t of templates) {
    if (t.name !== 'regionlist') continue;
    const named = parseTemplate(t.inner).named;
    const numbers = [];
    for (const key in named) {
      const m = /^region(\d+)name$/.exec(key);
      if (m) numbers.push(Number(m[1]));
    }
    numbers.sort((a, b) => a - b);
    for (const n of numbers) {
      groups.regions.push(...articleLinkTargets(named[`region${n}name`] ?? ''));
      regionItems.push(...articleLinkTargets(named[`region${n}items`] ?? ''));
    }
  }

  let templateAt = null;
  for (const section of level2) {
    const group = OTHER_HEADING.test(section.title)
      ? 'other'
      : CITY_HEADING.test(section.title)
        ? 'cities'
        : REGION_HEADING.test(section.title)
          ? 'regions'
          : null;
    if (!group) continue;
    templateAt ??= new Map(templates.map((t) => [t.start, t]));
    const seen = new Set();
    for (const child of childrenOfSection(text, section, templates, templateAt)) {
      if (child.title === title && !child.anchor) continue;
      // A link into a section of another article is not that article.
      if (!child.anchor) groups[group].push(child.title);
      // A bare `* [[Zermatt]]` says nothing `listed` does not already say.
      if (child.linked && !child.anchor && !child.wikidata && child.lat === null) continue;
      const key = `${child.name}\u0000${child.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      detail.push({ group, ...child });
    }
  }

  const notSelf = (t) => t !== title;
  return {
    listed: {
      regions: unique(groups.regions.filter(notSelf)),
      cities: unique(groups.cities.filter(notSelf)),
      other: unique(groups.other.filter(notSelf)),
    },
    listedDetail: detail,
    regionItems: unique(regionItems.filter(notSelf)),
  };
}

/* ------------------------------------------------------------------------ */
/* One article                                                               */
/* ------------------------------------------------------------------------ */

/** `:''For other places with the same name, see …''` — a hatnote, not a lead. */
const HATNOTE = /^:+[ \t]*''[^\n]*''\.?[ \t]*$/gm;

/**
 * Parse one main-namespace article.
 *
 * Pure: a function of its arguments. Returns the output record and, beside
 * it, the few facts the run's statistics need.
 *
 * @param {{ title: string, pageId: number, text: string, bytes?: number, qid?: string | null }} page
 */
export function parseArticle({ title, pageId, text, bytes, qid = null }) {
  const source = text.indexOf('\r') >= 0 ? text.replace(/\r\n?/g, '\n') : text;
  const clean = stripComments(source);
  const templates = scanTemplates(clean);
  const { lead: leadRaw, sections } = splitSections(clean);
  const level2 = sections.filter((s) => s.level === 2);

  const verdict = classify(templates.map((t) => t.name));

  const lead = clip(toPlainText(leadRaw.replace(HATNOTE, '')), 1500);

  const parts = {};
  const add = (key, value) => {
    if (value) (parts[key] ??= []).push(value);
  };
  for (const s of level2) {
    const key = sectionKey(s.title);
    if (key) add(key, toPlainText(clean.slice(s.bodyStart, s.end)));
  }
  // A "Climate" subsection anywhere is evidence of its own; it also stays
  // inside its parent (usually Understand), which already folded it in.
  for (const s of sections) {
    if (s.level > 2 && /^climate\b/i.test(s.title)) add('climate', toPlainText(clean.slice(s.bodyStart, s.end)));
  }
  const sectionText = {};
  for (const key of SECTION_ORDER) {
    if (parts[key]) sectionText[key] = clip(parts[key].join(' '), SECTION_CAPS[key]);
  }

  const { counts, top } = readListings(clean, templates);
  const { listed, listedDetail, regionItems } = readListed(clean, title, level2, templates);

  // "Go next": every link in the section, as specified — and, separately,
  // the ones that open a bullet. The difference is real: Torres del Paine's
  // section says a neighbouring park is "about the size of [[Taiwan]]".
  const goNext = [];
  const goNextPrimary = [];
  let templateAt = null;
  for (const s of level2) {
    if (!/^go next$/i.test(s.title)) continue;
    goNext.push(...articleLinkTargets(clean.slice(s.bodyStart, s.end)));
    templateAt ??= new Map(templates.map((t) => [t.start, t]));
    for (const child of childrenOfSection(clean, s, templates, templateAt)) {
      if (child.linked && !child.anchor) goNextPrimary.push(child.title);
    }
  }

  const record = {
    title,
    pageId,
    qid,
    type: verdict.type,
    status: verdict.status,
    parent: lastTemplateTitle(templates, 'ispartof'),
    geo: readGeo(templates),
    bytes: bytes ?? Buffer.byteLength(text, 'utf8'),
    lead,
    firstSentence: firstSentence(lead, 300),
    sections: sectionText,
    headings: level2.map((s) => s.title),
    listings: counts,
    top,
    listed,
    regionItems,
    goNext: unique(
      goNext.filter((t) => t !== title),
      30,
    ),
    links: countWikilinks(clean),
    // --- beyond the agreed schema, additive -------------------------------
    // Children found under a Cities / Other destinations / Regions heading
    // that carry more than a bare link: the displayed name, the article
    // linked (`linked: false` when the name was plain text), the section
    // anchor if the link pointed inside another article (those are NOT in
    // `listed`), and the marker's own Wikidata item and coordinate.
    listedDetail,
    // The subset of `goNext` that opens a bullet: the places the section is
    // actually sending the reader to, without links from the descriptions.
    goNextPrimary: unique(
      goNextPrimary.filter((t) => t !== title),
      30,
    ),
    // {{PartOfTopic|X}} / {{PartOfItinerary|X}} / {{PartOfPhrasebook|X}}: the
    // breadcrumb of travel topics, itineraries and phrasebooks, which have no
    // {{IsPartOf}}. Kept apart from `parent` because it is not geography.
    topicParent:
      lastTemplateTitle(templates, 'partoftopic') ??
      lastTemplateTitle(templates, 'partofitinerary') ??
      lastTemplateTitle(templates, 'partofphrasebook'),
  };
  return { record, verdict, trailing: trailingTemplates(clean, templates) };
}

/* ------------------------------------------------------------------------ */
/* Input streams                                                             */
/* ------------------------------------------------------------------------ */

/** Run a decompressor and yield its stdout as decoded text chunks. */
async function* decompress(command, file, encoding) {
  const child = spawn(command, [file], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.setEncoding(encoding);
  let drained = false;
  try {
    for await (const chunk of child.stdout) yield chunk;
    drained = true;
  } finally {
    // Only when the consumer stopped early or threw: a drained pipe means the
    // child is exiting on its own, and killing it would fake a failure.
    if (!drained) child.kill();
  }
  const { code, signal } = await exit;
  if (code !== 0) throw new Error(`${command} ${file} exited with ${code ?? signal}`);
}

/**
 * page id → Wikidata QID, from the `page_props` dump.
 *
 * Rows look like `(10,'wikibase_item','Q2766547',NULL)` inside multi-megabyte
 * INSERT statements, so this scans chunks with a regular expression and
 * carries a short tail across chunk boundaries instead of parsing SQL. Read
 * as latin1: `pp_value` is a blob and the bytes we want are ASCII.
 */
async function loadQids(file) {
  const qids = new Map();
  const row = /\((\d+),'wikibase_item','(Q\d+)'/g;
  const TAIL = 256;
  let carry = '';
  for await (const chunk of decompress('gzcat', file, 'latin1')) {
    const buf = carry + chunk;
    let lastEnd = 0;
    let m;
    row.lastIndex = 0;
    while ((m = row.exec(buf))) {
      qids.set(Number(m[1]), m[2]);
      lastEnd = row.lastIndex;
    }
    carry = buf.slice(Math.max(lastEnd, buf.length - TAIL));
  }
  return qids;
}

/** Yield the inside of each `<page>…</page>` element of the export. */
async function* pageElements(file) {
  const CLOSE = '</page>';
  let buf = '';
  let searchFrom = 0;
  for await (const chunk of decompress('bzcat', file, 'utf8')) {
    buf += chunk;
    let consumed = 0;
    for (;;) {
      const end = buf.indexOf(CLOSE, searchFrom);
      if (end < 0) break;
      const start = buf.indexOf('<page>', consumed);
      if (start >= 0 && start < end) yield buf.slice(start + 6, end);
      consumed = end + CLOSE.length;
      searchFrom = consumed;
    }
    if (consumed > 0) buf = buf.slice(consumed);
    // The closing tag may straddle two chunks; never rescan the whole page.
    searchFrom = Math.max(0, buf.length - CLOSE.length);
  }
}

function between(xml, open, close, from = 0) {
  const a = xml.indexOf(open, from);
  if (a < 0) return null;
  const b = xml.indexOf(close, a + open.length);
  return b < 0 ? null : xml.slice(a + open.length, b);
}

/** The handful of fields this stage reads from one `<page>` element. */
function readPage(xml) {
  const revision = xml.indexOf('<revision>');
  const head = revision < 0 ? xml : xml.slice(0, revision);
  const redirect = /<redirect title="([^"]*)"/.exec(head);
  const page = {
    title: decodeXmlEntities(between(head, '<title>', '</title>') ?? ''),
    ns: Number(between(head, '<ns>', '</ns>')),
    pageId: Number(between(head, '<id>', '</id>')),
    redirectTo: redirect ? decodeXmlEntities(redirect[1]) : null,
    text: '',
    bytes: undefined,
  };
  const open = xml.indexOf('<text', Math.max(revision, 0));
  if (open < 0) return page;
  const gt = xml.indexOf('>', open);
  const attributes = xml.slice(open, gt);
  const bytes = /\bbytes="(\d+)"/.exec(attributes);
  if (bytes) page.bytes = Number(bytes[1]);
  if (xml.charCodeAt(gt - 1) === 47 /* <text … /> */) return page;
  const close = xml.lastIndexOf('</text>');
  if (close > gt) page.text = decodeXmlEntities(xml.slice(gt + 1, close));
  return page;
}

/* ------------------------------------------------------------------------ */
/* Output                                                                    */
/* ------------------------------------------------------------------------ */

/** Buffered synchronous line writer: no backpressure to manage, flat memory. */
class LineWriter {
  constructor(file) {
    this.fd = fs.openSync(file, 'w');
    this.pending = [];
    this.size = 0;
    this.lines = 0;
  }

  write(line) {
    this.pending.push(line);
    this.size += line.length + 1;
    this.lines++;
    if (this.size > 4 << 20) this.flush();
  }

  flush() {
    if (this.pending.length === 0) return;
    fs.writeSync(this.fd, `${this.pending.join('\n')}\n`);
    this.pending = [];
    this.size = 0;
  }

  close() {
    this.flush();
    fs.closeSync(this.fd);
  }
}

const tally = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const topOf = (map, limit) =>
  [...map]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
const sortedObject = (map) => Object.fromEntries([...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
const say = (line) => process.stdout.write(`${line}\n`);

/* ------------------------------------------------------------------------ */
/* Main                                                                      */
/* ------------------------------------------------------------------------ */

async function main() {
  const cache = path.resolve(process.env.ATLAS_CACHE || '.atlas-cache');
  const dumpFile = path.join(cache, 'raw/wikivoyage/enwikivoyage-latest-pages-articles.xml.bz2');
  const propsFile = path.join(cache, 'raw/wikivoyage/enwikivoyage-latest-page_props.sql.gz');
  const workDir = path.join(cache, 'work');
  const outFile = path.join(workDir, 'wikivoyage.ndjson');
  const redirectsFile = path.join(workDir, 'wikivoyage-redirects.ndjson');
  const statsFile = path.join(workDir, 'wikivoyage-stats.json');
  for (const file of [dumpFile, propsFile]) {
    if (!fs.existsSync(file)) throw new Error(`missing input: ${file}`);
  }
  fs.mkdirSync(workDir, { recursive: true });

  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

  const qids = await loadQids(propsFile);
  say(`page_props: ${qids.size} pages with a Wikidata item (${elapsed()})`);

  // Outputs are written beside their final names and renamed at the end, so a
  // failed run never leaves a half-written file where the next stage reads.
  const articles = new LineWriter(`${outFile}.tmp`);
  const redirects = new LineWriter(`${redirectsFile}.tmp`);

  const namespaces = new Map();
  const endTemplates = new Map();
  const statusTemplates = new Map();
  const otherTemplates = new Map();
  const otherReasons = new Map();
  const otherTitles = [];
  const sectionCoverage = new Map();
  const failures = [];
  let failureCount = 0;
  /** One compact row per article; statistics are computed from these at the end. */
  const rows = [];
  let pages = 0;
  let redirectCount = 0;
  let redirectsOutOfNamespace = 0;

  for await (const xml of pageElements(dumpFile)) {
    pages++;
    if (pages % 10000 === 0) say(`  ${pages} pages read, ${rows.length} articles, ${redirectCount} redirects (${elapsed()})`);
    let title = '';
    try {
      const page = readPage(xml);
      title = page.title;
      tally(namespaces, String(page.ns));
      if (page.ns !== 0) continue;

      if (page.redirectTo !== null) {
        // The attribute is the normalised target but drops the fragment; the
        // text (`#REDIRECT [[Munich#Oktoberfest]]`) still has it.
        const hash = page.redirectTo.indexOf('#');
        const to = hash < 0 ? page.redirectTo : page.redirectTo.slice(0, hash);
        const inText = /^\s*#\s*redirect\s*:?\s*\[\[[^\]|#]*#([^\]|]*)/i.exec(page.text);
        const anchor = (inText?.[1] ?? (hash < 0 ? '' : page.redirectTo.slice(hash + 1))).replace(/_/g, ' ').trim();
        const row = { from: page.title, to };
        if (anchor) row.anchor = anchor;
        redirects.write(JSON.stringify(row));
        redirectCount++;
        if (toArticleTitle(to) === null) redirectsOutOfNamespace++;
        continue;
      }

      const { record, verdict, trailing } = parseArticle({
        title: page.title,
        pageId: page.pageId,
        text: page.text,
        bytes: page.bytes,
        qid: qids.get(page.pageId) ?? null,
      });
      articles.write(JSON.stringify(record));

      rows.push({
        title: record.title,
        type: record.type,
        status: record.status,
        parent: record.parent,
        geo: record.geo ? record.geo.source : null,
        qid: record.qid !== null,
      });
      for (const name of trailing) tally(endTemplates, name);
      if (verdict.template) tally(statusTemplates, verdict.template);
      for (const key in record.sections) tally(sectionCoverage, key);
      if (record.type === 'other') {
        tally(otherReasons, verdict.reason ?? 'unexplained');
        if (verdict.template) tally(otherTemplates, verdict.template);
        for (const name of trailing) if (name !== verdict.template) tally(otherTemplates, name);
        if (otherTitles.length < 80) otherTitles.push({ title: record.title, reason: verdict.reason, trailing });
      }
    } catch (error) {
      failureCount++;
      if (failures.length < 50) failures.push({ title, error: String(error?.message ?? error) });
    }
  }
  articles.close();
  redirects.close();
  say(`dump: ${pages} pages, ${rows.length} articles, ${redirectCount} redirects (${elapsed()})`);

  /*
   * Continental sections.
   *
   * Wikivoyage's hierarchy is continent → continental section → country, but
   * a section ("Central Asia", "Caribbean", "Southern Africa") carries an
   * ordinary `…region` status template. The structural facts that set it
   * apart are its neighbours in the hierarchy: a region-typed page whose
   * {{IsPartOf}} is a continent-typed page AND which is itself the
   * {{IsPartOf}} of at least one country-typed page. The second half keeps
   * out a territory filed directly under a continent (French Guiana, Saint
   * Pierre and Miquelon) and the regions of Antarctica. Decided from types
   * alone, never from a name, and only once every page has been seen — hence
   * a second, cheap pass that rewrites just those lines.
   */
  const continents = new Set(rows.filter((r) => r.type === 'continent').map((r) => r.title));
  const parentsOfCountries = new Set(rows.filter((r) => r.type === 'country' && r.parent !== null).map((r) => r.parent));
  const continentalSections = new Set();
  for (const r of rows) {
    if (r.type === 'region' && r.parent !== null && continents.has(r.parent) && parentsOfCountries.has(r.title)) {
      r.type = 'continentalsection';
      continentalSections.add(r.title);
    }
  }
  if (continentalSections.size > 0) {
    const patched = new LineWriter(`${outFile}.tmp2`);
    const lines = readline.createInterface({ input: fs.createReadStream(`${outFile}.tmp`, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      // `"type":"region"` can only be the top-level key: inside a JSON string
      // the quotes would be escaped.
      if (line.includes('"type":"region"')) {
        const record = JSON.parse(line);
        if (continentalSections.has(record.title)) {
          record.type = 'continentalsection';
          patched.write(JSON.stringify(record));
          continue;
        }
      }
      patched.write(line);
    }
    patched.close();
    fs.renameSync(`${outFile}.tmp2`, `${outFile}.tmp`);
  }
  fs.renameSync(`${outFile}.tmp`, outFile);
  fs.renameSync(`${redirectsFile}.tmp`, redirectsFile);

  const byType = new Map();
  const byStatus = new Map();
  const byTypeStatus = {};
  const coverage = {};
  let withGeo = 0;
  let withGeoFromMapframe = 0;
  let withQid = 0;
  let withParent = 0;
  for (const r of rows) {
    const status = r.status ?? 'none';
    tally(byType, r.type);
    tally(byStatus, status);
    (byTypeStatus[r.type] ??= {})[status] = (byTypeStatus[r.type][status] ?? 0) + 1;
    const c = (coverage[r.type] ??= { pages: 0, geo: 0, geoFromMapframe: 0, qid: 0, parent: 0 });
    c.pages++;
    if (r.geo) {
      withGeo++;
      c.geo++;
      if (r.geo === 'mapframe') {
        withGeoFromMapframe++;
        c.geoFromMapframe++;
      }
    }
    if (r.qid) {
      withQid++;
      c.qid++;
    }
    if (r.parent !== null) {
      withParent++;
      c.parent++;
    }
  }

  const stats = {
    generatedAt: new Date().toISOString(),
    inputs: { dump: path.relative(process.cwd(), dumpFile), pageProps: path.relative(process.cwd(), propsFile) },
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    pages: {
      total: pages,
      byNamespace: sortedObject(namespaces),
      articles: rows.length,
      redirects: redirectCount,
      redirectsToOtherNamespaces: redirectsOutOfNamespace,
      failures: failureCount,
      failureSamples: failures,
    },
    byType: sortedObject(byType),
    byStatus: sortedObject(byStatus),
    byTypeStatus,
    withGeo,
    withGeoFromMapframe,
    withQid,
    withParent,
    byTypeCoverage: coverage,
    sectionCoverage: sortedObject(sectionCoverage),
    // The template each article's type/status was read from.
    statusTemplates: sortedObject(statusTemplates),
    // Templates in the closing run of an article; an unrecognised status
    // template would show up here with a count.
    endTemplates: topOf(endTemplates, 40),
    other: {
      pages: byType.get('other') ?? 0,
      reasons: sortedObject(otherReasons),
      topTemplates: topOf(otherTemplates, 30),
      samples: otherTitles,
    },
    derived: {
      continentalSections: {
        rule: 'type region whose {{IsPartOf}} parent is a continent-typed page and which is the {{IsPartOf}} parent of at least one country-typed page',
        continents: [...continents].sort(),
        pages: [...continentalSections].sort(),
      },
    },
  };
  fs.writeFileSync(`${statsFile}.tmp`, `${JSON.stringify(stats, null, 2)}\n`);
  fs.renameSync(`${statsFile}.tmp`, statsFile);

  say(`wrote ${path.relative(process.cwd(), outFile)} (${rows.length} articles)`);
  say(`wrote ${path.relative(process.cwd(), redirectsFile)} (${redirectCount} redirects)`);
  say(`wrote ${path.relative(process.cwd(), statsFile)}`);
  say(`geo ${withGeo} · qid ${withQid} · parent ${withParent} · failures ${failureCount} · ${elapsed()}`);
}

/** True when this file is the program, not an import (a test, another stage). */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync.native(fileURLToPath(import.meta.url)) === fs.realpathSync.native(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
