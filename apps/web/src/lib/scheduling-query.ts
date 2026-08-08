import { useQuery } from '@tanstack/react-query';
import { loadLoop, type Scenario, type SchedulingLoop } from './scheduling-fixtures';

/**
 * The loop the screen renders.
 *
 * Backed by `scheduling-fixtures` rather than the network: spec 004's endpoints are
 * another stream's work and none of them exist. It is still a real query — cache key,
 * pending state, error state — so the day this becomes `fetch('/v1/interview-loops/…')`
 * nothing above it changes.
 */
export function useLoop(loopId: string, scenario: Scenario) {
  return useQuery<SchedulingLoop>({
    queryKey: ['scheduling-loop', loopId, scenario],
    queryFn: () => loadLoop(scenario),
    // A permission failure and a dropped connection are both final here; retrying a 403
    // three times just delays the message that explains it.
    retry: false,
  });
}
