/**
 * The ONLY file in this module allowed to touch the database.
 *
 * Every query runs on `tx.sql` — the request's reserved connection, inside its
 * transaction, with `app.tenant_id` set. RLS is what makes another tenant's row
 * unreachable; the explicit `tenant_id` predicates below are the application check on
 * top of it, the same belt-and-braces the jobs repository uses.
 */
import type { CanonicalStage, Source, ApplicationStatus, JobStatus } from '@talon/contracts';
import type { TenantTransaction } from '../../request-context.js';

/**
 * What `sql.json()` actually accepts. `Record<string, unknown>` compiles here and then
 * fails at the driver, which is a worse place to find out — postgres.js types its own
 * `JSONValue` narrowly and a wider parameter type just defers the error to runtime.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

/** Spec 004 §2: the board serves at most this many cards per column. `count` still
 *  reports the column's true size, so the client can tell it was truncated. */
export const CARDS_PER_COLUMN = 200;

export interface BoardJobRow {
  id: string;
  reqCode: string;
  title: string;
  status: JobStatus;
  location: string;
  recruiter: { id: string; name: string } | null;
}

export interface BoardStageRow {
  stageId: string;
  name: string;
  canonical: CanonicalStage;
  position: number;
  slaDays: number | null;
  isTerminal: boolean;
  count: number;
  passRatePct: number;
  medianDaysInStage: number | null;
}

export interface BoardCardRow {
  id: string;
  stageId: string;
  candidateId: string;
  name: string;
  currentTitle: string;
  currentCompany: string;
  source: Source;
  status: ApplicationStatus;
  daysInStage: number;
  version: number;
}

/**
 * What a move needs before it decides, read under a row lock.
 *
 * Carries the whole card, not just the version: a 409 answers with `current` so the
 * client can reconcile without a second round trip, and fetching that separately after
 * the conflict would read outside the lock and could report a third state.
 */
export interface MovableApplication {
  id: string;
  jobId: string;
  candidateId: string;
  name: string;
  currentTitle: string;
  currentCompany: string;
  source: Source;
  status: ApplicationStatus;
  currentStageId: string;
  currentStageName: string;
  /** The rank before the write, so a reorder's audit row can answer "where was it?"
   *  — which is the only question a reorder audit exists to answer. */
  boardRank: string;
  currentStageCanonical: CanonicalStage;
  daysInStage: number;
  version: number;
}

export class ApplicationsRepository {
  async findBoardJob(tx: TenantTransaction, jobId: string): Promise<BoardJobRow | null> {
    const [row] = await tx.sql<
      {
        id: string;
        req_code: string;
        title: string;
        status: JobStatus;
        location: string;
        recruiter_id: string | null;
        recruiter_name: string | null;
      }[]
    >`
      select j.id, j.req_code, j.title, j.status, j.location,
             u.id as recruiter_id, u.name as recruiter_name
      from jobs j
      left join users u on u.id = j.recruiter_id and u.tenant_id = j.tenant_id
      where j.id = ${jobId} and j.tenant_id = ${tx.tenantId}`;
    if (!row) return null;
    return {
      id: row.id,
      reqCode: row.req_code,
      title: row.title,
      status: row.status,
      location: row.location,
      recruiter: row.recruiter_id && row.recruiter_name ? { id: row.recruiter_id, name: row.recruiter_name } : null,
    };
  }

