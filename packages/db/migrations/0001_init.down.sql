-- Reverses 0001_init. Destructive by definition: drops every M0a table and its data.
drop table if exists audit_log;
drop table if exists activities;
drop table if exists stage_transitions;
drop table if exists applications;
drop table if exists candidates;
drop table if exists job_stages;
drop table if exists jobs;
drop table if exists stage_templates;
drop table if exists users;
drop table if exists tenants;
drop function if exists set_updated_at();
-- talon_app role and the citext/pg_trgm extensions are intentionally left in place:
-- the role is cluster-global (other databases may share the cluster) and the
-- extensions are owned by the docker init script. Both are created idempotently on up.
