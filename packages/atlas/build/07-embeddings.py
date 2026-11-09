#!/usr/bin/env python3
# =============================================================================
# 07-embeddings.py — static sentence embeddings for destination retrieval
# =============================================================================
#
# Stage 7 of the offline atlas build, and the measurement that decides whether
# it ships. It embeds one document per candidate with a STATIC model (a table
# of token vectors; a text's vector is the mean of its tokens' vectors — no
# network is evaluated, here or at query time), reduces the dimension with PCA,
# quantises to int8 and writes the table the runtime needs to embed a query the
# same way (`packages/core/src/atlas/embed.ts`). It then measures the result
# against the existing lexical index.
#
#   python3 -I packages/atlas/build/07-embeddings.py            # build + evaluate
#   python3 -I packages/atlas/build/07-embeddings.py --no-eval  # build only
#   python3 -I packages/atlas/build/07-embeddings.py \
#       --fixture packages/core/src/atlas/fixtures/embed-parity.json
#
# Inputs  (all under --cache, default <repo>/.atlas-cache)
#   raw/potion/model.safetensors   one F32 tensor, tokens × 256
#   raw/potion/tokenizer.json      HuggingFace tokenizers file (BERT WordPiece)
#   raw/potion/config.json         model2vec settings (`normalize`)
#   work/candidates.ndjson         the destinations; LINE ORDER IS ROW ORDER
#   work/wikivoyage.ndjson         the guide text
# Outputs
#   work/embeddings.json           what the runtime loads:
#     {model, licence, dim, rows, rowsDigest,
#      docs: base64 int8 rows × dim (row order = candidates.ndjson), docScale,
#      tokens: [string], tokenVectors: base64 int8 tokens × dim, tokenScale,
#      centre: base64 float32-LE dim, tokenizer: {lowercase, stripAccents,
#      continuingPrefix, unkToken, maxCharsPerWord}}
#     `rowsDigest` is sha256 of the candidate ids in order (first 16 hex): the
#     matrix is meaningless against any other candidates.ndjson — rebuild this
#     stage whenever stage 04 is re-run.
#   work/embeddings-eval.json      every number quoted in the stage report
#   --fixture <path>               the small parity fixture the TypeScript test
#                                  reads (a real slice of the shipped table)
#
# No network, no ML runtime, no third-party parser: numpy only. The downloaded
# files are treated as data — the safetensors header is parsed by hand, the
# tokenizer file is read for five settings and a vocabulary, nothing in either
# is executed.
#
# -----------------------------------------------------------------------------
# THE MODEL
# -----------------------------------------------------------------------------
# minishlab/potion-base-8M (MIT), a model2vec distillation of
# baai/bge-base-en-v1.5. A sentence embedding is, exactly:
#   ids  = tokenizer.encode(text, add_special_tokens=False), [UNK] ids removed
#   vec  = mean(embeddings[ids]);  L2-normalised when config.normalize is true
# The token weighting (Zipf) is already folded into the stored vectors: "the"
# has norm ≈ 1.7, "fjord" ≈ 112. A stopword therefore barely moves a mean.
#
# -----------------------------------------------------------------------------
# THE DOCUMENTS
# -----------------------------------------------------------------------------
# A guide row: the article's lead WITHOUT its first sentence, then Understand,
# See and Do (2,500 characters each), 600 tokens in all, then the names of its
# top sights (64 tokens more). The first sentence is left out because it is
# the query of the known-item evaluation, and because it is mostly the place's
# name and where it is — which the lexical index already does far better.
# `--layout balanced` (default) gives each of the four parts an equal share of
# the 600 and hands on what a short part leaves unused, so a long Understand
# cannot push See and Do out; `--layout first` simply reads the first 600. The
# two measure the same on known-item recall (the eval file carries both).
# A data-only row, and a guide with no prose at all: its name and the named
# features near it. A row with nothing at all is a zero vector and is never
# returned by a search.
#
# -----------------------------------------------------------------------------
# THE TOKENISER (must match embed.ts character for character)
# -----------------------------------------------------------------------------
# BertNormalizer  clean_text: drop U+0000, U+FFFD and control/format/private-use
#                 characters (tab, LF, CR are whitespace, not control); every
#                 whitespace character becomes one space.
#                 handle_chinese_chars: a space either side of a CJK ideograph.
#                 strip_accents (null in the file = "same as lowercase"): NFD,
#                 drop nonspacing marks (Mn).
#                 lowercase: per character, so no final-sigma context rule.
# BertPreTokenizer split on whitespace, then every punctuation character
#                 (ASCII punctuation ranges or Unicode P*) is its own piece.
# WordPiece       greedy longest match, continuation pieces prefixed "##"; a
#                 piece with any unmatched remainder, or longer than
#                 max_input_chars_per_word, is [UNK] as a whole — and model2vec
#                 drops [UNK].
# Known deviation: the literal strings "[CLS]", "[SEP]", "[PAD]", "[MASK]",
# "[UNK]" in the input are tokenised as text here, not matched as specials.
#
# -----------------------------------------------------------------------------
# THE REDUCTION
# -----------------------------------------------------------------------------
# Documents:  x = normalise(mean of token vectors)        the model2vec embedding
#             z = normalise((x - mu) · P)                 mu, P from PCA of the x
# Queries:    u = mean of PROJECTED token vectors (T = E · P, stored as int8)
#             z = normalise(u - centre)                   centre = mu · P
# The query path is exactly linear up to its one normalisation — averaging then
# projecting equals projecting then averaging — which is what lets the runtime
# hold a D-wide token table instead of the 256-wide model (verified below on 20
# queries). It is deliberately NOT the document path: a query's mean is not
# normalised before the centre comes off, and since token vectors are long
# (median norm ≈ 97) and mu is short (≈ 0.5), the subtraction barely moves a
# query. That asymmetry is measured, not assumed: centring the documents removes
# the "this is a travel guide" direction they all share and helps; centring a
# short query by the DOCUMENTS' mean, as if it were a guide, costs a third of
# the known-item recall (`ablation_symmetric_query_centring` in the eval file).
#
# -----------------------------------------------------------------------------
# THE EVALUATION (work/embeddings-eval.json)
# -----------------------------------------------------------------------------
# A  knownItem         1,500 guides; the query is the guide's first sentence
#                      with the place's name taken out; recall@10/50/200 and
#                      MRR over every rankable row, for the lexical index, the
#                      embedding at 256/128/96/64, and their fusion.
# B  concepts          twenty experience-style requests, top ten of each
#                      retriever, to be read by a person.
# B2 experienceLabels  the curated catalog's editorial 0–3 readings on its twin
#                      rows: nDCG@10 and AUC per experience. Objective, but
#                      small, and on famous places only.
# C  timings           here in numpy; the TypeScript runtime is timed on the
#                      written artifact.
# The lexical baseline is the index as it ships: score = sum over the query's
# distinct terms of the weight stage 04 stored for that term on that row.
#
# =============================================================================

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
import random
import re
import struct
import sys
import time
import unicodedata

import numpy as np

