/**
 * THE TRIPS HOME'S STAGE — the pure parts.
 *
 * Import-free so the greeting, the plates and the atlas positions are tested
 * without a browser or a database.
 */

/**
 * The name the page greets somebody by: the first word of the name their
 * account gave, or nothing.
 *
 * Never derived from an email address — "continuity-desktop-17944…" is how a
 * greeting reads when it is — and never something that does not look like a
 * name (digits, an address, a 30-character token). No name is better than a
 * wrong one: the greeting then says "Welcome back." on its own.
 */
export function greetingName(displayName: string | null | undefined): string | null {
  const first = (displayName ?? '').trim().split(/\s+/)[0] ?? '';
  if (first.length < 2 || first.length > 18) return null;
  if (/[\d@_/\\]/.test(first)) return null;
  if (!/\p{L}/u.test(first)) return null;
  return first;
}

/** The world sheet the atlas draws on: equirectangular, 84°N to 60°S, as `WorldDots` projects it. */
export const ATLAS_SHEET = { width: 360, height: 144, north: 84 } as const;

/** Where a coordinate sits on the world sheet, as percentages, so an HTML mark can be laid over the SVG. */
export function atlasPosition(lat: number, lng: number): { left: number; top: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const x = Math.min(ATLAS_SHEET.width, Math.max(0, lng + 180));
  const y = Math.min(ATLAS_SHEET.height, Math.max(0, ATLAS_SHEET.north - lat));
  return { left: (x / ATLAS_SHEET.width) * 100, top: (y / ATLAS_SHEET.height) * 100 };
}

/**
 * A route's real stops projected into a plate: local equirectangular with the
 * longitude squeezed by the cosine of the middle latitude, so Iceland is not
 * drawn twice as wide as it is, then fitted with padding and centred. The
 * line through the points is an order, never a road.
 */
export function plateRoute(stops: readonly { lat: number; lng: number }[], box: { width: number; height: number; pad: number }): { x: number; y: number }[] {
  const points = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (points.length === 0) return [];
  const midLat = (Math.min(...points.map((p) => p.lat)) + Math.max(...points.map((p) => p.lat))) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);
  const raw = points.map((p) => ({ x: p.lng * k, y: -p.lat }));
  const minX = Math.min(...raw.map((p) => p.x));
  const maxX = Math.max(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  const maxY = Math.max(...raw.map((p) => p.y));
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const fits = [spanX > 1e-9 ? (box.width - box.pad * 2) / spanX : Infinity, spanY > 1e-9 ? (box.height - box.pad * 2) / spanY : Infinity];
  const scale = Number.isFinite(Math.min(...fits)) ? Math.min(...fits) : 0;
  const offX = (box.width - spanX * scale) / 2;
  const offY = (box.height - spanY * scale) / 2;
  return raw.map((p) => ({ x: Math.round((offX + (p.x - minX) * scale) * 10) / 10, y: Math.round((offY + (p.y - minY) * scale) * 10) / 10 }));
}

/** A smooth path through the points (Catmull-Rom as cubic Béziers), so the sketch reads as a journey and not a chart. */
export function smoothPath(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0]!.x} ${points[0]!.y}`;
  let d = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    const r = (n: number) => Math.round(n * 10) / 10;
    d += ` C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(p2.x)} ${r(p2.y)}`;
  }
  return d;
}

/** One line under the greeting: how many journeys, what is under way, when the next one leaves. Figures only, no urgency. */
export function collectionLine(rows: readonly { lifecycle: string }[], nextInDays: number | null): string {
  const parts = [`${rows.length} ${rows.length === 1 ? 'journey' : 'journeys'}`];
  const under = rows.filter((r) => r.lifecycle === 'traveling').length;
  if (under > 0) parts.push(`${under} under way`);
  else if (nextInDays !== null) parts.push(nextInDays === 0 ? 'the next starts today' : `the next in ${nextInDays} ${nextInDays === 1 ? 'day' : 'days'}`);
  const past = rows.filter((r) => r.lifecycle === 'past').length;
  if (past > 0) parts.push(`${past} been and gone`);
  return parts.join(' · ');
}
