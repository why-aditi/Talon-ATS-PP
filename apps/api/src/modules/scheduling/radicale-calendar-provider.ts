import { fullyBusy, normalizeBusy, type BusyInterval, type CalendarEvent, type CalendarProvider } from '@talon/domain';
import type { ApiConfig } from '../../config.js';

const enc = (value: string) => encodeURIComponent(value);
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const icsTime = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const escapeIcs = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const unfold = (text: string) => text.replace(/\r?\n[ \t]/g, '');
const parseIcsDate = (raw: string): Date | null => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  return match ? new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!)) : null;
};

export class RadicaleCalendarProvider implements CalendarProvider {
  readonly #base: string; readonly #authorization: string;
  readonly #fetch: typeof globalThis.fetch;
  constructor({ config }: { config: ApiConfig }) {
    this.#base = (config.calendar?.url ?? 'http://localhost:5232').replace(/\/$/, '');
    this.#authorization = basic(config.calendar?.username ?? 'talon', config.calendar?.password ?? 'talon');
    this.#fetch = globalThis.fetch.bind(globalThis);
  }
  #collection(userId: string) { return `${this.#base}/talon/${enc(userId)}/`; }
  #headers(extra: Record<string, string> = {}) { return { authorization: this.#authorization, ...extra }; }
  async isConnected(userId: string): Promise<boolean> {
    try {
      const url = this.#collection(userId);
      const found = await this.#fetch(url, { method: 'PROPFIND', headers: this.#headers({ depth: '0' }) });
      if (found.status === 207) return true;
      if (found.status !== 404) return false;
      const created = await this.#fetch(url, { method: 'MKCALENDAR', headers: this.#headers({ 'content-type': 'application/xml' }), body:
        '<?xml version="1.0"?><c:mkcalendar xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set xmlns:d="DAV:"><d:prop><d:displayname>Talon interviews</d:displayname></d:prop></d:set></c:mkcalendar>' });
      return created.ok;
    }
    catch { return false; }
  }
  async getBusy(userIds: string[], from: Date, to: Date, ignoreExternalIds: readonly string[] = []): Promise<Record<string, BusyInterval[]>> {
    const pairs = await Promise.all(userIds.map(async (userId) => {
      try {
        const response = await this.#fetch(this.#collection(userId), { method: 'REPORT', headers: this.#headers({ depth: '1', 'content-type': 'application/xml' }), body:
          `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${icsTime(from)}" end="${icsTime(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>` });
        if (response.status !== 207) return [userId, fullyBusy(from, to)] as const;
        const xml = await response.text(); const intervals: BusyInterval[] = [];
        for (const encoded of xml.matchAll(/<(?:[^:>]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?calendar-data>/gi)) {
          const ics = unfold(encoded[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
          for (const event of ics.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)) {
            if (/\nSTATUS:CANCELLED/i.test(event[1]!)) continue;
            const uid = /\nUID:(\S+)/.exec(event[1]!)?.[1];
            if (uid && ignoreExternalIds.includes(uid)) continue;
            const start = /\nDTSTART(?:;[^:]*)?:(\S+)/.exec(event[1]!)?.[1]; const end = /\nDTEND(?:;[^:]*)?:(\S+)/.exec(event[1]!)?.[1];
            const a = start ? parseIcsDate(start) : null; const b = end ? parseIcsDate(end) : null;
            if (a && b) intervals.push({ start: a, end: b });
          }
        }
        return [userId, normalizeBusy(intervals, from, to)] as const;
      } catch { return [userId, fullyBusy(from, to)] as const; }
    }));
    return Object.fromEntries(pairs);
  }
  async createEvent(userId: string, event: CalendarEvent): Promise<{ externalId: string }> {
    const externalId = crypto.randomUUID(); await this.#put(userId, externalId, event); return { externalId };
  }
  async updateEvent(userId: string, externalId: string, event: CalendarEvent): Promise<void> { await this.#put(userId, externalId, event); }
  async #put(userId: string, externalId: string, event: CalendarEvent) {
    const body = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Talon//Scheduling//EN','BEGIN:VEVENT',`UID:${externalId}`,`DTSTAMP:${icsTime(new Date())}`,`DTSTART:${icsTime(event.start)}`,`DTEND:${icsTime(event.end)}`,`SUMMARY:${escapeIcs(event.summary)}`,`STATUS:${event.status.toUpperCase()}`,...(event.description ? [`DESCRIPTION:${escapeIcs(event.description)}`] : []),'END:VEVENT','END:VCALENDAR',''].join('\r\n');
    const response = await this.#fetch(`${this.#collection(userId)}${enc(externalId)}.ics`, { method: 'PUT', headers: this.#headers({ 'content-type': 'text/calendar; charset=utf-8' }), body });
    if (!response.ok) throw new Error(`CalDAV PUT failed with ${response.status}`);
  }
  async deleteEvent(userId: string, externalId: string): Promise<void> {
    const response = await this.#fetch(`${this.#collection(userId)}${enc(externalId)}.ics`, { method: 'DELETE', headers: this.#headers() });
    if (!response.ok && response.status !== 404) throw new Error(`CalDAV DELETE failed with ${response.status}`);
  }
}
