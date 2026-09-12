import { createHash } from 'node:crypto';

/**
 * V9.1 §7 — A PHOTO OF A CONFIRMATION, MADE SAFE BEFORE ANYTHING READS IT.
 *
 * A photo or screenshot of a booking is the one import a model has to read
 * (there is no text to extract from deterministically). Before the bytes
 * reach that one explicit call they pass through here, and only here:
 *
 *   1. what the bytes are is read from their first bytes — JPEG, PNG or
 *      WebP — never from a filename or a browser's `type`;
 *   2. anything past 4 MB is refused with a sentence;
 *   3. every metadata segment a camera or an editor writes is dropped —
 *      EXIF (with its GPS position and device serial), XMP, IPTC, comments —
 *      by a small pure walk over the container: JPEG APP1–APP15 and COM
 *      segments, PNG `tEXt` / `iTXt` / `zTXt` / `eXIf` chunks, WebP `EXIF`
 *      and `XMP ` chunks (and the VP8X flags that announced them);
 *   4. a SHA-256 of the stripped bytes is computed, so the same photo can be
 *      recognised again without keeping it.
 *
 * Nothing here persists anything. The bytes are returned to the caller, who
 * holds them only for the one model call and drops them; the pending
 * import row never sees them.
 */
export const PHOTO_LIMIT_BYTES = 4 * 1024 * 1024;

export type PhotoMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface PreparedPhoto {
  /** The image with its metadata removed. Held in memory for one call; never stored. */
  bytes: Uint8Array;
  mediaType: PhotoMediaType;
  /** SHA-256 (hex) of the stripped bytes — the photo's identity without the photo. */
  sha256: string;
  /** How many metadata segments or chunks were removed. */
  strippedSegments: number;
}

export type PreparePhotoOutcome = { ok: true; photo: PreparedPhoto } | { ok: false; error: string };

const TOO_BIG = 'That photo is larger than Sidequest reads (4 MB). A smaller photo or a screenshot works.';
const NOT_A_PHOTO = 'That is not a photo Sidequest can read. A JPEG, PNG or WebP photo or screenshot of the confirmation works.';
const UNREADABLE = 'That photo could not be read. Try a fresh screenshot of the confirmation.';

/** Which image container the bytes are, by magic bytes; `null` when they are not one of the three. */
export function sniffPhoto(bytes: Uint8Array): PhotoMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

/** Sniff, bound, strip and hash. Pure; nothing is stored. */
export function prepareConfirmationPhoto(bytes: Uint8Array): PreparePhotoOutcome {
  const mediaType = sniffPhoto(bytes);
  if (!mediaType) return { ok: false, error: NOT_A_PHOTO };
  if (bytes.byteLength > PHOTO_LIMIT_BYTES) return { ok: false, error: TOO_BIG };
  let stripped: { bytes: Uint8Array; removed: number };
  try {
    stripped = mediaType === 'image/jpeg' ? stripJpegMetadata(bytes) : mediaType === 'image/png' ? stripPngMetadata(bytes) : stripWebpMetadata(bytes);
  } catch {
    return { ok: false, error: UNREADABLE };
  }
  return {
    ok: true,
    photo: { bytes: stripped.bytes, mediaType, sha256: sha256Hex(stripped.bytes), strippedSegments: stripped.removed },
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = at; i < at + length && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * JPEG: SOI, then marker segments (`FF xx` + big-endian length that counts
 * itself) up to SOS, after which entropy-coded data runs to EOI and is copied
 * untouched. Dropped: APP1–APP15 (EXIF, XMP, ICC, IPTC, Adobe …) and COM.
 * Kept: APP0 (the JFIF header a decoder may want), every table and frame
 * segment, and everything from SOS on.
 */
export function stripJpegMetadata(bytes: Uint8Array): { bytes: Uint8Array; removed: number } {
  if (!(bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8)) throw new Error('not a JPEG');
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let removed = 0;
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) throw new Error('marker expected');
    /* Fill bytes (`FF FF …`) before a marker are legal; skip them. */
    while (at < bytes.length && bytes[at] === 0xff) at += 1;
    if (at >= bytes.length) break;
    const marker = bytes[at]!;
    at += 1;
    if (marker === 0xd9) {
      /* EOI: done. */
      parts.push(new Uint8Array([0xff, 0xd9]));
      break;
    }
    if (marker === 0xda) {
      /* SOS: the rest of the file is scan data (and any trailing markers); copy it whole. */
      parts.push(bytes.subarray(at - 2));
      break;
    }
    /* Standalone markers carry no length: RSTn, TEM, and SOI. */
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xd8) {
      parts.push(new Uint8Array([0xff, marker]));
      continue;
    }
    if (at + 2 > bytes.length) throw new Error('truncated segment');
    const length = (bytes[at]! << 8) | bytes[at + 1]!;
    if (length < 2 || at + length > bytes.length) throw new Error('bad segment length');
    const isApp = marker >= 0xe1 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (isApp || isComment) removed += 1;
    else parts.push(bytes.subarray(at - 2, at + length));
    at += length;
  }
  return { bytes: concat(parts), removed };
}

