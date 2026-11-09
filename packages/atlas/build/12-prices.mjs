#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
/**
 * Atlas build, stage 12 — destination price evidence.
 *
 *   node packages/atlas/build/12-prices.mjs fx         # (re)build lib/fx-rates.json from the World Bank and the Federal Reserve
 *   node packages/atlas/build/12-prices.mjs            # Wikivoyage listings → work/prices.ndjson
 *   node packages/atlas/build/12-prices.mjs perdiem    # U.S. government per-diem tables → work/perdiem.ndjson
 *   node packages/atlas/build/12-prices.mjs validate   # coverage, agreement, spread → work/prices-validation.json
 *
 * Reads (under `$ATLAS_CACHE`, default `.atlas-cache`):
 *   raw/wikivoyage/enwikivoyage-latest-pages-articles.xml.bz2   the same dump stage 01 reads
 *   work/wikivoyage.ndjson      stage 01: each page's type and {{IsPartOf}} parent
 *   work/candidates.ndjson      stage 04: which pages are destinations, and their country
 *   work/curated.json           the editorial catalog and country price levels (validation only)
 *
 * Writes:
 *   work/price-observations.ndjson   one line per listing whose price was read (or was "free")
 *   work/prices.ndjson               one line per destination page that has observations
 *   work/prices-stats.json           what was read, what was refused and why, with samples
 *   work/perdiem.ndjson, work/perdiem-stats.json
 *   work/prices-validation.json
 *
 * Nothing here changes an output of another stage.
 *
 * What an observation is
 * ----------------------
 * A `price=` a traveller typed into a Sleep, Eat, See or Do listing, with the
 * year the listing was last edited (`lastedit=`), or the year the string itself
 * states ("(Jan 2018)") when it states one. It is a **historical observation**:
 * converted to US dollars at that year's annual-average official exchange rate
 * (`usd`), and also carried to constant base-year dollars (`usdReal`) with the
 * consumer price index of the economy whose currency it is. It is never a
 * current price, and a listing with no year is counted and left out of every
 * figure.
 *
 * The dump and every download are untrusted data: nothing in them is executed,
 * evaluated or used as a path.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  COUNTRY_CURRENCY,
  bundledFx,
  parseLastEditYear,
  parsePrice,
  plausibleUsd,
  quantile,
  round3,
  spearman,
  tierOf,
} from './lib/prices.mjs';
import { LISTING_TEMPLATES, clip, decodeXmlEntities, parseTemplate, scanTemplates, splitSections, stripComments, toPlainText } from './lib/wikitext.mjs';
import { worldRegionFor } from './lib/world-regions.mjs';

const USER_AGENT = 'SidequestAtlasBuild/0.1 (open-data research)';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX_FILE = path.join(HERE, 'lib/fx-rates.json');
const say = (line) => process.stdout.write(`${line}\n`);
const tally = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const sortedObject = (map) => Object.fromEntries([...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));

/* ------------------------------------------------------------------------ */
/* Downloads                                                                 */
/* ------------------------------------------------------------------------ */

/** Fetch `url` to `file` unless it is already there. Never follows a path from the response. */
async function download(url, file, { force = false, timeoutMs = 180_000, headers = {} } = {}) {
  if (!force && fs.existsSync(file) && fs.statSync(file).size > 0) return { file, cached: true };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) throw new Error(`${url} answered with an empty body`);
  fs.writeFileSync(`${file}.tmp`, body);
  fs.renameSync(`${file}.tmp`, file);
  return { file, cached: false, bytes: body.length };
}

/* ------------------------------------------------------------------------ */
/* fx — the exchange-rate and price-index table                              */
/* ------------------------------------------------------------------------ */

/** Which World Bank country series carries each currency, and until when for a currency that has since been replaced. */
const LEGACY_SERIES = { HRK: ['HR', 2022], LTL: ['LT', 2014], LVL: ['LV', 2013], EEK: ['EE', 2010] };
/** Countries whose own series switches currency: read only up to the last year of the currency named in `COUNTRY_CURRENCY`. */
const SERIES_UNTIL = { BGN: 2025 };
/** Hard pegs, used only where the World Bank publishes no series for the currency. `[anchor, units per anchor unit]`. */
const PEGS = {
  BSD: ['USD', 1], BMD: ['USD', 1], KYD: ['USD', 0.8333], AWG: ['USD', 1.79], ANG: ['USD', 1.79], XCD: ['USD', 2.7],
  DJF: ['USD', 177.721], ERN: ['USD', 15], XPF: ['EUR', 119.332], XOF: ['EUR', 655.957], XAF: ['EUR', 655.957],
  KMF: ['EUR', 491.968], BTN: ['INR', 1], LSL: ['ZAR', 1], SZL: ['ZAR', 1], NAD: ['ZAR', 1], BAM: ['EUR', 1.95583],
};
const FIRST_YEAR = 2000;

async function buildFx(cache, { force }) {
  const raw = path.join(cache, 'raw/worldbank');
  const wb = (series) => `https://api.worldbank.org/v2/country/all/indicator/${series}?format=json&date=1995:2026&per_page=20000`;
  const meta = (series) => `https://api.worldbank.org/v2/sources/2/series/${series}/metadata?format=json`;
  for (const series of ['PA.NUS.FCRF', 'FP.CPI.TOTL']) {
    await download(wb(series), path.join(raw, `${series}.json`), { force });
    await download(meta(series), path.join(raw, `${series}.metadata.json`), { force });
  }
  const fed = await download('https://www.federalreserve.gov/releases/h10/hist/dat00_ta.htm', path.join(cache, 'raw/fed/dat00_ta.htm'), { force });

  const licenceOf = (series) => {
    const fields = JSON.parse(fs.readFileSync(path.join(raw, `${series}.metadata.json`), 'utf8')).source[0].concept[0].variable[0].metatype;
    const get = (id) => fields.find((f) => f.id === id)?.value ?? null;
    return { licenceType: get('License_Type'), licenceUrl: get('License_URL'), name: get('IndicatorName'), origin: get('Source') };
  };
  const read = (series) => {
    const [head, rows] = JSON.parse(fs.readFileSync(path.join(raw, `${series}.json`), 'utf8'));
    if (head.pages !== 1) throw new Error(`${series}: expected one page, got ${head.pages}`);
    const byCountry = new Map();
    for (const row of rows) {
      if (row.value === null || !row.country?.id) continue;
      const year = Number(row.date);
      if (year < FIRST_YEAR) continue;
      let years = byCountry.get(row.country.id);
      if (!years) byCountry.set(row.country.id, (years = {}));
      years[year] = row.value;
    }
    return { byCountry, lastUpdated: head.lastupdated };
  };
  const rates = read('PA.NUS.FCRF');
  const prices = read('FP.CPI.TOTL');
  for (const series of ['PA.NUS.FCRF', 'FP.CPI.TOTL']) {
    const licence = licenceOf(series);
    if (licence.licenceType !== 'CC BY-4.0') throw new Error(`${series}: the World Bank now states licence "${licence.licenceType}" — re-check before using`);
  }

  /* One series per currency, from the first country that uses it and has data. "XC" is the World Bank's euro-area aggregate. */
  const homes = new Map();
  for (const [iso, code] of COUNTRY_CURRENCY) if (!homes.has(code)) homes.set(code, []);
  for (const [iso, code] of COUNTRY_CURRENCY) homes.get(code).push(iso);
  homes.set('EUR', ['XC']);
  for (const [code, [iso]] of Object.entries(LEGACY_SERIES)) homes.set(code, [iso]);

  const significant = (value) => Number(value.toPrecision(6));
  const fx = {};
  const seriesOf = {};
  for (const [code, countries] of homes) {
    if (code === 'USD') continue;
    const source = countries.find((iso) => rates.byCountry.has(iso));
    if (!source) continue;
    const until = LEGACY_SERIES[code]?.[1] ?? SERIES_UNTIL[code] ?? Infinity;
    const years = {};
    for (const [year, value] of Object.entries(rates.byCountry.get(source))) if (Number(year) <= until && value > 0) years[year] = significant(value);
    if (Object.keys(years).length === 0) continue;
    fx[code] = years;
    seriesOf[code] = `worldbank:${source}`;
  }

  /* Taiwan is not a World Bank member: annual averages of the Federal Reserve's daily H.10 noon buying rates. */
  const taiwan = {};
  const page = fs.readFileSync(fed.file, 'latin1');
  const days = new Map();
  for (const m of page.matchAll(/(\d{1,2})-([A-Z]{3})-(\d{2})\s*<\/th>\s*<td[^>]*>\s*([\d.]+)\s*</g)) {
    const year = 2000 + Number(m[3]);
    if (!days.has(year)) days.set(year, []);
    days.get(year).push(Number(m[4]));
  }
  for (const [year, values] of days) if (values.length >= 150) taiwan[year] = significant(values.reduce((s, v) => s + v, 0) / values.length);
  if (Object.keys(taiwan).length < 20) throw new Error(`Federal Reserve H.10 Taiwan page: only ${Object.keys(taiwan).length} full years parsed — the page layout changed`);
  fx.TWD = taiwan;
  seriesOf.TWD = 'federalreserve:h10/dat00_ta';

  /* Pegs fill only what is still missing. */
  for (const [code, [anchor, units]] of Object.entries(PEGS)) {
    if (fx[code]) continue;
    const anchorYears = anchor === 'USD' ? null : fx[anchor];
    const years = {};
    for (let year = FIRST_YEAR; year <= 2026; year += 1) {
      const base = anchor === 'USD' ? 1 : anchorYears?.[year];
      if (base !== undefined) years[year] = significant(base * units);
    }
    fx[code] = years;
    seriesOf[code] = `peg:${anchor}x${units}`;
  }

  const cpi = {};
  for (const [iso, years] of prices.byCountry) {
    if (!/^[A-Z]{2}$/.test(iso) || !COUNTRY_CURRENCY.has(iso)) continue;
    cpi[iso] = Object.fromEntries(Object.entries(years).map(([year, value]) => [year, significant(value)]));
  }
  /* The base year is the latest for which the US index — the fallback deflator — is published. */
  const baseYear = Math.max(...Object.keys(cpi.US).map(Number));

  const table = {
    _meta: {
      what: 'Annual-average official exchange rates (local currency units per US dollar) and consumer price indices (2010 = 100), by year, for converting historical price observations. Built by `node packages/atlas/build/12-prices.mjs fx`; do not edit by hand.',
      builtAt: new Date().toISOString().slice(0, 10),
      sources: [
        { id: 'worldbank_fcrf', series: 'PA.NUS.FCRF', ...licenceOf('PA.NUS.FCRF'), url: wb('PA.NUS.FCRF'), licenceEvidence: meta('PA.NUS.FCRF'), lastUpdated: rates.lastUpdated, attribution: 'World Bank, World Development Indicators (source: IMF International Financial Statistics), CC BY 4.0' },
        { id: 'worldbank_cpi', series: 'FP.CPI.TOTL', ...licenceOf('FP.CPI.TOTL'), url: wb('FP.CPI.TOTL'), licenceEvidence: meta('FP.CPI.TOTL'), lastUpdated: prices.lastUpdated, attribution: 'World Bank, World Development Indicators (source: IMF International Financial Statistics), CC BY 4.0' },
        { id: 'federalreserve_h10', series: 'H.10 Taiwan dollar, daily noon buying rates, averaged by calendar year', url: 'https://www.federalreserve.gov/releases/h10/hist/dat00_ta.htm', licenceType: 'Public domain (work of the Board of Governors of the Federal Reserve System)', attribution: 'Board of Governors of the Federal Reserve System, H.10 Foreign Exchange Rates' },
      ],
      notes: [
        'fx[CODE][year]: one series per currency, taken from the country named in seriesOf. The World Bank expresses a redenominated currency in its current unit throughout; lib/prices.mjs scales the rate back for an observation older than the change.',
        'A currency replaced by the euro (HRK, LTL, LVL, EEK) is held only to its last year; EUR is the World Bank euro-area aggregate.',
        'peg:… series are fixed parities applied where the World Bank publishes none.',
        'cpi[ISO2][year]: the country series as published. baseYear is the latest year of the US series.',
        'Official rates are not street rates where a parallel market exists; lib/prices.mjs flags those country-years.',
      ],
    },
    baseYear,
    seriesOf,
    fx,
    cpi,
  };
  fs.writeFileSync(`${FX_FILE}.tmp`, `${JSON.stringify(table, null, 1)}\n`);
  fs.renameSync(`${FX_FILE}.tmp`, FX_FILE);
  const missing = [...new Set(COUNTRY_CURRENCY.values())].filter((code) => code !== 'USD' && !fx[code]);
  say(`wrote ${path.relative(process.cwd(), FX_FILE)}: ${Object.keys(fx).length} currencies, ${Object.keys(cpi).length} price indices, base year ${baseYear}`);
  say(`currencies with no rate (observations in them are refused as unsupported): ${missing.join(' ') || 'none'}`);
}