  /**
   * Every column with its statistics, in one statement.
   *
   * Both figures come from `stage_transitions`, never from the cards currently in the
   * column — those have incomplete dwells and are a different population. Seven
   * correlated aggregates per board load is the shape to avoid, so the CTEs compute
   * all stages at once and the stage list drives a left join.
   */
  async findBoardStages(tx: TenantTransaction, jobId: string): Promise<BoardStageRow[]> {
    const rows = await tx.sql<
      {
        stage_id: string;
        name: string;
        canonical: CanonicalStage;
        position: number;
        sla_days: number | null;
        is_terminal: boolean;
        card_count: number;
        pass_rate_pct: number;
        median_days: number | null;
      }[]
    >`
      with total as (
        -- Every application on the job, rejected and withdrawn included: they reached
        -- those stages, and a funnel that drops them overstates every rate.
        select count(*)::int as n
        from applications where job_id = ${jobId} and tenant_id = ${tx.tenantId}
      ),
      live as (
        select current_stage_id as stage_id, count(*)::int as n
        from applications where job_id = ${jobId} and tenant_id = ${tx.tenantId}
        group by current_stage_id
      ),
      reach as (
        -- distinct: an application that re-entered a stage must count once. Re-entry is
        -- legal — stage_transitions is append-only and a correction is a new row.
        select st.to_stage_id as stage_id, count(distinct st.application_id)::int as reached
        from stage_transitions st
        where st.tenant_id = ${tx.tenantId}
          and st.to_stage_id in (select id from job_stages where job_id = ${jobId})
        group by st.to_stage_id
      ),
      dwell as (
        -- The EARLIEST exit after each entry. A plain self-join on
        -- (nxt.from_stage_id = ent.to_stage_id) pairs entry #1 with every later exit,
        -- so a re-entered stage reports an inflated median. The ENG-204 seed has no
        -- re-entries, so metrics.test.ts passes either way and the bug hides.
        select ent.to_stage_id as stage_id,
               percentile_cont(0.5) within group (
                 order by extract(epoch from (x.exit_at - ent.occurred_at))
               ) as median_seconds
        from stage_transitions ent
        cross join lateral (
          select min(nxt.occurred_at) as exit_at
          from stage_transitions nxt
          where nxt.tenant_id = ent.tenant_id
            and nxt.application_id = ent.application_id
            and nxt.from_stage_id = ent.to_stage_id
            and nxt.occurred_at > ent.occurred_at
        ) x
        where ent.tenant_id = ${tx.tenantId}
          and ent.to_stage_id in (select id from job_stages where job_id = ${jobId})
          and x.exit_at is not null
        group by ent.to_stage_id
      )
      select js.id as stage_id, js.name, js.canonical, js.position,
             js.sla_days, js.is_terminal,
             coalesce(live.n, 0) as card_count,
             case when total.n = 0 then 0
                  else round(100.0 * coalesce(reach.reached, 0) / total.n)::int
             end as pass_rate_pct,
             -- Cast to numeric first: percentile_cont returns double precision, and
             -- round() on a double is banker's rounding — a true 2.5-day median would
             -- report 2 and a 3.5 would report 4. Half-away-from-zero is what the
             -- board's "median 3d" means to a recruiter.
             round((dwell.median_seconds / 86400)::numeric)::int as median_days
      from job_stages js
      cross join total
      left join live  on live.stage_id  = js.id
      left join reach on reach.stage_id = js.id
      left join dwell on dwell.stage_id = js.id
      where js.job_id = ${jobId} and js.tenant_id = ${tx.tenantId}
      order by js.position`;

    return rows.map((r) => ({
      stageId: r.stage_id,
      name: r.name,
      canonical: r.canonical,
      position: r.position,
      slaDays: r.sla_days,
      isTerminal: r.is_terminal,
      count: r.card_count,
      passRatePct: r.pass_rate_pct,
      medianDaysInStage: r.median_days,
    }));
  }

  /**
   * The top `CARDS_PER_COLUMN` cards of every column, in board order.
   *
   * `collate "C"` is not decoration. `board_rank` is compared here by Postgres and in
   * JavaScript by the client; those agree only under byte order, and Postgres text
   * ordering otherwise follows the database collation. Without it a board can render
   * in a different order than it was saved in, which reads as a bug in dragging.
   */
  async findBoardCards(tx: TenantTransaction, jobId: string): Promise<BoardCardRow[]> {
    const rows = await tx.sql<
      {
        id: string;
        stage_id: string;
        candidate_id: string;
        name: string;
        current_title: string | null;
        current_company: string | null;
        source: Source;
        status: ApplicationStatus;
        days_in_stage: number;
        version: number;
      }[]
    >`
      select id, stage_id, candidate_id, name, current_title, current_company,
             source, status, days_in_stage, version
      from (
        select a.id, a.current_stage_id as stage_id, a.candidate_id,
               c.name, c.current_title, c.current_company,
               a.source, a.status, a.version,
               floor(extract(epoch from (now() - a.stage_entered_at)) / 86400)::int as days_in_stage,
               row_number() over (
                 partition by a.current_stage_id order by a.board_rank collate "C", a.id
               ) as rn
        from applications a
        join candidates c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
        where a.job_id = ${jobId} and a.tenant_id = ${tx.tenantId}
      ) ranked
      where rn <= ${CARDS_PER_COLUMN}
      -- The window orders inside the subquery; Postgres does not promise that order
      -- survives the outer scan, and the service consumes this array positionally. On
      -- nine rows it holds by luck; on 200 with a parallel plan it need not. Dropping
      -- it one statement after the collate comment that exists to protect the ordering
      -- would have been the exact bug that comment describes.
      order by stage_id, rn`;

    return rows.map((r) => ({
      id: r.id,
      stageId: r.stage_id,
      candidateId: r.candidate_id,
      name: r.name,
      // Nullable on candidates; the card renders "title at company" and an empty
      // string is what the reference shows for a candidate with neither.
      currentTitle: r.current_title ?? '',
      currentCompany: r.current_company ?? '',
      source: r.source,
      status: r.status,
      daysInStage: r.days_in_stage,
      version: r.version,
    }));
  }