/**
 * PNG: an 8-byte signature, then chunks of `length (4) | type (4) | data |
 * crc (4)`. A kept chunk is copied verbatim, CRC included, so nothing is
 * recomputed; a dropped one simply is not copied.
 */
const PNG_DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);

export function stripPngMetadata(bytes: Uint8Array): { bytes: Uint8Array; removed: number } {
  if (sniffPhoto(bytes) !== 'image/png') throw new Error('not a PNG');
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let removed = 0;
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
    const type = ascii(bytes, at + 4, 4);
    const end = at + 12 + length;
    if (end > bytes.length) throw new Error('truncated chunk');
    if (PNG_DROP.has(type)) removed += 1;
    else parts.push(bytes.subarray(at, end));
    at = end;
    if (type === 'IEND') break;
  }
  return { bytes: concat(parts), removed };
}

/**
 * WebP: a RIFF container — `RIFF | size (4, LE) | WEBP` then chunks of
 * `fourcc (4) | size (4, LE) | data | pad to even`. `EXIF` and `XMP ` are
 * dropped; the RIFF size is rewritten for what remains; and when a `VP8X`
 * header announced those chunks, its two flag bits are cleared so the file
 * stays self-consistent.
 */
const WEBP_DROP = new Set(['EXIF', 'XMP ']);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

export function stripWebpMetadata(bytes: Uint8Array): { bytes: Uint8Array; removed: number } {
  if (sniffPhoto(bytes) !== 'image/webp') throw new Error('not a WebP');
  const chunks: Uint8Array[] = [];
  let removed = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const fourcc = ascii(bytes, at, 4);
    const size = (bytes[at + 4]! | (bytes[at + 5]! << 8) | (bytes[at + 6]! << 16) | (bytes[at + 7]! << 24)) >>> 0;
    const padded = size + (size % 2);
    const end = Math.min(bytes.length, at + 8 + padded);
    if (at + 8 + size > bytes.length) throw new Error('truncated chunk');
    if (WEBP_DROP.has(fourcc)) {
      removed += 1;
    } else if (fourcc === 'VP8X' && size >= 1) {
      const copy = new Uint8Array(bytes.subarray(at, end));
      copy[8] = copy[8]! & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      chunks.push(copy);
    } else {
      chunks.push(bytes.subarray(at, end));
    }
    at = end;
  }
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0);
  const riffSize = body.byteLength + 4;
  header[4] = riffSize & 0xff;
  header[5] = (riffSize >>> 8) & 0xff;
  header[6] = (riffSize >>> 16) & 0xff;
  header[7] = (riffSize >>> 24) & 0xff;
  header.set([0x57, 0x45, 0x42, 0x50], 8);
  return { bytes: concat([header, body]), removed };
}
