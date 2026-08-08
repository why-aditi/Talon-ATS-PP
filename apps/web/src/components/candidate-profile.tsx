'use client';

/**
 * Candidate profile — reference screen 05, spec 007 §7.3.
 *
 * Read-only, like the rest of spec 007. Reject / Schedule / Advance and the note
 * composer render as drawn and do nothing (§6).
 *
 * The comp expectation row is the interesting part. It has THREE states, not two, and
 * collapsing them is the bug this screen exists to avoid:
 *
 *   present               → the figure
 *   null, has scope       → "Not stated" — they never told us
 *   null, lacks scope     → the row is not rendered at all
 *
 * The last two are the same JSON. Only the caller's scope distinguishes them, which is
 * why the API sends `null` rather than omitting the key (§4.3) and why the component
 * asks the session for the role rather than inferring from the payload.
 */
import type { ActivityEntry, CandidateProfile } from '@talon/contracts';
import Link from 'next/link';
import { formatCompactMoney, formatInZone, useCandidateProfile } from '../lib/people-query';
import { useSession } from '../lib/session';
import { Avatar, Button, Eyebrow, cx } from './ui';

/** Mirrors the mock's gate (spec 007 §9). The component uses this only to tell the two
 *  nulls apart — it is not what withholds the value; the API already did that. */
const COMP_SCOPED = new Set(['admin', 'recruiting_lead', 'recruiter', 'hiring_manager']);

const DOT: Record<ActivityEntry['kind'], string> = {
  scheduling: 'bg-feedback-info-fg',
  scorecard: 'bg-feedback-success-fg',
  stage: 'bg-feedback-success-fg',
  email: 'bg-text-tertiary',
  note: 'bg-text-tertiary',
};

const TABS = [
  { key: 'emails', label: 'Emails' },
  { key: 'interviews', label: 'Interviews' },
  { key: 'scorecards', label: 'Scorecards' },
  { key: 'files', label: 'Files' },
] as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-text-tertiary">{label}</dt>
      <dd className="text-body-strong text-text-primary">{children}</dd>
    </div>
  );
}

