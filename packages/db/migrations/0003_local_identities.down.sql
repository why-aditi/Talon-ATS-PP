-- Reverses 0003_local_identities. Credentials are dropped with the table: this is
-- a local-only store and the down path exists so `up → down → up` stays clean.
drop function if exists auth_user_by_sub(uuid);
drop function if exists auth_user_by_email(citext);
drop table if exists local_identities;
