import Link from 'next/link';
import { buttonClass } from '../../components/ui';

// The sidebar links to all nine screens; eight of them are later specs. Landing on a
// real page inside the shell beats a bare 404 that loses the navigation.
export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[var(--layout-content-max-width)] flex-col items-center gap-2 rounded-lg border border-border-default bg-bg-surface px-6 py-12 text-center">
      <p className="text-body-strong text-text-primary">That screen isn&apos;t built yet.</p>
      <p className="max-w-md text-body text-text-secondary">Jobs is the only screen in this milestone. The rest arrive with their own specs.</p>
      <Link href="/jobs" className={buttonClass('primary', 'mt-2')}>
        Back to jobs
      </Link>
    </div>
  );
}
