'use client';

/**
 * Review inbox — reference screen 04, spec 007 §7.1.
 *
 * Read-only. "Advance to Screen" and "Reject" render exactly as drawn and do nothing:
 * §4.5 says advancing from the review inbox and dragging on the kanban must call the
 * same service method, and the board already advances through
 * `PATCH /v1/applications/:id/stage`. Wiring these to a mock would create the second
 * code path that rule exists to prevent, written against fixture semantics rather than
 * the real service's version-conflict behaviour.
 *
 * For the same reason `A` and `R` are drawn on the keyboard hint but not bound. Binding
 * them to nothing trains a reflex that will later fire on a real advance.
 */
import type { ReviewQueueItem } from '@talon/contracts';
import { useId, useState } from 'react';
import { useReviewQueue } from '../lib/people-query';
import { Avatar, Button, Eyebrow, cx } from './ui';

const SIGNAL_LABELS = {
  stackMatch: { strong: 'Strong', partial: 'Partial', weak: 'Weak' },
  locationFit: { remote_ok: 'Remote OK', onsite: 'Onsite', relocation: 'Relocation' },
} as const;

/** Success tint for the two signals the design shows in green; neutral otherwise. */
const signalTone = (good: boolean) =>
  good ? 'bg-feedback-success-bg text-feedback-success-fg' : 'bg-bg-surface-sunken text-text-secondary';

function Pill({ children, tone }: { children: string; tone: string }) {
  return <span className={cx('inline-flex items-center rounded-sm px-2 py-px text-caption', tone)}>{children}</span>;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border-subtle bg-bg-surface p-4">
      <Eyebrow className="mb-3">{title}</Eyebrow>
      {children}
    </section>
  );
}

