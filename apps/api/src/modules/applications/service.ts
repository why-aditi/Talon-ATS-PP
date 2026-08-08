/**
 * Orchestration; the only place transactions begin.
 *
 * `moveStage` is the SINGLE entry point for advancing an application (non-negotiable
 * #5). The review inbox's advance action calls this method — it does not reimplement
 * it. There is no second caller yet, which is the only reason the rule is asserted
 * here rather than demonstrated, so it is written down where the next person will look.
 */
import type {
  ApplicationCard,
  Board,
  CreateApplicationBody,
  CreateApplicationResponse,
  MoveStageBody,
  ReorderBody,
} from '@talon/contracts';
import { ERROR_TYPES } from '@talon/contracts';
import { FIRST_RANK, between, hasScope, isTerminalStage, nextActionFor } from '@talon/domain';
import { HttpProblem, forbidden, notFound } from '../../errors.js';
import type { AuthenticatedUser, TenantTransaction } from '../../request-context.js';

/** Where the request came from, for the audit row. Optional so a caller that has no
 *  HTTP context (a worker, a future console command) is not forced to invent one. */
export interface RequestOrigin {
  ip?: string | undefined;
  requestId?: string | undefined;
}
import type { ApplicationsRepository, BoardCardRow, MovableApplication } from './repository.js';

/** The event the relay publishes. Ids and versions only (ARCHITECTURE §6.1). */
const STAGE_CHANGED = 'application.stage_changed';

function toCard(row: BoardCardRow, canonical: Parameters<typeof nextActionFor>[0]): ApplicationCard {
  return {
    id: row.id,
    candidateId: row.candidateId,
    name: row.name,
    currentTitle: row.currentTitle,
    currentCompany: row.currentCompany,
    source: row.source,
    status: row.status,
    daysInStage: row.daysInStage,
    // Derived, not stored — spec 004 §5. The qualifier ("Call Tue") arrives with
    // scheduling; until then the verb stands alone.
    nextAction: nextActionFor(canonical),
    version: row.version,
  };
}

export class ApplicationsService {
  readonly #repository: ApplicationsRepository;

  constructor({ applicationsRepository }: { applicationsRepository: ApplicationsRepository }) {
    this.#repository = applicationsRepository;
  }

  async getBoard(tx: TenantTransaction, jobId: string): Promise<Board> {
    const job = await this.#repository.findBoardJob(tx, jobId);
    // 404, never 403: a 403 confirms the id exists, which is the leak. Another
    // tenant's job and an id that was never issued answer identically.
    if (!job) throw notFound('No job with that id exists in this tenant.');

    const [stages, cards] = await Promise.all([
      this.#repository.findBoardStages(tx, jobId),
      this.#repository.findBoardCards(tx, jobId),
    ]);

    return {
      job,
      // Rejected and withdrawn are OUTCOMES, not columns. They are real `job_stages`
      // rows — an application has to land somewhere when it is rejected — but the
      // reference board shows Applied through Hired and nothing else, because a
      // rejected candidate has left the pipeline rather than moved along it. Serving
      // them would put two permanently empty columns on every board and push Hired off
      // the right edge.
      columns: stages
        .filter((stage) => stage.canonical !== 'rejected' && stage.canonical !== 'withdrawn')
        .map((stage) => ({
        stageId: stage.stageId,
        name: stage.name,
        canonical: stage.canonical,
        position: stage.position,
        slaDays: stage.slaDays,
        isTerminal: stage.isTerminal,
        // The column's TRUE size. `cards` below is capped, so this is how the client
        // knows it is looking at a truncated column.
        count: stage.count,
        stats: {
          passRatePct: stage.passRatePct,
          // Null on a terminal stage and before anyone has left: nobody exits Hired,
          // so no completed dwell exists and there is no median to report.
          medianDaysInStage: stage.isTerminal ? null : stage.medianDaysInStage,
        },
        cards: cards.filter((c) => c.stageId === stage.stageId).map((c) => toCard(c, stage.canonical)),
      })),
    };
  }

