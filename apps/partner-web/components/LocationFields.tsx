'use client';
import { useState } from 'react';
import { Field } from '@happydrive/web-ui/components';
import { isRoughlyInJapan, mapPointUrl, mapSearchUrl, parseLatLng } from '@/lib/geo';

/**
 * 緯度・経度の手入力。住所からの自動変換（有料ジオコーダー）は行わない。
 * 外部の地図サイトで住所を開き、地点の座標をコピーして貼り付けてもらう。
 */
export function LocationFields({
  address,
  latitude,
  longitude,
  onChange,
  errors,
  disabled,
}: {
  address: string;
  latitude: string;
  longitude: string;
  onChange: (lat: string, lng: string) => void;
  errors: { latitude?: string; longitude?: string };
  disabled?: boolean;
}) {
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const lat = Number(latitude);
  const lng = Number(longitude);
  const hasPoint = latitude.trim() !== '' && longitude.trim() !== '' && Number.isFinite(lat) && Number.isFinite(lng);

  return (
    <div className="hd-stack">
      <p className="hd-hint" style={{ margin: 0 }}>
        位置は住所から自動計算しません。緯度・経度を手入力するか、地図サイトで地点の座標（例「35.4478, 139.6425」）をコピーして貼り付けてください。
        {address.trim().length >= 4 ? (
          <>
            {' '}
            <a href={mapSearchUrl(address.trim())} target="_blank" rel="noopener noreferrer">
              住所を地図で開く（外部サイト・新しいタブ）
            </a>
          </>
        ) : null}
      </p>
      <div className="hd-field">
        <label className="hd-label" htmlFor="hd-latlng-paste">
          座標を貼り付け（任意）
        </label>
        <div className="hd-row" style={{ flexWrap: 'nowrap' }}>
          <input
            id="hd-latlng-paste"
            className="hd-input"
            placeholder="35.4478, 139.6425"
            value={paste}
            disabled={disabled}
            onChange={(e) => setPaste(e.target.value)}
          />
          <button
            type="button"
            className="hd-btn"
            disabled={disabled || !paste.trim()}
            onClick={() => {
              const p = parseLatLng(paste);
              if (!p) {
                setPasteError('「緯度, 経度」の形式で入力してください（例 35.4478, 139.6425）。');
                return;
              }
              setPasteError(null);
              setPaste('');
              onChange(String(p.latitude), String(p.longitude));
            }}
          >
            反映
          </button>
        </div>
        {pasteError ? <span className="hd-error-text">{pasteError}</span> : null}
      </div>
      <div className="hd-grid-2">
        <Field label="緯度" required error={errors.latitude} hint="-90〜90（例 35.4478）">
          {(p) => (
            <input {...p} className="hd-input" inputMode="decimal" value={latitude} disabled={disabled} onChange={(e) => onChange(e.target.value, longitude)} />
          )}
        </Field>
        <Field label="経度" required error={errors.longitude} hint="-180〜180（例 139.6425）">
          {(p) => (
            <input {...p} className="hd-input" inputMode="decimal" value={longitude} disabled={disabled} onChange={(e) => onChange(latitude, e.target.value)} />
          )}
        </Field>
      </div>
      {hasPoint ? (
        <div className="hd-small">
          {!isRoughlyInJapan({ latitude: lat, longitude: lng }) ? (
            <span className="hd-error-text">日本国外の座標です。緯度と経度が逆になっていないか確認してください。 </span>
          ) : null}
          <a href={mapPointUrl({ latitude: lat, longitude: lng })} target="_blank" rel="noopener noreferrer">
            入力した座標を地図で確認（外部サイト）
          </a>
        </div>
      ) : null}
    </div>
  );
}
