-- Reverses 0009. Order matters: import_rows references jobs_async compositely.
--
-- pg_trgm is NOT dropped. It was created by 0001 and `candidates_name_trgm_idx` still
-- depends on it; dropping an extension this migration did not create would take that
-- index with it and leave 0001 half-applied. A down migration undoes its own up, not
-- somebody else's.

drop index if exists candidates_name_company_trgm_idx;

drop table if exists import_rows;
drop table if exists jobs_async;
