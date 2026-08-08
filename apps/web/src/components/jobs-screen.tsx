'use client';

import { JobStatusSchema, type Job } from '@talon/contracts';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { isOpenJob, useJobs } from '../lib/jobs-query';
import { useJobTemplate } from './app-shell';
import { Avatar, Button, DistributionBar, Eyebrow, Select, StatusPill, buttonClass, cx } from './ui';

/**
 * Not a JobStatus — a stand-in for "no filter" inside the control, because Radix
 * treats "" as "nothing selected" and refuses it as an item value. Kept out of the
 * URL and out of the query by the conversion at the call site.
 */
const ALL_STATUSES = 'all';

const STATUS_OPTIONS = [
  { value: ALL_STATUSES, label: 'All' },
  ...JobStatusSchema.options.map((value) => ({
    value,
    label: value === 'on_hold' ? 'On hold' : value.charAt(0).toUpperCase() + value.slice(1),
  })),
];

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


/* ── Row ───────────────────────────────────────────────────────────────────── */

function JobRow({ job }: { job: Job }) {
  return (
    <li
      className={cx(
        ROW_GRID,
        ROW_HEIGHT,
        // `relative` anchors the stretched hit area below.
        'relative transition-colors duration-[var(--duration-instant)] ease-standard hover:bg-bg-surface-hover',
      )}
    >
      <div className="min-w-0">
        {/*
          One link, on the title, stretched over the whole row with `after:inset-0`.

          The row could have been made clickable with an onClick on the <li>, and
          that is the version that is wrong: it gives the keyboard nothing to land
          on and a screen reader nothing to announce. This way there is exactly one
          tab stop per row, its accessible name is the job title, and middle-click
          and "open in new tab" work because it is a real anchor.

          The job detail screen (M1) does not exist; its board does, and it is what
          someone opening a req actually wants.
        */}
        <Link
          href={`/jobs/${job.id}/pipeline`}
          className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
        >
          <p className="truncate text-card-title text-text-primary">{job.title}</p>
        </Link>
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
  const openJobTemplate = useJobTemplate();

  // The URL is user input. `ListJobsQuery` is `.strict()` and `status` is an enum, so
  // forwarding `?status=bogus` verbatim 400s the real endpoint while the mock merely
  // filters to nothing — a divergence that would first show up in production. An
  // unparseable status is dropped, which is what the control then honestly reads.
  const rawStatus = searchParams.get('status') ?? '';
  const status = JobStatusSchema.safeParse(rawStatus).success ? rawStatus : '';
  const department = (searchParams.get('department') ?? '').trim();
  const isFiltered = Boolean(status || department);

  const query = useJobs({
    status: status || undefined,
    department: department || undefined,
  });

  const jobs = query.data?.data ?? [];
  const openCount = jobs.filter(isOpenJob).length;

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

        <Select
          prefix="Status:"
          ariaLabel="Filter jobs by status"
          // Radix reserves "" to mean "nothing selected", so "All" travels as a
          // sentinel and is converted back here. The URL contract is untouched:
          // "All" is still the absence of `?status=`, not `?status=all`.
          value={status || ALL_STATUSES}
          onValueChange={(next) => setStatus(next === ALL_STATUSES ? '' : next)}
          options={STATUS_OPTIONS}
        />

        {/*
          Screen 02 carries "+ New job" twice — dashed in the sidebar, primary here.
          Both now open the job template modal through the same context callback, which
          is what #5 requires: two entry points, one code path. Spec 003 records that
          this is a stopgap until the wizard on screen 09 exists.
        */}
        <button type="button" onClick={openJobTemplate} className={buttonClass('primary')}>
          + New job
        </button>
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
        The placeholder itself carries no action: the header and the sidebar both
        already offer "+ New job", so a third copy of it here would be the same dead
        end stated three times. The copy still does not name them, because /jobs/new
        is a 404 until the wizard lands (§7.4) and pointing at a dead end in prose is
        worse than letting the button be the thing that discovers it.
      */}
      {hasData && jobs.length === 0 && !isFiltered ? (
        <Placeholder
          title="No open roles yet."
          body="Jobs will appear here once they are created. Candidates land in Applied as soon as a job goes live."
        />
      ) : null}

      {groups.map((group) => (
        <section key={group.department} className="mt-6 first:mt-0">
          <Eyebrow className="pb-2">
            {group.department} · {group.jobs.filter(isOpenJob).length} open
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
