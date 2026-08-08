'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { isOpenJob, useJobs } from '../lib/jobs-query';
import { useSession } from '../lib/session';
import {
  BellIcon,
  BoardIcon,
  BriefcaseIcon,
  CalendarIcon,
  ChartIcon,
  DocumentIcon,
  InboxIcon,
  PersonIcon,
  SearchIcon,
  SignOutIcon,
  TalonMark,
} from './icons';
import { createContext, useCallback, useContext, useState } from 'react';
import { JobTemplateModal } from './job-template-modal';
import { Avatar, Eyebrow, cx } from './ui';

/*
  Both "+ New job" triggers have to open one modal (#5, one path per action). The
  sidebar's lives in Sidebar, the jobs header's lives in JobsScreen, and the two meet
  only as `children` through (app)/layout.tsx — so there is no props path between them.
  This context is the smallest join. Spec 003 records the alternative (`?new=1` in the
  URL, which would also give back-button dismissal) and why it was not taken: reading
  useSearchParams in a layout forces a Suspense boundary, which is a structural change
  to the layout for a component the wizard is going to delete.
*/
const JobTemplateContext = createContext<() => void>(() => {});

export const useJobTemplate = () => useContext(JobTemplateContext);

type NavItem = { href: string; label: string; icon: (p: { className?: string }) => React.JSX.Element };

/**
 * Nav shape only. No counts live here.
 *
 * The reference screen shows 6 / 9 / 4 / 4 / 1 beside these rows, and every one of
 * those except Jobs had been a literal in this file — a number that looked like
 * data, was read as data, and answered to nothing. Jobs now comes from the jobs
 * query; the rest render no badge at all until an endpoint can supply one. A
 * missing count is honest, a stale invented one is not (spec §11 open question 7:
 * these are tenant-wide and cannot ride the jobs envelope).
 */
const SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Recruit',
    items: [
      { href: '/jobs', label: 'Jobs', icon: BriefcaseIcon },
      { href: '/pipeline', label: 'Pipeline', icon: BoardIcon },
      { href: '/review-inbox', label: 'Review inbox', icon: InboxIcon },
      { href: '/candidates', label: 'Candidates', icon: PersonIcon },
    ],
  },
  {
    label: 'Coordinate',
    items: [
      { href: '/scheduling', label: 'Scheduling', icon: CalendarIcon },
      { href: '/offers', label: 'Offers', icon: DocumentIcon },
    ],
  },
  { label: 'Insights', items: [{ href: '/reports', label: 'Reports', icon: ChartIcon }] },
];

/**
 * Nav targets that have a page behind them. `/pipeline` is deliberately absent: it is
 * the highlight key for `/jobs/:id/pipeline` (see JOB_PIPELINE below), not a URL you
 * can navigate to. Rendering it as a link 404s the sidebar's own menu item.
 *
 * ponytail: a literal set, not a filesystem scan. Grows by one line per screen shipped;
 * if it ever drifts, the route-existence E2E is the place to catch it.
 */
const BUILT = new Set(['/jobs', '/review-inbox', '/candidates', '/offers', '/reports']);

function NavRow({ item, active, count }: { item: NavItem; active: boolean; count?: number | undefined }) {
  const Icon = item.icon;
  const built = BUILT.has(item.href);
  const className = cx(
    'relative flex h-8 items-center gap-3 rounded-md pl-3 pr-2 text-body',
    'transition-colors duration-[var(--duration-instant)] ease-standard',
    active ? 'bg-bg-selected text-text-link' : 'text-text-secondary hover:bg-action-ghost-bg-hover',
    built ? '' : 'cursor-default text-text-tertiary hover:bg-transparent',
  );
  const content = (
    <>
      {/* 2px indigo left marker on the active row (DESIGN_SYSTEM §4). */}
      {active ? (
        <span className="absolute left-0 inset-y-1 w-[var(--layout-nav-marker-width)] rounded-full bg-action-primary-bg" aria-hidden="true" />
      ) : null}
      <Icon className={active ? 'text-text-link' : 'text-text-tertiary'} />
      <span className="flex-1">{item.label}</span>
      {count === undefined ? null : (
        <span className={cx('rounded-full px-2 text-caption tabular-nums', active ? 'bg-bg-selected text-text-link' : 'text-text-tertiary')}>
          {count}
        </span>
      )}
    </>
  );

  // Unbuilt rows stay visible — the reference screens show the whole menu — but are not
  // links: not focusable, not clickable, and announced as disabled rather than as a
  // destination that answers 404.
  return (
    <li>
      {built ? (
        <Link href={item.href} aria-current={active ? 'page' : undefined} className={className}>
          {content}
        </Link>
      ) : (
        <span aria-disabled="true" aria-current={active ? 'page' : undefined} className={className}>
          {content}
        </span>
      )}
    </li>
  );
}

