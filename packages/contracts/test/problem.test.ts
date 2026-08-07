import { expect, test } from 'vitest';
import { ProblemSchema } from '../src/index.js';

const problem = (over: Record<string, unknown> = {}) => ({
  type: 'https://talon.dev/problems/validation-failed',
  title: 'Validation failed',
  status: 400,
  ...over,
});

test('type, title and status are required — a client switches on type', () => {
  for (const missing of ['type', 'title', 'status']) {
    const rest: Record<string, unknown> = problem();
    delete rest[missing];
    expect(ProblemSchema.safeParse(rest).success, missing).toBe(false);
  }
});

test('status must be a real error status', () => {
  expect(ProblemSchema.safeParse(problem({ status: 399 })).success).toBe(false);
  expect(ProblemSchema.safeParse(problem({ status: 600 })).success).toBe(false);
  expect(ProblemSchema.safeParse(problem({ status: 404.5 })).success).toBe(false);
  expect(ProblemSchema.parse(problem({ status: 404 })).status).toBe(404);
});

test('extension members survive — RFC 9457 §3.2', () => {
  // The 400 from a rejected query param carries the field detail a user can act on.
  const parsed = ProblemSchema.parse(problem({ errors: [{ field: 'limit', issue: 'max 100' }] }));
  expect(parsed).toHaveProperty('errors');
});
