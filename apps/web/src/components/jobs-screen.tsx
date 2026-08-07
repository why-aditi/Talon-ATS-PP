'use client';

import { JobStatusSchema, type Job } from '@talon/contracts';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useJobs } from '../lib/jobs-query';
import { ChevronDownIcon } from './icons';
import { Avatar, Button, DistributionBar, Eyebrow, StatusPill, buttonClass, cx } from './ui';

/**
 * Column tracks live in design-tokens.json under `layout.jobRow`, where the measurement
 * and its provenance are recorded. The title track is the flexible one; the rest carry
 * their own gutters, so the grid gap is zero.
 * Declared once and shared with the skeleton so the two cannot drift apart.
 */
const ROW_GRID = [
  'grid items-center px-4',
  'grid-cols-[minmax(0,1fr)_var(--layout-job-row-recruiter-column)_var(--layout-job-row-distribution-column)_var(--layout-job-row-active-count-column)_var(--layout-job-row-status-column)]',
].join(' ');
const ROW_HEIGHT = 'h-[var(--layout-row-height)]';

/** A job counts toward "N open" unless it has been closed out. */
const isOpen = (job: Job) => job.status !== 'closed';

/** URL `?state=` → the mock scenario that produces it. Filtered-empty needs no entry. */
const STATE_SCENARIOS: Record<string, string> = {
  loading: 'slow',
  empty: 'empty',
  error: 'error',
  forbidden: 'forbidden',
};

/* ── Row ───────────────────────────────────────────────────────────────────── */

