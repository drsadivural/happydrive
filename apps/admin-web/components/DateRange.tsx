'use client';
import { useState } from 'react';
import { addDays, jstToday } from '@happydrive/web-ui/format';
import { Button, Field } from '@happydrive/web-ui/components';

export interface Range {
  from: string;
  to: string;
}

export function defaultRange(days = 30, now = new Date()): Range {
  const to = jstToday(now);
  return { from: addDays(to, -(days - 1)), to };
}

export function validateRange(r: Range): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.from) || !/^\d{4}-\d{2}-\d{2}$/.test(r.to)) return '開始日と終了日を入力してください。';
  if (r.from > r.to) return '開始日は終了日以前にしてください。';
  return null;
}

/** 日付範囲（JST のカレンダー日付、API の date 形式） */
export function DateRangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="hd-row"
      style={{ alignItems: 'flex-end' }}
      onSubmit={(e) => {
        e.preventDefault();
        const err = validateRange(draft);
        setError(err);
        if (!err) onChange(draft);
      }}
    >
      <Field label="開始日（JST）">{(p) => <input {...p} className="hd-input" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />}</Field>
      <Field label="終了日（JST）">{(p) => <input {...p} className="hd-input" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />}</Field>
      <Button type="submit" variant="primary">
        表示
      </Button>
      {error ? <span className="hd-error-text">{error}</span> : null}
    </form>
  );
}
