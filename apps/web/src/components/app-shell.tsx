'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_COUNTS } from '../mocks/fixtures';
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
} from './icons';
import { Avatar, Eyebrow, cx } from './ui';

type NavItem = { href: string; label: string; icon: (p: { className?: string }) => React.JSX.Element; count?: number };

const SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Recruit',
    items: [
      { href: '/jobs', label: 'Jobs', icon: BriefcaseIcon, count: NAV_COUNTS.jobs },
      { href: '/pipeline', label: 'Pipeline', icon: BoardIcon, count: NAV_COUNTS.pipeline },
      { href: '/review-inbox', label: 'Review inbox', icon: InboxIcon, count: NAV_COUNTS.reviewInbox },
      { href: '/candidates', label: 'Candidates', icon: PersonIcon },
    ],
  },
  {
    label: 'Coordinate',
    items: [
      { href: '/scheduling', label: 'Scheduling', icon: CalendarIcon, count: NAV_COUNTS.scheduling },
      { href: '/offers', label: 'Offers', icon: DocumentIcon, count: NAV_COUNTS.offers },
    ],
  },
  { label: 'Insights', items: [{ href: '/reports', label: 'Reports', icon: ChartIcon }] },
];

// No session yet — step 4 owns authentication. Values match the reference screen.
const SIGNED_IN_USER = { id: '0198f3a1-0007-7000-8000-000000000001', name: 'Maya Reyes', title: 'Recruiting lead' };

function NavRow({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'relative flex h-8 items-center gap-3 rounded-md pl-3 pr-2 text-body',
          'transition-colors duration-[var(--duration-instant)] ease-standard',
          active ? 'bg-bg-selected text-text-link' : 'text-text-secondary hover:bg-action-ghost-bg-hover',
        )}
      >
        {/* 2px indigo left marker on the active row (DESIGN_SYSTEM §4). */}
        {active ? <span className="absolute left-0 inset-y-1 w-[2px] rounded-full bg-action-primary-bg" aria-hidden="true" /> : null}
        <Icon className={active ? 'text-text-link' : 'text-text-tertiary'} />
        <span className="flex-1">{item.label}</span>
        {item.count === undefined ? null : (
          <span className={cx('rounded-full px-2 text-caption tabular-nums', active ? 'bg-bg-selected text-text-link' : 'text-text-tertiary')}>
            {item.count}
          </span>
        )}
      </Link>
    </li>
  );
}

function Sidebar() {
  const pathname = usePathname();
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
          <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="text-text-on-primary"
          >
            <path d="M13 6v5.5c0 2.6-1.3 4.8-6 5.25" />
            <path d="M13.6 13.4 17.4 16.9" opacity="0.5" />
          </svg>
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
                <NavRow key={item.href} item={item} active={pathname === item.href} />
              ))}
            </ul>
          </div>
        ))}

        <Link
          href="/jobs/new"
          className={cx(
            'mt-6 flex h-[var(--control-height-md)] items-center justify-center rounded-md',
            'border border-dashed border-border-strong text-body text-text-secondary',
            'transition-colors duration-[var(--duration-instant)] ease-standard hover:bg-action-ghost-bg-hover',
          )}
        >
          + New job
        </Link>
      </nav>

      <div className="flex items-center gap-3 border-t border-border-subtle px-4 py-3">
        <Avatar id={SIGNED_IN_USER.id} name={SIGNED_IN_USER.name} size={32} />
        <span className="flex-1 leading-tight">
          <span className="block text-body-strong text-text-primary">{SIGNED_IN_USER.name}</span>
          <span className="block text-meta text-text-tertiary">{SIGNED_IN_USER.title}</span>
        </span>
        <button
          type="button"
          aria-label="Sign out"
          className="grid size-6 place-items-center rounded-md text-text-tertiary hover:bg-action-ghost-bg-hover hover:text-text-secondary"
        >
          <SignOutIcon />
        </button>
      </div>
    </div>
  );
}

const NAV_ITEMS = SECTIONS.flatMap((section) => section.items);

function Topbar() {
  const pathname = usePathname();
  // Breadcrumb per DESIGN_SYSTEM §4: the trail sits at `meta`, the current page at
  // `bodyStrong`. Only one level exists so far, so only the current page renders.
  const title = NAV_ITEMS.find((item) => item.href === pathname)?.label ?? 'Talon';
  return (
    <header className="flex h-[var(--layout-topbar-height)] shrink-0 items-center gap-4 border-b border-border-default bg-bg-surface px-6">
      <p className="flex-1 text-meta text-text-tertiary">
        <span className="text-body-strong text-text-primary">{title}</span>
      </p>
      {/*
        ponytail: the search field and the bell are pictures, not controls — the ⌘K
        palette and the notification feed are M1. They are aria-hidden rather than
        focusable so the keyboard path never lands on something that does nothing.
      */}
      <div aria-hidden="true" className="flex items-center gap-3">
        <span className="flex h-[var(--control-height-md)] w-[290px] items-center gap-2 rounded-md border border-border-default px-3 text-body text-text-placeholder">
          <SearchIcon className="text-text-placeholder" />
          Search candidates, jobs
        </span>
        <span className="relative grid size-[var(--control-height-md)] place-items-center rounded-md border border-border-default text-text-secondary">
          <BellIcon />
          {/* DESIGN_SYSTEM §4 names `red.500`; `text.danger` is the semantic token
              holding that exact value, so the component never touches the ramp. */}
          <span className="absolute right-2 top-2 size-[6px] rounded-full bg-text-danger" />
        </span>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-screen grid-cols-[var(--layout-sidebar-width)_minmax(0,1fr)]">
      <Sidebar />
      <div className="flex min-w-0 flex-col">
        <Topbar />
        <main id="main" className="flex-1 overflow-y-auto p-[var(--layout-page-gutter)]">
          {children}
        </main>
      </div>
    </div>
  );
}
