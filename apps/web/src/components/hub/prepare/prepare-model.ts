import { type PACKING_CATEGORIES, countryFacts, countryInProse, type Preflight, type PreflightItem, type RecheckManifest, type TravelIntelligence } from '@sidequest/core';

/**
 * 2026-11 — PREPARE AS A CHECKLIST ORGANISED AROUND ACTIONS.
 *
 * Prepare used to open on a verdict, a giant day count, four overlapping count
 * boxes and a register of readiness rows with a category eyebrow on each — and,
 * for a domestic trip whose traveller had not said their nationality, five
 * separate border rows (passport, visa, health documents, advisory, local laws)
 * plus "home health cover rarely applies abroad".
 *
 * This is a pure view over the same sources — the readiness packet, the
 * booking needs, the packing list and Preflight's tick state — sorted by
 * *when the traveller acts*: before booking, the week or two before, what to
 * pack, what to install, and what to know. Nothing here is a second store: a
 * row's done state is read from the persisted ticks (`trip_checks`) or from the
 * booking status, and a tick writes back to the same lists Preflight and the
 * state graph read.
 *
 * Border rows. When Sidequest does not know the traveller's citizenship
 * (`international === 'unknown'`), the entry-document entries are one row —
 * "check entry rules if you're coming from abroad" — that carries every
 * official link and every tick id underneath it. Nothing is hidden (the links
 * and the profile form are on the row), nothing is asserted (it is phrased as
 * a check), and ticking it settles each underlying entry so the state graph
 * agrees with the screen. Once a citizenship is known, the entries are listed
 * individually again, because then each one says something specific.
 */

export type CheckList = 'preflight' | 'checklist' | 'packing';
export interface TickTarget {
  list: CheckList;
  id: string;
}

export interface PrepareLink {
  name: string;
  url: string;
}

export interface PrepareRow {
  key: string;
  title: string;
  /** One short line under the title. */
  detail?: string;
  /** The rest, behind "More". */
  more?: string;
  links: PrepareLink[];
  done: boolean;
  /** Where a tick is written. Absent: the row is not tickable (a booking settles in Bookings; a shared copy has no controls). */
  tick?: TickTarget[];
  /** A booking or dependency row points at the place it is settled. */
  href?: string;
  hrefLabel?: string;
  /** Something the plan cannot do without, or a problem shown by the traveller's own data. */
  urgent?: boolean;
  /** Rendered as a Preflight row (the browser suite and the state graph address these). */
  preflight?: Pick<PreflightItem, 'category' | 'bucket' | 'checkId' | 'readinessKind' | 'readinessState'>;
  /** Shows the readiness profile form beneath this row (owner only). */
  profileForm?: boolean;
  /** A booking-kind marker for the browser suite. */
  bookingKind?: string;
}

export interface KnowRow {
  key: string;
  title: string;
  detail: string;
  links: PrepareLink[];
}

export interface PackGroup {
  key: 'essentials' | 'weather' | 'activities' | 'optional';
  title: string;
  rows: PrepareRow[];
}

export type PrepareSectionId = 'book' | 'weeks' | 'pack' | 'install' | 'know';

export interface PrepareModel {
  book: PrepareRow[];
  weeks: PrepareRow[];
  pack: PackGroup[];
  install: PrepareRow[];
  know: KnowRow[];
  /** The things to do (pack excluded): open and done. */
  todo: { open: number; done: number };
  packed: { done: number; total: number };
  /** Whether the weather items rest on a forecast or the climate record, in the packing list's own words. */
  packBasis: string | null;
  daysUntilTrip: number | null;
  international: 'yes' | 'no' | 'unknown';
  /** "Portugal", "the United States" — for prose; null when no country resolved. */
  country: string | null;
}

