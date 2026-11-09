/**
 * Pure wikitext helpers for the atlas build (stage 01, Wikivoyage).
 *
 * Nothing here touches the filesystem, the network or a clock, so every
 * function can be unit-tested on a snippet copied out of the dump
 * (`wikitext.test.ts`). The scope is deliberately narrow: this is not a
 * MediaWiki parser. It does the four things the atlas needs —
 *
 *   1. find templates, honouring nested braces        (`scanTemplates`, `parseTemplate`)
 *   2. split an article into its heading tree          (`splitSections`)
 *   3. turn wikitext into plain prose for keyword evidence (`toPlainText`)
 *   4. read wikilink targets as article titles         (`articleLinkTargets`, `toArticleTitle`)
 *
 * — and it prefers losing a fragment to throwing: malformed markup (an
 * unclosed `{{`, a stray `]]`) degrades to slightly noisier text, never to an
 * exception. The dump is untrusted input and one bad page must not stop a run.
 */

/* ------------------------------------------------------------------------ */
/* Entities                                                                  */
/* ------------------------------------------------------------------------ */

const XML_ENTITY = /&(lt|gt|quot|amp|apos|#\d+|#x[0-9a-fA-F]+);/g;
const XML_NAMED = { lt: '<', gt: '>', quot: '"', amp: '&', apos: "'" };

function codePoint(n) {
  // 0, surrogates and out-of-range values would throw or corrupt the string.
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '';
  return String.fromCodePoint(n);
}

/**
 * Decode the XML layer of a MediaWiki export: `&lt; &gt; &amp; &quot; &#NN;`.
 *
 * One pass on purpose. Wikitext may itself contain entities (`&nbsp;`,
 * `&mdash;`), which the export writes as `&amp;nbsp;`; decoding `&amp;` in a
 * separate step first would then decode the wikitext's own `&lt;` into a real
 * `<` and invent tags that were never there.
 */
export function decodeXmlEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(XML_ENTITY, (whole, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return codePoint(n);
    }
    return XML_NAMED[e] ?? whole;
  });
}

/** The HTML entities that actually occur in article prose, plus numeric forms. */
const HTML_NAMED = {
  nbsp: ' ', thinsp: ' ', ensp: ' ', emsp: ' ', zwnj: '', zwj: '', shy: '', lrm: '', rlm: '',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', minus: '−', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', prime: '′', Prime: '″',
  deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', copy: '©', reg: '®', trade: '™',
  times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  micro: 'µ', para: '¶', sect: '§', le: '≤', ge: '≥', ne: '≠', asymp: '≈',
  rarr: '→', larr: '←', harr: '↔', uarr: '↑', darr: '↓',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', szlig: 'ß',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
};
const HTML_ENTITY = /&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]{1,7});/g;

/** Decode the entities wikitext itself carries. Unknown names are left as written. */
export function decodeHtmlEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(HTML_ENTITY, (whole, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return codePoint(n);
    }
    return Object.hasOwn(HTML_NAMED, e) ? HTML_NAMED[e] : whole;
  });
}

/* ------------------------------------------------------------------------ */
/* Comments and block tags                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Remove `<!-- … -->`. An unclosed comment swallows the rest of the text,
 * which is what MediaWiki itself renders.
 */
export function stripComments(s) {
  let i = s.indexOf('<!--');
  if (i < 0) return s;
  let out = '';
  let last = 0;
  while (i >= 0) {
    out += s.slice(last, i);
    const j = s.indexOf('-->', i + 4);
    if (j < 0) return out;
    last = j + 3;
    i = s.indexOf('<!--', last);
  }
  return out + s.slice(last);
}

/**
 * Tags whose *content* is not prose: references, galleries, and the
 * Kartographer tags, whose bodies are GeoJSON full of `}}` that would
 * otherwise be read as template ends.
 */
