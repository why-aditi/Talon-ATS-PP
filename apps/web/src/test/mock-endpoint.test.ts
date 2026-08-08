/**
 * Spec 007 §12 — the mock endpoint.
 *
 * The load-bearing test here is the comp gate. Everything else on these four screens is
 * shape; comp is the one rule the mock enforces (§5.1), and it exists so components are
 * written against an API that can withhold a field. If someone later "simplifies" the
 * gate away because a fixture always has comp, this file fails.
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
import { describe, expect, it } from 'vitest';
import { GET } from '../app/api/mock/[...path]/route';
import { CANDIDATE_IDS, reviewQueue } from '../lib/mock-fixtures';
import { CANDIDATES } from './pipeline-fixtures';

const OFFER_ID = '0198f3a7-0001-7000-8000-000000000001';

/** An unsigned token — the mock reads the claim and never verifies it (§5.1). */
function tokenFor(role: string): string {
  const payload = Buffer.from(JSON.stringify({ role }), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

function call(path: string[], role: string | null = 'recruiter'): Promise<Response> {
  // Built conditionally rather than passing `headers: undefined` — the repo runs
  // `exactOptionalPropertyTypes`, so an explicit undefined is not the same as absent.
  const init: RequestInit = role ? { headers: { authorization: `Bearer ${tokenFor(role)}` } } : {};
  return GET(new Request('http://localhost/api/mock/' + path.join('/'), init), {
    params: Promise.resolve({ path }),
  });
}

describe('mock endpoint', () => {
  it('serves every route in a shape its contract accepts', async () => {
    const cases = [
      [['review-queue'], ReviewQueueResponseSchema],
      [['candidates'], ListCandidatesResponseSchema],
      [['candidates', CANDIDATE_IDS.ana], CandidateProfileSchema],
      [['offers'], ListOffersResponseSchema],
      [['offers', OFFER_ID], OfferSchema],
      [['reports', 'overview'], ReportsOverviewSchema],
    ] as const;

    for (const [path, schema] of cases) {
      const response = await call([...path]);
      expect(response.status, path.join('/')).toBe(200);
      const body: unknown = await response.json();
      expect(() => schema.parse(body), path.join('/')).not.toThrow();
    }
  });

  it('404s an unknown route and an unknown id', async () => {
    for (const path of [['nope'], ['candidates', CANDIDATE_IDS.david], ['offers', CANDIDATE_IDS.ana]]) {
      const response = await call(path);
      expect(response.status, path.join('/')).toBe(404);
      expect((await response.json()).type).toBe(ERROR_TYPES.NOT_FOUND);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }
  });

  it('401s with no bearer token', async () => {
    const response = await call(['review-queue'], null);
    expect(response.status).toBe(401);
    expect((await response.json()).type).toBe(ERROR_TYPES.UNAUTHENTICATED);
  });

  describe('comp gating', () => {
    it('gives comp to a role that has the scope', async () => {
      const profile = await (await call(['candidates', CANDIDATE_IDS.ana], 'recruiter')).json();
      expect(profile.details.compExpectation).toEqual({
        minCents: '20500000',
        maxCents: '22000000',
        currency: 'USD',
      });

      const offer = await (await call(['offers', OFFER_ID], 'hiring_manager')).json();
      expect(offer.comp?.baseCents).toBe('21000000');
      expect(offer.comp?.currency).toBe('USD');
    });

    it('withholds comp from a role that does not, as null rather than absent', async () => {
      const profile = await (await call(['candidates', CANDIDATE_IDS.ana], 'member')).json();
      expect(profile.details.compExpectation).toBeNull();
      // Present-and-null, not deleted: the screen distinguishes "withheld" from
      // "never stated" and only this shape lets it (§7.3).
      expect('compExpectation' in profile.details).toBe(true);

      const offer = await (await call(['offers', OFFER_ID], 'member')).json();
      expect(offer.comp).toBeNull();
      expect('comp' in offer).toBe(true);

      // A role the system cannot issue is also unscoped — `isRole` rejects it before
      // `hasScope` is asked. The previous version of these tests used exactly such a
      // string ('interviewer') for the whole unscoped case, so it passed by accident
      // rather than by exercising a real role.
      const bogus = await (await call(['offers', OFFER_ID], 'recruiting_lead')).json();
      expect(bogus.comp).toBeNull();
    });

    it('fails closed on a malformed token instead of erroring', async () => {
      const response = await GET(
        new Request('http://localhost/api/mock/offers/' + OFFER_ID, {
          headers: { authorization: 'Bearer not-a-jwt' },
        }),
        { params: Promise.resolve({ path: ['offers', OFFER_ID] }) },
      );
      expect(response.status).toBe(200);
      expect((await response.json()).comp).toBeNull();
    });

    it('never carries comp on the offer list, whatever the role', async () => {
      for (const role of ['admin', 'member']) {
        const list = await (await call(['offers'], role)).json();
        expect(list.items.length).toBeGreaterThan(0);
        for (const item of list.items) expect('comp' in item).toBe(false);
      }
    });
  });

  it('keeps candidate ids in step with the board fixtures', () => {
    // Avatar hue hashes off the candidate id. Two id lists means one person with two
    // colours across the board and the profile — the drift this catches is visual and
    // nobody would think to look for it.
    expect(CANDIDATE_IDS).toEqual(CANDIDATES);
  });

  it('keeps the review queue in step with the board it is drawn from', async () => {
    // The queue IS ENG-204's Applied column (§5.2). If the board says Tess has been
    // waiting 4 days and the inbox says 2, the two screens contradict each other about
    // the same person on the same afternoon.
    const { eng204Board } = await import('./pipeline-fixtures');
    const applied = eng204Board().columns[0]!;
    const byId = new Map(applied.cards.map((c) => [c.id, c]));

    for (const item of reviewQueue().items) {
      const card = byId.get(item.id);
      expect(card, `${item.name} is on the Applied column`).toBeDefined();
      expect(item.appliedDaysAgo, item.name).toBe(card!.daysInStage);
      expect(item.name).toBe(card!.name);
      expect(item.candidateId).toBe(card!.candidateId);
    }
    expect(reviewQueue().waiting).toBe(applied.count);
  });
});
