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
  recruiter: { id: '018f0000-0000-7000-8000-000000000002', name: 'Maya Reyes' },
  ...over,
});

const band = (over: Record<string, unknown> = {}) => ({
  minCents: '19000000',
  maxCents: '22500000',
  currency: 'USD',
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

  test('a raw number is accepted — the generated client will not send strings', () => {
    expect(ListJobsQuerySchema.parse({ limit: 50 }).limit).toBe(50);
    expect(ListJobsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListJobsQuerySchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  test('cursor is bounded', () => {
    expect(ListJobsQuerySchema.safeParse({ cursor: 'x'.repeat(512) }).success).toBe(true);
    expect(ListJobsQuerySchema.safeParse({ cursor: 'x'.repeat(513) }).success).toBe(false);
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

describe('comp band', () => {
  test('a job without comp:read parses with no band key at all', () => {
    const parsed = JobSchema.parse(job());
    expect('band' in parsed).toBe(false);
  });

  test('a partial band is rejected — presence is atomic', () => {
    // The whole point of nesting: a band can never arrive missing its currency.
    for (const key of ['minCents', 'maxCents', 'currency']) {
      const partial: Record<string, unknown> = band();
      delete partial[key];
      expect(JobSchema.safeParse(job({ band: partial })).success, `without ${key}`).toBe(false);
    }
  });

  test('a band with min above max is rejected', () => {
    expect(JobSchema.safeParse(job({ band: band({ minCents: '9000000', maxCents: '1' }) })).success).toBe(
      false,
    );
  });

  test('cents survive JSON round-trip without precision loss', () => {
    const parsed = JobSchema.parse(job({ band: band() }));
    const round = JobSchema.parse(JSON.parse(JSON.stringify(parsed)));
    if (!round.band) throw new Error('band lost in transit');
    expect(round.band.minCents).toBe('19000000');
    // The value a JS number would have mangled, had money been typed as one.
    expect(BigInt(round.band.maxCents)).toBe(22_500_000n);
  });

  test('money is canonical digits or it is not money', () => {
    const bad = [
      '190.00',
      '-19000000',
      19000000,
      '007',
      '',
      '1e6',
      '١٢٣',
      '9'.repeat(20),
      '9223372036854775808', // one past int8; the column cannot hold it
    ];
    for (const value of bad) {
      const asMin = job({ band: band({ minCents: value, maxCents: '99999999' }) });
      const asMax = job({ band: band({ minCents: '1', maxCents: value }) });
      expect(JobSchema.safeParse(asMin).success, `min ${String(value)}`).toBe(false);
      expect(JobSchema.safeParse(asMax).success, `max ${String(value)}`).toBe(false);
    }
  });

  test('currency must be alpha-3 uppercase', () => {
    expect(JobSchema.safeParse(job({ band: band({ currency: 'usd' }) })).success).toBe(false);
  });
});

test('an unassigned job serializes rather than failing the page', () => {
  expect(JobSchema.safeParse(job({ recruiter: null })).success).toBe(true);
});

test('the envelope carries a null cursor on the last page', () => {
  const page = ListJobsResponseSchema.parse({ data: [job()], nextCursor: null });
  expect(page.nextCursor).toBeNull();
  expect(page.data).toHaveLength(1);
});
