-- Reverses 0005_audit_authentication.
--
-- Dropping the function does NOT delete the rows it wrote, and that is correct:
-- audit_log is append-only (0001 grants select + insert and nothing else), so a
-- rollback that removed history would be the one operation the table exists to
-- make impossible.
--
-- The consequence to know about: with this function gone, `IdentityService`
-- fails every sign-in, because the audit write is fail-closed — no audit row,
-- no token. That is deliberate rather than an oversight in this file. Rolling
-- the schema back past a running api is already a broken deployment; failing
-- loudly at the door beats issuing sessions that nothing recorded.

drop function if exists audit_sign_in(text, text, text, uuid, uuid, text, text);