/** `hiring_manager` → `Hiring manager`. The role is the only title the API has. */
const roleLabel = (role: string) => {
  const words = role.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * Ends the session and leaves.
 *
 * Three things have to happen and the order is not arbitrary. The route handler
 * clears the httpOnly refresh cookie — the browser cannot, which is the point of
 * it being httpOnly. `signOut` then drops the in-memory access token. Only then is
 * the query cache cleared: it holds this tenant's jobs, and without this the next
 * person to sign in on the same tab is served the previous one's rows from cache
 * before their own request resolves. Hiding that behind a fresh fetch would be a
 * cross-tenant read that happened to be brief (§4.1).
 *
 * `replace`, not `push`: Back must not return to an authenticated screen.
 */
function SignOutButton() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { signOut } = useSession();
  const [leaving, setLeaving] = useState(false);

  return (
    <button
      type="button"
      // Icon-only, so the accessible name is the label. 24px is the whole button,
      // not a wrapper around a smaller one — the target is the control itself.
      aria-label="Sign out"
      disabled={leaving}
      onClick={async () => {
        setLeaving(true);
        // signOut swallows a failed request on purpose: a session the server
        // already forgot must still end here, or the user is stuck signed in to
        // a token nothing will honour.
        await signOut();
        queryClient.clear();
        router.replace('/sign-in');
      }}
      className={cx(
        'grid size-6 place-items-center rounded-md text-text-tertiary',
        'transition-colors duration-[var(--duration-instant)] ease-standard',
        'hover:bg-action-ghost-bg-hover hover:text-text-secondary',
        'disabled:cursor-not-allowed disabled:text-action-disabled-text',
      )}
    >
      <SignOutIcon />
    </button>
  );
}

/**
 * A job's board lives at `/jobs/:id/pipeline` but belongs to Pipeline in the nav. The
 * reference shows exactly that split — the sidebar lights Pipeline while the breadcrumb
 * sits under Jobs — so a longest-prefix match would light the wrong row.
 */
const JOB_PIPELINE = /^\/jobs\/[^/]+\/pipeline$/;

/** Same split for a loop: the URL is `/scheduling/:loopId`, the nav row is Scheduling. */
const SCHEDULING_LOOP = /^\/scheduling\/[^/]+$/;

function Sidebar() {
  const pathname = usePathname();
  const activeHref = JOB_PIPELINE.test(pathname)
    ? '/pipeline'
    : SCHEDULING_LOOP.test(pathname)
      ? '/scheduling'
      : pathname;
  const { session } = useSession();

  // A tenant-wide count, so it is deliberately the UNFILTERED query. React Query
  // dedupes it with the jobs screen only while that screen is also unfiltered; on
  // /jobs?status=on_hold the keys differ and this is a second request. That is the
  // cost of the badge meaning "jobs in this tenant" rather than "rows below", and
  // it is why the earlier claim that this always shared the cache was wrong.
  //
  // It counts what the header counts — open jobs — so the two cannot disagree
  // once a job is closed.
  const jobs = useJobs({});
  const countFor = (href: string): number | undefined =>
    href === '/jobs' ? jobs.data?.data.filter(isOpenJob).length : undefined;

  return (
    <div className="flex h-full flex-col border-r border-border-default bg-bg-surface">
      <div className="flex h-[var(--layout-topbar-height)] items-center gap-2 px-4">
        {/*
          The talon. Traced off 02-jobs-list@2x.png at native resolution: a 24px
          squircle tile, and inside it a shank descending from y=5 that sweeps
          down-left to (7.3, 17.5), plus a shorter outer toe at half strength.
          The half-strength toe is the whole trick — it reads as depth rather than
          as a third line, and dropping it flattens the mark into a chevron.
        */}
        <span className="flex size-6 items-center justify-center rounded-sm bg-action-primary-bg" aria-hidden="true">
          <TalonMark className="size-6 text-text-on-primary" />
        </span>
        <span className="flex-1 text-section-title font-display text-text-primary">Talon</span>
        {/* Presentational until the command palette ships — see the topbar search. */}
        <span aria-hidden="true" className="rounded-xs bg-bg-canvas px-1 py-px font-mono text-code text-text-tertiary">
          ⌘K
        </span>
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 pb-4">
        {SECTIONS.map((section) => (
          <div key={section.label} className="mt-5 first:mt-2">
            <Eyebrow className="px-3 pb-2">{section.label}</Eyebrow>
            <ul>
              {section.items.map((item) => (
                <NavRow key={item.href} item={item} active={activeHref === item.href} count={countFor(item.href)} />
              ))}
            </ul>
          </div>
        ))}

        {/*
          A Link now, not a button. This opened the JD template modal while
          /jobs/new did not exist; the wizard is real and POST /v1/jobs answers,
          so "+ New job" means what it says.

          The template modal is still reachable — it is a copy-the-JD-text tool,
          not a creation path, and conflating the two put two intents behind one
          control (#5).
        */}
        <Link
          href="/jobs/new"
          className={cx(
            'mt-6 flex h-[var(--control-height-md)] w-full items-center justify-center rounded-md',
            'border border-dashed border-border-strong text-body text-text-secondary',
            'transition-colors duration-[var(--duration-instant)] ease-standard hover:bg-action-ghost-bg-hover',
          )}
        >
          + New job
        </Link>
      </nav>

      {/*
        The signed-in user, from the session rather than a constant. This block used
        to hardcode "Maya Reyes / Recruiting lead" — which happened to match the
        reference screenshot and would have kept saying Maya whoever signed in.
        "Recruiting lead" is gone with it: the API carries a role, not a job title.
      */}
      <div className="flex items-center gap-3 border-t border-border-subtle px-4 py-3">
        {session ? <Avatar id={session.user.id} name={session.user.name} size={32} /> : null}
        <span className="flex-1 leading-tight">
          <span className="block text-body-strong text-text-primary">{session?.user.name ?? ''}</span>
          <span className="block text-meta text-text-tertiary">
            {session ? roleLabel(session.user.role) : ''}
          </span>
        </span>
        {/*
          A real control now that step 4 has shipped a session to end. It renders
          only when there is one: with no session there is nothing to sign out of,
          and the disabled-or-absent call is the same one the topbar search gets.
        */}
        {session ? <SignOutButton /> : null}
      </div>
    </div>
  );
}

