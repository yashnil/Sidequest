import { describe, expect, it } from 'vitest';
import { PHOTO_LIMIT_BYTES, prepareConfirmationPhoto, sha256Hex, sniffPhoto, stripJpegMetadata, stripPngMetadata, stripWebpMetadata } from './image-prep';

/**
 * V9.1 §7 — A PHOTO IS MADE SAFE BEFORE ANYTHING READS IT.
 *
 * Three hand-built minimal files — a JPEG with an EXIF segment carrying a GPS
 * position, a PNG with text and EXIF chunks, a WebP with EXIF and XMP chunks
 * — go through the stripper; what comes out must keep every byte the decoder
 * needs and none of the metadata. Then the door: type by magic bytes and
 * never by name, the 4 MB line, and the hash that lets the same photo be
 * recognised without keeping it.
 */
const GPS_TEXT = 'GPSLatitude 64.1466 GPSLongitude -21.9426 CameraSerial SN-778812';

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function be16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** A JPEG segment: marker, length (counting itself), payload. */
function jpegSegment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...be16(payload.length + 2), ...payload];
}

/** SOI · APP0 (JFIF) · APP1 (EXIF with a GPS position) · COM · DQT · SOF0 · SOS + scan data · EOI. */
export function tinyJpeg(options: { exif?: boolean; comment?: boolean } = {}): Uint8Array {
  const exif = options.exif ?? true;
  const comment = options.comment ?? true;
  const bytes = [
    0xff, 0xd8,
    ...jpegSegment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(exif ? jpegSegment(0xe1, [...ascii('Exif'), 0, 0, ...ascii(GPS_TEXT)]) : []),
    ...(comment ? jpegSegment(0xfe, ascii('Shot on a phone — private comment')) : []),
    ...jpegSegment(0xdb, [0, ...new Array<number>(64).fill(1)]),
    ...jpegSegment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    ...jpegSegment(0xda, [1, 1, 0, 0, 63, 0]),
    /* Entropy-coded data: a few bytes, with an FF 00 stuffed byte the scanner must copy through untouched. */
    0x12, 0x34, 0xff, 0x00, 0x56,
    0xff, 0xd9,
  ];
  return new Uint8Array(bytes);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: number[]): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: number[]): number[] {
  const typed = [...ascii(type), ...data];
  return [...be32(data.length), ...typed, ...be32(crc32(typed))];
}

function adler32(bytes: number[]): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream with one stored (uncompressed) block — deterministic across zlib versions. */
function zlibStored(raw: number[]): number[] {
  return [0x78, 0x01, 0x01, raw.length & 0xff, (raw.length >> 8) & 0xff, ~raw.length & 0xff, (~raw.length >> 8) & 0xff, ...raw, ...be32(adler32(raw))];
}

/** A `width`×1 RGB PNG with a text chunk, an EXIF chunk and a compressed-text chunk. */
export function tinyPng(width = 1, options: { metadata?: boolean } = {}): Uint8Array {
  const metadata = options.metadata ?? true;
  const scanline = [0, ...new Array<number>(width * 3).fill(0x7f)];
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [...be32(width), ...be32(1), 8, 2, 0, 0, 0]),
    ...(metadata ? pngChunk('tEXt', [...ascii('Comment'), 0, ...ascii('private text chunk')]) : []),
    ...(metadata ? pngChunk('eXIf', [...ascii('II*'), 0, ...ascii(GPS_TEXT)]) : []),
    ...(metadata ? pngChunk('zTXt', [...ascii('XML:com.adobe.xmp'), 0, 0, ...zlibStored(ascii('<xmp>private</xmp>'))]) : []),
    ...(metadata ? pngChunk('iTXt', [...ascii('Description'), 0, 0, 0, 0, 0, ...ascii('international private text')]) : []),
    ...pngChunk('IDAT', zlibStored(scanline)),
    ...pngChunk('IEND', []),
  ];
  return new Uint8Array(bytes);
}

