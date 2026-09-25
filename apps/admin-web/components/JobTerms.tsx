'use client';
import type { components } from '@happydrive/contracts';
import { formatDateTimeJst, formatNumber, formatRangeJst, formatYen } from '@happydrive/web-ui/format';
import { categoryLabel, contractTypeLabel, jobStatusLabel, RESTRICTED_CATEGORIES } from '@happydrive/web-ui/labels';
import { Alert, KeyValue, StatusPill } from '@happydrive/web-ui/components';

type OrgJob = components['schemas']['OrgJob'];

/** 審査用に案件の全条件を表示 */
export function JobTerms({ job }: { job: OrgJob }) {
  const restricted = (RESTRICTED_CATEGORIES as readonly string[]).includes(job.category);
  return (
    <div className="hd-stack">
      <div className="hd-row">
        <StatusPill status={jobStatusLabel(job.status)} />
        <StatusPill status={categoryLabel(job.category)} soft />
        <StatusPill status={contractTypeLabel(job.contractType)} soft />
      </div>
      {restricted ? <Alert tone="red">要資格カテゴリ（身体介護・医療関連）です。資格要件・事業審査が確定するまで公開できません。</Alert> : null}
      {job.contractType === 'other_legal_review' ? <Alert tone="red">契約区分「その他（法務審査中）」は公開できません。</Alert> : null}
      {job.contractType === 'employment' && !job.employmentTermsText ? <Alert tone="orange">雇用の案件ですが労働条件の記載がありません。</Alert> : null}

      <section>
        <h3 style={{ fontSize: 16, marginBottom: 8 }}>公開前チェック</h3>
        {job.publishChecks && job.publishChecks.length > 0 ? (
          <ul className="hd-stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 6 }}>
            {job.publishChecks.map((c) => (
              <li key={c.code} className="hd-row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                <StatusPill status={c.ok ? { label: 'OK', tone: 'green' } : { label: 'NG', tone: 'red' }} soft />
                <span>
                  {c.message} <span className="hd-small hd-muted">({c.code})</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hd-muted" style={{ margin: 0 }}>
            チェック結果はありません。
          </p>
        )}
      </section>

      <KeyValue
        items={[
          ['発注者', `${job.organizationName}${job.organizationVerified ? '（審査済）' : '（未審査）'}`],
          ['発注者所在地', job.organizationAddress],
          ['発注者連絡先', job.organizationContact],
          ['日時', formatRangeJst(job.startsAt, job.endsAt)],
          ['報酬（1人）', formatYen(job.amountYen)],
          ['実費負担', job.expensesReimbursedYen !== undefined ? formatYen(job.expensesReimbursedYen) : '—'],
          ['ドライバー負担の費用', job.workerBorneCostsNote],
          ['募集人数', `${formatNumber(job.capacity)}人（残り${formatNumber(job.remainingCapacity)}人）`],
          ['住所', job.address],
          ['公開用の地域名', job.areaLabel],
          ['緯度・経度', `${job.location.latitude}, ${job.location.longitude}`],
          ['チェックイン範囲', job.checkInRadiusMeters ? `${job.checkInRadiusMeters}m` : '—'],
          ['発注者承認', job.requiresOrgApproval ? `必要（${job.reservationTtlMinutes ?? '—'}分）` : '不要'],
          ['必要な資格', job.requiredSkillNames?.join('、') || job.requiredSkills.join('、') || 'なし'],
          ['必要な写真', `${job.minPhotoCount ?? 0}枚`],
          ['支払条件', job.paymentTermsText],
          ['連絡担当者', job.contactName],
          ['集合場所', job.meetingPointNote],
          ['安全上の注意', job.safetyNotes],
          ['作成日時', formatDateTimeJst(job.createdAt)],
          ['審査メモ', job.reviewNote],
        ]}
      />
      {job.contractType === 'employment' ? (
        <section>
          <h3 style={{ fontSize: 16, marginBottom: 8 }}>労働条件</h3>
          <p className="hd-pre">{job.employmentTermsText ?? '（未記載）'}</p>
        </section>
      ) : null}
      <section>
        <h3 style={{ fontSize: 16, marginBottom: 8 }}>業務内容</h3>
        <p className="hd-pre">{job.description}</p>
      </section>
      <section>
        <h3 style={{ fontSize: 16, marginBottom: 8 }}>作業手順</h3>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          {job.steps.map((s, i) => (
            <li key={i}>
              {s.title}
              {s.requiresPhoto ? '（写真必須）' : ''}
              {s.description ? <div className="hd-small hd-muted hd-pre">{s.description}</div> : null}
            </li>
          ))}
        </ol>
      </section>
      <section>
        <h3 style={{ fontSize: 16, marginBottom: 8 }}>キャンセル規定</h3>
        <p className="hd-small" style={{ margin: 0 }}>
          開始{job.cancellationPolicy.freeCancelHoursBefore}時間前まで無償 / 期限後の発注者取消の補償 {job.cancellationPolicy.lateCancelCompensationPercent}%
        </p>
        <p className="hd-pre">{job.cancellationPolicy.text}</p>
      </section>
    </div>
  );
}
