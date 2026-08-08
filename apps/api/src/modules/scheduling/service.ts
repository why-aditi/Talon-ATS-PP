import { ERROR_TYPES, type Arrangement as WireArrangement, type InterviewLoop, type SendLoopResponse } from '@talon/contracts';
import { loopWindowUtc, solveLoop, validateArrangement, type Arrangement, type CalendarProvider, type Constraints, type SolveBlocker } from '@talon/domain';
import { HttpProblem, badRequest, notFound } from '../../errors.js';
import type { AuthenticatedUser, TenantTransaction } from '../../request-context.js';
import type { SchedulingRepository, SchedulingRecord } from './repository.js';

const iso = (d: Date) => d.toISOString();
const shortName = (name: string) => { const p = name.trim().split(/\s+/); return p.length < 2 ? name : `${p[0]} ${p.at(-1)?.[0]}.`; };

export class SchedulingService {
  readonly #repository: SchedulingRepository;
  readonly #calendar: CalendarProvider;
  constructor({ schedulingRepository, calendarProvider }: { schedulingRepository: SchedulingRepository; calendarProvider: CalendarProvider }) {
    this.#repository = schedulingRepository; this.#calendar = calendarProvider;
  }
  async getLoop(tx: TenantTransaction, id: string): Promise<InterviewLoop> {
    const row = await this.#repository.findLoop(tx, id);
    if (!row) throw notFound('No interview loop with that id exists in this tenant.');
    return this.#hydrate(row);
  }
  async hold(tx: TenantTransaction, user: AuthenticatedUser, id: string, wire: WireArrangement, version: number): Promise<InterviewLoop> {
    const row = await this.#required(tx, id); const { arrangement, constraints } = await this.#validate(row, wire);
    const blocker = validateArrangement(arrangement, constraints);
    if (blocker) throw badRequest(`That arrangement is no longer available: ${blocker.reason}.`);
    const created: Array<{ userId: string; externalId: string }> = [];
    try {
      const rounds = [] as Array<{ roundId: string; start: Date; end: Date; external: Array<{ userId: string; externalId: string }> }>;
      for (const placement of arrangement.rounds) {
        const round = row.rounds.find((r) => r.id === placement.roundId)!; const external = [] as Array<{ userId: string; externalId: string }>;
        for (const panelist of round.panelists) {
          const made = await this.#calendar.createEvent(panelist.userId, { summary: `Interview — ${row.candidateName} (${round.kind.replace('_', ' ')})`, start: placement.start, end: placement.end, status: 'tentative' });
          external.push({ userId: panelist.userId, externalId: made.externalId }); created.push({ userId: panelist.userId, externalId: made.externalId });
        }
        rounds.push({ roundId: placement.roundId, start: placement.start, end: placement.end, external });
      }
      const ok = await this.#repository.acquireHold(tx, { loop: row, userId: user.id, version, expiresAt: new Date(Date.now() + 24 * 60 * 60_000), rounds });
      if (!ok) throw new HttpProblem(409, ERROR_TYPES.VALIDATION_FAILED, 'The loop changed', 'Reload the loop before holding this slot.');
      return this.#hydrate((await this.#repository.findLoop(tx, id))!);
    } catch (error) {
      await Promise.allSettled(created.map((e) => this.#calendar.deleteEvent(e.userId, e.externalId))); throw error;
    }
  }

  async send(tx: TenantTransaction, user: AuthenticatedUser, id: string, wire: WireArrangement, version: number, key: string): Promise<SendLoopResponse> {
    const replay = await this.#repository.sentResult(tx, id, key); if (replay) return replay as SendLoopResponse;
    const row = await this.#required(tx, id);
    if (row.heldBy !== user.id || !row.holdExpiresAt || row.holdExpiresAt <= new Date()) throw new HttpProblem(409, ERROR_TYPES.VALIDATION_FAILED, 'The hold expired', 'Hold the slot again before sending.');
    const events = await this.#repository.calendarEvents(tx, id);
    const { arrangement, constraints } = await this.#validate(row, wire, events.map((e) => e.externalId));
    const blocker = validateArrangement(arrangement, constraints);
    if (blocker) {
      const affected = blocker.reason === 'panelist_busy' ? blocker.busyPanelistIds : arrangement.rounds.flatMap((r) => r.panelistIds);
      const names = new Map(row.rounds.flatMap((r) => r.panelists.map((p) => [p.userId, p.name] as const)));
      return { status: 'drifted', drift: [...new Set(affected)].map((panelistId) => ({ panelistId, panelistName: names.get(panelistId) ?? 'Panelist', fromUtc: wire.startUtc, toUtc: wire.endUtc })) };
    }
    const candidateIcs = this.#candidateIcs(row, arrangement);
    const confirmed: typeof events = [];
    try {
      for (const event of events) {
        await this.#calendar.updateEvent(event.userId, event.externalId, { summary: `Interview — ${row.candidateName} (${event.kind.replace('_', ' ')})`, start: event.start, end: event.end, status: 'confirmed' });
        confirmed.push(event);
      }
      const ok = await this.#repository.confirmSend(tx, { loopId: id, userId: user.id, version });
      if (!ok) throw new HttpProblem(409, ERROR_TYPES.VALIDATION_FAILED, 'The hold expired', 'Nothing was sent; hold the slot again.');
      const result = { status: 'sent' as const, loop: await this.#hydrate((await this.#repository.findLoop(tx, id))!), candidateIcs };
      await this.#repository.recordSend(tx, { loopId: id, userId: user.id, key, result });
      return result;
    } catch (error) {
      await Promise.allSettled(confirmed.map((event) => this.#calendar.updateEvent(event.userId, event.externalId, {
        summary: `Interview — ${row.candidateName} (${event.kind.replace('_', ' ')})`, start: event.start, end: event.end, status: 'tentative',
      })));
      throw error;
    }
  }

  async #required(tx: TenantTransaction, id: string) { const row = await this.#repository.findLoop(tx, id); if (!row) throw notFound('No interview loop with that id exists in this tenant.'); return row; }
  async #validate(row: SchedulingRecord, wire: WireArrangement, ignored: readonly string[] = []): Promise<{ arrangement: Arrangement; constraints: Constraints }> {
    if (!row.targetDate || !row.candidateTimezone || !row.candidateWindowStart || !row.candidateWindowEnd) throw badRequest('Candidate availability is required before scheduling.');
    const window = loopWindowUtc({ date: row.targetDate, candidate: { start: row.candidateWindowStart, end: row.candidateWindowEnd, zone: row.candidateTimezone }, business: { start: row.businessStart, end: row.businessEnd, zone: row.timezone } });
    const ids = [...new Set(row.rounds.flatMap((r) => r.panelists.filter((p) => p.isRequired).map((p) => p.userId)))];
    const constraints: Constraints = { rounds: row.rounds.map((r) => ({ id: r.id, durationMin: r.durationMin, requiredPanelistIds: r.panelists.filter((p) => p.isRequired).map((p) => p.userId) })), busy: await this.#calendar.getBusy(ids, window.start, window.end, ignored), windowStart: window.start, windowEnd: window.end, maxGapMin: 60, maxSpanMin: 8 * 60 };
    return { arrangement: { start: new Date(wire.startUtc), end: new Date(wire.endUtc), spanMin: wire.spanMin, totalGapMin: wire.totalGapMin, rounds: wire.rounds.map((r) => ({ roundId: r.roundId, start: new Date(r.startUtc), end: new Date(r.endUtc), panelistIds: r.panelistIds })) }, constraints };
  }
  #candidateIcs(row: SchedulingRecord, arrangement: Arrangement): string { const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Talon//Scheduling//EN',...arrangement.rounds.flatMap((p) => { const round=row.rounds.find((r)=>r.id===p.roundId)!; return ['BEGIN:VEVENT',`UID:${row.id}-${p.roundId}@talon`,`DTSTART:${stamp(p.start)}`,`DTEND:${stamp(p.end)}`,`SUMMARY:Interview — ${row.candidateName} (${round.kind.replace('_',' ')})`,'STATUS:CONFIRMED','END:VEVENT']; }),'END:VCALENDAR',''].join('\r\n'); }
  async #hydrate(row: SchedulingRecord): Promise<InterviewLoop> {
    const unique = new Map(row.rounds.flatMap((r) => r.panelists.map((p) => [p.userId, p] as const)));
    const ids = [...unique.keys()];
    const connected = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await this.#calendar.isConnected(id)])));
    let candidateWindow = null; let searchWindow = null; let busy: Record<string, { startUtc: string; endUtc: string }[]> = {};
    let solved: ReturnType<typeof solveLoop> = { arrangements: [], partial: false, blocker: { reason: 'window_too_narrow', requiredMin: 0, availableMin: 0 } };
    if (row.targetDate && row.candidateTimezone && row.candidateWindowStart && row.candidateWindowEnd) {
      const candidate = loopWindowUtc({ date: row.targetDate,
        candidate: { start: row.candidateWindowStart, end: row.candidateWindowEnd, zone: row.candidateTimezone },
        business: { start: row.businessStart, end: row.businessEnd, zone: row.timezone } });
      candidateWindow = { startUtc: iso(candidate.start), endUtc: iso(candidate.end) };
      searchWindow = candidateWindow;
      const read = await this.#calendar.getBusy(ids, candidate.start, candidate.end);
      busy = Object.fromEntries(ids.map((id) => [id, (read[id] ?? [{ start: candidate.start, end: candidate.end }]).map((b) => ({ startUtc: iso(b.start), endUtc: iso(b.end) }))]));
      solved = solveLoop({ rounds: row.rounds.map((r) => ({ id: r.id, durationMin: r.durationMin,
        requiredPanelistIds: r.panelists.filter((p) => p.isRequired).map((p) => p.userId) })),
        busy: read, windowStart: candidate.start, windowEnd: candidate.end, maxGapMin: 60, maxSpanMin: 8 * 60 });
    }
    return {
      id: row.id, applicationId: row.applicationId, status: row.status as InterviewLoop['status'],
      candidate: { id: row.candidateId, name: row.candidateName, zone: row.candidateTimezone ?? row.timezone },
      jobTitle: row.jobTitle, organizerZone: row.timezone, targetDate: row.targetDate,
      candidateWindow, searchWindow,
      panelists: [...unique.values()].map((p) => ({ id: p.userId, name: p.name, shortName: shortName(p.name), calendarConnected: connected[p.userId] ?? false })),
      rounds: row.rounds.map((r) => ({ id: r.id, kind: r.kind as InterviewLoop['rounds'][number]['kind'], durationMin: r.durationMin, position: r.position,
        isSwappable: r.isSwappable, panelists: r.panelists.map((p) => ({ userId: p.userId, isRequired: p.isRequired })),
        interview: r.interview ? { id: r.interview.id, status: r.interview.status as NonNullable<InterviewLoop['rounds'][number]['interview']>['status'],
          startUtc: r.interview.start ? iso(r.interview.start) : null, endUtc: r.interview.end ? iso(r.interview.end) : null,
          manualOverride: r.interview.manualOverride, acknowledgedBlocker: r.interview.acknowledgedBlocker as NonNullable<InterviewLoop['rounds'][number]['interview']>['acknowledgedBlocker'] } : null })),
      busy, hold: row.heldBy && row.holdExpiresAt && row.holdExpiresAt > new Date() ? { heldById: row.heldBy, heldByName: row.heldByName ?? 'Another recruiter', expiresUtc: iso(row.holdExpiresAt) } : null,
      solve: {
        arrangements: solved.arrangements.map((a) => ({ startUtc: iso(a.start), endUtc: iso(a.end), spanMin: a.spanMin,
          totalGapMin: a.totalGapMin, rounds: a.rounds.map((r) => ({ roundId: r.roundId, startUtc: iso(r.start), endUtc: iso(r.end), panelistIds: r.panelistIds })) })),
        partial: solved.partial,
        blocker: solved.blocker ? this.#blocker(solved.blocker, row) : null,
      },
      version: row.version,
    };
  }
  #blocker(blocker: SolveBlocker, row: SchedulingRecord): NonNullable<NonNullable<InterviewLoop['solve']>['blocker']> {
    if (blocker.reason === 'panelist_busy') {
      const round = row.rounds.find((r) => r.id === blocker.roundId)!;
      return { reason: blocker.reason, roundId: blocker.roundId, roundKind: round.kind as InterviewLoop['rounds'][number]['kind'], atUtc: iso(blocker.at),
        busyPanelists: blocker.busyPanelistIds.map((id) => ({ id, name: round.panelists.find((p) => p.userId === id)?.name ?? 'Panelist' })) };
    }
    if (blocker.reason === 'outside_window') return { reason: blocker.reason, roundId: blocker.roundId, roundKind: row.rounds.find((r) => r.id === blocker.roundId)!.kind as InterviewLoop['rounds'][number]['kind'], atUtc: iso(blocker.at) };
    if (blocker.reason === 'rounds_overlap') return { reason: blocker.reason, roundId: blocker.roundId, otherRoundId: blocker.otherRoundId, roundKind: row.rounds.find((r) => r.id === blocker.roundId)!.kind as InterviewLoop['rounds'][number]['kind'], atUtc: iso(blocker.at) };
    return blocker;
  }
}
