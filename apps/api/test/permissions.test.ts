/**
 * Scope resolution (spec 001 §6.4). Small enough to state exhaustively, and
 * important enough that a silent change to the table should fail a test rather
 * than a screen.
 */
import { expect, it } from 'vitest';
import { ROLES, ROLE_SCOPES, hasScope, isRole, scopesFor } from '@talon/domain';
import { RoleSchema } from '@talon/contracts';

it('comp:read is held by admin, recruiter and hiring manager — never member', () => {
  expect(hasScope('admin', 'comp:read')).toBe(true);
  expect(hasScope('recruiter', 'comp:read')).toBe(true);
  expect(hasScope('hiring_manager', 'comp:read')).toBe(true);
  expect(hasScope('member', 'comp:read')).toBe(false);
});

it('every role has an explicit scope list', () => {
  // A role added without a decision about comp lands here, not in production.
  for (const role of ROLES) expect(Array.isArray(ROLE_SCOPES[role]), role).toBe(true);
  expect(scopesFor('member')).toEqual([]);
});

it('the contract enum is the domain table', () => {
  // Open question 9 is that nothing catches enum drift; this catches the half
  // of it that does not need a database.
  expect(RoleSchema.options).toEqual([...ROLES]);
});

it('an unknown role is not a role', () => {
  expect(isRole('superuser')).toBe(false);
  expect(isRole('Admin')).toBe(false);
  expect(isRole('admin')).toBe(true);
});
