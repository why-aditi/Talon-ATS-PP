/**
 * Roles and scopes (spec 001 §6.4).
 *
 * Lives in `domain` rather than in a module because two consumers need the same
 * table and neither may import the other: `packages/contracts` derives its
 * `RoleSchema` from ROLES, and every api module's `service.ts` checks scopes.
 * One array, one mapping, no drift.
 */

/** Must match the `users.role` check constraint in packages/db. */
export const ROLES = ['admin', 'recruiter', 'hiring_manager', 'member'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Only the scopes something actually enforces today. A scope nobody checks is a
 * permission model on paper; they are added by the feature that needs them.
 */
export const SCOPES = ['comp:read'] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * `comp:read` — base, equity, band, comp expectation. Held by admin, recruiter
 * and hiring manager; NOT by member. Offer approvers also hold it (spec 001
 * §6.4) but approvers are a per-offer relation, not a role, and offers are M1 —
 * that grant lands with them.
 */
export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  admin: ['comp:read'],
  recruiter: ['comp:read'],
  hiring_manager: ['comp:read'],
  member: [],
};

export function scopesFor(role: Role): readonly Scope[] {
  return ROLE_SCOPES[role];
}

export function hasScope(role: Role, scope: Scope): boolean {
  return ROLE_SCOPES[role].includes(scope);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
