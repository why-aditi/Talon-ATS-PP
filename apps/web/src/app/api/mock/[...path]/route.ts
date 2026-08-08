/**
 * Stand-in for the review-inbox, candidates, offers and reports endpoints — spec 007 §5.
 * None of these routes exist yet.
 *
 * One dispatcher rather than a file per resource: five resources is five copies of the
 * same fixture-lookup boilerplate, and deleting this directory is the entire cleanup
 * when the real endpoints land.
 *
 * It lives under `/api/mock/*` and not `/v1/*` deliberately. `next.config.mjs` rewrites
 * `/v1/:path*` to the API, so a mock under `/v1` would depend on Next resolving
 * filesystem routes ahead of rewrites — true today, and not a thing to build on. A
 * separate namespace cannot collide at all.
 *
 * The one piece of real server behaviour it implements is the comp gate (§5.1), for the
 * reason `test/pipeline-handlers.ts` gives about `version` and conflict types: a stub
 * that says yes to everything makes the screen easier to build and wrong in exactly the
 * ways that matter. Comp is scope-gated at the API layer (CLAUDE.md §4.2) — a mock that
 * always returns it produces components written to render it unconditionally, and the
 * real endpoint's `null` becomes a crash discovered in staging.
 */
import {
  CandidateProfileSchema,
  ERROR_TYPES,
  ListCandidatesResponseSchema,
  ListOffersResponseSchema,
  OfferSchema,
  ReportsOverviewSchema,
  ReviewQueueResponseSchema,
} from '@talon/contracts';
import { NextResponse } from 'next/server';
import type { ZodSchema } from 'zod';
import {
  candidateProfiles,
  candidates,
  offers,
  offersById,
  reportsOverview,
  reviewQueue,
} from '../../../../lib/mock-fixtures';

/** Roles allowed to see base, equity, band and comp expectation. Mirrors spec 007 §9. */
const COMP_SCOPED = new Set(['admin', 'recruiting_lead', 'recruiter', 'hiring_manager']);

function problem(status: number, type: string, title: string): NextResponse {
  return NextResponse.json(
    { type, title, status },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/**
 * Reads the role claim off the bearer token WITHOUT verifying the signature.
 *
 * Acceptable only because this endpoint serves fixtures and grants nothing. The real
 * endpoint verifies; this one is a shape, not a boundary. It is written as a separate
 * function so that when these routes move to Fastify, the thing being replaced is
 * obvious rather than inlined into five handlers.
 *
 * Fails closed: an absent, malformed or unparseable token yields no comp scope
 * (§10 case 19). Failing open on a comp gate is the one direction that is never safe.
 */
function compScopeOf(request: Request): boolean {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;
  const payload = header.slice(7).split('.')[1];
  if (!payload) return false;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const role = (claims as { role?: unknown } | null)?.role;
    return typeof role === 'string' && COMP_SCOPED.has(role);
  } catch {
    return false;
  }
}

/**
 * Parses on the way out, the way `applications/routes.ts` does. Zod strips anything the
 * schema does not declare, so a fixture that grows a field cannot leak it — and a
 * fixture that drifts from its contract fails loudly here in dev rather than rendering
 * `undefined` on the screen (§10 case 20).
 */
function send<T>(schema: ZodSchema<T>, value: T): NextResponse {
  return NextResponse.json(schema.parse(value));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  const hasComp = compScopeOf(request);

  if (!request.headers.get('authorization')) {
    return problem(401, ERROR_TYPES.UNAUTHENTICATED, 'No session');
  }

  const [resource, id] = path;

  if (resource === 'review-queue' && !id) {
    return send(ReviewQueueResponseSchema, reviewQueue());
  }

  if (resource === 'candidates') {
    if (!id) return send(ListCandidatesResponseSchema, candidates());
    const build = candidateProfiles[id];
    if (!build) return problem(404, ERROR_TYPES.NOT_FOUND, 'No such candidate');
    const profile = build();
    // Null, not deleted. The screen renders "withheld" and "never stated" differently,
    // and only the caller's scope distinguishes them (§7.3, §10 cases 7 and 8).
    return send(CandidateProfileSchema, {
      ...profile,
      details: { ...profile.details, compExpectation: hasComp ? profile.details.compExpectation : null },
    });
  }

  if (resource === 'offers') {
    // The summary carries no comp at all, so the list needs no gating — the shape is
    // the protection, which is stronger than a filter someone can forget to apply.
    if (!id) return send(ListOffersResponseSchema, offers());
    const build = offersById[id];
    if (!build) return problem(404, ERROR_TYPES.NOT_FOUND, 'No such offer');
    const offer = build();
    return send(OfferSchema, { ...offer, comp: hasComp ? offer.comp : null });
  }

  if (resource === 'reports' && id === 'overview') {
    return send(ReportsOverviewSchema, reportsOverview());
  }

  return problem(404, ERROR_TYPES.NOT_FOUND, 'No such mock route');
}
