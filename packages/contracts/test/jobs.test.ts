import { describe, expect, test } from 'vitest';
import {
  JobSchema,
  ListJobsQuerySchema,
  ListJobsResponseSchema,
  StageDistributionSchema,
} from '../src/index.js';

const job = (over: Record<string, unknown> = {}) => ({
  id: '018f0000-0000-7000-8000-000000000001',
  reqCode: 'ENG-204',
  title: 'Senior Backend Engineer',
  department: 'Engineering',
  location: 'Remote',
  employmentType: 'full_time',
  status: 'active',
  inProcessCount: 8,
  activeCount: 9,
  stageDistribution: {
    applied: 4,
    screen: 2,
    onsite: 1,
    offer: 1,
    hired: 1,
    rejected: 0,
    withdrawn: 0,
  },
  recruiter: { id: '018f0000-0000-7000-8000-000000000002', name: 'Maya Reyes', avatarColor: null },
  hiringManagerId: null,
  openings: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
  ...over,
});

describe('query params', () => {
  test('limit coerces from a string and defaults to 50', () => {
    expect(ListJobsQuerySchema.parse({}).limit).toBe(50);
    expect(ListJobsQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  test('limit is bounded — an unbounded page size is a denial of service', () => {
    expect(ListJobsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(ListJobsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  test('an unknown param is rejected rather than silently ignored', () => {
    // A typo'd filter must not return unfiltered data that looks correct.
    expect(ListJobsQuerySchema.safeParse({ departmnet: 'Engineering' }).success).toBe(false);
  });
});

describe('stage distribution', () => {
  test('a job with no applications parses with every stage at zero', () => {
    const empty = Object.fromEntries(
      ['applied', 'screen', 'onsite', 'offer', 'hired', 'rejected', 'withdrawn'].map((k) => [k, 0]),
    );
    expect(StageDistributionSchema.parse(empty).applied).toBe(0);
  });

  test('a missing stage key is rejected — spec 001 §9 edge case 4', () => {
    // The bar reads every key; an absent one computes NaN width instead of zero.
    const withdrawnMissing = {
      applied: 0,
      screen: 0,
      onsite: 0,
      offer: 0,
      hired: 0,
      rejected: 0,
    };
    expect(StageDistributionSchema.safeParse(withdrawnMissing).success).toBe(false);
  });
});

describe('comp band', () => {
  test('absent and null are both valid and stay distinguishable', () => {
    const forbidden = JobSchema.parse(job());
    const noBandSet = JobSchema.parse(job({ compBand: null }));

    expect('compBand' in forbidden).toBe(false); // caller lacks comp:read
    expect(noBandSet.compBand).toBeNull(); // may see comp, job has no band
  });

  test('cents survive JSON round-trip without precision loss', () => {
    const parsed = JobSchema.parse(
      job({ compBand: { minCents: '19000000', maxCents: '22500000', currency: 'USD' } }),
    );
    const round = JobSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(round.compBand?.minCents).toBe('19000000');
    // The value a JS number would have mangled, had money been typed as one.
    expect(BigInt(round.compBand!.maxCents)).toBe(22_500_000n);
  });

  test('a float, a signed value, or a bare number is not money', () => {
    for (const minCents of ['190.00', '-19000000', 19000000]) {
      expect(
        JobSchema.safeParse(job({ compBand: { minCents, maxCents: '1', currency: 'USD' } })).success,
      ).toBe(false);
    }
  });

  test('currency must be ISO 4217 alpha-3', () => {
    expect(
      JobSchema.safeParse(job({ compBand: { minCents: '1', maxCents: '2', currency: 'usd' } }))
        .success,
    ).toBe(false);
  });
});

test('the envelope carries a null cursor on the last page', () => {
  const page = ListJobsResponseSchema.parse({ data: [job()], nextCursor: null });
  expect(page.nextCursor).toBeNull();
  expect(page.data).toHaveLength(1);
});
