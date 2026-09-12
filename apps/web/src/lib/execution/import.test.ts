import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, describeExtraction, htmlToText, prepareImport, senderDomainOf, sniffBytes } from './import';

/**
 * V9 §6 — A CONFIRMATION BECOMES FACTS, AND ONLY FACTS.
 *
 * Three documents a traveller actually forwards — a hotel confirmation e-mail,
 * an airline record locator, an e-mail whose booking is in the attached PDF —
 * and the three refusals that keep the door honest: too big, not a document,
 * and a card number that must never survive into what is stored.
 */
const WINDOW = { tripStart: '2026-09-12', tripEnd: '2026-09-18' };

const HOTEL_EMAIL = `From: Booking.com <noreply@booking.com>
Subject: Your booking is confirmed at Harbour View Hotel

Thanks, Alex! Your booking at Harbour View Hotel is confirmed.
Confirmation number: 4471.882.301
PIN code: 9932
Check-in: Saturday, 12 September 2026 (from 15:00)
Check-out: Tuesday, 15 September 2026 (until 11:00)
Room: 1 Double Room, 2 adults
Address: 14 Quay Street, Harbour City
Total price: € 486.00
Free cancellation until 10 September 2026 23:59
Paid with card 4111 1111 1111 1111
Questions? Call +44 20 7946 0958 or reply to alex.traveller@example.com
`;

const FLIGHT_EMAIL = `Subject: Your itinerary — record locator K7PQ2M
Icelandair booking confirmation
Record locator: K7PQ2M
Passenger: 1 adult
FI 455 KEF → CDG
Departs 18 Sep 2026 at 07:35, arrives 12:50 (CET)
Seat 14A · Boarding at 06:55
Total paid: USD 312.40
Non-refundable fare.
`;

