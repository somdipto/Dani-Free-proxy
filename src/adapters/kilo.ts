import type {
  BackendAdapter,
  BackendHealth,
  BackendModel,
  Capability,
  ChatRequest,
} from "../types";
import { redactDiagnostics } from "../redact";
import { readCappedJson } from "./capped-json";

export const KILO_DEFAULT_BASE_URL = "https://api.kilo.ai/api/gateway";

const CANONICAL_FREE_MODEL_IDS = [
  "kilo-auto/free",
  "qwen/qwen3.8-27b:free",
  "poolside/laguna-s-2.1:free",
  "stepfun/step-3.7-flash:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "nex-agi/nex-n2.5-pro:free",
  "inclusionai/ling-3.0-flash-vl:free",
  "dots-studio/dots-3-note-preview:free",
  "liquid/lfm-2.5-2.6b:free",
  "openrouter/free",
  "nex-agi/nex-n2.5-mini:free",
  "cohere/north-mini-code:free",
  "poolside/laguna-xs-2.1:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "nvidia/nemotron-3.5-lightning:free",
  "inclusionai/ling-3.0-flash-fin:free",
  "thinkingmachines/inkling-small:free",
] as const;

const CANONICAL_FREE_MODEL_SET: ReadonlySet<string> = new Set(CANONICAL_FREE_MODEL_IDS);

const FREE_MODEL_PRIORITY = [
  "nex-agi/nex-n2.5-pro:free",
  "dots-studio/dots-3-note-preview:free",
  "nex-agi/nex-n2.5-mini:free",
  "poolside/laguna-s-2.1:free",
  "thinkingmachines/inkling-small:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "qwen/qwen3.8-27b:free",
  "stepfun/step-3.7-flash:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3.5-lightning:free",
  "poolside/laguna-xs-2.1:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "liquid/lfm-2.5-2.6b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
] as const;

function prioritizeFreeModels(models: BackendModel[]): BackendModel[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const preferred = FREE_MODEL_PRIORITY.flatMap((id) => {
    const model = byId.get(id);
    return model ? [model] : [];
  });
  const selected = new Set(preferred.map((model) => model.id));
  return [...preferred, ...models.filter((model) => !selected.has(model.id))];
}
export interface KiloAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  fetcher?: typeof globalThis.fetch;
}




/** A normalized error for an HTTP failure returned by the Kilo gateway. */
export class KiloBackendError extends Error {
  readonly backend = "kilo" as const;
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  readonly url: string;

  constructor(url: string, status: number, statusText: string, body: string) {
    const detail = extractErrorDetail(body);
    super(
      `Kilo gateway request failed (${status}${statusText ? ` ${statusText}` : ""})${detail ? `: ${detail}` : ""}`,
    );
    this.name = "KiloBackendError";
    this.url = url;
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

class KiloConfigurationError extends Error {
  readonly backend = "kilo" as const;

  constructor() {
    super("Kilo backend is not configured: set DANI_FREE_KILO_API_KEY");
    this.name = "KiloConfigurationError";
  }
}

/**
 * Kilo Code's OpenAI-compatible AI Gateway.
 *
 * The gateway's upstream model id is deliberately used unchanged for both
 * discovery and completion requests. This matters because ids can carry the
 * provider/model routing information understood by Kilo.
 */
export class KiloAdapter implements BackendAdapter {
  readonly id = "kilo" as const;
  readonly baseUrl: string;

  private readonly apiKey?: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: KiloAdapterOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? readEnvironment("DANI_FREE_KILO_BASE_URL") ?? KILO_DEFAULT_BASE_URL,
    );
    this.apiKey = normalizeSecret(options.apiKey ?? readEnvironment("DANI_FREE_KILO_API_KEY"));
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async listModels(signal?: AbortSignal): Promise<BackendModel[]> {
    const response = await this.request("/models", {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    const payload: unknown = await readCappedJson(response, MAX_KILO_DISCOVERY_BYTES, DISCOVERY_MESSAGES);
    const models = parseModels(payload);
    const freeModels = models.filter((model) => CANONICAL_FREE_MODEL_SET.has(model.id));
    return prioritizeFreeModels(freeModels);
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
      await this.request("/models", {
        method: "GET",
        headers: { Accept: "application/json" },
        signal,
      });
      return {
        backend: this.id,
        configured: true,
        healthy: true,
        checkedAt,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        backend: this.id,
        configured: true,
        healthy: false,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        // Exposed on GET /health: same redaction pass as router failover
        // reasons so a misbehaving gateway cannot leak a signed URL or
        // credential into its health report.
        reason: error instanceof Error ? redactDiagnostics(error.message) : String(error),
      };
    }
  }

  async complete(request: ChatRequest, model: BackendModel, signal: AbortSignal): Promise<Response> {
    return this.request("/chat/completions", {
      method: "POST",
      headers: {
        Accept: request.stream ? "text/event-stream, application/json" : "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...request, model: model.id }),
      signal,
    });
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const startedAt = Date.now();
    const headers = new Headers(init.headers);
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, headers });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        console.error(`[kilo] aborted ${path} after ${Date.now() - startedAt}ms`);
        throw error;
      }
      if (error instanceof Error) {
        console.error(`[kilo] transport failure ${path} after ${Date.now() - startedAt}ms: ${error.message}`);
        throw new Error(`Kilo gateway request failed: ${error.message}`, { cause: error });
      }
      throw new Error(`Kilo gateway request failed: ${String(error)}`);
    }
    console.error(`[kilo] ${init.method ?? "GET"} ${path} -> ${response.status} in ${Date.now() - startedAt}ms`);
    if (!response.ok) {
      const body = await readErrorSnippet(response, init.signal ?? undefined);
      throw new KiloBackendError(url, response.status, response.statusText, body);
    }
    return response;
  }
}

