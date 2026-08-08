-- Reverses 0004_outbox. The table is dropped with its rows: unpublished events are lost,
-- which is correct for a down migration — replaying them after a schema rollback would
-- publish events describing a shape that no longer exists.
drop table if exists outbox;
