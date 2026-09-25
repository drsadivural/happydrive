import type { components } from '@happydrive/contracts';
import { toCsv } from '@happydrive/web-ui/csv';

type Invoice = components['schemas']['Invoice'];

/** 月次請求明細の CSV（クライアント側生成、Excel 向け UTF-8 BOM 付き）。金額は整数円。 */
export function invoiceToCsv(invoice: Invoice, orgName: string): string {
  const rows: (string | number | null | undefined)[][] = [
    ['組織', orgName],
    ['対象月', invoice.month],
    [],
    ['割当ID', '案件', 'ドライバー', '実施日', '報酬（円）', '実費（円）', '調整（円）'],
    ...invoice.lines.map((l) => [l.assignmentId, l.jobTitle, l.workerDisplayName, l.workDate, l.amountYen, l.expensesYen ?? 0, l.adjustmentsYen ?? 0]),
    [],
    ['ドライバーへの支払', invoice.workerPaymentsYen],
    ['実費', invoice.expensesYen],
    ['手数料', invoice.platformFeeYen],
    ['消費税', invoice.taxYen],
    ['合計（円）', invoice.totalYen],
  ];
  return toCsv(rows);
}

export function invoiceCsvFilename(month: string): string {
  return `happydrive-invoice-${month.replace(/[^0-9-]/g, '')}.csv`;
}