function parseModels(payload: unknown): BackendModel[] {
  const rows = isRecord(payload) && Array.isArray(payload.data) ? payload.data : undefined;
  if (!rows) {
    throw new Error("Kilo gateway returned an invalid /models response: expected a data array");
  }

  return rows.flatMap((row): BackendModel[] => {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id) return [];
    return [mapModel(row)];
  });
}

function mapModel(row: Record<string, unknown>): BackendModel {
  const capabilities = modelCapabilities(row);
  return {
    id: row.id as string,
    backend: "kilo",
    name: typeof row.name === "string" && row.name ? row.name : (row.id as string),
    capabilities,
    contextWindow: positiveNumber(
      row.contextWindow ?? row.context_window ?? row.context_length ??
        (isRecord(row.limits) ? row.limits.context_window : undefined),
    ),
    maxTokens: positiveNumber(
      row.maxTokens ?? row.max_tokens ?? row.max_output_tokens ??
        (isRecord(row.limits) ? row.limits.max_output_tokens : undefined),
    ),
    healthy: true,
    source: "discovered",
  };
}

function modelCapabilities(row: Record<string, unknown>): Capability[] {
  const capabilities: Capability[] = ["text", "tools", "reasoning"];
  const declared = Array.isArray(row.capabilities)
    ? row.capabilities.filter((value): value is string => typeof value === "string")
    : [];
  const modalities = Array.isArray(row.modalities)
    ? row.modalities.filter((value): value is string => typeof value === "string")
    : [];
  const values = new Set([...declared, ...modalities].map((value) => value.toLowerCase()));
  if (values.has("image") || values.has("vision") || values.has("multimodal")) capabilities.push("image");
  return capabilities;
}

/** Max upstream error-body bytes read when building a KiloBackendError. Parity with the router's own error-snippet cap: a bloated upstream error page must not be buffered whole. */
const MAX_KILO_ERROR_BODY_BYTES = 2_048;

/**
 * Max /models discovery-body bytes parsed for a 200 response. A 200 with an
 * anomalously large body (multi-MB gateway HTML) must fail discovery instead
 * of being buffered whole: discovery refetches on every cache miss, so an
 * unbounded parse is a memory-exhaustion shape.
 */
export const MAX_KILO_DISCOVERY_BYTES = 1_048_576;

/** Failure messages for the shared capped-JSON discovery reader. */
const DISCOVERY_MESSAGES = {
  empty: "Kilo gateway returned an empty /models response",
  oversize: (maxBytes: number) => `Kilo gateway returned a /models response exceeding ${maxBytes} bytes`,
} as const;

/**
 * Read at most `MAX_KILO_ERROR_BODY_BYTES` of an upstream error body, then
 * stop the stream. Mirrors the router's readUpstreamSnippet: mid-read body
 * failures diagnose as nothing, like the old full-read path. The read also
 * honors the caller's abort signal: a gateway that answers with an error
 * status and then trickles (or never finishes) the error body must fail fast
 * on caller cancellation instead of stalling the failover chain until the
 * router's outer deadline fires. Cancellation rethrows the abort error (never
 * retried); genuine body failures still diagnose with nothing.
 */
async function readErrorSnippet(response: Response, signal?: AbortSignal | null): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    // Cancelling makes the pending read() below settle with { done: true }
    // instead of hanging on the dead stream.
    void reader.cancel(abortReason(signal)).catch(() => undefined);
  };
  try {
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    while (bytes < MAX_KILO_ERROR_BODY_BYTES) {
      const part = await reader.read();
      // The caller left (deadline or client cancel): surface the abort so the
      // router treats it as cancellation, not a retryable network error.
      if (aborted) throw abortReason(signal);
      if (part.done) break;
      chunks.push(part.value);
      bytes += part.value.byteLength;
    }
    // Enforce the byte cap exactly: one upstream chunk can be larger than
    // the cap on its own, so slice after concat rather than trusting chunk size.
    return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_KILO_ERROR_BODY_BYTES));
  } catch (error) {
    if (isAbortError(error)) throw error;
    return "";
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function abortReason(signal?: AbortSignal | null): unknown {
  return signal?.reason instanceof DOMException
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function extractErrorDetail(body: string): string {
  if (!body) return "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : parsed;
      for (const key of ["message", "detail", "error"]) {
        if (typeof error[key] === "string" && error[key]) return truncate(error[key]);
      }
    }
  } catch {
    // The gateway may return plain text; use it below.
  }
  return truncate(body.trim());
}

function positiveNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (parsed > 0 && Number.isSafeInteger(parsed)) return parsed;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return (trimmed || KILO_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function normalizeSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function readEnvironment(name: string): string | undefined {
  return typeof Bun !== "undefined" ? Bun.env[name] : undefined;
}

function truncate(value: string): string {
  return value.length > 1000 ? `${value.slice(0, 997)}...` : value;
}