T0 = time.time()
MODEL_ID = "minishlab/potion-base-8M"
LICENCE = "MIT"
TOKEN_CAP = 600          # document body tokens
NAMES_CAP = 64           # tokens of sight names appended after the body
SECTION_CHARS = 2500
DIMS = (64, 96, 128, 256)

CONCEPT_QUERIES = [
    "tea plantations, misty hills and train rides",
    "fjords I can kayak in with few cruise ships",
    "caves, karst and underground rivers",
    "remote monasteries and high passes",
    "quiet fishing villages with good seafood",
    "laid-back surf town",
    "vineyards and medieval hill towns",
    "volcano hikes and black sand beaches",
    "wild horses and steppe",
    "coral atolls and lagoons",
    "ancient temples in the jungle",
    "northern lights and reindeer",
    "rice terraces and trekking between villages",
    "sand dunes and camel trekking",
    "old silk road cities",
    "cloud forest and hummingbirds",
    "thermal baths and art nouveau architecture",
    "dramatic sea cliffs and puffins",
    "alpine lakes and wildflower meadows",
    "colonial architecture and salsa",
]

# The parity fixture's queries: accents, punctuation, an out-of-vocabulary word,
# long compounds, odd whitespace, and scripts the pruned table no longer holds.
FIXTURE_QUERIES = [
    "tea plantations, misty hills and train rides",
    "fjords I can kayak in with few cruise ships",
    "wild horses and steppe",
    "São Tomé and Príncipe: crêperies, cafés & piña coladas",
    "Hike/trek (multi-day!) to hot-springs — wine-tasting… & stargazing?",
    "volcano\U0001F30Btrek and black sand beaches",
    "Donaudampfschifffahrtsgesellschaftskapitän on a Rindfleischetikettierungsüberwachungsaufgaben river cruise",
    "  REMOTE   Monasteries\tand HIGH passes\n",
    "Þingvellir, Tromsø & Ærøskøbing in winter",
    "İstanbul bazaars, ΟΔΟΣ and Ὀδυσσεύς ruins",
    "東京 temples & 京都 gardens",
    "a" * 101 + " beaches",
    "can’t-miss naïve coöperative façade “quoted”",
    "soft­hyphen zero​width non breaking　ideographic space",
    "\U0001F30B\U0001F30B \U0001F3D4",
    "",
]


def log(msg: str) -> None:
    sys.stderr.write(f"[07-embeddings {time.time() - T0:7.1f}s] {msg}\n")
    sys.stderr.flush()


# ───────────────────────────── model files ──────────────────────────────────


def read_safetensors(path: str) -> np.ndarray:
    """The single F32 tensor in the file. Header: u64 LE length, JSON, raw data."""
    with open(path, "rb") as fh:
        (header_len,) = struct.unpack("<Q", fh.read(8))
        if header_len > 1 << 20:
            raise ValueError(f"implausible safetensors header length {header_len}")
        header = json.loads(fh.read(header_len).decode("utf-8"))
        tensors = {k: v for k, v in header.items() if k != "__metadata__"}
        if len(tensors) != 1:
            raise ValueError(f"expected one tensor, found {sorted(tensors)}")
        (name, spec), = tensors.items()
        if spec["dtype"] != "F32" or len(spec["shape"]) != 2:
            raise ValueError(f"tensor {name}: expected a 2-d F32, got {spec}")
        start, end = spec["data_offsets"]
        rows, cols = spec["shape"]
        if end - start != rows * cols * 4:
            raise ValueError(f"tensor {name}: offsets {start}..{end} do not hold {rows}x{cols} float32")
        fh.seek(8 + header_len + start)
        data = fh.read(end - start)
    return np.frombuffer(data, dtype="<f4").reshape(rows, cols).astype(np.float32)


def read_tokenizer_settings(path: str) -> tuple[dict, list[str]]:
    """The five settings the runtime needs, and the vocabulary in id order."""
    with open(path, encoding="utf-8") as fh:
        spec = json.load(fh)
    normalizer, pre, model = spec["normalizer"], spec["pre_tokenizer"], spec["model"]
    if normalizer["type"] != "BertNormalizer" or pre["type"] != "BertPreTokenizer" or model["type"] != "WordPiece":
        raise ValueError("this stage implements BertNormalizer + BertPreTokenizer + WordPiece only")
    if not normalizer.get("clean_text", True) or not normalizer.get("handle_chinese_chars", True):
        raise ValueError("clean_text and handle_chinese_chars are assumed on")
    lowercase = bool(normalizer["lowercase"])
    strip = normalizer.get("strip_accents")
    settings = {
        "lowercase": lowercase,
        "stripAccents": lowercase if strip is None else bool(strip),
        "continuingPrefix": model["continuing_subword_prefix"],
        "unkToken": model["unk_token"],
        "maxCharsPerWord": int(model["max_input_chars_per_word"]),
    }
    by_id = sorted(model["vocab"].items(), key=lambda kv: kv[1])
    if [i for _, i in by_id] != list(range(len(by_id))):
        raise ValueError("vocabulary ids are not 0..V-1")
    return settings, [token for token, _ in by_id]


# ───────────────────────────── tokeniser ────────────────────────────────────

_CJK = (
    (0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0x20000, 0x2A6DF), (0x2A700, 0x2B73F),
    (0x2B740, 0x2B81F), (0x2B920, 0x2CEAF), (0xF900, 0xFAFF), (0x2F800, 0x2FA1F),
)


def _is_cjk(cp: int) -> bool:
    return any(lo <= cp <= hi for lo, hi in _CJK)


def _is_punct(ch: str) -> bool:
    cp = ord(ch)
    if 33 <= cp <= 47 or 58 <= cp <= 64 or 91 <= cp <= 96 or 123 <= cp <= 126:
        return True
    return cp > 127 and unicodedata.category(ch).startswith("P")


class _Lazy(dict):
    """A str.translate table filled on first sight of each code point."""

    def __init__(self, fn):
        super().__init__()
        self._fn = fn

    def __missing__(self, cp):
        value = self._fn(cp)
        self[cp] = value
        return value


def _clean(cp: int):
    if cp == 0 or cp == 0xFFFD:
        return None
    if cp in (9, 10, 13):
        return " "
    category = unicodedata.category(chr(cp))
    if category in ("Cc", "Cf", "Co", "Cs"):
        return None
    if category in ("Zs", "Zl", "Zp"):
        return " "
    if _is_cjk(cp):
        return f" {chr(cp)} "
    return cp


