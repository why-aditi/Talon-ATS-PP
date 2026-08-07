// Owner (migration) role: docker superuser, bypasses RLS — used for setup and
// derived-metric assertions. App role: created by 0001_init, subject to RLS.
export const OWNER_URL = process.env['DATABASE_URL'] ?? 'postgres://talon:talon@localhost:5432/talon';
export const APP_URL =
  process.env['APP_DATABASE_URL'] ?? 'postgres://talon_app:talon_app@localhost:5432/talon';

export const TENANT_TABLES = [
  'users',
  'stage_templates',
  'jobs',
  'job_stages',
  'candidates',
  'applications',
  'stage_transitions',
  'activities',
  'audit_log',
] as const;
