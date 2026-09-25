import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_STATE,
  assignmentStateLabel,
  categoryLabel,
  contractTypeLabel,
  isActiveAssignment,
  JOB_CATEGORIES,
  JOB_STATUS,
  jobStatusLabel,
  orgReviewLabel,
  payoutStatusLabel,
  progressLabel,
  RESTRICTED_CATEGORIES,
  verificationLabel,
} from '../src/labels';

// openapi.yaml v1.1 の列挙値（契約の変更時にこのテストで未対応ラベルを検出する）
const CONTRACT_JOB_STATUS = ['draft', 'pending_review', 'published', 'filled', 'expired', 'cancelled', 'rejected', 'completed'];
const CONTRACT_ASSIGNMENT_STATE = [
  'reserved', 'accepted', 'traveling', 'checked_in', 'working', 'submitted', 'needs_revision', 'approved',
  'payable', 'paid', 'cancelled', 'declined', 'expired', 'no_show', 'disputed', 'refunded',
];
const CONTRACT_CATEGORIES = [
  'elderly_watch', 'life_support', 'shopping_assist', 'corporate_task', 'community_info', 'delivery_related', 'personal_care', 'healthcare',
];

describe('状態ラベル', () => {
  it('案件状態の全列挙値に日本語ラベルがある', () => {
    expect(Object.keys(JOB_STATUS).sort()).toEqual([...CONTRACT_JOB_STATUS].sort());
    expect(jobStatusLabel('published')).toEqual({ label: '募集中', tone: 'blue' });
    expect(jobStatusLabel('pending_review').label).toBe('審査中');
  });
  it('割当状態の全列挙値に日本語ラベルがある', () => {
    expect(Object.keys(ASSIGNMENT_STATE).sort()).toEqual([...CONTRACT_ASSIGNMENT_STATE].sort());
    expect(assignmentStateLabel('submitted')).toEqual({ label: '検収待ち', tone: 'orange' });
    expect(assignmentStateLabel('working')).toEqual({ label: '実施中', tone: 'green' });
  });
  it('未知の値は値そのもの（灰色）、空は —', () => {
    expect(jobStatusLabel('future_status')).toEqual({ label: 'future_status', tone: 'gray' });
    expect(assignmentStateLabel(undefined)).toEqual({ label: '—', tone: 'gray' });
  });
  it('ダッシュボードの progressLabel はモックアップの色', () => {
    expect(progressLabel('実施中').tone).toBe('green');
    expect(progressLabel('募集中').tone).toBe('blue');
    expect(progressLabel('検収待ち').tone).toBe('orange');
    expect(progressLabel('不明').tone).toBe('gray');
  });
  it('業務中の判定（位置共有の表示条件）', () => {
    expect(isActiveAssignment('traveling')).toBe(true);
    expect(isActiveAssignment('checked_in')).toBe(true);
    expect(isActiveAssignment('working')).toBe(true);
    expect(isActiveAssignment('submitted')).toBe(false);
    expect(isActiveAssignment('accepted')).toBe(false);
    expect(isActiveAssignment(undefined)).toBe(false);
  });
  it('その他のラベル', () => {
    expect(orgReviewLabel('pending').label).toBe('審査中');
    expect(orgReviewLabel('suspended').tone).toBe('red');
    expect(verificationLabel('verified').label).toBe('確認済み');
    expect(payoutStatusLabel('failed').tone).toBe('red');
    expect(contractTypeLabel('other_legal_review').label).toBe('その他（法務審査中）');
    expect(contractTypeLabel('employment').label).toBe('雇用');
  });
});

describe('カテゴリ', () => {
  it('契約の全カテゴリを design-tokens のラベルで表示する', () => {
    expect([...JOB_CATEGORIES].sort()).toEqual([...CONTRACT_CATEGORIES].sort());
    expect(categoryLabel('elderly_watch')).toEqual({ label: '高齢者見守り', tone: 'green' });
    expect(categoryLabel('corporate_task').tone).toBe('purple');
  });
  it('要資格カテゴリは公開不可として扱う', () => {
    expect([...RESTRICTED_CATEGORIES].sort()).toEqual(['healthcare', 'personal_care']);
    expect(categoryLabel('healthcare').tone).toBe('red');
  });
});

import { DISCREPANCY_TYPE, EARNING_STATE, earningStateLabel, ticketCategoryLabel } from '../src/labels';

describe('v1.1 追加の列挙値', () => {
  it('報酬状態・照合差異・問い合わせカテゴリ', () => {
    expect(Object.keys(EARNING_STATE).sort()).toEqual(['estimated', 'failed', 'paid', 'payable', 'pending', 'reversed']);
    expect(earningStateLabel('reversed').tone).toBe('red');
    expect(Object.keys(DISCREPANCY_TYPE).sort()).toEqual(['employment_payroll', 'ledger_payout_mismatch', 'payout_failed', 'provider_unconfirmed', 'snapshot_mismatch']);
    expect(ticketCategoryLabel('matching_appeal')).toBe('マッチング異議申立て');
  });
});