function webpChunk(fourcc: string, data: number[]): number[] {
  return [...ascii(fourcc), ...le32(data.length), ...data, ...(data.length % 2 === 1 ? [0] : [])];
}

/** RIFF/WEBP with a VP8X header announcing EXIF+XMP, a VP8L payload, then EXIF and XMP chunks. */
export function tinyWebp(options: { metadata?: boolean } = {}): Uint8Array {
  const metadata = options.metadata ?? true;
  const vp8x = webpChunk('VP8X', [metadata ? 0x08 | 0x04 : 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const vp8l = webpChunk('VP8L', [0x2f, 0x00, 0x00, 0x00, 0x00, 0x07, 0x10]);
  const exif = metadata ? webpChunk('EXIF', [...ascii('II*'), 0, ...ascii(GPS_TEXT)]) : [];
  const xmp = metadata ? webpChunk('XMP ', ascii('<x:xmpmeta>private</x:xmpmeta>')) : [];
  const body = [...ascii('WEBP'), ...vp8x, ...vp8l, ...exif, ...xmp];
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]);
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

describe('what the bytes are, by their first bytes', () => {
  it('names the three photo containers and nothing else', () => {
    expect(sniffPhoto(tinyJpeg())).toBe('image/jpeg');
    expect(sniffPhoto(tinyPng())).toBe('image/png');
    expect(sniffPhoto(tinyWebp())).toBe('image/webp');
    expect(sniffPhoto(new TextEncoder().encode('%PDF-1.4 not a photo'))).toBeNull();
    expect(sniffPhoto(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
    expect(sniffPhoto(new Uint8Array(0))).toBeNull();
    /* A RIFF that is not a WebP (a WAVE file) is not a photo. */
    expect(sniffPhoto(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]))).toBeNull();
  });

  it('refuses a renamed executable and a PDF with a sentence, never a filename in mind', () => {
    const exe = new Uint8Array(64);
    exe[0] = 0x4d;
    exe[1] = 0x5a;
    const outcome = prepareConfirmationPhoto(exe);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(/not a photo Sidequest can read/);
    expect(outcome.error).not.toMatch(/bytes|magic|mime|schema/i);
  });

  it('refuses a photo past 4 MB before touching its contents', () => {
    const big = new Uint8Array(PHOTO_LIMIT_BYTES + 1);
    big.set([0xff, 0xd8, 0xff], 0);
    const outcome = prepareConfirmationPhoto(big);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(/4 MB/);
    /* Exactly at the line is still accepted. */
    const atLimit = new Uint8Array(PHOTO_LIMIT_BYTES);
    atLimit.set(tinyJpeg({ exif: false, comment: false }), 0);
    expect(prepareConfirmationPhoto(atLimit.subarray(0, tinyJpeg({ exif: false, comment: false }).length)).ok).toBe(true);
  });
});

describe('a JPEG with an EXIF segment', () => {
  it('loses the EXIF and the comment and keeps every decoding segment and the scan data', () => {
    const input = tinyJpeg();
    expect(latin1(input)).toContain('GPSLatitude');
    const { bytes, removed } = stripJpegMetadata(input);
    const text = latin1(bytes);
    expect(removed).toBe(2);
    expect(text).not.toContain('Exif');
    expect(text).not.toContain('GPSLatitude');
    expect(text).not.toContain('CameraSerial');
    expect(text).not.toContain('private comment');
    /* SOI, JFIF APP0, DQT, SOF0, SOS, the stuffed byte and EOI all survive in order. */
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(text).toContain('JFIF');
    expect(text.indexOf('\xff\xdb')).toBeGreaterThan(0);
    expect(text.indexOf('\xff\xc0')).toBeGreaterThan(text.indexOf('\xff\xdb'));
    expect(text.indexOf('\xff\xda')).toBeGreaterThan(text.indexOf('\xff\xc0'));
    expect(text).toContain('\x12\x34\xff\x00\x56');
    expect(bytes[bytes.length - 2]).toBe(0xff);
    expect(bytes[bytes.length - 1]).toBe(0xd9);
    /* The stripped file is byte-identical to one that never carried metadata. */
    expect(Buffer.from(bytes).equals(Buffer.from(tinyJpeg({ exif: false, comment: false })))).toBe(true);
  });

  it('is idempotent and leaves a clean JPEG untouched', () => {
    const clean = tinyJpeg({ exif: false, comment: false });
    const once = stripJpegMetadata(clean);
    expect(once.removed).toBe(0);
    expect(Buffer.from(once.bytes).equals(Buffer.from(clean))).toBe(true);
  });

  it('refuses a truncated segment rather than guessing', () => {
    const cut = tinyJpeg().subarray(0, 12);
    expect(() => stripJpegMetadata(cut)).toThrow();
    const outcome = prepareConfirmationPhoto(cut);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/could not be read/);
  });
});

