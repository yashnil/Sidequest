import { chromeAccount } from '@/lib/auth/chrome';
import { ProductChrome } from '@/components/ProductChrome';

/** The customer journey's shell. See the note in `../trips/layout.tsx`. */
export default async function ExploreLayout({ children }: { children: React.ReactNode }) {
  return <ProductChrome account={await chromeAccount()}>{children}</ProductChrome>;
}
