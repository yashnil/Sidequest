import { extractConfirmation, redactSensitive, type ExtractedConfirmation } from '@sidequest/core';
import type { ImportSourceKind } from '@/lib/db/execution-repository';

/**
 * V9 §6 — READING A CONFIRMATION THE TRAVELLER HANDED OVER.
 *
 * Pasted text, an `.eml`, a `.pdf` or a photo become one redacted text and a
 * deterministic extraction. Order matters and is fixed here:
 *
 *   1. the bytes are refused by size and by what they actually are (magic
 *      bytes, never the filename);
 *   2. the document is read to text — an e-mail's plain body, its HTML
 *      stripped to words, its PDF and text attachments;
 *   3. card numbers, account numbers, e-mail addresses and phone numbers are
 *      removed (`redactSensitive`) BEFORE anything is stored or sent anywhere;
 *   4. `extractConfirmation` reads the redacted text with the trip window and
 *      the sender's domain as hints.
 *
 * Nothing here persists; the caller stores only the extraction. The raw
 * document is never written to disk or a row. A photo carries no text this
 * module can read: it is accepted only for the explicit "Ask Sidequest to
 * read it" path and is refused here with a sentence.
 */
export const IMPORT_LIMITS = {
  /** Pasted text and `.eml` files. */
  textBytes: 512 * 1024,
  /** A PDF, alone or as an attachment. */
  pdfBytes: 2 * 1024 * 1024,
  /** A photo, only ever read by the explicit model path. */
  imageBytes: 4 * 1024 * 1024,
} as const;

export type ImportKindHint = 'text' | 'file';

export interface ImportInput {
  kind: ImportKindHint;
  text?: string;
  /** Base64 of the whole file. */
  fileBase64?: string;
  filename?: string;
  subject?: string;
  /** The sender's address or domain, when the traveller has it. */
  sender?: string;
}

export interface PreparedImport {
  sourceKind: ImportSourceKind;
  /** The redacted text the extraction read. Never the raw document. */
  redactedText: string;
  extracted: ExtractedConfirmation;
  subject?: string;
  senderDomain?: string;
  /** How many attachments were read into the text. */
  attachmentsRead: number;
  /** A photo the traveller chose, held for the explicit model path only; never stored. */
  image?: { bytes: Uint8Array; mediaType: 'image/png' | 'image/jpeg' };
}

export type PrepareOutcome = { ok: true; prepared: PreparedImport } | { ok: false; error: string };

export type SniffedType = 'pdf' | 'png' | 'jpeg' | 'eml' | 'text' | 'unknown';

/** What the bytes are, read from their first bytes and never from a filename. */
export function sniffBytes(bytes: Uint8Array): SniffedType {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return 'pdf';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
  if (looksLikeBinary(head)) return 'unknown';
  return looksLikeRawEmail(head) ? 'eml' : 'text';
}

/**
 * A raw e-mail, as opposed to a paste that happens to start with "Subject:":
 * an unbroken block of header lines (folded continuations allowed) that ends
 * in a blank line and carries at least one transport header. A paste whose
 * second line is prose is text, and goes to the reader as text.
 */
function looksLikeRawEmail(head: string): boolean {
  const lines = head.split(/\r?\n/);
  if (/^From \S+/.test(lines[0] ?? '')) return true;
  let sawTransportHeader = false;
  let sawHeader = false;
  for (const line of lines) {
    if (line.length === 0) return sawHeader && sawTransportHeader;
    if (/^[ \t]/.test(line) && sawHeader) continue;
    const header = line.match(/^([A-Za-z][A-Za-z0-9-]*):/);
    if (!header) return false;
    sawHeader = true;
    if (/^(from|received|mime-version|message-id|content-type|return-path|delivered-to|to|date)$/i.test(header[1]!)) sawTransportHeader = true;
  }
  return false;
}

function looksLikeBinary(sample: string): boolean {
  let control = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const c = sample.charCodeAt(i);
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.05;
}

