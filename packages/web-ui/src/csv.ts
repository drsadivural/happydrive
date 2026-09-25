/** CSV 生成（RFC 4180、CRLF）。Excel での文字化け防止に UTF-8 BOM を付け、数式インジェクションを無害化する。 */
export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  let s = typeof cell === 'number' ? (Number.isFinite(cell) ? String(cell) : '') : String(cell);
  // 数値セル（負数を含む）はそのまま、文字列の先頭が数式記号なら ' を付ける
  if (typeof cell === 'string' && FORMULA_PREFIX.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<CsvCell>>, options: { bom?: boolean } = {}): string {
  const body = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n';
  return (options.bom ?? true) ? `\uFEFF${body}` : body;
}
