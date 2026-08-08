'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Avatar, cx } from './ui';

/* ── Shape ─────────────────────────────────────────────────────────────────── */

export type CellState = 'free' | 'busy' | 'selected';

export type GridCell = {
  state: CellState;
  /** "Busy", "Loop slot", "All free" — the visible label. Status is never colour alone. */
  label?: string;
  /** Read to a screen reader in place of the terse visible label. */
  description: string;
  /**
   * A round of the loop sits here. Usually that means `state: 'selected'`; it means
   * `state: 'busy'` as well when the recruiter placed over a conflict (§7a, "Place
   * anyway"), where the cell has to carry both facts — the hatch says the panelist is
   * busy, the stroke says the round is there regardless.
   */
  placed?: boolean;
};

export type GridColumn = {
  id: string;
  label: string;
  /** Present for a panelist column, absent for a day column in the Week view. */
  avatar?: { id: string; name: string };
  /** "Calendar not connected" — why this column reads fully busy (§12.1). */
  note?: string;
};

export type GridRow = {
  key: string;
  /** "10:00" in the organizer's zone. */
  label: string;
  description: string;
  cells: GridCell[];
};

/* ── The 45° hatch ─────────────────────────────────────────────────────────── */

/**
 * Busy is a pattern first and a colour second.
 *
 * DESIGN_SYSTEM §4 and §5 both say so, and the reason is not decoration: `busyFill`
 * against a `surfaceSunken` cell is a ~3% luminance step. In grayscale, in a screenshot
 * pasted into a doc, or to a viewer with reduced colour discrimination, the fill alone
 * is invisible. The hatch survives all three, and the cell also carries the word "Busy"
 * — pattern, colour and label, so no one of them is load-bearing on its own.
 *
 * An SVG `<pattern>` rather than a `repeating-linear-gradient`, because the gradient
 * form needs literal pixel stops in a class name and the token scale ships no
 * hatch-period step; the geometry here is user-space units on a graphic, the same kind
 * of number as the path coordinates in `icons.tsx`. Both colours are still tokens.
 *
 * Measured off `06-scheduling@2x.png`: stripes run top-left to bottom-right, ~4px wide
 * on an ~8px period, perpendicular.
 */
function HatchDefs({ id }: { id: string }) {
  return (
    <svg aria-hidden="true" focusable="false" className="absolute size-0">
      <defs>
        <pattern id={id} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="8" fill="var(--color-bg-surface-sunken)" />
          <rect width="4" height="8" fill="var(--color-calendar-busy-fill)" />
        </pattern>
      </defs>
    </svg>
  );
}

/** The legend's busy swatch. Its own pattern instance so the legend can sit outside the
 *  grid — an `url(#id)` reference only resolves to a `<defs>` in the same document, and
 *  scoping each one to its consumer keeps that a local fact rather than a shared id. */
export function BusySwatch() {
  const id = useId();
  return (
    <svg aria-hidden="true" focusable="false" className="size-4 rounded-xs">
      <defs>
        <pattern id={id} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="8" fill="var(--color-bg-surface-sunken)" />
          <rect width="4" height="8" fill="var(--color-calendar-busy-fill)" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} stroke="var(--color-calendar-busy-stroke)" />
    </svg>
  );
}

/* ── Grid ──────────────────────────────────────────────────────────────────── */

const CELL_STYLES: Record<CellState, string> = {
  free: 'bg-bg-surface text-text-secondary',
  busy: 'text-text-secondary',
  selected: 'border-2 border-calendar-selected-stroke bg-calendar-selected-fill text-text-link',
};

/**
 * The availability grid.
 *
 * Keyboard is the primary path, not an accommodation: arrows move the focused cell,
 * Home/End jump to the ends of a row, PageUp/PageDown to the first and last row, and
 * Enter or Space commits the row under focus. A roving tabindex means the grid is one
 * tab stop, so tabbing past it does not walk twenty-eight cells.
 */
