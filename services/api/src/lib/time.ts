// Storage is UTC; business rules that depend on the calendar (daily route, monthly statements) use JST.
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const now = () => new Date();

/** YYYY-MM-DD of the instant in JST. */
export function jstDate(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant for JST midnight of the given YYYY-MM-DD. */
export function jstStartOfDay(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00+09:00`));
}

/** UTC instant for date + HH:MM in JST. */
export function jstDateTime(date: string, hhmm: string): Date {
  return new Date(Date.parse(`${date}T${hhmm}:00+09:00`));
}

/** [start, end) UTC instants of a JST month "YYYY-MM". */
export function jstMonthRange(month: string): [Date, Date] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = new Date(Date.parse(`${month}-01T00:00:00+09:00`));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const end = new Date(Date.parse(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+09:00`));
  return [start, end];
}

export function currentJstMonth(d = new Date()): string {
  return jstDate(d).slice(0, 7);
}

export const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

export function formatJst(d: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

/**
 * Payout schedule policy: approved balances are paid on the next 15th or month-end (JST)
 * that is at least 3 days away. Shown to users as 「振込予定日」, never as instant.
 */
export function nextPayoutDate(from: Date): string {
  const earliest = addDays(from, 3);
  const ymd = jstDate(earliest);
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${d <= 15 ? '15' : String(lastDay)}`;
}