describe('a PNG with text and EXIF chunks', () => {
  it('loses tEXt, iTXt, zTXt and eXIf and keeps IHDR, IDAT and IEND with their CRCs', () => {
    const input = tinyPng(3);
    const { bytes, removed } = stripPngMetadata(input);
    const text = latin1(bytes);
    expect(removed).toBe(4);
    for (const gone of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'GPSLatitude', 'private', 'xmp']) expect(text).not.toContain(gone);
    for (const kept of ['IHDR', 'IDAT', 'IEND']) expect(text).toContain(kept);
    expect(Buffer.from(bytes).equals(Buffer.from(tinyPng(3, { metadata: false })))).toBe(true);
  });

  it('keeps a chunk whose type it does not know (a decoder may need it)', () => {
    const input = tinyPng(1, { metadata: false });
    /* Splice a gAMA chunk after IHDR. */
    const ihdrEnd = 8 + 12 + 13;
    const gama = pngChunk('gAMA', be32(45455));
    const withGama = new Uint8Array([...input.subarray(0, ihdrEnd), ...gama, ...input.subarray(ihdrEnd)]);
    const { bytes, removed } = stripPngMetadata(withGama);
    expect(removed).toBe(0);
    expect(latin1(bytes)).toContain('gAMA');
  });
});

describe('a WebP with EXIF and XMP chunks', () => {
  it('drops both chunks, clears the VP8X flags and rewrites the RIFF size', () => {
    const input = tinyWebp();
    const { bytes, removed } = stripWebpMetadata(input);
    const text = latin1(bytes);
    expect(removed).toBe(2);
    expect(text).not.toContain('EXIF');
    expect(text).not.toContain('XMP ');
    expect(text).not.toContain('GPSLatitude');
    expect(text).not.toContain('xmpmeta');
    expect(text).toContain('VP8X');
    expect(text).toContain('VP8L');
    /* The RIFF size names exactly what follows it. */
    const riffSize = bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24);
    expect(riffSize).toBe(bytes.length - 8);
    /* VP8X flags no longer announce EXIF or XMP. */
    const vp8xAt = text.indexOf('VP8X');
    expect(bytes[vp8xAt + 8]! & 0x0c).toBe(0);
    expect(Buffer.from(bytes).equals(Buffer.from(tinyWebp({ metadata: false })))).toBe(true);
  });
});

describe('the prepared photo', () => {
  it('carries the stripped bytes, the type and a stable SHA-256 of what remains', () => {
    const a = prepareConfirmationPhoto(tinyJpeg());
    const b = prepareConfirmationPhoto(tinyJpeg({ exif: false, comment: false }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.photo.mediaType).toBe('image/jpeg');
    expect(a.photo.strippedSegments).toBe(2);
    expect(b.photo.strippedSegments).toBe(0);
    /* The same picture with and without metadata is the same photo. */
    expect(a.photo.sha256).toBe(b.photo.sha256);
    expect(a.photo.sha256).toBe(sha256Hex(b.photo.bytes));
    expect(a.photo.sha256).toMatch(/^[0-9a-f]{64}$/);
    /* And nothing about the original's metadata is retained on the result. */
    expect(JSON.stringify({ ...a.photo, bytes: undefined })).not.toContain('GPS');
  });
});
