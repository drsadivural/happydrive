'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, ErrorAlert, Field } from './ui';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/** ネイティブ <dialog>（フォーカス閉じ込め・Esc で閉じる） */
export function Modal({ open, title, onClose, children, footer }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="hd-dialog"
      aria-labelledby="hd-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <div className="hd-dialog-body">
          <h2 id="hd-dialog-title">{title}</h2>
          {children}
          {footer ? <div className="hd-dialog-actions">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: 'primary' | 'danger' | 'success';
  /** 理由入力を必須にする（契約で reason 必須の操作） */
  requireReason?: boolean;
  /** 理由欄を出すが任意 */
  showReason?: boolean;
  reasonLabel?: string;
  reasonMaxLength?: number;
  pending?: boolean;
  error?: unknown;
  /** 追加の入力欄（例 金額・有効期限） */
  children?: ReactNode;
  /** 追加入力の検証エラー（あれば確定不可） */
  extraError?: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

/** 確認ダイアログ。理由必須の操作では未入力で確定できない。 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '実行する',
  tone = 'primary',
  requireReason,
  showReason,
  reasonLabel = '理由',
  reasonMaxLength = 1000,
  pending,
  error,
  children,
  extraError,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setReason('');
      setTouched(false);
    }
  }
  const trimmed = reason.trim();
  const reasonError =
    requireReason && trimmed.length === 0
      ? `${reasonLabel}を入力してください。`
      : trimmed.length > reasonMaxLength
        ? `${reasonLabel}は${reasonMaxLength}文字以内で入力してください。`
        : undefined;

  return (
    <Modal
      open={open}
      title={title}
      onClose={() => {
        if (!pending) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            キャンセル
          </Button>
          <Button
            variant={tone}
            loading={pending}
            onClick={() => {
              setTouched(true);
              if (reasonError || extraError) return;
              onConfirm(trimmed);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description ? <div>{description}</div> : null}
      {children}
      {requireReason || showReason ? (
        <Field label={reasonLabel} required={requireReason} error={touched ? reasonError : undefined} hint={`${reasonMaxLength}文字以内`}>
          {(p) => (
            <textarea
              {...p}
              className="hd-textarea"
              value={reason}
              maxLength={reasonMaxLength}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
      ) : null}
      {touched && extraError ? <span className="hd-error-text">{extraError}</span> : null}
      <ErrorAlert error={error} title="操作できませんでした" />
    </Modal>
  );
}
