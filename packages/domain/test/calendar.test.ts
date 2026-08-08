import { describe, expect, test } from 'vitest';
import {
  SeededCalendarProvider,
  fullyBusy,
  mergeBusy,
  normalizeBusy,
  type BusyInterval,
} from '../src/index.js';

const t = (iso: string): Date => new Date(iso);
const interval = (from: string, to: string): BusyInterval => ({ start: t(from), end: t(to) });
const shown = (intervals: BusyInterval[]): string[] =>
  intervals.map((i) => `${i.start.toISOString()}/${i.end.toISOString()}`);

const D = '2026-08-06T';

describe('mergeBusy', () => {
  test('sorts, and joins overlapping intervals', () => {
    expect(
      shown(
        mergeBusy([
          interval(`${D}12:00:00.000Z`, `${D}13:00:00.000Z`),
          interval(`${D}09:00:00.000Z`, `${D}10:00:00.000Z`),
          interval(`${D}09:30:00.000Z`, `${D}11:00:00.000Z`),
        ]),
      ),
    ).toEqual([`${D}09:00:00.000Z/${D}11:00:00.000Z`, `${D}12:00:00.000Z/${D}13:00:00.000Z`]);
  });

  test('joins touching intervals — back-to-back meetings are one block, not a zero-minute gap', () => {
    expect(
      shown(
        mergeBusy([
          interval(`${D}09:00:00.000Z`, `${D}10:00:00.000Z`),
          interval(`${D}10:00:00.000Z`, `${D}11:00:00.000Z`),
        ]),
      ),
    ).toEqual([`${D}09:00:00.000Z/${D}11:00:00.000Z`]);
  });

  test('absorbs a fully contained interval rather than shrinking the outer one', () => {
    expect(
      shown(
        mergeBusy([
          interval(`${D}09:00:00.000Z`, `${D}17:00:00.000Z`),
          interval(`${D}10:00:00.000Z`, `${D}11:00:00.000Z`),
        ]),
      ),
    ).toEqual([`${D}09:00:00.000Z/${D}17:00:00.000Z`]);
  });

  test('drops zero-length and inverted intervals', () => {
    expect(
      mergeBusy([
        interval(`${D}09:00:00.000Z`, `${D}09:00:00.000Z`),
        interval(`${D}11:00:00.000Z`, `${D}10:00:00.000Z`),
      ]),
    ).toEqual([]);
  });

  test('does not mutate its input', () => {
    const input = [interval(`${D}09:00:00.000Z`, `${D}10:00:00.000Z`)];
    const before = shown(input);
    mergeBusy([...input, interval(`${D}09:30:00.000Z`, `${D}12:00:00.000Z`)]);
    expect(shown(input)).toEqual(before);
  });
});

describe('normalizeBusy', () => {
  test('clips to the window and drops what falls outside it', () => {
    expect(
      shown(
        normalizeBusy(
          [
            interval(`${D}06:00:00.000Z`, `${D}10:00:00.000Z`),
            interval(`${D}20:00:00.000Z`, `${D}22:00:00.000Z`),
            interval(`${D}12:00:00.000Z`, `${D}13:00:00.000Z`),
          ],
          t(`${D}09:00:00.000Z`),
          t(`${D}17:00:00.000Z`),
        ),
      ),
    ).toEqual([`${D}09:00:00.000Z/${D}10:00:00.000Z`, `${D}12:00:00.000Z/${D}13:00:00.000Z`]);
  });
});

describe('SeededCalendarProvider', () => {
  const from = t(`${D}09:00:00.000Z`);
  const to = t(`${D}17:00:00.000Z`);

  test('a disconnected calendar is fully busy for the whole window, never free (§4, §12.1)', async () => {
    const provider = new SeededCalendarProvider({
      busy: { maya: [interval(`${D}10:00:00.000Z`, `${D}11:00:00.000Z`)] },
      disconnected: ['maya'],
    });
    expect(shown((await provider.getBusy(['maya'], from, to)).maya ?? [])).toEqual([
      `${D}09:00:00.000Z/${D}17:00:00.000Z`,
    ]);
    await expect(provider.isConnected('maya')).resolves.toBe(false);
  });

  test('an unknown user is fully busy too — "no intervals" and "never read" are one value', async () => {
    const provider = new SeededCalendarProvider();
    expect(shown((await provider.getBusy(['nobody'], from, to)).nobody ?? [])).toEqual(
      shown(fullyBusy(from, to)),
    );
  });

  test('a seeded panelist with no meetings is free', async () => {
    const provider = new SeededCalendarProvider({ busy: { lin: [] } });
    expect((await provider.getBusy(['lin'], from, to)).lin).toEqual([]);
    await expect(provider.isConnected('lin')).resolves.toBe(true);
  });

  test('writes are readable back, and deleting twice is not an error (#19)', async () => {
    const provider = new SeededCalendarProvider({ busy: { lin: [] } });
    const event = {
      summary: 'Interview loop',
      start: t(`${D}10:00:00.000Z`),
      end: t(`${D}11:00:00.000Z`),
      status: 'tentative' as const,
    };
    const { externalId } = await provider.createEvent('lin', event);
    expect(provider.written.get(externalId)).toEqual({ userId: 'lin', event });
    await provider.deleteEvent('lin', externalId);
    await expect(provider.deleteEvent('lin', externalId)).resolves.toBeUndefined();
  });
});
