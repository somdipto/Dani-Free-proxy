import type {
  BackendAdapter,
  BackendHealth,
  BackendModel,
  Capability,
  ChatMessage,
  ChatRequest,
} from "../types.ts";
import { readCappedJson } from "./capped-json";
import { retryAfterMs } from "../retry-after";
import {
  parseToolOutput,
  renderAssistantToolCalls,
  renderToolResultPrefix,
  toolInstructions,
  type EmulatedToolCall,
} from "./tool-emulation";

/**
 * OpenCode backend adapter.
 *
 * Transport: the genuine local `opencode serve` sidecar (default
 * http://127.0.0.1:4187). There is NO OpenAI-compatible upstream here — the
 * sidecar exposes a session API (/session, /session/{id}/message,
 * /session/{id}, /config/providers, /global/health).
 *
 * OpenCode's free tier only works from inside the genuine OpenCode client, so
 * this adapter ONLY talks to the local sidecar. It never calls
 * https://opencode.ai/zen/v1 (direct HTTPS there is rejected with
 * "OpenCode's free tier can only be used from within OpenCode") and it never
 * sends any API key upstream — the sidecar needs none.
 *
 * Optional sidecar basic auth: if the sidecar was started with
 * OPENCODE_SERVER_PASSWORD, set the same value in DANI_FREE_OPENCODE_API_KEY
 * and this adapter sends `Authorization: Basic base64("opencode:<key>")` on
 * every sidecar request. Unset means no auth (loopback dev).
 */
const DEFAULT_BASE_URL = "http://127.0.0.1:4187";
const BACKEND = "opencode" as const;
const SERVER_USERNAME = "opencode";
const SESSION_TITLE = "dani-free";
const PROVIDER_ID = "opencode";
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const PERMISSION_POLL_MS = 300;

type UnknownRecord = Record<string, unknown>;
type FetchFn = typeof fetch;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPositiveNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return 0;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function rawModelId(id: string): string {
  if (id.startsWith("opencode/")) return id.slice("opencode/".length);
  if (id.startsWith("opencode:")) return id.slice("opencode:".length);
  return id;
}

function normalizedModelId(id: string): string {
  return `opencode/${rawModelId(id)}`;
}

