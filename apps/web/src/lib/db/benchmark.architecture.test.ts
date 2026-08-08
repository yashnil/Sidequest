import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from './schema';

/**
 * TWO CLAIMS THE BENCHMARK MAKES ABOUT ITSELF, CHECKED AGAINST ITS OWN SOURCE.
 *
 * Both are properties of the code rather than of any single run, so neither can
 * be exercised: there is no input that makes an UPDATE against an unmarked column
 * misbehave, and no input that makes a logged error object leak a credential on
 * demand. What there is, in each case, is a comment saying the thing is true and
 * nothing that notices when it stops being.
 *
 * ---
 *
 * THE MUTABLE LIST, HELD TO ITS WORD.
 *
 * The benchmark schema claims that only the columns it marks MUTABLE are ever
 * the object of an UPDATE, and that claim is the whole basis for reading the rest
 * of the tables as evidence. It was, until this file existed, a comment — and a
 * comment is exactly as strong as the attention of whoever writes the next
 * repository function.
 *
 * So the marker set is parsed out of the schema and the written set is parsed out
 * of every repository beside it, and containment is asserted. What that catches is
 * not malice: it is the ordinary afternoon on which somebody adds
 * `SET payload_json = ?` to a plan or a review because it was the quickest way to
 * fix something, and nothing anywhere says the row was supposed to be immutable.
 *
 * Both parsers are deliberately literal about the SQL this directory actually
 * writes — one statement per template literal, a WHERE on every UPDATE — and both
 * assert they found a plausible number of statements. A regex that silently
 * matched nothing would turn this file into a test that passes forever while
 * proving nothing, which is the failure mode every architecture test has.
 */

const DB_DIRECTORY = join(__dirname);

/** Only the tables the benchmark owns. The rest of the schema makes no such claim. */
const BENCHMARK_TABLE = /^benchmark_\w+$/;

/* ------------------------------------------------------------------ *
 * What the schema says may move
 * ------------------------------------------------------------------ */

/**
 * A column is mutable when the contiguous comment block directly above it says
 * so. Attaching the marker to the column rather than to a range is what makes
 * this parseable at all — a marker that covered "both of the following" would
 * have to be read by a human to know where it stopped.
 */
function mutableColumns(schemaSql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const createTable = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g;

  for (const match of schemaSql.matchAll(createTable)) {
    const table = match[1];
    const body = match[2];
    if (table === undefined || body === undefined) continue;
    if (!BENCHMARK_TABLE.test(table)) continue;

    const marked = new Set<string>();
    let markerIsOpen = false;
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) {
        markerIsOpen = false;
        continue;
      }
      if (line.startsWith('--')) {
        if (line.includes('MUTABLE')) markerIsOpen = true;
        continue;
      }
      const column = /^(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)\b/.exec(line);
      if (column?.[1] !== undefined && markerIsOpen) marked.add(column[1]);
      markerIsOpen = false;
    }
    tables.set(table, marked);
  }
  return tables;
}

/* ------------------------------------------------------------------ *
 * What the repositories actually write
 * ------------------------------------------------------------------ */

interface Write {
  file: string;
  table: string;
  columns: string[];
}

