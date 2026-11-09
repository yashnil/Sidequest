import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* Each case starts two or three node processes; the default five seconds is a busy machine's coin toss. */
vi.setConfig({ testTimeout: 60_000 });

/**
 * RELEASE PASS — THE BACKUP IS WAL-SAFE AND THE RESTORE IS A TESTED PROCEDURE.
 *
 * `backup-db.mjs` claimed to be safe against a writing server and nothing ran
 * it; the restore was five manual steps. These run the two scripts as the
 * operator would — separate processes, against a database another process is
 * holding open in WAL mode with rows that exist *only* in the write-ahead log —
 * and state what must hold: the backup carries every committed row, a naive
 * file copy does not, a restore refuses to run under a live server, never
 * destroys what it replaces, never lets a stale `-wal` replay over the restored
 * pages, and refuses a backup that is not a healthy database.
 */

const BACKUP = new URL('../../../scripts/backup-db.mjs', import.meta.url).pathname;
const RESTORE = new URL('../../../scripts/restore-db.mjs', import.meta.url).pathname;

const BASICS = {
  mode: 'known_destination' as const,
  destinationInput: 'Harbour City',
  regionId: 'open-world',
  startDate: '2026-09-01',
  endDate: '2026-09-04',
  arrivalTime: '10:00',
  departureTime: '18:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

/**
 * A writer that dies mid-flight: four trips committed to the write-ahead log
 * with checkpoints off, then SIGKILL to itself. Run with `node -e`.
 */
const CRASHING_WRITER = `
const Database = require(${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))});
const db = new Database(process.argv[1]);
db.pragma('journal_mode = WAL');
db.pragma('wal_autocheckpoint = 0');
const row = db.prepare('SELECT * FROM trips LIMIT 1').get();
const columns = Object.keys(row);
const insert = db.prepare('INSERT INTO trips (' + columns.join(', ') + ') VALUES (' + columns.map(() => '?').join(', ') + ')');
for (let n = 0; n < 4; n += 1) insert.run(...columns.map((column) => (column === 'id' ? 'after-the-backup-' + n : row[column])));
process.kill(process.pid, 'SIGKILL');
`;

let dir: string;
let live: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

function run(script: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function tripCount(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** The app's own schema and repository, with checkpoints off so committed rows stay in the WAL. */
async function seedLiveDatabase(trips: number): Promise<string[]> {
  const { getDb } = await import('./client');
  const { createTrip } = await import('./repository');
  getDb().pragma('wal_autocheckpoint = 0');
  const ids: string[] = [];
  for (let n = 0; n < trips; n += 1) ids.push(createTrip({ ...BASICS, destinationInput: `Harbour City ${n}` }, `owner-${n}`).id);
  return ids;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-backup-'));
  live = join(dir, 'sidequest.db');
  process.env.SIDEQUEST_DB_PATH = live;
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('backup-db.mjs against a database the server is writing', () => {
  it('copies every committed row, including the ones that exist only in the write-ahead log', async () => {
    await seedLiveDatabase(5);
    /* The server is still attached, and its rows have never been checkpointed into the main file. */
    expect(existsSync(`${live}-wal`)).toBe(true);

    const backup = join(dir, 'backup.db');
    const result = run(BACKUP, live, backup);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('integrity ok');
    expect(result.stdout).toContain('trips=5');
    expect(tripCount(backup)).toBe(5);

    /* What `cp` of the one file would have saved: the pages before the WAL, which is not the five trips. */
    const naive = join(dir, 'naive.db');
    copyFileSync(live, naive);
    let naiveTrips: number;
    try {
      naiveTrips = tripCount(naive);
    } catch {
      naiveTrips = 0;
    }
    expect(naiveTrips).toBeLessThan(5);
  });

  it('never prints a row, and refuses to overwrite an existing backup', async () => {
    await seedLiveDatabase(2);
    const backup = join(dir, 'backup.db');
    const first = run(BACKUP, live, backup);
    expect(first.status).toBe(0);
    expect(first.stdout).not.toContain('Harbour City');
    expect(first.stdout).not.toContain('owner-0');

    const second = run(BACKUP, live, backup);
    expect(second.status).toBe(2);
    expect(second.stderr).toContain('refusing to overwrite');
  });
});

describe('restore-db.mjs', () => {
  it('refuses while a server still has the database open, and touches nothing', async () => {
    await seedLiveDatabase(3);
    const backup = join(dir, 'backup.db');
    expect(run(BACKUP, live, backup).status).toBe(0);

    const result = run(RESTORE, backup, live);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Stop the service first');
    expect(readdirSync(dir).some((name) => name.includes('.pre-restore-'))).toBe(false);

    /* The attached server is unharmed and still sees its rows. */
    const { getDb } = await import('./client');
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n).toBe(3);
  });

  it('puts the backup back, keeps what it replaced, and lets no stale write-ahead log replay over it', async () => {
    const kept = await seedLiveDatabase(3);
    const backup = join(dir, 'backup.db');
    expect(run(BACKUP, live, backup).status).toBe(0);

    /*
     * After the backup, a server process writes four more trips and is killed
     * outright — no close, no checkpoint — which is what a crash or an
     * out-of-memory kill leaves on a volume: the main file plus a `-wal` that
     * holds rows the main file does not.
     */
    releaseDatabase();
    const crashed = spawnSync(process.execPath, ['-e', CRASHING_WRITER, live], { encoding: 'utf8' });
    expect(crashed.signal, crashed.stderr).toBe('SIGKILL');
    expect(existsSync(`${live}-wal`)).toBe(true);

    const result = run(RESTORE, backup, live);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('integrity ok');
    expect(result.stdout).toContain('trips=3');
    expect(result.stdout).not.toContain('Harbour City');

    /* Exactly the backed-up trips, none of the later ones: nothing replayed. */
    const restored = new Database(live, { readonly: true });
    const ids = (restored.prepare('SELECT id FROM trips ORDER BY id').all() as { id: string }[]).map((row) => row.id);
    expect(ids).toEqual([...kept].sort());
    expect(restored.pragma('journal_mode', { simple: true })).toBe('wal');
    restored.close();

    /* What was replaced is still on disk, whole, with the seven trips it held. */
    const aside = readdirSync(dir).find((name) => /^sidequest\.db\.pre-restore-\d{8}T\d{6}Z$/.test(name));
    expect(aside, readdirSync(dir).join(', ')).toBeDefined();
    expect(tripCount(join(dir, aside!))).toBe(7);

    /* And the application opens the restored file and reads its trips through the repository. */
    const { getTrip } = await import('./repository');
    for (const id of kept) expect(getTrip(id)?.id).toBe(id);
  });

  it('restores onto a path with no database at all (a fresh volume)', async () => {
    await seedLiveDatabase(2);
    const backup = join(dir, 'backup.db');
    expect(run(BACKUP, live, backup).status).toBe(0);
    releaseDatabase();

    const fresh = join(dir, 'fresh-volume.db');
    const result = run(RESTORE, backup, fresh);
    expect(result.status, result.stderr).toBe(0);
    expect(tripCount(fresh)).toBe(2);
    expect(result.stdout).not.toContain('previous database kept');
  });

  it('refuses a backup that is not a healthy Sidequest database, and leaves the current one in place', async () => {
    const ids = await seedLiveDatabase(2);
    releaseDatabase();

    const garbage = join(dir, 'garbage.db');
    writeFileSync(garbage, 'this is not a database, it is a text file somebody renamed');
    const corrupt = run(RESTORE, garbage, live);
    expect(corrupt.status).toBe(1);
    expect(corrupt.stderr).toContain('refusing to restore');

    const foreign = join(dir, 'foreign.db');
    const other = new Database(foreign);
    other.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    other.close();
    const wrong = run(RESTORE, foreign, live);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('not a Sidequest database');

    expect(readdirSync(dir).some((name) => name.includes('.pre-restore-'))).toBe(false);
    expect(tripCount(live)).toBe(ids.length);
  });
});
