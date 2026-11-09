/**
 * STATIC SENTENCE EMBEDDINGS, AT QUERY TIME.
 *
 * The atlas's documents are embedded offline (`packages/atlas/build/07-embeddings.py`)
 * with a static model — minishlab/potion-base-8M, MIT — in which a text's vector
 * is the mean of its tokens' vectors. Nothing is inferred: embedding a query is
 * a tokeniser, a table lookup and an average, so the server needs no ML runtime
 * and this file needs no dependency, no Node API and no network.
 *
 * What the query path computes, and must keep computing exactly as the build
 * does or the two halves stop meeting:
 *
 *   ids   = WordPiece(text)                 unknown pieces dropped
 *   mean  = average of the stored token vectors × scale
 *   query = (mean − centre) / |mean − centre|
 *
 * The token vectors are already projected to `dim` dimensions (PCA is linear,
 * so projecting each token and averaging equals averaging and projecting), and
 * `centre` is the documents' mean in that space. Token vectors are long and the
 * centre is short, so the subtraction barely moves a query — deliberately: the
 * build measured that centring a query as if it were a guide loses recall.
 *
 * The tokeniser is BERT's, read off the model's `tokenizer.json`:
 *   normalise    drop U+0000, U+FFFD and control / format / private-use
 *                characters; every whitespace character becomes one space; a
 *                space either side of a CJK ideograph; NFD and drop nonspacing
 *                marks (accents); lower-case one character at a time.
 *   pre-tokenise split on spaces, then every punctuation character is its own
 *                piece.
 *   WordPiece    greedy longest match with `##` continuation pieces; a piece
 *                with any unmatched remainder, or over `maxCharsPerWord`
 *                characters, is unknown as a whole and contributes nothing.
 * `embed.test.ts` holds this to the Python implementation on a slice of the
 * shipped table.
 */

export interface EmbeddingTable {
  dim: number;
  /** Token text → row in `vectors`. */
  tokens: Map<string, number>;
  /** Row-major, `tokens.size × dim`. A stored value × `scale` is the real one. */
  vectors: Int8Array;
  scale: number;
  centre: Float32Array;
  lowercase: boolean;
  stripAccents: boolean;
  continuingPrefix: string;
  maxCharsPerWord: number;
}

/** The token half of `embeddings.json`, as written by the build. */
export interface RawEmbeddingTable {
  dim: number;
  tokens: string[];
  /** base64 of int8, `tokens.length × dim`. */
  tokenVectors: string;
  tokenScale: number;
  /** base64 of little-endian float32, `dim`. */
  centre: string;
  tokenizer: {
    lowercase: boolean;
    stripAccents: boolean;
    continuingPrefix: string;
    unkToken?: string;
    maxCharsPerWord: number;
  };
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** base64 → the int8 matrix it holds (`rows × dim`, row-major). Throws when the length is wrong. */
export function decodeInt8Matrix(base64: string, rows: number, dim: number): Int8Array {
  const bytes = bytesOf(base64);
  if (bytes.length !== rows * dim) {
    throw new Error(`embedding matrix holds ${bytes.length} bytes, expected ${rows} × ${dim}`);
  }
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

export function decodeEmbeddingTable(raw: RawEmbeddingTable): EmbeddingTable {
  const { dim } = raw;
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`embedding table has dimension ${dim}`);
  const vectors = decodeInt8Matrix(raw.tokenVectors, raw.tokens.length, dim);
  const centreBytes = bytesOf(raw.centre);
  if (centreBytes.length !== dim * 4) {
    throw new Error(`embedding centre holds ${centreBytes.length} bytes, expected ${dim * 4}`);
  }
  const view = new DataView(centreBytes.buffer, centreBytes.byteOffset, centreBytes.length);
  const centre = new Float32Array(dim);
  for (let j = 0; j < dim; j += 1) centre[j] = view.getFloat32(j * 4, true);

  const tokens = new Map<string, number>();
  raw.tokens.forEach((token, row) => {
    // The unknown marker is never a piece of text; it must not be matchable.
    if (token !== raw.tokenizer.unkToken) tokens.set(token, row);
  });
  return {
    dim,
    tokens,
    vectors,
    scale: raw.tokenScale,
    centre,
    lowercase: raw.tokenizer.lowercase,
    stripAccents: raw.tokenizer.stripAccents,
    continuingPrefix: raw.tokenizer.continuingPrefix,
    maxCharsPerWord: raw.tokenizer.maxCharsPerWord,
  };
}

/* ── Normalisation ────────────────────────────────────────────────────────── */

const CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u;
const SEPARATOR = /[\p{Zs}\p{Zl}\p{Zp}]/u;
const NONSPACING_MARKS = /\p{Mn}/gu;
const PUNCTUATION = /\p{P}/u;
/** After `clean` nothing below a space survives, so printable ASCII is all of ASCII. */
const ASCII_ONLY = /^[ -~]*$/;

function isCjkIdeograph(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b920 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

function isPunctuation(ch: string, cp: number): boolean {
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
    return true;
  }
  return cp > 127 && PUNCTUATION.test(ch);
}

function clean(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 9 || cp === 10 || cp === 13) out += ' ';
    else if (cp < 128) out += cp < 32 || cp === 127 ? '' : ch;
    else if (cp === 0xfffd || CONTROL.test(ch)) continue;
    else if (SEPARATOR.test(ch)) out += ' ';
    else if (isCjkIdeograph(cp)) out += ` ${ch} `;
    else out += ch;
  }
  return out;
}

