import { z } from 'zod';
import { BOOKED_ITEM_TYPES, type BookedItemType } from '../intelligence/booking';

/**
 * V9 §6 — READING A CONFIRMATION WITHOUT A MODEL.
 *
 * Deterministic extraction from the text of a confirmation e-mail, PDF or
 * paste: the provider, the kind of booking, dates, local times, a time zone
 * token, an address, an amount with its currency, a reference number, a
 * cancellation deadline. Every field carries its confidence and the snippet
 * it came from, so the review screen can show its work and the traveller can
 * correct it. Nothing here is persisted; the caller redacts first
 * (`redactSensitive`) and stores only what the traveller confirms.
 *
 * The trip's own dates disambiguate `12/09/2026`: whichever reading falls
 * inside or nearest the trip window wins. Unknown stays unknown.
 */
export const extractedFieldSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.string().min(1),
});
export type ExtractedField = z.infer<typeof extractedFieldSchema>;

export const extractedConfirmationSchema = z.object({
  type: z.enum(BOOKED_ITEM_TYPES),
  typeConfidence: z.enum(['high', 'medium', 'low']),
  title: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  date: z.string().optional(),
  endDate: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  timeZone: z.string().optional(),
  location: z.string().optional(),
  confirmationRef: z.string().optional(),
  cost: z.object({ amount: z.number().min(0), currency: z.string().min(1) }).optional(),
  cancellationDeadline: z.string().optional(),
  travellers: z.number().int().min(1).optional(),
  fields: z.array(extractedFieldSchema).default([]),
  /** Facts the extractor could not settle, in the traveller's words. */
  gaps: z.array(z.string().min(1)).default([]),
});
export type ExtractedConfirmation = z.infer<typeof extractedConfirmationSchema>;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

const CURRENCY_SYMBOLS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', 'C$': 'CAD', 'A$': 'AUD', 'CA$': 'CAD', 'NZ$': 'NZD', 'US$': 'USD', 'HK$': 'HKD', 'S$': 'SGD', 'R$': 'BRL', '₩': 'KRW', '₺': 'TRY', '₪': 'ILS', kr: 'SEK', CHF: 'CHF' };
const CURRENCY_CODES = /\b(USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF|SEK|NOK|DKK|INR|CNY|RMB|HKD|SGD|THB|IDR|MYR|KRW|TWD|VND|PHP|ZAR|KES|TZS|MAD|EGP|AED|SAR|TRY|ILS|MXN|BRL|ARS|CLP|COP|PEN|ISK|CZK|PLN|HUF|RON|BGN|HRK|RSD)\b/;

const KNOWN_PROVIDERS: readonly { pattern: RegExp; name: string; type: BookedItemType }[] = [
  { pattern: /booking\.com/i, name: 'Booking.com', type: 'lodging' },
  { pattern: /airbnb/i, name: 'Airbnb', type: 'lodging' },
  { pattern: /expedia/i, name: 'Expedia', type: 'lodging' },
  { pattern: /hotels\.com/i, name: 'Hotels.com', type: 'lodging' },
  { pattern: /agoda/i, name: 'Agoda', type: 'lodging' },
  { pattern: /marriott|hilton|hyatt|accor|ihg|four seasons/i, name: 'Hotel', type: 'lodging' },
  { pattern: /\b(ana|jal|lufthansa|british airways|air canada|united|delta|american airlines|emirates|qatar airways|singapore airlines|cathay|klm|air france|ryanair|easyjet|westjet|icelandair|kenya airways|ethiopian)\b/i, name: 'Airline', type: 'flight' },
  { pattern: /via rail|amtrak|eurostar|jr east|jr west|jr central|trenitalia|renfe|sncf|deutsche bahn|db bahn|öbb|sbb/i, name: 'Rail operator', type: 'train' },
  { pattern: /bc ferries|smyril|caledonian macbrayne|calmac|stena|dfds|brittany ferries/i, name: 'Ferry operator', type: 'ferry' },
  { pattern: /hertz|avis|europcar|enterprise|budget car|sixt|alamo|national car|thrifty|turo/i, name: 'Car hire', type: 'rental_car' },
  { pattern: /parks canada|recreation\.gov|nps\.gov|reserve california|visit.*permit/i, name: 'Park or permit authority', type: 'activity' },
  { pattern: /opentable|resy|tabelog|thefork|quandoo/i, name: 'Restaurant reservation', type: 'restaurant' },
  { pattern: /viator|getyourguide|klook|airbnb experiences|tripadvisor experiences/i, name: 'Tour operator', type: 'activity' },
];

