'use client';

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { CanonicalStage } from '@talon/contracts';
import type { BoardColumn } from '@talon/contracts';
import { PlusIcon } from './icons';
import { PipelineCard } from './pipeline-card';
import { cx } from './ui';

/**
 * One hue per canonical stage, carried by the header square and the progress rule
 * (DESIGN_SYSTEM §1). Never the only carrier of meaning — the stage label sits beside
 * it in every case.
 */
const STAGE_HUE: Record<CanonicalStage, string> = {
  applied: 'bg-stage-applied',
  screen: 'bg-stage-screen',
  onsite: 'bg-stage-onsite',
  offer: 'bg-stage-offer',
  hired: 'bg-stage-hired',
  rejected: 'bg-stage-rejected',
  withdrawn: 'bg-stage-rejected',
};

function ColumnHeader({ column }: { column: BoardColumn }) {
  const { stats } = column;
  return (
    // Not `position: sticky`. The board's own `overflow-x` establishes a containing
    // block that breaks a sticky descendant; making the header a non-scrolling flex
    // sibling of the scrolling card list gets the same result with no positioning at
    // all (spec 003 §6.1).
    <div className="shrink-0 px-3 pt-3">
      <div className="flex items-center gap-2">
        {/* Square, not rounded: `radius.xs` is 4px, which CSS clamps to 50% on a 6px
            box and turns the square into a circle. The reference softens the corners by
            roughly 1.5px and the scale has no step that small — recorded in spec 003
            §6.2 rather than papered over with a literal. */}
        <span
          className={cx('size-[var(--layout-stage-dot-size)] shrink-0', STAGE_HUE[column.canonical])}
          aria-hidden="true"
        />
        <h2 className="text-body-strong text-text-primary">{column.name}</h2>
        <span className="flex-1">
          <span className="rounded-xs bg-bg-canvas px-1 text-caption tabular-nums text-text-tertiary">{column.count}</span>
        </span>
        {/*
          Disabled, not focusable-but-inert. Adding a candidate directly is not in this
          spec, and a control that takes focus and does nothing is a dead-end tab stop —
          the same call as the sign-in SSO buttons and the topbar search.
        */}
        <button
          type="button"
          disabled
          aria-label={`Add a candidate to ${column.name} (not available yet)`}
          className="grid size-6 place-items-center rounded-md text-text-placeholder"
        >
          <PlusIcon />
        </button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span
          className="flex h-[var(--layout-progress-rule-height)] flex-1 overflow-hidden rounded-full bg-border-subtle"
          role="img"
          aria-label={`${stats.passRatePct}% of candidates reached ${column.name}`}
        >
          <span className={STAGE_HUE[column.canonical]} style={{ width: `${stats.passRatePct}%` }} />
        </span>
        <span className="text-meta tabular-nums text-text-tertiary">{stats.passRatePct}% pass</span>
      </div>

      {/* A terminal stage has no exits, so a median time-in-stage does not exist —
          "closed" rather than a blank or a zero. */}
      <p className="mt-2 text-meta tabular-nums text-text-tertiary">
        {stats.medianDaysInStage === null ? 'closed' : `median ${stats.medianDaysInStage}d`}
      </p>
    </div>
  );
}

export function PipelineColumn({ column, dragging }: { column: BoardColumn; dragging: boolean }) {
  // Terminal columns stay ENABLED as droppables and refuse the drop instead.
  //
  // Disabling them was the first attempt, and it made the refusal silent: dnd-kit never
  // resolves `over` to a disabled droppable, so the announcement explaining why never
  // fired and a screen-reader user simply found that ArrowRight did nothing. A sighted
  // user saw the dashed hint; nobody else got told anything. Reaching the column and
  // being told "this needs a reason" is the explanation the block was supposed to carry
  // (spec 003 §8 edges 7–8). `handleDragEnd` is what actually refuses.
  const { setNodeRef, isOver } = useDroppable({
    id: column.stageId,
    data: { type: 'column', position: column.position },
  });

  return (
    // The 1px border is measured, not assumed: scanning the reference at 2x shows
    // border.default at the column edge with a 24px (12 CSS) gap between columns.
    // Consistent with DESIGN_SYSTEM §1 — surfaces separate with a border and a
    // background step, never a shadow.
    <section
      aria-label={`${column.name}, ${column.count} ${column.count === 1 ? 'candidate' : 'candidates'}`}
      className="flex w-[var(--layout-kanban-column-width)] shrink-0 flex-col rounded-lg border border-border-default bg-bg-surface-sunken"
    >
      <ColumnHeader column={column} />

      {/* The vertical scroller. `min-h-0` is what lets it actually scroll inside a flex
          column rather than growing the section past the board; `min-h-20` is what keeps
          an emptied column a reachable drop target instead of collapsing to nothing
          (spec 003 §8 edge 6). */}
      <ul
        ref={setNodeRef}
        className={cx(
          // `min-h-20` does both jobs: any explicit min-height replaces a flex item's
          // default `min-height: auto`, so the list can still shrink and scroll, while
          // never collapsing below a droppable 80px.
          'flex min-h-20 flex-1 flex-col gap-[var(--layout-kanban-card-gap)] overflow-y-auto p-3',
          'transition-colors duration-[var(--duration-instant)] ease-standard',
          isOver && !column.isTerminal && 'bg-bg-selected',
        )}
      >
        <SortableContext items={column.cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
          {column.cards.map((card) => (
            <li key={card.id}>
              <PipelineCard card={card} slaDays={column.slaDays} draggable={!column.isTerminal} />
            </li>
          ))}
        </SortableContext>

        {/* Said, not implied. A drag that silently refuses a column teaches nothing;
            PRD §5.4 requires a reason for a terminal stage and that prompt is not built,
            so the block is explained where the user is looking (spec 003 §8 edge 7). */}
        {dragging && column.isTerminal ? (
          <li className="rounded-md border border-dashed border-border-strong px-3 py-2 text-meta text-text-tertiary">
            Moving to {column.name} needs a reason. That&apos;s not available yet.
          </li>
        ) : null}

        {column.cards.length === 0 ? (
          // An invitation, not a dead end (DESIGN_SYSTEM §6). Terminal columns get
          // different copy: nobody advances into Hired from a neighbouring column by
          // hand, so offering that as the next move would be wrong.
          <li className="px-2 py-4 text-meta text-text-tertiary">
            {column.isTerminal
              ? `No one in ${column.name} yet.`
              : `No candidates in ${column.name} yet. Advance someone from the previous stage, or add a candidate directly.`}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