  /**
   * Locks the application for the duration of the transaction and reports what a move
   * needs to decide. `for update` rather than a conditional UPDATE plus a re-read: the
   * check and the write have to be one atomic step, and the lock is what makes the
   * two 409s distinguishable without racing a concurrent mover.
   */
  async lockForMove(tx: TenantTransaction, applicationId: string): Promise<MovableApplication | null> {
    const [row] = await tx.sql<
      {
        id: string;
        job_id: string;
        candidate_id: string;
        name: string;
        current_title: string | null;
        current_company: string | null;
        source: Source;
        status: ApplicationStatus;
        current_stage_id: string;
        stage_name: string;
        board_rank: string;
        canonical: CanonicalStage;
        days_in_stage: number;
        version: number;
      }[]
    >`
      select a.id, a.job_id, a.candidate_id, c.name, c.current_title, c.current_company,
             a.source, a.status, a.current_stage_id, a.version, a.board_rank,
             js.name as stage_name, js.canonical,
             floor(extract(epoch from (now() - a.stage_entered_at)) / 86400)::int as days_in_stage
      from applications a
      join candidates c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
      join job_stages js on js.id = a.current_stage_id
      where a.id = ${applicationId} and a.tenant_id = ${tx.tenantId}
      for update of a`;
    if (!row) return null;
    return {
      id: row.id,
      jobId: row.job_id,
      candidateId: row.candidate_id,
      name: row.name,
      currentTitle: row.current_title ?? '',
      currentCompany: row.current_company ?? '',
      source: row.source,
      status: row.status,
      currentStageId: row.current_stage_id,
      currentStageName: row.stage_name,
      boardRank: row.board_rank,
      currentStageCanonical: row.canonical,
      daysInStage: row.days_in_stage,
      version: row.version,
    };
  }

  /** The stage's own row, used to validate the destination belongs to this job. */
  async findStage(
    tx: TenantTransaction,
    jobId: string,
    stageId: string,
  ): Promise<{ id: string; name: string; canonical: CanonicalStage; isTerminal: boolean } | null> {
    const [row] = await tx.sql<{ id: string; name: string; canonical: CanonicalStage; is_terminal: boolean }[]>`
      select id, name, canonical, is_terminal
      from job_stages
      where id = ${stageId} and job_id = ${jobId} and tenant_id = ${tx.tenantId}`;
    return row ? { id: row.id, name: row.name, canonical: row.canonical, isTerminal: row.is_terminal } : null;
  }

  /** The ranks of the two named neighbours, so the service can pick a key between them.
   *  A neighbour that has since moved or been deleted simply comes back null, which the
   *  service treats as "no bound that side" rather than an error. */
  async neighbourRanks(
    tx: TenantTransaction,
    stageId: string,
    beforeId: string | null,
    afterId: string | null,
  ): Promise<{ before: string | null; after: string | null }> {
    const ids = [beforeId, afterId].filter((id): id is string => id !== null);
    if (ids.length === 0) return { before: null, after: null };
    const rows = await tx.sql<{ id: string; board_rank: string }[]>`
      select id, board_rank from applications
      where id in ${tx.sql(ids)} and current_stage_id = ${stageId} and tenant_id = ${tx.tenantId}`;
    const rank = (id: string | null) => (id ? (rows.find((r) => r.id === id)?.board_rank ?? null) : null);
    return { before: rank(beforeId), after: rank(afterId) };
  }

  /** The last rank in a column, for an append. */
  async lastRank(tx: TenantTransaction, stageId: string): Promise<string | null> {
    const [row] = await tx.sql<{ board_rank: string }[]>`
      select board_rank from applications
      where current_stage_id = ${stageId} and tenant_id = ${tx.tenantId}
      order by board_rank collate "C" desc, id desc
      limit 1`;
    return row?.board_rank ?? null;
  }