function normalise(text: string, table: EmbeddingTable): string {
  let out = clean(text);
  if (ASCII_ONLY.test(out)) return table.lowercase ? out.toLowerCase() : out;
  if (table.stripAccents) out = out.normalize('NFD').replace(NONSPACING_MARKS, '');
  if (table.lowercase) {
    // One character at a time: a whole-string lower-casing applies the Greek
    // final-sigma rule, which the reference tokeniser does not.
    let lowered = '';
    for (const ch of out) lowered += ch.toLowerCase();
    out = lowered;
  }
  return out;
}

/* ── WordPiece ────────────────────────────────────────────────────────────── */

/** Greedy longest match over one piece. All of it or none of it. */
function matchPiece(chars: readonly string[], table: EmbeddingTable, out: number[]): void {
  const length = chars.length;
  if (length === 0 || length > table.maxCharsPerWord) return;
  const found: number[] = [];
  let start = 0;
  while (start < length) {
    let end = length;
    let hit: number | undefined;
    while (start < end) {
      const piece = chars.slice(start, end).join('');
      hit = table.tokens.get(start === 0 ? piece : table.continuingPrefix + piece);
      if (hit !== undefined) break;
      end -= 1;
    }
    if (hit === undefined) return;
    found.push(hit);
    start = end;
  }
  for (const id of found) out.push(id);
}

/** The token ids of a text, in order. A piece the table cannot spell is dropped whole. */
export function wordpiece(text: string, table: EmbeddingTable): number[] {
  const ids: number[] = [];
  for (const word of normalise(text, table).split(' ')) {
    if (word === '') continue;
    let piece: string[] = [];
    for (const ch of word) {
      if (isPunctuation(ch, ch.codePointAt(0) ?? 0)) {
        matchPiece(piece, table, ids);
        matchPiece([ch], table, ids);
        piece = [];
      } else {
        piece.push(ch);
      }
    }
    matchPiece(piece, table, ids);
  }
  return ids;
}

/* ── Embedding and search ─────────────────────────────────────────────────── */

/** The unit vector of a query, or null when the table knows none of its words. */
export function embedQuery(text: string, table: EmbeddingTable): Float32Array | null {
  const ids = wordpiece(text, table);
  if (ids.length === 0) return null;
  const { dim, vectors, centre } = table;
  const sum = new Float64Array(dim);
  for (const id of ids) {
    const base = id * dim;
    for (let j = 0; j < dim; j += 1) sum[j] = (sum[j] ?? 0) + (vectors[base + j] ?? 0);
  }
  const factor = table.scale / ids.length;
  let squares = 0;
  for (let j = 0; j < dim; j += 1) {
    const value = (sum[j] ?? 0) * factor - (centre[j] ?? 0);
    sum[j] = value;
    squares += value * value;
  }
  if (!(squares > 0)) return null;
  const norm = Math.sqrt(squares);
  const out = new Float32Array(dim);
  for (let j = 0; j < dim; j += 1) out[j] = (sum[j] ?? 0) / norm;
  return out;
}

