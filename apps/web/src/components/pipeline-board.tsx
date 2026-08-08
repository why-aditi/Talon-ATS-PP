'use client';

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { TOKENS } from '@talon/tokens';
import { hasScope } from '@talon/domain';
import { MoveFailure, useBoard, useMoveStage, useReorder, type MoveInput } from '../lib/board-query';
import { useJob } from '../lib/jobs-query';
import { useSession } from '../lib/session';
import { EditJobModal } from './edit-job-modal';
import { boardCoordinateGetter, locate, neighboursFor, prefersReducedMotion } from '../lib/board-state';
import { SOURCE_LABELS } from '../lib/labels';
import { CardBody } from './pipeline-card';
import { SourceSchema, type ApplicationCard, type Board, type BoardColumn } from '@talon/contracts';
import { ChevronDownIcon, SearchIcon } from './icons';
import { PipelineColumn } from './pipeline-column';
import { Button, StatusPill, buttonClass, cx } from './ui';

/** URL `?state=` → the mock scenario that produces it. Filtered-empty needs no entry:
 *  a filter that matches nothing is reachable for real. */
const STATE_SCENARIOS: Record<string, string> = {
  loading: 'slow',
  empty: 'empty',
  error: 'error',
  forbidden: 'forbidden',
  conflict: 'conflict-version',
  moved: 'conflict-stage',
};

/**
 * A sort and a hand-arranged column are mutually exclusive, and pretending otherwise
 * is what made the first version of this screen lie: the sort ran on every render, so
 * a drag-reorder was spliced in optimistically, confirmed by the server, and then
 * immediately sorted back out. The PATCH fired and the board snapped back.
 *
 * `manual` is therefore the board's own order — `board_rank` as the server returns it
 * — and is the only sort under which reordering within a column means anything. Any
 * other sort refuses a within-column drop and says why, rather than accepting it and
 * discarding it. Cross-stage moves are unaffected: they are a stage change, not a
 * position.
 */
const SORTS = {
  // Default per the reference, which reads "sort: time in stage" and shows every
  // column in descending dwell.
  time: { label: 'time in stage', compare: (a: ApplicationCard, b: ApplicationCard) => b.daysInStage - a.daysInStage },
  recent: { label: 'recency', compare: (a: ApplicationCard, b: ApplicationCard) => a.daysInStage - b.daysInStage },
  // No `score` sort: `scoreAvg` left the contract with the scorecards table it never
  // had. Offering a sort over a field the server does not send would order every
  // column identically and look broken rather than absent.
  manual: { label: 'manual', compare: null },
} as const;

type SortKey = keyof typeof SORTS;
const isSortKey = (value: string): value is SortKey => value in SORTS;

type Filters = { q: string; stage: string; source: string; recruiter: string; sort: SortKey };

function applyFilters(columns: BoardColumn[], filters: Filters): BoardColumn[] {
  const q = filters.q.trim().toLowerCase();
  return columns.map((column) => {
    let cards = column.cards;
    if (q) {
      cards = cards.filter((card) =>
        `${card.name} ${card.currentTitle} ${card.currentCompany}`.toLowerCase().includes(q),
      );
    }
    if (filters.stage) cards = cards.filter(() => column.canonical === filters.stage);
    if (filters.source) cards = cards.filter((card) => card.source === filters.source);
    // No recruiter filter: the recruiter belongs to the JOB, and this board is scoped
    // to one job, so the control could only ever match everything or nothing. It is
    // rendered disabled rather than applied (see `FilterSelect` below).
    // Sorting is per column: the board has no single ordered list, and sorting across
    // columns would be sorting something the user cannot see.
    const compare = SORTS[filters.sort].compare;
    // Copied before sorting — `cards` is still the query cache's array when no filter
    // narrowed it, and sorting in place would mutate cached data. `manual` keeps the
    // server's order untouched.
    const ordered = compare ? [...cards].sort(compare) : cards;
    return { ...column, cards: ordered, count: ordered.length };
  });
}