/* ------------------------------------------------------------------------ */
/* The dump                                                                  */
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
    if (!drained) child.kill();
  }
  const { code, signal } = await exit;
  if (code !== 0) throw new Error(`${command} ${file} exited with ${code ?? signal}`);
}

/** Yield `{ title, text, timestamp }` for each main-namespace article that is not a redirect. */
async function* articles(file) {
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
      if (start >= 0 && start < end) {
        const page = readPage(buf.slice(start + 6, end));
        if (page) yield page;
      }
      consumed = end + CLOSE.length;
      searchFrom = consumed;
    }
    if (consumed > 0) buf = buf.slice(consumed);
    searchFrom = Math.max(0, buf.length - CLOSE.length);
  }
}

function readPage(xml) {
  const revision = xml.indexOf('<revision>');
  const head = revision < 0 ? xml : xml.slice(0, revision);
  if (!head.includes('<ns>0</ns>') || head.includes('<redirect ')) return null;
  const title = /<title>([^<]*)<\/title>/.exec(head);
  const open = xml.indexOf('<text', Math.max(revision, 0));
  if (!title || open < 0) return null;
  const gt = xml.indexOf('>', open);
  if (xml.charCodeAt(gt - 1) === 47) return null;
  const close = xml.lastIndexOf('</text>');
  if (close <= gt) return null;
  const timestamp = /<timestamp>(\d{4})-/.exec(xml.slice(Math.max(revision, 0), open));
  return { title: decodeXmlEntities(title[1]), text: decodeXmlEntities(xml.slice(gt + 1, close)), year: timestamp ? Number(timestamp[1]) : null };
}

/* ------------------------------------------------------------------------ */
/* Which page is which destination, in which country                         */
/* ------------------------------------------------------------------------ */

async function lines(file, each) {
  const reader = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of reader) if (line) each(line);
}

/** English country names → ISO 3166-1, for the candidates stage 04 left without a country code. */
function countryNames() {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const byName = new Map();
  for (const iso of COUNTRY_CURRENCY.keys()) {
    const name = names.of(iso);
    if (name && name !== iso) byName.set(name.toLowerCase(), iso);
  }
  return byName;
}

async function loadPlaces(cache) {
  const pages = new Map();
  await lines(path.join(cache, 'work/wikivoyage.ndjson'), (line) => {
    // The fields wanted are the first six of each record; the rest (kilobytes of section text) is never parsed.
    const cut = line.indexOf(',"geo":');
    const head = JSON.parse(cut > 0 ? `${line.slice(0, cut)}}` : line);
    pages.set(head.title, { type: head.type, parent: head.parent ?? null, qid: head.qid ?? null });
  });
  const byName = countryNames();
  const candidates = new Map();
  let recovered = 0;
  await lines(path.join(cache, 'work/candidates.ndjson'), (line) => {
    const c = JSON.parse(line);
    if (c.source !== 'wikivoyage') return;
    let iso = c.countries.length === 1 ? c.countries[0] : null;
    if (!iso && c.countries.length === 0 && c.countryTitle) {
      iso = byName.get(c.countryTitle.toLowerCase()) ?? null;
      if (iso) recovered += 1;
    }
    candidates.set(c.title, { id: c.id, iso, country: iso, ownIso: c.ownIso ?? null, countries: c.countries, wvType: c.wvType, qid: c.qid ?? null, lat: c.lat, lng: c.lng, parents: c.parents, curated: c.curated ?? null, scopeOnly: c.scopeOnly });
  });

  /*
   * Whose money a page is priced in is not always its sovereign's. Stage 04
   * files Hong Kong under CN, Bermuda under GB and Nouméa under FR, and a bare
   * "$" read on that footing turned HK$800 into US$800. The jurisdiction is the
   * nearest of the page and its ancestors that has an ISO 3166-1 code of its
   * own with a currency; only then the country.
   */
  let reassigned = 0;
  for (const place of candidates.values()) {
    const chain = [place, ...place.parents.map((id) => candidates.get(id.slice(3))).filter(Boolean)];
    const own = chain.find((p) => p.ownIso && COUNTRY_CURRENCY.has(p.ownIso));
    if (own && own.ownIso !== place.iso) {
      // A sovereign ancestor with a code of its own settles it; so does a territory nearer than the country.
      const nearer = !place.country || chain.indexOf(own) <= chain.findIndex((p) => p.ownIso === place.country) || chain.findIndex((p) => p.ownIso === place.country) < 0;
      if (nearer) {
        place.iso = own.ownIso;
        reassigned += 1;
      }
    }
  }

  /** The destination a page's listings belong to: itself, or — for a district — the city it is a district of. */
  function destinationOf(title) {
    let at = title;
    for (let hops = 0; hops < 6; hops += 1) {
      const page = pages.get(at);
      if (!page) return null;
      if (page.type !== 'district') return candidates.has(at) ? at : null;
      if (!page.parent) return null;
      at = page.parent;
    }
    return null;
  }
  return { pages, candidates, destinationOf, recovered, reassigned };
}

/* ------------------------------------------------------------------------ */
/* extract — listings → observations → one line per destination              */
/* ------------------------------------------------------------------------ */

const TEMPLATE_SECTION = { sleep: 'sleep', eat: 'eat', see: 'see', do: 'do' };
const TYPE_SECTION = { sleep: 'sleep', hotel: 'sleep', stay: 'sleep', eat: 'eat', restaurant: 'eat', see: 'see', do: 'do' };
const HEADING_SECTION = [
  [/^sleep\b/i, 'sleep'],
  [/^eat\b/i, 'eat'],
  [/^see\b/i, 'see'],
  [/^do\b/i, 'do'],
];
/** `lastedit=` entered the listing template in 2015; an undated listing was last touched before that. */
const UNDATED_ASSUMED_YEAR = 2014;
const FIRST_OBSERVATION_YEAR = 2003;

function sectionOf(templateName, type, level2) {
  if (TEMPLATE_SECTION[templateName]) return TEMPLATE_SECTION[templateName];
  if (templateName !== 'listing') return null;
  const byType = TYPE_SECTION[(type ?? '').toLowerCase()];
  if (byType) return byType;
  if (type) return null;
  for (const [pattern, section] of HEADING_SECTION) if (level2 && pattern.test(level2)) return section;
  return null;
}

