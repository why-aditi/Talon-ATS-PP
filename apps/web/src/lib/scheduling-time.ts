/**
 * Rendering instants in a named zone — spec 004 §8.
 *
 * Storage is UTC and nothing here changes that: every function takes an ISO instant
 * and an IANA zone and returns a string. There is no `new Date()` without an argument
 * and no reliance on the machine's own zone, which is the whole point — the organizer
 * reads the grid in CT whether the browser thinks it is in Chicago, Berlin or a CI
 * container pinned to UTC. That also makes every one of these testable against a DST
 * boundary without mutating process.env.TZ.
 */

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}|${JSON.stringify(options)}`;
  let found = cache.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options });
    cache.set(key, found);
  }
  return found;
}

/**
 * "10:00" — the grid's row labels, which carry no meridiem.
 *
 * The reference renders 9:00, 12:00, 1:00, 2:30 in one column, so the hours are
 * 12-hour and the AM/PM is dropped: a day grid reading top to bottom already says
 * which half of the day a row is in, and the repeated "AM"/"PM" is noise at 10px.
 * Built from parts rather than a regex over a formatted string, because the parts
 * are locale-stable and a string strip is not.
 */
export function timeLabel(iso: string, zone: string): string {
  const parts = formatter(zone, { hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
  return `${hour}:${minute}`;
}

/** "10:00 AM" — the commitment on the primary button, where the meridiem is load-bearing. */
export function clockLabel(iso: string, zone: string): string {
  return formatter(zone, { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
}

/** "Thursday, Aug 6" — the grid's date heading. */
export function dayLabel(iso: string, zone: string): string {
  return formatter(zone, { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(iso));
}

/** "Aug 6" — the tail of "Send invites, 10:00 AM Aug 6". */
export function dateLabel(iso: string, zone: string): string {
  return formatter(zone, { month: 'short', day: 'numeric' }).format(new Date(iso));
}

/**
 * "Thu 6" — a week-view column header.
 *
 * Assembled from parts rather than asked for as one pattern: en-US formats
 * `{ weekday, day }` as "6 Thu", which reads as a date that has lost its month.
 */
export function weekdayLabel(iso: string, zone: string): string {
  const date = new Date(iso);
  const weekday = formatter(zone, { weekday: 'short' }).format(date);
  const day = formatter(zone, { day: 'numeric' }).format(date);
  return `${weekday} ${day}`;
}

/**
 * "CT", not "CDT".
 *
 * `shortGeneric` rather than `short` on purpose: the recruiter is naming a zone, not a
 * point in the year, and a header that flips between CST and CDT halfway through
 * October invites the reader to wonder whether the times moved. The reference says
 * "Times in CT".
 */
export function zoneLabel(iso: string, zone: string): string {
  const parts = formatter(zone, { timeZoneName: 'shortGeneric' }).formatToParts(new Date(iso));
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? zone;
}

/** "9" / "4" — the bare hours in "candidate available 9 to 4". */
export function hourLabel(iso: string, zone: string): string {
  const parts = formatter(zone, { hour: 'numeric', hour12: true }).formatToParts(new Date(iso));
  return parts.find((p) => p.type === 'hour')?.value ?? '';
}

/** Minutes added to an instant, as an instant. Arithmetic in UTC, never in wall clock. */
export function plusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/**
 * Does any interval run through `[startUtc, endUtc)`?
 *
 * Half-open, so a meeting that ends exactly when a round starts is not a clash — the
 * boundary case that turns into an off-by-one everywhere else if it is left implicit.
 * ISO-8601 UTC strings compare lexicographically in instant order, which is why this is
 * string comparison and not a `Date` round-trip per interval.
 */
export function overlaps(
  intervals: readonly { startUtc: string; endUtc: string }[],
  startUtc: string,
  endUtc: string,
): boolean {
  return intervals.some((iv) => iv.startUtc < endUtc && iv.endUtc > startUtc);
}

/** `true` when two instants land on the same calendar day *in the given zone*. */
export function sameDay(a: string, b: string, zone: string): boolean {
  const format = formatter(zone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return format.format(new Date(a)) === format.format(new Date(b));
}