/* ── Chrome ────────────────────────────────────────────────────────────────── */

/** Pictured but not built. Disabled rather than focusable-and-inert, so the keyboard
 *  path never lands on something that does nothing (spec 003 §6.8). */
function DisabledTab({ label, count }: { label: string; count?: number }) {
  return (
    <button
      type="button"
      disabled
      className="flex items-center gap-2 border-b-2 border-b-transparent pb-3 text-body text-action-disabled-text"
    >
      {label}
      {count === undefined ? null : <span className="tabular-nums">{count}</span>}
    </button>
  );
}

function JobHeader({ job, total }: { job: Board['job']; total: number }) {
  const [editing, setEditing] = useState(false);
  // Fetched only once the editor is asked for: the board's BoardJob has no
  // department, no band and no `version`, and a board load should not pay for a
  // dialog most visits never open.
  const full = useJob(job.id, editing);
  const { session } = useSession();
  const canReadComp = session ? hasScope(session.user.role, 'comp:read') : false;

  return (
    <div>
      <div className="flex items-center gap-3">
        {/* `sectionTitle`, not `pageTitle` — the token's own description names this
            exact string ("'Senior Product Engineer' detail header"). A job's board is a
            detail view under Jobs, not a top-level page. */}
        <h1 className="font-display text-section-title text-text-primary">{job.title}</h1>
        <StatusPill status={job.status} />
        <span className="font-mono text-code text-text-tertiary">{job.reqCode}</span>
        {/* Plain text, no avatar — the reference names the recruiter here without one,
            and the sidebar already carries her face. */}
        <span className="flex-1 text-body text-text-secondary">
          {job.location}
          {job.recruiter ? ` · ${job.recruiter.name}` : ''}
        </span>
        <Button onClick={() => setEditing(true)} disabled={editing && full.isPending}>
          {editing && full.isPending ? 'Opening…' : 'Edit job'}
        </Button>
        {/*
          Still disabled, and the title says why rather than leaving it a mystery.
          POST /v1/applications does not exist (spec 005 §12 step 4), and a button
          that opens a form which cannot submit is the same mistake as a link to a
          page that errors — just with more typing in between.
        */}
        <Button variant="primary" disabled title="Adding candidates needs POST /v1/applications — spec 005 §12">
          + Add candidate
        </Button>
      </div>

      {editing && full.data ? (
        <EditJobModal job={full.data} canReadComp={canReadComp} onClose={() => setEditing(false)} />
      ) : null}

      <div className="mt-4 flex items-center gap-6 border-b border-border-default">
        <span
          aria-current="page"
          className="border-b-2 border-b-action-primary-bg pb-3 text-body-strong text-text-primary"
        >
          Pipeline
        </span>
        <DisabledTab label="Candidates" count={total} />
        <DisabledTab label="Job details" />
        <DisabledTab label="Hiring team" />
      </div>
    </div>
  );
}

/** A select styled as the reference's inline "Label Value ⌄" control. The height lives
 *  on the select itself, not the wrapper — a wrapper-sized control leaves the real hit
 *  target at the ~20px line box, under the 24×24 minimum. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="flex h-[var(--control-height-md)] items-center gap-1 rounded-md border border-border-default bg-bg-surface pl-3 pr-2 text-body">
      <span className="pointer-events-none text-text-secondary">{label}</span>
      <span className="relative flex h-full items-center">
        <select
          aria-label={`Filter candidates by ${label.toLowerCase()}`}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cx('h-full appearance-none bg-transparent', disabled ? 'text-action-disabled-text' : 'text-text-primary', 'pr-5')}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-0 text-text-secondary" />
      </span>
    </div>
  );
}

function Placeholder({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border-default bg-bg-surface px-6 py-12 text-center">
      <p className="text-body-strong text-text-primary">{title}</p>
      <p className="max-w-md text-body text-text-secondary">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Skeleton cards are built from the same padding, gaps and type as a real card rather
 *  than pinned to a measured height, so the two cannot drift apart and nothing shifts
 *  when data lands. */
function LoadingSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading pipeline" className="flex gap-[var(--layout-kanban-column-gap)]">
      {[0, 1, 2, 3, 4].map((column) => (
        <div
          key={column}
          className="flex w-[var(--layout-kanban-column-width)] shrink-0 flex-col rounded-lg bg-bg-surface-sunken p-3"
        >
          <div className="flex items-center gap-2">
            <span className="size-[var(--layout-stage-dot-size)] rounded-xs bg-border-subtle" />
            <span className="h-4 w-20 animate-pulse rounded-xs bg-border-subtle" />
          </div>
          <span className="mt-2 h-[var(--layout-progress-rule-height)] w-full rounded-full bg-border-subtle" />
          <span className="mt-2 h-3 w-16 animate-pulse rounded-xs bg-border-subtle" />
          <div className="mt-3 flex flex-col gap-[var(--layout-kanban-card-gap)]">
            {[0, 1].map((card) => (
              <div key={card} className="rounded-md border border-border-default bg-bg-surface p-3">
                <div className="flex items-start gap-2">
                  <span className="size-6 shrink-0 animate-pulse rounded-full bg-border-subtle" />
                  <div className="flex-1 space-y-2">
                    <span className="block h-4 w-2/3 animate-pulse rounded-xs bg-border-subtle" />
                    <span className="block h-3 w-full animate-pulse rounded-xs bg-border-subtle" />
                  </div>
                </div>
                <div className="mt-2 flex gap-1">
                  <span className="h-5 w-16 animate-pulse rounded-xs bg-border-subtle" />
                  <span className="h-5 w-12 animate-pulse rounded-xs bg-border-subtle" />
                </div>
                <span className="mt-3 block h-3 w-1/2 animate-pulse rounded-xs bg-border-subtle" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Screen ────────────────────────────────────────────────────────────────── */

export function PipelineBoard({ jobId }: { jobId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = searchParams.get('state') ?? '';
  const rawSort = searchParams.get('sort') ?? '';
  const filters: Filters = {
    q: searchParams.get('q') ?? '',
    // The URL is user input: an unparseable stage or source is dropped rather than
    // forwarded, so the control reads honestly instead of filtering to nothing.
    stage: searchParams.get('stage') ?? '',
    source: SourceSchema.safeParse(searchParams.get('source')).success ? (searchParams.get('source') as string) : '',
    recruiter: searchParams.get('recruiter') ?? '',
    sort: isSortKey(rawSort) ? rawSort : 'time',
  };

  const query = useBoard(jobId, STATE_SCENARIOS[state]);
  const board = query.data;

  // The rendered view. Declared here because the drag handlers and the announcements
  // both read it: the drop happened on what the user could see, not on the raw cache.
  const columns = board ? applyFilters(board.columns, filters) : [];
  /** Only `manual` leaves the server's order alone, so only `manual` can be rearranged. */
  const manualOrder = filters.sort === 'manual';

  /**
   * Read from the token map, never copied as literals. These are `motion.duration.base`
   * and `motion.easing.spring` (DESIGN_SYSTEM §4) — and because a dropAnimation is a JS
   * prop rather than a className, `token-usage.test.ts` structurally cannot catch a
   * hard-coded value here. Reading TOKENS is what keeps it honest.
   */
  const dropAnimation = prefersReducedMotion()
    ? null
    : { duration: Number.parseInt(TOKENS['--duration-base'], 10), easing: TOKENS['--ease-spring'] };

  const scenario = STATE_SCENARIOS[state];
  const moveStage = useMoveStage(jobId, scenario);
  const reorder = useReorder(jobId, scenario);
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    // A small distance threshold so a click on a card is not read as a drag. Without it
    // every future click target on a card — the detail drawer especially — becomes a
    // one-pixel drag instead.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: boardCoordinateGetter }),
  );

  const [refocus, setRefocus] = useState<string | null>(null);

  // Guarded on `refocus` so an ordinary refetch never steals focus from wherever the
  // user actually is. Deferred a frame because dnd-kit restores focus to the node it
  // lifted on the next frame — and that node no longer exists once the card has
  // changed columns, so running first means the restore silently wins and the keyboard
  // ends up on the document.
  useEffect(() => {
    if (!refocus) return;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-card-id="${refocus}"]`)?.focus();
      // Stays armed until the write has settled AND the refetch has landed. The
      // optimistic render and the confirmed one each replace the card's node, and a
      // node that is replaced while focused drops focus to <body> — so focus has to be
      // re-asserted on both, not just the first.
      if (!query.isFetching && !moveStage.isPending && !reorder.isPending) setRefocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [refocus, board, query.isFetching, moveStage.isPending, reorder.isPending]);


  /**
   * Resolves whatever dnd-kit reports being over — a column or a card — to a column.
   *
   * Reads the RENDERED columns, not `board.columns`. The drop happened on what the
   * user could see, which is the filtered and sorted array; resolving against the raw
   * cache would compute `over.cardIndex` and the movingDown branch against indices
   * that need not match what was on screen.
   */
  function resolveTarget(overId: string) {
    const column = columns.find((c) => c.stageId === overId);
    if (column) return { column, over: null };
    const over = locate(columns, overId);
    return over ? { column: over.column, over } : null;
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || !board) return;
    // dnd-kit restores focus to the node it lifted, but React replaces that node when
    // the columns re-render, so focus lands on the document and the next Tab restarts
    // at the top of the page. Dropping a card must leave the keyboard where the card
    // is — refocused by id below, once the new node exists.
    setRefocus(String(active.id));

    const from = locate(columns, String(active.id));
    const target = resolveTarget(String(over.id));
    if (!from || !target) return;
    // Terminal columns are reachable droppables that refuse — this is the refusal.
    if (target.column.isTerminal || from.column.isTerminal) return;

    const { beforeId, afterId, index } = neighboursFor(from, target.column, target.over);
    const sameColumn = from.column.stageId === target.column.stageId;

    // Dropped where it started. No write, no request — Space-Space is the natural
    // "never mind" for a keyboard user and must not relocate anything.
    if (sameColumn && index === from.cardIndex) return;
    // A hand-arranged position is meaningless while a sort is deciding the order, so
    // the drop is refused rather than accepted and silently sorted away.
    if (sameColumn && !manualOrder) return;

    const input: MoveInput = {
      card: from.card,
      fromStageId: from.column.stageId,
      toStageId: target.column.stageId,
      beforeId,
      afterId,
    };
    // Two routes, chosen here and nowhere else. A reorder must never reach the write
    // that bumps `version` (non-negotiable #18).
    if (sameColumn) reorder.mutate(input);
    else moveStage.mutate(input);
  }

  /**
   * dnd-kit already mounts a live region; these replace its default copy rather than
   * adding a second one. Two regions would announce every move twice, which is the
   * kind of bug that is invisible unless you actually listen to it.
   */
  const announcements: Announcements = {
    onDragStart({ active }) {
      const from = locate(columns, String(active.id));
      if (!from) return;
      return `Picked up ${from.card.name} from ${from.column.name}, position ${from.cardIndex + 1} of ${from.column.cards.length}.`;
    },
    onDragOver({ active, over }) {
      if (!over) return;
      const from = locate(columns, String(active.id));
      const target = resolveTarget(String(over.id));
      if (!from || !target) return;
      if (target.column.isTerminal) {
        return `${target.column.name} is not available — moving there needs a reason.`;
      }
      const { index } = neighboursFor(from, target.column, target.over);
      const sameColumn = target.column.stageId === from.column.stageId;

      // Nothing is mutated during a drag, so `from` still reports where the card
      // started. dnd-kit fires onDragOver immediately after onDragStart, and without
      // this the "Picked up…" message is overwritten within the same tick by a move
      // that never happened — the user never hears that they picked anything up.
      if (sameColumn && index === from.cardIndex) return;
      if (sameColumn && !manualOrder) {
        return `Reordering ${from.column.name} needs sort: manual. The board is sorted by ${SORTS[filters.sort].label}.`;
      }

      const total = target.column.cards.filter((c) => c.id !== from.card.id).length + 1;
      return `${from.card.name} moved to ${target.column.name}, position ${index + 1} of ${total}.`;
    },
    onDragEnd({ active, over }) {
      if (!over) return 'Move cancelled.';
      const from = locate(columns, String(active.id));
      const target = resolveTarget(String(over.id));
      if (!from || !target) return 'Move cancelled.';
      if (target.column.isTerminal) return `${from.card.name} was not moved. ${target.column.name} needs a reason.`;

      const { index } = neighboursFor(from, target.column, target.over);
      const sameColumn = target.column.stageId === from.column.stageId;
      if (sameColumn && index === from.cardIndex) return `${from.card.name} stayed in ${from.column.name}.`;
      if (sameColumn && !manualOrder) return `${from.card.name} was not moved. Reordering needs sort: manual.`;

      const total = target.column.cards.filter((c) => c.id !== from.card.id).length + 1;
      // Position included: "dropped into Offer" alone leaves a keyboard user with no
      // idea where the card landed (spec 003 §6.7).
      return `${from.card.name} dropped into ${target.column.name}, position ${index + 1} of ${total}.`;
    },
    onDragCancel({ active }) {
      const from = locate(columns, String(active.id));
      return from ? `Move cancelled. ${from.card.name} returned to ${from.column.name}.` : 'Move cancelled.';
    },
  };

  function setParam(key: string, next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set(key, next);
    else params.delete(key);
    router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false });
  }

  const hasData = board !== undefined;
  const loadFailed = query.isError && !hasData;

  const shown = columns.reduce((sum, column) => sum + column.cards.length, 0);
  const total = board ? board.columns.reduce((sum, column) => sum + column.cards.length, 0) : 0;
  const isFiltered = Boolean(filters.q || filters.stage || filters.source);

  const activeDrag = activeId && board ? locate(board.columns, activeId) : null;

  // Both mutations roll back; both must say so. Reading only `moveStage.isError` left
  // a failed reorder silent, which is half the writes on this screen.
  const failure =
    moveStage.error instanceof MoveFailure
      ? { error: moveStage.error, dismiss: () => moveStage.reset() }
      : reorder.error instanceof MoveFailure
        ? { error: reorder.error, dismiss: () => reorder.reset() }
        : null;

  const stageOptions = [
    { value: '', label: 'All' },
    ...(board?.columns ?? []).map((column) => ({ value: column.canonical, label: column.name })),
  ];

  return (
    // h-full so the board can own the vertical space and scroll its columns rather
    // than growing the page.
    <div className="flex h-full min-h-0 flex-col">
      {board ? <JobHeader job={board.job} total={total} /> : null}

      <div className="flex items-center gap-3 py-4">
        <div className="flex h-[var(--control-height-md)] w-[var(--layout-filter-field-width)] items-center gap-2 rounded-md border border-border-default bg-bg-surface px-3">
          <SearchIcon className="shrink-0 text-text-placeholder" />
          <input
            type="search"
            aria-label="Filter candidates by name, title or company"
            placeholder="Filter candidates"
            value={filters.q}
            onChange={(event) => setParam('q', event.target.value)}
            className="h-full w-full bg-transparent text-body text-text-primary placeholder:text-text-placeholder"
          />
        </div>

        <FilterSelect label="Stage" value={filters.stage} onChange={(next) => setParam('stage', next)} options={stageOptions} />
        <FilterSelect
          label="Source"
          value={filters.source}
          onChange={(next) => setParam('source', next)}
          options={[
            { value: '', label: 'Any' },
            ...SourceSchema.options.map((value) => ({ value, label: SOURCE_LABELS[value] })),
          ]}
        />
        {/*
          One recruiter owns every application on this job, so the control has exactly
          one real option. It is rendered honestly rather than padded with names that
          would match nothing — a filter that lists absent values teaches the wrong
          thing about the data.
        */}
        <FilterSelect
          label="Recruiter"
          value=""
          disabled
          onChange={() => undefined}
          options={[{ value: '', label: 'All' }]}
        />

        {/* The filters group left, the count and sort flush right, per the reference. */}
        <span className="flex-1" />

        <p className="text-meta tabular-nums text-text-tertiary">{hasData ? `${shown} shown ·` : ''}</p>
        <div className="relative flex items-center">
          <select
            aria-label="Sort candidates"
            value={filters.sort}
            onChange={(event) => setParam('sort', event.target.value)}
            className="h-[var(--control-height-md)] appearance-none bg-transparent pr-5 text-meta text-text-tertiary"
          >
            {Object.entries(SORTS).map(([value, { label }]) => (
              <option key={value} value={value}>
                sort: {label}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute right-0 text-text-tertiary" />
        </div>
      </div>

      {query.isPending ? <LoadingSkeleton /> : null}

      {loadFailed ? (
        <Placeholder
          title="The pipeline didn't load."
          body="The connection dropped before the board arrived. Your filters are still set — try again."
          action={
            <Button variant="primary" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      ) : null}

      {/* Empty-because-filtered offers to clear the filter. Empty-because-no-data does
          not exist as a whole-board state: the columns still render, because which
          stages exist is itself the information (spec 003 §6.5). */}
      {hasData && shown === 0 && isFiltered ? (
        <Placeholder
          title="No candidates match those filters."
          body="Nothing in this pipeline matches what you have set. Clear the filters to see the whole board again."
          action={
            <Link href={pathname} className={buttonClass()}>
              Clear filters
            </Link>
          }
        />
      ) : null}

      {/* A failed move says what happened and what the board did about it. The card is
          already back where it was — this explains why, rather than asking the user to
          notice. */}
      {failure ? (
        // `aria-live` is off deliberately: dnd-kit already owns the one live region on
        // this screen (spec 003 §6.7), and a second one would double-announce every
        // move. The banner is reached by the refocused card instead.
        <div role="status" aria-live="off" className="mb-3 flex items-center gap-3 rounded-lg bg-feedback-warning-bg px-4 py-3">
          <p className="flex-1 text-body text-feedback-warning-fg">{failure.error.message}</p>
          <Button onClick={failure.dismiss}>Dismiss</Button>
        </div>
      ) : null}

      {hasData && !(shown === 0 && isFiltered) ? (
        <DndContext
          sensors={sensors}
          // closestCorners, not closestCenter: a tall column and a short card compare
          // badly by centre, and the empty-column case is exactly where that shows.
          collisionDetection={closestCorners}
          accessibility={{ announcements }}
          onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
          onDragCancel={() => setActiveId(null)}
          onDragEnd={handleDragEnd}
        >
          {/* The only horizontal scroller. Five 252px columns plus their gaps come to
              1308px against a 1162px content width, so the board overflows by design —
              the reference itself clips the Hired column mid-card. */}
          <div className="flex min-h-0 flex-1 gap-[var(--layout-kanban-column-gap)] overflow-x-auto pb-2">
            {columns.map((column) => (
              <PipelineColumn key={column.stageId} column={column} dragging={activeId !== null} />
            ))}
          </div>

          {/* The lifted card. `shadow.dragging` plus a 2° tilt per DESIGN_SYSTEM §4;
              both are transforms, so `prefers-reduced-motion` collapses them while the
              source card's opacity fade stays. */}
          <DragOverlay dropAnimation={dropAnimation}>
            {activeDrag ? (
              <div className="rotate-2 motion-reduce:rotate-0">
                <CardBody card={activeDrag.card} slaDays={activeDrag.column.slaDays} className="shadow-dragging" />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}
    </div>
  );
}
