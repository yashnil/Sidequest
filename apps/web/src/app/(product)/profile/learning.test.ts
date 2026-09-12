import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreferenceEvidenceRow } from '@sidequest/core';

/**
 * V9 §18 — "SIDEQUEST NOTICED" IS REVERSIBLE, AND A DISMISSAL IS KEPT.
 *
 * Three claims. A dismissed leaning never reaches the brief (`learnedForOwner`
 * is what `production-plan.ts` reads before the one call). The profile still
 * sees it, marked dismissed, so it can be restored. Restoring or confirming
 * records an explicit confirmation on the ledger in the ledger's own words —
 * and never for a feature the ledger refuses.
 */

const jar = new Map<string, string>();

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (options?.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-learning-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_AUTH_PROVIDER = 'fixture';
  process.env.SIDEQUEST_ACTION_FENCES = 'off';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_AUTH_PROVIDER;
  delete process.env.SIDEQUEST_ACTION_FENCES;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-09-11T10:00:00.000Z');

function row(userId: string, feature: string, at: string, overrides: Partial<PreferenceEvidenceRow> = {}): Omit<PreferenceEvidenceRow, 'id'> {
  return { userId, ownerToken: null, travelerId: null, tripId: null, scope: 'account', signal: 'post_trip_loved', feature, polarity: 1, strength: 1, source: 'post_trip', context: {}, createdAt: at, ...overrides };
}

async function signedInUserId(): Promise<string> {
  const { fixtureSignInAction } = await import('@/app/(product)/signin/actions');
  expect((await fixtureSignInAction({ email: 'learner@example.com' })).ok).toBe(true);
  const { currentUser } = await import('@/lib/auth/session');
  return (await currentUser())!.id;
}

describe('a dismissed leaning', () => {
  it('leaves the brief and stays visible on the profile, until restored', async () => {
    const userId = await signedInUserId();
    const { recordPreferenceEvidence, learnedForOwner, learnedWithDismissals } = await import('@/lib/db/preference-evidence-repository');
    recordPreferenceEvidence([row(userId, 'interest:hiking', '2026-08-01T00:00:00.000Z'), row(userId, 'interest:hiking', '2026-08-10T00:00:00.000Z'), row(userId, 'category:market', '2026-08-05T00:00:00.000Z')]);
    const owner = { userId, ownerToken: null };
    expect(learnedForOwner(owner, NOW).learned.map((p) => p.feature).sort()).toEqual(['category:market', 'interest:hiking']);
    expect(learnedForOwner(owner, NOW).hints.some((h) => h.includes('hiking'))).toBe(true);

    const { dismissLearnedAction, restoreLearnedAction } = await import('@/app/(product)/profile/actions');
    expect((await dismissLearnedAction('interest:hiking')).ok).toBe(true);

    const brief = learnedForOwner(owner, NOW);
    expect(brief.learned.map((p) => p.feature)).toEqual(['category:market']);
    expect(brief.hints.some((h) => h.includes('hiking'))).toBe(false);

    const profile = learnedWithDismissals(owner, NOW);
    expect(profile.dismissed).toEqual(['interest:hiking']);
    expect(profile.learned.map((p) => p.feature).sort()).toEqual(['category:market', 'interest:hiking']);

    expect((await restoreLearnedAction('interest:hiking')).ok).toBe(true);
    expect(learnedWithDismissals(owner, NOW).dismissed).toEqual([]);
    expect(learnedForOwner(owner, NOW).learned.map((p) => p.feature).sort()).toEqual(['category:market', 'interest:hiking']);
  });

  it('is scoped to the account: a browser with no account has nothing dismissed', async () => {
    const { learnedWithDismissals } = await import('@/lib/db/preference-evidence-repository');
    expect(learnedWithDismissals({ userId: null, ownerToken: 'browser-1' }, NOW)).toEqual({ learned: [], dismissed: [] });
  });
});

describe('restoring or confirming a leaning', () => {
  it('records one explicit confirmation on the ledger, agreeing with the lean as it stands', async () => {
    const userId = await signedInUserId();
    const { recordPreferenceEvidence, listPreferenceEvidence } = await import('@/lib/db/preference-evidence-repository');
    recordPreferenceEvidence([row(userId, 'pace:slow', '2026-08-01T00:00:00.000Z', { polarity: -1 }), row(userId, 'pace:slow', '2026-08-09T00:00:00.000Z', { polarity: -1 })]);
    const { confirmLearnedAction, restoreLearnedAction } = await import('@/app/(product)/profile/actions');

    expect((await confirmLearnedAction('pace:slow')).ok).toBe(true);
    const afterConfirm = listPreferenceEvidence({ userId, ownerToken: null }).filter((r) => r.signal === 'recommendation_accepted');
    expect(afterConfirm).toHaveLength(1);
    expect(afterConfirm[0]).toMatchObject({ feature: 'pace:slow', polarity: -1, source: 'explicit', scope: 'account', context: { surface: 'profile', how: 'confirmed' } });

    expect((await restoreLearnedAction('pace:slow')).ok).toBe(true);
    const afterRestore = listPreferenceEvidence({ userId, ownerToken: null }).filter((r) => r.signal === 'recommendation_accepted');
    expect(afterRestore).toHaveLength(2);
    expect(afterRestore.map((r) => r.context.how).sort()).toEqual(['confirmed', 'restored']);
  });

  it('writes nothing for a feature Sidequest never learned', async () => {
    const userId = await signedInUserId();
    const { listPreferenceEvidence } = await import('@/lib/db/preference-evidence-repository');
    const { confirmLearnedAction } = await import('@/app/(product)/profile/actions');
    expect((await confirmLearnedAction('interest:opera')).ok).toBe(true);
    expect(listPreferenceEvidence({ userId, ownerToken: null })).toEqual([]);
  });
});
