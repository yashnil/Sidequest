#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
/**
 * Blinds the benchmark for a qualitative read.
 *
 *   node packages/atlas/build/blind-pairs.mjs
 *
 * For every benchmark request, the old recommender's three picks and the new
 * one's are written as lists X and Y in an order fixed by a seeded shuffle,
 * with nothing that says which system produced which (no scores, no "open
 * data" marks). `blind.json` goes to the rater; `key.json` stays behind until
 * the ratings are in. Same seed, same blinding — the exercise is repeatable.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = 'docs/global-destinations';
const results = JSON.parse(readFileSync(`${DIR}/benchmark/results.json`, 'utf8'));
let seed = 20261108;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const blind = [];
const key = {};
for (let index = 0; index < results.after.length; index += 1) {
  const after = results.after[index];
  const before = results.before[index];
  const flip = random() < 0.5;
  const list = (run) => run.picks.map((pick) => `${pick.name} (${pick.context})`);
  blind.push({ id: after.id, request: after.text, X: list(flip ? after : before), Y: list(flip ? before : after) });
  key[after.id] = flip ? { X: 'after', Y: 'before' } : { X: 'before', Y: 'after' };
}
writeFileSync(`${DIR}/blind/blind.json`, `${JSON.stringify(blind, null, 1)}\n`);
writeFileSync(`${DIR}/blind/key.json`, `${JSON.stringify(key, null, 1)}\n`);
console.log(`${blind.length} blinded pairs → ${DIR}/blind/`);