const TYPE_WORDS: readonly { pattern: RegExp; type: BookedItemType; weight: number }[] = [
  { pattern: /\b(check-?in|check-?out|room|suite|hotel|hostel|apartment|lodge|guesthouse|ryokan|b&b|nights?\b)/i, type: 'lodging', weight: 2 },
  { pattern: /\b(flight|boarding|departure gate|airline|e-?ticket|pnr|record locator|terminal|seat \d+[a-k])\b/i, type: 'flight', weight: 3 },
  { pattern: /\b(train|rail|coach \d|carriage|platform|seat reservation)\b/i, type: 'train', weight: 2 },
  { pattern: /\b(ferry|sailing|vessel|port of|boarding at the pier)\b/i, type: 'ferry', weight: 2 },
  { pattern: /\b(rental|hire car|pick-?up location|drop-?off|vehicle|car hire)\b/i, type: 'rental_car', weight: 2 },
  { pattern: /\b(transfer|shuttle|driver will|pickup time)\b/i, type: 'transfer', weight: 2 },
  { pattern: /\b(table|reservation for \d+ (?:guests|people|persons)|dinner|lunch|restaurant)\b/i, type: 'restaurant', weight: 2 },
  { pattern: /\b(ticket|admission|entry|permit|tour|excursion|guide|experience|activity)\b/i, type: 'activity', weight: 1 },
  { pattern: /\b(concert|match|performance|show|event)\b/i, type: 'event', weight: 1 },
];

const TIME_ZONE_TOKENS = /\b(Asia\/[A-Za-z_]+|Europe\/[A-Za-z_]+|America\/[A-Za-z_]+|Africa\/[A-Za-z_]+|Australia\/[A-Za-z_]+|Pacific\/[A-Za-z_]+|UTC|GMT|JST|CET|CEST|EST|EDT|PST|PDT|MST|MDT|CST|CDT|BST|IST|AEST|AEDT|EAT)\b/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

interface DateHit {
  value: string;
  index: number;
  evidence: string;
  ambiguous: boolean;
  alternative?: string;
}

function findDates(text: string): DateHit[] {
  const hits: DateHit[] = [];
  const push = (value: string | null, index: number, evidence: string, alternative?: string | null) => {
    if (!value) return;
    hits.push({ value, index, evidence: evidence.trim(), ambiguous: Boolean(alternative && alternative !== value), ...(alternative && alternative !== value ? { alternative } : {}) });
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(isoDate(Number(m[1]), Number(m[2]), Number(m[3])), m.index ?? 0, m[0]);
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/gi)) push(isoDate(Number(m[3]), MONTHS[m[2]!.toLowerCase()] ?? 0, Number(m[1])), m.index ?? 0, m[0]);
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi)) push(isoDate(Number(m[3]), MONTHS[m[1]!.toLowerCase()] ?? 0, Number(m[2])), m.index ?? 0, m[0]);
  for (const m of text.matchAll(/\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{4})\b/gi)) push(isoDate(Number(m[3]), MONTHS[m[2]!.toLowerCase()] ?? 0, Number(m[1])), m.index ?? 0, m[0]);
  for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    const dayFirst = isoDate(y, b, a);
    const monthFirst = isoDate(y, a, b);
    if (dayFirst && monthFirst && dayFirst !== monthFirst) push(dayFirst, m.index ?? 0, m[0], monthFirst);
    else push(dayFirst ?? monthFirst, m.index ?? 0, m[0]);
  }
  return hits.sort((x, y) => x.index - y.index);
}

function inWindow(date: string, start?: string, end?: string): boolean {
  if (!start || !end) return true;
  return date >= start && date <= end;
}

function distanceToWindow(date: string, start?: string, end?: string): number {
  if (!start || !end) return 0;
  if (date >= start && date <= end) return 0;
  const d = Date.parse(`${date}T00:00:00Z`);
  return Math.min(Math.abs(d - Date.parse(`${start}T00:00:00Z`)), Math.abs(d - Date.parse(`${end}T00:00:00Z`))) / 86_400_000;
}

function resolveAmbiguity(hit: DateHit, hints: { tripStart?: string; tripEnd?: string }): string {
  if (!hit.ambiguous || !hit.alternative) return hit.value;
  return distanceToWindow(hit.value, hints.tripStart, hints.tripEnd) <= distanceToWindow(hit.alternative, hints.tripStart, hints.tripEnd) ? hit.value : hit.alternative;
}

