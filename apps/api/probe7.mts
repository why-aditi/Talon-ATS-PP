import { signJwt } from './src/modules/identity/jwt.js';
import { startApp, loadFixtures, signIn, testConfig } from './test/helpers.js';

const t = await startApp();
const f = await loadFixtures();
const auth = testConfig().auth;
const now = () => Math.floor(Date.now() / 1000);
await signIn(t, f.talon.member);

const mint = (c: Record<string, unknown>) => signJwt({
  sub: f.talon.member.id, email: f.talon.member.email,
  tenant_id: f.talon.tenantId, role: 'member',
  iss: auth.issuer, aud: auth.audience, iat: now(), exp: now() + 3600, jti: 'x', ...c,
}, auth.secret);

const call = async (label: string, token: string) => {
  const r = await t.app.inject({ method: 'GET', url: `/v1/jobs/${f.talon.jobId}`, headers: { authorization: `Bearer ${token}` } });
  const body = r.body;
  console.log(label, '->', r.statusCode, 'band present:', body.includes('band'), 'cents:', /cents/i.test(body));
};

await call('member, honest claims        ', mint({}));
await call('member, forged role=admin    ', mint({ role: 'admin' }));
await call('member, forged role=recruiter', mint({ role: 'recruiter' }));
// extra claim smuggling
await call('member + scopes claim        ', mint({ scopes: ['comp:read'], 'comp:read': true }));

// Header quirks
for (const h of ['Bearer  ' + mint({}), 'bearer ' + mint({}), 'BEARER ' + mint({})]) {
  const r = await t.app.inject({ method: 'GET', url: `/v1/jobs/${f.talon.jobId}`, headers: { authorization: h } });
  console.log(JSON.stringify(h.slice(0, 12)), '->', r.statusCode);
}
// 500 body shape from a repository blowup? check notFound detail leakage
const r404 = await t.app.inject({ method: 'GET', url: `/v1/jobs/${f.acme.jobId}`, headers: { authorization: `Bearer ${mint({})}` } });
console.log('cross-tenant 404 body:', r404.body);
await t.close();
process.exit(0);
