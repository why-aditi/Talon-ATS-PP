import { describe, expect, test } from 'vitest';
import {
  type Job,
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
  comp: { visible: false },
  openings: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
  ...over,
});

describe('query params', () => {
  test('limit accepts a numeric string and defaults to 50', () => {
    expect(ListJobsQuerySchema.parse({}).limit).toBe(50);
    expect(ListJobsQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  test('limit is bounded — an unbounded page size is a denial of service', () => {
    expect(ListJobsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(ListJobsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  test('limit rejects everything Number() would have silently accepted', () => {
    // z.coerce.number() is Number(): "0x10" is 16, "1e2" is 100, " 100 " is 100.
    for (const limit of ['0x10', '1e2', '0b1010', '0o17', '+50', '50.', ' 100 ', '1.5', 'abc', '']) {
      expect(ListJobsQuerySchema.safeParse({ limit }).success, limit || '(empty)').toBe(false);
    }
  });

  test('an unknown param is rejected rather than silently ignored', () => {
    // A typo'd filter must not return unfiltered data that looks correct.
    expect(ListJobsQuerySchema.safeParse({ departmnet: 'Engineering' }).success).toBe(false);
  });

  test('filters are validated, not passed through', () => {
    expect(ListJobsQuerySchema.safeParse({ status: 'archived' }).success).toBe(false);
    expect(ListJobsQuerySchema.safeParse({ recruiter_id: 'maya' }).success).toBe(false);
    expect(ListJobsQuerySchema.safeParse({ department: '   ' }).success).toBe(false);
  });
});

describe('stage distribution', () => {
  test('a missing stage key is rejected — spec 001 §9 edge case 4', () => {
    // The bar reads every key; an absent one computes NaN width instead of zero.
    const withdrawnMissing = { applied: 0, screen: 0, onsite: 0, offer: 0, hired: 0, rejected: 0 };
    expect(StageDistributionSchema.safeParse(withdrawnMissing).success).toBe(false);
    expect(StageDistributionSchema.safeParse({}).success).toBe(false);
  });

  test('a job with no applications parses with every stage present at zero', () => {
    const empty = StageDistributionSchema.parse({
      applied: 0,
      screen: 0,
      onsite: 0,
      offer: 0,
      hired: 0,
      rejected: 0,
      withdrawn: 0,
    });
    expect(Object.values(empty).every((n) => n === 0)).toBe(true);
    expect(Object.keys(empty)).toHaveLength(7);
  });
});

describe('comp visibility', () => {
  test('hidden and unset are different states, and both narrow in TypeScript', () => {
    const forbidden = JobSchema.parse(job({ comp: { visible: false } }));
    const noBandSet = JobSchema.parse(job({ comp: { visible: true, band: null } }));

    // This is the branch the UI writes; it must compile without a cast.
    const bandOf = (j: Job) => (j.comp.visible ? j.comp.band : undefined);

    expect(bandOf(forbidden)).toBeUndefined(); // lacks comp:read — render no band
    expect(bandOf(noBandSet)).toBeNull(); // may see comp — job has none
  });

  test('a hidden comp cannot smuggle a band', () => {
    // Unknown keys are stripped, so this must not become a readable band.
    const parsed = JobSchema.parse(
      job({ comp: { visible: false, band: { minCents: '1', maxCents: '2', currency: 'USD' } } }),
    );
    expect('band' in parsed.comp).toBe(false);
  });

  test('cents survive JSON round-trip without precision loss', () => {
    const parsed = JobSchema.parse(
      job({
        comp: { visible: true, band: { minCents: '19000000', maxCents: '22500000', currency: 'USD' } },
      }),
    );
    const round = JobSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(round.comp.visible && round.comp.band?.minCents).toBe('19000000');
    // The value a JS number would have mangled, had money been typed as one.
    expect(BigInt(round.comp.visible ? round.comp.band!.maxCents : '0')).toBe(22_500_000n);
  });

  test('money is canonical digits or it is not money', () => {
    const bad = ['190.00', '-19000000', 19000000, '007', '', '1e6', '١٢٣', '9'.repeat(20)];
    for (const value of bad) {
      const asMin = { visible: true, band: { minCents: value, maxCents: '1', currency: 'USD' } };
      const asMax = { visible: true, band: { minCents: '1', maxCents: value, currency: 'USD' } };
      expect(JobSchema.safeParse(job({ comp: asMin })).success, `min ${String(value)}`).toBe(false);
      expect(JobSchema.safeParse(job({ comp: asMax })).success, `max ${String(value)}`).toBe(false);
    }
  });

  test('currency must be alpha-3 uppercase', () => {
    const band = { minCents: '1', maxCents: '2', currency: 'usd' };
    expect(JobSchema.safeParse(job({ comp: { visible: true, band } })).success).toBe(false);
  });
});

test('a zero-openings row is serializable, not a failed page', () => {
  // The column carries no check constraint, so this row is legal storage.
  expect(JobSchema.safeParse(job({ openings: 0 })).success).toBe(true);
});

test('the envelope carries a null cursor on the last page', () => {
  const page = ListJobsResponseSchema.parse({ data: [job()], nextCursor: null });
  expect(page.nextCursor).toBeNull();
  expect(page.data).toHaveLength(1);
});