function findTimes(text: string): { value: string; index: number; evidence: string }[] {
  const out: { value: string; index: number; evidence: string }[] = [];
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?\b/gi)) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const suffix = m[3]?.toLowerCase().replace(/\./g, '');
    if (h > 23 || min > 59) continue;
    if (suffix === 'pm' && h < 12) h += 12;
    if (suffix === 'am' && h === 12) h = 0;
    out.push({ value: `${pad(h)}:${pad(min)}`, index: m.index ?? 0, evidence: m[0] });
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s*(am|pm)\b/gi)) {
    let h = Number(m[1]);
    if (h > 12) continue;
    if (m[2]!.toLowerCase() === 'pm' && h < 12) h += 12;
    if (m[2]!.toLowerCase() === 'am' && h === 12) h = 0;
    out.push({ value: `${pad(h)}:00`, index: m.index ?? 0, evidence: m[0] });
  }
  return out.sort((a, b) => a.index - b.index);
}

function labelledLine(text: string, labels: RegExp): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(labels);
    if (m) {
      const rest = line.slice((m.index ?? 0) + m[0].length).replace(/^[\s:.-]+/, '').trim();
      if (rest.length > 1) return rest;
    }
  }
  return null;
}

/** Strip what must never leave the server or be stored: card numbers, phone numbers, e-mail addresses, IBANs. */
export function redactSensitive(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card number removed]')
    .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}\b/g, '[account removed]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]')
    .replace(/(?:\+|00)\d{1,3}[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?){2,5}\d{2,4}\b/g, '[phone removed]');
}

