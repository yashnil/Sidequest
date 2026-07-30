import Link from 'next/link';
import { buttonClass } from '@/components/ui';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-5 py-24 text-center sm:px-8">
      <h1 className="font-display text-4xl text-ink">No such trip</h1>
      <p className="mt-3 text-ink-muted">
        That trip does not exist, or it was created against a database that has since been cleared.
      </p>
      <Link href="/trips/new" className={`${buttonClass('primary')} mt-8`}>
        Start a new one
      </Link>
    </div>
  );
}
