import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BackendAdapter, BackendModel, Capability } from "./types";

/**
 * Persistent model catalog.
 *
 * Every refresh pulls each backend's live model list, diffs it against what we
 * knew, optionally probes models we have never seen answer, and saves the
 * result. The router ranks `auto` and the picker list from this catalog, and
 * records each real attempt's outcome here, so a model that keeps failing
 * drops out of `auto` and the picker until it answers again.
 *
 * A refresh that fails keeps the previous catalog: nothing a refresh does can
 * take chat down.
 */

export interface CatalogEntry {
  selector: string;
  backend: string;
  id: string;
  name: string;
  capabilities: Capability[];
  contextWindow: number;
  maxTokens: number;
  /** Discovery order within its backend at the last refresh (lower = preferred). */
  order: number;
  firstSeen: string;
  lastSeen: string;
  /** Present in the backend's list at the most recent successful refresh of that backend. */
  present: boolean;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  successes: number;
  failures: number;
  /** Exponential moving average of time-to-response for successful attempts. */
  latencyMs?: number;
  /** Rate-limited until this time: still offered, but tried after models that are not cooling down. */
  cooldownUntil?: string;
  rateLimits?: number;
  /** Present when the catalog was first populated (first install): never flagged new. */
  baseline?: boolean;
}

/**
 * A whole backend is out of free quota (not one model rate-limited): every
 * model on it is skipped until `until`, then it is probed and brought back on
 * the first success.
 */
export interface BackendQuota {
  until: string;
  since: string;
  reason: string;
  hits: number;
}

export interface CatalogFile {
  version: 1;
  backendQuota?: Record<string, BackendQuota>;
  /** When the first refresh populated this catalog; models present then are not flagged new. */
  createdAt?: string;
  refreshedAt?: string;
  lastRefreshError?: string;
  entries: Record<string, CatalogEntry>;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  /** The model answered with a rate limit: capacity, not breakage. */
  rateLimited?: boolean;
  retryAfterMs?: number;
}

export interface FailureInfo {
  rateLimited?: boolean;
  retryAfterMs?: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
/** First hold when a backend's free quota runs out with no Retry-After. Doubles per repeat hit, up to 6h. */
export const DEFAULT_QUOTA_HOLD_MS = 30 * 60_000;
export const MAX_QUOTA_HOLD_MS = 6 * 60 * 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

/** True when a failure reason or status is a rate limit (HTTP 429 or a rate-limit code). */
export function isRateLimitFailure(status: number | undefined, reason: string): boolean {
  return status === 429 || /\b429\b|rate[ _-]?limit/i.test(reason);
}

export type Prober = (adapter: BackendAdapter, model: BackendModel, signal: AbortSignal) => Promise<ProbeResult>;

export interface RefreshSummary {
  refreshedAt: string;
  total: number;
  visible: number;
  added: string[];
  removed: string[];
  probed: Array<{ selector: string; ok: boolean; error?: string }>;
  backendErrors: Array<{ backend: string; error: string }>;
}

export interface CatalogOptions {
  /** Where the catalog is persisted. Omit for an in-memory catalog. */
  path?: string;
  now?: () => Date;
  /** Days a newly seen model carries the `new` flag. Default 7. */
  newBadgeDays?: number;
  /** Consecutive failed attempts before a model is hidden. Default 3. */
  hideAfterFailures?: number;
}

const LATENCY_WEIGHT = 0.3;

/** Same shape the router uses: ids that already carry their backend prefix (OpenCode) are not prefixed twice. */
export function selectorOf(model: Pick<BackendModel, "backend" | "id">): string {
  return model.id.startsWith(`${model.backend}/`) ? model.id : `${model.backend}/${model.id}`;
}

export class ModelCatalog {
  readonly path?: string;
  readonly newBadgeDays: number;
  readonly hideAfterFailures: number;
  private readonly now: () => Date;
  private data: CatalogFile = { version: 1, entries: {} };
  private refreshing?: Promise<RefreshSummary>;

  constructor(options: CatalogOptions = {}) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
    this.newBadgeDays = options.newBadgeDays ?? 7;
    this.hideAfterFailures = options.hideAfterFailures ?? 3;
    this.load();
  }

  get refreshedAt(): string | undefined {
    return this.data.refreshedAt;
  }

  get lastRefreshError(): string | undefined {
    return this.data.lastRefreshError;
  }

  /** True once at least one refresh has produced entries. */
  get populated(): boolean {
    return Object.keys(this.data.entries).length > 0;
  }

  entries(): CatalogEntry[] {
    return Object.values(this.data.entries);
  }

  get(selector: string): CatalogEntry | undefined {
    return this.data.entries[selector];
  }

  isHidden(entry: CatalogEntry): boolean {
    return !entry.present || entry.consecutiveFailures >= this.hideAfterFailures;
  }

  isNew(entry: CatalogEntry): boolean {
    const first = Date.parse(entry.firstSeen);
    if (!Number.isFinite(first)) return false;
    // Everything on a first install is the baseline, not "new".
    if (entry.baseline) return false;
    return this.now().getTime() - first < this.newBadgeDays * 86_400_000;
  }