class WordPiece:
    """The tokeniser above over a given vocabulary (token → id)."""

    def __init__(self, settings: dict, vocab: dict[str, int]):
        self.lowercase = settings["lowercase"]
        self.strip_accents = settings["stripAccents"]
        self.prefix = settings["continuingPrefix"]
        self.max_chars = settings["maxCharsPerWord"]
        self.vocab = vocab
        self.unk = vocab.get(settings["unkToken"], -1)
        self._clean = _Lazy(_clean)
        self._strip = _Lazy(lambda cp: None if unicodedata.category(chr(cp)) == "Mn" else cp)
        self._lower = _Lazy(lambda cp: chr(cp).lower())
        self._words: dict[str, tuple[int, ...]] = {}

    def normalize(self, text: str) -> str:
        text = text.translate(self._clean)
        if text.isascii():
            return text.lower() if self.lowercase else text
        if self.strip_accents:
            text = unicodedata.normalize("NFD", text).translate(self._strip)
        if self.lowercase:
            text = text.translate(self._lower)
        return text

    def _piece(self, piece: str, out: list[int]) -> None:
        """Greedy longest match; -1 for a piece that cannot be fully matched."""
        n = len(piece)
        if n > self.max_chars:
            out.append(-1)
            return
        found: list[int] = []
        start = 0
        while start < n:
            end = n
            hit = None
            while start < end:
                sub = piece[start:end] if start == 0 else self.prefix + piece[start:end]
                hit = self.vocab.get(sub)
                if hit is not None:
                    break
                end -= 1
            if hit is None:
                out.append(-1)
                return
            found.append(hit)
            start = end
        out.extend(found)

    def _word(self, word: str) -> tuple[int, ...]:
        out: list[int] = []
        if word.isascii() and word.isalnum():
            self._piece(word, out)
        else:
            start = 0
            for i, ch in enumerate(word):
                if _is_punct(ch):
                    if i > start:
                        self._piece(word[start:i], out)
                    self._piece(ch, out)
                    start = i + 1
            if start < len(word):
                self._piece(word[start:], out)
        return tuple(i for i in out if i >= 0 and i != self.unk)

    def encode(self, text: str, limit: int | None = None) -> list[int]:
        """Token ids of a text, unknown pieces dropped, at most `limit` of them."""
        ids: list[int] = []
        words = self._words
        for word in self.normalize(text).split(" "):
            if not word:
                continue
            hit = words.get(word)
            if hit is None:
                hit = self._word(word)
                if len(words) < 2_000_000:
                    words[word] = hit
            ids.extend(hit)
            if limit is not None and len(ids) >= limit:
                return ids[:limit]
        return ids


def keep_in_runtime_table(token: str, settings: dict) -> bool:
    """
    Whether a token can matter to a query typed in a Latin-script language.

    Dropped: the five specials, [unused…] rows, and any token holding a letter
    or mark from another script (CJK ideographs, kana, Hangul, Cyrillic, Greek,
    Arabic, Indic …) — in this English vocabulary those are single characters
    with no travel meaning. Safe: a word's segmentation only ever consults
    substrings of itself, so a Latin-script word is tokenised identically with
    or without these rows; a word in a dropped script becomes unknown and is
    skipped, exactly as an unknown word already is.
    """
    if token.startswith("[") and token.endswith("]") and len(token) > 2:
        return False
    prefix = settings["continuingPrefix"]
    body = token[len(prefix):] if token.startswith(prefix) and len(token) > len(prefix) else token
    for ch in body:
        if ord(ch) < 128:
            continue
        category = unicodedata.category(ch)
        if category[0] in ("L", "M") and not unicodedata.name(ch, "").startswith("LATIN "):
            return False
    return True


# ───────────────────────────── lexical baseline ─────────────────────────────
# A faithful port of `tokens()` / `stem()` in packages/atlas/build/lib/vocabulary.mjs.

_STOP = set(
    "the a an and or of in on at to for from by with as is are was were be been being it its this that these those there here which who whom whose what when where why how not no nor but if then than so such very can could should would may might must will shall do does did done have has had having you your yours we our ours they them their he him his she her i me my also more most some any all each every other others one two three four five six seven eight nine ten first second third many much few several about above below under over between into through during before after again further once only own same too just out up down off near around along across via per etc e.g i.e km m ft miles mile hours hour minutes minute day days week weeks year years time times well good great best nice small large big little long short old new high low main local many there their get go goes going take takes taken make makes made see sees seen visit visits visiting visitor visitors place places area areas town towns city cities region regions country countries part parts side sides end way ways road roads street streets north south east west northern southern eastern western centre center central located location known called named including include includes around within without available open closed daily hotel hotels room rooms price prices phone tel fax email website http https www com org net".split()
)
_COMBINING = re.compile("[̀-ͯ]")
_SUFFIX_ES = re.compile(r"(ches|shes|sses|xes|zes)$")


def stem(word: str) -> str:
    w = _COMBINING.sub("", unicodedata.normalize("NFD", word.lower()))
    if len(w) > 4 and w.endswith("ies"):
        w = w[:-3] + "y"
    elif len(w) > 4 and _SUFFIX_ES.search(w):
        w = w[:-2]
    elif len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is")):
        w = w[:-1]
    return w


def _utf16_len(s: str) -> int:
    return len(s) + sum(1 for ch in s if ord(ch) > 0xFFFF)


def lexical_tokens(text: str) -> list[str]:
    out: list[str] = []
    raw: list[str] = []
    for ch in text.lower() + " ":
        if unicodedata.category(ch).startswith("L"):   # JS \p{L}
            raw.append(ch)
            continue
        if raw:
            word = "".join(raw)
            raw = []
            if _utf16_len(word) < 3 or _utf16_len(word) > 24 or word in _STOP:
                continue
            term = stem(word)
            if _utf16_len(term) < 3 or term in _STOP:
                continue
            out.append(term)
    return out


class LexicalIndex:
    """score(doc) = Σ over the query's distinct terms of the doc's stored weight."""

    def __init__(self, rows: list[dict]):
        postings: dict[str, tuple[list[int], list[float]]] = {}
        for i, row in enumerate(rows):
            for term, weight in row["terms"]:
                entry = postings.get(term)
                if entry is None:
                    entry = postings[term] = ([], [])
                entry[0].append(i)
                entry[1].append(weight)
        self.n = len(rows)
        self.postings = {t: (np.asarray(r, dtype=np.int32), np.asarray(w, dtype=np.float32)) for t, (r, w) in postings.items()}

    def scores(self, query: str) -> np.ndarray:
        out = np.zeros(self.n, dtype=np.float32)
        for term in dict.fromkeys(lexical_tokens(query)):
            entry = self.postings.get(term)
            if entry is not None:
                np.add.at(out, entry[0], entry[1])
        return out


# ───────────────────────────── documents ────────────────────────────────────


def read_ndjson(path: str):
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def document_parts(row: dict, article: dict | None, keep_first: bool = False) -> tuple[list[str], str]:
    """
    (body parts in order, sight names) for one candidate. Empty when there is
    nothing to say. The lead's first sentence is left out — it is the known-item
    query of the evaluation, and it is mostly the name and where the place is.
    `keep_first` exists only for the ablation that measures what that costs.
    """
    if article is not None:
        lead = article.get("lead") or ""
        first = article.get("firstSentence") or ""
        if keep_first:
            pass
        elif first and lead.startswith(first):
            lead = lead[len(first):]
        elif first and first in lead:
            lead = lead.replace(first, " ", 1)
        sections = article.get("sections") or {}
        body = [lead] + [(sections.get(k) or "")[:SECTION_CHARS] for k in ("understand", "see", "do")]
        body = [part.strip() for part in body]
        names = ", ".join([*(row.get("topSee") or []), *(row.get("topDo") or [])])
        if any(body) or names:
            return body, names
    # A data-only row, or a guide with no prose at all: its name and what lies near it.
    text = ", ".join([row.get("name") or "", *(row.get("nearFeatures") or [])]).strip(", ")
    return ([text] if text else []), ""