const DROP_BLOCKS =
  /<(ref|gallery|maplink|mapframe|math|timeline|imagemap|syntaxhighlight|source|score|templatedata|graph)\b[^<>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/gi;

function stripTagBlocks(s) {
  if (s.indexOf('<') < 0) return s;
  return s.replace(DROP_BLOCKS, ' ');
}

/* ------------------------------------------------------------------------ */
/* Templates                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * A template name as MediaWiki compares it for our purposes: no `Template:`
 * prefix, underscores as spaces, single spaces, lower case. (`{{IsPartOf}}`,
 * `{{isPartOf}}`, `{{Template:outlinepark}}` all occur in the dump.)
 */
export function normaliseTemplateName(raw) {
  let n = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (n.startsWith('template:')) n = n.slice(9).trim();
  return n;
}

/**
 * Every balanced `{{ … }}` in `text`, nested ones included, in document order.
 *
 * `depth` is the number of *balanced* templates enclosing this one, computed
 * from the finished intervals rather than from the open-brace stack: a stray,
 * never-closed `{{` early in an article must not push every later template to
 * depth 1 and hide it from callers that ask for top-level templates.
 *
 * @returns {{ start: number, end: number, depth: number, name: string, inner: string }[]}
 */
export function scanTemplates(text) {
  const found = [];
  if (!text || text.indexOf('{{') < 0) return found;
  const stack = [];
  const n = text.length - 1;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 123 /* { */ && text.charCodeAt(i + 1) === 123) {
      stack.push(i);
      i += 2;
    } else if (c === 125 /* } */ && text.charCodeAt(i + 1) === 125 && stack.length > 0) {
      const start = stack.pop();
      found.push({ start, end: i + 2, depth: 0, name: '', inner: '' });
      i += 2;
    } else {
      i += 1;
    }
  }
  found.sort((a, b) => a.start - b.start);
  const enclosing = [];
  for (const t of found) {
    while (enclosing.length > 0 && enclosing[enclosing.length - 1] <= t.start) enclosing.pop();
    t.depth = enclosing.length;
    enclosing.push(t.end);
    t.inner = text.slice(t.start + 2, t.end - 2);
    const bar = t.inner.indexOf('|');
    t.name = normaliseTemplateName(bar < 0 ? t.inner : t.inner.slice(0, bar));
  }
  return found;
}

/**
 * Split on `|` at the top level only: a pipe inside a nested `{{template}}`
 * or a `[[link|label]]` belongs to that construct. An unclosed `[[` stops
 * protecting pipes at the end of its line, so one typo cannot swallow every
 * following parameter of a listing.
 */
