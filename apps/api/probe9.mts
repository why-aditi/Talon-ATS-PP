import { fastify } from 'fastify';
const app = fastify();
let fail = true;
app.addHook('onSend', async (req, reply, payload) => {
  if (fail) { fail = false; throw new Error('COMMIT failed'); }
  return payload;
});
app.get('/x', async () => ({ ok: true, wrote: 'something' }));
const r = await app.inject({ method: 'GET', url: '/x' });
console.log('status:', r.statusCode);
console.log('body:', r.body);
process.exit(0);