/** Row lengths of a document matrix, computed once per matrix. */
const rowNorms = new WeakMap<Int8Array, { dim: number; norms: Float32Array }>();

function normsOf(docs: Int8Array, dim: number): Float32Array {
  const cached = rowNorms.get(docs);
  if (cached && cached.dim === dim) return cached.norms;
  const rows = Math.floor(docs.length / dim);
  const norms = new Float32Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const base = row * dim;
    let squares = 0;
    for (let j = 0; j < dim; j += 1) {
      const value = docs[base + j] ?? 0;
      squares += value * value;
    }
    norms[row] = Math.sqrt(squares);
  }
  rowNorms.set(docs, { dim, norms });
  return norms;
}

/**
 * The `k` rows of `docs` closest to `query` by cosine, best first; equal scores
 * in row order. `docs` is row-major int8, `dim` wide; its scale cancels in a
 * cosine, so none is needed. A row of zeros is a document with no text and is
 * never returned. `allowed` restricts the search without copying the matrix.
 */
export function cosineTop(
  query: Float32Array,
  docs: Int8Array,
  dim: number,
  k: number,
  allowed?: (row: number) => boolean,
): { row: number; score: number }[] {
  const limit = Math.floor(k);
  if (!(limit > 0) || !(dim > 0) || query.length !== dim) return [];
  let querySquares = 0;
  for (let j = 0; j < dim; j += 1) querySquares += (query[j] ?? 0) * (query[j] ?? 0);
  if (!(querySquares > 0)) return [];
  const queryNorm = Math.sqrt(querySquares);
  const norms = normsOf(docs, dim);
  const rows = norms.length;

  // A min-heap of the best `limit` so far; its root is the one to beat.
  const heapRows = new Int32Array(Math.min(limit, rows));
  const heapScores = new Float64Array(heapRows.length);
  let size = 0;
  const worse = (a: number, b: number): boolean => {
    const sa = heapScores[a] ?? 0;
    const sb = heapScores[b] ?? 0;
    return sa < sb || (sa === sb && (heapRows[a] ?? 0) > (heapRows[b] ?? 0));
  };
  const swap = (a: number, b: number): void => {
    const row = heapRows[a] ?? 0;
    const score = heapScores[a] ?? 0;
    heapRows[a] = heapRows[b] ?? 0;
    heapScores[a] = heapScores[b] ?? 0;
    heapRows[b] = row;
    heapScores[b] = score;
  };
  const siftDown = (from: number): void => {
    let at = from;
    for (;;) {
      const left = 2 * at + 1;
      const right = left + 1;
      let least = at;
      if (left < size && worse(left, least)) least = left;
      if (right < size && worse(right, least)) least = right;
      if (least === at) return;
      swap(at, least);
      at = least;
    }
  };

  for (let row = 0; row < rows; row += 1) {
    const norm = norms[row] ?? 0;
    if (norm === 0 || (allowed && !allowed(row))) continue;
    const base = row * dim;
    let dot = 0;
    for (let j = 0; j < dim; j += 1) dot += (query[j] ?? 0) * (docs[base + j] ?? 0);
    const score = dot / (norm * queryNorm);
    if (size < heapRows.length) {
      heapRows[size] = row;
      heapScores[size] = score;
      size += 1;
      let at = size - 1;
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (!worse(at, parent)) break;
        swap(at, parent);
        at = parent;
      }
    } else if (size > 0 && score > (heapScores[0] ?? 0)) {
      // Rows arrive in order, so an equal score never displaces an earlier row.
      heapRows[0] = row;
      heapScores[0] = score;
      siftDown(0);
    }
  }

  const out: { row: number; score: number }[] = [];
  for (let i = 0; i < size; i += 1) out.push({ row: heapRows[i] ?? 0, score: heapScores[i] ?? 0 });
  return out.sort((a, b) => b.score - a.score || a.row - b.row);
}
