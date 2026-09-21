import type {
  BackendAdapter,
  BackendHealth,
  BackendModel,
  Capability,
  ChatRequest,
} from "./types";

export interface RouterOptions {
  adapters?: BackendAdapter[];
  apiKey?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  primaryModel?: string;
  allowedModels?: readonly string[];
  /**
   * Ordered full selectors (e.g. "opencode/foo", "kilo/bar:free") forming the
   * failover chain. When omitted, the chain is derived from the allowed roster
   * (or discovered models), ordered OpenCode-first, then Kilo.
   */
  modelChain?: string[];
  /** Base backoff before the next chain attempt after a 429. Defaults to 1000ms. */
  failoverBackoffMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const MODEL_CACHE_TTL_MS = 5_000;
export const DEFAULT_PRIMARY_MODEL = "kilo/nex-agi/nex-n2.5-pro:free";
export const DEFAULT_FAILOVER_BACKOFF_MS = 1_000;
/** Response header naming the selector that actually answered the request. */
export const ANSWERED_MODEL_HEADER = "x-dani-free-model";

const BACKENDS = ["opencode", "kilo", "mimo"] as const;

type Route = { backend: BackendAdapter; model: BackendModel };

type ErrorBody = {
  error: {
    message: string;
    type: string;
    code: string;
  };
};


function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function structuredError(
  message: string,
  status: number,
  code: string,
  type = "invalid_request_error",
): Response {
  const body: ErrorBody = { error: { message, type, code } };
  return json(body, status);
}


function isAbort(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  return error instanceof Error && error.name === "AbortError";
}

function abortError(signal?: AbortSignal): DOMException {
  if (signal?.reason instanceof DOMException) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

interface CombinedSignal {
  signal: AbortSignal;
  dispose: () => void;
}

function combineSignals(...sources: Array<AbortSignal | undefined>): CombinedSignal {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const [source, listener] of listeners) source.removeEventListener("abort", listener);
    listeners.clear();
  };
  const abortFrom = (source: AbortSignal) => {
    if (disposed || controller.signal.aborted) return;
    controller.abort(source.reason ?? abortError(source));
    dispose();
  };

  for (const source of sources) {
    if (!source) continue;
    if (source.aborted) {
      abortFrom(source);
      break;
    }
    const listener = () => abortFrom(source);
    source.addEventListener("abort", listener, { once: true });
    listeners.set(source, listener);
  }

  return { signal: controller.signal, dispose };
}

function abortAfter(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(abortError(controller.signal)), Math.max(0, timeoutMs));
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function deadline(parent: AbortSignal | undefined, timeoutMs: number): CombinedSignal {
  const attempt = abortAfter(timeoutMs);
  const combined = combineSignals(parent, attempt.signal);
  return {
    signal: combined.signal,
    dispose: () => {
      attempt.cancel();
      combined.dispose();
    },
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const leftByte = index < leftBytes.length ? leftBytes[index] : 0;
    const rightByte = index < rightBytes.length ? rightBytes[index] : 0;
    difference |= leftByte ^ rightByte;
  }
  return difference === 0;
}

function requestApiKey(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return request.headers.get("x-api-key") ?? undefined;
}

function modelSelector(selector: string): { auto: true } | { auto: false; backendId?: string; id?: string } {
  const trimmed = selector.trim();
  if (trimmed.toLowerCase() === "auto") return { auto: true };
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return { auto: false };
  }
  return {
    auto: false,
    backendId: trimmed.slice(0, separator),
    id: trimmed.slice(separator + 1),
  };
}

function modelSelectorId(model: BackendModel): string {
  return model.id.startsWith(`${model.backend}/`) ? model.id : `${model.backend}/${model.id}`;
}

function publicModel(model: BackendModel): Omit<BackendModel, "backend"> & { id: string } {
  return {
    id: modelSelectorId(model),
    name: model.name,
    capabilities: [...model.capabilities],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    healthy: model.healthy,
    source: model.source,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasImageContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasImageContent);
  if (!isRecord(value)) return false;
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (type === "image" || type === "image_url") return true;
  return ["image", "image_url", "attachment"].some((key) => key in value);
}