export function extractConfirmation(rawText: string, hints: { tripStart?: string; tripEnd?: string; senderDomain?: string; subject?: string } = {}): ExtractedConfirmation {
  const text = rawText.replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const haystack = `${hints.subject ?? ''}\n${hints.senderDomain ?? ''}\n${text}`;
  const fields: ExtractedField[] = [];
  const gaps: string[] = [];

  // Provider and type -------------------------------------------------------------------------
  let provider: string | undefined;
  let type: BookedItemType = 'custom';
  let typeConfidence: ExtractedConfirmation['typeConfidence'] = 'low';
  const known = KNOWN_PROVIDERS.find((p) => p.pattern.test(haystack));
  if (known) {
    provider = known.name === 'Hotel' || known.name === 'Airline' || known.name === 'Rail operator' || known.name === 'Ferry operator' || known.name === 'Car hire' ? (haystack.match(known.pattern)?.[0] ?? known.name) : known.name;
    type = known.type;
    typeConfidence = 'medium';
    fields.push({ key: 'provider', value: provider, confidence: 'high', evidence: haystack.match(known.pattern)?.[0] ?? provider });
  } else if (hints.senderDomain) {
    provider = hints.senderDomain.replace(/^(mail|email|noreply|no-reply|booking|reservations)\./, '').split('.')[0] ?? hints.senderDomain;
    provider = provider.charAt(0).toUpperCase() + provider.slice(1);
    fields.push({ key: 'provider', value: provider, confidence: 'medium', evidence: hints.senderDomain });
  }
  const scores = new Map<BookedItemType, number>();
  for (const word of TYPE_WORDS) {
    const count = (haystack.match(new RegExp(word.pattern.source, 'gi')) ?? []).length;
    if (count > 0) scores.set(word.type, (scores.get(word.type) ?? 0) + count * word.weight);
  }
  const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best && (!known || best[1] >= 6)) {
    if (!known || best[0] === known.type || best[1] >= 8) {
      type = known && best[1] < 8 ? known.type : best[0];
      typeConfidence = best[1] >= 6 ? 'high' : best[1] >= 3 ? 'medium' : 'low';
    }
  }
  if (!best && !known) gaps.push('What kind of booking this is');

  // Reference --------------------------------------------------------------------------------
  /*
   * A label, an optional noun ("number", "reference", "(PNR)"), then a real
   * separator, then the value — which must carry a digit, so a label word
   * ("NUMBER", "BOOKING") can never be read as the reference.
   */
  const refMatch = [...text.matchAll(/(?:confirmation|booking|reservation|reference|record locator|pnr|itinerary|order)(?:\s+(?:number|no\.?|code|id|reference|ref\.?|locator))?(?:\s*\((?:pnr|ref|reference|code)\))?\s*(?:[:#]|\bis\b|—|-)\s*([A-Z0-9][A-Z0-9.-]{4,19})(?![A-Za-z0-9])/gi)].find((m) => /\d/.test(m[1]!) && !/^\d{1,2}$/.test(m[1]!));
  let confirmationRef: string | undefined;
  if (refMatch) {
    confirmationRef = refMatch[1]!.toUpperCase();
    fields.push({ key: 'confirmationRef', value: confirmationRef, confidence: /^(?:[A-Z]{2,}\d|\d{5,}|[A-Z0-9]{6})/i.test(confirmationRef) ? 'high' : 'medium', evidence: refMatch[0] });
  } else gaps.push('A confirmation reference');

  // Dates ------------------------------------------------------------------------------------
  const dates = findDates(text);
  const resolved = dates.map((d) => ({ ...d, value: resolveAmbiguity(d, hints) }));
  const checkIn = labelledLine(text, /\b(check-?in|arrival|arrive|from|start|departure date|departs|date)\b/i);
  const checkOut = labelledLine(text, /\b(check-?out|departure|depart|until|to|end|return)\b/i);
  const labelledDate = (line: string | null): string | undefined => {
    if (!line) return undefined;
    const hit = findDates(line)[0];
    return hit ? resolveAmbiguity(hit, hints) : undefined;
  };
  let date = labelledDate(checkIn);
  let endDate = labelledDate(checkOut);
  const candidates = resolved.filter((d) => inWindow(d.value, hints.tripStart, hints.tripEnd));
  if (!date) date = (candidates[0] ?? resolved[0])?.value;
  if (!endDate && (type === 'lodging' || type === 'rental_car')) {
    const later = (candidates.length > 0 ? candidates : resolved).find((d) => date && d.value > date);
    endDate = later?.value;
  }
  if (date) fields.push({ key: 'date', value: date, confidence: checkIn ? 'high' : candidates.length > 0 ? 'medium' : 'low', evidence: (resolved.find((d) => d.value === date) ?? { evidence: date }).evidence });
  else gaps.push('The date');
  if (endDate && endDate !== date) fields.push({ key: 'endDate', value: endDate, confidence: checkOut ? 'high' : 'medium', evidence: (resolved.find((d) => d.value === endDate) ?? { evidence: endDate }).evidence });
  if (endDate === date) endDate = undefined;

  // Times ------------------------------------------------------------------------------------
  const times = findTimes(text);
  let startTime: string | undefined;
  let endTime: string | undefined;
  if (type !== 'lodging' && times.length > 0) {
    startTime = times[0]!.value;
    fields.push({ key: 'startTime', value: startTime, confidence: /\b(dep|departs|departure|from|starts?|check-?in|pick-?up)\b[^\n]{0,40}$/i.test(text.slice(Math.max(0, times[0]!.index - 40), times[0]!.index)) ? 'high' : 'medium', evidence: times[0]!.evidence });
    if (times[1] && times[1].value !== startTime) {
      endTime = times[1].value;
      fields.push({ key: 'endTime', value: endTime, confidence: 'medium', evidence: times[1].evidence });
    }
  } else if (type === 'lodging') {
    const inTime = labelledLine(text, /check-?in(?: time| from)?/i);
    const outTime = labelledLine(text, /check-?out(?: time| by| until)?/i);
    const t1 = inTime ? findTimes(inTime)[0] : undefined;
    const t2 = outTime ? findTimes(outTime)[0] : undefined;
    if (t1) {
      startTime = t1.value;
      fields.push({ key: 'startTime', value: startTime, confidence: 'medium', evidence: inTime! });
    }
    if (t2) {
      endTime = t2.value;
      fields.push({ key: 'endTime', value: endTime, confidence: 'medium', evidence: outTime! });
    }
  }

  // Time zone ------------------------------------------------------------------------------
  const tz = text.match(TIME_ZONE_TOKENS)?.[1];
  const timeZone = tz && tz.includes('/') ? tz : undefined;
  if (timeZone) fields.push({ key: 'timeZone', value: timeZone, confidence: 'high', evidence: tz! });
  else if (tz) fields.push({ key: 'timeZoneHint', value: tz, confidence: 'low', evidence: tz });

  // Amount -----------------------------------------------------------------------------------
  let cost: ExtractedConfirmation['cost'];
  const amountLine = labelledLine(text, /\b(total(?: price| amount| paid| charged| due)?|amount (?:paid|due|charged)|grand total|price|paid|fare)\b/i) ?? text;
  const amountMatch = amountLine.match(/(US\$|CA\$|C\$|A\$|NZ\$|HK\$|S\$|R\$|[$€£¥₹₩₺₪])\s?(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{2})?)|(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{2})?)\s?(USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF|SEK|NOK|DKK|INR|CNY|HKD|SGD|THB|IDR|MYR|KRW|ZAR|KES|TZS|AED|MXN|BRL|ISK|CZK|PLN|HUF|kr)\b|(USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF|SEK|NOK|DKK|INR|CNY|HKD|SGD|THB|IDR|MYR|KRW|ZAR|KES|TZS|AED|MXN|BRL|ISK|CZK|PLN|HUF)\s?(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{2})?)/);
  if (amountMatch) {
    const symbol = amountMatch[1] ?? amountMatch[4] ?? amountMatch[5];
    const raw = amountMatch[2] ?? amountMatch[3] ?? amountMatch[6] ?? '';
    const normalised = raw.replace(/\s/g, '').replace(/,(?=\d{3}(?:\D|$))/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
    const amount = Number(normalised);
    const currency = symbol ? (CURRENCY_SYMBOLS[symbol] ?? symbol.toUpperCase()) : (text.match(CURRENCY_CODES)?.[1] ?? 'USD');
    if (Number.isFinite(amount) && amount > 0) {
      cost = { amount, currency };
      fields.push({ key: 'cost', value: `${amount} ${currency}`, confidence: amountLine !== text ? 'high' : 'medium', evidence: amountMatch[0] });
    }
  }

  // Cancellation deadline -------------------------------------------------------------------
  const cancelLine = text.split(/\n/).find((l) => /free cancellation|cancel(?:lation)? (?:by|until|before|deadline)|non-?refundable/i.test(l));
  let cancellationDeadline: string | undefined;
  if (cancelLine) {
    const hit = findDates(cancelLine)[0];
    if (hit) {
      cancellationDeadline = resolveAmbiguity(hit, hints);
      fields.push({ key: 'cancellationDeadline', value: cancellationDeadline, confidence: 'high', evidence: cancelLine.trim() });
    } else fields.push({ key: 'cancellation', value: /non-?refundable/i.test(cancelLine) ? 'non_refundable' : 'stated', confidence: 'medium', evidence: cancelLine.trim() });
  }

  // Title, location, travellers -------------------------------------------------------------
  let title: string | undefined;
  if (type === 'flight') {
    const flight = text.match(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{2,4})\b/);
    const route = text.match(/\b([A-Z]{3})\s*(?:-|–|→|to)\s*([A-Z]{3})\b/);
    title = [flight ? `${flight[1]}${flight[2]}` : null, route ? `${route[1]} → ${route[2]}` : null].filter(Boolean).join(' · ') || undefined;
    if (title) fields.push({ key: 'title', value: title, confidence: flight ? 'high' : 'medium', evidence: (flight ?? route)![0] });
  }
  if (!title) {
    const named = labelledLine(text, /\b(hotel|property|accommodation|restaurant|venue|tour|experience|vessel|train|pick-?up location)\s*:/i);
    const propertyLine = text.split(/\n/).map((l) => l.trim()).find((l) => /\b(hotel|inn|lodge|resort|hostel|guesthouse|ryokan|apartments?|suites?|b&b|camp|cabins?)\b/i.test(l) && l.length < 80 && !/check|cancel|total|confirm/i.test(l));
    title = named ?? propertyLine ?? hints.subject?.replace(/^(re|fwd?):\s*/i, '').replace(/confirmation|booking|reservation|your|for|#\S+/gi, '').trim() ?? undefined;
    if (title && title.length > 0) fields.push({ key: 'title', value: title, confidence: named ? 'high' : propertyLine ? 'medium' : 'low', evidence: named ?? propertyLine ?? hints.subject ?? title });
    if (title && title.length === 0) title = undefined;
  }
  if (!title) gaps.push('What was booked');
  const address = labelledLine(text, /\b(address|location|where|pick-?up location|venue address)\b/i);
  const location = address ?? undefined;
  if (location) fields.push({ key: 'location', value: location, confidence: 'medium', evidence: address! });
  const guests = text.match(/\b(\d{1,2})\s*(?:guests?|adults?|passengers?|travell?ers?|people|persons?)\b/i);
  const travellers = guests ? Number(guests[1]) : undefined;
  if (travellers) fields.push({ key: 'travellers', value: String(travellers), confidence: 'medium', evidence: guests![0] });

  return extractedConfirmationSchema.parse({
    type,
    typeConfidence,
    ...(title ? { title: title.slice(0, 160) } : {}),
    ...(provider ? { provider: provider.slice(0, 80) } : {}),
    ...(date ? { date } : {}),
    ...(endDate ? { endDate } : {}),
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(location ? { location: location.slice(0, 160) } : {}),
    ...(confirmationRef ? { confirmationRef: confirmationRef.slice(0, 80) } : {}),
    ...(cost ? { cost } : {}),
    ...(cancellationDeadline ? { cancellationDeadline } : {}),
    ...(travellers ? { travellers } : {}),
    fields,
    gaps,
  });
}
