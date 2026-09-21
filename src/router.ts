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
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const MODEL_CACHE_TTL_MS = 5_000;
export const DEFAULT_PRIMARY_MODEL = "kilo/nex-agi/nex-n2.5-pro:free";

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
  return new Response(body, { status, statusText, headers: { "content-type": "text/plain; charset=utf-8" } });
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
        finishSse(controller);
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
  private readonly allowedModels?: ReadonlySet<string>;
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
    const groups = await Promise.all(this.adapters.map((adapter) => this.modelsFor(adapter, signal)));
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

  private async complete(request: ChatRequest, signal: AbortSignal): Promise<Response> {
    const selector = modelSelector(request.model).auto ? this.primaryModel : request.model;
    const route = await this.resolveExplicit(selector, signal);
    if (route instanceof Response) return route;
    const required = requiredCapabilities(request);
    if (!supportsCapabilities(route.model, required)) {
      return structuredError(
        `Model ${route.model.id} does not support required capabilities: ${required.join(", ")}`,
        422,
        "unsupported_capability",
      );
    }
    const limitError = outputLimitError(request, route.model);
    if (limitError) return limitError;
    if (signal.aborted) throw abortError(signal);
    const completion = route.backend.complete({ ...request, model: route.model.id }, route.model, signal);
    // An adapter may ignore cancellation and return a body after the caller has left.
    void completion.then((response) => {
      if (signal.aborted) void response.body?.cancel().catch(() => undefined);
    }, () => undefined);
    return raceWithSignal(completion, signal);
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