  /**
   * Rank-only write. Touches `board_rank` and `updated_at` and NOTHING else.
   *
   * Separate from `moveStage` so non-negotiable #18 is structural: there is no code
   * path on which a reorder reaches the statement that bumps `version`. If these were
   * one method with a flag, one wrong argument would produce 409s on unrelated cards
   * that look like a race and are not.
   */
  async updateRank(tx: TenantTransaction, applicationId: string, rank: string): Promise<void> {
    await tx.sql`
      update applications
      set board_rank = ${rank}, updated_at = now()
      where id = ${applicationId} and tenant_id = ${tx.tenantId}`;
  }

  /**
   * The stage write. Bumps `version`, resets `stage_entered_at`, and is the only
   * statement here that does either.
   *
   * `where version = ${expectedVersion}` even though the caller holds the row lock:
   * the lock makes it correct, the predicate makes it self-evidently correct, and it
   * costs nothing.
   */
  async moveStage(
    tx: TenantTransaction,
    args: {
      applicationId: string;
      toStageId: string;
      rank: string;
      expectedVersion: number;
      status: ApplicationStatus;
    },
  ): Promise<number> {
    const rows = await tx.sql<{ version: number }[]>`
      update applications
      set current_stage_id = ${args.toStageId},
          stage_entered_at = now(),
          board_rank       = ${args.rank},
          status           = ${args.status},
          version          = version + 1,
          updated_at       = now()
      where id = ${args.applicationId}
        and tenant_id = ${tx.tenantId}
        and version = ${args.expectedVersion}
      returning version`;
    const version = rows[0]?.version;
    if (version === undefined) {
      // The lock was held, so this cannot be a lost race — it is a caller that did not
      // check, and silently succeeding would be worse than failing loudly.
      throw new Error('moveStage updated no row despite holding the lock');
    }
    return version;
  }

  /** Append-only. There is no update or delete grant on this table for the app role. */
  async appendTransition(
    tx: TenantTransaction,
    args: { applicationId: string; fromStageId: string; toStageId: string; actorId: string; reason?: string | undefined },
  ): Promise<void> {
    await tx.sql`
      insert into stage_transitions (tenant_id, application_id, from_stage_id, to_stage_id, actor_id, reason)
      values (${tx.tenantId}, ${args.applicationId}, ${args.fromStageId}, ${args.toStageId},
              ${args.actorId}, ${args.reason ?? null})`;
  }

  async appendActivity(
    tx: TenantTransaction,
    args: { applicationId: string; type: string; actorId: string; meta: JsonObject },
  ): Promise<void> {
    await tx.sql`
      insert into activities (tenant_id, application_id, type, actor_id, meta)
      values (${tx.tenantId}, ${args.applicationId}, ${args.type}, ${args.actorId}, ${tx.sql.json(args.meta)})`;
  }

  /**
   * The audit row. Non-negotiable #13: EVERY mutation writes one, with actor, before,
   * after, IP and request id.
   *
   * Distinct from `activities`, which is the candidate's human-readable timeline and
   * carries none of those. The identity module already writes a real `audit_log` row
   * for sign-in; these are the first business mutations in the repo, so this is the
   * pattern every module after them inherits.
   *
   * Inserted directly rather than through a `security definer` function: sign-in needs
   * one because it runs before tenant context exists, and this does not — the row is
   * written inside the request's transaction with `app.tenant_id` already set.
   */
  async appendAudit(
    tx: TenantTransaction,
    args: {
      action: string;
      entityId: string;
      before: JsonObject;
      after: JsonObject;
      actorId: string;
      ip: string | null;
      requestId: string | null;
    },
  ): Promise<void> {
    await tx.sql`
      insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, before, after, ip, request_id)
      values (${tx.tenantId}, ${args.actorId}, ${args.action}, 'application', ${args.entityId},
              ${tx.sql.json(args.before)}, ${tx.sql.json(args.after)}, ${args.ip}, ${args.requestId})`;
  }

  /**
   * The outbox row, written in the same transaction as the state change it describes.
   * Nothing is published inline: a failed publish must never roll back a committed
   * state change, and a committed state change must never lose its event.
   *
   * The payload carries ids and versions only (ARCHITECTURE §6.1) — never entity
   * state, so a stale broadcast cannot write bad data into a client's cache.
   */
  async appendOutbox(
    tx: TenantTransaction,
    args: { aggregateId: string; eventType: string; payload: JsonObject },
  ): Promise<void> {
    await tx.sql`
      insert into outbox (tenant_id, aggregate, aggregate_id, event_type, payload)
      values (${tx.tenantId}, 'application', ${args.aggregateId}, ${args.eventType}, ${tx.sql.json(args.payload)})`;
  }
}
