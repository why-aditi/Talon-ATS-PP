/**
 * `CalendarProvider` — spec 004 §4.
 *
 * The interface lives in `domain` rather than beside its adapter because the solver, the
 * hold path and the send path all speak `BusyInterval`, and none of them may know that
 * CalDAV exists. `RadicaleCalendarProvider` implements this in `apps/api`; a Google
 * adapter later implements the same five methods and changes nothing else.
 *
 * Only the seeded implementation is here: it performs no I/O, so it is a domain value in
 * the same sense a fixture is, and it lets the solver's tests run without a container.
 */

/** UTC, always. Merged and sorted — normalisation happens in the adapter, never in the
 *  solver (§4), so every provider hands the same shape to the same code. */
export type BusyInterval = { start: Date; end: Date };

export type CalendarEvent = {
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  /** Tentative for a hold, confirmed on send (§9 step 3, §10 step 6). */
  status: 'tentative' | 'confirmed';
};

export interface CalendarProvider {
  getBusy(userIds: string[], from: Date, to: Date, ignoreExternalIds?: readonly string[]): Promise<Record<string, BusyInterval[]>>;
  createEvent(userId: string, event: CalendarEvent): Promise<{ externalId: string }>;
  updateEvent(userId: string, externalId: string, event: CalendarEvent): Promise<void>;
  deleteEvent(userId: string, externalId: string): Promise<void>;
  isConnected(userId: string): Promise<boolean>;
}

/**
 * The single most important line in spec 004 §4, as a function: an unreadable or
 * disconnected calendar is one interval covering the whole window. A provider error is
 * never interpreted as free, because the failure mode has to be "we didn't offer a
 * slot", never "we double-booked an interviewer".
 */
export const fullyBusy = (from: Date, to: Date): BusyInterval[] => [{ start: from, end: to }];

/**
 * Sorted, non-overlapping, with touching intervals joined.
 *
 * Adjacent is merged, not just overlapping: two back-to-back meetings are one solid
 * block of unavailability, and leaving them as two rows invites a "gap" of zero minutes
 * to be read as free by anything that looks between them.
 */
export function mergeBusy(intervals: readonly BusyInterval[]): BusyInterval[] {
  const sorted = [...intervals]
    .filter((i) => i.end.getTime() > i.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: BusyInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start.getTime() <= last.end.getTime()) {
      if (interval.end.getTime() > last.end.getTime()) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

/** Intervals clipped to [from, to), then merged. What an adapter does to a `REPORT`
 *  response before anything else sees it. */
export function normalizeBusy(
  intervals: readonly BusyInterval[],
  from: Date,
  to: Date,
): BusyInterval[] {
  const clipped = intervals
    .filter((i) => i.end.getTime() > from.getTime() && i.start.getTime() < to.getTime())
    .map((i) => ({
      start: new Date(Math.max(i.start.getTime(), from.getTime())),
      end: new Date(Math.min(i.end.getTime(), to.getTime())),
    }));
  return mergeBusy(clipped);
}

export type CalendarSeed = {
  /** userId → busy intervals. A user ABSENT from this map is fully busy, not free —
   *  see `getBusy`. A genuinely free panelist is seeded with an empty array. */
  busy?: Readonly<Record<string, readonly BusyInterval[]>>;
  /** Users whose calendar cannot be read at all (§12.1, §12.3). */
  disconnected?: readonly string[];
};

/** In-memory provider for unit tests. No container, no network, no clock. */
export class SeededCalendarProvider implements CalendarProvider {
  readonly #busy: Map<string, readonly BusyInterval[]>;
  readonly #disconnected: Set<string>;
  #nextId = 1;

  /** externalId → what was written, so a test can assert the send path's effects. */
  readonly written = new Map<string, { userId: string; event: CalendarEvent }>();

  constructor(seed: CalendarSeed = {}) {
    this.#busy = new Map(Object.entries(seed.busy ?? {}));
    this.#disconnected = new Set(seed.disconnected ?? []);
  }

  getBusy(userIds: string[], from: Date, to: Date): Promise<Record<string, BusyInterval[]>> {
    const out: Record<string, BusyInterval[]> = {};
    for (const userId of userIds) {
      const seeded = this.#busy.get(userId);
      // Unknown is treated exactly like disconnected. "We have no intervals for this
      // person" and "we never managed to read their calendar" are the same value at
      // this boundary, and §4 says which way that has to fail.
      out[userId] =
        seeded === undefined || this.#disconnected.has(userId)
          ? fullyBusy(from, to)
          : normalizeBusy(seeded, from, to);
    }
    return Promise.resolve(out);
  }

  createEvent(userId: string, event: CalendarEvent): Promise<{ externalId: string }> {
    const externalId = `seeded-${this.#nextId++}`;
    this.written.set(externalId, { userId, event });
    return Promise.resolve({ externalId });
  }

  updateEvent(userId: string, externalId: string, event: CalendarEvent): Promise<void> {
    if (!this.written.has(externalId)) {
      return Promise.reject(new Error(`No such event: ${externalId}`));
    }
    this.written.set(externalId, { userId, event });
    return Promise.resolve();
  }

  /** Idempotent: deleting what is already gone is a no-op, because delivery is
   *  at-least-once and a retry must not throw (non-negotiable #19). */
  deleteEvent(_userId: string, externalId: string): Promise<void> {
    this.written.delete(externalId);
    return Promise.resolve();
  }

  isConnected(userId: string): Promise<boolean> {
    return Promise.resolve(this.#busy.has(userId) && !this.#disconnected.has(userId));
  }
}
