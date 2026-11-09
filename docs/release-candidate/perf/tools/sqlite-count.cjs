/**
 * COUNT AND TIME EVERY SQLITE STATEMENT, WITHOUT TOUCHING THE PRODUCT.
 *
 *   NODE_OPTIONS="--require <abs>/sqlite-count.cjs" serve.sh
 *   kill -USR2 <pid>      # print the tally since the last signal, then reset it
 *
 * A preload, so nothing in `apps/web` knows it exists: it wraps
 * `better-sqlite3`'s `Database.prototype.prepare` and `exec`, and each
 * statement's `run` / `get` / `all` / `iterate`. Synchronous driver, so wall
 * time inside the call is the statement's whole cost — and, in a single Node
 * process, time during which nothing else is served.
 *
 * Measurement only. It adds two `performance.now()` calls per statement; do not
 * read its absolute times as production figures.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS preload script, which is the point of it.
const Module = require('node:module');

const tally = { prepares: 0, prepareMs: 0, statements: 0, statementMs: 0, execs: 0, execMs: 0, bySql: new Map() };

function reset() {
  tally.prepares = 0;
  tally.prepareMs = 0;
  tally.statements = 0;
  tally.statementMs = 0;
  tally.execs = 0;
  tally.execMs = 0;
  tally.bySql.clear();
}

function note(sql, ms) {
  const key = String(sql).replace(/\s+/g, ' ').trim().slice(0, 110);
  const entry = tally.bySql.get(key) ?? { n: 0, ms: 0 };
  entry.n += 1;
  entry.ms += ms;
  tally.bySql.set(key, entry);
}

function wrap(Database) {
  if (Database.__sidequestCounted) return Database;
  const { prepare, exec } = Database.prototype;
  Database.prototype.prepare = function countedPrepare(sql, ...rest) {
    const started = performance.now();
    const statement = prepare.call(this, sql, ...rest);
    tally.prepares += 1;
    tally.prepareMs += performance.now() - started;
    for (const method of ['run', 'get', 'all']) {
      const original = statement[method];
      statement[method] = function counted(...args) {
        const at = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          const ms = performance.now() - at;
          tally.statements += 1;
          tally.statementMs += ms;
          note(sql, ms);
        }
      };
    }
    return statement;
  };
  Database.prototype.exec = function countedExec(sql, ...rest) {
    const at = performance.now();
    try {
      return exec.call(this, sql, ...rest);
    } finally {
      tally.execs += 1;
      tally.execMs += performance.now() - at;
    }
  };
  Database.__sidequestCounted = true;
  return Database;
}

const load = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  const loaded = load.call(this, request, ...rest);
  if (/better-sqlite3/.test(String(request)) && typeof loaded === 'function') return wrap(loaded);
  return loaded;
};

process.on('SIGUSR2', () => {
  const top = [...tally.bySql.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12).map(([sql, entry]) => ({ n: entry.n, ms: Number(entry.ms.toFixed(2)), sql }));
  console.log(
    `SQLITE_TALLY ${JSON.stringify({ prepares: tally.prepares, prepareMs: Number(tally.prepareMs.toFixed(2)), statements: tally.statements, statementMs: Number(tally.statementMs.toFixed(2)), execs: tally.execs, execMs: Number(tally.execMs.toFixed(2)), distinctSql: tally.bySql.size, top })}`,
  );
  reset();
});
