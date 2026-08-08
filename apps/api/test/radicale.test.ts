import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { asValue } from 'awilix';
import { InterviewLoopSchema, HoldLoopResponseSchema, SendLoopResponseSchema } from '@talon/contracts';
import type { ApiConfig } from '../src/config.js';
import { RadicaleCalendarProvider } from '../src/modules/scheduling/radicale-calendar-provider.js';
import { bearer, loadFixtures, signIn, startApp, type TestApp } from './helpers.js';
import { OWNER_URL } from './urls.js';

const run = process.env['RUN_RADICALE'] === '1' ? describe : describe.skip;
const nativeFetch = globalThis.fetch.bind(globalThis);

run('Radicale calendar provider', () => {
  const provider = new RadicaleCalendarProvider({ config: { calendar: {
    url: process.env['RADICALE_URL'] ?? 'http://localhost:5232', username: 'talon', password: 'talon',
  } } as ApiConfig });

  it('creates a real collection, writes/reads a VEVENT, ignores the hold during revalidation, and deletes idempotently', async () => {
    const userId = randomUUID(); const from = new Date('2026-08-06T14:00:00.000Z'); const to = new Date('2026-08-06T22:00:00.000Z');
    expect(await provider.isConnected(userId)).toBe(true);
    const event = { summary: 'Interview — Ana Petrova (System design)', start: new Date('2026-08-06T16:00:00.000Z'), end: new Date('2026-08-06T17:00:00.000Z'), status: 'tentative' as const };
    const { externalId } = await provider.createEvent(userId, event);
    expect(await provider.getBusy([userId], from, to)).toEqual({ [userId]: [{ start: event.start, end: event.end }] });
    expect(await provider.getBusy([userId], from, to, [externalId])).toEqual({ [userId]: [] });
    await provider.updateEvent(userId, externalId, { ...event, status: 'confirmed' });
    await provider.deleteEvent(userId, externalId); await provider.deleteEvent(userId, externalId);
    expect(await provider.getBusy([userId], from, to)).toEqual({ [userId]: [] });
  });
});

run('scheduling API against Radicale', () => {
  let test: TestApp; let token: Awaited<ReturnType<typeof signIn>>;
  beforeAll(async () => {
    const provider = new RadicaleCalendarProvider({ config: { calendar: { url: 'http://localhost:5232', username: 'talon', password: 'talon' } } as ApiConfig });
    test = await startApp(); test.container.register({ calendarProvider: asValue(provider) });
    const fixtures = await loadFixtures(); token = await signIn(test, fixtures.talon.recruiter);
    const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
    const users = await owner<{ id: string }[]>`select id from users where tenant_id=${fixtures.talon.tenantId}`; await owner.end();
    const authorization = `Basic ${Buffer.from('talon:talon').toString('base64')}`;
    await Promise.all(users.map(({ id }) => nativeFetch(`http://localhost:5232/talon/${encodeURIComponent(id)}/`, { method: 'DELETE', headers: { authorization } })));
  });
  afterAll(async () => { await test.close(); });

  it('holds real events, detects drift, confirms after revalidation, and replays duplicate send', async () => {
    const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
    const [seeded] = await owner<{ id: string }[]>`select l.id from interview_loops l join tenants t on t.id=l.tenant_id where t.slug='talon' order by l.created_at limit 1`; await owner.end();
    const loopId = seeded!.id;
    const read = await test.app.inject({ method: 'GET', url: `/v1/interview-loops/${loopId}`, headers: bearer(token) });
    expect(read.statusCode).toBe(200);
    const loop = InterviewLoopSchema.parse(read.json()); const arrangement = loop.solve?.arrangements[0];
    expect(arrangement, JSON.stringify(loop.solve)).toBeDefined();
    const held = await test.app.inject({ method: 'POST', url: `/v1/interview-loops/${loopId}/hold`, headers: bearer(token), payload: { arrangement, version: loop.version } });
    expect(held.statusCode, held.body).toBe(200);
    const hold = HoldLoopResponseSchema.parse(held.json()); expect(hold.loop.status).toBe('held');

    const first = arrangement!.rounds[0]!; const panelistId = first.panelistIds[0]!;
    const provider = test.container.cradle.calendarProvider;
    const collision = await provider.createEvent(panelistId, { summary: 'A meeting booked after the hold', start: new Date(first.startUtc), end: new Date(first.endUtc), status: 'confirmed' });
    const idempotencyKey = randomUUID();
    try {
      const sent = await test.app.inject({ method: 'POST', url: `/v1/interview-loops/${loopId}/send`, headers: bearer(token), payload: { arrangement, version: hold.loop.version, idempotencyKey: randomUUID() } });
      expect(sent.statusCode, sent.body).toBe(200);
      const result = SendLoopResponseSchema.parse(sent.json()); expect(result.status).toBe('drifted');
      if (result.status === 'drifted') expect(result.drift.map((d) => d.panelistId)).toContain(panelistId);
    } finally { await provider.deleteEvent(panelistId, collision.externalId); }
    const payload = { arrangement, version: hold.loop.version, idempotencyKey };
    const sent = await test.app.inject({ method: 'POST', url: `/v1/interview-loops/${loopId}/send`, headers: bearer(token), payload });
    expect(sent.statusCode, sent.body).toBe(200);
    const result = SendLoopResponseSchema.parse(sent.json());
    expect(result.status).toBe('sent');
    if (result.status === 'sent') {
      expect(result.loop.status).toBe('confirmed');
      expect(result.candidateIcs).toContain('BEGIN:VCALENDAR');
    }
    const replay = await test.app.inject({ method: 'POST', url: `/v1/interview-loops/${loopId}/send`, headers: bearer(token), payload });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(sent.json());
  });
});