function requiredCapabilities(request: ChatRequest): Capability[] {
  const capabilities = new Set<Capability>();
  if (Array.isArray(request.tools) && request.tools.length > 0) capabilities.add("tools");
  if (request.tool_choice !== undefined && request.tool_choice !== null) capabilities.add("tools");
  if (request.reasoning !== undefined || request.reasoning_effort !== undefined) capabilities.add("reasoning");
  if (request.messages.some((message) => hasImageContent(message.content))) capabilities.add("image");
  return [...capabilities];
}

function supportsCapabilities(model: BackendModel, required: Capability[]): boolean {
  return required.every((capability) => model.capabilities.includes(capability));
}

function outputLimitError(request: ChatRequest, model: BackendModel): Response | undefined {
  if (
    typeof request.max_tokens === "number" &&
    Number.isFinite(request.max_tokens) &&
    request.max_tokens > 0 &&
    model.maxTokens > 0 &&
    request.max_tokens > model.maxTokens
  ) {
    return structuredError(
      `Requested max_tokens ${request.max_tokens} exceeds ${model.id} limit ${model.maxTokens}`,
      422,
      "output_limit_exceeded",
    );
  }
  return undefined;
}

function statusFrom(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const status = error.status ?? error.statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
}

function responseFromStatusError(error: unknown): Response | undefined {
  if (!isRecord(error)) return undefined;
  const status = statusFrom(error);
  if (!status) return undefined;
  const statusText = typeof error.statusText === "string" ? error.statusText : undefined;
  const body = typeof error.body === "string" ? error.body : "";
  // An adapter-thrown typed error body (e.g. OpenCodeError.body) is JSON; serve
  // it as JSON so OpenAI-compatible clients can parse the refusal. Plain-text
  // bodies keep their text/plain label.
  let json = false;
  if (body.trim() !== "") {
    try {
      JSON.parse(body);
      json = true;
    } catch {
      // Plain text stays plain text.
    }
  }
  return new Response(body, {
    status,
    statusText,
    headers: {
      "content-type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    },
  });
}

const BACKEND_CHAIN_PRIORITY: Record<string, number> = { opencode: 0, kilo: 1, mimo: 2 };

/** Stable OpenCode-first, then Kilo, then everything else. Founder priority. */
function opencodeFirst(selectors: string[]): string[] {
  const rank = (selector: string): number => {
    const separator = selector.indexOf("/");
    const backend = separator > 0 ? selector.slice(0, separator) : "";
    return BACKEND_CHAIN_PRIORITY[backend] ?? 3;
  };
  return [...selectors].sort((a, b) => rank(a) - rank(b));
}

function withModelHeader(response: Response, selector: string): Response {
  const headers = new Headers(response.headers);
  headers.set(ANSWERED_MODEL_HEADER, selector);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Strip URLs and bearer tokens from any diagnostic text that ends up in a
 * failover reason handed back to the client. Upstream error bodies can carry
 * signed URLs or leaked credentials; error messages already get this pass,
 * and typed JSON error details should too.
 */
function redactDiagnostics(text: string): string {
  return text
    .replace(/https?:\/\/[^\s)"']+/g, "[url]")
    .replace(/bearer\s+[^\s]+/gi, "Bearer [redacted]");
}

function sanitizeReason(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = redactDiagnostics(raw).trim();
  const text = cleaned || fallback;
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function upstreamReason(status: number, statusText: string | undefined, detail: string): string {
  const head = `upstream ${status}${statusText ? ` ${statusText}` : ""}`;
  const trimmed = detail.trim();
  const short = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  return short ? `${head}: ${short}` : head;
}

/** Max error-body bytes read for failure diagnostics; the rest is discarded. */
const MAX_UPSTREAM_ERROR_SNIPPET_BYTES = 2_048;

/**
 * Max upstream 200-body bytes buffered while checking for the empty-content
 * quirk. A real chat-completion payload is small; an anomalous multi-MB
 * body must fail over instead of being buffered into memory whole.
 */
export const MAX_UPSTREAM_RESPONSE_BYTES = 8_388_608;

/**
 * Read at most `maxBytes` of an upstream error body for the failover reason,
 * then stop the stream. A bloated upstream error page (multi-MB gateway HTML
 * on a 502) must not be fully buffered just to diagnose the failure.
 */
async function readUpstreamSnippet(response: Response, signal: AbortSignal, maxBytes = MAX_UPSTREAM_ERROR_SNIPPET_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const part = await raceWithSignal(reader.read(), signal);
      if (part.done) break;
      chunks.push(part.value);
      bytes += part.value.byteLength;
    }
    return new TextDecoder().decode(Buffer.concat(chunks, bytes));
  } catch {
    // A mid-read failure (or caller abort): diagnose with nothing, like the
    // old read-everything path which swallowed body errors the same way.
    return "";
  } finally {
    // Stop pulling the rest of the body once we have the snippet.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Buffer an upstream 200 body up to `maxBytes` for the empty-content guard.
 * Returns `oversize: true` when the body exceeds the cap: the caller fails
 * over instead of buffering an anomalous multi-MB completion into memory.
 * The remainder is cancelled, like the error-snippet reader.
 */
async function readCappedResponseBody(
  response: Response,
  signal: AbortSignal,
  maxBytes = MAX_UPSTREAM_RESPONSE_BYTES,
): Promise<{ text: string; oversize: boolean }> {
  if (!response.body) return { text: "", oversize: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await raceWithSignal(reader.read(), signal);
      if (part.done) break;
      chunks.push(part.value);
      bytes += part.value.byteLength;
      if (bytes > maxBytes) return { text: "", oversize: true };
    }
    return { text: new TextDecoder().decode(Buffer.concat(chunks, bytes)), oversize: false };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Prefer a short human detail from a typed error body over the raw message. */
function errorBodyDetail(error: unknown): string {
  if (!isRecord(error)) return "";
  const body = error.body;
  if (typeof body !== "string" || !body.trim()) return "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const nested = isRecord(parsed.error) ? parsed.error : parsed;
      for (const key of ["message", "detail", "error"]) {
        const value = nested[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  } catch {
    // Fall through to the raw body below.
  }
  return body.trim();
}

function statusTextOf(error: unknown): string | undefined {
  return isRecord(error) && typeof error.statusText === "string" ? error.statusText : undefined;
}

function retryableStatusReason(error: unknown, status: number, fallback: string): string {
  const detail = errorBodyDetail(error) || sanitizeReason(error, fallback);
  return upstreamReason(status, statusTextOf(error), redactDiagnostics(detail));
}

/**
 * True when a parsed JSON body carries real answer text (or tool calls),
 * false when it is an empty chat completion (the Kilo empty-content quirk),
 * undefined when it is not a chat-completion shape at all (opaque: pass through).
 */
function chatCompletionHasContent(payload: unknown): boolean | undefined {
  if (!isRecord(payload)) return undefined;
  const choices = payload.choices;
  if (!Array.isArray(choices)) return undefined;
  if (choices.length === 0) return false;
  const choice = choices[0];
  if (!isRecord(choice)) return false;
  const message = isRecord(choice.message) ? choice.message : isRecord(choice.delta) ? choice.delta : undefined;
  if (!message) return false;
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(
      (part) => isRecord(part) && typeof part.text === "string" && part.text.trim().length > 0,
    );
  }
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return true;
  return false;
}

interface AttemptFailure {
  model: string;
  reason: string;
  status?: number;
}

function allModelsFailedResponse(failures: AttemptFailure[]): Response {
  const summary = failures.map((failure) => `${failure.model}: ${failure.reason}`).join("; ");
  return json(
    {
      error: {
        message: `All ${failures.length} model${failures.length === 1 ? "" : "s"} in the failover chain failed${summary ? `: ${summary}` : ""}`,
        type: "api_error",
        code: "all_models_failed",
      },
      attempts: failures,
    },
    503,
  );
}

function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("json");
}

/** A Response whose body immediately fails with the upstream's read error. */
function failedBodyResponse(response: Response, error: unknown): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}


async function readBody(request: Request, maxBodyBytes: number, signal: AbortSignal): Promise<string | Response> {
  if (signal.aborted) throw abortError(signal);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel(abortError(signal)).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const part = await raceWithSignal(reader.read(), signal);
      if (signal.aborted) throw abortError(signal);
      if (part.done) return new TextDecoder().decode(Buffer.concat(chunks, bytes));
      bytes += part.value.byteLength;
      if (bytes > maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        return structuredError(`Request body exceeds ${maxBodyBytes} bytes`, 413, "request_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function parseRequest(body: string): ChatRequest | Response {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return structuredError("Request body must be valid JSON", 400, "invalid_json");
  }
  if (!isRecord(value)) return structuredError("Request body must be a JSON object", 400, "invalid_request");
  if (typeof value.model !== "string" || !value.model.trim()) {
    return structuredError("model is required", 422, "invalid_request");
  }
  if (!Array.isArray(value.messages) || value.messages.some((message) => !isRecord(message))) {
    return structuredError("messages must be an array of objects", 422, "invalid_request");
  }
  return value as unknown as ChatRequest;
}

function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sseStopFrame(): Uint8Array {
  return new TextEncoder().encode(
    `data: ${JSON.stringify({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`,
  );
}

function responseWithDeadline(response: Response, scope: CombinedSignal): Response {
  if (!response.body) {
    scope.dispose();
    return response;
  }
  const reader = response.body.getReader();
  let settled = false;
  let onAbort: () => void;
  const sse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  const dispose = () => {
    if (settled) return;
    settled = true;
    scope.signal.removeEventListener("abort", onAbort);
    scope.dispose();
    reader.releaseLock();
  };
  const finishSse = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!sse) {
      controller.error(abortError(scope.signal));
      return;
    }
    try { controller.enqueue(sseStopFrame()); } catch { /* already closed */ }
    try { controller.close(); } catch { /* already closed */ }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (settled) return;
        finishSse(controller);
        void reader.cancel(abortError(scope.signal)).catch(() => undefined);
        dispose();
      };
      scope.signal.addEventListener("abort", onAbort, { once: true });
      if (scope.signal.aborted) onAbort();
    },
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ping = new Promise<{ ping: true }>((resolve) => {
          timer = setTimeout(() => resolve({ ping: true }), 5_000);
        });
        const part = await Promise.race([reader.read(), ping]);
        if (settled) return;
        if ("ping" in part) {
          if (sse) {
            try {
              controller.enqueue(new TextEncoder().encode(
                `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`,
              ));
            } catch { /* closed */ }
          }
          return;
        }
        if (part.done) {
          controller.close();
          dispose();
        } else {
          controller.enqueue(part.value);
        }
      } catch (error) {
        if (settled) return;
        if (!scope.signal.aborted) {
          // Genuine upstream stream failure (not a caller/deadline abort):
          // preserve the original error instead of replacing it with an abort error.
          try { controller.error(error); } catch { /* already closed */ }
        } else {
          finishSse(controller);
        }
        dispose();
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      if (settled) return;
      const cancelled = reader.cancel(reason);
      dispose();
      return cancelled;
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class Router {
  readonly adapters: BackendAdapter[];
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly apiKey?: string;
  readonly primaryModel: string;
  readonly failoverBackoffMs: number;
  private readonly allowedModels?: ReadonlySet<string>;
  private readonly modelChain?: string[];
  private readonly modelCache = new Map<string, {
    expiresAt: number;
    models?: BackendModel[];
    pending?: Promise<BackendModel[]>;
  }>();

  constructor(options: RouterOptions = {}) {
    this.adapters = options.adapters ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.apiKey = options.apiKey ?? process.env.DANI_FREE_API_KEY;
    this.primaryModel = options.primaryModel ?? DEFAULT_PRIMARY_MODEL;
    this.allowedModels = options.allowedModels ? new Set(options.allowedModels) : undefined;
    this.modelChain = options.modelChain?.map((selector) => selector.trim()).filter((selector) => selector.length > 0);
    this.failoverBackoffMs = options.failoverBackoffMs ?? DEFAULT_FAILOVER_BACKOFF_MS;
  }

  private findAdapter(id: string): BackendAdapter | undefined {
    return this.adapters.find((adapter) => adapter.id === id);
  }

  private async modelsFor(adapter: BackendAdapter, signal?: AbortSignal): Promise<BackendModel[]> {
    if (signal?.aborted) throw abortError(signal);
    const now = Date.now();
    const cached = this.modelCache.get(adapter.id);
    if (cached?.models && cached.expiresAt > now) return cached.models;
    if (cached?.pending) return raceWithSignal(cached.pending, signal);

    const discoveryTimeout = abortAfter(this.timeoutMs);
    const pending = raceWithSignal(
      Promise.resolve().then(() => adapter.listModels(discoveryTimeout.signal)),
      discoveryTimeout.signal,
    ).then(
      (models) => {
        this.modelCache.set(adapter.id, { models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
        return models;
      },
      (error) => {
        if (this.modelCache.get(adapter.id)?.pending === pending) this.modelCache.delete(adapter.id);
        throw error;
      },
    ).finally(() => discoveryTimeout.cancel());
    this.modelCache.set(adapter.id, { pending, expiresAt: now + MODEL_CACHE_TTL_MS });
    return raceWithSignal(pending, signal);
  }

  async models(signal?: AbortSignal): Promise<BackendModel[]> {
    // One backend's failed discovery must not take the whole listing (or the
    // derived chain) down: its models are simply absent. Cancellation and the
    // overall deadline still abort the request.
    const groups = await Promise.all(
      this.adapters.map(async (adapter): Promise<BackendModel[]> => {
        try {
          return await this.modelsFor(adapter, signal);
        } catch (error) {
          if (isAbort(error)) throw error;
          return [];
        }
      }),
    );
    return groups.flat().filter((model) => !this.allowedModels || this.allowedModels.has(modelSelectorId(model)));
  }

  async health(signal?: AbortSignal): Promise<BackendHealth[]> {
    return Promise.all(
      this.adapters.map(async (adapter): Promise<BackendHealth> => {
        try {
          return await raceWithSignal(Promise.resolve().then(() => adapter.health(signal)), signal);
        } catch (error) {
          return {
            backend: adapter.id,
            configured: false,
            healthy: false,
            checkedAt: new Date().toISOString(),
            reason: error instanceof Error ? error.message : "health check failed",
          };
        }
      }),
    );
  }

  private async resolveExplicit(selector: string, signal: AbortSignal): Promise<Route | Response> {
    const parsed = modelSelector(selector);
    if (parsed.auto || !parsed.backendId || !parsed.id) {
      return structuredError("Model must use auto or backend/model syntax", 400, "invalid_model");
    }
    if (!(BACKENDS as readonly string[]).includes(parsed.backendId)) {
      return structuredError(`Unknown backend: ${parsed.backendId}`, 404, "backend_not_found");
    }
    if (this.allowedModels && !this.allowedModels.has(selector.trim())) {
      return structuredError(`Model not found: ${selector}`, 404, "model_not_found");
    }
    const backend = this.findAdapter(parsed.backendId);
    if (!backend) return structuredError(`Backend is unavailable: ${parsed.backendId}`, 503, "backend_unavailable");
    const models = await this.modelsFor(backend, signal);
    const model = models.find((candidate) => modelSelectorId(candidate) === selector.trim());
    if (!model) return structuredError(`Model not found: ${selector}`, 404, "model_not_found");
    if (!model.healthy) return structuredError(`Model is unhealthy: ${selector}`, 503, "model_unavailable");
    return { backend, model };
  }

  /**
   * Ordered failover selectors. Explicit `modelChain` wins; otherwise derive
   * from the allowed roster (or discovered models), OpenCode-first, then Kilo.
   */
  private async chainSelectors(signal: AbortSignal): Promise<string[]> {
    if (this.modelChain) {
      return this.modelChain.filter(
        (selector) => !this.allowedModels || this.allowedModels.has(selector),
      );
    }
    if (this.allowedModels) return opencodeFirst([...this.allowedModels]);
    const models = await this.models(signal);
    return opencodeFirst(models.map(modelSelectorId));
  }

  /**
   * Resolve chain selectors to healthy routes, skipping anything unusable.
   * Backend discovery is pre-warmed concurrently: with an allowlist-derived
   * chain the selectors below would otherwise discover each backend's models
   * one after another (OpenCode's round trip, then Kilo's). modelsFor dedupes
   * through the shared pending promise, so the loop reuses these warm results.
   */
  private async resolveChain(signal: AbortSignal): Promise<Route[]> {
    const selectors = await this.chainSelectors(signal);
    const backends = new Map<string, BackendAdapter>();
    for (const selector of selectors) {
      const parsed = modelSelector(selector);
      if (parsed.auto || !parsed.backendId || backends.has(parsed.backendId)) continue;
      const backend = this.findAdapter(parsed.backendId);
      if (backend) backends.set(parsed.backendId, backend);
    }
    await Promise.all(
      [...backends.values()].map(async (backend) => {
        try {
          await this.modelsFor(backend, signal);
        } catch (error) {
          // Mirror the loop below: a backend whose discovery fails is simply
          // skipped; client cancellation still aborts the request.
          if (isAbort(error)) throw error;
        }
      }),
    );
    const routes: Route[] = [];
    const seen = new Set<string>();
    for (const selector of selectors) {
      if (seen.has(selector)) continue;
      seen.add(selector);
      let route: Route | Response;
      try {
        route = await this.resolveExplicit(selector, signal);
      } catch (error) {
        // A backend whose discovery fails (network error, misconfigured
        // sidecar, …) is skipped so the failover chain keeps walking the
        // remaining backends. Client cancellation and the overall deadline
        // still abort the request.
        if (isAbort(error)) throw error;
        continue;
      }
      if (route instanceof Response) continue;
      routes.push(route);
    }
    return routes;
  }

  private async failoverBackoff(signal: AbortSignal): Promise<void> {
    const base = this.failoverBackoffMs;
    if (!(base > 0)) return;
    const delay = base + Math.random() * Math.min(500, base);
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError(signal));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Walk the chain until one model returns a real answer.
   * Retryable: network errors, upstream timeouts (including HTTP 408), 429, 5xx,
   * and HTTP 200 with empty/no text content or a body exceeding the
   * MAX_UPSTREAM_RESPONSE_BYTES buffer cap. Never fails over after response bytes
   * have been emitted to the client. All attempts share the caller's remaining
   * deadline via `signal`.
   */
  private async completeWithFailover(request: ChatRequest, attempts: Route[], signal: AbortSignal): Promise<Response> {
    const failures: AttemptFailure[] = [];
    const required = requiredCapabilities(request);
    const streaming = request.stream === true;

    for (const route of attempts) {
      const selector = modelSelectorId(route.model);
      if (signal.aborted) throw abortError(signal);
      if (!supportsCapabilities(route.model, required)) {
        return structuredError(
          `Model ${route.model.id} does not support required capabilities: ${required.join(", ")}`,
          422,
          "unsupported_capability",
        );
      }
      const limitError = outputLimitError(request, route.model);
      if (limitError) return limitError;

      let response: Response;
      try {
        const completion = route.backend.complete({ ...request, model: route.model.id }, route.model, signal);
        // An adapter may ignore cancellation and return a body after the caller has left.
        void completion.then((candidate) => {
          if (signal.aborted) void candidate.body?.cancel().catch(() => undefined);
        }, () => undefined);
        response = await raceWithSignal(completion, signal);
      } catch (error) {
        // Client cancellation and the overall deadline are never retried.
        if (isAbort(error)) throw error;
        const status = statusFrom(error);
        if (status === 429) {
          failures.push({ model: selector, status, reason: retryableStatusReason(error, status, "rate limited") });
          await this.failoverBackoff(signal);
          continue;
        }
        if (status !== undefined && (status === 408 || status >= 500)) {
          failures.push({ model: selector, status, reason: retryableStatusReason(error, status, "upstream error") });
          continue;
        }
        if (status !== undefined) {
          // Other 4xx are not retryable: pass the upstream refusal through.
          const passthrough = responseFromStatusError(error);
          if (passthrough) return withModelHeader(passthrough, selector);
          throw error;
        }
        failures.push({ model: selector, reason: sanitizeReason(error, "network error") });
        continue;
      }

      const status = response.status;
      if (status === 429) {
        failures.push({
          model: selector,
          status,
          reason: upstreamReason(status, response.statusText || undefined, await readUpstreamSnippet(response, signal)),
        });
        await this.failoverBackoff(signal);
        continue;
      }
      if (status === 408 || status >= 500) {
        failures.push({
          model: selector,
          status,
          reason: upstreamReason(status, response.statusText || undefined, await readUpstreamSnippet(response, signal)),
        });
        continue;
      }
      if (status >= 400) {
        return withModelHeader(response, selector);
      }

      // 2xx: guard against the empty-content quirk on non-stream JSON bodies.
      // Streaming responses relay bytes as they arrive, so once the first byte
      // is handed to the client there is no failing over.
      if (!streaming && isJsonResponse(response)) {
        let text: string;
        let oversize = false;
        try {
          ({ text, oversize } = await readCappedResponseBody(response, signal));
        } catch (error) {
          if (isAbort(error)) throw error;
          // A mid-body upstream failure is handed to the client as-is rather
          // than failed over, preserving the upstream's error surface.
          return withModelHeader(failedBodyResponse(response, error), selector);
        }
        if (oversize) {
          failures.push({
            model: selector,
            reason: `upstream returned 200 with a body exceeding ${MAX_UPSTREAM_RESPONSE_BYTES} bytes`,
          });
          continue;
        }
        let payload: unknown;
        let parseable = true;
        try {
          payload = JSON.parse(text);
        } catch {
          parseable = false;
        }
        if (!parseable) {
          failures.push({ model: selector, reason: "upstream returned 200 with an invalid JSON body" });
          continue;
        }
        const content = chatCompletionHasContent(payload);
        if (content === false) {
          failures.push({ model: selector, reason: "upstream returned 200 with empty content" });
          continue;
        }
        const headers = new Headers(response.headers);
        headers.set(ANSWERED_MODEL_HEADER, selector);
        return new Response(text, { status: response.status, statusText: response.statusText, headers });
      }
      return withModelHeader(response, selector);
    }
    return allModelsFailedResponse(failures);
  }

  private async complete(request: ChatRequest, signal: AbortSignal): Promise<Response> {
    const parsed = modelSelector(request.model);
    if (!parsed.auto && (!parsed.backendId || !parsed.id)) {
      return structuredError("Model must use auto or backend/model syntax", 400, "invalid_model");
    }
    if (parsed.auto) {
      const chain = await this.resolveChain(signal);
      if (chain.length === 0) {
        // No usable chain: resolve the primary for a precise 404/503.
        const route = await this.resolveExplicit(this.primaryModel, signal);
        if (route instanceof Response) return route;
        return this.completeWithFailover(request, [route], signal);
      }
      return this.completeWithFailover(request, chain, signal);
    }
    const selector = request.model.trim();
    const route = await this.resolveExplicit(selector, signal);
    if (route instanceof Response) return route;
    const first = modelSelectorId(route.model);
    const rest = (await this.resolveChain(signal)).filter((candidate) => modelSelectorId(candidate.model) !== first);
    return this.completeWithFailover(request, [route, ...rest], signal);
  }

  async handle(request: Request): Promise<Response> {
    const receivedAt = Date.now();
    if (this.apiKey && !constantTimeEqual(requestApiKey(request) ?? "", this.apiKey)) {
      return structuredError("Invalid API key", 401, "invalid_api_key", "authentication_error");
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const timeout = deadline(request.signal, this.timeoutMs);
      try {
        const backends = await this.health(timeout.signal);
        const ok = backends.length > 0 && backends.every((backend) => backend.healthy);
        return json({
          ok,
          status: ok ? "ok" : "degraded",
          checkedAt: new Date().toISOString(),
          backends,
        });
      } finally {
        timeout.dispose();
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      const timeout = deadline(request.signal, this.timeoutMs);
      try {
        const models = await this.models(timeout.signal);
        return json({ object: "list", data: models.map(publicModel) });
      } catch (error) {
        if (isAbort(error)) return structuredError("Model discovery timed out", 504, "timeout", "api_error");
        return structuredError("Model discovery failed", 502, "backend_network_error", "api_error");
      } finally {
        timeout.dispose();
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const scope = deadline(request.signal, this.timeoutMs - (Date.now() - receivedAt));
      let transferred = false;
      try {
        const body = await readBody(request, this.maxBodyBytes, scope.signal);
        if (body instanceof Response) return body;
        const parsed = parseRequest(body);
        if (parsed instanceof Response) return parsed;
        const response = await this.complete(parsed, scope.signal);
        if (scope.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw abortError(scope.signal);
        }
        const result = responseWithDeadline(response, scope);
        transferred = true;
        return result;
      } catch (error) {
        if (scope.signal.aborted || isAbort(error)) {
          return structuredError("Backend request timed out or cancelled", 504, "timeout", "api_error");
        }
        return responseFromStatusError(error)
          ?? structuredError("Backend request failed", 502, "backend_network_error", "api_error");
      } finally {
        if (!transferred) scope.dispose();
      }
    }
    return structuredError("Route not found", 404, "not_found");
  }
}

export function createRouter(
  optionsOrAdapters: RouterOptions | BackendAdapter[] = {},
  options: Omit<RouterOptions, "adapters"> = {},
): Router {
  if (Array.isArray(optionsOrAdapters)) {
    return new Router({ ...options, adapters: optionsOrAdapters });
  }
  return new Router(optionsOrAdapters);
}
