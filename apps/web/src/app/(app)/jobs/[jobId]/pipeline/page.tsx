import { Suspense } from 'react';
import { PipelineBoard } from '../../../../../components/pipeline-board';

export default async function PipelinePage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  // useSearchParams needs a Suspense boundary; the board renders its own skeleton once
  // mounted, so the fallback here is only for the first paint.
  return (
    <Suspense fallback={null}>
      <PipelineBoard jobId={jobId} />
    </Suspense>
  );
}
