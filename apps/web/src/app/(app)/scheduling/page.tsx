import Link from 'next/link';
import { buttonClass } from '../../../components/button-styles';

export default function SchedulingIndexPage() {
  return (
    <main id="main" className="flex min-h-full items-center justify-center bg-bg-canvas p-8">
      <section className="max-w-lg rounded-lg border border-border-default bg-bg-surface p-8 text-center shadow-sm">
        <h1 className="text-title text-text-primary">Scheduling</h1>
        <p className="mt-3 text-body text-text-secondary">
          Open a candidate with an active interview loop to review availability and schedule their panel.
        </p>
        <Link href="/candidates" className={buttonClass('primary', 'mt-6')}>
          Browse candidates
        </Link>
      </section>
    </main>
  );
}
