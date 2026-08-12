import { NextResponse, type NextRequest } from 'next/server';
import {
  LABS_TOKEN_COOKIE,
  LABS_TOKEN_HEADER,
  labsAccess,
} from '@/lib/net/billable-surface';

/**
 * THE SPENDING GATE ON THE `/labs` **PAGES**.
 *
 * `/labs` is the internal comparison harness. Pressing its start control runs
 * two planners, one of which makes billed model calls, and until this existed
 * nothing stood between the open internet and that button.
 *
 * This file used to claim to be the whole gate, on this reasoning: "Middleware
 * rather than a check inside the actions, because a server action is one of
 * several ways to reach this tree and the next one added would not have the
 * check. This runs before any of them."
 *
 * **That reasoning was false for this framework, and it was proved false at
 * runtime.** Next resolves a server action from its `Next-Action` id against a
 * global manifest and executes it whatever URL the POST was addressed to; the
 * per-page `workers` mapping is a bundling detail, not an authorisation
 * boundary. A reviewer POSTed a labs-only action id to `/` against the running
 * production build and it ran. A path matcher therefore protects the labs pages
 * and nothing their buttons actually call.
 *
 * So the gate now lives in two places that cannot be reached around:
 *
 * - here, for **navigations**, so an unauthorised operator never sees the
 *   harness at all; and
 * - in `lib/labs/access`, called as the first statement of every exported
 *   action under `app/labs/**`, which is the path a POST actually takes.
 *   `labs/actions.architecture.test.ts` fails if an action is added without it.
 *
 * Both ask the same question of the same module, so a deployment cannot be open
 * to one and closed to the other.
 */
export function middleware(request: NextRequest): NextResponse {
  /*
   * `??` on a trimmed string is the wrong operator: an empty-but-present header
   * is not nullish, so it short-circuited the cookie and refused an operator who
   * had a valid one. Take the first value that is actually a value.
   */
  const header = request.headers.get(LABS_TOKEN_HEADER)?.trim() ?? '';
  const cookie = request.cookies.get(LABS_TOKEN_COOKIE)?.value?.trim() ?? '';

  const decision = labsAccess(header !== '' ? header : cookie);
  if (decision.allowed) return NextResponse.next();

  return new NextResponse(decision.message, {
    status: decision.status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export const config = {
  /**
   * Only the labs tree. The customer journey is untouched by this file — and
   * this constant is what decides whether the check above runs at all, so
   * `middleware.test.ts` asserts the matcher itself rather than only the
   * predicate behind it. A one-token typo here (or a future move to
   * `/internal/labs`) would otherwise silently open the harness with the whole
   * suite green.
   */
  matcher: ['/labs/:path*'],
};