  /** Backends currently out of free quota. */
  exhaustedBackends(): string[] {
    const nowIso = this.now().toISOString();
    return Object.entries(this.data.backendQuota ?? {})
      .filter(([, quota]) => quota.until > nowIso)
      .map(([backend]) => backend);
  }

  /** Backends whose quota hold has passed but have not answered since: due for a recovery probe. */
  backendsDueForProbe(): string[] {
    const nowIso = this.now().toISOString();
    return Object.entries(this.data.backendQuota ?? {})
      .filter(([, quota]) => quota.until <= nowIso)
      .map(([backend]) => backend);
  }

  backendQuota(backend: string): BackendQuota | undefined {
    return this.data.backendQuota?.[backend];
  }

  /** Put a whole backend on hold for its quota window. Repeated hits back off longer. */
  recordBackendQuota(backend: string, reason: string, retryAfterMs?: number): void {
    const now = this.now();
    const quotas = (this.data.backendQuota ??= {});
    const previous = quotas[backend];
    const hits = (previous?.hits ?? 0) + 1;
    const backoff = Math.min(MAX_QUOTA_HOLD_MS, DEFAULT_QUOTA_HOLD_MS * 2 ** (hits - 1));
    const wait = retryAfterMs && retryAfterMs > 0 ? Math.min(24 * 60 * 60_000, retryAfterMs) : backoff;
    quotas[backend] = {
      until: new Date(now.getTime() + wait).toISOString(),
      since: previous?.since ?? now.toISOString(),
      reason: reason.slice(0, 200),
      hits,
    };
    this.saveQuietly();
  }

  /** The backend answered: its quota is back. Returns true when a hold was lifted. */
  clearBackendQuota(backend: string): boolean {
    if (!this.data.backendQuota?.[backend]) return false;
    delete this.data.backendQuota[backend];
    this.saveQuietly();
    return true;
  }

  /**
   * Selectors in auto order: healthy first, then fewer recent failures, then
   * backend priority, then discovery order. Models on a backend that is out of
   * free quota go last (still there if nothing else is left).
   */
  ranked(backendPriority: readonly string[] = []): string[] {
    const priority = (backend: string) => {
      const index = backendPriority.indexOf(backend);
      return index === -1 ? backendPriority.length : index;
    };
    const nowIso = this.now().toISOString();
    const cooling = (entry: CatalogEntry) => (entry.cooldownUntil && entry.cooldownUntil > nowIso ? 1 : 0);
    const exhausted = new Set(this.exhaustedBackends());
    const held = (entry: CatalogEntry) => (exhausted.has(entry.backend) ? 1 : 0);
    return this.entries()
      .filter((entry) => !this.isHidden(entry))
      .sort((left, right) =>
        held(left) - held(right)
        || cooling(left) - cooling(right)
        || left.consecutiveFailures - right.consecutiveFailures
        || priority(left.backend) - priority(right.backend)
        || left.order - right.order
        || left.selector.localeCompare(right.selector))
      .map((entry) => entry.selector);
  }

  recordSuccess(selector: string, latencyMs: number): void {
    if (this.recordSuccessNoSave(selector, latencyMs)) this.saveQuietly();
  }

  /**
   * A failed attempt. Rate limits only put the model on a short cooldown (it
   * is tried after others but never hidden); real failures count toward
   * hiding it.
   */
  recordFailure(selector: string, reason: string, info: FailureInfo = {}): void {
    if (this.recordFailureNoSave(selector, reason, info)) this.saveQuietly();
  }

