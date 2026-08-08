import { ProductChrome } from '@/components/ProductChrome';

/** The customer journey's shell. See the note in `../trips/layout.tsx`. */
export default function DecideLayout({ children }: { children: React.ReactNode }) {
  return <ProductChrome>{children}</ProductChrome>;
}
