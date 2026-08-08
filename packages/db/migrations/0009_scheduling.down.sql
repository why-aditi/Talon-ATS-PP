-- Revert 0009_scheduling. Dropped child-first so the drops do not depend on CASCADE
-- deciding what else to take with them — an explicit order is reviewable, a cascade is not.
drop table if exists interview_panelists;
drop table if exists interviews;
drop table if exists interview_round_panelists;
drop table if exists interview_rounds;
drop table if exists interview_loops;

alter table tenants
  drop constraint if exists tenants_business_hours_ck,
  drop column if exists business_hours_start,
  drop column if exists business_hours_end;
