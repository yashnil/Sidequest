/**
 * DISTANCE AND A POINT GRID, for the evidence stages (09-ski, 10-wildlife).
 *
 * Small on purpose: great-circle distance and "everything within r km of here"
 * over a few thousand to a few hundred thousand points, with the antimeridian
 * and the poles handled so a Fijian or Svalbard query is not silently empty.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const RAD = Math.PI / 180;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLng = (lng2 - lng1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** One-degree buckets; `near` visits every stored value within `km` of a point. */
export class PointGrid {
  constructor() {
    this.cells = new Map();
    this.size = 0;
  }

  add(lat, lng, value) {
    const key = `${Math.floor(lat)}:${Math.floor(lng)}`;
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, (cell = []));
    cell.push({ lat, lng, value });
    this.size += 1;
  }

  near(lat, lng, km, visit) {
    const dLat = km / 111;
    const cos = Math.cos(lat * RAD);
    /* Near a pole a circle spans every longitude. */
    const dLng = cos < 0.02 || lat + dLat >= 89 || lat - dLat <= -89 ? 180 : Math.min(180, km / (111 * cos));
    for (let la = Math.floor(lat - dLat); la <= Math.floor(lat + dLat); la += 1) {
      for (let lo = Math.floor(lng - dLng); lo <= Math.floor(lng + dLng); lo += 1) {
        const wrapped = ((((lo + 180) % 360) + 360) % 360) - 180;
        const cell = this.cells.get(`${la}:${wrapped}`);
        if (!cell) continue;
        for (const point of cell) {
          const d = haversineKm(lat, lng, point.lat, point.lng);
          if (d <= km) visit(point.value, d);
        }
      }
    }
  }
}

/** Read an NDJSON file line by line. */
export async function eachLine(path, visit) {
  const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of reader) if (line.trim()) visit(JSON.parse(line));
}
