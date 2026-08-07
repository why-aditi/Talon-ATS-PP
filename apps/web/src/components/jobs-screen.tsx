'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Job } from '../lib/jobs-contract';
import { JOB_STATUSES } from '../lib/jobs-contract';
import { useJobs } from '../lib/jobs-query';
import { ChevronDownIcon } from './icons';
import { Avatar, Button, DistributionBar, Eyebrow, StatusPill, buttonClass, cx } from './ui';

/**
 * Column tracks measured off docs/reference/02-jobs-list@2x.png by scanning the 2880px
 * original for ink extents, then halving. At 1440 CSS the reference puts the title at
 * x=269.5, the recruiter avatar at 825, the distribution bar at 1064 (130 wide), the
 * active count at 1206.5 and the status pill at ~1312, with the card's inner edge at
 * 1400 — so the tracks carry their own gutters and the grid gap is zero.
 * Declared once and shared with the skeleton so the two cannot drift apart.
 */
const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_239px_142px_106px_88px] items-center px-4';
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
        <Avatar id={job.recruiter.id} name={job.recruiter.name} />
        <span className="truncate text-body text-text-secondary">{job.recruiter.name}</span>
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

function Placeholder({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border-default bg-bg-surface px-6 py-12 text-center">
      <p className="text-body-strong text-text-primary">{title}</p>
      <p className="max-w-md text-body text-text-secondary">{body}</p>
      <div className="mt-2">{action}</div>
    </div>
  );
}

function LoadingSkeleton() {
  // Rows sit at the real 55px so nothing jumps when data lands. The department headers
  // still shift by one row's worth: the grouping is not known until the response is.
  return (
    // Placeholder bar widths are arbitrary by nature — they stand in for text runs of
    // unknown length, so they are sized to the reference's typical run rather than to
    // a spacing token. Heights and columns are the parts that must not shift.
    <div role="status" aria-busy="true" aria-label="Loading jobs">
      <div className="mb-2 h-[14px] w-[130px] animate-pulse rounded-xs bg-border-subtle" />
      <div className="overflow-hidden rounded-lg border border-border-default bg-bg-surface">
        <ul className="divide-y divide-border-subtle">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <li key={row} className={cx(ROW_GRID, ROW_HEIGHT)}>
              <div className="space-y-2">
                <div className="h-[14px] w-[180px] animate-pulse rounded-xs bg-border-subtle" />
                <div className="h-[12px] w-[136px] animate-pulse rounded-xs bg-border-subtle" />
              </div>
              <div className="flex items-center gap-2">
                <div className="size-6 animate-pulse rounded-full bg-border-subtle" />
                <div className="h-[14px] w-20 animate-pulse rounded-xs bg-border-subtle" />
              </div>
              <div className="h-[3px] w-[130px] animate-pulse rounded-full bg-border-subtle" />
              <div className="h-[14px] w-12 animate-pulse rounded-xs bg-border-subtle" />
              <div className="h-5 w-[52px] animate-pulse rounded-sm bg-border-subtle" />
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
        <p className="flex-1 text-meta tabular-nums text-text-tertiary">
          {query.isSuccess ? `${openCount} open` : ''}
        </p>

        <div className="flex h-[var(--control-height-md)] items-center gap-1 rounded-md border border-border-default bg-bg-surface pl-3 pr-2 text-body">
          <span className="text-text-secondary">Status:</span>
          <span className="relative flex items-center">
            <select
              aria-label="Filter jobs by status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="appearance-none bg-transparent pr-5 text-text-primary"
            >
              <option value="">All</option>
              {JOB_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value === 'on_hold' ? 'On hold' : value.charAt(0).toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-0 text-text-secondary" />
          </span>
        </div>

        <Button variant="primary">+ New job</Button>
      </div>

      {query.isPending ? <LoadingSkeleton /> : null}

      {query.isError ? (
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

      {query.isSuccess && jobs.length === 0 && isFiltered ? (
        <Placeholder
          title="No jobs match this filter."
          body="Nothing in the list has that status. Clear the filter to see every job again."
          action={
            <Link href={pathname} className={buttonClass()}>
              Clear filter
            </Link>
          }
        />
      ) : null}

      {query.isSuccess && jobs.length === 0 && !isFiltered ? (
        <Placeholder
          title="No open roles yet."
          body="Create your first job to start a pipeline. Candidates land in Applied as soon as it is live."
          action={<Button variant="primary">+ New job</Button>}
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
