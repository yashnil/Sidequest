import { NextResponse, type NextRequest } from 'next/server';

/**
 * THE ONE SURFACE THAT CAN SPEND MONEY, AND WHO MAY REACH IT.
 *
 * `/labs` is the internal comparison harness. Pressing its start control runs
 * two planners, one of which makes billed model calls, and until now nothing
 * stood between the open internet and that button: there was no middleware
 * anywhere in the app, and the labs layout is a skip link and a `main` landmark.
 * Locally that is fine. On any reachable deployment with live mode configured it
 * is a stranger's hand on a spending control.
 *
 * The gate is deliberately conditional rather than absolute, because an
 * unconditional one would break the thing it is protecting. Two properties:
 *
 * **Fixture mode stays open.** The default configuration — and everything the
 * browser suite runs against — makes no paid call at all, so requiring a secret
 * there would add a login to a surface that cannot cost anything, and every
 * developer and every end-to-end run would carry a token for no reason.
 *
 * **Live mode is closed unless a token is set and presented.** The moment a
 * deployment configures paid operations, `/labs` requires `SIDEQUEST_LABS_TOKEN`
 * — and if live mode is on and no token is configured, the surface is refused
 * outright rather than left open. A deployment that turns on spending and forgets
 * the secret gets a locked door, not an open one.
 *
 * Middleware rather than a check inside the actions, because a server action is
 * one of several ways to reach this tree and the next one added would not have
 * the check. This runs before any of them.
 */

/**
 * Read here rather than imported from `lib/benchmark/budget`.
 *
 * Middleware runs on the edge runtime, and pulling in the budget module would
 * drag the SDK and the database client behind it. The two conditions are
 * duplicated as literal string comparisons — the same shape `switches.ts` uses,
 * and for the same reason: a predicate about spending must not depend on
 * anything that could fail to load.
 */
function liveSpendingConfigured(): boolean {
  const mode = process.env.SIDEQUEST_BENCHMARK_MODE?.trim().toLowerCase();
  const budget = process.env.SIDEQUEST_BENCHMARK_BUDGET_USD?.trim();
  return mode === 'live' && budget !== undefined && budget.length > 0;
}

/** Fixed-width, constant-time-ish comparison without importing node:crypto. */
function secretsMatch(offered: string, expected: string): boolean {
  if (offered.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < offered.length; index += 1) {
    diff |= offered.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

export function middleware(request: NextRequest): NextResponse {
  if (!liveSpendingConfigured()) return NextResponse.next();

  const expected = process.env.SIDEQUEST_LABS_TOKEN?.trim();
  if (!expected) {
    return new NextResponse(
      'This deployment has live benchmark spending configured and no SIDEQUEST_LABS_TOKEN set, so the comparison harness is closed.',
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  /*
   * `??` on a trimmed string is the wrong operator: an empty-but-present header
   * is not nullish, so it short-circuited the cookie and refused an operator who
   * had a valid one. Take the first value that is actually a value.
   */
  const header = request.headers.get('x-sidequest-labs')?.trim() ?? '';
  const cookie = request.cookies.get('sidequest_labs')?.value?.trim() ?? '';
  const offered = header !== '' ? header : cookie;

  if (!offered || !secretsMatch(offered, expected)) {
    return new NextResponse('Not authorised.', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return NextResponse.next();
}

export const config = {
  /** Only the labs tree. The customer journey is untouched by this file. */
  matcher: ['/labs/:path*'],
};