  /**
   * Advance or move an application between stages.
   *
   * Everything below happens inside the caller's transaction: the transition, the
   * denormalized `stage_entered_at`, the version bump, the activity and the outbox row
   * commit together or not at all. Nothing is published inline — a failed publish must
   * never roll back a committed state change, and a committed state change must never
   * lose its event.
   */
  async moveStage(
    tx: TenantTransaction,
    user: AuthenticatedUser,
    applicationId: string,
    body: MoveStageBody,
    context: RequestOrigin = {},
  ): Promise<ApplicationCard> {
    // Locks the row for the rest of the transaction, so the checks below and the write
    // are one atomic step rather than a read someone else can invalidate.
    const application = await this.#repository.lockForMove(tx, applicationId);
    if (!application) throw notFound('That application is no longer on this board.');

    // Validated before the FK would reject it: the composite key
    // (job_id, current_stage_id) already makes a cross-job stage structurally
    // impossible, but letting Postgres raise it surfaces a constraint violation as a
    // 500 instead of a 404.
    const destination = await this.#repository.findStage(tx, application.jobId, body.toStageId);
    if (!destination) throw notFound('That stage is not on this job.');

    // FROM-STAGE FIRST, and answered regardless of version.
    //
    // Silently re-applying a stage change over someone else's move corrupts the
    // append-only transition log, which is worse than acting on a stale version. This
    // ordering is the whole reason the two 409s are separate types.
    if (application.currentStageId !== body.fromStageId) {
      throw this.#conflict(ERROR_TYPES.STAGE_MOVED, `${application.name} has already moved`, application);
    }

    if (application.version !== body.version) {
      throw this.#conflict(ERROR_TYPES.STAGE_VERSION_CONFLICT, `${application.name} has changed`, application);
    }

    // Rejection and withdrawal have their own flows, which carry more than a stage id
    // (a reason code, an optional templated email — PRD §5.3). Accepting them here
    // half-applies: `current_stage_id` would move while `status` stayed 'active', and
    // the application would then vanish from the board entirely, because those columns
    // are filtered out of the response above.
    if (destination.canonical === 'rejected' || destination.canonical === 'withdrawn') {
      throw new HttpProblem(
        422,
        ERROR_TYPES.NOT_A_BOARD_MOVE,
        'Not a board move',
        `${destination.name} is reached by rejecting or withdrawing ${application.name}, not by moving the card.`,
      );
    }

    // PRD §5.4: a move to a terminal stage records why. The board blocks these
    // client-side until the prompt exists (spec 003 OQ-1), so this is the backstop for
    // any other caller.
    if (isTerminalStage(destination.canonical) && !body.reason) {
      throw new HttpProblem(
        422,
        ERROR_TYPES.REASON_REQUIRED,
        'A reason is required',
        `Moving ${application.name} to ${destination.name} needs a reason.`,
      );
    }

    const rank = await this.#rankFor(tx, body.toStageId, body.beforeId ?? null, body.afterId ?? null);

    // `hired` is the only destination that changes the application's own status;
    // rejected and withdrawn arrive through their own flows, which carry more than a
    // stage id.
    const status = destination.canonical === 'hired' ? 'hired' : application.status;

    const version = await this.#repository.moveStage(tx, {
      applicationId,
      toStageId: body.toStageId,
      rank,
      expectedVersion: body.version,
      status,
    });

    await this.#repository.appendTransition(tx, {
      applicationId,
      fromStageId: application.currentStageId,
      toStageId: body.toStageId,
      actorId: user.id,
      reason: body.reason,
    });

    await this.#repository.appendActivity(tx, {
      applicationId,
      type: 'stage_changed',
      actorId: user.id,
      meta: { fromStageId: application.currentStageId, toStageId: body.toStageId, version },
    });

    await this.#repository.appendOutbox(tx, {
      aggregateId: applicationId,
      eventType: STAGE_CHANGED,
      // Ids and versions only: a consumer refetches what it needs, so a stale
      // broadcast can never write bad data into a cache.
      payload: { applicationId, jobId: application.jobId, toStageId: body.toStageId, version },
    });

    // Non-negotiable #13. `activities` above is the candidate's timeline; this is the
    // security record, and it is the one that carries who, from where, and what changed.
    await this.#repository.appendAudit(tx, {
      action: 'application.stage_changed',
      entityId: applicationId,
      before: { stageId: application.currentStageId, version: application.version, status: application.status },
      after: { stageId: body.toStageId, version, status },
      actorId: user.id,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
    });

    return {
      id: application.id,
      candidateId: application.candidateId,
      name: application.name,
      currentTitle: application.currentTitle,
      currentCompany: application.currentCompany,
      source: application.source,
      status,
      // The move reset it, so the card reads 0 rather than the pre-move dwell.
      daysInStage: 0,
      nextAction: nextActionFor(destination.canonical),
      version,
    };
  }

  /**
   * Position only. Carries no version and returns no new one (non-negotiable #18):
   * bumping it here would 409 an unrelated in-flight stage move, which reads as a race
   * and is not one. Last-write-wins — position is not worth a conflict dialog.
   */
  async reorder(
    tx: TenantTransaction,
    user: AuthenticatedUser,
    applicationId: string,
    body: ReorderBody,
    context: RequestOrigin = {},
  ): Promise<ApplicationCard> {
    const application = await this.#repository.lockForMove(tx, applicationId);
    if (!application) throw notFound('That application is no longer on this board.');

    const rank = await this.#rankFor(
      tx,
      application.currentStageId,
      body.beforeId ?? null,
      body.afterId ?? null,
    );
    await this.#repository.updateRank(tx, applicationId, rank);

    // A reorder is still a mutation (#13). It carries no version because position is
    // last-write-wins, so `before`/`after` name the rank rather than the version.
    await this.#repository.appendAudit(tx, {
      action: 'application.reordered',
      entityId: applicationId,
      // Symmetric: a reorder changes `board_rank` and nothing else, so a `before`
      // without the old rank cannot answer where the card was — which is the whole
      // question this row exists to answer.
      before: { stageId: application.currentStageId, boardRank: application.boardRank },
      after: { stageId: application.currentStageId, boardRank: rank },
      actorId: user.id,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
    });

    return {
      id: application.id,
      candidateId: application.candidateId,
      name: application.name,
      currentTitle: application.currentTitle,
      currentCompany: application.currentCompany,
      source: application.source,
      status: application.status,
      daysInStage: application.daysInStage,
      nextAction: nextActionFor(application.currentStageCanonical),
      version: application.version,
    };
  }

  /**
   * A key between the two named neighbours.
   *
   * Neighbours go stale: by the time the write lands, the card the client named may
   * have moved or been deleted. A missing one is treated as "no bound that side"
   * rather than an error — the drop still has to land somewhere sensible, and failing
   * a move because a *different* card moved would be its own bug.
   */
  async #rankFor(
    tx: TenantTransaction,
    stageId: string,
    beforeId: string | null,
    afterId: string | null,
  ): Promise<string> {
    const { before, after } = await this.#repository.neighbourRanks(tx, stageId, beforeId, afterId);

    // `beforeId` names the card this one goes ABOVE, so its rank is the upper bound.
    //
    // Both bounds are read UNLOCKED and were named by the client from a board it read
    // earlier, so by now they may not be adjacent — or even ordered. Two recruiters
    // dragging in one column is the ordinary case, not an exotic one, and `between`
    // throws on an inverted pair. Falling back to the single bound that still makes
    // sense keeps a routine race a successful move rather than a 500 (spec §8.3).
    if (before !== null && after !== null && after < before) {
      try {
        return between(after, before);
      } catch {
        // The pair was ordered but admits no key between them. Land just above the
        // lower neighbour instead of failing the drag.
      }
    }
    if (before !== null) return between(null, before);
    if (after !== null) return between(after, null);

    // Neither resolved: append. An empty column gets the mid-space first key so the
    // next inserts either side of it stay short.
    const last = await this.#repository.lastRank(tx, stageId);
    return last === null ? FIRST_RANK : between(last, null);
  }

  #conflict(type: string, title: string, application: MovableApplication): HttpProblem {
    return new HttpProblem(409, type, title, `${application.name} is now in ${application.currentStageName}.`, {
      // The client reconciles from this rather than issuing a second request, and it
      // is read under the same lock as the checks, so it cannot report a third state.
      current: {
        id: application.id,
        candidateId: application.candidateId,
        name: application.name,
        currentTitle: application.currentTitle,
        currentCompany: application.currentCompany,
        source: application.source,
        status: application.status,
        daysInStage: application.daysInStage,
        nextAction: nextActionFor(application.currentStageCanonical),
        version: application.version,
      },
      // `current` alone does not say WHERE the card is, and the client names the stage
      // in its own sentence rather than rendering ours.
      currentStageName: application.currentStageName,
    });
  }

  /**
   * Candidate intake. Spec 005 §4.5.
   *
   * Four writes, one transaction, all or none:
   *
   *   1. the candidate (or an existing one, verified to be this tenant's)
   *   2. the application
   *   3. its FIRST `stage_transitions` row, `from_stage_id` null
   *   4. the audit row, and the outbox event
   *
   * Step 3 is not a follow-up. Non-negotiable #4 makes every pipeline metric
   * derive from `stage_transitions`, so an application created without its first
   * entry is invisible to time-in-stage and conversion for its whole life —
   * silently, and unfixably without a correction row.
   *
   * Resumes are not here. Spec 005 §5 needs a quarantine bucket, a scanner and a
   * separate download subdomain (#17), none of which exist; attaching files to an
   * intake that cannot scan them is the one shortcut this feature must not take.
   */
  async createApplication(
    tx: TenantTransaction,
    user: AuthenticatedUser,
    body: CreateApplicationBody,
    context: RequestOrigin = {},
  ): Promise<CreateApplicationResponse> {
    // Comp expectation is scope-gated exactly as a job's band is (#2). Checked
    // before anything is written, so a refusal costs no rows.
    const sendsComp =
      body.compExpectationMinCents !== undefined ||
      body.compExpectationMaxCents !== undefined ||
      body.compExpectationCurrency !== undefined;
    if (sendsComp && !hasScope(user.role, 'comp:read')) {
      throw forbidden('You do not have permission to record a compensation expectation.');
    }

    const job = await this.#repository.findBoardJob(tx, body.jobId);
    // 404 and not 403: another tenant's job id must be indistinguishable from one
    // that was never issued (§6.4).
    if (!job) throw notFound('No job with that id exists in this tenant.');

    const stage = body.stageId
      ? await this.#repository.findStageInJob(tx, body.jobId, body.stageId)
      : await this.#repository.firstStageOfJob(tx, body.jobId);
    if (!stage) {
      throw notFound(
        body.stageId
          ? 'That stage is not on this job.'
          : 'This job has no stages, so it cannot accept an application.',
      );
    }

    let candidateId: string;
    if (body.candidateId) {
      // Existence is checked through the tenant-scoped repository, so another
      // tenant's candidate id is simply not found.
      if (!(await this.#repository.candidateExists(tx, body.candidateId))) {
        throw notFound('No candidate with that id exists in this tenant.');
      }
      candidateId = body.candidateId;
    } else {
      const c = body.candidate!;
      candidateId = await this.#repository.insertCandidate(tx, {
        name: c.name,
        email: c.email ?? null,
        phone: c.phone ?? null,
        location: c.location ?? null,
        currentTitle: c.currentTitle ?? null,
        currentCompany: c.currentCompany ?? null,
        links: c.links,
      });
    }

    /*
      The top of the column, not the bottom: a candidate somebody just added and
      cannot see without scrolling reads as an add that failed.

      The fallback is not defensive padding. `between` refuses to produce a key
      above one ending in the lowest digit, and every prepend makes the top key
      one digit longer — so the SECOND intake into a column was a 500 until this
      existed. When the top cannot be beaten, land immediately below it, which is
      still the first screenful.
    */
    const [topRank, secondRank] = await this.#repository.topTwoRanks(tx, stage.id);
    let boardRank: string;
    if (topRank === undefined) {
      boardRank = FIRST_RANK;
    } else {
      try {
        boardRank = between(null, topRank);
      } catch {
        boardRank = between(topRank, secondRank ?? null);
      }
    }

    /*
      The unique index on (tenant_id, candidate_id, job_id) is the arbiter, not a
      pre-read: a check-then-insert loses the race, and this is the shape that
      cannot. 23505 here means the person already has an application on this job
      — a fact about the world, so a 409 with its own type rather than a 500.

      Spec 005 §10.9 said duplicates were allowed and creates a second row. That
      was wrong about the schema, which has forbidden it since 0001. The spec is
      corrected rather than the constraint relaxed: re-applying to a req is a
      reopened application, not a second one, and two rows would double-count the
      person in every funnel metric.
    */
    let applicationId: string;
    try {
      applicationId = await this.#repository.insertApplication(tx, {
      candidateId,
      jobId: body.jobId,
      stageId: stage.id,
      boardRank,
      source: body.source,
      referredById: body.referredById ?? null,
      compExpectationMinCents: body.compExpectationMinCents ?? null,
      compExpectationMaxCents: body.compExpectationMaxCents ?? null,
      compExpectationCurrency: body.compExpectationCurrency ?? null,
      noticePeriodDays: body.noticePeriodDays ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpProblem(
          409,
          ERROR_TYPES.ALREADY_APPLIED,
          'Already applied',
          'This candidate already has an application on this job.',
        );
      }
      throw error;
    }

    // Append-only, and the first row of this application's history (#4).
    await this.#repository.appendTransition(tx, {
      applicationId,
      fromStageId: null,
      toStageId: stage.id,
      actorId: user.id,
    });

    await this.#repository.appendAudit(tx, {
      action: 'application.created',
      entityId: applicationId,
      before: {},
      after: { candidateId, jobId: body.jobId, stageId: stage.id, source: body.source },
      actorId: user.id,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
    });

    await this.#repository.appendOutbox(tx, {
      aggregateId: applicationId,
      eventType: 'application.created',
      // Ids only. A payload carrying comp expectation would put scope-gated data
      // into every consumer's queue, where the HTTP gate cannot reach it.
      payload: { applicationId, candidateId, jobId: body.jobId, stageId: stage.id },
    });

    // Read back through the board's own projection so the card the client
    // receives is the same shape, and the same derivation, as the board's.
    const cards = await this.#repository.findBoardCards(tx, body.jobId);
    const created = cards.find((c) => c.id === applicationId);
    if (!created) throw new Error('created application could not be read back');
    const stages = await this.#repository.findBoardStages(tx, body.jobId);
    const canonical = stages.find((s) => s.stageId === stage.id)?.canonical ?? 'applied';

    return { application: toCard(created, canonical), stageId: stage.id };
  }
}

/** 23505. Narrow on purpose — any other database error is not ours to swallow. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