def document_ids(tok: WordPiece, body: list[str], names: str, layout: str) -> list[int]:
    """
    `first`:    the first TOKEN_CAP tokens of the parts read in order.
    `balanced`: every part gets an equal share first, the remainder is filled
                in order — so a long Understand cannot push See and Do out.
    The sight names always follow, capped separately.
    """
    if layout == "first" or len(body) <= 1:
        ids = tok.encode(" ".join(part for part in body if part), TOKEN_CAP)
    else:
        encoded = [tok.encode(part, TOKEN_CAP) for part in body]
        share = TOKEN_CAP // len(body)
        take = [min(len(e), share) for e in encoded]
        spare = TOKEN_CAP - sum(take)
        for i, e in enumerate(encoded):
            extra = min(spare, len(e) - take[i])
            take[i] += extra
            spare -= extra
        ids = [i for e, n in zip(encoded, take) for i in e[:n]]
    if names:
        ids.extend(tok.encode(names, NAMES_CAP))
    return ids


# ───────────────────────────── linear algebra ───────────────────────────────


def unit_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return np.divide(matrix, norms, out=np.zeros_like(matrix), where=norms > 0)


class Reduction:
    """PCA to D dimensions: documents normalised then centred, queries centred as a raw mean."""

    def __init__(self, components: np.ndarray, dim: int, mu: np.ndarray):
        self.dim = dim
        self.mu = mu
        self.projection = np.ascontiguousarray(components[:dim].T).astype(np.float64)   # 256 × D
        self.centre = mu @ self.projection

    def documents(self, normalised: np.ndarray, has_text: np.ndarray) -> np.ndarray:
        z = unit_rows((normalised - self.mu) @ self.projection)
        z[~has_text] = 0
        return z

    def query(self, mean_256: np.ndarray) -> np.ndarray:
        return unit_rows(np.atleast_2d(mean_256.astype(np.float64) @ self.projection - self.centre))[0]


def quantise(matrix: np.ndarray) -> tuple[np.ndarray, float]:
    """
    int8 with one global scale: value ≈ int8 × scale. The scale is the one that
    minimises the squared error — a few outliers are clipped so that the bulk
    of the values keeps more of the 255 levels.
    """
    peak = float(np.abs(matrix).max())
    if peak == 0:
        return np.zeros(matrix.shape, dtype=np.int8), 1.0
    best = None
    for fraction in (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2):
        scale = peak * fraction / 127
        q = np.clip(np.rint(matrix / scale), -127, 127)
        error = float(np.mean((q * scale - matrix) ** 2))
        if best is None or error < best[0]:
            best = (error, q.astype(np.int8), scale)
    return best[1], best[2]


def b64(array: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(array).tobytes()).decode("ascii")


def sizes(array: np.ndarray) -> dict:
    raw = np.ascontiguousarray(array).tobytes()
    encoded = base64.b64encode(raw)
    return {
        "rawBytes": len(raw),
        "gzip9Bytes": len(gzip.compress(raw, 9)),
        "base64Bytes": len(encoded),
        "base64Gzip9Bytes": len(gzip.compress(encoded, 9)),
    }


class RuntimeTable:
    """What embed.ts holds, and the Python reference of what it computes."""

    def __init__(self, reduction: Reduction, embeddings: np.ndarray, vocab: list[str], settings: dict):
        keep = [i for i, token in enumerate(vocab) if keep_in_runtime_table(token, settings)]
        self.dim = reduction.dim
        self.tokens = [vocab[i] for i in keep]
        self.vectors, self.scale = quantise(embeddings[keep].astype(np.float64) @ reduction.projection)
        self.centre = reduction.centre.astype(np.float32)
        self.settings = settings
        self.tokenizer = WordPiece(settings, {token: i for i, token in enumerate(self.tokens)})
        self.dropped = len(vocab) - len(keep)

    def embed(self, text: str) -> np.ndarray | None:
        ids = self.tokenizer.encode(text)
        if not ids:
            return None
        v = self.vectors[ids].astype(np.float64).mean(axis=0) * self.scale - self.centre.astype(np.float64)
        norm = np.linalg.norm(v)
        return None if norm == 0 else (v / norm).astype(np.float32)


def cosine_int8(query: np.ndarray, docs_i8: np.ndarray, doc_norms: np.ndarray) -> np.ndarray:
    """True cosine against int8 rows (the scale cancels); a zero row scores -2."""
    dots = docs_i8.astype(np.float32) @ query.astype(np.float32)
    return np.where(doc_norms > 0, dots / np.where(doc_norms > 0, doc_norms, 1), -2).astype(np.float32)


# ───────────────────────────── evaluation helpers ───────────────────────────


def fold(word: str) -> str:
    return _COMBINING.sub("", unicodedata.normalize("NFD", word.lower()))


def strip_name(sentence: str, names: list[str]) -> str:
    """The sentence without the destination's name or any word of it."""
    out = sentence
    banned: set[str] = set()
    for name in names:
        if not name:
            continue
        out = re.sub(re.escape(name), " ", out, flags=re.IGNORECASE)
        for word in re.findall(r"[^\W\d_]+", name):
            if len(word) >= 3:
                banned.add(fold(word))
                banned.add(stem(word))
    pieces = re.findall(r"[^\W\d_]+|[\W\d_]+", out)
    kept = [p for p in pieces if not (p[0].isalpha() and (fold(p) in banned or stem(p) in banned))]
    return re.sub(r"\s+", " ", "".join(kept)).strip()


def ranks_desc(scores: np.ndarray) -> np.ndarray:
    """rank[i] = 1-based position of row i by descending score, ties by row index."""
    order = np.argsort(-scores, kind="stable")
    rank = np.empty(len(scores), dtype=np.int32)
    rank[order] = np.arange(1, len(scores) + 1, dtype=np.int32)
    return rank


def rrf(lexical: np.ndarray, embedding: np.ndarray, k: int = 60, lexical_weight: float = 1.0) -> np.ndarray:
    """Reciprocal-rank fusion. A row a retriever did not score contributes nothing from it."""
    fused = np.zeros(len(lexical), dtype=np.float64)
    hit = lexical > 0
    if hit.any():
        fused[hit] += lexical_weight / (k + ranks_desc(np.where(hit, lexical, -np.inf))[hit])
    hit = embedding > -1.5
    if hit.any():
        fused[hit] += 1.0 / (k + ranks_desc(np.where(hit, embedding, -np.inf))[hit])
    return fused


def rank_of(scores: np.ndarray, target: int, floor: float) -> float:
    """1-based rank of `target`; inf when the retriever gave it no score."""
    s = scores[target]
    if not s > floor:
        return float("inf")
    return float(1 + int((scores > s).sum()) + int((scores[:target] == s).sum()))


