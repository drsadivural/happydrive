'use client';
import { useState } from 'react';
import { errorMessage } from '../errors';
import { formatDateTimeJst } from '../format';
import { Button } from './ui';

export interface EvidenceItem {
  id: string;
  purpose?: string;
  status?: string;
  createdAt?: string;
  contentType?: string;
}

const PURPOSE_LABEL: Record<string, string> = {
  work_photo: '作業写真',
  delivery_photo: '配達写真',
  signature: '署名',
  identity_document: '本人確認書類',
  skill_document: '資格証',
  message_attachment: '添付',
};

/**
 * 証跡のサムネイル。署名URLは表示ボタンを押したときにだけ取得する（取得は API 側で監査記録される）。
 * URL は有効期限付きのため保持しない。
 */
export function EvidenceThumb({ item, getUrl }: { item: EvidenceItem; getUrl: (id: string) => Promise<string> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function load() {
    setPending(true);
    setError(null);
    try {
      setUrl(await getUrl(item.id));
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }

  return (
    <figure className="hd-thumb" style={{ margin: 0 }}>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element -- 有効期限付き署名URLのため最適化しない */}
          <img src={url} alt={`${PURPOSE_LABEL[item.purpose ?? ''] ?? '証跡'}（${formatDateTimeJst(item.createdAt)}）`} referrerPolicy="no-referrer" />
        </a>
      ) : (
        <Button size="sm" onClick={load} loading={pending} disabled={item.status === 'pending_upload' || item.status === 'rejected'}>
          画像を表示
        </Button>
      )}
      <figcaption>
        {PURPOSE_LABEL[item.purpose ?? ''] ?? item.purpose ?? '証跡'}
        {item.createdAt ? <div className="hd-muted">{formatDateTimeJst(item.createdAt)}</div> : null}
        {item.status === 'pending_upload' ? <div className="hd-muted">アップロード未完了</div> : null}
        {item.status === 'rejected' ? <div className="hd-error-text">検証NG</div> : null}
        {error ? <div className="hd-error-text">{errorMessage(error)}</div> : null}
      </figcaption>
    </figure>
  );
}

export function EvidenceGallery({ items, getUrl }: { items: readonly EvidenceItem[]; getUrl: (id: string) => Promise<string> }) {
  if (items.length === 0) return <p className="hd-muted">証跡はありません。</p>;
  return (
    <div className="hd-thumbs">
      {items.map((it) => (
        <EvidenceThumb key={it.id} item={it} getUrl={getUrl} />
      ))}
    </div>
  );
}