/** Which summary a reading belongs to. `null` — read, counted, and deliberately kept out of every median. */
function bucketOf(section, basis) {
  if (section === 'sleep') return basis === 'double' || basis === 'room' || basis === 'single' ? 'sleep' : basis === 'dorm' ? 'dorm' : null;
  if (section === 'eat') return basis === 'main' || basis === 'plain' ? 'eat' : null;
  if (section === 'see') return basis === 'adult' || basis === 'plain' ? 'entry' : null;
  return basis === 'adult' || basis === 'plain' ? 'do' : null;
}
const envelopeKind = (section, basis) => (section === 'sleep' ? (basis === 'dorm' ? 'dorm' : basis === 'camping' ? 'camping' : 'sleep') : section);

function summarise(observations) {
  const usd = observations.map((o) => o.usd).sort((a, b) => a - b);
  const real = observations.map((o) => o.usdReal).sort((a, b) => a - b);
  const years = observations.map((o) => o.year).sort((a, b) => a - b);
  return {
    n: observations.length,
    usdMedian: round3(quantile(usd, 0.5)),
    usdP25: round3(quantile(usd, 0.25)),
    usdP75: round3(quantile(usd, 0.75)),
    usdRealMedian: round3(quantile(real, 0.5)),
    usdRealP25: round3(quantile(real, 0.25)),
    usdRealP75: round3(quantile(real, 0.75)),
    yearMedian: Math.round(quantile(years, 0.5)),
    yearMin: years[0],
    yearMax: years[years.length - 1],
  };
}

function summariseTiered(observations) {
  const out = summarise(observations);
  const tiers = {};
  for (const tier of ['budget', 'mid', 'splurge']) {
    const inTier = observations.filter((o) => o.tier === tier);
    if (inTier.length === 0) continue;
    const s = summarise(inTier);
    tiers[tier] = { n: s.n, usdMedian: s.usdMedian, usdRealMedian: s.usdRealMedian };
  }
  out.tiers = tiers;
  out.untiered = observations.filter((o) => !o.tier).length;
  out.lowerBounds = observations.filter((o) => o.bound === 'from').length;
  out.upperBounds = observations.filter((o) => o.bound === 'upto').length;
  const caveats = observations.filter((o) => o.fxCaveat).length;
  if (caveats > 0) out.fxCaveat = caveats;
  return out;
}

