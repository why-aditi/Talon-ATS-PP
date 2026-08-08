import type { Metadata } from 'next';
import { JobWizard } from '../../../../components/job-wizard';

export const metadata: Metadata = { title: 'New job · Talon' };

/**
 * Spec 005 §6. Inside the `(app)` group, so `RequireSession` already gates it.
 *
 * Reachable by URL only: the "+ New job" buttons still open the JD template
 * modal, and they stay pointed there until `POST /v1/jobs` exists. Spec 005 §12 —
 * a button that opens a form which cannot submit is the pipeline board's
 * navigate-then-error with more typing in between.
 */
export default function NewJobPage() {
  return <JobWizard />;
}
