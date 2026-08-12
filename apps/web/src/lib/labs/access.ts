import 'server-only';
import { cookies, headers } from 'next/headers';
import {
  LABS_TOKEN_COOKIE,
  LABS_TOKEN_HEADER,
  labsAccess,
  type LabsAccess,
} from '@/lib/net/billable-surface';

/**
 * THE LABS GATE ON THE PATH A SPENDING REQUEST ACTUALLY TAKES.
 *
 * The middleware's `matcher: ['/labs/:path*']` guards navigations to the labs
 * pages. It does not guard the labs *actions*, and that is not a subtlety: Next
 * dispatches a server action by its `Next-Action` id against a global manifest,
 * so the same action id POSTed to `/` runs exactly as it does at
 * `/labs/benchmark/x/run`. A reviewer demonstrated it against the running
 * production build. Every exported action under `app/labs/**` therefore asks
 * this first, and `labs/actions.architecture.test.ts` fails if one does not.
 *
 * Same predicate, same token, same conditionality as the middleware — fixture
 * deployments stay open so local development and the browser suite are
 * unaffected, and any billable configuration closes the door unless
 * `SIDEQUEST_LABS_TOKEN` is set and presented. One module answers both, so the
 * page gate and the action gate cannot disagree.
 *
 * Returns rather than throws. A thrown error inside a server action reaches the
 * browser as a digest and an error boundary, which tells an unauthorised caller
 * that something exploded; a quiet refusal in each action's own result shape
 * tells them nothing and leaves the authorised path unchanged.
 */
export async function labsAccessDecision(): Promise<LabsAccess> {
  let offered: string;
  try {
    const requestHeaders = await headers();
    offered = requestHeaders.get(LABS_TOKEN_HEADER)?.trim() ?? '';
    if (offered === '') {
      const jar = await cookies();
      offered = jar.get(LABS_TOKEN_COOKIE)?.value?.trim() ?? '';
    }
  } catch {
    /*
     * Outside a request scope — a unit test, or an internal caller. The
     * credential is simply absent, which is the honest input: `labsAccess`
     * still opens for a deployment that cannot spend and still refuses one
     * that can. Failing open here would make the guard depend on being able to
     * read a header.
     */
    offered = '';
  }

  return labsAccess(offered);
}

/**
 * The common case: may this labs action run at all?
 *
 * A boolean rather than the decision, because no labs action has anywhere to
 * put a status code — each one refuses in its own result shape.
 */
export async function labsAccessGranted(): Promise<boolean> {
  return (await labsAccessDecision()).allowed;
}