async function extract(cache) {
  const dumpFile = path.join(cache, 'raw/wikivoyage/enwikivoyage-latest-pages-articles.xml.bz2');
  const work = path.join(cache, 'work');
  for (const file of [dumpFile, path.join(work, 'wikivoyage.ndjson'), path.join(work, 'candidates.ndjson'), FX_FILE]) {
    if (!fs.existsSync(file)) throw new Error(`missing input: ${file}${file === FX_FILE ? ' — run `12-prices.mjs fx` first' : ''}`);
  }
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const fx = bundledFx();
  const places = await loadPlaces(cache);
  say(`places: ${places.pages.size} pages, ${places.candidates.size} destinations (${places.recovered} countries recovered by name, ${places.reassigned} placed in a territory with its own currency) (${elapsed()})`);

  const readings = [];
  const status = new Map();
  const samples = new Map();
  const sample = (key, title, raw, extra) => {
    let list = samples.get(key);
    if (!list) samples.set(key, (list = []));
    list.seen = (list.seen ?? 0) + 1;
    // A spread across the dump, not the first forty of the alphabet.
    if (list.length < 40 && list.seen % 7 === 1) list.push({ title, raw: clip(raw, 160), ...extra });
  };
  const counts = { pages: 0, listings: 0, priced: 0, notADestination: 0, sectionSkipped: 0, failures: 0 };
  let dumpYear = 0;

  for await (const page of articles(dumpFile)) {
    counts.pages += 1;
    if (page.year && page.year > dumpYear) dumpYear = page.year;
    if (page.text.indexOf('price') < 0) continue;
    try {
      const destination = places.destinationOf(page.title);
      const text = stripComments(page.text.indexOf('\r') >= 0 ? page.text.replace(/\r\n?/g, '\n') : page.text);
      const templates = scanTemplates(text);
      let sections = null;
      for (const t of templates) {
        if (!LISTING_TEMPLATES.has(t.name)) continue;
        counts.listings += 1;
        if (t.inner.indexOf('price') < 0) continue;
        const p = parseTemplate(t.inner);
        const raw = p.named.price;
        if (!raw) continue;
        counts.priced += 1;
        if (!destination) {
          counts.notADestination += 1;
          continue;
        }
        sections ??= splitSections(text).sections;
        const enclosing = sections.filter((s) => s.bodyStart <= t.start && t.end <= s.end);
        const level2 = enclosing.find((s) => s.level === 2)?.title ?? null;
        const section = sectionOf(t.name, p.named.type, level2);
        if (!section) {
          counts.sectionSkipped += 1;
          continue;
        }
        const headings = enclosing.filter((s) => s.level > 2).map((s) => s.title).reverse();
        const place = places.candidates.get(destination);
        const name = clip(toPlainText(p.named.name ?? ''), 80);
        const parsed = parsePrice(raw, { section, iso: place.iso, headings, name, fx });
        tally(status, `${section}:${parsed.status}`);
        if (parsed.status !== 'ok' && parsed.status !== 'free') {
          sample(parsed.status, page.title, raw, { section });
          continue;
        }
        readings.push({
          page: page.title,
          destination,
          section,
          tier: section === 'sleep' || section === 'eat' ? tierOf(headings) : null,
          name,
          raw: clip(raw.replace(/\s+/g, ' '), 200),
          lastedit: parseLastEditYear(p.named.lastedit, { min: FIRST_OBSERVATION_YEAR }),
          parsed,
        });
      }
    } catch (error) {
      counts.failures += 1;
      sample('page_failed', page.title, String(error?.message ?? error), {});
    }
  }
  say(`dump: ${counts.pages} articles, ${counts.listings} listings, ${counts.priced} with a price, ${readings.length} read (${elapsed()})`);

  /* Years, conversion, the plausibility envelope. */
  const observationsFile = path.join(work, 'price-observations.ndjson');
  const out = fs.openSync(`${observationsFile}.tmp`, 'w');
  const byDestination = new Map();
  const yearsSeen = new Map();
  const yearBasis = new Map();
  const editLag = [];
  const outcome = new Map();
  const currencies = new Map();
  const currencyBasis = new Map();
  let buffer = [];
  for (const reading of readings) {
    const { parsed, section } = reading;
    const place = places.candidates.get(reading.destination);
    const stated = parsed.statedYear && parsed.statedYear >= FIRST_OBSERVATION_YEAR && parsed.statedYear <= dumpYear ? parsed.statedYear : null;
    const edited = reading.lastedit && reading.lastedit <= dumpYear ? reading.lastedit : null;
    // A year written into the price is when the price was true; `lastedit` is only when somebody last touched the listing.
    const year = stated ?? edited;
    const basis = stated ? 'stated' : edited ? 'lastedit' : null;
    if (stated && edited) editLag.push(edited - stated);
    const record = {
      destination: reading.destination,
      page: reading.page,
      iso: place.iso,
      country: place.country,
      section,
      tier: reading.tier,
      name: reading.name,
      raw: reading.raw,
      status: parsed.status,
      year,
      yearBasis: basis,
    };
    let entry = byDestination.get(reading.destination);
    if (!entry) byDestination.set(reading.destination, (entry = { observations: [], free: 0, freeDo: 0, undated: {}, other: {}, pages: new Set() }));
    entry.pages.add(reading.page);
    if (parsed.status === 'free') {
      if (section === 'see') entry.free += 1;
      else entry.freeDo += 1;
      tally(outcome, `${section}:free`);
      buffer.push(JSON.stringify(record));
    } else {
      Object.assign(record, { currency: parsed.currency, currencyBasis: parsed.currencyBasis, low: parsed.low, high: parsed.high, value: parsed.value, bound: parsed.bound, basis: parsed.basis, unit: parsed.unit });
      const converted = fx.convert(parsed.value, parsed.currency, year ?? UNDATED_ASSUMED_YEAR, place.iso);
      const kind = envelopeKind(section, parsed.basis);
      if (!converted) {
        tally(outcome, `${section}:no_rate`);
        sample('no_rate', reading.page, reading.raw, { section, currency: parsed.currency });
        continue;
      }
      if (!plausibleUsd(kind, converted.usd)) {
        tally(outcome, `${section}:implausible`);
        sample('implausible', reading.page, reading.raw, { section, currency: parsed.currency, value: parsed.value, usd: round3(converted.usd) });
        continue;
      }
      const bucket = bucketOf(section, parsed.basis);
      tally(currencies, parsed.currency);
      tally(currencyBasis, parsed.currencyBasis);
      if (year === null) {
        // No year: the conversion below is an assumption, written for analysis and never summarised.
        Object.assign(record, { assumedYear: UNDATED_ASSUMED_YEAR, usdIfAssumedYear: round3(converted.usd), usdRealIfAssumedYear: round3(converted.usdBase) });
        tally(outcome, `${section}:undated`);
        if (bucket) entry.undated[bucket] = (entry.undated[bucket] ?? 0) + 1;
      } else {
        Object.assign(record, { usd: round3(converted.usd), usdReal: round3(converted.usdBase), realBasis: converted.realBasis, fxGapYears: converted.fxGap, fxCaveat: converted.fxCaveat || undefined, bucket });
        tally(yearsSeen, year);
        tally(yearBasis, basis);
        if (bucket) {
          tally(outcome, `${section}:observed`);
          entry.observations.push({ bucket, tier: reading.tier, usd: converted.usd, usdReal: converted.usdBase, year, bound: parsed.bound, fxCaveat: converted.fxCaveat, basis: parsed.basis });
        } else {
          tally(outcome, `${section}:kept_out:${parsed.basis}`);
          entry.other[`${section}:${parsed.basis}`] = (entry.other[`${section}:${parsed.basis}`] ?? 0) + 1;
        }
      }
      buffer.push(JSON.stringify(record));
    }
    if (buffer.length >= 5000) {
      fs.writeSync(out, `${buffer.join('\n')}\n`);
      buffer = [];
    }
  }
  if (buffer.length > 0) fs.writeSync(out, `${buffer.join('\n')}\n`);
  fs.closeSync(out);
  fs.renameSync(`${observationsFile}.tmp`, observationsFile);

  /* One line per destination. */
  const pricesFile = path.join(work, 'prices.ndjson');
  const rows = [];
  for (const [title, entry] of byDestination) {
    const place = places.candidates.get(title);
    const of = (bucket) => entry.observations.filter((o) => o.bucket === bucket);
    const row = { title, id: place.id, qid: place.qid, iso: place.iso, country: place.country, type: place.wvType };
    const sleep = of('sleep');
    const eat = of('eat');
    const entryFees = of('entry');
    const activities = of('do');
    const dorm = of('dorm');
    if (sleep.length > 0) row.sleep = summariseTiered(sleep);
    if (dorm.length > 0) {
      const s = summarise(dorm);
      row.dorm = { n: s.n, usdMedian: s.usdMedian, usdRealMedian: s.usdRealMedian, yearMedian: s.yearMedian };
    }
    if (eat.length > 0) row.eat = summariseTiered(eat);
    if (entryFees.length > 0 || entry.free > 0) {
      row.entry = entryFees.length > 0 ? { ...summarise(entryFees), free: entry.free } : { n: 0, free: entry.free };
    }
    if (activities.length > 0 || entry.freeDo > 0) row.do = activities.length > 0 ? { ...summarise(activities), free: entry.freeDo } : { n: 0, free: entry.freeDo };
    row.undated = Object.values(entry.undated).reduce((s, v) => s + v, 0);
    if (row.undated > 0) row.undatedBy = entry.undated;
    if (Object.keys(entry.other).length > 0) row.keptOut = entry.other;
    const districtPages = [...entry.pages].filter((p) => p !== title).length;
    if (districtPages > 0) row.districtPages = districtPages;
    if (!row.sleep && !row.eat && !row.entry && !row.do && !row.dorm && row.undated === 0) continue;
    rows.push(row);
  }
  rows.sort((a, b) => (a.title < b.title ? -1 : 1));
  fs.writeFileSync(`${pricesFile}.tmp`, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  fs.renameSync(`${pricesFile}.tmp`, pricesFile);

  const lag = editLag.sort((a, b) => a - b);
  const stats = {
    generatedAt: new Date().toISOString(),
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    dumpYear,
    baseYear: fx.baseYear,
    undatedAssumedYear: UNDATED_ASSUMED_YEAR,
    counts: { ...counts, read: readings.length, destinationsWithAnyLine: rows.length, countriesRecoveredByName: places.recovered, placedInOwnCurrencyTerritory: places.reassigned },
    destinationsWith: {
      sleep: rows.filter((r) => r.sleep).length,
      eat: rows.filter((r) => r.eat).length,
      paidEntry: rows.filter((r) => r.entry?.n > 0).length,
      do: rows.filter((r) => r.do?.n > 0).length,
      dorm: rows.filter((r) => r.dorm).length,
      onlyUndated: rows.filter((r) => !r.sleep && !r.eat && !(r.entry?.n > 0) && !(r.do?.n > 0) && !r.dorm).length,
    },
    parseStatus: sortedObject(status),
    outcome: sortedObject(outcome),
    observationYears: Object.fromEntries([...yearsSeen].sort((a, b) => a[0] - b[0])),
    yearBasis: sortedObject(yearBasis),
    /* Where a price states its own year and the listing has a later `lastedit`: how stale the edit date is as a price date. */
    lasteditMinusStatedYear: lag.length > 0 ? { n: lag.length, median: quantile(lag, 0.5), p75: quantile(lag, 0.75), p90: quantile(lag, 0.9), sameYear: lag.filter((v) => v === 0).length, twoOrMoreYearsLater: lag.filter((v) => v >= 2).length } : null,
    currencies: sortedObject(currencies),
    currencyBasis: sortedObject(currencyBasis),
    samples: Object.fromEntries([...samples].map(([key, list]) => [key, { seen: list.seen, examples: [...list] }])),
  };
  fs.writeFileSync(path.join(work, 'prices-stats.json'), `${JSON.stringify(stats, null, 1)}\n`);
  say(`wrote ${path.relative(process.cwd(), observationsFile)}`);
  say(`wrote ${path.relative(process.cwd(), pricesFile)} (${rows.length} destinations: sleep ${stats.destinationsWith.sleep}, eat ${stats.destinationsWith.eat}, paid entry ${stats.destinationsWith.paidEntry})`);
  say(`wrote ${path.relative(process.cwd(), path.join(work, 'prices-stats.json'))} (${elapsed()})`);
}

/* ------------------------------------------------------------------------ */
/* perdiem — U.S. government lodging and meal rates                          */
/* ------------------------------------------------------------------------ */

const STATE_COUNTRY_ALIAS = {
  'antigua and barbuda': 'AG', 'trinidad and tobago': 'TT', 'wallis and futuna': 'WF', 'st lucia': 'LC', 'saint helena': 'SH', "dem. people's republic of korea": 'KP', 'falkland islands (islas malvinas)': 'FK', 'micronesia, federated states of': 'FM', 'virgin islands, british': 'VG', 'chagos archipelago': 'IO',
  burma: 'MM', 'bahamas, the': 'BS', 'gambia, the': 'GM', 'bosnia and herzegovina': 'BA', brunei: 'BN', 'cabo verde': 'CV', 'cote d\'ivoire': 'CI',
  'congo, democratic republic of the': 'CD', 'congo, republic of the': 'CG', 'democratic republic of the congo': 'CD', 'republic of the congo': 'CG', 'czech republic': 'CZ', czechia: 'CZ', eswatini: 'SZ',
  'korea, south': 'KR', 'south korea': 'KR', 'korea, north': 'KP', 'north korea': 'KP', 'hong kong': 'HK', macau: 'MO', macedonia: 'MK', 'north macedonia': 'MK', micronesia: 'FM', russia: 'RU',
  'sao tome and principe': 'ST', 'saint kitts and nevis': 'KN', 'st. kitts and nevis': 'KN', 'saint lucia': 'LC', 'st. lucia': 'LC', 'saint vincent and the grenadines': 'VC', 'st. vincent and the grenadines': 'VC',
  'timor-leste': 'TL', turkey: 'TR', turkiye: 'TR', 'türkiye': 'TR', 'united kingdom': 'GB', vatican: 'VA', 'holy see': 'VA', 'west bank': 'PS', jerusalem: 'IL', 'gaza strip': 'PS', 'bonaire, sint eustatius, and saba': 'BQ',
  curacao: 'CW', 'sint maarten': 'SX', 'british virgin islands': 'VG', 'turks and caicos islands': 'TC', 'falkland islands': 'FK', reunion: 'RE', 'french polynesia': 'PF', 'new caledonia': 'NC', laos: 'LA', syria: 'SY', vietnam: 'VN', tanzania: 'TZ', moldova: 'MD', iran: 'IR', bolivia: 'BO', venezuela: 'VE',
};
const STATE_NOT_A_COUNTRY = new Set(['antarctica', 'other foreign localities', 'ascension island']);

function stateCountryIso(name, byName) {
  const key = name.trim().toLowerCase();
  return STATE_COUNTRY_ALIAS[key] ?? byName.get(key) ?? null;
}
const usDate = (value) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};
const longDate = (value) => {
  const parsed = new Date(`${value.trim()} 00:00:00 UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};
const cellText = (html) => decodeXmlEntities(html.replace(/<[^>]+>/g, ' ')).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Rows of the State Department's all-locations table: nine cells, the first a country and the last a date. */
export function parseStatePerDiem(html, byName) {
  const rows = [];
  const unmatched = new Set();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
    if (cells.length !== 9 || !usDate(cells[8]) || !/^\d+$/.test(cells[4]) || !/^\d+$/.test(cells[5])) continue;
    const [country, locality, begin, end, lodging, meals, , footnote, effective] = cells;
    const iso = stateCountryIso(country, byName);
    if (!iso && !STATE_NOT_A_COUNTRY.has(country.toLowerCase())) unmatched.add(country);
    const fullYear = begin === '01/01' && end === '12/31';
    rows.push({
      source: 'us_state_foreign_per_diem',
      country,
      iso,
      locality,
      restOfCountry: /^other$/i.test(locality),
      lodgingUsd: Number(lodging) > 0 ? Number(lodging) : null,
      mealsUsd: Number(meals) > 0 ? Number(meals) : null,
      season: fullYear ? null : { begin, end },
      effectiveDate: usDate(effective),
      footnote: footnote === 'View',
    });
  }
  return { rows, unmatched: [...unmatched].sort() };
}

function readXlsxRows(file) {
  const read = (member) => execFileSync('unzip', ['-p', file, member], { maxBuffer: 1 << 28 }).toString('utf8');
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decodeXmlEntities(m[1].replace(/<[^>]+>/g, '')));
  const rows = [];
  for (const row of read('xl/worksheets/sheet1.xml').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[3] ?? '');
      if (v) cells[c[1]] = /t="s"/.test(c[2]) ? shared[Number(v[1])] : decodeXmlEntities(v[1]);
    }
    rows.push(cells);
  }
  return rows;
}

async function perdiem(cache, { force }) {
  const raw = path.join(cache, 'raw/perdiem');
  fs.mkdirSync(raw, { recursive: true });
  const stateFile = path.join(raw, 'state_all.html');
  if (force || !fs.existsSync(stateFile)) {
    const response = await fetch('https://allowances.state.gov/web920/per_diem_action.asp?MenuHide=1', {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'CountryCode=0000',
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`State per diem answered ${response.status}`);
    fs.writeFileSync(stateFile, Buffer.from(await response.arrayBuffer()));
  }
  const byName = countryNames();
  const state = parseStatePerDiem(fs.readFileSync(stateFile, 'latin1'), byName);
  if (state.rows.length < 800) throw new Error(`State per diem: only ${state.rows.length} rows parsed — the page layout changed`);

  /* GSA renames the file every year; the page says which is current. */
  const page = path.join(raw, 'gsa_files.html');
  await download('https://www.gsa.gov/travel/plan-a-trip/per-diem-rates/per-diem-files', page, { force });
  const files = [...fs.readFileSync(page, 'utf8').matchAll(/href="(https:\/\/www\.gsa\.gov\/system\/files\/FY(\d{4})[^"]*\.xlsx)"/g)]
    .filter((m) => !/zip/i.test(m[1]))
    .sort((a, b) => Number(b[2]) - Number(a[2]));
  if (files.length === 0) throw new Error('GSA per-diem page: no master rates file found');
  const [, gsaUrl, fiscalYear] = files[0];
  const gsaFile = path.join(raw, `gsa_fy${fiscalYear}.xlsx`);
  await download(gsaUrl, gsaFile, { force });
  const gsaRows = [];
  for (const cell of readXlsxRows(gsaFile)) {
    if (!/^\d+(\.\d+)?$/.test(cell.F ?? '') || !/^\d+(\.\d+)?$/.test(cell.G ?? '') || !cell.B) continue;
    const begin = longDate(cell.D ?? '');
    const end = longDate(cell.E ?? '');
    const fullYear = begin?.endsWith('-10-01') && end?.endsWith('-09-30');
    const standard = /^Standard CONUS/i.test(cell.B);
    gsaRows.push({
      source: 'us_gsa_per_diem',
      country: 'United States',
      iso: 'US',
      locality: standard ? 'Standard CONUS' : cell.B,
      state: cell.A ?? null,
      county: cell.C ?? null,
      restOfCountry: standard,
      lodgingUsd: Number(cell.F),
      mealsUsd: Number(cell.G),
      season: fullYear ? null : { begin, end },
      effectiveDate: `${Number(fiscalYear) - 1}-10-01`,
    });
  }
  if (gsaRows.length < 300) throw new Error(`GSA per diem: only ${gsaRows.length} rows parsed — the workbook layout changed`);

  const rows = [...state.rows, ...gsaRows];
  const out = path.join(cache, 'work/perdiem.ndjson');
  fs.writeFileSync(`${out}.tmp`, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  fs.renameSync(`${out}.tmp`, out);
  const years = new Map();
  for (const row of state.rows) tally(years, row.effectiveDate.slice(0, 4));
  const stats = {
    generatedAt: new Date().toISOString(),
    gsaFile: gsaUrl,
    state: {
      rows: state.rows.length,
      localities: new Set(state.rows.map((r) => `${r.iso}|${r.locality}`)).size,
      countries: new Set(state.rows.map((r) => r.iso).filter(Boolean)).size,
      seasonalRows: state.rows.filter((r) => r.season).length,
      withoutLodging: state.rows.filter((r) => r.lodgingUsd === null).length,
      unmatchedCountries: state.unmatched,
      effectiveYears: Object.fromEntries([...years].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    },
    gsa: { rows: gsaRows.length, localities: new Set(gsaRows.map((r) => `${r.state}|${r.locality}`)).size, seasonalRows: gsaRows.filter((r) => r.season).length },
  };
  fs.writeFileSync(path.join(cache, 'work/perdiem-stats.json'), `${JSON.stringify(stats, null, 1)}\n`);
  say(`wrote ${path.relative(process.cwd(), out)}: ${state.rows.length} State rows, ${gsaRows.length} GSA rows; unmatched countries: ${state.unmatched.join(', ') || 'none'}`);
}

/* ------------------------------------------------------------------------ */
/* validate — coverage, agreement, noise, age, and which signals earn weight */
/* ------------------------------------------------------------------------ */

const median = (values) => quantile([...values].sort((a, b) => a - b), 0.5);
const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
const sd = (values) => {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
};
const r3 = (value) => (value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(3)));
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
function shuffled(values, rnd) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Ordinary least squares with an intercept and a whisper of ridge. @returns coefficient vector, intercept first. */
export function ols(X, y) {
  const n = X.length;
  const p = X[0].length + 1;
  const A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < n; i += 1) {
    const row = [1, ...X[i]];
    for (let a = 0; a < p; a += 1) {
      for (let b = 0; b < p; b += 1) A[a][b] += row[a] * row[b];
      A[a][p] += row[a] * y[i];
    }
  }
  for (let a = 1; a < p; a += 1) A[a][a] += 1e-6;
  for (let c = 0; c < p; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < p; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
    [A[c], A[pivot]] = [A[pivot], A[c]];
    for (let r = 0; r < p; r += 1) {
      if (r === c || A[c][c] === 0) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= p; k += 1) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => (row[i] === 0 ? 0 : row[p] / row[i]));
}
const applyOls = (beta, row) => beta[0] + row.reduce((s, v, i) => s + v * beta[i + 1], 0);

/** Held-out predictions, `folds` folds assigned in row order after a seeded shuffle (folds = n: leave-one-out). */
function heldOut(X, y, folds, seed = 11) {
  const n = X.length;
  const order = shuffled(X.map((_, i) => i), seeded(seed));
  const fold = new Array(n);
  order.forEach((index, at) => {
    fold[index] = at % folds;
  });
  const predictions = new Array(n);
  for (let f = 0; f < folds; f += 1) {
    const train = X.map((_, i) => i).filter((i) => fold[i] !== f);
    const beta = ols(train.map((i) => X[i]), train.map((i) => y[i]));
    for (let i = 0; i < n; i += 1) if (fold[i] === f) predictions[i] = applyOls(beta, X[i]);
  }
  return predictions;
}
function scoreLog(predicted, actual) {
  const residuals = predicted.map((p, i) => actual[i] - p);
  const ybar = mean(actual);
  const sst = actual.reduce((s, v) => s + (v - ybar) ** 2, 0);
  const sse = residuals.reduce((s, v) => s + v * v, 0);
  const abs = residuals.map((v) => Math.abs(v));
  return { n: actual.length, r2: r3(1 - sse / sst), maeLog: r3(mean(abs)), medianFactorOff: r3(Math.exp(median(abs))), residualSdLog: r3(sd(residuals)), p80RangeFactor: r3(Math.exp(1.2816 * sd(residuals))), spearman: r3(spearman(predicted, actual)) };
}
const residualise = (y, x) => {
  const beta = ols(x.map((v) => [v]), y);
  return y.map((v, i) => v - applyOls(beta, [x[i]]));
};
const normalName = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function validate(cache) {
  const work = path.join(cache, 'work');
  const curated = JSON.parse(fs.readFileSync(path.join(work, 'curated.json'), 'utf8'));
  const places = await loadPlaces(cache);
  const priceOf = (iso) => curated.priceLevels[iso]?.c ?? curated.priceLevels[iso]?.g ?? null;
  const summaries = fs.readFileSync(path.join(work, 'prices.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const summaryOf = new Map(summaries.map((row) => [row.title, row]));

  /* ── Dated observations in each bucket, with the page's ancestry ── */
  const rawObs = [];
  await lines(path.join(work, 'price-observations.ndjson'), (line) => {
    const o = JSON.parse(line);
    if (o.status === 'ok' && o.usd !== undefined && o.bucket) rawObs.push(o);
  });
  const allFailures = { bbDoubleTemplate: 0, bbDoubleByCountry: new Map() };
  const tierOffsetRows = { budget: [], mid: [], splurge: [] };
  const byBucket = { sleep: [], eat: [], entry: [] };
  for (const o of rawObs) {
    if (!byBucket[o.bucket]) continue;
    const place = places.candidates.get(o.destination);
    const chain = place.parents.map((id) => id.slice(3));
    byBucket[o.bucket].push({ d: o.destination, iso: o.iso, chain, usdReal: o.usdReal, usd: o.usd, year: o.year, tier: o.tier, bound: o.bound, raw: o.raw, realBasis: o.realBasis, fxGap: o.fxGapYears, fxCaveat: Boolean(o.fxCaveat), l: Math.log(o.usdReal) });
    if (o.bucket === 'sleep' && /^(?:hotel )?b&b doubles? /i.test(o.raw)) {
      allFailures.bbDoubleTemplate += 1;
      tally(allFailures.bbDoubleByCountry, o.iso);
    }
  }

  /* Tier composition: how far each tier sits from its country's median, so a page listing only hostels is not read as a cheap place. */
  const countryMedian = (bucket) => {
    const by = new Map();
    for (const o of byBucket[bucket]) if (o.iso) (by.get(o.iso) ?? by.set(o.iso, []).get(o.iso)).push(o.l);
    return new Map([...by].filter(([, v]) => v.length >= 20).map(([iso, v]) => [iso, median(v)]));
  };
  const sleepCountry = countryMedian('sleep');
  for (const o of byBucket.sleep) if (o.tier && sleepCountry.has(o.iso)) tierOffsetRows[o.tier].push(o.l - sleepCountry.get(o.iso));
  const tierOffset = { budget: median(tierOffsetRows.budget), mid: median(tierOffsetRows.mid), splurge: median(tierOffsetRows.splurge) };
  for (const o of byBucket.sleep) o.adj = o.l - (o.tier ? tierOffset[o.tier] : 0);

  const own = (bucket) => {
    const m = new Map();
    for (const o of byBucket[bucket]) (m.get(o.d) ?? m.set(o.d, []).get(o.d)).push(o);
    return m;
  };
  const ownSleep = own('sleep');
  const ownEat = own('eat');
  const ownEntry = own('entry');
  const descendantPool = (bucket) => {
    const m = new Map();
    for (const o of byBucket[bucket]) {
      (m.get(o.d) ?? m.set(o.d, []).get(o.d)).push(o);
      for (const a of o.chain) (m.get(a) ?? m.set(a, []).get(a)).push(o);
    }
    return m;
  };
  const poolSleep = descendantPool('sleep');
  const poolEat = descendantPool('eat');
  const poolEntry = descendantPool('entry');
  const logMed = (list, key = 'l') => median(list.map((o) => o[key]));

  /* ── 1. Coverage ── */
  const addCoverage = (table, key, row) => {
    const c = (table[key] ??= { destinations: 0, sleep1: 0, sleep3: 0, sleep5: 0, sleep10: 0, eat3: 0, entry3: 0, anySignal: 0 });
    c.destinations += 1;
    if (!row) return;
    const s = row.sleep?.n ?? 0;
    if (s >= 1) c.sleep1 += 1;
    if (s >= 3) c.sleep3 += 1;
    if (s >= 5) c.sleep5 += 1;
    if (s >= 10) c.sleep10 += 1;
    if ((row.eat?.n ?? 0) >= 3) c.eat3 += 1;
    if ((row.entry?.n ?? 0) >= 3) c.entry3 += 1;
    if (s >= 1 || row.eat || row.entry?.n > 0) c.anySignal += 1;
  };
  const byRegion = {};
  const byType = {};
  const overall = {};
  for (const [title, place] of places.candidates) {
    if (place.scopeOnly) continue;
    const row = summaryOf.get(title);
    addCoverage(byRegion, (place.iso && worldRegionFor(place.iso, place.lat, place.lng)) || 'unknown', row);
    addCoverage(byType, place.wvType, row);
    addCoverage(overall, 'wikivoyage_destinations', row);
  }

  /* ── 2. Noise: two disjoint samples of n listings from one destination ── */
  const rnd = seeded(2026);
  const splitHalf = {};
  for (const n of [1, 2, 3, 5, 8, 12]) {
    const diffs = [];
    const a = [];
    const b = [];
    const diffsAdj = [];
    for (const [, list] of ownSleep) {
      if (list.length < 2 * n) continue;
      const pick = shuffled(list, rnd);
      const x = pick.slice(0, n);
      const y = pick.slice(n, 2 * n);
      diffs.push(logMed(x) - logMed(y));
      diffsAdj.push(logMed(x, 'adj') - logMed(y, 'adj'));
      a.push(logMed(x));
      b.push(logMed(y));
    }
    if (diffs.length < 30) continue;
    const errorSd = sd(diffs) / Math.SQRT2;
    splitHalf[n] = { destinations: diffs.length, oneEstimateSdLog: r3(errorSd), p80RangeFactor: r3(Math.exp(1.2816 * errorSd)), tierAdjustedSdLog: r3(sd(diffsAdj) / Math.SQRT2), halfVsHalfSpearman: r3(spearman(a, b)) };
  }

  /* ── 3. Age: the same destination, old listings against listings from 2024–26 ── */
  const NOW = 2026;
  const ageBands = [['0-2y', 0, 2], ['3-5y', 3, 5], ['6-8y', 6, 8], ['9y+', 9, 99]];
  const age = {};
  for (const [label, lo, hi] of ageBands) {
    const reals = [];
    const nominals = [];
    const x = [];
    const y = [];
    for (const [, list] of ownSleep) {
      const fresh = list.filter((o) => o.year >= NOW - 2);
      const band = lo === 0 ? null : list.filter((o) => NOW - o.year >= lo && NOW - o.year <= hi);
      if (lo === 0) {
        if (fresh.length < 6) continue;
        const pick = shuffled(fresh, rnd);
        const p = pick.slice(0, 3);
        const q = pick.slice(3, 6);
        reals.push(logMed(p) - logMed(q));
        x.push(logMed(p));
        y.push(logMed(q));
        continue;
      }
      if (fresh.length < 3 || band.length < 3) continue;
      const p = shuffled(band, rnd).slice(0, 3);
      const q = shuffled(fresh, rnd).slice(0, 3);
      reals.push(logMed(q) - logMed(p));
      nominals.push(median(q.map((o) => Math.log(o.usd))) - median(p.map((o) => Math.log(o.usd))));
      x.push(logMed(p));
      y.push(logMed(q));
    }
    if (reals.length < 15) {
      age[label] = { destinations: reals.length, note: 'too few pairs' };
      continue;
    }
    age[label] = { destinations: reals.length, medianRealLogChange: r3(median(reals)), medianNominalLogChange: nominals.length ? r3(median(nominals)) : null, sdRealLogDiff: r3(sd(reals)), spearmanVsFresh: r3(spearman(x, y)) };
  }

  /* ── 4. Within-country spread ── */
  const destinations = [...ownSleep].filter(([, list]) => list.length >= 3).map(([title, list]) => ({ title, list, iso: list[0].iso, m: logMed(list), a: logMed(list, 'adj'), n: list.length, type: places.candidates.get(title).wvType }));
  const groups = new Map();
  for (const d of destinations) if (d.iso) (groups.get(d.iso) ?? groups.set(d.iso, []).get(d.iso)).push(d);
  const big = [...groups].filter(([, v]) => v.length >= 8);
  const grand = mean(big.flatMap(([, v]) => v.map((d) => d.m)));
  let between = 0;
  let within = 0;
  let total = 0;
  for (const [, v] of big) {
    const cm = mean(v.map((d) => d.m));
    for (const d of v) {
      between += (cm - grand) ** 2;
      within += (d.m - cm) ** 2;
      total += 1;
    }
  }
  const noiseVar = splitHalf[3] ? splitHalf[3].oneEstimateSdLog ** 2 : null;
  const spreadRows = big
    .map(([iso, v]) => {
      const sorted = v.map((d) => d.m).sort((a, b) => a - b);
      return { iso, destinations: v.length, sdLog: r3(sd(v.map((d) => d.m))), p90OverP10: r3(Math.exp(quantile(sorted, 0.9) - quantile(sorted, 0.1))), medianUsd: Math.round(Math.exp(median(sorted))), worldBankPriceLevel: priceOf(iso) };
    })
    .sort((a, b) => b.destinations - a.destinations);
  const typeEffect = {};
  for (const type of ['city', 'ruralarea', 'park', 'region']) {
    const deltas = big.flatMap(([, v]) => {
      const cm = median(v.map((d) => d.m));
      return v.filter((d) => d.type === type).map((d) => d.m - cm);
    });
    if (deltas.length >= 10) typeEffect[type] = { destinations: deltas.length, medianLogVsCountry: r3(median(deltas)), asFactor: r3(Math.exp(median(deltas))), sdLog: r3(sd(deltas)) };
  }
  const expensiveInCheap = destinations
    .filter((d) => d.iso && groups.get(d.iso)?.length >= 8 && (priceOf(d.iso) ?? 1) < 0.5 && d.n >= 3)
    .map((d) => ({ title: d.title, iso: d.iso, type: d.type, n: d.n, usdMedian: Math.round(Math.exp(d.m)), countryMedianUsd: Math.round(Math.exp(median(groups.get(d.iso).map((x) => x.m)))) }))
    .map((d) => ({ ...d, factor: r3(d.usdMedian / d.countryMedianUsd) }))
    .sort((a, b) => b.factor - a.factor)
    .slice(0, 20);

  /* ── 5. Agreement with the curated editorial cost label ── */
  const twins = [...places.candidates].filter(([, p]) => p.curated).map(([title, p]) => ({ title, entry: curated.entries.find((e) => e.id === p.curated), iso: p.iso })).filter((t) => t.entry);
  const wbOf = (t) => priceOf(t.entry.countries[0]);
  const agreement = (pool, { minN, since = 0, key = 'l' }) => {
    const rows = [];
    for (const t of twins) {
      const list = (pool.get(t.title) ?? []).filter((o) => o.year >= since);
      const wb = wbOf(t);
      if (list.length < minN || wb === null) continue;
      rows.push({ cost: t.entry.cost, value: logMed(list, key), wb: Math.log(wb) });
    }
    if (rows.length < 12) return { n: rows.length };
    const cost = rows.map((r) => r.cost);
    const value = rows.map((r) => r.value);
    const wb = rows.map((r) => r.wb);
    return { n: rows.length, spearmanSignal: r3(spearman(cost, value)), spearmanCountryPriceLevel: r3(spearman(cost, wb)), signalBeyondCountry: r3(spearman(residualise(cost, wb), residualise(value, wb))) };
  };
  const curatedAgreement = {
    sleepOwnPage: Object.fromEntries([1, 3, 5, 10].map((minN) => [`n>=${minN}`, agreement(ownSleep, { minN })])),
    sleepWithDescendants: Object.fromEntries([1, 3, 5, 10, 20].map((minN) => [`n>=${minN}`, agreement(poolSleep, { minN })])),
    sleepTierAdjusted: Object.fromEntries([3, 5, 10, 20].map((minN) => [`n>=${minN}`, agreement(poolSleep, { minN, key: 'adj' })])),
    eatWithDescendants: Object.fromEntries([3, 5, 10, 20].map((minN) => [`n>=${minN}`, agreement(poolEat, { minN })])),
    paidEntryWithDescendants: Object.fromEntries([3, 5, 10, 20].map((minN) => [`n>=${minN}`, agreement(poolEntry, { minN })])),
    sleepByRecency: Object.fromEntries([0, 2016, 2019, 2021, 2023].map((since) => [since ? `year>=${since}` : 'all years', agreement(poolSleep, { minN: 5, since })])),
  };

  /* Held-out cost on the 1–4 scale: does the evidence beat the country level? */
  const scale = (predicted, actual) => {
    const clamped = predicted.map((p) => Math.min(4, Math.max(1, p)));
    return { n: actual.length, mae: r3(mean(clamped.map((p, i) => Math.abs(p - actual[i])))), spearman: r3(spearman(clamped, actual)) };
  };
  const curatedRows = twins
    .map((t) => {
      const wb = wbOf(t);
      if (wb === null) return null;
      const sleep = poolSleep.get(t.title) ?? [];
      const eat = poolEat.get(t.title) ?? [];
      return { cost: t.entry.cost, wb: Math.log(wb), title: t.title, sleepN: sleep.length, sleep: sleep.length >= 5 ? logMed(sleep, 'adj') : null, eatN: eat.length, eat: eat.length >= 5 ? logMed(eat) : null };
    })
    .filter(Boolean);
  const withSleep = curatedRows.filter((r) => r.sleep !== null);
  const y = withSleep.map((r) => r.cost);
  const looModels = {
    subsetWithSleepEvidence: {
      n: withSleep.length,
      countryOnly: scale(heldOut(withSleep.map((r) => [r.wb]), y, withSleep.length), y),
      sleepOnly: scale(heldOut(withSleep.map((r) => [r.sleep]), y, withSleep.length), y),
      countryPlusSleep: scale(heldOut(withSleep.map((r) => [r.wb, r.sleep]), y, withSleep.length), y),
    },
  };
  const withBoth = withSleep.filter((r) => r.eat !== null);
  if (withBoth.length >= 25) {
    const yb = withBoth.map((r) => r.cost);
    looModels.subsetWithSleepAndEat = {
      n: withBoth.length,
      countryOnly: scale(heldOut(withBoth.map((r) => [r.wb]), yb, withBoth.length), yb),
      countryPlusSleep: scale(heldOut(withBoth.map((r) => [r.wb, r.sleep]), yb, withBoth.length), yb),
      countryPlusSleepPlusEat: scale(heldOut(withBoth.map((r) => [r.wb, r.sleep, r.eat]), yb, withBoth.length), yb),
    };
  }
  /* Every twin: where evidence is thin the sleep term is zero and the model is the country level. */
  const wbMean = mean(curatedRows.filter((r) => r.sleep !== null).map((r) => r.sleep - r.wb));
  const allY = curatedRows.map((r) => r.cost);
  looModels.allTwins = {
    n: curatedRows.length,
    withEvidence: withSleep.length,
    countryOnly: scale(heldOut(curatedRows.map((r) => [r.wb]), allY, curatedRows.length), allY),
    countryPlusSleepWhereKnown: scale(heldOut(curatedRows.map((r) => [r.wb, r.sleep === null ? 0 : r.sleep - r.wb - wbMean]), allY, curatedRows.length), allY),
  };

  /* ── 6. Per diem against listings ── */
  let perdiemMatch = null;
  const perdiemOf = new Map();
  const perdiemFile = path.join(work, 'perdiem.ndjson');
  if (fs.existsSync(perdiemFile)) {
    const rows = fs.readFileSync(perdiemFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((r) => r.iso && r.lodgingUsd !== null && !r.restOfCountry);
    const byLocality = new Map();
    for (const r of rows) (byLocality.get(`${r.iso}|${normalName(r.locality)}`) ?? byLocality.set(`${r.iso}|${normalName(r.locality)}`, []).get(`${r.iso}|${normalName(r.locality)}`)).push(r);
    const names = new Map();
    for (const [title, place] of places.candidates) {
      if (!place.iso || place.scopeOnly || place.wvType === 'country') continue;
      const key = `${place.iso}|${normalName(title.split('/')[0])}`;
      (names.get(key) ?? names.set(key, []).get(key)).push(title);
    }
    let unique = 0;
    let ambiguous = 0;
    for (const [key, list] of byLocality) {
      const titles = names.get(key);
      if (!titles) continue;
      if (titles.length > 1) {
        ambiguous += 1;
        continue;
      }
      unique += 1;
      const seasons = list.map((r) => r.lodgingUsd);
      perdiemOf.set(titles[0], { lodging: mean(seasons), meals: mean(list.map((r) => r.mealsUsd).filter(Boolean)), source: list[0].source });
    }
    const pairs = [...perdiemOf].map(([title, p]) => ({ title, p, list: ownSleep.get(title) ?? [], iso: places.candidates.get(title).iso })).filter((x) => x.list.length >= 3);
    const within = (subset) => {
      const g = new Map();
      for (const x of subset) (g.get(x.iso) ?? g.set(x.iso, []).get(x.iso)).push(x);
      const a = [];
      const b = [];
      for (const [, v] of g) {
        if (v.length < 3) continue;
        const ma = mean(v.map((x) => Math.log(x.p.lodging)));
        const mb = mean(v.map((x) => logMed(x.list)));
        for (const x of v) {
          a.push(Math.log(x.p.lodging) - ma);
          b.push(logMed(x.list) - mb);
        }
      }
      return { n: a.length, spearman: r3(spearman(a, b)) };
    };
    const state = pairs.filter((x) => x.p.source === 'us_state_foreign_per_diem');
    const gsa = pairs.filter((x) => x.p.source === 'us_gsa_per_diem');
    const ratio = pairs.map((x) => Math.log(x.p.lodging) - logMed(x.list));
    perdiemMatch = {
      localitiesWithRates: byLocality.size,
      exactUniqueMatchesToAtlas: unique,
      ambiguousNamesLeftOut: ambiguous,
      matchedWithAtLeast3SleepListings: pairs.length,
      lodgingVsListings: {
        state: { n: state.length, spearman: r3(spearman(state.map((x) => x.p.lodging), state.map((x) => logMed(x.list)))), withinCountry: within(state) },
        gsa: { n: gsa.length, spearman: r3(spearman(gsa.map((x) => x.p.lodging), gsa.map((x) => logMed(x.list)))) },
      },
      perDiemOverListingMedianFactor: { median: r3(Math.exp(median(ratio))), p10: r3(Math.exp(quantile([...ratio].sort((a, b) => a - b), 0.1))), p90: r3(Math.exp(quantile([...ratio].sort((a, b) => a - b), 0.9))) },
    };
  }

  /* ── 7. Which signals predict a held-out destination's own listings ── */
  const countryLists = new Map();
  for (const o of byBucket.sleep) if (o.iso) (countryLists.get(o.iso) ?? countryLists.set(o.iso, []).get(o.iso)).push(o);
  const excluding = (list, title) => list.filter((o) => o.d !== title && !o.chain.includes(title));
  const modelRows = [];
  for (const [title, list] of ownSleep) {
    if (list.length < 5) continue;
    const place = places.candidates.get(title);
    const wb = place.iso ? priceOf(place.iso) : null;
    if (wb === null) continue;
    const country = excluding(countryLists.get(place.iso) ?? [], title);
    if (country.length < 20) continue;
    const countryLog = logMed(country, 'adj');
    const chain = place.parents.map((id) => id.slice(3));
    const sibling = chain[0] ? excluding(poolSleep.get(chain[0]) ?? [], title) : [];
    const region = chain[1] ? excluding(poolSleep.get(chain[1]) ?? [], title) : [];
    const hier = sibling.length >= 5 ? logMed(sibling, 'adj') : region.length >= 5 ? logMed(region, 'adj') : countryLog;
    const eat = ownEat.get(title) ?? [];
    const p = perdiemOf.get(title);
    modelRows.push({ title, actual: logMed(list, 'adj'), n: list.length, wb: Math.log(wb), countryLog, hier, hasSibling: sibling.length >= 5 ? 1 : 0, park: place.wvType === 'park' ? 1 : 0, rural: place.wvType === 'ruralarea' ? 1 : 0, region: place.wvType === 'region' ? 1 : 0, eat: eat.length >= 3 ? logMed(eat) : null, perdiem: p ? Math.log(p.lodging) : null });
  }
  const fit = (rows, features) => scoreLog(heldOut(rows.map((r) => features.map((f) => r[f])), rows.map((r) => r.actual), 5), rows.map((r) => r.actual));
  const nestedModels = {
    allDestinationsWith5Listings: {
      worldBankPriceLevel: fit(modelRows, ['wb']),
      countryListingMedian: fit(modelRows, ['countryLog']),
      countryListingsPlusWorldBank: fit(modelRows, ['countryLog', 'wb']),
      plusHierarchy: fit(modelRows, ['countryLog', 'wb', 'hier']),
      plusHierarchyAndType: fit(modelRows, ['countryLog', 'wb', 'hier', 'park', 'rural', 'region']),
    },
  };
  const withEat = modelRows.filter((r) => r.eat !== null);
  if (withEat.length >= 100) {
    nestedModels.subsetWithOwnEatListings = {
      n: withEat.length,
      withoutEat: fit(withEat, ['countryLog', 'wb', 'hier', 'park', 'rural', 'region']),
      withEat: fit(withEat, ['countryLog', 'wb', 'hier', 'park', 'rural', 'region', 'eat']),
    };
  }
  const withPerdiem = modelRows.filter((r) => r.perdiem !== null);
  if (withPerdiem.length >= 40) {
    nestedModels.subsetWithExactPerDiemMatch = {
      n: withPerdiem.length,
      withoutPerDiem: fit(withPerdiem, ['countryLog', 'wb', 'hier']),
      withPerDiem: fit(withPerdiem, ['countryLog', 'wb', 'hier', 'perdiem']),
      perDiemAlone: fit(withPerdiem, ['perdiem']),
    };
  }
  const finalBeta = ols(modelRows.map((r) => [r.countryLog, r.wb, r.hier, r.park, r.rural, r.region]), modelRows.map((r) => r.actual));

  /* ── 7b. Age at listing level: each old listing against the same destination's listings from 2023 on ── */
  const ageWithin = {};
  for (const [label, lo, hi] of [['0-1y', 0, 1], ['2-3y', 2, 3], ['4-5y', 4, 5], ['6-7y', 6, 7], ['8-9y', 8, 9], ['10y+', 10, 99]]) {
    const deltas = [];
    const destinationsSeen = new Set();
    for (const [title, list] of ownSleep) {
      const anchorList = list.filter((o) => o.year >= NOW - 3);
      if (anchorList.length < 2) continue;
      for (const o of list) {
        const a = NOW - o.year;
        if (a < lo || a > hi) continue;
        const rest = anchorList.filter((x) => x !== o);
        if (rest.length < 2) continue;
        deltas.push(o.adj - median(rest.map((x) => x.adj)));
        destinationsSeen.add(title);
      }
    }
    if (deltas.length >= 20) ageWithin[label] = { listings: deltas.length, destinations: destinationsSeen.size, medianLogVsFresh: r3(median(deltas)), asFactor: r3(Math.exp(median(deltas))), sdLog: r3(sd(deltas)), madLog: r3(median(deltas.map((d) => Math.abs(d - median(deltas))))) };
  }

  /* "From" prices against exact ones and ranges on the same page: how low does the floor read? */
  const fromDeltas = [];
  for (const [, list] of ownSleep) {
    const from = list.filter((o) => o.bound === 'from');
    const exact = list.filter((o) => o.bound !== 'from');
    if (from.length >= 2 && exact.length >= 2) fromDeltas.push(logMed(from, 'adj') - logMed(exact, 'adj'));
  }

  /* How many destinations could borrow from their hierarchy. */
  let reachOwn = 0;
  let reachSibling = 0;
  let reachRegion = 0;
  let reachCountry = 0;
  let reachNone = 0;
  for (const [title, place] of places.candidates) {
    if (place.scopeOnly) continue;
    const chain = place.parents.map((id) => id.slice(3));
    if ((poolSleep.get(title)?.length ?? 0) >= 5) reachOwn += 1;
    else if (chain[0] && (poolSleep.get(chain[0])?.length ?? 0) >= 5 && places.pages.get(chain[0])?.type !== 'country') reachSibling += 1;
    else if (chain[1] && (poolSleep.get(chain[1])?.length ?? 0) >= 5 && places.pages.get(chain[1])?.type !== 'country') reachRegion += 1;
    else if (place.iso && (countryLists.get(place.iso)?.length ?? 0) >= 20) reachCountry += 1;
    else reachNone += 1;
  }

  /* Within-country spread among destinations with at least five listings, where sampling noise is smaller and known. */
  const big5 = big.map(([iso, v]) => [iso, v.filter((d) => d.n >= 5)]).filter(([, v]) => v.length >= 4);
  let within5 = 0;
  let total5 = 0;
  for (const [, v] of big5) {
    const cm = mean(v.map((d) => d.a));
    for (const d of v) {
      within5 += (d.a - cm) ** 2;
      total5 += 1;
    }
  }
  const noise5 = splitHalf[5] ? splitHalf[5].tierAdjustedSdLog ** 2 : null;

  /* ── 8. Failure modes, counted ── */
  const sleepObs = byBucket.sleep;
  const ratioSpread = summaries.filter((r) => r.sleep?.n >= 5 && r.sleep.usdRealP25 > 0).map((r) => r.sleep.usdRealP75 / r.sleep.usdRealP25);
  const failure = {
    sleepObservations: sleepObs.length,
    lowerBoundsReadAsValue: sleepObs.filter((o) => o.bound === 'from').length,
    fxOfficialRateCaveat: sleepObs.filter((o) => o.fxCaveat).length,
    fxRateFromAnotherYear: sleepObs.filter((o) => o.fxGap > 0).length,
    usCpiFallbackDeflator: sleepObs.filter((o) => o.realBasis === 'us_cpi_fallback').length,
    templatedBBDoubleStrings: allFailures.bbDoubleTemplate,
    templatedBBDoubleTopCountries: Object.fromEntries([...allFailures.bbDoubleByCountry].sort((a, b) => b[1] - a[1]).slice(0, 6)),
    tierShares: { budget: sleepObs.filter((o) => o.tier === 'budget').length, mid: sleepObs.filter((o) => o.tier === 'mid').length, splurge: sleepObs.filter((o) => o.tier === 'splurge').length, untiered: sleepObs.filter((o) => !o.tier).length },
    tierOffsetsFromCountryMedianAsFactor: { budget: r3(Math.exp(tierOffset.budget)), mid: r3(Math.exp(tierOffset.mid)), splurge: r3(Math.exp(tierOffset.splurge)) },
    destinationsWithSleep5: ratioSpread.length,
    interquartileRatioMedian: r3(median(ratioSpread)),
    destinationsWithInterquartileRatioOver5: ratioSpread.filter((v) => v > 5).length,
    destinationsWhoseEverySleepListingIsOneTier: summaries.filter((r) => r.sleep?.n >= 3 && Object.keys(r.sleep.tiers).length === 1 && r.sleep.untiered === 0).length,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    coverage: { overall: overall.wikivoyage_destinations, byWorldRegion: byRegion, byType, dataOnlyRowsHaveNoListings: 7804 },
    splitHalfNoiseSleep: splitHalf,
    ageAgainstFresh2024to2026: age,
    ageListingVsFreshSameDestination: ageWithin,
    fromPriceVsOthersSamePage: { destinations: fromDeltas.length, medianLog: r3(median(fromDeltas)), asFactor: r3(Math.exp(median(fromDeltas))) },
    hierarchyReachForAllGuideDestinations: { ownOrDescendantsN5: reachOwn, siblingsN5: reachSibling, regionN5: reachRegion, countryOnlyN20: reachCountry, nothing: reachNone },
    withinCountry: { countriesWith8Destinations: big.length, destinations: total, shareOfVarianceBetweenCountries: r3(between / (between + within)), shareWithinCountries: r3(within / (between + within)), withinCountrySdLogRaw: r3(Math.sqrt(within / total)), samplingNoiseVarianceAtN3: r3(noiseVar), withinCountrySdLogNoiseCorrected: noiseVar === null ? null : r3(Math.sqrt(Math.max(0, within / total - noiseVar))), n5TierAdjusted: { destinations: total5, sdLogRaw: r3(Math.sqrt(within5 / total5)), noiseVariance: r3(noise5), sdLogNoiseCorrected: noise5 === null ? null : r3(Math.sqrt(Math.max(0, within5 / total5 - noise5))) }, typeEffect, countries: spreadRows, expensiveInCheapCountries: expensiveInCheap },
    curatedAgreement,
    curatedHeldOutCost1to4: looModels,
    perDiem: perdiemMatch,
    nestedModels,
    finalModelCoefficients: { intercept: r3(finalBeta[0]), countryListings: r3(finalBeta[1]), worldBank: r3(finalBeta[2]), hierarchy: r3(finalBeta[3]), park: r3(finalBeta[4]), rural: r3(finalBeta[5]), region: r3(finalBeta[6]), trainedOn: modelRows.length },
    failureModes: failure,
  };
  fs.writeFileSync(path.join(work, 'prices-validation.json'), `${JSON.stringify(report, null, 1)}\n`);
  say(`wrote ${path.relative(process.cwd(), path.join(work, 'prices-validation.json'))}`);
}

/* ------------------------------------------------------------------------ */
/* Main                                                                      */
/* ------------------------------------------------------------------------ */

async function main() {
  const cache = path.resolve(process.env.ATLAS_CACHE || '.atlas-cache');
  const [command = 'extract', ...flags] = process.argv.slice(2);
  const force = flags.includes('--download');
  if (command === 'fx') await buildFx(cache, { force });
  else if (command === 'extract') await extract(cache);
  else if (command === 'perdiem') await perdiem(cache, { force });
  else if (command === 'validate') await validate(cache);
  else throw new Error(`unknown command "${command}" — expected fx, extract, perdiem or validate`);
}

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