/** Splits a SET clause on the commas that separate assignments, and no others. */
function assignments(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const character of clause) {
    if (character === "'") quoted = !quoted;
    if (!quoted && character === '(') depth += 1;
    if (!quoted && character === ')') depth -= 1;
    if (!quoted && depth === 0 && character === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function columnsOf(clause: string): string[] {
  return assignments(clause)
    .map((part) => /^\s*(\w+)\s*=/.exec(part)?.[1])
    .filter((column): column is string => column !== undefined);
}

/**
 * Every UPDATE and every upsert against a benchmark table, read out of the
 * source rather than out of a list somebody maintains beside it.
 *
 * The gap in each pattern refuses to cross a backtick, which keeps a match
 * inside the one template literal that holds the statement. Without that, an
 * `ON CONFLICT … DO NOTHING` insert here would happily pair with a `DO UPDATE`
 * three functions later and blame the wrong table.
 */
function writes(): Write[] {
  const found: Write[] = [];
  const files = readdirSync(DB_DIRECTORY).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );

  for (const file of files) {
    const source = readFileSync(join(DB_DIRECTORY, file), 'utf8');

    for (const match of source.matchAll(/UPDATE\s+(benchmark_\w+)\s+SET\s+([^`]*?)\bWHERE\b/gi)) {
      const table = match[1];
      const clause = match[2];
      if (table === undefined || clause === undefined) continue;
      found.push({ file, table, columns: columnsOf(clause) });
    }

    const upsert =
      /INSERT\s+INTO\s+(benchmark_\w+)[^`]*?ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\s+([^`]*)/gi;
    for (const match of source.matchAll(upsert)) {
      const table = match[1];
      const clause = match[2];
      if (table === undefined || clause === undefined) continue;
      found.push({ file, table, columns: columnsOf(clause) });
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * The assertions
 * ------------------------------------------------------------------ */

describe('the benchmark schema MUTABLE markers', () => {
  const marked = mutableColumns(SCHEMA_SQL);
  const written = writes();

  it('finds the tables and the statements it claims to check', () => {
    // A parser that matched nothing would make every assertion below vacuous,
    // and it would do so silently on the day somebody reformatted the schema.
    expect(marked.size).toBeGreaterThanOrEqual(12);
    expect(written.length).toBeGreaterThanOrEqual(9);
    expect(new Set(written.map((write) => write.table)).size).toBeGreaterThanOrEqual(6);
    for (const write of written) {
      expect(write.columns.length, `${write.file} wrote ${write.table} with no columns`).toBeGreaterThan(0);
    }
  });

  it('writes only columns the schema marked MUTABLE', () => {
    const offences: string[] = [];
    for (const write of written) {
      const allowed = marked.get(write.table);
      if (allowed === undefined) {
        offences.push(`${write.file}: ${write.table} is written but is not a table in the schema`);
        continue;
      }
      for (const column of write.columns) {
        if (!allowed.has(column)) {
          offences.push(`${write.file}: ${write.table}.${column} is updated but is not marked MUTABLE`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('marks nothing MUTABLE that nothing updates', () => {

    // The other direction, and it matters for a different reason: a marker on a
    // column nobody writes is permission granted in advance, and the next person
    // to need it will read the marker as evidence that rewriting the row is fine.
    const writtenByTable = new Map<string, Set<string>>();
    for (const write of written) {
      const columns = writtenByTable.get(write.table) ?? new Set<string>();
      for (const column of write.columns) columns.add(column);
      writtenByTable.set(write.table, columns);
    }

    const idle: string[] = [];
    for (const [table, columns] of marked) {
      for (const column of columns) {
        if (!writtenByTable.get(table)?.has(column)) idle.push(`${table}.${column}`);
      }
    }
    expect(idle).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * What reaches the server log
 * ------------------------------------------------------------------ */

/**
 * EVERY DIRECTORY A BENCHMARK RUN EXECUTES, NOT THE TWO IT LIVES IN.
 *
 * The scan covered `lib/benchmark` and `app/labs/benchmark` and stopped there,
 * which left three places out: the repositories a run writes through, the
 * components it renders, and the provider modules the deterministic arm reaches
 * through the compiler. The guarantee is about a *class* — a raw provider error
 * object carries the outbound request and its headers — and the class was
 * unguarded just outside the two directories. One live offender sat in the
 * imagery lookup, on a path a live session reaches.
 *
 * A scan whose root list is narrower than the code the guarantee is about passes
 * for ever while the guarantee erodes beside it.
 */
const BENCHMARK_SOURCE_ROOTS: readonly { root: string; only?: RegExp }[] = [
  { root: join(DB_DIRECTORY, '..', 'benchmark') },
  { root: join(DB_DIRECTORY, '..', '..', 'app', 'labs', 'benchmark') },
  { root: join(DB_DIRECTORY, '..', '..', 'components', 'benchmark') },
  /*
   * The provider modules, which is where the risk actually lives: an SDK error
   * carries the request that produced it, headers and all. The deterministic arm
   * reaches these through the compiler on every live run.
   */
  { root: join(DB_DIRECTORY, '..', 'providers') },
  /*
   * The benchmark repositories only. The rest of this directory logs SQLite
   * errors, which is a different risk class with a different answer, and pulling
   * them in would make this test about local database faults rather than about
   * credentials.
   */
  { root: DB_DIRECTORY, only: /(^|\/)benchmark-[^/]*\.tsx?$/ },
];

function sourceFiles(root: string, only?: RegExp): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path, only));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || entry.includes('.test.')) continue;
    if (only && !only.test(path)) continue;
    found.push(path);
  }
  return found;
}

/** The argument text of every `console.*` call, brackets balanced. */
function consoleArguments(source: string): string[] {
  const calls: string[] = [];
  const opener = /console\.\w+\(/g;
  for (const match of source.matchAll(opener)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      index += 1;
    }
    calls.push(source.slice(start, index - 1));
  }
  return calls;
}

describe('what the benchmark writes to the server log', () => {
  const files = BENCHMARK_SOURCE_ROOTS.flatMap((entry) => sourceFiles(entry.root, entry.only));

  it('finds the modules it claims to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it('never logs a caught error object, only its name', () => {
    /*
     * A provider SDK error is not a string with a stack attached. It routinely
     * carries the request that produced it — the outbound headers, the API key
     * among them, and the entire prompt body — and a server log is a place that
     * gets tailed, shipped and pasted into issues. Nothing about that is visible
     * at the call site, which is why `{ system, error }` reads as diligence.
     *
     * So the identifier may be tested, may have a property read from it, and may
     * name a key. It may not be the value.
     */
    const offences: string[] = [];
    for (const file of files) {
      for (const argument of consoleArguments(readFileSync(file, 'utf8'))) {
        /*
         * Comments are not code, and the widened roots proved it.
         *
         * Two of the cleanest call sites in the repository were flagged, because
         * each carries a comment explaining *why* it logs a property rather than
         * the error — and the word "error" in that explanation matched. A scan
         * that fails on the note describing its own rule teaches people to delete
         * the note.
         */
        const withoutComments = argument
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/\/\/[^\n]*/g, ' ');
        for (const use of withoutComments.matchAll(/\b(error|err|cause|reason)\b(.{0,12})/gs)) {
          const identifier = use[1] ?? '';
          const following = use[2] ?? '';
          if (/^\s*(?:\.|instanceof\b|:)/.test(following)) continue;
          offences.push(`${file}: logs \`${identifier}\` itself`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
