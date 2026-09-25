import { describe, expect, it } from 'vitest';
import { latestCreatedAt, mergeMessages, type Message } from '@/lib/chat';

const m = (id: string, createdAt: string, body = id): Message => ({ id, assignmentId: 'a', senderRole: 'worker', body, createdAt });

describe('mergeMessages', () => {
  it('重複を除き作成日時順に並べる（同じIDは新しい内容で置換）', () => {
    const merged = mergeMessages([m('1', '2026-10-01T00:00:00Z'), m('2', '2026-10-01T00:01:00Z')], [m('2', '2026-10-01T00:01:00Z', 'hidden'), m('3', '2026-10-01T00:00:30Z')]);
    expect(merged.map((x) => x.id)).toEqual(['1', '3', '2']);
    expect(merged[2]!.body).toBe('hidden');
    expect(latestCreatedAt(merged)).toBe('2026-10-01T00:01:00Z');
    expect(latestCreatedAt([])).toBeUndefined();
  });
});
