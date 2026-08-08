-- Optimistic concurrency for job edit. Spec 005 §3.1.
--
-- `applications` has had a `version` since 0001; `jobs` did not, so two
-- recruiters editing the same job silently overwrote each other. The board
-- already has the 409 pattern (ARCHITECTURE §6.1) — this gives job edit the same
-- one rather than a second, different answer to the same problem.
--
-- NOT NULL with a constant DEFAULT: PostgreSQL 11+ records the default in the
-- catalogue instead of rewriting the table, so this does not lock `jobs` for the
-- length of a backfill. Every existing row reads 1 without one.
alter table jobs add column if not exists version integer not null default 1;

comment on column jobs.version is
  'Optimistic concurrency (spec 005 §3.1). Bumped by any PATCH that reaches the row. Unlike applications there is no rank-only write here, so non-negotiable #18 has no analogue — if a write is ever added that must NOT bump this, it needs its own repository method and its own reason.';