function Detail({ item }: { item: ReviewQueueItem }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-start gap-3 border-b border-border-subtle bg-bg-surface px-6 py-4">
        <Avatar id={item.candidateId} name={item.name} size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-section-title text-text-primary">{item.name}</h2>
          <p className="truncate text-body text-text-secondary">
            {item.currentTitle} at {item.currentCompany} · {item.location} · applied {item.appliedDaysAgo}d ago
          </p>
        </div>
        {/* Focusable despite being inert, so a keyboard user can reach one and be told
            why rather than tabbing past a button they can plainly see (§8). */}
        <Button
          variant="secondary"
          aria-disabled="true"
          title="Advancing needs the real endpoint — see spec 007 §6"
          className="border-border-danger text-action-danger-text"
        >
          Reject <kbd className="rounded-xs border border-border-default px-1 text-caption">R</kbd>
        </Button>
        <Button variant="primary" aria-disabled="true" title="Advancing needs the real endpoint — see spec 007 §6">
          Advance to Screen <kbd className="rounded-xs border border-border-focus px-1 text-caption">A</kbd>
        </Button>
      </header>

      <div className="flex flex-1 gap-4 overflow-y-auto p-6">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/* Omitted, not blank: §10 case 3. */}
          {item.coverNote === null ? null : (
            <Card title="Cover note">
              <p className="text-body-lg text-text-primary">{item.coverNote}</p>
            </Card>
          )}
          {item.resumeHighlights.length === 0 ? null : (
            <Card title="Resume highlights">
              <ul className="flex flex-col gap-2">
                {item.resumeHighlights.map((line) => (
                  <li key={line} className="flex gap-2 text-body-lg text-text-primary">
                    <span aria-hidden="true" className="text-text-tertiary">
                      ·
                    </span>
                    {line}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <aside className="flex w-[var(--layout-detail-rail-width)] shrink-0 flex-col gap-3">
          <Card title="Signal">
            <dl className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-body text-text-primary">Years experience</dt>
                <dd>
                  <Pill tone={signalTone(false)}>{String(item.signal.yearsExperience)}</Pill>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-body text-text-primary">Stack match</dt>
                <dd>
                  <Pill tone={signalTone(item.signal.stackMatch === 'strong')}>
                    {SIGNAL_LABELS.stackMatch[item.signal.stackMatch]}
                  </Pill>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-body text-text-primary">Location</dt>
                <dd>
                  <Pill tone={signalTone(item.signal.locationFit === 'remote_ok')}>
                    {SIGNAL_LABELS.locationFit[item.signal.locationFit]}
                  </Pill>
                </dd>
              </div>
            </dl>
          </Card>
          <p className="px-1 text-caption text-text-tertiary">
            Keyboard: <b className="text-text-secondary">A</b> advance, <b className="text-text-secondary">R</b> reject,
            ↑ ↓ navigate
          </p>
        </aside>
      </div>
    </div>
  );
}

export function ReviewInbox() {
  const query = useReviewQueue();
  const [selected, setSelected] = useState(0);
  const listId = useId();

  const items = query.data?.items ?? [];
  // Clamped rather than trusted: a refetch that returns a shorter queue must not leave
  // the index pointing past the end and render an empty detail pane over live data.
  const index = Math.min(selected, Math.max(items.length - 1, 0));
  const current = items[index];

  if (query.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-body text-text-secondary">The review queue could not be loaded.</p>
        <Button variant="primary" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (query.isPending) {
    return (
      <div className="flex flex-1">
        <div className="w-[var(--layout-review-list-width)] shrink-0 border-r border-border-subtle bg-bg-surface p-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="mb-2 h-[var(--layout-row-height)] animate-pulse rounded-md bg-bg-surface-sunken" />
          ))}
        </div>
        <div className="flex-1" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-body text-text-secondary">Nothing waiting for review.</p>
      </div>
    );
  }

  const move = (delta: number) => setSelected((i) => Math.min(Math.max(i + delta, 0), items.length - 1));

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex w-[var(--layout-review-list-width)] shrink-0 flex-col border-r border-border-subtle bg-bg-surface">
        <div className="border-b border-border-subtle px-4 py-4">
          <p className="text-body-strong text-text-primary">
            Review queue <span className="font-normal text-text-secondary">{query.data.waiting} waiting</span>
          </p>
          {/* No bar at all when nothing is waiting — a full rule reading "0 of 0" is a
              lie about a queue that does not exist (§10 case 1). */}
          {query.data.waiting > 0 ? (
            <div
              className="mt-3 h-[var(--layout-progress-rule-height)] overflow-hidden rounded-full bg-bg-surface-sunken"
              role="img"
              aria-label={`${query.data.reviewedToday} of ${query.data.waiting} reviewed today`}
            >
              <span
                className="block h-full rounded-full bg-action-primary-bg"
                style={{ width: `${(query.data.reviewedToday / query.data.waiting) * 100}%` }}
              />
            </div>
          ) : null}
          <p className="mt-2 text-caption text-text-tertiary">
            {query.data.reviewedToday} of {query.data.waiting} reviewed today
          </p>
        </div>

        {/*
          A roving-tabindex listbox, not a list of buttons: one tab stop for the whole
          queue, arrow keys inside it. Selection follows focus, which is correct here
          because selecting is free — it swaps a read-only pane and commits nothing.
        */}
        <ul
          role="listbox"
          aria-label="Review queue"
          aria-activedescendant={`${listId}-${index}`}
          tabIndex={0}
          className="flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          onKeyDown={(event) => {
            const handled: Record<string, () => void> = {
              ArrowDown: () => move(1),
              ArrowUp: () => move(-1),
              Home: () => setSelected(0),
              End: () => setSelected(items.length - 1),
            };
            const action = handled[event.key];
            if (!action) return;
            event.preventDefault();
            action();
          }}
        >
          {items.map((item, i) => (
            <li
              key={item.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              onClick={() => setSelected(i)}
              className={cx(
                'relative flex h-[var(--layout-row-height)] cursor-pointer items-center gap-3 px-4',
                i === index ? 'bg-bg-selected' : 'hover:bg-action-ghost-bg-hover',
              )}
            >
              {i === index ? (
                <span
                  className="absolute left-0 inset-y-2 w-[var(--layout-nav-marker-width)] rounded-full bg-action-primary-bg"
                  aria-hidden="true"
                />
              ) : null}
              <Avatar id={item.candidateId} name={item.name} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-strong text-text-primary">{item.name}</span>
                <span className="block truncate text-body text-text-secondary">
                  {item.currentTitle} at {item.currentCompany}
                </span>
              </span>
              <span className="shrink-0 text-caption text-text-tertiary">{item.appliedDaysAgo}d</span>
            </li>
          ))}
        </ul>
      </div>

      {current ? <Detail item={current} /> : null}
    </div>
  );
}
