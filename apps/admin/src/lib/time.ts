// Algeria uses a fixed UTC+01:00 offset (CET, no daylight saving since 1981). The admin shows and
// accepts dates in Africa/Algiers whatever the browser's time zone.

export const ALGIERS_TZ = 'Africa/Algiers';
const OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Epoch ms → `YYYY-MM-DDTHH:mm` (value for `<input type="datetime-local">`) in Africa/Algiers. */
export function toAlgiersInput(ms: number): string {
  const d = new Date(ms + OFFSET_MS);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `YYYY-MM-DDTHH:mm[:ss]` or `YYYY-MM-DD` read as Africa/Algiers local time → epoch ms, or null. */
export function fromAlgiersInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h = '0', mi = '0', s = '0'] = m.slice(1) as [string, string, string, string?, string?, string?];
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== +y || back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) return null;
  return utc - OFFSET_MS;
}

/** Start of the Africa/Algiers calendar day containing `ms` (epoch ms). */
export function startOfAlgiersDay(ms: number): number {
  return Math.floor((ms + OFFSET_MS) / DAY_MS) * DAY_MS - OFFSET_MS;
}