const NAV_ITEMS = SECTIONS.flatMap((section) => section.items);

function Topbar() {
  const pathname = usePathname();
  // Breadcrumb per DESIGN_SYSTEM §4: the trail sits at `meta`, the current page at
  // `bodyStrong`. Only one level exists so far, so only the current page renders.
  const onJobPipeline = JOB_PIPELINE.test(pathname);
  const onLoop = SCHEDULING_LOOP.test(pathname);
  const title = onJobPipeline
    ? 'Pipeline'
    : onLoop
      ? 'Schedule onsite loop'
      : (NAV_ITEMS.find((item) => item.href === pathname)?.label ?? 'Talon');
  return (
    <header className="flex h-[var(--layout-topbar-height)] shrink-0 items-center gap-4 border-b border-border-default bg-bg-surface px-6">
      {/*
        The reference trail reads "Jobs / Senior Product Engineer". The shell has no way
        to know the job's title — it would need the board's response, which is fetched a
        component away — so the trail names the section and the job title sits in the
        page header immediately below, where the reference also puts it. A shell-level
        breadcrumb that nested routes can fill is spec 003 §9; not worth a context for
        one screen.
      */}
      <p className="flex-1 text-meta text-text-tertiary">
        {onJobPipeline ? <Link href="/jobs" className="hover:text-text-link">Jobs</Link> : null}
        {onJobPipeline ? ' / ' : null}
        {/* The reference reads "Ana Petrova / Schedule onsite loop". The shell cannot
            know the candidate — that is in the loop response, a component away — so the
            trail names the section and the candidate sits at the top of the left pane,
            where the reference also puts her. Same trade as the job pipeline above.

            Text, not a link: there is no `/scheduling` index page yet, and a breadcrumb
            that 404s is worse than one that only names where you are (#25). It becomes a
            Link in the PR that adds the page, next to "Jobs" above, which has one. */}
        {onLoop ? <span>Scheduling</span> : null}
        {onLoop ? ' / ' : null}
        <span className="text-body-strong text-text-primary">{title}</span>
      </p>
      {/*
        ponytail: the search field and the bell are pictures, not controls — the ⌘K
        palette and the notification feed are M1. They are aria-hidden rather than
        focusable so the keyboard path never lands on something that does nothing.
      */}
      <div aria-hidden="true" className="flex items-center gap-3">
        <span className="flex h-[var(--control-height-md)] w-[var(--layout-search-field-width)] items-center gap-2 rounded-md border border-border-default px-3 text-body text-text-placeholder">
          <SearchIcon className="text-text-placeholder" />
          Search candidates, jobs
        </span>
        <span className="relative grid size-[var(--control-height-md)] place-items-center rounded-md border border-border-default text-text-secondary">
          <BellIcon />
          {/* DESIGN_SYSTEM §4 names `red.500`; `text.danger` is the semantic token
              holding that exact value, so the component never touches the ramp. */}
          <span className="absolute right-2 top-2 size-[var(--layout-notification-dot-size)] rounded-full bg-text-danger" />
        </span>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [templateOpen, setTemplateOpen] = useState(false);
  const open = useCallback(() => setTemplateOpen(true), []);
  const close = useCallback(() => setTemplateOpen(false), []);

  return (
    <JobTemplateContext.Provider value={open}>
      <div className="grid h-screen grid-cols-[var(--layout-sidebar-width)_minmax(0,1fr)]">
        <Sidebar />
        <div className="flex min-w-0 flex-col">
          <Topbar />
          <main id="main" className="flex-1 overflow-y-auto p-[var(--layout-page-gutter)]">
            {children}
          </main>
        </div>
      </div>
      {/* Rendered once, here, so both triggers address the same instance. */}
      <JobTemplateModal open={templateOpen} onClose={close} />
    </JobTemplateContext.Provider>
  );
}
