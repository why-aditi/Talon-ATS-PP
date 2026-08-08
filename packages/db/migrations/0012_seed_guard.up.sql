-- Narrow owner-only reader used by provisioning before the destructive demo seed.
create function seed_database_has_data()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$ select exists(select 1 from public.tenants) $$;

revoke all on function seed_database_has_data() from public;
