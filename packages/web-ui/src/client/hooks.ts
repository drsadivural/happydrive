'use client';
/** データ取得・更新の小さなフック。読込/失敗/再試行/ポーリングと Idempotency-Key の再利用を扱う。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../errors';
import { IdempotencyKeeper } from '../idempotency';

export interface QueryState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** 再取得（エラー時の再試行ボタン・更新後の反映） */
  reload: () => void;
  setData: (updater: T | ((prev: T | undefined) => T)) => void;
}

export interface QueryOptions {
  /** false の間は取得しない */
  enabled?: boolean;
  /** ポーリング間隔（ミリ秒）。0/undefined で無効 */
  pollMs?: number;
}

/**
 * `key` が変わると再取得する。fetcher は最新のものを使う（依存配列の代わりに key 文字列で管理）。
 */
export function useQuery<T>(key: string, fetcher: () => Promise<T>, options: QueryOptions = {}): QueryState<T> {
  const { enabled = true, pollMs } = options;
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean; key: string }>({
    data: undefined,
    error: undefined,
    loading: enabled,
    key,
  });
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  // key が変わったら前のデータを捨てる（別組織・別案件のデータを表示しない）
  if (state.key !== key) {
    setState({ data: undefined, error: undefined, loading: enabled, key });
  }

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = (background: boolean) => {
      if (!background) setState((s) => ({ ...s, loading: true, error: undefined }));
      fetcherRef.current().then(
        (data) => {
          if (!cancelled) setState((s) => ({ ...s, data, error: undefined, loading: false }));
        },
        (error: unknown) => {
          if (!cancelled) setState((s) => ({ ...s, error, loading: false }));
        },
      );
    };
    run(false);
    let timer: ReturnType<typeof setInterval> | undefined;
    if (pollMs && pollMs > 0) {
      timer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') run(true);
      }, pollMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [key, enabled, pollMs, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((updater: T | ((prev: T | undefined) => T)) => {
    setState((s) => ({
      ...s,
      data: typeof updater === 'function' ? (updater as (prev: T | undefined) => T)(s.data) : updater,
    }));
  }, []);

  return { data: state.data, error: state.error, loading: enabled && state.loading, reload, setData };
}

export interface MutationState<A, R> {
  run: (args: A) => Promise<R | undefined>;
  pending: boolean;
  error: unknown;
  reset: () => void;
}

/**
 * 変更系操作。利用者の1回の送信ごとに Idempotency-Key を生成し、結果不明の失敗後に
 * 同じ内容で再送した場合は同じキーを再利用する。二重クリックは pending 中に無視する。
 */
export function useMutation<A, R>(
  prefix: string,
  fn: (args: A, idempotencyKey: string) => Promise<R>,
  options: { onSuccess?: (result: R, args: A) => void } = {},
): MutationState<A, R> {
  const keeper = useRef<IdempotencyKeeper | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const fnRef = useRef(fn);
  const onSuccessRef = useRef(options.onSuccess);
  useEffect(() => {
    fnRef.current = fn;
    onSuccessRef.current = options.onSuccess;
  });

  const run = useCallback(
    async (args: A) => {
      if (inFlight.current) return undefined;
      if (!keeper.current) keeper.current = new IdempotencyKeeper(prefix);
      const key = keeper.current.keyFor(args);
      inFlight.current = true;
      setPending(true);
      setError(undefined);
      try {
        const result = await fnRef.current(args, key);
        keeper.current.succeeded();
        onSuccessRef.current?.(result, args);
        return result;
      } catch (e) {
        keeper.current.failed(e instanceof ApiError ? e.retryable : true);
        setError(e);
        return undefined;
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [prefix],
  );
  const reset = useCallback(() => setError(undefined), []);
  return { run, pending, error, reset };
}

/** 現在時刻（interval ごとに更新）。描画中に Date.now() を直接呼ばないための補助。 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
