'use client';

/**
 * Candidates list — spec 007 §7.2.
 *
 * This screen has NO reference. The nine screenshots include a candidate *profile*
 * (05) and no list, so the row grammar here is borrowed wholesale from `jobs-screen`:
 * avatar, name over subtitle, then fixed metadata tracks. That is the only list
 * grammar the design actually has, and inventing a second one would be a guess wearing
 * the confidence of a measurement. Spec 007 OQ-1 carries the question.
 */
import type { CandidateSummary } from '@talon/contracts';
import Link from 'next/link';
import { useCandidates } from '../lib/people-query';
import { SOURCE_LABELS } from '../lib/labels';
import { Avatar, cx } from './ui';

/** Declared once and shared with the skeleton, so the two cannot drift out of
 *  alignment — the pattern `jobs-screen.tsx` uses and explains. */
const ROW_GRID =
  'grid items-center gap-4 px-4 grid-cols-[minmax(0,1fr)_auto_auto_auto_auto]';
const ROW_HEIGHT = 'h-[var(--layout-row-height)]';

const STAGE_DOT: Record<string, string> = {
  applied: 'bg-stage-applied',
  screen: 'bg-stage-screen',
  onsite: 'bg-stage-onsite',
  offer: 'bg-stage-offer',
  hired: 'bg-stage-hired',
  rejected: 'bg-stage-rejected',
};

const stageLabel = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1);

function Row({ candidate }: { candidate: CandidateSummary }) {
  return (
    <li className="border-b border-border-subtle last:border-0">
      <Link
        href={`/candidates/${candidate.id}`}
        className={cx(ROW_GRID, ROW_HEIGHT, 'hover:bg-action-ghost-bg-hover')}
      >
        <span className="flex min-w-0 items-center gap-3">
          <Avatar id={candidate.id} name={candidate.name} size={24} />
          <span className="min-w-0">
            <span className="block truncate text-body-strong text-text-primary">{candidate.name}</span>
            <span className="block truncate text-body text-text-secondary">
              {candidate.currentTitle} at {candidate.currentCompany}
            </span>
          </span>
        </span>
        <span className="truncate text-body text-text-secondary">{candidate.jobTitle}</span>
        {/* Dot plus label. The stage is never carried by colour alone (§4.15). */}
        <span className="flex items-center gap-2 text-body text-text-primary">
          <span
            className={cx('size-[var(--layout-stage-dot-size)] shrink-0 rounded-full', STAGE_DOT[candidate.stage])}
            aria-hidden="true"
          />
          {stageLabel(candidate.stage)}
        </span>
        <span className="text-body text-text-tertiary tabular-nums">{candidate.daysInStage}d</span>
        <span className="truncate text-body text-text-tertiary">{SOURCE_LABELS[candidate.source]}</span>
      </Link>
    </li>
  );
}

export function CandidatesScreen() {
  const query = useCandidates();

  return (
    <div className="flex flex-1 flex-col gap-4 p-[var(--layout-page-gutter)]">
      <h1 className="text-page-title text-text-primary">Candidates</h1>

      <div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
        <div className={cx(ROW_GRID, 'h-10 border-b border-border-subtle text-caption uppercase text-text-tertiary')}>
          <span>Candidate</span>
          <span>Job</span>
          <span>Stage</span>
          <span>In stage</span>
          <span>Source</span>
        </div>

        {query.isPending ? (
          <ul>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <li key={i} className={cx(ROW_GRID, ROW_HEIGHT, 'border-b border-border-subtle last:border-0')}>
                <span className="h-4 w-20 animate-pulse rounded-sm bg-bg-surface-sunken" />
                <span className="h-4 w-20 animate-pulse rounded-sm bg-bg-surface-sunken" />
                <span className="h-4 w-12 animate-pulse rounded-sm bg-bg-surface-sunken" />
                <span className="h-4 w-8 animate-pulse rounded-sm bg-bg-surface-sunken" />
                <span className="h-4 w-20 animate-pulse rounded-sm bg-bg-surface-sunken" />
              </li>
            ))}
          </ul>
        ) : query.isError ? (
          <p className="p-6 text-body text-text-secondary">Candidates could not be loaded.</p>
        ) : query.data.items.length === 0 ? (
          <p className="p-6 text-body text-text-secondary">No candidates yet.</p>
        ) : (
          <ul>
            {query.data.items.map((candidate) => (
              <Row key={candidate.applicationId} candidate={candidate} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