function JobRow({ job }: { job: Job }) {
  return (
    // ponytail: not a link yet — the job detail screen is M1, and a row that focuses
    // but goes nowhere is worse than one that does not focus. Becomes an <a> then.
    <li
      className={cx(
        ROW_GRID,
        ROW_HEIGHT,
        'transition-colors duration-[var(--duration-instant)] ease-standard hover:bg-bg-surface-hover',
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-card-title text-text-primary">{job.title}</p>
        {/* The reference renders req code and location as one monospace line;
            DESIGN_SYSTEM §4 describes it as `code`/`meta`. Following the screen. */}
        <p className="truncate font-mono text-code text-text-tertiary">
          {job.reqCode} · {job.location}
        </p>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        {/* The contract makes recruiter nullable — an unassigned req says so rather
            than rendering an avatar for nobody. */}
        {job.recruiter ? (
          <>
            <Avatar id={job.recruiter.id} name={job.recruiter.name} />
            <span className="truncate text-body text-text-secondary">{job.recruiter.name}</span>
          </>
        ) : (
          <span className="truncate text-body text-text-tertiary">Unassigned</span>
        )}
      </div>

      <div>
        <DistributionBar distribution={job.stageDistribution} inProcessCount={job.inProcessCount} />
        <p className="mt-1 text-meta tabular-nums text-text-tertiary">{job.inProcessCount} in process</p>
      </div>

      <p className="text-body tabular-nums text-text-primary">{job.activeCount} active</p>

      <div className="justify-self-start">
        <StatusPill status={job.status} />
      </div>
    </li>
  );
}

/* ── States ────────────────────────────────────────────────────────────────── */

function Placeholder({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border-default bg-bg-surface px-6 py-12 text-center">
      <p className="text-body-strong text-text-primary">{title}</p>
      <p className="max-w-md text-body text-text-secondary">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

function LoadingSkeleton() {
  // Rows sit at the real 55px so nothing jumps when data lands. The department headers
  // still shift by one row's worth: the grouping is not known until the response is.
  return (
    // Placeholder bars stand in for text runs of unknown length, so their widths are
    // fractions of the track rather than measured constants — the row height and the
    // columns are what must not shift, and both come from tokens.
    <div role="status" aria-busy="true" aria-label="Loading jobs">
      <div className="mb-2 h-4 w-1/6 animate-pulse rounded-xs bg-border-subtle" />
      <div className="overflow-hidden rounded-lg border border-border-default bg-bg-surface">
        <ul className="divide-y divide-border-subtle">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <li key={row} className={cx(ROW_GRID, ROW_HEIGHT)}>
              <div className="space-y-2">
                <div className="h-4 w-1/3 animate-pulse rounded-xs bg-border-subtle" />
                <div className="h-3 w-1/4 animate-pulse rounded-xs bg-border-subtle" />
              </div>
              <div className="flex items-center gap-2">
                <div className="size-6 animate-pulse rounded-full bg-border-subtle" />
                <div className="h-4 w-20 animate-pulse rounded-xs bg-border-subtle" />
              </div>
              <div className="h-[var(--layout-progress-rule-height)] w-[var(--layout-job-row-distribution-bar-width)] animate-pulse rounded-full bg-border-subtle" />
              <div className="h-4 w-12 animate-pulse rounded-xs bg-border-subtle" />
              <div className="h-5 w-12 animate-pulse rounded-sm bg-border-subtle" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── Screen ────────────────────────────────────────────────────────────────── */

export function JobsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const status = searchParams.get('status') ?? '';
  const department = searchParams.get('department') ?? '';
  const state = searchParams.get('state') ?? '';
  const isFiltered = Boolean(status || department);

  const query = useJobs({
    status: status || undefined,
    department: department || undefined,
    scenario: STATE_SCENARIOS[state],
  });

  const jobs = query.data?.data ?? [];
  const openCount = jobs.filter(isOpen).length;

  // A failed *refetch* is not a failed load. React Query keeps the last good `data`
  // across a failure, so rendering the error card unconditionally would stack it on
  // top of rows that are still on screen — telling a recruiter the board is fine and
  // broken at once. The two situations get different treatment.
  const hasData = query.data !== undefined;
  const loadFailed = query.isError && !hasData;
  const refreshFailed = query.isError && hasData;

  function setStatus(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set('status', next);
    else params.delete('status');
    router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false });
  }

  // Groups keep first-appearance order, which is the order the API returns and the
  // order the reference screen shows — Engineering, Design, People, Sales.
  const groups: { department: string; jobs: Job[] }[] = [];
  for (const job of jobs) {
    const group = groups.find((g) => g.department === job.department);
    if (group) group.jobs.push(job);
    else groups.push({ department: job.department, jobs: [job] });
  }

  return (
    <div className="mx-auto w-full max-w-[var(--layout-content-max-width)]">
      <div className="flex items-center gap-3 pb-4">
        <h1 className="font-display text-page-title text-text-primary">Jobs</h1>
        <p className="flex-1 text-meta tabular-nums text-text-tertiary">{hasData ? `${openCount} open` : ''}</p>

        {/*
          The height belongs on the select, not the wrapper: a wrapper-sized control
          leaves the real hit target at the select's ~20px line box, under the 24×24
          minimum. The chevron overlays the select's own right padding and is
          pointer-events-none, so the arrow is part of the target rather than a hole
          in it. Neither failure is visible to axe — both need a human or a ruler.
        */}
        <div className="flex h-[var(--control-height-md)] items-center gap-1 rounded-md border border-border-default bg-bg-surface pl-3 pr-2 text-body">
          <span className="pointer-events-none text-text-secondary">Status:</span>
          <span className="relative flex h-full items-center">
            <select
              aria-label="Filter jobs by status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="h-full appearance-none bg-transparent pr-5 text-text-primary"
            >
              <option value="">All</option>
              {JobStatusSchema.options.map((value) => (
                <option key={value} value={value}>
                  {value === 'on_hold' ? 'On hold' : value.charAt(0).toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-0 text-text-secondary" />
          </span>
        </div>
      </div>

      {query.isPending ? <LoadingSkeleton /> : null}

      {loadFailed ? (
        <Placeholder
          title="Jobs didn't load."
          body="The connection dropped before the list arrived. Your filters are still set — try again."
          action={
            <Button variant="primary" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      ) : null}

      {/* Rows stay; the banner says only that they may be stale. */}
      {refreshFailed ? (
        <div
          role="status"
          className="mb-4 flex items-center gap-3 rounded-lg bg-feedback-warning-bg px-4 py-3"
        >
          <p className="flex-1 text-body text-feedback-warning-fg">
            These counts may be out of date — the last refresh didn&apos;t reach the server.
          </p>
          <Button onClick={() => void query.refetch()}>Refresh</Button>
        </div>
      ) : null}

      {hasData && jobs.length === 0 && isFiltered ? (
        <Placeholder
          title="No jobs match this filter."
          body={
            department
              ? `No jobs in ${department}. Clear the filter to see every job again.`
              : 'Nothing in the list has that status. Clear the filter to see every job again.'
          }
          action={
            <Link href={pathname} className={buttonClass()}>
              Clear filter
            </Link>
          }
        />
      ) : null}

      {/*
        No action here: "+ New job" is deferred with the wizard (§7.4). A primary
        button that does nothing would teach the next person the route exists.
      */}
      {hasData && jobs.length === 0 && !isFiltered ? (
        <Placeholder
          title="No open roles yet."
          body="Create your first job from the sidebar to start a pipeline. Candidates land in Applied as soon as it is live."
        />
      ) : null}

      {groups.map((group) => (
        <section key={group.department} className="mt-6 first:mt-0">
          <Eyebrow className="pb-2">
            {group.department} · {group.jobs.filter(isOpen).length} open
          </Eyebrow>
          <div className="overflow-hidden rounded-lg border border-border-default bg-bg-surface">
            <ul className="divide-y divide-border-subtle">
              {group.jobs.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </ul>
          </div>
        </section>
      ))}
    </div>
  );
}
