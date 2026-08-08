'use client';

/**
 * Reports — reference screen 08, spec 007 §7.5.
 *
 * No charting dependency. Five bars and eight columns of known height are divs; a
 * library here would be a build-size and API surface bought for arithmetic we can do
 * in a style attribute.
 *
 * ACCESSIBILITY NOTE, and it is the reason this file is shaped the way it is.
 * `color.semantic.stage.*` and `color.semantic.source.*` were run through the palette
 * validator and both FAIL adjacent-pair CVD separation on the same pair: `screen`
 * (#2569C2) against `onsite` (#6F4FC4) measures ΔE 0.6 for deuteranopes — visually
 * identical — and ΔE 10.1 even with normal colour vision, under the readability floor.
 * The two are adjacent in pipeline order, which is the worst arrangement for it.
 *
 * The tokens are measured from the reference and are authoritative (CLAUDE.md), so
 * they are not "corrected" here. What makes this screen legal instead is the secondary
 * encoding the reference itself carries: EVERY bar and legend row is directly labelled
 * and carries its count, so identity never rests on the swatch (§4.15). Do not
 * refactor toward a stacked bar or a legend-only chart on this palette — that removes
 * the very thing holding it up. Spec 007 OQ-8 carries the token question.
 */
import type { ReportsOverview } from '@talon/contracts';
import { useReports } from '../lib/people-query';
import { Eyebrow, cx } from './ui';

const STAGE_FILL: Record<string, string> = {
  applied: 'bg-stage-applied',
  screen: 'bg-stage-screen',
  onsite: 'bg-stage-onsite',
  offer: 'bg-stage-offer',
  hired: 'bg-stage-hired',
};

const SOURCE_FILL: Record<string, string> = {
  referral: 'bg-source-referral',
  outbound: 'bg-source-outbound',
  careers_page: 'bg-source-careers-page',
  agency: 'bg-source-agency',
};

/** Direction rides an arrow as well as a colour — never colour alone (§4.15). */
const ARROW = { up: '↑', down: '↓', flat: '→' } as const;
const DELTA_TONE = {
  up: 'text-feedback-success-fg',
  down: 'text-feedback-danger-fg',
  flat: 'text-text-secondary',
} as const;

function Panel({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-bg-surface p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-body-lg text-text-primary">{title}</h2>
        {aside ? <span className="text-caption text-text-tertiary">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The numbers again, for a screen reader. A bar chart made of coloured divs is
 * invisible without this: `role="img"` plus a label states the shape, and the table
 * gives the actual values to anyone who wants them.
 */
function DataTable({ caption, rows }: { caption: string; rows: [string, number][] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Conversion({ rows }: { rows: ReportsOverview['conversion'] }) {
  // Guarded, not assumed: an all-zero series must render zero-width bars rather than
  // dividing by zero and writing `NaN%` into a style attribute (§10 case 11).
  const max = Math.max(...rows.map((r) => r.count), 0);
  return (
    <Panel title="Pipeline conversion">
      <ul className="flex flex-col gap-3" role="img" aria-label={rows.map((r) => `${r.label} ${r.count}`).join(', ')}>
        {rows.map((row) => (
          <li key={row.stage} className="grid grid-cols-[5rem_minmax(0,1fr)_3rem] items-center gap-3">
            {/* The label is the identity carrier. The fill reinforces it. */}
            <span className="text-body text-text-primary">{row.label}</span>
            <span className="h-4 overflow-hidden rounded-full bg-bg-surface-sunken">
              <span
                className={cx('block h-full rounded-full', STAGE_FILL[row.stage])}
                style={{ width: max === 0 ? '0%' : `${(row.count / max) * 100}%` }}
              />
            </span>
            <span className="text-right text-body text-text-primary tabular-nums">{row.count}</span>
          </li>
        ))}
      </ul>
      <DataTable caption="Pipeline conversion" rows={rows.map((r) => [r.label, r.count])} />
    </Panel>
  );
}

function Sources({ rows }: { rows: ReportsOverview['sources'] }) {
  return (
    <Panel title="Hires by source">
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-3">
            <span className={cx('size-3 shrink-0 rounded-xs', SOURCE_FILL[row.key])} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-body text-text-primary">{row.label}</span>
            <span className="shrink-0 text-body-strong text-text-primary tabular-nums">
              {row.hires} {row.hires === 1 ? 'hire' : 'hires'}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Trend({ points }: { points: ReportsOverview['interviewsPerWeek'] }) {
  const max = Math.max(...points.map((p) => p.count), 0);
  return (
    <Panel title="Interviews per week" aside={`${points.length} week trend`}>
      <div
        className="flex h-48 items-end gap-3"
        role="img"
        aria-label={points.map((p) => `${p.label} ${p.count}`).join(', ')}
      >
        {points.map((point, i) => (
          <div key={point.label} className="flex min-w-0 flex-1 flex-col items-center gap-2">
            <span className="text-caption text-text-secondary tabular-nums">{point.count}</span>
            <span
              // Only the last column is the current week, and it is the only saturated
              // one — the design's own emphasis, carried by a token measured off the
              // reference rather than an opacity guess.
              className={cx(
                'w-full rounded-t-sm',
                i === points.length - 1 ? 'bg-chart-bar-current' : 'bg-chart-bar-idle',
              )}
              style={{ height: max === 0 ? '0%' : `${(point.count / max) * 100}%` }}
            />
            <span className="text-caption text-text-tertiary">{point.label}</span>
          </div>
        ))}
      </div>
      <DataTable caption="Interviews per week" rows={points.map((p) => [p.label, p.count])} />
    </Panel>
  );
}

function TileSkeleton() {
  // Final height, so the page does not reflow when the data lands.
  return <div className="h-28 animate-pulse rounded-lg bg-bg-surface-sunken" />;
}

export function ReportsScreen() {
  const query = useReports();

  if (query.isError) {
    return <p className="p-[var(--layout-page-gutter)] text-body text-text-secondary">Reports could not be loaded.</p>;
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-[var(--layout-page-gutter)]">
      <div className="flex items-baseline gap-3">
        <h1 className="text-page-title text-text-primary">Reports</h1>
        <p className="text-body text-text-secondary">{query.data?.period ?? ''}</p>
      </div>

      {query.isPending ? (
        <>
          <div className="grid grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <TileSkeleton key={i} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="h-56 animate-pulse rounded-lg bg-bg-surface-sunken" />
            <div className="h-56 animate-pulse rounded-lg bg-bg-surface-sunken" />
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-4">
            {query.data.tiles.map((tile) => (
              <section key={tile.key} className="rounded-lg border border-border-subtle bg-bg-surface p-5">
                <Eyebrow>{tile.label}</Eyebrow>
                <p className="mt-2 text-metric-xl text-text-primary tabular-nums">{tile.value}</p>
                {/* Omitted when null, and the tile keeps its height so the row cannot
                    jag (§10 case 12). */}
                {tile.delta === null ? null : (
                  <p className={cx('mt-1 text-body', DELTA_TONE[tile.direction])}>
                    <span aria-hidden="true">{ARROW[tile.direction]} </span>
                    {tile.delta}
                  </p>
                )}
              </section>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Conversion rows={query.data.conversion} />
            <Sources rows={query.data.sources} />
          </div>

          <Trend points={query.data.interviewsPerWeek} />
        </>
      )}
    </div>
  );
}
