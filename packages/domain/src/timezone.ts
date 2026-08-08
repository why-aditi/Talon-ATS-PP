/**
 * Wall clock → UTC instant — spec 004 §8.
 *
 * Storage is UTC everywhere, but the two bounds the solver needs are both stored as wall
 * clock plus a zone: the candidate's window sits in the candidate's zone
 * (`interview_loops.candidate_window_start` + `candidate_timezone`) and business hours
 * sit in the loop's (`tenants.business_hours_start`). Turning those into instants is the
 * step DST breaks, so it happens once, here, and the solver only ever sees instants.
 *
 * Pure: no clock is read, and the zone database comes from ICU via `Intl`.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let cached = formatters.get(zone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, cached);
  }
  return cached;
}

/**
 * The offset of `zone` from UTC in milliseconds at the instant `utcMs`. Positive east of
 * Greenwich, so `utc + offset = wall clock`.
 *
 * Derived by rendering the instant in the zone and reading the digits back, because
 * there is no API that just says "what was the offset". Half-hour and 45-minute zones
 * fall out of this for free, which is the point — an offset table keyed by hours is the
 * bug Asia/Kolkata finds.
 */
export function offsetMsAt(utcMs: number, zone: string): number {
  const parts = formatter(zone).formatToParts(new Date(utcMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new RangeError(`Intl returned no ${type} for zone ${zone}`);
    return Number(part.value);
  };
  return (
    Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second')) - utcMs
  );
}

/**
 * The UTC instant at which the clock in `zone` reads `date` `time`.
 *
 * `date` is `YYYY-MM-DD`, `time` is `HH:MM` or `HH:MM:SS` — exactly the shapes Postgres
 * hands back for a `date` and a `time` column, so no parsing lives at the call site.
 */
export function wallClockToUtc(date: string, time: string, zone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined) {
    throw new RangeError(`Not a date and time: ${date} ${time}`);
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute ?? 0, second ?? 0);

  // Two passes: the first guesses using the offset at the wrong instant, the second
  // corrects it. They agree everywhere except within an hour of a transition.
  const guess = wall - offsetMsAt(wall, zone);
  const corrected = wall - offsetMsAt(guess, zone);

  // Prefer whichever candidate actually renders back as the requested wall clock. On a
  // fall-back day both do and this picks the first (pre-transition) occurrence; in a
  // spring-forward gap neither does, and we take the later instant — the moment the
  // clock jumps to — so a candidate window can only narrow, never silently widen into
  // an hour that did not happen.
  if (offsetMsAt(corrected, zone) === wall - corrected) return new Date(corrected);
  if (offsetMsAt(guess, zone) === wall - guess) return new Date(guess);
  return new Date(Math.max(guess, corrected));
}

export type LoopWindowInput = {
  /** `interview_loops.target_date`, `YYYY-MM-DD`. Applied AS WRITTEN in each zone below,
   *  so a Kolkata candidate's "6 Aug, 9 to 4" is 6 August in Kolkata — which is partly
   *  5 August for a Chicago organiser. That is the intended reading of a date column
   *  with no zone attached to it. */
  date: string;
  /** The candidate's stated availability, in the candidate's zone (§6). */
  candidate: { start: string; end: string; zone: string };
  /** The tenant's single business-hours window, in the loop's zone (§6, migration 0009). */
  business: { start: string; end: string; zone: string };
};

/**
 * The two hard bounds, intersected, as one UTC window for the solver.
 *
 * An empty intersection is returned as-is (start >= end) rather than thrown: the solver
 * already has the right words for it — `window_too_narrow`, naming how much time was
 * actually available — and a throw here would turn a recruiter-fixable situation into a
 * 500.
 */
export function loopWindowUtc(input: LoopWindowInput): { start: Date; end: Date } {
  const candidateStart = wallClockToUtc(input.date, input.candidate.start, input.candidate.zone);
  const candidateEnd = wallClockToUtc(input.date, input.candidate.end, input.candidate.zone);
  const businessStart = wallClockToUtc(input.date, input.business.start, input.business.zone);
  const businessEnd = wallClockToUtc(input.date, input.business.end, input.business.zone);
  return {
    start: new Date(Math.max(candidateStart.getTime(), businessStart.getTime())),
    end: new Date(Math.min(candidateEnd.getTime(), businessEnd.getTime())),
  };
}