/** A minimal, valid PDF with one page of Helvetica lines — enough for a text extractor, no compression. */
function tinyPdf(lines: readonly string[]): Uint8Array {
  const content = ['BT', '/F1 12 Tf', '72 740 Td', '14 TL', ...lines.map((l, i) => `${i === 0 ? '' : 'T* '}(${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

function emlWithAttachment(pdf: Uint8Array): Uint8Array {
  const boundary = 'sq-boundary-42';
  const raw = [
    'From: Ferry Desk <bookings@smyrilline.fo>',
    'To: alex@example.com',
    'Subject: Your Smyril Line booking',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hi Alex, your ferry booking is attached. Bring the reference with you.',
    'Our number is +298 34 59 00.',
    '',
    `--${boundary}`,
    'Content-Type: application/pdf; name="booking.pdf"',
    'Content-Disposition: attachment; filename="booking.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(pdf).toString('base64').replace(/(.{76})/g, '$1\n'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return new Uint8Array(Buffer.from(raw, 'utf8'));
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('a pasted hotel confirmation', () => {
  it('reads the stay, the dates, the reference and the amount', async () => {
    const outcome = await prepareImport({ kind: 'text', text: HOTEL_EMAIL, sender: 'noreply@booking.com' }, WINDOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { extracted } = outcome.prepared;
    expect(extracted.type).toBe('lodging');
    expect(extracted.provider).toBe('Booking.com');
    expect(extracted.date).toBe('2026-09-12');
    expect(extracted.endDate).toBe('2026-09-15');
    expect(extracted.confirmationRef).toMatch(/^4471/);
    expect(extracted.cost).toEqual({ amount: 486, currency: 'EUR' });
    expect(extracted.cancellationDeadline).toBe('2026-09-10');
    expect(extracted.travellers).toBe(2);
    expect(extracted.title).toMatch(/Harbour View Hotel/);
    /* Every field shows its work. */
    for (const field of extracted.fields) {
      expect(field.evidence.length).toBeGreaterThan(0);
      expect(['high', 'medium', 'low']).toContain(field.confidence);
    }
  });

  it('removes the card number, the phone number and the e-mail address before anything can be stored', async () => {
    const outcome = await prepareImport({ kind: 'text', text: HOTEL_EMAIL }, WINDOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { redactedText, extracted } = outcome.prepared;
    expect(redactedText).not.toContain('4111 1111 1111 1111');
    expect(redactedText).not.toContain('7946 0958');
    expect(redactedText).not.toContain('alex.traveller@example.com');
    expect(redactedText).toContain('[card number removed]');
    const everything = JSON.stringify(extracted);
    expect(everything).not.toContain('4111');
    expect(everything).not.toContain('example.com');
    /* The redaction never eats the reference or the amount. */
    expect(extracted.confirmationRef).toBeDefined();
    expect(extracted.cost?.amount).toBe(486);
  });
});

describe('a flight record locator', () => {
  it('reads the flight, its date and the locator', async () => {
    const outcome = await prepareImport({ kind: 'text', text: FLIGHT_EMAIL }, WINDOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { extracted } = outcome.prepared;
    expect(extracted.type).toBe('flight');
    expect(extracted.date).toBe('2026-09-18');
    expect(extracted.confirmationRef).toBe('K7PQ2M');
    expect(extracted.title).toMatch(/FI455/);
    expect(extracted.title).toMatch(/KEF → CDG/);
    expect(extracted.startTime).toBe('07:35');
    expect(extracted.cost).toEqual({ amount: 312.4, currency: 'USD' });
    expect(extracted.fields.some((f) => f.key === 'cancellation' && f.value === 'non_refundable')).toBe(true);
  });
});

describe('an e-mail file with the booking in a PDF attachment', () => {
  const pdf = tinyPdf(['Smyril Line - Booking confirmation', 'Booking reference: SL88214', 'Ferry: Hirtshals to Torshavn', 'Departure date: 14 September 2026', 'Departs 15:30', '2 passengers, 1 vehicle', 'Total amount: 3,420.00 DKK']);

  it('reads the attachment through the e-mail and finds the crossing', async () => {
    const outcome = await prepareImport({ kind: 'file', fileBase64: b64(emlWithAttachment(pdf)), filename: 'booking.eml' }, WINDOW);
    expect(outcome.ok, outcome.ok ? '' : outcome.error).toBe(true);
    if (!outcome.ok) return;
    const { prepared } = outcome;
    expect(prepared.sourceKind).toBe('eml');
    expect(prepared.attachmentsRead).toBe(1);
    expect(prepared.senderDomain).toBe('smyrilline.fo');
    expect(prepared.subject).toBe('Your Smyril Line booking');
    expect(prepared.extracted.type).toBe('ferry');
    expect(prepared.extracted.confirmationRef).toBe('SL88214');
    expect(prepared.extracted.date).toBe('2026-09-14');
    expect(prepared.extracted.startTime).toBe('15:30');
    expect(prepared.extracted.cost).toEqual({ amount: 3420, currency: 'DKK' });
    /* The phone number in the body did not survive. */
    expect(prepared.redactedText).not.toContain('34 59 00');
  });

  it('reads the same PDF on its own', async () => {
    const outcome = await prepareImport({ kind: 'file', fileBase64: b64(pdf), filename: 'anything.txt' }, WINDOW);
    expect(outcome.ok, outcome.ok ? '' : outcome.error).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.prepared.sourceKind).toBe('pdf');
    expect(outcome.prepared.extracted.confirmationRef).toBe('SL88214');
  });
});

describe('what is refused at the door', () => {
  it('refuses a 3 MB PDF by size before reading it', async () => {
    const big = new Uint8Array(3 * 1024 * 1024);
    big.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
    const outcome = await prepareImport({ kind: 'file', fileBase64: b64(big), filename: 'big.pdf' }, WINDOW);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(/2 MB/);
    expect(outcome.error).not.toMatch(/limit|bytes|schema/i);
  });

  it('refuses an executable renamed .pdf by its bytes, not its name', async () => {
    const exe = new Uint8Array(4096);
    exe[0] = 0x4d;
    exe[1] = 0x5a;
    for (let i = 2; i < exe.length; i += 1) exe[i] = i % 7 === 0 ? 0x00 : (i * 31) % 256;
    expect(sniffBytes(exe)).toBe('unknown');
    const outcome = await prepareImport({ kind: 'file', fileBase64: b64(exe), filename: 'invoice.pdf' }, WINDOW);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(/not a confirmation Sidequest can read/);
  });

  it('refuses pasted text past the limit and an empty paste', async () => {
    const huge = 'x'.repeat(IMPORT_LIMITS.textBytes + 1);
    expect((await prepareImport({ kind: 'text', text: huge }, WINDOW)).ok).toBe(false);
    expect((await prepareImport({ kind: 'text', text: '   ' }, WINDOW)).ok).toBe(false);
  });

  it('accepts a photo only as an empty reading for the explicit press, and never keeps the bytes in the extraction', async () => {
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const outcome = await prepareImport({ kind: 'file', fileBase64: b64(png), filename: 'photo.png' }, WINDOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.prepared.sourceKind).toBe('image');
    expect(outcome.prepared.image?.mediaType).toBe('image/png');
    expect(outcome.prepared.redactedText).toBe('');
    expect(outcome.prepared.extracted.gaps[0]).toMatch(/photo/);
    expect(JSON.stringify(outcome.prepared.extracted)).not.toContain('bytes');
  });
});

describe('the small helpers', () => {
  it('sniffs by magic bytes', () => {
    expect(sniffBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe('pdf');
    expect(sniffBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffBytes(new TextEncoder().encode('From: a@b.co\r\nSubject: hi\r\n\r\nbody'))).toBe('eml');
    expect(sniffBytes(new TextEncoder().encode('Subject: Your itinerary\nIcelandair booking confirmation\nRecord locator: K7PQ2M'))).toBe('text');
    expect(sniffBytes(new TextEncoder().encode('Your booking is confirmed.'))).toBe('text');
  });

  it('turns HTML into lines the extractor can label', () => {
    const text = htmlToText('<html><body><p>Check-in: <b>12 Sep 2026</b></p><br><div>Total: &euro;40 &amp; more</div><script>alert(1)</script></body></html>');
    expect(text).toBe('Check-in: 12 Sep 2026\n\nTotal: &euro;40 & more');
  });

  it('reads a sender domain from an address or a domain', () => {
    expect(senderDomainOf('Booking <noreply@booking.com>')).toBe('booking.com');
    expect(senderDomainOf('airbnb.com')).toBe('airbnb.com');
    expect(senderDomainOf('not a domain')).toBeUndefined();
  });

  it('describes what was found in a sentence a traveller reads', () => {
    expect(describeExtraction({ type: 'custom', typeConfidence: 'low', fields: [], gaps: ['The date'] })).toMatch(/could not read a booking/);
    /* The count is the number of lines the review shows, so the sentence never disagrees with the list under it. */
    expect(describeExtraction({ type: 'lodging', typeConfidence: 'high', title: 'Hotel', date: '2026-09-12', fields: [{ key: 'title', value: 'Hotel', confidence: 'high', evidence: 'Hotel' }, { key: 'date', value: '2026-09-12', confidence: 'high', evidence: '12 Sep 2026' }], gaps: ['A confirmation reference'] })).toMatch(/Found 2 things; still missing a confirmation reference/);
  });
});
