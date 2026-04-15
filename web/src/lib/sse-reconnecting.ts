const DEFAULT_MAX_BACKOFF_MS = 60_000;
const RESYNC_THROTTLE_MS = 2000;

export interface ReconnectingSseOptions {
  onOpen?: () => void;
  /** HTTP refresh when the transport may have dropped (throttled). */
  onResync?: () => void | Promise<void>;
  maxBackoffMs?: number;
}

/**
 * EventSource with resync on (re)open, throttled HTTP refresh on errors, and a
 * fresh EventSource when the browser gives up (readyState === CLOSED).
 */
export function subscribeReconnectingSse(
  url: string,
  attach: (es: EventSource) => void,
  options?: ReconnectingSseOptions,
): () => void {
  let aborted = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let currentEs: EventSource | null = null;
  let lastResync = 0;

  const clearTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const start = () => {
    if (aborted) return;
    clearTimer();
    const es = new EventSource(url);
    currentEs = es;

    es.onopen = () => {
      if (aborted) return;
      attempt = 0;
      options?.onOpen?.();
    };

    es.onerror = () => {
      if (aborted) return;
      if (es.readyState === EventSource.CONNECTING) return;

      const now = Date.now();
      if (now - lastResync >= RESYNC_THROTTLE_MS) {
        lastResync = now;
        void Promise.resolve(options?.onResync?.()).catch(() => {});
      }

      if (es.readyState !== EventSource.CLOSED) return;
      if (currentEs !== es) return;

      const cap = options?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
      const delay = Math.min(cap, 1000 * Math.pow(2, attempt));
      attempt += 1;

      clearTimer();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (aborted) return;
        if (currentEs !== es) return;
        try {
          es.close();
        } catch {
          /* ignore */
        }
        if (currentEs === es) {
          currentEs = null;
        }
        start();
      }, delay);
    };

    attach(es);
  };

  start();

  return () => {
    aborted = true;
    clearTimer();
    if (currentEs) {
      try {
        currentEs.close();
      } catch {
        /* ignore */
      }
      currentEs = null;
    }
  };
}
