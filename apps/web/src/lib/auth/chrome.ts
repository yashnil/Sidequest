import 'server-only';
import { authProviders } from './config';
import { currentUser } from './session';

/**
 * WHAT THE PRODUCT CHROME NEEDS TO KNOW ABOUT THE ACCOUNT, RESOLVED ONCE
 * BY THE ASYNC LAYOUT THAT MOUNTS IT.
 *
 * `ProductChrome` stays a synchronous component so a page can be rendered to
 * a string in a unit test (`adopted-region.test.ts` does exactly that); the
 * cookie read happens here, in the layout, and travels down as props.
 */
export interface ChromeAccount {
  user: { displayName: string | null; email: string | null } | null;
  signInAvailable: boolean;
}

export async function chromeAccount(): Promise<ChromeAccount> {
  const user = await currentUser();
  return { user: user ? { displayName: user.displayName, email: user.email } : null, signInAvailable: authProviders().any };
}
