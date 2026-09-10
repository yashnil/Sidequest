import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE HEALTH PROBE, AND WHAT IT REFUSES TO SAY.
 *
 * Two properties, and the second is the one worth a test: the endpoint reports
 * the database it actually depends on, and it discloses nothing else. A health
 * URL is unauthenticated by definition, so "ok" must not grow a version string,
 * a provider list or a row count the next time somebody debugs a deployment.
 */
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-health-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'health.db');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.SIDEQUEST_DB_PATH;
});

describe('GET /api/health', () => {
  it('answers ok with a reachable database, and says only that', async () => {
    const { GET } = await import('./route');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, database: 'ready' });
    /* Nothing about the deployment leaks through the most public URL it has. */
    expect(Object.keys(body).sort()).toEqual(['database', 'ok']);
  });
});