export interface PrepareModelInput {
  intel: TravelIntelligence | null;
  preflight: Preflight | null;
  checks: { packing: readonly string[]; checklist: readonly string[] };
  recheck?: RecheckManifest | null;
  bookedCount?: number;
  /** Whether ticks can be written (the owner's copy). */
  canTick: boolean;
}

/** Entry kinds that are about crossing a border with a particular passport. */
const RECHECK_SAID_ELSEWHERE = new Set(['recheck:entry', 'recheck:forecast', 'recheck:weather-48h', 'recheck:booked-venues', 'recheck:same-day']);

const BORDER_KINDS = new Set(['passport_validity', 'visa', 'health_document', 'advisory', 'local_law', 'transit']);

export function firstSentence(text: string): { head: string; rest: string } {
  const trimmed = text.trim();
  const match = /^(.+?[.!?])(\s+)(?=[A-Z0-9“"(])/.exec(trimmed);
  if (!match) return { head: trimmed, rest: '' };
  return { head: match[1]!, rest: trimmed.slice(match[0].length).trim() };
}

function capitalise(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function dedupeLinks(links: readonly PrepareLink[]): PrepareLink[] {
  const seen = new Set<string>();
  const out: PrepareLink[] = [];
  for (const link of links) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    out.push({ name: link.name, url: link.url });
  }
  return out;
}

function allItems(preflight: Preflight | null): PreflightItem[] {
  return preflight ? [...preflight.attention, ...preflight.later, ...preflight.ready] : [];
}

type Entry = TravelIntelligence['readiness']['entries'][number];

export function buildPrepareModel(input: PrepareModelInput): PrepareModel {
  const { intel, preflight, checks, canTick } = input;
  const checklist = new Set(checks.checklist);
  const packingTicks = new Set(checks.packing);
  const items = allItems(preflight);
  const international = intel?.readiness.international ?? intel?.destinationContext.international ?? 'unknown';
  const facts = countryFacts(intel?.destinationContext.countryCode ?? intel?.readiness.destinationCountry);
  const country = facts ? countryInProse(facts.name) : null;

  const book: PrepareRow[] = [];
  const weeks: PrepareRow[] = [];
  const install: PrepareRow[] = [];
  const know: KnowRow[] = [];

  /* The Preflight row for an entry: by kind, and by title for the several local set-up entries. */
  const preflightFor = (entry: Entry): PreflightItem | undefined =>
    items.find((item) => item.readinessKind === entry.kind && (entry.kind !== 'local_setup' || item.title === entry.title));

  const readinessRow = (entry: Entry, overrides: Partial<PrepareRow> = {}): PrepareRow => {
    const row = readinessRowBase(entry, overrides);
    if ('detail' in overrides && !('more' in overrides)) delete row.more;
    return row;
  };
  const readinessRowBase = (entry: Entry, overrides: Partial<PrepareRow>): PrepareRow => {
    const item = preflightFor(entry);
    /*
     * A `confirmed` entry is a confirmed *fact* (the emergency number, the
     * language) — Preflight counts it ready, but the action on it (save the
     * number, download the pack) is still the traveller's. Those rows keep
     * their own tick in the checklist list; every other entry ticks the
     * Preflight check the state graph reads.
     */
    const factOnly = entry.state === 'confirmed';
    const checkId = factOnly ? `prepare:${entry.kind}` : item?.checkId;
    const list: CheckList = factOnly ? 'checklist' : 'preflight';
    const done = factOnly ? checklist.has(checkId!) : item ? item.bucket === 'ready' : false;
    const several = entry.kind === 'local_setup';
    const title = several ? entry.title : (entry.action ?? entry.title).replace(/\.$/, '');
    const { head, rest } = firstSentence(capitalise(entry.summary));
    return {
      key: `readiness:${entry.kind}:${entry.title}`,
      title,
      detail: head,
      ...(rest ? { more: rest } : {}),
      links: dedupeLinks(entry.links),
      done,
      ...(canTick && checkId ? { tick: [{ list, id: checkId }] } : {}),
      urgent: entry.blocking || entry.state === 'problem',
      preflight: { category: item?.category ?? 'documents', bucket: factOnly ? (done ? 'ready' : 'later') : (item?.bucket ?? (done ? 'ready' : 'attention')), ...(item?.checkId ? { checkId: item.checkId } : {}), readinessKind: entry.kind, readinessState: entry.state },
      ...overrides,
    };
  };


  const entries = intel?.readiness.entries.filter((entry) => entry.state !== 'not_applicable') ?? [];

  /* ---- Border documents ------------------------------------------------------------------- */
  const border = entries.filter((entry) => BORDER_KINDS.has(entry.kind));
  if (border.length > 0 && international === 'unknown') {
    const rows = border.map((entry) => readinessRow(entry));
    const visa = border.find((entry) => entry.kind === 'visa') ?? border[0]!;
    const plugs = entries.find((entry) => entry.kind === 'electricity' && entry.state === 'confirmed');
    const where = country ?? 'your destination';
    book.push({
      key: 'border:unknown',
      title: `If you're coming from abroad, check the entry rules for ${where}`,
      detail: 'Passport validity, a visa or travel authorisation, and any health-entry rules all depend on your passport. If you live there, skip this.',
      more: [
        'Sidequest does not know your citizenship and will not guess it. Add it below and this becomes a specific list.',
        plugs ? capitalise(plugs.summary) : null,
      ]
        .filter(Boolean)
        .join(' '),
      links: dedupeLinks(border.flatMap((entry) => entry.links)),
      done: rows.every((row) => row.done),
      ...(canTick && rows.some((row) => row.tick) ? { tick: rows.flatMap((row) => row.tick ?? []) } : {}),
      urgent: border.some((entry) => entry.blocking || entry.state === 'problem'),
      /* The row stands for the visa entry: the one a spec, and a reader, asks about first. */
      preflight: { category: 'documents', bucket: rows.every((row) => row.done) ? 'ready' : 'attention', ...(rows.find((r) => r.preflight?.readinessKind === visa.kind)?.preflight?.checkId ? { checkId: rows.find((r) => r.preflight?.readinessKind === visa.kind)!.preflight!.checkId! } : {}), readinessKind: visa.kind, readinessState: visa.state },
      profileForm: true,
    });
  } else {
    for (const entry of border) {
      if (entry.kind === 'local_law') {
        know.push({ key: 'local_law', title: entry.title, detail: capitalise(entry.summary), links: dedupeLinks(entry.links) });
        continue;
      }
      const row = readinessRow(entry, entry.kind === 'visa' || entry.kind === 'passport_validity' ? { profileForm: false } : {});
      if (entry.kind === 'health_document') weeks.push(row);
      else book.push(row);
    }
    /* The form that changes the packet sits with the documents it changes. */
    const firstDoc = book.find((row) => row.preflight?.readinessKind === 'visa' || row.preflight?.readinessKind === 'passport_validity');
    if (firstDoc) firstDoc.profileForm = true;
  }

  /* ---- Bookings, in the order a trip is arranged ---------------------------------------------- */
  const bookingItems = items.filter((item) => item.category === 'bookings' && item.detail !== 'Nothing required');
  for (const item of bookingItems) {
    const kind = item.id.replace(/^preflight:/, '');
    book.push({
      key: item.id,
      title: item.title,
      ...(item.detail ? { detail: firstSentence(item.detail).head } : {}),
      links: [],
      done: item.bucket === 'ready',
      href: '#book',
      hrefLabel: item.bucket === 'ready' ? 'View' : 'Arrange',
      preflight: { category: item.category, bucket: item.bucket },
      bookingKind: kind === 'lodging' ? 'accommodation' : kind,
    });
  }
  if (!preflight && intel) {
    /* No Preflight (an older render path): the open needs straight from the intelligence. */
    for (const need of intel.bookings.items.filter((b) => !b.memberIds && b.status === 'open' && (b.necessity === 'required' || b.necessity === 'strongly_recommended') && !(b.group === 'stays' && intel.bookings.items.some((g) => g.memberIds)))) {
      book.push({ key: `booking:${need.id}`, title: need.title, detail: firstSentence(need.reason).head, links: [], done: false, href: '#book', hrefLabel: 'Arrange', bookingKind: need.kind });
    }
    const group = intel.bookings.items.find((b) => b.memberIds && b.status === 'open');
    if (group) book.push({ key: `booking:${group.id}`, title: group.title, detail: firstSentence(group.reason).head, links: [], done: false, href: '#book', hrefLabel: 'Arrange', bookingKind: group.kind });
  }

  /* ---- Driving, permits and the dependencies the plan cannot do without ------------------------- */
  for (const entry of entries) {
    if (entry.kind === 'driving_document') {
      /* A compiled permit rule (a local set-up row) already says the licence part; this row keeps only the rental decision. */
      const permitRow = entries.some((e) => e.kind === 'local_setup' && /\bpermit\b/i.test(e.title));
      book.push(
        readinessRow(
          entry,
          permitRow
            ? { title: 'Rental car: decide the excess cover', detail: 'Rental desks set their own age and licence rules; decide the excess (deductible) cover before you book.' }
            : international === 'unknown' && country
              ? { title: 'Rental car: check licence rules and the excess', detail: `If your licence is from outside ${country}, confirm whether you need an International Driving Permit. Rental desks set their own age rules and excess.` }
              : { title: 'Rental car: check licence rules and the excess' },
        ),
      );
    } else if (entry.kind === 'minor_documents') {
      book.push(readinessRow(entry));
    } else if (entry.kind === 'local_setup' && /\bpermit\b/i.test(entry.title)) {
      book.push(readinessRow(entry));
    }
  }
  for (const item of items.filter((i) => i.category === 'transport' && !i.readinessKind)) {
    book.push({ key: item.id, title: item.title, ...(item.detail ? { detail: item.detail } : {}), links: [], done: item.bucket === 'ready', href: item.href, hrefLabel: 'Decide', urgent: true, preflight: { category: item.category, bucket: item.bucket } });
  }

  /* ---- One to two weeks before ----------------------------------------------------------------- */
  const weather = items.find((item) => item.category === 'weather');
  if (weather) weeks.push(ownCheck('prepare:weather', 'Check the forecast for the weather-sensitive days', weather.title.replace(/ (is|are) weather-sensitive$/, '') + ' depend on the weather. A backup already sits on each.', checklist, canTick));
  /* Entry rules, the forecast and booked venues each have their own row; the re-check lists what is left. */
  const recheck = (input.recheck?.items ?? []).filter((item) => item.state !== 'past' && item.window !== 'same_day' && !RECHECK_SAID_ELSEWHERE.has(item.id));
  if (recheck.length > 0) {
    const names = recheck.slice(0, 3).map((item, index) => (index === 0 ? item.title : item.title.charAt(0).toLowerCase() + item.title.slice(1)).replace(/\.$/, ''));
    weeks.push(ownCheck('prepare:recheck', 'Re-check hours, closures and conditions', `${names.join('; ')}${recheck.length > 3 ? `; and ${recheck.length - 3} more` : ''}.`, checklist, canTick));
  }
  if ((input.bookedCount ?? 0) > 0) weeks.push(ownCheck('prepare:reconfirm', 'Reconfirm your bookings', `${input.bookedCount} booked — check the dates, times and names match.`, checklist, canTick));

  const insurance = entries.find((entry) => entry.kind === 'insurance');
  const activity = entries.find((entry) => entry.kind === 'activity_insurance');
  if (insurance) {
    const base = readinessRow(insurance);
    const activityRow = activity ? readinessRow(activity) : null;
    const summary =
      international === 'yes'
        ? capitalise(insurance.summary)
        : `Check your usual cover applies away from home, for cancellations as well as medical care${international === 'unknown' ? ' — and arrange travel medical insurance if you are coming from abroad' : ''}.`;
    const { head, rest } = firstSentence(summary);
    weeks.push({
      ...base,
      title: 'Check your travel insurance',
      detail: head,
      more: [rest, activity ? capitalise(activity.summary) : null].filter(Boolean).join(' ') || undefined,
      done: base.done && (activityRow?.done ?? true),
      ...(canTick && (base.tick || activityRow?.tick) ? { tick: [...(base.tick ?? []), ...(activityRow?.tick ?? [])] } : {}),
    } as PrepareRow);
  } else if (activity) weeks.push(readinessRow(activity));
  /* Prescription medicines are a packing line on an international trip; elsewhere the generic sentence is filler. */

  /* ---- Install and download --------------------------------------------------------------------- */
  for (const entry of entries.filter((e) => e.kind === 'local_setup' && !/\bpermit\b/i.test(e.title))) install.push(readinessRow(entry));
  const connectivity = entries.find((entry) => entry.kind === 'connectivity');
  if (connectivity) {
    const remote = intel?.destinationContext.remote ?? false;
    const roaming = international === 'yes' ? ' Decide between roaming, a local SIM or an eSIM before you land.' : '';
    install.push(readinessRow(connectivity, { title: 'Download offline maps', detail: `${remote ? 'Parts of this trip have no signal; keep the maps and this plan offline.' : 'For the areas you will be in.'}${roaming}` }));
  }
  const language = entries.find((entry) => entry.kind === 'language' && entry.tier === 'primary');
  if (language) install.push(readinessRow(language, { title: 'Download an offline translation pack', detail: firstSentence(capitalise(language.summary)).head }));
  const offline = items.find((item) => item.category === 'offline');
  if (offline) {
    install.push({ key: offline.id, title: 'Save this trip offline on your phone', detail: 'The days and your bookings then open without signal.', links: [], done: offline.bucket === 'ready', ...(canTick && offline.checkId ? { tick: [{ list: 'preflight' as const, id: offline.checkId }] } : {}), preflight: { category: offline.category, bucket: offline.bucket, ...(offline.checkId ? { checkId: offline.checkId } : {}) } });
  }
  const emergency = entries.find((entry) => entry.kind === 'emergency');
  if (emergency) {
    const number = facts?.emergency;
    install.push(readinessRow(emergency, { title: number ? `Save ${number} and each night's address` : "Save the emergency number and each night's address", detail: number ? `${number} is the emergency number${country ? ` in ${country}` : ''}. Keep it on your phone and on paper.` : 'On your phone and on paper.' }));
  }

  /* ---- Know before you go --------------------------------------------------------------------- */
  const money = entries.find((entry) => entry.kind === 'currency_payment');
  if (money) know.push({ key: 'money', title: 'Money', detail: capitalise(money.summary), links: dedupeLinks(money.links) });
  const electricity = entries.find((entry) => entry.kind === 'electricity');
  if (electricity && international === 'yes') know.push({ key: 'plugs', title: 'Plugs', detail: capitalise(electricity.summary), links: [] });
  const drivingSide = entries.find((entry) => entry.kind === 'driving_document')?.facts?.find((fact) => /^Traffic drives on the/.test(fact));
  if (drivingSide) know.push({ key: 'driving-side', title: 'Driving', detail: drivingSide, links: [] });
  for (const entry of intel?.safety.practical.slice(0, 3) ?? []) know.push({ key: `safety:${entry.title}`, title: entry.title, detail: entry.detail, links: entry.sourceUrl ? [{ name: entry.sourceName ?? 'Source', url: entry.sourceUrl }] : [] });
  if (intel?.destinationContext.timeZone && international !== 'no') {
    const zone = facts?.timeZone ?? intel.destinationContext.timeZone;
    if (international === 'yes') know.push({ key: 'time', title: 'Time zone', detail: `${zone}. The plan's times are local.`, links: [] });
  }

  /* ---- Pack ------------------------------------------------------------------------------------ */
  const pack = packGroups(intel, packingTicks, canTick, install);

  const actionable = [...book, ...weeks, ...install];
  const todo = { open: actionable.filter((row) => !row.done).length, done: actionable.filter((row) => row.done).length };
  const packRows = pack.flatMap((group) => group.rows);
  return {
    book: sortOpenFirst(book),
    weeks,
    pack,
    install,
    know,
    todo,
    packed: { done: packRows.filter((row) => row.done).length, total: packRows.length },
    packBasis: intel?.packing.basisNote ?? null,
    daysUntilTrip: preflight?.daysUntilTrip ?? intel?.destinationContext.daysUntilTrip ?? null,
    international,
    country,
  };
}

function ownCheck(id: string, title: string, detail: string, checklist: ReadonlySet<string>, canTick: boolean): PrepareRow {
  return { key: id, title, detail, links: [], done: checklist.has(id), ...(canTick ? { tick: [{ list: 'checklist' as const, id }] } : {}) };
}

/** What the plan cannot do without, then the bookings, then the documents and permits; done rows last. */
function sortOpenFirst(rows: PrepareRow[]): PrepareRow[] {
  const rank = (row: PrepareRow) => (row.done ? 3 : row.urgent ? 0 : row.bookingKind ? 1 : 2);
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map(({ row }) => row);
}

const PACK_GROUP_OF: Record<(typeof PACKING_CATEGORIES)[number], PackGroup['key']> = {
  essential_documents: 'essentials',
  electronics: 'essentials',
  health_toiletries: 'essentials',
  transport: 'essentials',
  weather: 'weather',
  clothing: 'weather',
  footwear: 'activities',
  outdoor: 'activities',
  activity_specific: 'activities',
  remote_travel: 'activities',
  optional: 'optional',
};

const PACK_TITLES: Record<PackGroup['key'], string> = {
  essentials: 'Essentials',
  weather: 'For the weather',
  activities: 'For what you are doing',
  optional: 'If it suits you',
};

/** Offline maps are something to download, not something to pack; they move to Install, keeping their packing tick. */
const DOWNLOAD = /offline maps|downloaded plan/i;

function packGroups(intel: TravelIntelligence | null, ticks: ReadonlySet<string>, canTick: boolean, install: PrepareRow[]): PackGroup[] {
  const groups: Record<PackGroup['key'], PrepareRow[]> = { essentials: [], weather: [], activities: [], optional: [] };
  const hasOfflineRow = install.some((row) => row.preflight?.readinessKind === 'connectivity');
  for (const item of intel?.packing.items ?? []) {
    const row: PrepareRow = { key: `pack:${item.id}`, title: item.label, detail: item.why, links: [], done: ticks.has(item.id), ...(canTick ? { tick: [{ list: 'packing' as const, id: item.id }] } : {}) };
    if (DOWNLOAD.test(item.label)) {
      /* Already said by the offline-maps row: tick both from one press rather than show the same instruction twice. */
      const offline = install.find((r) => r.preflight?.readinessKind === 'connectivity');
      if (hasOfflineRow && offline) {
        offline.done = offline.done || row.done;
        if (offline.tick && row.tick) offline.tick = [...offline.tick, ...row.tick];
        continue;
      }
      install.push(row);
      continue;
    }
    groups[item.optional ? 'optional' : PACK_GROUP_OF[item.category]].push(row);
  }
  return (['essentials', 'weather', 'activities', 'optional'] as const).filter((key) => groups[key].length > 0).map((key) => ({ key, title: PACK_TITLES[key], rows: groups[key] }));
}
