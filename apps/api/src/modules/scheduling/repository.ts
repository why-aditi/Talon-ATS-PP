import type { TenantTransaction } from '../../request-context.js';
import { newId } from '@talon/db';

export type SchedulingRecord = {
  id: string; applicationId: string; status: string; targetDate: string | null;
  timezone: string; candidateTimezone: string | null; candidateWindowStart: string | null;
  candidateWindowEnd: string | null; heldBy: string | null; heldByName: string | null;
  holdExpiresAt: Date | null; version: number; candidateId: string; candidateName: string;
  jobTitle: string; businessStart: string; businessEnd: string;
  rounds: Array<{ id: string; kind: string; durationMin: number; position: number;
    isSwappable: boolean; panelists: Array<{ userId: string; name: string; isRequired: boolean }>;
    interview: null | { id: string; status: string; start: Date | null; end: Date | null;
      manualOverride: boolean; acknowledgedBlocker: unknown; externalEventId: string | null } }>;
};
type LoopRow = { id: string; application_id: string; status: string; target_date: string | null; timezone: string;
  candidate_timezone: string | null; candidate_window_start: string | null; candidate_window_end: string | null;
  held_by: string | null; held_by_name: string | null; hold_expires_at: Date | null; version: number;
  candidate_id: string; candidate_name: string; job_title: string; business_start: string; business_end: string };
type RoundRow = { id: string; kind: string; duration_min: number; position: number; is_swappable: boolean;
  panelists: Array<{ userId: string; name: string; isRequired: boolean }>; interview_id: string | null;
  interview_status: string | null; scheduled_start: Date | null; scheduled_end: Date | null;
  manual_override: boolean | null; acknowledged_blocker: unknown; external_event_id: string | null };

export class SchedulingRepository {
  async findLoop(tx: TenantTransaction, id: string): Promise<SchedulingRecord | null> {
    const [loop] = await tx.sql<LoopRow[]>`
      select l.id, l.application_id, l.status, l.target_date::text, l.timezone,
             l.candidate_timezone, l.candidate_window_start::text, l.candidate_window_end::text,
             l.held_by, holder.name as held_by_name, l.hold_expires_at, l.version,
             c.id as candidate_id, c.name as candidate_name, j.title as job_title,
             t.business_hours_start::text as business_start, t.business_hours_end::text as business_end
      from interview_loops l
      join applications a on a.id = l.application_id and a.tenant_id = l.tenant_id
      join candidates c on c.id = a.candidate_id and c.tenant_id = l.tenant_id
      join jobs j on j.id = a.job_id and j.tenant_id = l.tenant_id
      join tenants t on t.id = l.tenant_id
      left join users holder on holder.id = l.held_by and holder.tenant_id = l.tenant_id
      where l.tenant_id = ${tx.tenantId}::uuid and l.id = ${id}::uuid`;
    if (!loop) return null;
    const rounds = await tx.sql<RoundRow[]>`
      select r.id, r.kind, r.duration_min, r.position, r.is_swappable,
             coalesce(jsonb_agg(jsonb_build_object('userId', u.id, 'name', u.name,
               'isRequired', rp.is_required) order by u.id) filter (where u.id is not null), '[]') as panelists,
             i.id as interview_id, i.status as interview_status, i.scheduled_start, i.scheduled_end,
             i.manual_override, i.acknowledged_blocker, i.external_event_id
      from interview_rounds r
      left join interview_round_panelists rp on rp.round_id = r.id and rp.tenant_id = r.tenant_id
      left join users u on u.id = rp.user_id and u.tenant_id = r.tenant_id
      left join interviews i on i.round_id = r.id and i.tenant_id = r.tenant_id
      where r.tenant_id = ${tx.tenantId}::uuid and r.loop_id = ${id}::uuid
      group by r.id, i.id order by r.position`;
    return {
      id: loop.id, applicationId: loop.application_id, status: loop.status,
      targetDate: loop.target_date, timezone: loop.timezone, candidateTimezone: loop.candidate_timezone,
      candidateWindowStart: loop.candidate_window_start, candidateWindowEnd: loop.candidate_window_end,
      heldBy: loop.held_by, heldByName: loop.held_by_name, holdExpiresAt: loop.hold_expires_at,
      version: loop.version, candidateId: loop.candidate_id, candidateName: loop.candidate_name,
      jobTitle: loop.job_title, businessStart: loop.business_start, businessEnd: loop.business_end,
      rounds: rounds.map((r) => ({
        id: r.id, kind: r.kind, durationMin: r.duration_min, position: r.position,
        isSwappable: r.is_swappable, panelists: r.panelists,
        interview: r.interview_id ? { id: r.interview_id, status: r.interview_status ?? 'unscheduled',
          start: r.scheduled_start, end: r.scheduled_end, manualOverride: r.manual_override ?? false,
          acknowledgedBlocker: r.acknowledged_blocker, externalEventId: r.external_event_id } : null,
      })),
    };
  }