def summarise(ranks: list[float]) -> dict:
    r = np.asarray(ranks, dtype=np.float64)
    return {
        "recall@10": round(float((r <= 10).mean()), 4),
        "recall@50": round(float((r <= 50).mean()), 4),
        "recall@200": round(float((r <= 200).mean()), 4),
        "mrr": round(float((1.0 / r).mean()), 4),
        "unranked": int(np.isinf(r).sum()),
    }


# ───────────────────────────── main ─────────────────────────────────────────


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    default_cache = os.path.normpath(os.path.join(here, "..", "..", "..", ".atlas-cache"))
    ap = argparse.ArgumentParser(description="Static embeddings for destination retrieval, and their evaluation.")
    ap.add_argument("--cache", default=default_cache, help="cache root holding raw/ and work/ (default: %(default)s)")
    ap.add_argument("--dim", type=int, default=96, choices=DIMS, help="shipping dimension (default: %(default)s)")
    ap.add_argument("--layout", default="balanced", choices=("first", "balanced"), help="how the 600-token budget is spent (default: %(default)s)")
    ap.add_argument("--out", default=None, help="artifact path (default: <cache>/work/embeddings.json)")
    ap.add_argument("--eval-out", default=None, help="evaluation path (default: <cache>/work/embeddings-eval.json)")
    ap.add_argument("--no-eval", action="store_true", help="build the artifact only")
    ap.add_argument("--fixture", default=None, help="also write the TypeScript parity fixture here")
    ap.add_argument("--sample", type=int, default=1500, help="known-item queries (default: %(default)s)")
    ap.add_argument("--seed", type=int, default=20261108)
    args = ap.parse_args()

    raw = os.path.join(args.cache, "raw", "potion")
    work = os.path.join(args.cache, "work")
    out_path = args.out or os.path.join(work, "embeddings.json")
    eval_path = args.eval_out or os.path.join(work, "embeddings-eval.json")
    timings: dict[str, float] = {}

    # ── model ────────────────────────────────────────────────────────────────
    embeddings = read_safetensors(os.path.join(raw, "model.safetensors"))
    settings, vocab = read_tokenizer_settings(os.path.join(raw, "tokenizer.json"))
    with open(os.path.join(raw, "config.json"), encoding="utf-8") as fh:
        config = json.load(fh)
    if len(vocab) != embeddings.shape[0]:
        raise ValueError(f"{len(vocab)} tokens but {embeddings.shape[0]} vectors")
    full = WordPiece(settings, {token: i for i, token in enumerate(vocab)})
    log(f"model: {embeddings.shape[0]} tokens × {embeddings.shape[1]}, normalize={config.get('normalize')}, tokenizer {settings}")
    if not config.get("normalize", False):
        log("config.normalize is false — documents are compared by cosine, so they are normalised here regardless")

    # ── documents ────────────────────────────────────────────────────────────
    t = time.time()
    rows = list(read_ndjson(os.path.join(work, "candidates.ndjson")))
    wanted = {row["title"] for row in rows if row.get("title")}
    articles: dict[str, dict] = {}
    for article in read_ndjson(os.path.join(work, "wikivoyage.ndjson")):
        if article["title"] in wanted:
            articles[article["title"]] = {k: article.get(k) for k in ("lead", "firstSentence", "sections")}
    timings["readInputsSeconds"] = round(time.time() - t, 2)
    n = len(rows)
    # The artifact is only valid for this exact row order; the digest lets a consumer check.
    rows_digest = hashlib.sha256("\n".join(row["id"] for row in rows).encode("utf-8")).hexdigest()[:16]
    log(f"{n} candidates (rows digest {rows_digest}), {len(articles)} guide articles matched ({timings['readInputsSeconds']}s)")

    def embed_documents(layout: str, keep_first: bool = False) -> dict:
        means = np.zeros((n, embeddings.shape[1]), dtype=np.float32)
        chars = np.zeros(n, dtype=np.int64)
        count = np.zeros(n, dtype=np.int32)
        fallback = 0
        for i, row in enumerate(rows):
            article = articles.get(row["title"]) if row.get("title") else None
            body, sights = document_parts(row, article, keep_first)
            if article is not None and len(body) <= 1 and not sights:
                fallback += 1
            chars[i] = sum(len(part) for part in body) + len(sights)
            ids = document_ids(full, body, sights, layout)
            count[i] = len(ids)
            if ids:
                means[i] = embeddings[ids].mean(axis=0)
        return {"means": means, "chars": chars, "tokens": count, "fallback": fallback, "hasText": np.any(means != 0, axis=1)}

    t = time.time()
    built = embed_documents(args.layout)
    timings["embedDocumentsSeconds"] = round(time.time() - t, 2)
    means, has_text, doc_chars, doc_tokens = built["means"], built["hasText"], built["chars"], built["tokens"]
    log(f"embedded {int(has_text.sum())} documents ({n - int(has_text.sum())} empty, {built['fallback']} guides fell back to name + nearby features) in {timings['embedDocumentsSeconds']}s; median {int(np.median(doc_tokens[has_text]))} tokens")
    alternatives = {}
    if not args.no_eval:
        alternatives["layout"] = embed_documents("first" if args.layout == "balanced" else "balanced")
        alternatives["leak"] = embed_documents(args.layout, keep_first=True)
    del articles

    # ── PCA ──────────────────────────────────────────────────────────────────
    t = time.time()
    normalised = unit_rows(means.astype(np.float64))        # the model2vec embeddings
    mu = normalised[has_text].mean(axis=0)
    _, singular, components = np.linalg.svd(normalised[has_text] - mu, full_matrices=False)
    variance = singular ** 2 / np.sum(singular ** 2)
    reductions = {d: Reduction(components, d, mu) for d in DIMS}
    docs_float = {d: reductions[d].documents(normalised, has_text) for d in DIMS}
    timings["pcaSeconds"] = round(time.time() - t, 2)
    explained = {str(d): round(float(variance[:d].sum()), 4) for d in DIMS}
    log(f"PCA in {timings['pcaSeconds']}s; |mu| {np.linalg.norm(mu):.3f}; variance kept {explained}")

    tables = {d: RuntimeTable(reductions[d], embeddings, vocab, settings) for d in sorted({64, 96, args.dim})}
    docs_i8, doc_scale, doc_norm = {}, {}, {}
    for d in tables:
        docs_i8[d], doc_scale[d] = quantise(docs_float[d])
        doc_norm[d] = np.linalg.norm(docs_i8[d].astype(np.float32), axis=1)
    ship = tables[args.dim]
    red = reductions[args.dim]
    log(f"runtime table: {len(ship.tokens)} tokens kept, {ship.dropped} dropped; scales docs {doc_scale[args.dim]:.6f} tokens {ship.scale:.6f}")

    # ── the linearity the runtime relies on ──────────────────────────────────
    probe = CONCEPT_QUERIES[:20]
    linear_diff, final_diff, magnitude = 0.0, 0.0, 0.0
    quantised_cos, mean_norms = [], []
    for text in probe:
        vectors = embeddings[full.encode(text)].astype(np.float64)
        a = (vectors.mean(axis=0) - mu) @ red.projection            # embed, centre, then project
        b = (vectors @ red.projection).mean(axis=0) - red.centre    # project the token vectors, average, minus the centre
        linear_diff = max(linear_diff, float(np.abs(a - b).max()))
        magnitude = max(magnitude, float(np.abs(a).max()))
        za, zb = a / np.linalg.norm(a), b / np.linalg.norm(b)
        final_diff = max(final_diff, float(np.abs(za - zb).max()))
        quantised_cos.append(float(ship.embed(text).astype(np.float64) @ za))
        mean_norms.append(float(np.linalg.norm(vectors.mean(axis=0) @ red.projection)))
    linearity = {
        "queries": len(probe),
        "dim": args.dim,
        "maxAbsDiffBeforeNormalising": linear_diff,
        "largestComponentBeforeNormalising": round(magnitude, 3),
        "maxAbsDiffUnitVector": final_diff,
        "minCosineRuntimeInt8TableVsFloatModel": round(min(quantised_cos), 6),
        "meanCosineRuntimeInt8TableVsFloatModel": round(float(np.mean(quantised_cos)), 6),
        "centreNorm": round(float(np.linalg.norm(red.centre)), 4),
        "medianProjectedQueryMeanNorm": round(float(np.median(mean_norms)), 3),
    }
    log(f"linearity: {linearity}")

    # ── artifact ─────────────────────────────────────────────────────────────
    artifact = {
        "model": MODEL_ID,
        "licence": LICENCE,
        "dim": args.dim,
        "rows": n,
        "rowsDigest": rows_digest,
        "docs": b64(docs_i8[args.dim]),
        "docScale": doc_scale[args.dim],
        "tokens": ship.tokens,
        "tokenVectors": b64(ship.vectors),
        "tokenScale": ship.scale,
        "centre": b64(ship.centre.astype("<f4")),
        "tokenizer": settings,
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(artifact, fh, ensure_ascii=False, separators=(",", ":"))
    log(f"wrote {out_path} ({os.path.getsize(out_path)} bytes)")

    size_report = {}
    for d in (96, 64):
        token_strings = json.dumps(tables[d].tokens, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        size_report[str(d)] = {
            "docs": sizes(docs_i8[d]),
            "tokenVectors": sizes(tables[d].vectors),
            "tokenStrings": {"rawBytes": len(token_strings), "gzip9Bytes": len(gzip.compress(token_strings, 9))},
        }
    with open(out_path, "rb") as fh:
        blob = fh.read()
    size_report["embeddingsJson"] = {"dim": args.dim, "rawBytes": len(blob), "gzip9Bytes": len(gzip.compress(blob, 9))}
    del blob

    names = [row.get("name") or row["id"] for row in rows]
    in_scope = np.array([not row.get("scopeOnly") for row in rows])

    if args.fixture:
        write_fixture(args.fixture, ship, docs_i8[args.dim], doc_norm[args.dim], names, in_scope)

    if args.no_eval:
        return 0

    # ── evaluation ───────────────────────────────────────────────────────────
    lexical = LexicalIndex(rows)
    blocked = ~in_scope                      # scope-only rows are never ranked
    unscored = blocked | ~has_text

    def lexical_scores(query: str) -> np.ndarray:
        s = lexical.scores(query)
        s[blocked] = 0
        return s

    def mean_256(query: str) -> np.ndarray | None:
        ids = full.encode(query)
        return embeddings[ids].astype(np.float64).mean(axis=0) if ids else None

    def cosine(docs: np.ndarray, z: np.ndarray | None, skip: np.ndarray = unscored) -> np.ndarray:
        if z is None or not np.any(z):
            return np.full(n, -2, dtype=np.float32)
        s = (docs @ (z / np.linalg.norm(z))).astype(np.float32)
        s[skip] = -2
        return s

    def int8_scores(d: int, query: str) -> np.ndarray:
        z = tables[d].embed(query)
        if z is None:
            return np.full(n, -2, dtype=np.float32)
        s = cosine_int8(z, docs_i8[d], doc_norm[d])
        s[blocked] = -2
        return s

    # A. Known-item recall.
    pool = [
        i for i, row in enumerate(rows)
        if row["source"] == "wikivoyage" and not row.get("scopeOnly")
        and len(row.get("firstSentence") or "") >= 60 and doc_chars[i] >= 400 and has_text[i]
    ]
    sample = sorted(random.Random(args.seed).sample(pool, min(args.sample, len(pool))))
    queries = [strip_name(rows[i]["firstSentence"], [rows[i].get("name"), rows[i].get("title")]) for i in sample]

    # Variants, to show what each choice costs. All float, at the shipping D,
    # with the shipping mu and projection.
    uncentred_docs = unit_rows(normalised @ red.projection)
    other_layout = alternatives["layout"]
    other_docs = red.documents(unit_rows(other_layout["means"].astype(np.float64)), other_layout["hasText"])
    leak = alternatives["leak"]
    leak_docs = red.documents(unit_rows(leak["means"].astype(np.float64)), leak["hasText"])
    del alternatives

    other_name = "first" if args.layout == "balanced" else "balanced"
    systems = [
        "lexical",
        "embedding_256_model_float", "embedding_256_float", "embedding_128_float",
        f"embedding_96_float", "embedding_96_int8", "embedding_64_float", "embedding_64_int8",
        "hybrid_rrf_lexical_96_int8",
        "exploratory_hybrid_rrf_lexical_x3",
        "ablation_symmetric_query_centring", "ablation_no_centring",
        f"ablation_layout_{other_name}", "ablation_first_sentence_left_in_document",
    ]
    ranks: dict[str, list[float]] = {name: [] for name in systems}
    agreement = {d: {"overlap20": [], "overlap10": [], "top1": []} for d in (96, 64)}
    empty_lexical = 0
    t = time.time()
    for position, (target, query) in enumerate(zip(sample, queries)):
        lex = lexical_scores(query)
        if not lexical_tokens(query):
            empty_lexical += 1
        ranks["lexical"].append(rank_of(lex, target, 0))
        m = mean_256(query)

        # The model as published: cosine of the 256-d normalised embeddings, no PCA, no centring.
        ranks["embedding_256_model_float"].append(rank_of(cosine(normalised, m), target, -1.5))
        per_dim_float = {}
        for d in (256, 128, 96, 64):
            per_dim_float[d] = cosine(docs_float[d], None if m is None else reductions[d].query(m))
            ranks[f"embedding_{d}_float"].append(rank_of(per_dim_float[d], target, -1.5))
        per_dim_int8 = {}
        for d in (96, 64):
            per_dim_int8[d] = int8_scores(d, query)
            ranks[f"embedding_{d}_int8"].append(rank_of(per_dim_int8[d], target, -1.5))
        ranks["hybrid_rrf_lexical_96_int8"].append(rank_of(rrf(lex, per_dim_int8[96]), target, 0))
        ranks["exploratory_hybrid_rrf_lexical_x3"].append(rank_of(rrf(lex, per_dim_int8[96], lexical_weight=3.0), target, 0))

        if m is None:
            for name in systems[-4:]:
                ranks[name].append(float("inf"))
        else:
            q = red.query(m)
            symmetric = (m / np.linalg.norm(m) - mu) @ red.projection     # the query treated as if it were a document
            ranks["ablation_symmetric_query_centring"].append(rank_of(cosine(docs_float[args.dim], symmetric), target, -1.5))
            ranks["ablation_no_centring"].append(rank_of(cosine(uncentred_docs, m @ red.projection), target, -1.5))
            ranks[f"ablation_layout_{other_name}"].append(rank_of(cosine(other_docs, q, blocked | ~other_layout["hasText"]), target, -1.5))
            ranks["ablation_first_sentence_left_in_document"].append(rank_of(cosine(leak_docs, q, blocked | ~leak["hasText"]), target, -1.5))

        if position < 50:
            for d in (96, 64):
                top_float = np.argsort(-per_dim_float[d], kind="stable")
                top_int8 = np.argsort(-per_dim_int8[d], kind="stable")
                agreement[d]["overlap20"].append(len(set(top_float[:20].tolist()) & set(top_int8[:20].tolist())) / 20)
                agreement[d]["overlap10"].append(len(set(top_float[:10].tolist()) & set(top_int8[:10].tolist())) / 10)
                agreement[d]["top1"].append(float(top_float[0] == top_int8[0]))
    timings["knownItemEvalSeconds"] = round(time.time() - t, 2)
    known_item = {name: summarise(r) for name, r in ranks.items()}
    for name in systems:
        log(f"A  {name:42s} {known_item[name]}")

    # Where each retriever finds what the other misses.
    lex_r = np.asarray(ranks["lexical"])
    emb_r = np.asarray(ranks["embedding_96_int8"])
    complement = {}
    for k in (10, 50, 200):
        complement[f"top{k}"] = {
            "both": int(((lex_r <= k) & (emb_r <= k)).sum()),
            "lexicalOnly": int(((lex_r <= k) & (emb_r > k)).sum()),
            "embeddingOnly": int(((lex_r > k) & (emb_r <= k)).sum()),
            "neither": int(((lex_r > k) & (emb_r > k)).sum()),
        }
    no_lexical_hit = np.isinf(lex_r)
    complement["lexicalUnranked"] = {
        "queries": int(no_lexical_hit.sum()),
        "embeddingTop10": int((emb_r[no_lexical_hit] <= 10).sum()),
        "embeddingTop50": int((emb_r[no_lexical_hit] <= 50).sum()),
        "embeddingTop200": int((emb_r[no_lexical_hit] <= 200).sum()),
    }
    quantisation = {
        str(d): {
            "queries": len(v["overlap20"]),
            "meanOverlap@20": round(float(np.mean(v["overlap20"])), 4),
            "meanOverlap@10": round(float(np.mean(v["overlap10"])), 4),
            "top1Agreement": round(float(np.mean(v["top1"])), 4),
        }
        for d, v in agreement.items()
    }
    log(f"int8 (runtime path) vs float (model path): {quantisation}")

    # B. Concept queries.
    def label(i: int) -> str:
        country = rows[i].get("countryTitle")
        return f"{names[i]} ({country})" if country and country != names[i] else names[i]

    def top(scores: np.ndarray, floor: float, k: int = 10) -> list[dict]:
        order = np.argsort(-scores, kind="stable")[:k]
        return [{"row": int(i), "id": rows[i]["id"], "name": label(int(i)), "score": round(float(scores[i]), 4)} for i in order if scores[i] > floor]

    concepts = []
    for query in CONCEPT_QUERIES:
        lex = lexical_scores(query)
        emb = int8_scores(args.dim, query)
        concepts.append({
            "query": query,
            "lexicalTerms": list(dict.fromkeys(lexical_tokens(query))),
            "embeddingTokens": [ship.tokens[i] for i in ship.tokenizer.encode(query)],
            "lexical": top(lex, 0),
            "embedding": top(emb, -1.5),
            "hybrid": top(rrf(lex, emb), 0),
        })

    # B2. The same question with labels instead of taste: the curated catalog's
    # editorial 0–3 reading of each experience, on the rows that are its twins.
    # The query is the experience's identifier with its underscores read as
    # spaces — mechanical, so nobody chose words that flatter a retriever.
    experience_labels = None
    curated_path = os.path.join(work, "curated.json")
    twins = {row["curated"]: i for i, row in enumerate(rows) if row.get("curated") and not row.get("scopeOnly")}
    if os.path.exists(curated_path) and twins:
        with open(curated_path, encoding="utf-8") as fh:
            curated = json.load(fh)
        labelled = [(twins[entry["id"]], entry.get("experiences") or {}) for entry in curated["entries"] if entry["id"] in twins]
        subset = np.array([i for i, _ in labelled])
        outside = np.ones(n, dtype=bool)
        outside[subset] = False
        tie_break = np.random.default_rng(args.seed)
        per_experience = []
        for experience in curated["experiences"]:
            query = experience.replace("_", " ")
            gains = np.array([float(readings.get(experience, 0)) for _, readings in labelled])
            if (gains >= 2).sum() < 3 or (gains == 0).sum() < 3:
                continue
            lex = lexical_scores(query)
            emb = int8_scores(args.dim, query)
            emb_small = int8_scores(64, query)
            lex[outside] = 0
            emb[outside] = -2
            emb_small[outside] = -2
            entry = {"experience": experience, "query": query, "strong": int((gains >= 2).sum()), "absent": int((gains == 0).sum())}
            ideal = np.sort(2 ** gains - 1)[::-1][:10]
            discount = 1 / np.log2(np.arange(2, 12))
            systems_here = (
                ("random", np.zeros(len(subset), dtype=np.float32)),       # what an index that matched nothing would score
                ("lexical", lex[subset]),
                ("embedding", emb[subset]),
                ("embedding64", emb_small[subset]),
                ("hybrid", rrf(lex, emb)[subset]),
            )
            for name, scores in systems_here:
                # Ties are broken at random and averaged — the lexical index leaves most rows at zero.
                ndcg, precision = [], []
                for _ in range(25):
                    order = np.lexsort((tie_break.random(len(scores)), -scores))[:10]
                    ndcg.append(float(((2 ** gains[order] - 1) * discount).sum() / (ideal * discount).sum()))
                    precision.append(float((gains[order] >= 2).mean()))
                positive, negative = scores[gains >= 2], scores[gains == 0]
                wins = (positive[:, None] > negative[None, :]).sum() + 0.5 * (positive[:, None] == negative[None, :]).sum()
                entry[name] = {
                    "ndcg@10": round(float(np.mean(ndcg)), 4),
                    "precision@10": round(float(np.mean(precision)), 4),
                    "auc": round(float(wins / (len(positive) * len(negative))), 4),
                    "rowsScored": int((scores > (-1.5 if name.startswith("embedding") else 0)).sum()),
                }
            per_experience.append(entry)
        summary = {}
        for name in ("random", "lexical", "embedding", "embedding64", "hybrid"):
            summary[name] = {
                metric: round(float(np.mean([e[name][metric] for e in per_experience])), 4)
                for metric in ("ndcg@10", "precision@10", "auc")
            }
        best = {"lexical": 0, "embedding": 0, "hybrid": 0, "tie": 0}
        head_to_head = {"lexical": 0, "embedding": 0, "tie": 0}
        for e in per_experience:
            values = {name: e[name]["ndcg@10"] for name in ("lexical", "embedding", "hybrid")}
            top_value = max(values.values())
            leaders = [name for name, value in values.items() if value >= top_value - 0.01]
            best[leaders[0] if len(leaders) == 1 else "tie"] += 1
            gap = e["embedding"]["ndcg@10"] - e["lexical"]["ndcg@10"]
            head_to_head["embedding" if gap > 0.01 else "lexical" if gap < -0.01 else "tie"] += 1
        experience_labels = {
            "labelledRows": len(labelled),
            "experiences": len(per_experience),
            "note": "Ranked among the curated twins only. gain = 2^reading - 1; AUC is reading >= 2 against reading 0, ties counted half.",
            "mean": summary,
            "bestByNdcg@10": best,
            "embeddingVsLexicalByNdcg@10": head_to_head,
            "perExperience": per_experience,
        }
        log(f"B2 experience labels ({len(labelled)} rows, {len(per_experience)} experiences): {summary}; best {best}; head to head {head_to_head}")

    # C. Cost in numpy (the TypeScript figure is measured separately on the artifact).
    docs32 = docs_i8[args.dim].astype(np.float32)
    safe_norm = np.where(doc_norm[args.dim] > 0, doc_norm[args.dim], 1)
    loops = 5
    t = time.time()
    for _ in range(loops):
        for query in CONCEPT_QUERIES:
            s = docs32 @ ship.embed(query) / safe_norm
            np.argpartition(-s, 10)[:10]
    timings["numpyEmbedAndCosineQueryMs"] = round((time.time() - t) * 1000 / (loops * len(CONCEPT_QUERIES)), 3)
    t = time.time()
    for _ in range(loops):
        for query in CONCEPT_QUERIES:
            ship.embed(query)
    timings["pythonEmbedQueryMs"] = round((time.time() - t) * 1000 / (loops * len(CONCEPT_QUERIES)), 3)
    t = time.time()
    for _ in range(loops):
        for query in CONCEPT_QUERIES:
            lexical_scores(query)
    timings["numpyLexicalQueryMs"] = round((time.time() - t) * 1000 / (loops * len(CONCEPT_QUERIES)), 3)

    report = {
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": MODEL_ID,
        "licence": LICENCE,
        "shippingDim": args.dim,
        "layout": args.layout,
        "rows": n,
        "rowsDigest": rows_digest,
        "rowsRanked": int(in_scope.sum()),
        "documents": {
            "withText": int(has_text.sum()),
            "empty": int(n - has_text.sum()),
            "guidesFallenBackToNameAndNearby": built["fallback"],
            "medianTokens": int(np.median(doc_tokens[has_text])),
            "atTokenCap": int((doc_tokens >= TOKEN_CAP).sum()),
        },
        "pcaVarianceKept": explained,
        "tokens": {"model": len(vocab), "runtime": len(ship.tokens), "dropped": ship.dropped},
        "linearity": linearity,
        "quantisationAgreement": quantisation,
        "sizes": size_report,
        "knownItem": {
            "queries": len(sample),
            "pool": len(pool),
            "seed": args.seed,
            "queriesWithNoLexicalTerm": empty_lexical,
            "note": "The lexical index was built from the whole article, first sentence included; the embedded document leaves that sentence out. `ablation_first_sentence_left_in_document` gives the embedding the same advantage.",
            "examples": [{"target": names[i], "query": q} for i, q in list(zip(sample, queries))[:8]],
            "results": known_item,
            "complement_lexical_vs_embedding96int8": complement,
        },
        "concepts": concepts,
        "experienceLabels": experience_labels,
        "timings": timings,
    }
    with open(eval_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
    log(f"wrote {eval_path}")
    return 0


def write_fixture(path: str, table: RuntimeTable, docs_i8: np.ndarray, doc_norm: np.ndarray, names: list[str], in_scope: np.ndarray) -> None:
    """
    A real slice of the shipped table: every token the greedy matcher selects
    for the fixture queries (on failed words too, so the walk to the failure is
    the same), the vectors Python computes from that slice's rows, and a few
    dozen real document rows with the ranking Python gets.
    """
    tok = table.tokenizer
    used: set[int] = set()
    prefix = table.settings["continuingPrefix"]

    def walk(piece: str) -> None:
        if len(piece) > tok.max_chars:
            return
        start = 0
        while start < len(piece):
            end = len(piece)
            hit = None
            while start < end:
                hit = tok.vocab.get(piece[start:end] if start == 0 else prefix + piece[start:end])
                if hit is not None:
                    break
                end -= 1
            if hit is None:
                return
            used.add(hit)
            start = end

    for text in FIXTURE_QUERIES:
        for word in tok.normalize(text).split(" "):
            start = 0
            for i, ch in enumerate(word):
                if _is_punct(ch):
                    walk(word[start:i])
                    walk(ch)
                    start = i + 1
            walk(word[start:])

    keep = sorted(used)
    remap = {old: new for new, old in enumerate(keep)}
    queries = []
    vectors = []
    for text in FIXTURE_QUERIES:
        ids = tok.encode(text)
        vector = table.embed(text)
        vectors.append(vector)
        queries.append({
            "text": text,
            "tokens": [table.tokens[i] for i in ids],
            "ids": [remap[i] for i in ids],
            "vector": None if vector is None else [round(float(x), 6) for x in vector],
        })

    # Document rows: the best few for each query, so the rankings are not arbitrary.
    chosen: list[int] = []
    scored = {}
    for qi, vector in enumerate(vectors):
        if vector is None:
            continue
        s = cosine_int8(vector, docs_i8, doc_norm)
        s[~in_scope] = -2
        scored[qi] = s
        for row in np.argsort(-s, kind="stable")[:4].tolist():
            if row not in chosen:
                chosen.append(row)
    empty = next((i for i in range(len(doc_norm)) if doc_norm[i] == 0), None)
    if empty is not None:
        chosen.append(empty)          # an empty document must never be returned
    chosen.sort()
    rankings = []
    for qi, s in scored.items():
        local = s[chosen]
        order = [j for j in np.argsort(-local, kind="stable").tolist() if local[j] > -1.5][:5]
        rankings.append({"query": qi, "k": 5, "top": [{"row": j, "score": round(float(local[j]), 6)} for j in order]})

    fixture = {
        "note": "Generated by packages/atlas/build/07-embeddings.py --fixture. A slice of the shipped table; do not edit by hand.",
        "model": MODEL_ID,
        "licence": LICENCE,
        "dim": table.dim,
        "tokens": [table.tokens[i] for i in keep],
        "tokenVectors": b64(table.vectors[keep]),
        "tokenScale": table.scale,
        "centre": b64(table.centre.astype("<f4")),
        "tokenizer": table.settings,
        "queries": queries,
        "docs": {"rows": len(chosen), "names": [names[i] for i in chosen], "vectors": b64(docs_i8[chosen])},
        "rankings": rankings,
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(fixture, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    log(f"wrote fixture {path} ({os.path.getsize(path)} bytes, {len(keep)} tokens, {len(chosen)} document rows)")


if __name__ == "__main__":
    sys.exit(main())
