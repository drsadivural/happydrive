/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). First row is the header; keys are trimmed & lower-cased. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') {
      if (field.length) throw new Error(`${rows.length + 1}行目: 引用符の位置が不正です`);
      quoted = true; i++; continue;
    }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); field = '';
      if (row.some((f) => f.length)) rows.push(row);
      row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  if (quoted) throw new Error('引用符が閉じられていません');
  row.push(field);
  if (row.some((f) => f.length)) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, (r[idx] ?? '').trim()])));
}
