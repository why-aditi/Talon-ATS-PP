'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { prefersReducedMotion } from '../lib/board-state';
import {
  SOURCE_LABELS,
  STATUS_LABELS,
  type ApplicationCard,
} from '../lib/pipeline-contract';
import { GripIcon } from './icons';
import { Avatar, cx } from './ui';

/**
 * Strictly greater. Marcus Webb sits at 5d in Screen against a 5-day SLA and renders
 * normally on the reference; Elena Ruiz at 8d is stalled. `>=` would stall Marcus and
 * contradict the screen. Derived from pixels rather than stated in any doc, which is
 * why it is written down here and in spec 003 §6.4 rather than left implicit.
 */
export function isStalled(card: ApplicationCard, slaDays: number | null): boolean {
  return slaDays !== null && card.daysInStage > slaDays;
}

/**
 * Source, skills and status all render identically — they are metadata, not status,
 * and keeping them neutral is what lets the stage hues stay meaningful
 * (DESIGN_SYSTEM §3). Order follows the reference: status first where it exists, then
 * skills, then source.
 */
function tagsFor(card: ApplicationCard): string[] {
  const status = card.status === 'active' ? [] : [STATUS_LABELS[card.status]];
  return [...status, ...card.skills, SOURCE_LABELS[card.source]];
}

function Tag({ label }: { label: string }) {
  return <span className="rounded-xs bg-bg-canvas px-2 py-px text-caption text-text-secondary">{label}</span>;
}

/** Presentation only, so the `DragOverlay` can render the same card without a second
 *  sortable registration fighting the first for the same id. */
export function CardBody({
  card,
  slaDays,
  className,
}: {
  card: ApplicationCard;
  slaDays: number | null;
  className?: string | undefined;
}) {
  const stalled = isStalled(card, slaDays);

  return (
    <div
      className={cx(
        'rounded-md border border-border-default bg-bg-surface p-3 shadow-xs',
        className,
        // Signal three of three: position. Colour and weight live on the footer below.
        // A left edge survives both greyscale and a colourblind viewer, which neither
        // of the other two does on its own.
        stalled && 'border-l-2 border-l-border-danger',
      )}
    >
      <div className="flex items-start gap-2">
        <Avatar id={card.candidateId} name={card.name} />
        <div className="min-w-0 flex-1">
          <p data-testid="card-name" className="truncate text-card-title text-text-primary">{card.name}</p>
          <p className="truncate text-meta text-text-secondary">
            {card.currentTitle} at {card.currentCompany}
          </p>
        </div>
        {/* Absent, not null, for a caller outside scorecard scope — so an unscored card
            and an unreadable one look the same and the board leaks nothing (spec 003 §7). */}
        {card.scoreAvg == null ? null : (
          <span className="rounded-sm bg-bg-canvas px-2 py-px text-caption tabular-nums text-text-secondary">
            {card.scoreAvg.toFixed(1)}
          </span>
        )}
      </div>

      {/* Five of the nine candidates have no skills; the row still renders because the
          source tag is always present, so no card collapses to a different height. */}
      <div className="mt-2 flex flex-wrap gap-1">
        {tagsFor(card).map((label) => (
          <Tag key={label} label={label} />
        ))}
      </div>

      <div className="mt-3 flex items-end gap-2">
        {/* Only the dwell clause carries the stall. The reference keeps "· Call Tue"
            at tertiary and normal weight — reddening the whole line would say the next
            action is also a problem, which it isn't. */}
        <p className="flex-1 text-meta tabular-nums text-text-tertiary">
          <span className={cx(stalled && 'text-body-strong text-text-danger')}>
            {stalled ? `Stalled ${card.daysInStage}d in stage` : `${card.daysInStage}d in stage`}
          </span>{' '}
          · {card.nextAction}
        </p>
        {/* The affordance, not the control: the whole card is the drag handle and the
            keyboard target, so a separate focusable grip would be a second tab stop
            onto the same action. */}
        <GripIcon className="shrink-0 text-text-placeholder" />
      </div>
    </div>
  );
}

export function PipelineCard({
  card,
  slaDays,
  draggable,
}: {
  card: ApplicationCard;
  slaDays: number | null;
  /** Terminal columns neither give up cards nor take them — a closed application is
   *  not in play, and moving one needs the reason prompt that is not built yet
   *  (spec 003 §8 edges 7–8). */
  draggable: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled: !draggable,
    data: { type: 'card' },
  });

  return (
    <div
      ref={setNodeRef}
      // The handle the board refocuses after a drop — dnd-kit's own restore targets a
      // node React has already replaced by then.
      data-card-id={card.id}
      // The transition is an INLINE style, which beats the reduced-motion rule in
      // globals.css — so it has to be dropped here rather than overridden there.
      style={{ transform: CSS.Translate.toString(transform), transition: prefersReducedMotion() ? undefined : transition }}
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
      // The whole card is the handle and the keyboard target, so the hit area is the
      // card — comfortably past the 32×32 minimum DESIGN_SYSTEM §5 sets for anything
      // where a mis-tap moves a candidate.
      className={cx('touch-none', draggable && 'cursor-grab')}
    >
      {/* The source position fades rather than disappearing, so the column does not
          reflow under the pointer mid-drag. Opacity survives prefers-reduced-motion by
          design (design-tokens.json motion.reducedMotion). */}
      <CardBody card={card} slaDays={slaDays} className={isDragging ? 'opacity-[var(--opacity-drag-source)]' : undefined} />
    </div>
  );
}