  /**
   * Refresh from every adapter. Concurrent callers share one refresh.
   * Probing runs only for models that have never answered (new, or never
   * succeeded) and for hidden-by-failure models, so a routine refresh costs
   * one list call per backend.
   */
  refresh(adapters: readonly BackendAdapter[], options: { signal?: AbortSignal; prober?: Prober; probeConcurrency?: number } = {}): Promise<RefreshSummary> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(adapters, options).finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(
    adapters: readonly BackendAdapter[],
    options: { signal?: AbortSignal; prober?: Prober; probeConcurrency?: number },
  ): Promise<RefreshSummary> {
    const nowIso = this.now().toISOString();
    const added: string[] = [];
    const removed: string[] = [];
    const backendErrors: Array<{ backend: string; error: string }> = [];
    const discovered = new Map<string, { adapter: BackendAdapter; model: BackendModel }>();
    const firstPopulate = !this.populated;

    const results = await Promise.all(adapters.map(async (adapter) => {
      try {
        return { adapter, models: await adapter.listModels(options.signal) };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return { adapter, error: error instanceof Error ? error.message : String(error) };
      }
    }));

    for (const result of results) {
      if ("error" in result && result.error !== undefined) {
        // Keep this backend's previous entries as they were: a failed list is not evidence the models are gone.
        backendErrors.push({ backend: result.adapter.id, error: result.error.slice(0, 300) });
        continue;
      }
      const models = result.models ?? [];
      if (models.length === 0 && Object.values(this.data.entries).some((entry) => entry.backend === result.adapter.id && entry.present)) {
        // An empty list (sidecar still starting, soft discovery failure) is not
        // evidence every model vanished: keep what we knew.
        backendErrors.push({ backend: result.adapter.id, error: "backend listed no models" });
        continue;
      }
      const seen = new Set<string>();
      models.forEach((model, order) => {
        const selector = selectorOf(model);
        if (seen.has(selector)) return;
        seen.add(selector);
        discovered.set(selector, { adapter: result.adapter, model });
        const existing = this.data.entries[selector];
        if (existing) {
          if (!existing.present) added.push(selector);
          Object.assign(existing, {
            name: model.name,
            capabilities: model.capabilities,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            order,
            lastSeen: nowIso,
            present: true,
          });
        } else {
          added.push(selector);
          this.data.entries[selector] = {
            selector,
            backend: model.backend,
            id: model.id,
            name: model.name,
            capabilities: model.capabilities,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            order,
            firstSeen: nowIso,
            lastSeen: nowIso,
            present: true,
            consecutiveFailures: 0,
            successes: 0,
            failures: 0,
            ...(firstPopulate ? { baseline: true } : {}),
          };
        }
      });
      for (const entry of Object.values(this.data.entries)) {
        if (entry.backend === result.adapter.id && entry.present && !seen.has(entry.selector)) {
          entry.present = false;
          removed.push(entry.selector);
        }
      }
    }

    const probed: Array<{ selector: string; ok: boolean; error?: string }> = [];
    if (options.prober) {
      const targets = [...discovered.entries()].filter(([selector]) => {
        const entry = this.data.entries[selector];
        return entry && (entry.successes === 0 || entry.consecutiveFailures >= this.hideAfterFailures);
      });
      const concurrency = Math.max(1, options.probeConcurrency ?? 2);
      let cursor = 0;
      const worker = async () => {
        while (cursor < targets.length) {
          const [selector, { adapter, model }] = targets[cursor++];
          if (options.signal?.aborted) return;
          const controller = new AbortController();
          const onAbort = () => controller.abort();
          options.signal?.addEventListener("abort", onAbort, { once: true });
          try {
            const result = await options.prober!(adapter, model, controller.signal);
            if (result.ok) this.recordSuccessNoSave(selector, result.latencyMs);
            else this.recordFailureNoSave(selector, result.error ?? "probe failed", { rateLimited: result.rateLimited, retryAfterMs: result.retryAfterMs });
            probed.push({ selector, ok: result.ok, error: result.error });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.recordFailureNoSave(selector, message);
            probed.push({ selector, ok: false, error: message.slice(0, 300) });
          } finally {
            options.signal?.removeEventListener("abort", onAbort);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    }

    const allFailed = adapters.length > 0 && backendErrors.length === adapters.length;
    if (allFailed) {
      this.data.lastRefreshError = backendErrors.map((item) => `${item.backend}: ${item.error}`).join("; ");
    } else {
      this.data.refreshedAt = nowIso;
      if (!this.data.createdAt) this.data.createdAt = nowIso;
      this.data.lastRefreshError = backendErrors.length
        ? backendErrors.map((item) => `${item.backend}: ${item.error}`).join("; ")
        : undefined;
    }
    this.saveQuietly();
    const visible = this.entries().filter((entry) => !this.isHidden(entry)).length;
    return { refreshedAt: nowIso, total: this.entries().length, visible, added, removed, probed, backendErrors };
  }

  private recordSuccessNoSave(selector: string, latencyMs: number): boolean {
    const entry = this.data.entries[selector];
    if (!entry) return false;
    entry.successes += 1;
    entry.consecutiveFailures = 0;
    entry.cooldownUntil = undefined;
    entry.lastOkAt = this.now().toISOString();
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      entry.latencyMs = entry.latencyMs === undefined
        ? Math.round(latencyMs)
        : Math.round(entry.latencyMs * (1 - LATENCY_WEIGHT) + latencyMs * LATENCY_WEIGHT);
    }
    return true;
  }

  private recordFailureNoSave(selector: string, reason: string, info: FailureInfo = {}): boolean {
    const entry = this.data.entries[selector];
    if (!entry) return false;
    const now = this.now();
    entry.lastErrorAt = now.toISOString();
    entry.lastError = reason.slice(0, 300);
    if (info.rateLimited) {
      entry.rateLimits = (entry.rateLimits ?? 0) + 1;
      const wait = Math.min(MAX_COOLDOWN_MS, Math.max(DEFAULT_COOLDOWN_MS, info.retryAfterMs ?? 0));
      entry.cooldownUntil = new Date(now.getTime() + wait).toISOString();
      return true;
    }
    entry.failures += 1;
    entry.consecutiveFailures += 1;
    return true;
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CatalogFile>;
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        this.data = {
          version: 1,
          createdAt: parsed.createdAt,
          refreshedAt: parsed.refreshedAt,
          lastRefreshError: parsed.lastRefreshError,
          backendQuota: parsed.backendQuota,
          entries: parsed.entries,
        };
      }
    } catch {
      // A corrupt catalog is rebuilt by the next refresh; never fatal.
    }
  }

  private saveQuietly(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      console.error(`[catalog] could not save ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
