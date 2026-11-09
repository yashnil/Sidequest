#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
/**
 * Refreshes the travel-advisory snapshot the atlas carries.
 *
 *   node packages/atlas/build/advisories.mjs && node packages/atlas/build/06-assemble.mjs
 *
 * One request to the U.S. Department of State's public advisory feed. The
 * snapshot is dated; a "do not travel" level removes a destination only while
 * the snapshot is fresh (`ADVISORY_FRESH_DAYS`), and after that it is shown as
 * a caution to check. Re-run this before a release — advisories change far
 * more often than mountains do, and nothing else in the atlas needs rebuilding
 * for it (stage 06 takes seconds).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CACHE = process.env.ATLAS_CACHE ?? '.atlas-cache';
const URL = 'https://cadataapi.state.gov/api/TravelAdvisories';

const response = await fetch(URL, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; SidequestAtlasBuild/0.1)', accept: 'application/json' }, signal: AbortSignal.timeout(180_000) });
if (!response.ok) throw new Error(`${URL} answered ${response.status}`);
const text = await response.text();
const rows = JSON.parse(text);
if (!Array.isArray(rows) || rows.length < 150) throw new Error(`unexpected advisory payload (${Array.isArray(rows) ? rows.length : typeof rows} rows)`);
mkdirSync(join(CACHE, 'raw', 'advisories'), { recursive: true });
writeFileSync(join(CACHE, 'raw', 'advisories', 'TravelAdvisories.json'), text);
console.log(`${rows.length} advisories → ${join(CACHE, 'raw', 'advisories', 'TravelAdvisories.json')}`);
