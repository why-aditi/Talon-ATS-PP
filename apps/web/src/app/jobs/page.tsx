import { Suspense } from 'react';
import { JobsScreen } from '../../components/jobs-screen';

export default function JobsPage() {
  // useSearchParams needs a Suspense boundary; the screen renders its own skeleton
  // once mounted, so the fallback here is only for the first paint.
  return (
    <Suspense fallback={null}>
      <JobsScreen />
    </Suspense>
  );
}
