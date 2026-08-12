import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchIfAllowed,
  fetchRefusalCounts,
  refusalCauseFor,
  resetFetchRefusalCounts,
  UnsafeUrlError,
} from './safe-fetch';

/**
 * WHY PAGES WERE REFUSED — THE DECOMPOSITION `pagesRejected` NEVER HAD.
 *
 * One number told an operator how many pages a build refused and nothing about
 * whether that was robots politeness, the SSRF guard, or a publisher's bad
 * afternoon — three situations with three different next moves. The histogram
 * is counts only: these tests also pin that nothing about a URL survives into
 * it.
 */

afterEach(() => {
  resetFetchRefusalCounts();
});

describe('the cause mapping', () => {
  it('maps every UnsafeUrlError code to the bucket an operator would triage', () => {
    const cause = (code: ConstructorParameters<typeof UnsafeUrlError>[0]) =>
      refusalCauseFor(new UnsafeUrlError(code, 'x'));

    expect(cause('robots_disallowed')).toBe('robots');
    expect(cause('response_too_large')).toBe('size');
    expect(cause('content_type_not_allowed')).toBe('content_type');
    expect(cause('request_failed')).toBe('transient');
    for (const policy of [
      'bad_url',
      'scheme_not_allowed',
      'credentials_in_url',
      'hostname_blocked',
      'address_blocked',
      'port_not_allowed',
      'too_many_redirects',
    ] as const) {
      expect(cause(policy)).toBe('policy');
    }
  });

  it('treats anything that is not an UnsafeUrlError as transient', () => {
    expect(refusalCauseFor(new Error('socket hang up'))).toBe('transient');
    expect(refusalCauseFor('not even an error')).toBe('transient');
  });
});

describe('counting at the retrieval entry point', () => {
  it('counts a policy refusal without recording anything about the URL', async () => {
    await expect(fetchIfAllowed('http://plain.example/page')).rejects.toThrow();
    await expect(fetchIfAllowed('https://user:pw@example.com/')).rejects.toThrow();

    const counts = fetchRefusalCounts();
    expect(counts.policy).toBe(2);
    expect(counts.robots + counts.size + counts.content_type + counts.transient).toBe(0);
    // Counts only. A histogram carrying hostnames would be a retrieval log.
    expect(Object.values(counts).every((value) => typeof value === 'number')).toBe(true);
  });

  it('counts a blocked resolution as policy, through the real lookup path', async () => {
    await expect(
      fetchIfAllowed('https://rebind.example/page', {
        resolve: async () => ['169.254.169.254'],
      }),
    ).rejects.toThrow();
    expect(fetchRefusalCounts().policy).toBeGreaterThan(0);
  });

  it('resets to zero between runs, so one job’s histogram is one job’s', async () => {
    await expect(fetchIfAllowed('http://plain.example/page')).rejects.toThrow();
    expect(fetchRefusalCounts().policy).toBe(1);
    resetFetchRefusalCounts();
    expect(fetchRefusalCounts().policy).toBe(0);
  });
});