/** HTML to readable lines: block boundaries become newlines, tags go, entities are decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table|section|article|header|footer|blockquote)\s*>/gi, '\n')
    .replace(/<\s*(td|th)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function senderDomainOf(sender: string | undefined): string | undefined {
  if (!sender) return undefined;
  const at = sender.lastIndexOf('@');
  const domain = (at >= 0 ? sender.slice(at + 1) : sender).replace(/[>\s"']+$/g, '').trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : undefined;
}

async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { extractText } = await import('unpdf');
  const result = await extractText(bytes, { mergePages: true });
  return result.text.replace(/[ \t]+\n/g, '\n').trim();
}

async function emlToText(bytes: Uint8Array): Promise<{ text: string; subject?: string; senderDomain?: string; attachmentsRead: number }> {
  const { default: PostalMime } = await import('postal-mime');
  const mail = await PostalMime.parse(bytes, { attachmentEncoding: 'arraybuffer' });
  const parts: string[] = [];
  if (mail.subject) parts.push(`Subject: ${mail.subject}`);
  const body = mail.text?.trim() || (mail.html ? htmlToText(mail.html) : '');
  if (body) parts.push(body);
  let attachmentsRead = 0;
  for (const attachment of mail.attachments) {
    const content = attachment.content;
    const raw = typeof content === 'string' ? new TextEncoder().encode(content) : content instanceof Uint8Array ? content : new Uint8Array(content);
    const sniffed = sniffBytes(raw);
    if (sniffed === 'pdf' || attachment.mimeType === 'application/pdf') {
      if (raw.byteLength > IMPORT_LIMITS.pdfBytes) continue;
      try {
        const text = await pdfToText(raw);
        if (text) {
          parts.push(`\n--- ${attachment.filename ?? 'attachment'} ---\n${text}`);
          attachmentsRead += 1;
        }
      } catch {
        /* an unreadable attachment is skipped; the body still counts */
      }
      continue;
    }
    if (attachment.mimeType.startsWith('text/') && raw.byteLength <= IMPORT_LIMITS.textBytes) {
      const text = new TextDecoder().decode(raw).trim();
      if (text) {
        parts.push(`\n--- ${attachment.filename ?? 'attachment'} ---\n${attachment.mimeType === 'text/html' ? htmlToText(text) : text}`);
        attachmentsRead += 1;
      }
    }
  }
  const fromAddress = mail.from && 'address' in mail.from ? mail.from.address : undefined;
  return { text: parts.join('\n'), ...(mail.subject ? { subject: mail.subject } : {}), ...(senderDomainOf(fromAddress) ? { senderDomain: senderDomainOf(fromAddress) } : {}), attachmentsRead };
}