export function splitTopLevel(inner) {
  const parts = [];
  let braces = 0;
  let links = 0;
  let from = 0;
  const n = inner.length;
  for (let i = 0; i < n; i++) {
    const c = inner.charCodeAt(i);
    if (c === 123 && inner.charCodeAt(i + 1) === 123) {
      braces++;
      i++;
    } else if (c === 125 && inner.charCodeAt(i + 1) === 125) {
      if (braces > 0) braces--;
      i++;
    } else if (c === 91 /* [ */ && inner.charCodeAt(i + 1) === 91) {
      links++;
      i++;
    } else if (c === 93 /* ] */ && inner.charCodeAt(i + 1) === 93) {
      if (links > 0) links--;
      i++;
    } else if (c === 10 /* \n */) {
      links = 0;
    } else if (c === 124 /* | */ && braces === 0 && links === 0) {
      parts.push(inner.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(inner.slice(from));
  return parts;
}

/**
 * Parse the inside of a template (the text between `{{` and `}}`).
 *
 * `positional` holds unnamed parameters in order; `named` holds `key=value`
 * pairs with the key lower-cased and both sides trimmed. A later duplicate key
 * wins, as in MediaWiki.
 *
 * @returns {{ name: string, positional: string[], named: Record<string, string> }}
 */
export function parseTemplate(inner) {
  const parts = splitTopLevel(inner);
  const name = normaliseTemplateName(parts[0] ?? '');
  const positional = [];
  const named = Object.create(null);
  for (let k = 1; k < parts.length; k++) {
    const part = parts[k];
    const eq = part.indexOf('=');
    if (eq > 0) {
      const key = part.slice(0, eq);
      // An `=` that sits inside a nested construct is not a name separator.
      if (key.indexOf('{{') < 0 && key.indexOf('[[') < 0 && key.indexOf('<') < 0) {
        named[key.trim().toLowerCase()] = part.slice(eq + 1).trim();
        continue;
      }
    }
    positional.push(part.trim());
  }
  return { name, positional, named };
}

/** Listing templates: `{{see|name=…|content=…}}` and friends. */
export const LISTING_TEMPLATES = new Set(['see', 'do', 'eat', 'drink', 'sleep', 'buy', 'go', 'listing']);

/** Listing-shaped templates whose name/content should survive as text. */
const LISTING_LIKE = new Set([...LISTING_TEMPLATES, 'event', 'mapgroup-item']);

/** `{{km|5}}` → "5 km". The label is what a reader sees, not the template name. */
const UNIT_LABEL = {
  km: 'km', kilometer: 'km', kilometre: 'km', m: 'm', meter: 'm', metre: 'm', cm: 'cm', mm: 'mm',
  mi: 'mi', mile: 'mi', ft: 'ft', feet: 'ft', foot: 'ft', inch: 'in', in: 'in', yard: 'yd', yd: 'yd',
  km2: 'km²', m2: 'm²', mi2: 'sq mi', sqmi: 'sq mi', squaremile: 'sq mi', ft2: 'sq ft', sqft: 'sq ft',
  squarefeet: 'sq ft', sqm: 'm²', acre: 'acres', ha: 'ha', hectare: 'ha',
  kmh: 'km/h', 'km/h': 'km/h', mph: 'mph', kg: 'kg', lb: 'lb', nmi: 'nmi',
};
const TEMPERATURE_LABEL = { c: '°C', celsius: '°C', f: '°F', fahrenheit: '°F' };

/** Templates that simply show their first unnamed parameter. */
const SHOW_FIRST = new Set([
  'nowrap', 'nobr', 'small', 'big', 'center', 'w', 'station', 'quote', 'cautionbox', 'warningbox',
  'disclaimerbox', 'iata', 'faa lid', 'icao', 'strike', 'noitalic', 'plainlist',
]);

const LITERAL = {
  emdash: ' — ', snd: ' – ', '·': ' · ', '!': ' ', okina: 'ʻ',
  unesco: ' UNESCO World Heritage Site ', 'unesco world heritage site': ' UNESCO World Heritage Site ',
  'unesco whs': ' UNESCO World Heritage Site ',
};

/**
 * An explicit list, never "any short name with a number in it": that rule
 * turned `{{geo|68.33|14.66}}` into the prose "68.33 GEO".
 */
const CURRENCY = new Set([
  'eur', 'euro', '€', 'usd', 'gbp', 'aud', 'cad', 'nzd', 'chf', 'jpy', 'cny', 'inr', 'rub', 'huf', 'php', 'aur',
  'dkk', 'nok', 'sek', 'egp', 'gel', 'idr', 'npr', 'clp', 'try', 'sar', 'zar', 'thb', 'krw', 'mxn', 'brl', 'pln',
  'czk', 'ils', 'twd', 'hkd', 'sgd', 'myr', 'vnd', 'nzr',
]);

const NUMERIC = /^[\d.,\s–−-]+$/;
const RANGE_WORD = /^(to|and|or|by|x|×|-|–|±)$/i;
const MAX_TEMPLATE_DEPTH = 12;

function renderListing(t, depth) {
  const name = renderTemplates(t.named.name ?? '', depth + 1).trim();
  const alt = renderTemplates(t.named.alt ?? '', depth + 1).trim();
  const content = renderTemplates(t.named.content ?? '', depth + 1).trim();
  let out = name;
  if (alt) out += out ? ` (${alt})` : alt;
  if (out && !/[.!?]$/.test(out)) out += '.';
  if (content) out += (out ? ' ' : '') + content;
  if (out && !/[.!?]["')\]]*$/.test(out)) out += '.';
  // Listings sit one per bullet; the surrounding spaces keep neighbours apart
  // once whitespace is collapsed.
  return out ? ` ${out} ` : '';
}

function renderRegionlist(t, depth) {
  const numbers = [];
  for (const key in t.named) {
    const m = /^region(\d+)name$/.exec(key);
    if (m) numbers.push(Number(m[1]));
  }
  numbers.sort((a, b) => a - b);
  const lines = [];
  for (const n of numbers) {
    const name = renderTemplates(t.named[`region${n}name`] ?? '', depth + 1).trim();
    const items = renderTemplates(t.named[`region${n}items`] ?? '', depth + 1).trim();
    const description = renderTemplates(t.named[`region${n}description`] ?? '', depth + 1).trim();
    if (!name && !description) continue;
    let line = name;
    if (items) line += ` (${items})`;
    if (description) line += ` — ${description}`;
    if (!/[.!?]$/.test(line)) line += '.';
    lines.push(line);
  }
  return lines.length > 0 ? `\n${lines.join('\n')}\n` : '';
}

/** What one template contributes to plain text. Almost always nothing. */
function renderTemplate(inner, depth) {
  if (depth > MAX_TEMPLATE_DEPTH) return '';
  const bar = inner.indexOf('|');
  const name = normaliseTemplateName(bar < 0 ? inner : inner.slice(0, bar));
  if (Object.hasOwn(LITERAL, name)) return LITERAL[name];
  if (bar < 0) return '';

  if (LISTING_LIKE.has(name)) return renderListing(parseTemplate(inner), depth);
  if (name === 'marker') return renderTemplates(parseTemplate(inner).named.name ?? '', depth + 1);
  if (name === 'regionlist') return renderRegionlist(parseTemplate(inner), depth);

  if (name === 'convert' || name === 'cvt') {
    const out = [];
    for (const p of parseTemplate(inner).positional) {
      if (NUMERIC.test(p) || RANGE_WORD.test(p)) out.push(p);
      else {
        if (out.length > 0 && p) out.push(p);
        break;
      }
    }
    return out.join(' ');
  }
  if (Object.hasOwn(UNIT_LABEL, name) || Object.hasOwn(TEMPERATURE_LABEL, name)) {
    const first = parseTemplate(inner).positional[0] ?? '';
    if (!first || first.indexOf('{{') >= 0) return '';
    return Object.hasOwn(UNIT_LABEL, name) ? `${first} ${UNIT_LABEL[name]}` : `${first}${TEMPERATURE_LABEL[name]}`;
  }
  if (SHOW_FIRST.has(name)) return renderTemplates(parseTemplate(inner).positional[0] ?? '', depth + 1);
  if (name === 'lang') return renderTemplates(parseTemplate(inner).positional[1] ?? '', depth + 1);
  if (name === 'legend') return renderTemplates(parseTemplate(inner).positional[1] ?? '', depth + 1);
  if (name === 'infobox') {
    const t = parseTemplate(inner);
    const title = renderTemplates(t.positional[0] ?? '', depth + 1).trim();
    const body = renderTemplates(t.positional[1] ?? '', depth + 1).trim();
    // On lines of their own, so a body that opens with a bullet is still
    // seen as a list by the line-anchored clean-up in `toPlainText`.
    return `\n${title}${title && !/[.!?:]$/.test(title) ? '.' : ''}\n${body}\n`;
  }
  if (name === 'frac') {
    const p = parseTemplate(inner).positional;
    if (p.length === 2) return `${p[0]}/${p[1]}`;
    if (p.length >= 3) return `${p[0]} ${p[1]}/${p[2]}`;
    return p[0] ?? '';
  }
  // Currency templates ({{EUR|5}}, {{huf|500}}): the amount and the code.
  if (CURRENCY.has(name)) {
    const first = parseTemplate(inner).positional[0] ?? '';
    if (first && NUMERIC.test(first)) return `${first} ${name === 'euro' || name === '€' ? 'EUR' : name.toUpperCase()}`;
  }
  return '';
}

/**
 * Replace every top-level template in `s` with its plain-text contribution
 * (see `renderTemplate`); parameters that are kept are rendered recursively.
 */
export function renderTemplates(s, depth = 0) {
  if (!s || s.indexOf('{{') < 0) return s;
  let out = '';
  let last = 0;
  for (const t of scanTemplates(s)) {
    if (t.depth !== 0) continue;
    out += s.slice(last, t.start) + renderTemplate(t.inner, depth);
    last = t.end;
  }
  return out + s.slice(last);
}

/* ------------------------------------------------------------------------ */
/* Tables and links                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Drop `{| … |}` tables, nested ones included. Table markup is line-anchored,
 * so this walks lines; an unclosed table removes the rest of the text, as it
 * would render.
 */
function stripTables(s) {
  if (s.indexOf('{|') < 0) return s;
  const lines = s.split('\n');
  const kept = [];
  let depth = 0;
  for (const line of lines) {
    const head = line.replace(/^[\s:*#]+/, '');
    if (head.startsWith('{|')) {
      depth++;
      // A one-line `{| … |}` closes itself.
      if (head.length > 2 && head.trimEnd().endsWith('|}')) depth--;
      continue;
    }
    if (depth > 0) {
      if (head.startsWith('|}')) depth--;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** Namespaces and interwiki prefixes whose links are not Wikivoyage articles. */
const NON_ARTICLE_PREFIX = new Set([
  'file', 'image', 'media', 'category', 'wikivoyage', 'project', 'template', 'help', 'user', 'special',
  'mediawiki', 'module', 'talk', 'user talk', 'wikivoyage talk', 'wv', 'wt', 'event',
  'w', 'wikipedia', 'commons', 'c', 'wikt', 'wiktionary', 'wikidata', 'd', 'm', 'meta', 'mw', 's',
  'wikisource', 'b', 'wikibooks', 'q', 'wikiquote', 'n', 'wikinews', 'v', 'wikiversity', 'species',
  'wmf', 'foundation', 'phab', 'dmoz', 'wikitravel', 'wts', 'voy', 'tech', 'incubator', 'toollabs', 'doi',
]);
const MEDIA_PREFIX = new Set(['file', 'image', 'media', 'category']);

/** `Foo_bar ` → `Foo bar`; first letter upper-cased, as MediaWiki stores titles. */
export function normaliseTitle(raw) {
  // Invisible direction marks get pasted into titles (`{{IsPartOf|Malda (district)<LRM>}}`).
  let t = decodeHtmlEntities(raw)
    .replace(/[\u200b\u200e\u200f\ufeff]/g, '')
    .replace(/[_\s]+/g, ' ')
    .trim();
  if (t.startsWith(':')) t = t.slice(1).trim();
  if (!t) return '';
  const first = String.fromCodePoint(t.codePointAt(0));
  return first.toUpperCase() + t.slice(first.length);
}

/**
 * The article title a wikilink target points at, or `null` when it is not a
 * main-namespace article (a file, a category, another project, another
 * language, a same-page `#anchor`). Any `#anchor` is dropped.
 */
export function toArticleTitle(rawTarget) {
  if (!rawTarget) return null;
  let t = rawTarget;
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  if (/[{}<>[\]|]/.test(t)) return null;
  t = normaliseTitle(t);
  if (!t) return null;
  const colon = t.indexOf(':');
  if (colon > 0) {
    const prefix = t.slice(0, colon).toLowerCase();
    if (NON_ARTICLE_PREFIX.has(prefix)) return null;
    // Interlanguage links: `[[fr:Paris]]`, `[[:de:Berlin]]`.
    if (/^([a-z]{2,3}|simple|zh-[a-z-]+)$/.test(prefix) && /^\S/.test(t.slice(colon + 1))) return null;
  }
  return t;
}

const LINK_TARGET = /\[\[([^[\]|\n]+)/g;

/** Article titles of every wikilink in `text`, in order, duplicates kept. */
export function articleLinkTargets(text) {
  const out = [];
  if (!text || text.indexOf('[[') < 0) return out;
  LINK_TARGET.lastIndex = 0;
  let m;
  while ((m = LINK_TARGET.exec(text))) {
    const title = toArticleTitle(m[1]);
    if (title) out.push(title);
  }
  return out;
}

const NON_MEDIA_LINK = /\[\[(?!\s*(?:file|image|media|category)\s*:)/gi;

/** How many `[[wikilinks]]` a text carries, files and categories excluded. */
export function countWikilinks(text) {
  if (!text || text.indexOf('[[') < 0) return 0;
  const m = text.match(NON_MEDIA_LINK);
  return m ? m.length : 0;
}

function renderLink(inner, depth) {
  const head = /^\s*(:?)\s*([^|:#[\]]*):/.exec(inner);
  if (head && !head[1] && MEDIA_PREFIX.has(head[2].trim().toLowerCase())) return '';
  const bar = inner.indexOf('|');
  let target = (bar < 0 ? inner : inner.slice(0, bar)).replace(/_/g, ' ').trim();
  if (target.startsWith(':')) target = target.slice(1).trim();
  const label = bar < 0 ? null : inner.slice(bar + 1);
  if (label !== null && label.trim() !== '') {
    return label.indexOf('[[') >= 0 && depth < 4 ? renderLinks(label, depth + 1) : label;
  }
  const hash = target.indexOf('#');
  if (hash === 0) target = target.slice(1);
  else if (hash > 0) target = target.slice(0, hash);
  const colon = target.indexOf(':');
  if (colon > 0 && NON_ARTICLE_PREFIX.has(target.slice(0, colon).toLowerCase())) target = target.slice(colon + 1);
  // The "pipe trick": `[[Springfield (Illinois)|]]` shows as "Springfield".
  if (label !== null) target = target.replace(/\s*\([^()]*\)\s*$/, '').replace(/,.*$/, '');
  return target;
}

/**
 * `[[A|B]]` → B, `[[A]]` → A, files and categories removed. Brackets nest —
 * `[[File:x.jpg|thumb|A view of [[Reine]]]]` is one link — so this matches
 * pairs by depth instead of with a regular expression.
 */
function renderLinks(s, depth = 0) {
  let i = s.indexOf('[[');
  if (i < 0) return s;
  let out = '';
  let last = 0;
  let unmatched = 0;
  while (i >= 0) {
    let open = 1;
    let j = i + 2;
    let close = -1;
    for (;;) {
      const c = s.indexOf(']]', j);
      if (c < 0) break;
      const o = s.indexOf('[[', j);
      if (o >= 0 && o < c) {
        open++;
        j = o + 2;
      } else {
        open--;
        j = c + 2;
        if (open === 0) {
          close = c;
          break;
        }
      }
    }
    if (close < 0) {
      // Unbalanced: leave this `[[` for the stray-bracket sweep and move on.
      // Bounded, because each miss rescans to the end of the text.
      if (++unmatched > 40) break;
      i = s.indexOf('[[', i + 2);
      continue;
    }
    out += s.slice(last, i) + renderLink(s.slice(i + 2, close), depth);
    last = close + 2;
    i = s.indexOf('[[', last);
  }
  return out + s.slice(last);
}

/* ------------------------------------------------------------------------ */
/* Plain text                                                                */
/* ------------------------------------------------------------------------ */

const EXTERNAL_LINK = /\[(?:(?:https?|ftp|irc|gopher):\/\/|\/\/|mailto:)[^\s\]]*[ \t]*([^\]\n]*)\]/gi;
const BARE_URL = /\b(?:https?|ftp):\/\/[^\s<>"\]]+/gi;

/**
 * Wikitext → plain prose.
 *
 * Removed: comments, references, galleries, tables, files, categories, magic
 * words, headings, list markers, bold/italic quotes and every template —
 * except the ones a reader would see as words: a listing becomes
 * "Name (alt). content", a marker its name, a Regionlist its regions and
 * descriptions, `{{km|5}}` "5 km". Whitespace is collapsed to single spaces.
 */
export function toPlainText(wikitext) {
  if (!wikitext) return '';
  let s = stripComments(wikitext);
  s = stripTagBlocks(s);
  if (s.indexOf('{{') >= 0) s = renderTemplates(s, 0);
  s = stripTables(s);
  s = renderLinks(s, 0);
  if (s.indexOf('[') >= 0) s = s.replace(EXTERNAL_LINK, '$1');
  if (s.indexOf('://') >= 0) s = s.replace(BARE_URL, '');
  if (s.indexOf('<') >= 0) s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-zA-Z][^<>]*>/g, '');
  s = s
    .replace(/^=+[^\n]*?=+[ \t]*$/gm, ' ')
    // Bold/italic quotes. Four in a row is an apostrophe next to bold:
    // `''''s-Hertogenbosch'''` renders as 's-Hertogenbosch.
    .replace(/'{2,}/g, (q) => (q.length === 4 ? "'" : ''))
    .replace(/^[ \t]*[*#:;]+[ \t]*/gm, '')
    .replace(/^-{4,}[ \t]*$/gm, ' ')
    .replace(/__[A-Z]+__/g, ' ')
    .replace(/\{\{|\}\}|\[\[|\]\]|\{\||\|\}/g, ' ');
  s = decodeHtmlEntities(s);
  s = s.replace(/\s+/g, ' ').trim();
  // Tidy what removed templates leave behind: "( )", " ,", "..".
  return s
    .replace(/\(\s*[,;:]?\s*\)/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/(?<!\.)\.{2}(?!\.)/g, '.')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------------ */
/* Sections                                                                  */
/* ------------------------------------------------------------------------ */

const HEADING = /^(={2,6})[ \t]*(.+?)[ \t]*\1[ \t]*$/gm;

/**
 * The heading tree of an article, flat and in order.
 *
 * `lead` is everything before the first heading. Each section's `[bodyStart,
 * end)` covers its own text *and its subsections*: `end` is the start of the
 * next heading of the same or a higher level. Offsets index into `text`, so a
 * caller can relate a template's position to the section it sits in.
 *
 * Pass text with comments already stripped — a commented-out heading is not a
 * heading.
 *
 * @returns {{ lead: string, sections: { level: number, title: string, rawTitle: string, start: number, bodyStart: number, end: number }[] }}
 */
export function splitSections(text) {
  const sections = [];
  HEADING.lastIndex = 0;
  let m;
  while ((m = HEADING.exec(text))) {
    sections.push({
      level: m[1].length,
      rawTitle: m[2],
      title: toPlainText(m[2]),
      start: m.index,
      bodyStart: m.index + m[0].length,
      end: text.length,
    });
  }
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].level <= sections[i].level) {
        sections[i].end = sections[j].start;
        break;
      }
    }
  }
  return { lead: sections.length > 0 ? text.slice(0, sections[0].start) : text, sections };
}

/* ------------------------------------------------------------------------ */
/* Clipping and sentences                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Cut to at most `max` characters, at a word boundary when one is near, so a
 * cap never leaves half a word that a keyword match could trip over.
 */
export function clip(s, max) {
  if (s.length <= max) return s;
  let cut = s.lastIndexOf(' ', max);
  if (cut < max * 0.8) {
    cut = max;
    const c = s.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--; // never split a surrogate pair
  }
  return s.slice(0, cut).trimEnd();
}

/** Words that end in a full stop without ending a sentence. */
const ABBREVIATIONS = new Set([
  'st', 'ste', 'mt', 'mts', 'dr', 'mr', 'mrs', 'ms', 'vs', 'e.g', 'i.e', 'approx', 'no', 'nos', 'ft', 'jr', 'sr',
  'u.s', 'u.k', 'u.s.a', 'a.k.a', 'c', 'ca', 'cf', 'inc', 'ltd', 'co', 'prof', 'gen', 'col', 'lt', 'sgt', 'capt',
  'rev', 'hon', 'fr', 'ave', 'blvd', 'rd', 'est', 'esp', 'incl', 'sq', 'lit', 'pop', 'elev', 'gov', 'pres',
]);

/**
 * The first sentence of a plain-text paragraph, at most `max` characters.
 * A full stop ends the sentence only when it is not an abbreviation
 * ("St. Anton"), not an initial, not inside brackets, and is followed by
 * something that starts a sentence.
 */
export function firstSentence(text, max = 300) {
  if (!text) return '';
  const stop = /[.!?。]["'”’)\]]*(?=\s|$)/g;
  let m;
  while ((m = stop.exec(text))) {
    const end = m.index + m[0].length;
    const rest = text.slice(end).trimStart();
    if (rest && !/^["'“‘([]?[\p{Lu}\p{N}\p{Lo}]/u.test(rest)) continue;
    const before = text.slice(0, m.index);
    const word = (/(\S+)$/.exec(before)?.[1] ?? '').replace(/^[("'“‘[]+/, '').toLowerCase();
    if (text[m.index] === '.' && (ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word))) continue;
    if (rest && end < 25) continue;
    const candidate = text.slice(0, end);
    let balance = 0;
    for (let i = 0; i < candidate.length; i++) {
      const c = candidate.charCodeAt(i);
      if (c === 40) balance++;
      else if (c === 41 && balance > 0) balance--;
    }
    if (balance > 0 && rest) continue;
    return clip(candidate, max);
  }
  return clip(text, max);
}
