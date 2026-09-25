'use client';
import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { errorMessage } from '../errors';
import type { StatusLabel, Tone } from '../labels';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  loading?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', loading, disabled, children, className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('hd-btn', variant !== 'secondary' && `hd-btn--${variant}`, size === 'sm' && 'hd-btn--sm', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="hd-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('hd-card', className)}>
      {title || actions ? (
        <div className="hd-card-header">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="hd-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function StatCard({ label, value, tone = 'blue' }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <section className="hd-card" aria-label={label}>
      <div className="hd-stat-label">{label}</div>
      <div className={cx('hd-stat-value', `hd-tone-${tone}`)}>{value}</div>
    </section>
  );
}

export function StatusPill({ status, soft }: { status: StatusLabel; soft?: boolean }) {
  return <span className={cx('hd-pill', `hd-tone-${status.tone}`, soft && 'hd-pill--soft')}>{status.label}</span>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="hd-page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="hd-actions">{actions}</div> : null}
    </header>
  );
}

export function Alert({ tone = 'blue', title, children, role }: { tone?: Tone; title?: ReactNode; children?: ReactNode; role?: 'alert' | 'status' }) {
  return (
    <div className={cx('hd-alert', `hd-tone-${tone}`)} role={role ?? (tone === 'red' ? 'alert' : 'status')}>
      {title ? <strong>{title}</strong> : null}
      {children}
    </div>
  );
}

/** API エラーの表示。409/422 などは API の message（日本語）をそのまま表示する。 */
export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  return (
    <Alert tone="red" title={title ?? 'エラー'} role="alert">
      {errorMessage(error)}
    </Alert>
  );
}

export function LoadingState({ label = '読み込み中…' }: { label?: string }) {
  return (
    <div className="hd-state" role="status" aria-live="polite">
      <span className="hd-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="hd-state">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="hd-state" role="alert">
      <strong style={{ color: 'var(--hd-danger)' }}>読み込みに失敗しました</strong>
      <span>{errorMessage(error)}</span>
      {onRetry ? (
        <Button variant="primary" onClick={onRetry}>
          再試行
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 読込・失敗・空・成功の表示切替。データ取得済みでバックグラウンド更新が失敗した場合はデータを残してエラーを上に出す。
 */
export function AsyncView<T>({
  state,
  empty,
  isEmpty,
  children,
  loadingLabel,
}: {
  state: { data: T | undefined; error: unknown; loading: boolean; reload: () => void };
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
  loadingLabel?: string;
}) {
  if (state.data === undefined) {
    if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
    return <LoadingState label={loadingLabel} />;
  }
  const emptyNow = isEmpty ? isEmpty(state.data) : Array.isArray(state.data) && state.data.length === 0;
  return (
    <>
      {state.error ? (
        <Alert tone="orange" title="最新の情報を取得できませんでした">
          {errorMessage(state.error)}{' '}
          <button type="button" className="hd-btn hd-btn--ghost hd-btn--sm" onClick={state.reload}>
            再試行
          </button>
        </Alert>
      ) : null}
      {emptyNow && empty ? empty : children(state.data)}
    </>
  );
}

export interface FieldProps {
  label: ReactNode;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string; required?: boolean }) => ReactNode;
  className?: string;
}

/** ラベル・ヒント・エラーをアクセシブルに関連付けるフォーム項目 */
export function Field({ label, error, hint, required, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('hd-field', className)}>
      <label htmlFor={id}>
        {label}
        {required ? <span className="hd-required">必須</span> : null}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': describedBy, required })}
      {hint ? (
        <span id={hintId} className="hd-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errId} className="hd-error-text">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  label: string;
}) {
  return (
    <div className="hd-tabs" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          className="hd-tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {typeof o.count === 'number' ? `（${o.count}）` : ''}
        </button>
      ))}
    </div>
  );
}

export function KeyValue({ items }: { items: ReadonlyArray<[ReactNode, ReactNode]> }) {
  return (
    <dl className="hd-kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v === undefined || v === null || v === '' ? '—' : v}</dd>
        </div>
      ))}
    </dl>
  );
}