  async acquireHold(tx: TenantTransaction, input: {
    loop: SchedulingRecord; userId: string; version: number; expiresAt: Date;
    rounds: Array<{ roundId: string; start: Date; end: Date; external: Array<{ userId: string; externalId: string }> }>;
  }): Promise<boolean> {
    const updated = await tx.sql`
      update interview_loops set status = 'held', held_by = ${input.userId}::uuid,
        hold_expires_at = ${input.expiresAt}, version = version + 1
      where tenant_id = ${tx.tenantId}::uuid and id = ${input.loop.id}::uuid
        and version = ${input.version}
        and (held_by is null or hold_expires_at <= now() or held_by = ${input.userId}::uuid)
      returning id`;
    if (updated.length !== 1) return false;
    for (const placement of input.rounds) {
      const round = input.loop.rounds.find((r) => r.id === placement.roundId)!;
      const interviewId = newId();
      const [written] = await tx.sql<{ id: string }[]>`
        insert into interviews (id, tenant_id, application_id, loop_id, round_id, kind,
          duration_min, scheduled_start, scheduled_end, status, external_provider)
        values (${interviewId}::uuid, ${tx.tenantId}::uuid, ${input.loop.applicationId}::uuid,
          ${input.loop.id}::uuid, ${round.id}::uuid, ${round.kind}, ${round.durationMin},
          ${placement.start}, ${placement.end}, 'pending', 'radicale')
        on conflict (round_id) do update set scheduled_start = excluded.scheduled_start,
          scheduled_end = excluded.scheduled_end, status = 'pending', external_provider = 'radicale'
        returning id`;
      for (const panelist of round.panelists) {
        await tx.sql`insert into interview_panelists (tenant_id, interview_id, user_id, is_required)
          values (${tx.tenantId}::uuid, ${written!.id}::uuid, ${panelist.userId}::uuid, ${panelist.isRequired})
          on conflict (interview_id,user_id) do update set is_required = excluded.is_required`;
      }
      for (const event of placement.external) {
        await tx.sql`insert into interview_calendar_events
          (tenant_id, interview_id, user_id, provider, external_event_id, status)
          values (${tx.tenantId}::uuid, ${written!.id}::uuid, ${event.userId}::uuid, 'radicale', ${event.externalId}, 'tentative')
          on conflict (interview_id,user_id) do update set external_event_id = excluded.external_event_id,
            provider = excluded.provider, status = excluded.status`;
      }
    }
    await tx.sql`insert into audit_log (tenant_id,actor_id,action,entity_type,entity_id,before,after)
      values (${tx.tenantId}::uuid,${input.userId}::uuid,'interview_loop.held','interview_loop',${input.loop.id}::uuid,
        ${tx.sql.json({ status: input.loop.status, version: input.loop.version })},
        ${tx.sql.json({ status: 'held', version: input.loop.version + 1, expiresAt: input.expiresAt.toISOString() })})`;
    return true;
  }

  async calendarEvents(tx: TenantTransaction, loopId: string): Promise<Array<{ interviewId: string; roundId: string; userId: string; externalId: string; start: Date; end: Date; kind: string }>> {
    return tx.sql`
      select e.interview_id as "interviewId", i.round_id as "roundId", e.user_id as "userId",
             e.external_event_id as "externalId", i.scheduled_start as start, i.scheduled_end as end, i.kind
      from interview_calendar_events e join interviews i on i.id=e.interview_id and i.tenant_id=e.tenant_id
      where e.tenant_id=${tx.tenantId}::uuid and i.loop_id=${loopId}::uuid`;
  }

  async sentResult(tx: TenantTransaction, loopId: string, key: string): Promise<unknown | null> {
    const [row] = await tx.sql<{ result: unknown }[]>`select result from interview_loop_sends
      where tenant_id=${tx.tenantId}::uuid and loop_id=${loopId}::uuid and idempotency_key=${key}::uuid`;
    return row?.result ?? null;
  }

  async confirmSend(tx: TenantTransaction, input: { loopId: string; userId: string; version: number }): Promise<boolean> {
    const updated = await tx.sql`update interview_loops set status='confirmed', held_by=null,
      hold_expires_at=null, version=version+1 where tenant_id=${tx.tenantId}::uuid and id=${input.loopId}::uuid
      and version=${input.version} and held_by=${input.userId}::uuid and hold_expires_at > now() returning id`;
    if (updated.length !== 1) return false;
    await tx.sql`update interviews set status='confirmed' where tenant_id=${tx.tenantId}::uuid and loop_id=${input.loopId}::uuid`;
    await tx.sql`update interview_calendar_events e set status='confirmed' from interviews i
      where e.interview_id=i.id and e.tenant_id=${tx.tenantId}::uuid and i.loop_id=${input.loopId}::uuid`;
    return true;
  }

  async recordSend(tx: TenantTransaction, input: { loopId: string; userId: string; key: string; result: unknown }): Promise<void> {
    await tx.sql`insert into interview_loop_sends(tenant_id,loop_id,idempotency_key,result)
      values (${tx.tenantId}::uuid,${input.loopId}::uuid,${input.key}::uuid,${tx.sql.json(input.result as never)})`;
    await tx.sql`insert into audit_log (tenant_id,actor_id,action,entity_type,entity_id,after)
      values (${tx.tenantId}::uuid,${input.userId}::uuid,'interview_loop.sent','interview_loop',${input.loopId}::uuid,${tx.sql.json(input.result as never)})`;
  }
}
