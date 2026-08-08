import { Suspense } from 'react';
import { SchedulingScreen } from '../../../../components/scheduling-screen';

export default async function SchedulingPage({ params }: { params: Promise<{ loopId: string }> }) {
  const { loopId } = await params;
  // `useSearchParams` needs a boundary; the screen renders its own skeleton once
  // mounted, so the fallback here only covers the first paint.
  return (
    <Suspense fallback={null}>
      <SchedulingScreen loopId={loopId} />
    </Suspense>
  );
}
