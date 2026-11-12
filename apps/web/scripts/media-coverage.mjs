/**
 * How many curated advisor destinations get a real photograph per frame.
 *
 * Not a test: it asks Wikimedia live (politely — one request at a time, at
 * least 1.2 s apart, honouring Retry-After once) and prints a table. Runs the
 * same selection code the product runs (`lib/media/resolve.ts` + `select.ts`),
 * without downloading renditions for focal points.
 *
 * "Before" is estimated from the same answers: the previous imagery ladder took
 * the first licensable file among the item's own P948 (7:1 banner), P18 and
 * P3451, and the advisor card drew it letterboxed into a 16:9 frame — so a
 * banner became a narrow strip. Later rungs of that ladder (article lead image,
 * category, name search) are not replayed here, so "before" undercounts places
 * that only those rungs reached.
 *
 * Usage:
 *   node apps/web/scripts/media-coverage.mjs [--limit 60] [--interval 1200] [--only id,id] [--json out.json]
 *
 * Set SIDEQUEST_CONTACT_URL so the User-Agent carries a contact.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const LIMIT = Number(flag('--limit', '60'));
const JSON_OUT = flag('--json', null);
const INTERVAL = Number(flag('--interval', '1200'));
/* Comma-separated catalogue ids, to re-ask only the places a busy service refused last time. */
const ONLY = flag('--only', null)?.split(',') ?? null;

const jiti = createJiti(import.meta.url, {
  alias: {
    'server-only': `${ROOT}vitest.server-only.ts`,
    '@/': `${ROOT}apps/web/src/`,
  },
});

process.env.SIDEQUEST_IMAGERY_PROVIDER = 'wikimedia';
const core = await jiti.import(`${ROOT}packages/core/src/index.ts`);
const { resolveMediaLive } = await jiti.import(`${ROOT}apps/web/src/lib/media/resolve.ts`);

/** One request at a time, ≥1.2 s apart; one polite retry on 429/503. */
let last = 0;
async function politeFetch(input, init) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const wait = last + INTERVAL - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = Date.now();
    const response = await fetch(input, init);
    if ((response.status === 429 || response.status === 503) && attempt === 0) {
      const retry = Math.min(30, Number(response.headers.get('retry-after') ?? '10') || 10);
      await response.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, retry * 1000));
      continue;
    }
    return response;
  }
  return new Response('busy', { status: 429 });
}

/* Spread across the catalogue rather than its first region: every k-th entry with a Wikidata item. */
const catalog = core.destinationCatalog().filter((entry) => entry.wikidataId);
const stride = Math.max(1, Math.floor(catalog.length / LIMIT));
const sample = ONLY ? catalog.filter((entry) => ONLY.includes(entry.id)) : catalog.filter((_, index) => index % stride === 0).slice(0, LIMIT);

/* Capture the candidate pool the resolver sees, to estimate the old ladder's rung (a) from the same answers. */
const rows = [];
for (const entry of sample) {
  const seen = [];
  const recordingFetch = async (input, init) => {
    const response = await politeFetch(input, init);
    const url = new URL(typeof input === 'string' ? input : input.href);
    if (url.hostname === 'www.wikidata.org' && response.ok) {
      const clone = response.clone();
      try {
        const json = await clone.json();
        const claims = json?.entities?.[entry.wikidataId]?.claims ?? {};
        for (const property of ['P948', 'P18', 'P3451']) {
          const value = claims[property]?.find((claim) => claim.rank !== 'deprecated')?.mainsnak?.datavalue?.value;
          if (typeof value === 'string') seen.push({ property, title: `File:${value}` });
        }
      } catch {
        /* ignore */
      }
    }
    return response;
  };
  const subject = {
    wikidataId: entry.wikidataId,
    name: entry.name,
    center: entry.center,
    radiusKm: entry.radiusKm,
    scale: /city|town|village/i.test(entry.kind) ? 'place' : 'region',
  };
  const started = Date.now();
  const { selections, calls } = await resolveMediaLive(subject, { fetchImpl: recordingFetch, measureFocal: false });
  const row = { id: entry.id, name: entry.name, qid: entry.wikidataId, calls, ms: Date.now() - started, stated: seen.map((item) => item.property) };
  for (const [context, selection] of Object.entries(selections)) {
    row[context] = selection.status === 'selected' ? `${selection.origin}${selection.shareAlike ? ' SA' : ''}` : `none:${selection.reason}`;
  }
  /* Old ladder estimate: first stated file in P948 → P18 → P3451 order. A banner first means a strip in a 16:9 card. */
  row.before = seen.length === 0 ? 'later-rungs-or-none' : seen[0].property === 'P948' ? 'banner-strip' : `stated-${seen[0].property}`;
  rows.push(row);
  process.stdout.write(`${entry.name.padEnd(28).slice(0, 28)} hero=${row.hero.padEnd(26)} card=${row.card.padEnd(26)} before=${row.before}\n`);
}

const count = (predicate) => rows.filter(predicate).length;
const summary = {
  sampled: rows.length,
  hero: count((row) => !row.hero.startsWith('none')),
  card: count((row) => !row.card.startsWith('none')),
  thumb: count((row) => !row.thumb.startsWith('none')),
  strip: count((row) => !row.strip.startsWith('none')),
  anyPhoto: count((row) => ['hero', 'card', 'thumb', 'strip'].some((context) => !row[context].startsWith('none'))),
  plateOnCard: count((row) => row.card.startsWith('none')),
  unavailable: count((row) => row.card === 'none:provider_unavailable'),
  before: {
    bannerStrip: count((row) => row.before === 'banner-strip'),
    statedPhoto: count((row) => row.before.startsWith('stated-')),
    laterRungsOrNone: count((row) => row.before === 'later-rungs-or-none'),
  },
  calls: rows.reduce((sum, row) => sum + row.calls, 0),
};
console.log('\n' + JSON.stringify(summary, null, 2));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ summary, rows }, null, 2));