export function SchedulingGrid({
  columns,
  rows,
  caption,
  onActivate,
  onCancel,
}: {
  columns: GridColumn[];
  rows: GridRow[];
  /** Names the grid for assistive tech; visually the day heading above it does the job. */
  caption: string;
  onActivate: (rowIndex: number, columnIndex: number) => void;
  /** Escape — abandons a round that was picked up for placing (§7a). */
  onCancel?: () => void;
}) {
  const hatchId = useId();
  const [focus, setFocus] = useState({ row: 0, column: 0 });
  const cells = useRef(new Map<string, HTMLDivElement>());
  const shouldFocus = useRef(false);

  // Clamp when the shape changes — the Day/Week toggle swaps four columns for five,
  // and a stale index would leave the roving tabindex on a cell that no longer exists.
  useEffect(() => {
    setFocus((current) => ({
      row: Math.min(current.row, Math.max(rows.length - 1, 0)),
      column: Math.min(current.column, Math.max(columns.length - 1, 0)),
    }));
  }, [rows.length, columns.length]);

  // Only after a key moved it. Focusing on every render would steal the caret from
  // whatever the user actually clicked into.
  useEffect(() => {
    if (!shouldFocus.current) return;
    shouldFocus.current = false;
    cells.current.get(`${focus.row}:${focus.column}`)?.focus();
  }, [focus]);

  const move = (row: number, column: number) => {
    shouldFocus.current = true;
    setFocus({
      row: Math.max(0, Math.min(row, rows.length - 1)),
      column: Math.max(0, Math.min(column, columns.length - 1)),
    });
  };

  function onKeyDown(event: React.KeyboardEvent, row: number, column: number) {
    switch (event.key) {
      case 'ArrowUp':
        move(row - 1, column);
        break;
      case 'ArrowDown':
        move(row + 1, column);
        break;
      case 'ArrowLeft':
        move(row, column - 1);
        break;
      case 'ArrowRight':
        move(row, column + 1);
        break;
      case 'Home':
        move(row, 0);
        break;
      case 'End':
        move(row, columns.length - 1);
        break;
      case 'PageUp':
        move(0, column);
        break;
      case 'PageDown':
        move(rows.length - 1, column);
        break;
      case 'Enter':
      case ' ':
        onActivate(row, column);
        break;
      case 'Escape':
        if (!onCancel) return;
        onCancel();
        break;
      default:
        return;
    }
    // Only for keys that were handled — otherwise typing anywhere in the grid would
    // swallow the browser's own shortcuts.
    event.preventDefault();
  }

  // One template, applied to the header and to every row, so the columns line up
  // without the rows having to be grid items of a single grid (which would need
  // `display: contents` on the row and take `role="row"` out of the layout).
  const template = `var(--spacing-16) repeat(${columns.length}, minmax(0, 1fr))`;

  return (
    <div
      role="grid"
      aria-label={caption}
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length + 1}
      className="flex flex-1 flex-col overflow-auto rounded-lg border border-border-default bg-bg-surface"
    >
      <HatchDefs id={hatchId} />

      <div
        role="row"
        style={{ gridTemplateColumns: template }}
        className="sticky top-0 z-[var(--z-sticky)] grid border-b border-border-default bg-bg-surface-sunken"
      >
        {/* Real text rather than an aria-label: a header whose only accessible name is
            an attribute reads as an empty header to axe, and to some screen readers. */}
        <span role="columnheader" className="border-r border-calendar-grid-line">
          <span className="sr-only">Time</span>
        </span>
        {columns.map((column) => (
          <div
            key={column.id}
            role="columnheader"
            className="flex min-w-0 items-center gap-2 border-r border-calendar-grid-line px-3 py-2 last:border-r-0"
          >
            {column.avatar ? <Avatar id={column.avatar.id} name={column.avatar.name} size={24} /> : null}
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-body-strong text-text-primary">{column.label}</span>
              {column.note ? <span className="block truncate text-meta text-feedback-warning-fg">{column.note}</span> : null}
            </span>
          </div>
        ))}
      </div>

      {rows.map((row, rowIndex) => (
        <div
          key={row.key}
          role="row"
          style={{ gridTemplateColumns: template }}
          className="grid border-b border-calendar-grid-line"
        >
          <span
            role="rowheader"
            className="flex h-[var(--layout-scheduling-row-height)] items-start justify-end border-r border-calendar-grid-line px-2 py-2 text-meta tabular-nums text-text-secondary"
          >
            {row.label}
          </span>

          {row.cells.map((cell, columnIndex) => {
            const isFocusTarget = focus.row === rowIndex && focus.column === columnIndex;
            return (
              <div
                key={`${row.key}:${columns[columnIndex]?.id ?? columnIndex}`}
                role="gridcell"
                tabIndex={isFocusTarget ? 0 : -1}
                aria-selected={cell.placed === true}
                aria-label={cell.description}
                ref={(node) => {
                  const key = `${rowIndex}:${columnIndex}`;
                  if (node) cells.current.set(key, node);
                  else cells.current.delete(key);
                }}
                onKeyDown={(event) => onKeyDown(event, rowIndex, columnIndex)}
                onClick={() => {
                  setFocus({ row: rowIndex, column: columnIndex });
                  onActivate(rowIndex, columnIndex);
                }}
                onFocus={() => setFocus({ row: rowIndex, column: columnIndex })}
                className={cx(
                  'relative flex h-[var(--layout-scheduling-row-height)] cursor-pointer items-start overflow-hidden border-r border-calendar-grid-line px-3 py-2 last:border-r-0',
                  // The ring replaces the outline rather than removing it — a focus
                  // style that only draws outside the box would be clipped by the
                  // scroller this grid lives in.
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus',
                  CELL_STYLES[cell.state],
                  // Placed over a busy panelist: the hatch stays, the stroke is added.
                  cell.placed && cell.state === 'busy'
                    ? 'border-2 border-calendar-selected-stroke'
                    : undefined,
                )}
              >
                {cell.state === 'busy' ? (
                  <svg aria-hidden="true" focusable="false" className="absolute inset-0 size-full">
                    <rect width="100%" height="100%" fill={`url(#${hatchId})`} />
                  </svg>
                ) : null}
                {cell.label ? (
                  <span
                    className={cx(
                      'relative text-meta',
                      cell.label === 'All free' ? 'text-calendar-free-text' : undefined,
                    )}
                  >
                    {cell.label}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Same bones, no data — so nothing shifts when the loop lands (§11, loading). */
export function SchedulingGridSkeleton({ columns = 4, rows = 7 }: { columns?: number; rows?: number }) {
  const template = `var(--spacing-16) repeat(${columns}, minmax(0, 1fr))`;
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading availability"
      className="flex flex-1 flex-col overflow-hidden rounded-lg border border-border-default bg-bg-surface"
    >
      <div style={{ gridTemplateColumns: template }} className="grid border-b border-border-default bg-bg-surface-sunken">
        <span className="border-r border-calendar-grid-line" />
        {Array.from({ length: columns }, (_, i) => (
          <div key={i} className="flex items-center gap-2 border-r border-calendar-grid-line px-3 py-2 last:border-r-0">
            <span className="size-6 shrink-0 animate-pulse rounded-full bg-border-subtle" />
            <span className="h-4 w-20 animate-pulse rounded-xs bg-border-subtle" />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ gridTemplateColumns: template }} className="grid border-b border-calendar-grid-line">
          <span className="flex h-[var(--layout-scheduling-row-height)] items-start justify-end px-2 py-2">
            <span className="h-3 w-8 animate-pulse rounded-xs bg-border-subtle" />
          </span>
          {Array.from({ length: columns }, (_, c) => (
            <span
              key={c}
              className="flex h-[var(--layout-scheduling-row-height)] items-start border-r border-calendar-grid-line px-3 py-2 last:border-r-0"
            >
              <span className="h-3 w-12 animate-pulse rounded-xs bg-border-subtle" />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