function Rail({ profile, showComp }: { profile: CandidateProfile; showComp: boolean }) {
  const comp = profile.details.compExpectation;
  return (
    <aside className="flex w-[var(--layout-detail-rail-width)] shrink-0 flex-col gap-6 border-l border-border-subtle bg-bg-surface p-6">
      <div>
        <Eyebrow className="mb-3">Details</Eyebrow>
        <dl className="flex flex-col gap-4">
          <Field label="Email">{profile.details.email}</Field>
          <Field label="Phone">{profile.details.phone}</Field>
          <Field label="Source">{profile.details.source}</Field>
          <Field label="Recruiter">{profile.details.recruiterName}</Field>
          {/* Rendered only with scope. Without it the row is absent, because the label
              "Comp expectation" is itself the information being withheld (§10 case 8). */}
          {showComp ? (
            <Field label="Comp expectation">
              {comp
                ? `${formatCompactMoney(comp.minCents, comp.currency)} to ${formatCompactMoney(comp.maxCents, comp.currency)}`
                : 'Not stated'}
            </Field>
          ) : null}
          {profile.details.noticePeriod === null ? null : (
            <Field label="Notice period">{profile.details.noticePeriod}</Field>
          )}
        </dl>
      </div>

      <div>
        <Eyebrow className="mb-3">Job</Eyebrow>
        <Link href={`/jobs/${profile.job.id}/pipeline`} className="text-body-strong text-text-link hover:underline">
          {profile.job.title}
        </Link>
        <p className="text-body text-text-secondary">
          {profile.job.reference} · {profile.job.recruiterName}
        </p>
      </div>

      {profile.links.length === 0 ? null : (
        <div>
          <Eyebrow className="mb-3">Links</Eyebrow>
          <ul className="flex flex-wrap gap-2">
            {profile.links.map((link) => (
              <li key={link.label}>
                <a
                  href={link.href}
                  rel="noopener noreferrer"
                  className="inline-flex items-center rounded-full border border-border-default px-3 py-px text-caption text-text-link"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

export function CandidateProfileScreen({ candidateId }: { candidateId: string }) {
  const query = useCandidateProfile(candidateId);
  const { session } = useSession();
  const showComp = COMP_SCOPED.has(session?.user.role ?? '');

  if (query.isPending) {
    return (
      <div className="flex flex-1 gap-6 p-6">
        <div className="flex-1 space-y-3">
          <div className="h-12 w-20 animate-pulse rounded-md bg-bg-surface-sunken" />
          <div className="h-20 animate-pulse rounded-lg bg-bg-surface-sunken" />
        </div>
        <div className="h-20 w-[var(--layout-detail-rail-width)] animate-pulse rounded-lg bg-bg-surface-sunken" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-body text-text-secondary">This candidate could not be loaded.</p>
        <Button variant="primary" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const profile = query.data;

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="flex flex-col gap-4 border-b border-border-subtle bg-bg-surface px-6 py-5">
          <div className="flex items-start gap-3">
            <Avatar id={profile.id} name={profile.name} size={44} />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-page-title text-text-primary">{profile.name}</h1>
              <p className="truncate text-body text-text-secondary">
                {profile.currentTitle} at {profile.currentCompany} · {profile.location}
              </p>
            </div>
            <Button
              variant="secondary"
              aria-disabled="true"
              title="Rejecting needs the real endpoint — see spec 007 §6"
              className="border-border-danger text-action-danger-text"
            >
              Reject
            </Button>
            <Button variant="secondary" aria-disabled="true" title="Scheduling ships with spec 004">
              Schedule
            </Button>
            <Button variant="primary" aria-disabled="true" title="Advancing needs the real endpoint — see spec 007 §6">
              Advance →
            </Button>
          </div>

          {/* Stage rail. Current stage is named as well as tinted (§4.15). */}
          <div className="flex flex-wrap items-center gap-2">
            {profile.stages.map((stage, i) => {
              const isCurrent = stage.toLowerCase() === profile.stage;
              return (
                <span key={stage} className="flex items-center gap-2">
                  {i > 0 ? (
                    <span aria-hidden="true" className="text-text-tertiary">
                      ›
                    </span>
                  ) : null}
                  <span
                    aria-current={isCurrent ? 'step' : undefined}
                    className={cx(
                      'inline-flex items-center rounded-full border px-3 py-px text-body',
                      isCurrent
                        ? 'border-action-primary-bg bg-bg-selected text-text-link'
                        : 'border-border-default text-text-secondary',
                    )}
                  >
                    {stage}
                  </span>
                </span>
              );
            })}
            <span className="text-body text-text-secondary">
              {profile.daysInStage}d in {profile.stage.charAt(0).toUpperCase() + profile.stage.slice(1)}
            </span>
          </div>

          {/* Only Activity is built. The rest carry their counts and are disabled —
              their bodies have no design, and Scorecards needs §4.3 blindness
              specified before anything is drawn (spec 007 §2, OQ-5). */}
          <div role="tablist" aria-label="Candidate record" className="-mb-5 flex gap-6">
            <span
              role="tab"
              aria-selected="true"
              className="border-b-2 border-text-primary pb-3 text-body-strong text-text-primary"
            >
              Activity
            </span>
            {TABS.map((tab) => (
              <span
                key={tab.key}
                role="tab"
                aria-selected="false"
                aria-disabled="true"
                title="Not built yet — spec 007 open question 5"
                className="pb-3 text-body text-text-tertiary"
              >
                {tab.label} {profile.tabCounts[tab.key]}
              </span>
            ))}
          </div>
        </header>

        <div className="flex flex-col gap-4 p-6">
          {/* Absent, not empty, when there is nothing outstanding (§10 case 5). */}
          {profile.nextAction ? (
            <div className="flex items-center gap-4 rounded-lg bg-bg-selected px-5 py-4">
              <div className="min-w-0 flex-1">
                <Eyebrow className="text-text-link">Next action</Eyebrow>
                <p className="text-body-lg text-text-primary">{profile.nextAction.text}</p>
              </div>
              {profile.nextAction.href ? (
                <Link href={profile.nextAction.href} className="shrink-0">
                  <Button variant="primary">Open scheduling</Button>
                </Link>
              ) : null}
            </div>
          ) : null}

          <div className="flex gap-3">
            <input
              disabled
              placeholder="Log a note, @ to mention"
              aria-label="Log a note"
              title="Notes need the real endpoint — see spec 007 §6"
              className="h-[var(--layout-control-height-md)] flex-1 rounded-md border border-border-default bg-bg-surface px-3 text-body text-text-primary placeholder:text-text-placeholder disabled:bg-action-disabled-bg"
            />
            <Button aria-disabled="true" title="Notes need the real endpoint — see spec 007 §6">
              Add note
            </Button>
          </div>

          {profile.activity.length === 0 ? (
            <p className="py-8 text-center text-body text-text-secondary">No activity yet.</p>
          ) : (
            <ol className="flex flex-col border-l border-border-subtle pl-0">
              {profile.activity.map((entry) => (
                <li key={entry.id} className="relative flex gap-4 pb-3 pl-6">
                  <span
                    className={cx('absolute left-0 top-4 size-2 -translate-x-1/2 rounded-full', DOT[entry.kind])}
                    aria-hidden="true"
                  />
                  <div className="flex flex-1 items-start gap-4 rounded-lg border border-border-subtle bg-bg-surface px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-body-strong text-text-primary">{entry.title}</p>
                      <p className="text-body text-text-secondary">{entry.body}</p>
                    </div>
                    {/* The session's zone, not the browser's (§4.7). */}
                    <time
                      dateTime={entry.at}
                      className="shrink-0 text-caption text-text-tertiary"
                      title={entry.at}
                    >
                      {formatInZone(entry.at, session?.user.timezone ?? 'UTC')}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <Rail profile={profile} showComp={showComp} />
    </div>
  );
}
