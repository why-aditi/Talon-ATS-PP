-- 0002_drop_avatar_color — the column has no legitimate reader. The UI derives an
-- avatar's fill by hashing the entity id over the avatar.1–8 token palette
-- (DESIGN_SYSTEM §Avatar / §JobRow), so a stored hex served by the API would be a
-- raw color outside packages/tokens — CLAUDE.md §4.8. ARCHITECTURE §5 still lists
-- the column; that line is stale and is called out in the PR description.
--
-- DESTRUCTIVE: the stored hex values are dropped and are not recoverable by the
-- down migration. Acceptable — the seed was the only writer, nothing reads them,
-- and the replacement value is a pure function of the id.
alter table users drop column avatar_color;