function decodeBase64(value: string): Uint8Array | null {
  const cleaned = value.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (cleaned.length === 0 || !/^[A-Za-z0-9+/=_-]+$/.test(cleaned)) return null;
  try {
    return new Uint8Array(Buffer.from(cleaned.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  } catch {
    return null;
  }
}

const TOO_BIG_TEXT = 'That is larger than Sidequest reads (512 KB). Paste just the part with the booking details.';
const TOO_BIG_PDF = 'That PDF is larger than Sidequest reads (2 MB). Paste the text from it instead.';
const TOO_BIG_IMAGE = 'That photo is larger than Sidequest reads (4 MB). A smaller photo, or the text itself, works.';
const NOT_A_DOCUMENT = 'That file is not a confirmation Sidequest can read. Paste the text, or choose a PDF, an e-mail file or a photo.';

/**
 * Parse, redact and extract. Pure apart from reading the packages; nothing is stored.
 */
export async function prepareImport(input: ImportInput, hints: { tripStart?: string; tripEnd?: string }): Promise<PrepareOutcome> {
  const subject = input.subject?.trim().slice(0, 300) || undefined;
  const senderDomain = senderDomainOf(input.sender?.trim());
  const base = { ...(subject ? { subject } : {}), ...(senderDomain ? { senderDomain } : {}) };

  if (input.kind === 'text') {
    const text = (input.text ?? '').trim();
    if (text.length === 0) return { ok: false, error: 'Paste the confirmation first.' };
    if (Buffer.byteLength(text, 'utf8') > IMPORT_LIMITS.textBytes) return { ok: false, error: TOO_BIG_TEXT };
    /* Pasted text that is itself a raw e-mail is read as one. */
    const bytes = new TextEncoder().encode(text);
    if (sniffBytes(bytes) === 'eml') {
      const mail = await emlToText(bytes);
      return finish('eml', mail.text, { ...base, ...(mail.subject ? { subject: mail.subject } : {}), ...(mail.senderDomain ? { senderDomain: mail.senderDomain } : {}) }, hints, mail.attachmentsRead);
    }
    return finish('text', text, base, hints, 0);
  }

  const bytes = input.fileBase64 ? decodeBase64(input.fileBase64) : null;
  if (!bytes || bytes.byteLength === 0) return { ok: false, error: 'Choose a file first.' };
  const sniffed = sniffBytes(bytes);
  switch (sniffed) {
    case 'pdf': {
      if (bytes.byteLength > IMPORT_LIMITS.pdfBytes) return { ok: false, error: TOO_BIG_PDF };
      let text: string;
      try {
        text = await pdfToText(bytes);
      } catch {
        return { ok: false, error: 'That PDF could not be read. Paste the text from it instead.' };
      }
      if (text.length === 0) return { ok: false, error: 'That PDF holds no text Sidequest can read — it may be a scan. Ask Sidequest to read a photo of it, or paste the details.' };
      return finish('pdf', text, base, hints, 0);
    }
    case 'eml': {
      if (bytes.byteLength > IMPORT_LIMITS.textBytes) return { ok: false, error: TOO_BIG_TEXT };
      const mail = await emlToText(bytes);
      if (mail.text.trim().length === 0) return { ok: false, error: 'That e-mail has no text Sidequest can read.' };
      return finish('eml', mail.text, { ...base, ...(mail.subject ? { subject: mail.subject } : {}), ...(mail.senderDomain ? { senderDomain: mail.senderDomain } : {}) }, hints, mail.attachmentsRead);
    }
    case 'text': {
      if (bytes.byteLength > IMPORT_LIMITS.textBytes) return { ok: false, error: TOO_BIG_TEXT };
      return finish('text', new TextDecoder().decode(bytes), base, hints, 0);
    }
    case 'png':
    case 'jpeg': {
      if (bytes.byteLength > IMPORT_LIMITS.imageBytes) return { ok: false, error: TOO_BIG_IMAGE };
      /*
       * A photo has no text to extract deterministically. It is accepted as an
       * import whose reading is empty, so the review can offer the one explicit
       * press that reads it. The bytes travel with the result and are never stored.
       */
      const extracted = extractConfirmation('', { ...hints, ...base });
      return {
        ok: true,
        prepared: {
          sourceKind: 'image',
          redactedText: '',
          extracted: { ...extracted, gaps: ['Sidequest cannot read a photo on its own. Ask Sidequest to read it, or paste the text.'] },
          ...base,
          attachmentsRead: 0,
          image: { bytes, mediaType: sniffed === 'png' ? 'image/png' : 'image/jpeg' },
        },
      };
    }
    default:
      return { ok: false, error: NOT_A_DOCUMENT };
  }
}

function finish(sourceKind: ImportSourceKind, rawText: string, base: { subject?: string; senderDomain?: string }, hints: { tripStart?: string; tripEnd?: string }, attachmentsRead: number): PrepareOutcome {
  const redactedText = redactSensitive(rawText).trim();
  if (redactedText.length === 0) return { ok: false, error: 'There was nothing to read in that.' };
  const extracted = extractConfirmation(redactedText, { ...hints, ...base });
  return { ok: true, prepared: { sourceKind, redactedText, extracted, ...base, attachmentsRead } };
}

/** The sentence the review screen leads with, from what was and was not found. */
export function describeExtraction(extracted: ExtractedConfirmation): string {
  /* Every line the review lists is a thing found; the count says the same number the traveller can see. */
  const found = extracted.fields.filter((f) => f.key !== 'timeZoneHint');
  if (found.length === 0) return 'Sidequest could not read a booking from this. Fill in what you know, or ask Sidequest to read it.';
  return `Found ${found.length === 1 ? 'one thing' : `${found.length} things`}${extracted.gaps.length > 0 ? `; still missing ${extracted.gaps.map((g) => g.toLowerCase()).join(', ')}` : ''}. Check each line before confirming.`;
}
