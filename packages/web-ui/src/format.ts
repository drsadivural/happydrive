/**
 * 表示フォーマット（JST・円）。API は UTC ISO 8601 / 整数円で送受信し、表示と入力は JST。
 * 日本は夏時間がないため JST = UTC+9 固定として変換する。
 */

export const JST_OFFSET_MINUTES = 9 * 60;
const JST_OFFSET_MS = JST_OFFSET_MINUTES * 60 * 1000;
export const TIME_ZONE = 'Asia/Tokyo';

const yenFormatter = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const numberFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });

/** 整数円を「￥12,345」形式で表示。null/undefined/非数は「—」。 */
export function formatYen(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  return yenFormatter.format(Math.trunc(amount));
}

/** 桁区切りの数値（件数など）。 */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return numberFormatter.format(n);
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});
const timeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** UTC ISO → 「2026/10/01 09:00」(JST) */
export function formatDateTimeJst(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? dateTimeFormatter.format(d) : '—';
}

/** UTC ISO → 「2026/10/01(木)」(JST) */
export function formatDateJst(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? dateFormatter.format(d) : '—';
}

/** UTC ISO → 「09:00」(JST) */
export function formatTimeJst(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? timeFormatter.format(d) : '—';
}

/** 開始〜終了を「2026/10/01(木) 09:00〜12:00」のように表示（同日なら終了は時刻のみ）。 */
export function formatRangeJst(start: string | null | undefined, end: string | null | undefined): string {
  const s = toDate(start);
  const e = toDate(end);
  if (!s) return '—';
  const startText = `${dateFormatter.format(s)} ${timeFormatter.format(s)}`;
  if (!e) return startText;
  const sameDay = toJstDateString(s) === toJstDateString(e);
  return sameDay
    ? `${startText}〜${timeFormatter.format(e)}`
    : `${startText}〜${dateFormatter.format(e)} ${timeFormatter.format(e)}`;
}

/** 「YYYY-MM-DD」形式の日付（API の date 形式）は JST のカレンダー日付として表示。 */
export function formatPlainDate(date: string | null | undefined): string {
  if (!date) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${m[1]}/${m[2]}/${m[3]}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Date を JST のカレンダー日付「YYYY-MM-DD」に。 */
export function toJstDateString(date: Date): string {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}`;
}

/** JST の今日「YYYY-MM-DD」 */
export function jstToday(now: Date = new Date()): string {
  return toJstDateString(now);
}

/** JST の今月「YYYY-MM」 */
export function jstMonth(now: Date = new Date()): string {
  return toJstDateString(now).slice(0, 7);
}

/** 「YYYY-MM」に月数を加算 */
export function addMonths(month: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`invalid month: ${month}`);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** 「YYYY-MM-DD」に日数を加算（暦日計算） */
export function addDays(date: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`invalid date: ${date}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 「YYYY-MM」を「2026年10月」に */
export function formatMonth(month: string | null | undefined): string {
  if (!month) return '—';
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `${m[1]}年${Number(m[2])}月` : month;
}

const LOCAL_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * `<input type="datetime-local">` の値（JST として解釈）を UTC ISO 8601 文字列へ。
 * 不正な値は null。例: "2026-10-01T09:00" → "2026-10-01T00:00:00.000Z"
 */
export function jstInputToUtcIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = LOCAL_INPUT_RE.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [
    number, number, number, number, number, number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const utcMs = Date.UTC(y, mo - 1, d, h, mi, s) - JST_OFFSET_MS;
  const check = new Date(utcMs + JST_OFFSET_MS);
  // 2026-02-31 のような存在しない日付を拒否
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return new Date(utcMs).toISOString();
}

/** UTC ISO → `<input type="datetime-local">` 用の JST 文字列「YYYY-MM-DDTHH:mm」 */
export function utcIsoToJstInput(value: string | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}T${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
}

/** 経過・残り時間の簡易表示（例「あと25分」「3時間前」） */
export function formatRelative(value: string | null | undefined, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return '—';
  const diffMin = Math.round((d.getTime() - now.getTime()) / 60000);
  const abs = Math.abs(diffMin);
  const unit = abs < 60 ? `${abs}分` : abs < 60 * 48 ? `${Math.round(abs / 60)}時間` : `${Math.round(abs / 1440)}日`;
  if (abs === 0) return 'たった今';
  return diffMin > 0 ? `あと${unit}` : `${unit}前`;
}
