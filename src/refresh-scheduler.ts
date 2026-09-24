import type { RefreshSummary } from "./catalog";

export interface RefreshSchedulerOptions {
  /** Time between refreshes. Default 24h. */
  intervalMs?: number;
  /** Random spread added to each interval so installs don't refresh in lockstep. Default 30 min. */
  jitterMs?: number;
  /** Refresh once right away (app boot). Default true. */
  refreshOnStart?: boolean;
  onResult?: (summary: RefreshSummary | undefined) => void;
  onError?: (error: unknown) => void;
}

export interface RefreshScheduler {
  stop(): void;
  /** Resolves when the boot-time refresh settles (immediately if refreshOnStart is false). */
  readonly firstRefresh: Promise<void>;
}

/**
 * Refresh on boot, then every interval (plus jitter). Timers are unref'd so
 * they never keep the process alive, and a failed refresh only logs: the
 * previous catalog keeps serving.
 */
export function startRefreshScheduler(
  refresh: () => Promise<RefreshSummary | undefined>,
  options: RefreshSchedulerOptions = {},
): RefreshScheduler {
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
  const jitterMs = options.jitterMs ?? 30 * 60 * 1000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    try {
      const summary = await refresh();
      options.onResult?.(summary);
    } catch (error) {
      options.onError?.(error);
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    const delay = intervalMs + Math.floor(Math.random() * Math.max(0, jitterMs));
    timer = setTimeout(async () => {
      await run();
      scheduleNext();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  };

  const firstRefresh = (options.refreshOnStart ?? true ? run() : Promise.resolve()).then(scheduleNext);

  return {
    firstRefresh,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
