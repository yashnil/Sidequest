import { chromeAccount } from '@/lib/auth/chrome';
import { ProductChrome } from '@/components/ProductChrome';

/**
 * The shared read-only trip wears the product's shell.
 *
 * Mounted per section rather than at the root, for the reason `trips/layout.tsx`
 * gives: the root layout must stay chrome-free so `/labs/benchmark` cannot leak
 * a wordmark into its flight payload. A share link is the opposite case — it is
 * the one page a stranger meets the product on, and it should say whose it is.
 */
export default async function ShareLayout({ children }: { children: React.ReactNode }) {
  return <ProductChrome account={await chromeAccount()}>{children}</ProductChrome>;
}
