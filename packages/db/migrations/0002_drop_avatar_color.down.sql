-- Restores the column as 0001_init declared it: text, nullable, no default.
--
-- SHAPE ONLY — the data is gone. `drop column` in the up migration discards the
-- values, so every existing row comes back with avatar_color null. This is a
-- one-way loss and is accepted: no reader exists, and the seed regenerates its
-- own values if it is ever taught to write them again.
alter table users add column avatar_color text;
