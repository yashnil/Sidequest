#!/usr/bin/env node
/**
 * THE CONTOUR TEXTURE, GENERATED ONCE AND CHECKED IN.
 *
 * Sidequest's ground is a topographic sheet: isolines over a smooth relief.
 * This draws them deterministically (seeded value noise, fractal octaves,
 * marching squares, segment chaining) into one SVG that tiles horizontally and
 * vertically, so CSS can use it as a mask over any token colour. Not a map of
 * anywhere — a texture, and the product never presents it as geography.
 *
 * `node apps/web/scripts/generate-contours.mjs` rewrites public/brand/contours.svg.
 */
import { writeFileSync } from 'node:fs';

const W = 960;
const H = 640;
const CELL = 6;
const LEVELS = 15;

let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const lattice = (n) => Array.from({ length: n }, () => Array.from({ length: n }, rand));

/** Tileable value noise: the lattice wraps, so the right edge meets the left. */
function noiseLayer(period) {
  const g = lattice(period);
  return (x, y) => {
    const fx = (x / W) * period;
    const fy = (y / H) * period;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const s = (t) => t * t * (3 - 2 * t);
    const at = (i, j) => g[((j % period) + period) % period][((i % period) + period) % period];
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * s(tx);
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * s(tx);
    return a + (b - a) * s(ty);
  };
}
const octaves = [noiseLayer(3), noiseLayer(6), noiseLayer(12)];
const field = (x, y) => octaves[0](x, y) * 0.62 + octaves[1](x, y) * 0.28 + octaves[2](x, y) * 0.1;

const cols = W / CELL + 1;
const rows = H / CELL + 1;
const v = [];
for (let j = 0; j < rows; j++) {
  v.push([]);
  for (let i = 0; i < cols; i++) v[j].push(field(i * CELL, j * CELL));
}
const flat = v.flat();
const lo = Math.min(...flat);
const hi = Math.max(...flat);

const paths = [];
for (let l = 1; l < LEVELS; l++) {
  const t = lo + ((hi - lo) * l) / LEVELS;
  const segs = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = v[j][i], b = v[j][i + 1], c = v[j + 1][i + 1], d = v[j + 1][i];
      const k = (a > t ? 8 : 0) | (b > t ? 4 : 0) | (c > t ? 2 : 0) | (d > t ? 1 : 0);
      if (k === 0 || k === 15) continue;
      const x = i * CELL, y = j * CELL;
      const lerp = (p, q) => (t - p) / (q - p);
      const top = [x + CELL * lerp(a, b), y];
      const right = [x + CELL, y + CELL * lerp(b, c)];
      const bottom = [x + CELL * lerp(d, c), y + CELL];
      const left = [x, y + CELL * lerp(a, d)];
      const table = { 1: [[left, bottom]], 2: [[bottom, right]], 3: [[left, right]], 4: [[top, right]], 5: [[left, top], [bottom, right]], 6: [[top, bottom]], 7: [[left, top]], 8: [[left, top]], 9: [[top, bottom]], 10: [[left, bottom], [top, right]], 11: [[top, right]], 12: [[left, right]], 13: [[bottom, right]], 14: [[left, bottom]] };
      for (const s of table[k]) segs.push(s);
    }
  }
  // Chain segments into polylines so the file is paths, not thousands of lines.
  const key = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const byStart = new Map();
  for (const s of segs) {
    for (const [p, q] of [[s[0], s[1]], [s[1], s[0]]]) {
      const k = key(p);
      if (!byStart.has(k)) byStart.set(k, []);
      byStart.get(k).push(q);
    }
  }
  const used = new Set();
  const edge = (p, q) => `${key(p)}|${key(q)}`;
  for (const s of segs) {
    if (used.has(edge(s[0], s[1]))) continue;
    const line = [s[0], s[1]];
    used.add(edge(s[0], s[1])); used.add(edge(s[1], s[0]));
    for (;;) {
      const tail = line[line.length - 1];
      const next = (byStart.get(key(tail)) ?? []).find((q) => !used.has(edge(tail, q)));
      if (!next) break;
      used.add(edge(tail, next)); used.add(edge(next, tail));
      line.push(next);
    }
    if (line.length < 4) continue;
    const d = line.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
    paths.push(`<path d="${d}" stroke-width="${l % 5 === 0 ? 1.3 : 0.7}"/>`);
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g fill="none" stroke="#000" stroke-linejoin="round">${paths.join('')}</g></svg>`;
writeFileSync(new URL('../public/brand/contours.svg', import.meta.url), svg);
console.log(`contours.svg: ${paths.length} paths, ${(svg.length / 1024).toFixed(0)} KB`);
