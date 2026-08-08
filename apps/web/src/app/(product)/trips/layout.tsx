import { ProductChrome } from '@/components/ProductChrome';

/**
 * The customer journey's shell, mounted per section rather than at the root of
 * the group.
 *
 * It sat one level up until a leakage check found what that cost. A layout in a
 * top-level route group has no URL segment of its own, so Next treats it as a
 * candidate wrapper for the application's root `not-found` — and then serialises
 * that boundary, chrome and all, into the flight payload of *every* route,
 * including `/labs/benchmark`. Nothing appeared on screen; the wordmark was
 * simply in the response bytes, which is precisely the channel the blind review
 * has to be clean in.
 *
 * Mounted at `trips` and `decide` instead, the chrome belongs to the pages that
 * want it and to nothing else. The cost is one more small file; the alternative
 * was an assertion with an exception carved out of it.
 */
export default function TripsLayout({ children }: { children: React.ReactNode }) {
  return <ProductChrome>{children}</ProductChrome>;
}