/** Error thrown for OpenCode-side failures. Carries an HTTP status so the router can surface it. */
export class OpenCodeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;
  /** Upstream `Retry-After` cooldown (ms) parsed at throw time, if any. */
  readonly retryAfterMs?: number;

  constructor(message: string, init: { status?: number; code?: string; type?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "OpenCodeError";
    this.status = init.status ?? 502;
    this.code = init.code ?? "opencode_backend_error";
    this.type = init.type ?? "api_error";
    this.retryAfterMs = init.retryAfterMs;
  }

  get body(): string {
    return JSON.stringify({
      error: { message: this.message, type: this.type, code: this.code },
    });
  }
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "request failed";
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof DOMException
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function joinUrl(baseUrl: URL, path: string): URL {
  const url = new URL(baseUrl.toString());
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${basePath}${path}` || "/";
  url.search = "";
  return url;
}

function baseOrigin(baseUrl: URL): string {
  return `${baseUrl.protocol}//${baseUrl.host}`;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Max upstream error-body bytes read for OpenCode failure diagnostics.
 * Parity with the Kilo adapter's cap: a bloated upstream error page
 * (multi-MB gateway HTML on a 502) must not be buffered whole just to
 * build an error detail.
 */
const MAX_OPENCODE_ERROR_BODY_BYTES = 2_048;

/**
 * Max /config/providers discovery-body bytes parsed for a 200 response. A 200
 * with an anomalously large body must not be buffered whole: discovery
 * refetches on every cache miss, so an unbounded parse is a
 * memory-exhaustion shape. Oversize or invalid bodies keep this adapter's
 * soft-failure posture (listModels returns no models) so the failover chain
 * walks the remaining backends.
 */
export const MAX_OPENCODE_DISCOVERY_BYTES = 1_048_576;

/** Failure messages for the shared capped-JSON discovery reader. */
const DISCOVERY_MESSAGES = {
  empty: "OpenCode sidecar returned an empty /config/providers response",
  oversize: (maxBytes: number) => `OpenCode sidecar returned a /config/providers response exceeding ${maxBytes} bytes`,
} as const;

/** Free ids: provider ids ending in `-free`, plus opencode's own free model. */
function isFreeModelId(id: string): boolean {
  return id === "big-pickle" || id.endsWith("-free");
}

/**
 * Advertise text/tools/reasoning always; add image ONLY when the provider
 * metadata actually declares image input (capabilities.input.image === true).
 */
function modelCapabilities(record: UnknownRecord): Capability[] {
  const capabilities: Capability[] = ["text", "tools", "reasoning"];
  const declared = isRecord(record.capabilities) ? record.capabilities : undefined;
  const input = declared && isRecord(declared.input) ? declared.input : undefined;
  if (input?.image === true) capabilities.push("image");
  return capabilities;
}

function messageContentText(message: ChatMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join("");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

interface SessionMessageParts {
  system: string;
  parts: Array<{ type: "text"; text: string }>;
  model?: { providerID: string; modelID: string };
}

/**
 * Map an OpenAI chat request onto the sidecar's message shape: all system
 * messages join into `system`; every other message becomes one text part
 * prefixed with its role (tool content is carried as JSON).
 */
function toSessionMessage(messages: ChatMessage[], request?: ChatRequest): SessionMessageParts {
  const system: string[] = [];
  const parts: Array<{ type: "text"; text: string }> = [];
  for (const message of messages) {
    const text = messageContentText(message);
    if (message.role === "system") {
      if (text !== "") system.push(text);
      continue;
    }
    let prefix = message.role === "assistant" ? "assistant: " : "user: ";
    let body = text;
    if (message.role === "tool") {
      prefix = renderToolResultPrefix(message);
      if (typeof message.content !== "string") {
        try {
          body = JSON.stringify(message.content) ?? "";
        } catch {
          body = text;
        }
      }
    }
    if (message.role === "assistant") {
      const calls = renderAssistantToolCalls(message);
      if (calls) body = body ? `${body}\n${calls}` : calls;
    }
    const combined = `${prefix}${body}`;
    if (combined.trim() !== "") parts.push({ type: "text", text: combined });
  }
  const tools = request ? toolInstructions(request) : "";
  if (tools) system.push(tools);
  return { system: system.join("\n\n"), parts };
}

/** Extract assistant text from a sidecar message's parts[]. */
function extractText(message: unknown): string {
  if (!isRecord(message)) return "";
  const parts = message.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part): part is UnknownRecord => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/**
 * A turn the sidecar finished with an upstream error (info.error): the free
 * tier's quota or rate limit, a FreeTierError, a provider outage. Surface it
 * with its status so the router can fail over and put the backend on hold.
 */
function messageError(message: unknown): OpenCodeError | undefined {
  if (!isRecord(message)) return undefined;
  const info = isRecord(message.info) ? message.info : undefined;
  const error = info && isRecord(info.error) ? info.error : undefined;
  if (!error) return undefined;
  const data = isRecord(error.data) ? error.data : {};
  const name = typeof error.name === "string" ? error.name : "error";
  const text = typeof data.message === "string" ? data.message : name;
  const body = typeof data.responseBody === "string" ? data.responseBody : "";
  let status = typeof data.statusCode === "number" ? data.statusCode : undefined;
  const headers = isRecord(data.responseHeaders) ? data.responseHeaders : {};
  const retryHeader = typeof headers["retry-after"] === "string" ? headers["retry-after"] : undefined;
  const retry = retryHeader ? retryAfterMs(new Headers({ "retry-after": retryHeader })) : undefined;
  const quota = /quota|rate.?limit|too many requests|limit (?:reached|exceeded)|usage limit|out of credits|insufficient credits/i.test(`${text} ${body}`);
  if (quota && (status === undefined || status === 403 || status >= 500)) status = 429;
  const code = quota ? "quota_exhausted" : /FreeTierError/.test(body) ? "free_tier_rejected" : "upstream_error";
  return new OpenCodeError(`OpenCode turn failed: ${text}`, { status: status ?? 502, code, retryAfterMs: retry });
}

interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function extractUsage(message: unknown): SessionUsage | undefined {
  if (!isRecord(message)) return undefined;
  const tokens = isRecord(message.tokens) ? message.tokens : undefined;
  if (!tokens) return undefined;
  const input = typeof tokens.input === "number" ? tokens.input : 0;
  const output = typeof tokens.output === "number" ? tokens.output : 0;
  const total = typeof tokens.total === "number" ? tokens.total : input + output;
  return { promptTokens: input, completionTokens: output, totalTokens: total };
}

const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";
const CHUNK_SIZE = 2048;

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function completionId(): string {
  return `chatcmpl-opencode-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Non-streaming OpenAI `chat.completion` object: buffer the whole turn and
 * return a single application/json body so clients with `stream: false`
 * (or stream absent) get a parseable response.
 */
function chatCompletionJson(text: string, modelId: string, usage?: SessionUsage, toolCalls: EmulatedToolCall[] = []): Response {
  return Response.json({
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: toolCalls.length
          ? { role: "assistant", content: text === "" ? null : text, tool_calls: toolCalls }
          : { role: "assistant", content: text },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage?.promptTokens ?? 0,
      completion_tokens: usage?.completionTokens ?? 0,
      total_tokens: usage?.totalTokens ?? 0,
    },
  });
}

/**
 * The sidecar returns the completed message as buffered JSON (Accept:
 * text/event-stream does not yield live SSE deltas), so synthesize a valid
 * OpenAI SSE stream: role+content deltas, a stop chunk with usage, then
 * [DONE].
 */
function synthesizeSse(text: string, modelId: string, usage?: SessionUsage, toolCalls: EmulatedToolCall[] = []): Response {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const base = { id: completionId(), object: "chat.completion.chunk" as const, created, model: modelId };
  const frames: string[] = [];
  frames.push(
    sseData({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
  );
  for (let offset = 0; offset < text.length; offset += CHUNK_SIZE) {
    frames.push(
      sseData({
        ...base,
        choices: [{ index: 0, delta: { content: text.slice(offset, offset + CHUNK_SIZE) }, finish_reason: null }],
      }),
    );
  }
  toolCalls.forEach((call, index) => {
    frames.push(
      sseData({
        ...base,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } }] },
          finish_reason: null,
        }],
      }),
    );
  });
  frames.push(
    sseData({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
      ...(usage
        ? {
            usage: {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.totalTokens,
            },
          }
        : {}),
    }),
  );
  frames.push("data: [DONE]\n\n");

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": SSE_CONTENT_TYPE,
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export interface OpenCodeAdapterOptions {
  baseUrl?: string;
  /** Sidecar password; sent as HTTP Basic `opencode:<key>` on every request. */
  apiKey?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetch?: FetchFn;
  /** Live sidecar location (a managed sidecar can move ports on restart). Wins over baseUrl. */
  resolveBaseUrl?: () => string | undefined;
}

function parseBase(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported URL scheme");
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed;
  } catch {
    return null;
  }
}

export class OpenCodeAdapter implements BackendAdapter {
  readonly id = BACKEND;
  private readonly staticBaseUrl: URL | null;
  private readonly resolveBaseUrl?: () => string | undefined;
  private readonly basicAuth: string | undefined;
  private readonly fetchFn: FetchFn;

  constructor(options: OpenCodeAdapterOptions = {}) {
    const configuredBase = options.baseUrl ?? process.env.DANI_FREE_OPENCODE_BASE_URL ?? DEFAULT_BASE_URL;
    this.staticBaseUrl = parseBase(configuredBase);
    this.resolveBaseUrl = options.resolveBaseUrl;

    const configuredKey = options.apiKey ?? process.env.DANI_FREE_OPENCODE_API_KEY;
    const trimmed = configuredKey?.trim();
    this.basicAuth = trimmed
      ? `Basic ${Buffer.from(`${SERVER_USERNAME}:${trimmed}`, "utf8").toString("base64")}`
      : undefined;
    this.fetchFn = options.fetch ?? fetch;
  }

  private get baseUrl(): URL | null {
    return this.resolveBaseUrl ? parseBase(this.resolveBaseUrl()) : this.staticBaseUrl;
  }

  private headers(contentType = false): Headers {
    const headers = new Headers({ Accept: "application/json" });
    if (this.basicAuth) headers.set("Authorization", this.basicAuth);
    if (contentType) headers.set("Content-Type", "application/json");
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<BackendModel[]> {
    if (!this.baseUrl) return [];

    let response: Response;
    try {
      response = await this.fetchFn(joinUrl(this.baseUrl, "/config/providers"), {
        method: "GET",
        headers: this.headers(),
        signal,
      });
    } catch {
      return [];
    }
    if (!response.ok) return [];

    let payload: unknown;
    try {
      // Oversize bodies hit the 1 MiB discovery cap and throw: the
      // soft-failure posture below keeps listModels returning no models, so
      // the failover chain walks the remaining backends.
      payload = await readCappedJson(response, MAX_OPENCODE_DISCOVERY_BYTES, DISCOVERY_MESSAGES);
    } catch {
      return [];
    }
    if (!isRecord(payload) || !Array.isArray(payload.providers)) return [];

    const provider = payload.providers.find((entry): entry is UnknownRecord => isRecord(entry) && entry.id === PROVIDER_ID);
    if (!provider || !isRecord(provider.models)) return [];

    const models: BackendModel[] = [];
    for (const [id, value] of Object.entries(provider.models)) {
      const modelId = id.trim();
      if (modelId === "" || !isFreeModelId(modelId) || !isRecord(value)) continue;
      const name = asNonEmptyString(value.name) ?? modelId;
      const limit = isRecord(value.limit) ? value.limit : undefined;
      const status = asNonEmptyString(value.status);
      models.push({
        id: normalizedModelId(modelId),
        backend: BACKEND,
        name,
        capabilities: modelCapabilities(value),
        contextWindow: asPositiveNumber(limit?.context),
        maxTokens: asPositiveNumber(limit?.output),
        healthy: status === undefined || status === "active",
        source: "discovered",
      });
    }
    return models;
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.baseUrl) {
      return {
        backend: BACKEND,
        configured: false,
        healthy: false,
        checkedAt,
        reason: "invalid OpenCode base URL",
      };
    }

    const origin = baseOrigin(this.baseUrl);
    const port =
      this.baseUrl.port !== ""
        ? this.baseUrl.port
        : this.baseUrl.protocol === "https:"
          ? "443"
          : "80";
    const startedAt = performance.now();
    const notReachable = `opencode serve not reachable at ${origin} — start it with: opencode serve --port ${port}`;

    try {
      const healthResponse = await this.fetchFn(joinUrl(this.baseUrl, "/global/health"), {
        method: "GET",
        headers: this.headers(),
        signal,
      });
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (!healthResponse.ok) {
        return {
          backend: BACKEND,
          configured: true,
          healthy: false,
          checkedAt,
          latencyMs,
          reason: `opencode serve returned HTTP ${healthResponse.status} for /global/health`,
        };
      }
      let healthPayload: unknown;
      try {
        healthPayload = await healthResponse.json();
      } catch {
        healthPayload = undefined;
      }
      if (!isRecord(healthPayload) || healthPayload.healthy !== true) {
        return {
          backend: BACKEND,
          configured: true,
          healthy: false,
          checkedAt,
          latencyMs,
          reason: "opencode serve reported unhealthy at /global/health",
        };
      }

      const providersResponse = await this.fetchFn(joinUrl(this.baseUrl, "/config/providers"), {
        method: "GET",
        headers: this.headers(),
        signal,
      });
      if (!providersResponse.ok) {
        return {
          backend: BACKEND,
          configured: true,
          healthy: false,
          checkedAt,
          latencyMs,
          reason: `opencode serve returned HTTP ${providersResponse.status} for /config/providers`,
        };
      }
      let providersPayload: unknown;
      try {
        providersPayload = await providersResponse.json();
      } catch {
        providersPayload = undefined;
      }
      const providers = isRecord(providersPayload) && Array.isArray(providersPayload.providers)
        ? providersPayload.providers
        : [];
      const hasProvider = providers.some((entry) => isRecord(entry) && entry.id === PROVIDER_ID);
      if (!hasProvider) {
        return {
          backend: BACKEND,
          configured: true,
          healthy: false,
          checkedAt,
          latencyMs,
          reason: "opencode provider missing from /config/providers",
        };
      }
      return { backend: BACKEND, configured: true, healthy: true, checkedAt, latencyMs };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      return {
        backend: BACKEND,
        configured: true,
        healthy: false,
        checkedAt,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        reason: `${notReachable} (${errorReason(error)})`,
      };
    }
  }

  /**
   * Read at most MAX_OPENCODE_ERROR_BODY_BYTES of an upstream error body for
   * diagnostics, then stop the stream. Mirrors the Kilo adapter's
   * readErrorSnippet: a mid-read body failure diagnoses with nothing, like
   * the old full-read path which swallowed body errors the same way. The read
   * honors the caller's abort signal: a sidecar that answers with an error
   * status and then trickles (or never finishes) the error body must fail
   * fast on caller cancellation instead of stalling the failover chain until
   * the router's outer deadline fires. Cancellation rethrows the abort error
   * (never retried); genuine body failures still diagnose with nothing.
   */
  private async readErrorBody(response: Response, signal: AbortSignal): Promise<string> {
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
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      while (bytes < MAX_OPENCODE_ERROR_BODY_BYTES) {
        const part = await reader.read();
        // The caller left (deadline or client cancel): surface the abort so
        // the router treats it as cancellation, not a retryable failure.
        if (aborted) throw abortReason(signal);
        if (part.done) break;
        chunks.push(part.value);
        bytes += part.value.byteLength;
      }
      // Enforce the byte cap exactly: one upstream chunk can be larger than
      // the cap on its own, so slice after concat rather than trusting chunk size.
      const text = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_OPENCODE_ERROR_BODY_BYTES));
      return truncate(text.trim(), 300);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return "";
    } finally {
      signal.removeEventListener("abort", onAbort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async createSession(modelId: string, signal: AbortSignal): Promise<string> {
    if (!this.baseUrl) throw new OpenCodeError("OpenCode backend is not configured", { code: "not_configured" });
    let response: Response;
    try {
      response = await this.fetchFn(joinUrl(this.baseUrl, "/session"), {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          model: { providerID: PROVIDER_ID, modelID: modelId, id: modelId },
          title: SESSION_TITLE,
        }),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new OpenCodeError(`failed to create OpenCode session: ${errorReason(error)}`, {
        code: "session_create_failed",
      });
    }
    if (!response.ok) {
      const detail = await this.readErrorBody(response, signal);
      throw new OpenCodeError(
        `failed to create OpenCode session: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
        { status: response.status, code: "session_create_failed", retryAfterMs: retryAfterMs(response.headers) },
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OpenCodeError("OpenCode session create returned invalid JSON", { code: "session_create_failed" });
    }
    const sessionId = isRecord(payload) ? asNonEmptyString(payload.id) : undefined;
    if (!sessionId) {
      throw new OpenCodeError("OpenCode session create returned no session id", { code: "session_create_failed" });
    }
    return sessionId;
  }

  private async postMessage(sessionId: string, body: SessionMessageParts, signal: AbortSignal): Promise<unknown> {
    if (!this.baseUrl) throw new OpenCodeError("OpenCode backend is not configured", { code: "not_configured" });
    let response: Response;
    try {
      response = await this.fetchFn(joinUrl(this.baseUrl, `/session/${sessionId}/message`), {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new OpenCodeError(`OpenCode message request failed: ${errorReason(error)}`, {
        code: "message_failed",
      });
    }
    if (!response.ok) {
      const detail = await this.readErrorBody(response, signal);
      throw new OpenCodeError(
        `OpenCode message failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
        { status: response.status, code: "message_failed", retryAfterMs: retryAfterMs(response.headers) },
      );
    }
    try {
      return await response.json();
    } catch {
      throw new OpenCodeError("OpenCode message returned invalid JSON", { code: "message_failed" });
    }
  }

  /** Best-effort abort of an in-flight turn; never throws. */
  private async abortSession(sessionId: string): Promise<void> {
    if (!this.baseUrl) return;
    const scoped = timeoutSignal(undefined, HEALTH_CHECK_TIMEOUT_MS);
    try {
      await this.fetchFn(joinUrl(this.baseUrl, `/session/${sessionId}/abort`), {
        method: "POST",
        headers: this.headers(),
        signal: scoped.signal,
      });
    } catch {
      /* best effort */
    } finally {
      scoped.cancel();
    }
  }

  /**
   * OpenCode's free tier only answers when its own tool set is offered, so the
   * sidecar runs with every permission set to "ask" and this loop rejects each
   * request from our session. The sidecar never edits, runs, reads or fetches
   * anything on this machine; the caller's tools go through the text protocol.
   */
  private rejectToolRequests(sessionId: string, signal: AbortSignal): { stop: () => void } {
    let stopped = false;
    const handled = new Set<string>();
    const loop = async () => {
      while (!stopped && !signal.aborted) {
        for (const kind of ["permission", "question"] as const) {
          try {
            const response = await this.fetchFn(joinUrl(this.baseUrl!, `/${kind}`), { method: "GET", headers: this.headers(), signal });
            if (!response.ok) continue;
            const pending: unknown = await response.json().catch(() => []);
            if (!Array.isArray(pending)) continue;
            for (const item of pending) {
              if (!isRecord(item) || item.sessionID !== sessionId || typeof item.id !== "string" || handled.has(item.id)) continue;
              handled.add(item.id);
              const path = kind === "permission" ? `/permission/${item.id}/reply` : `/question/${item.id}/reject`;
              const body = kind === "permission"
                ? JSON.stringify({ reply: "reject", message: "Built-in tools are switched off here. Use the host tools protocol or answer in text." })
                : "{}";
              await this.fetchFn(joinUrl(this.baseUrl!, path), { method: "POST", headers: this.headers(true), body, signal }).catch(() => undefined);
            }
          } catch {
            /* keep polling until the turn ends */
          }
        }
        if (stopped || signal.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, PERMISSION_POLL_MS));
      }
    };
    if (this.baseUrl) void loop();
    return { stop: () => { stopped = true; } };
  }

  /** Best-effort session cleanup; never throws. */
  private async deleteSession(sessionId: string): Promise<void> {
    if (!this.baseUrl) return;
    const scoped = timeoutSignal(undefined, HEALTH_CHECK_TIMEOUT_MS);
    try {
      await this.fetchFn(joinUrl(this.baseUrl, `/session/${sessionId}`), {
        method: "DELETE",
        headers: this.headers(),
        signal: scoped.signal,
      });
    } catch {
      /* best effort */
    } finally {
      scoped.cancel();
    }
  }

  async complete(request: ChatRequest, model: BackendModel, signal: AbortSignal): Promise<Response> {
    const rawId = rawModelId(model.id);
    if (!rawId) throw new OpenCodeError("OpenCode model id is empty", { status: 422, code: "invalid_model" });

    const { system, parts } = toSessionMessage(request.messages, request);
    if (parts.length === 0 && system === "") {
      throw new OpenCodeError("no message content to send to OpenCode", { status: 422, code: "invalid_request" });
    }

    if (signal.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    let sessionId: string | undefined;
    const onAbort = () => {
      if (sessionId) void this.abortSession(sessionId);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      sessionId = await this.createSession(rawId, signal);
      const watcher = this.rejectToolRequests(sessionId, signal);
      let message: unknown;
      try {
        message = await this.postMessage(sessionId, { system, parts, model: { providerID: PROVIDER_ID, modelID: rawId } }, signal);
      } finally {
        watcher.stop();
      }
      const failure = messageError(message);
      if (failure) throw failure;
      const text = extractText(message);
      if (text.trim() === "") {
        throw new OpenCodeError("model produced no text output", {
          status: 502,
          code: "empty_response",
        });
      }
      const usage = extractUsage(message);
      const parsed = parseToolOutput(text, request);
      if (request.stream) return synthesizeSse(parsed.content, model.id, usage, parsed.toolCalls);
      return chatCompletionJson(parsed.content, model.id, usage, parsed.toolCalls);
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (sessionId) await this.deleteSession(sessionId);
    }
  }
}

