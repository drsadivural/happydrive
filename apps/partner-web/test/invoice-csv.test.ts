import { describe, expect, it } from 'vitest';
import { invoiceCsvFilename, invoiceToCsv } from '@/lib/invoice-csv';

describe('invoiceToCsv', () => {
  it('明細と合計を CSV にする', () => {
    const csv = invoiceToCsv(
      {
        month: '2026-09',
        totalYen: 11000,
        workerPaymentsYen: 9000,
        expensesYen: 500,
        platformFeeYen: 500,
        taxYen: 1000,
        lines: [
          { assignmentId: 'a1', jobTitle: '買い物, 付き添い', workerDisplayName: '山田', workDate: '2026-09-10', amountYen: 4500, expensesYen: 500 },
          { assignmentId: 'a2', jobTitle: '=見守り', workerDisplayName: '佐藤', workDate: '2026-09-11', amountYen: 4500, adjustmentsYen: -200 },
        ],
      },
      '横浜市',
    );
    const lines = csv.replace('﻿', '').split('\r\n');
    expect(lines[0]).toBe('組織,横浜市');
    expect(lines[3]).toBe('割当ID,案件,ドライバー,実施日,報酬（円）,実費（円）,調整（円）');
    expect(lines[4]).toBe('a1,"買い物, 付き添い",山田,2026-09-10,4500,500,0');
    expect(lines[5]).toBe("a2,'=見守り,佐藤,2026-09-11,4500,0,-200");
    expect(lines).toContain('合計（円）,11000');
    expect(invoiceCsvFilename('2026-09')).toBe('happydrive-invoice-2026-09.csv');
  });
});
