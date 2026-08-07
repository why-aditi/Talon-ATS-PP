import postgres from 'postgres';
const owner = postgres('postgres://talon:talon@localhost:5432/talon_api_test', { max: 1, onnotice: () => {} });
const app = postgres('postgres://talon_app:talon_app@localhost:5432/talon_api_test', { max: 1, onnotice: () => {} });
try {
  await owner`drop role if exists talon_ops`;
  await owner`create role talon_ops bypassrls`;
  await owner`grant talon_ops to talon_app`;
  await owner`grant select on all tables in schema public to talon_ops`;

  // What the repository's audit actually asks:
  const [audit] = await app`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  console.log('audit sees for current_user:', audit, '=> audit PASSES:', !audit.rolsuper && !audit.rolbypassrls);

  // What Postgres actually does when it decides whether to apply a policy:
  const [truth] = await app`select current_user, pg_has_role(current_user,'talon_ops','USAGE') as member,
                                   has_table_privilege('jobs','select') as can_read`;
  console.log('reality:', truth);

  await app.unsafe('begin');
  await app`select set_config('app.tenant_id','00000000-0000-0000-0000-000000000000',true)`;
  const rows = await app`select count(*)::int as n from jobs`;
  console.log('rows visible with a bogus tenant while a member of a BYPASSRLS role:', rows[0]);
  await app.unsafe('rollback');
} finally {
  await app.end();
  await owner`revoke talon_ops from talon_app`.catch(()=>{});
  await owner`drop owned by talon_ops`.catch(()=>{});
  await owner`drop role if exists talon_ops`.catch(()=>{});
  await owner.end();
}
