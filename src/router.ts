import { isRateLimitFailure, type ModelCatalog, type ProbeResult, type RefreshSummary } from "./catalog";
import type {
  BackendAdapter,
  BackendHealth,
  BackendModel,
  Capability,
  ChatRequest,
} from "./types";
import { redactDiagnostics } from "./redact";
import { VENDOR_WORDS, identityTokens, opaqueToolCallId, withIdentity } from "./opacity";
import { retryAfterMs } from "./retry-after";
import {
  API_VERSION,
  CLIENT_ID_HEADER,
  FeedbackStore,
  OUTCOMES,
  orderForTask,
  parseTask,
  REQUEST_ID_HEADER,
  TASK_HEADER,
  TASKS,
  type Outcome,
  type Task,
} from "./tasks";

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
  /**
   * Per-attempt deadline for a single model in the failover chain. When one
   * backend hangs, the attempt is abandoned after this long and the chain
   * walks to the next model instead of burning the whole request deadline on
   * the hung backend. Defaults to 60s; clamped to the overall timeout.
   */
  attemptTimeoutMs?: number;
  /**
   * Persistent model catalog. When set (and no explicit allowedModels /
   * modelChain), `auto` and GET /v1/models follow the catalog's ranking,
   * failing models drop out, and every attempt's outcome is recorded.
   */
  catalog?: ModelCatalog;
  /** Backend order for catalog ranking; defaults to kilo, then opencode, then mimo. */
  backendPriority?: readonly string[];
  /** Timeout for one refresh probe. Default 20s. */
  probeTimeoutMs?: number;
  /** Probe never-answered models during refresh. Default true when a catalog is set. */
  probeOnRefresh?: boolean;
  /** Reported on /health and used for the empty-catalog message. */
  privateMode?: boolean;
  /**
   * Backends whose free quota is shared by all their models: any rate limit or
   * quota error puts the whole backend on hold and auto moves to the next
   * backend until a recovery probe succeeds. Default ["opencode"].
   */
  quotaBackends?: readonly string[];
  /**
   * Product mode: clients only ever see this one model. /v1/models lists just
   * it, responses carry its id, and errors, headers and /health never name a
   * backend or model. Omit to expose the real roster (development).
   */
  brand?: { id: string; name: string };
  /** Called when a backend's free quota runs out or comes back. */
  onQuotaChange?: (backend: string, exhausted: boolean) => void;
  /** Outcome feedback store (POST /v1/feedback). Omit for an in-memory store. */
  feedback?: FeedbackStore;
  /** Accept feedback. Default: on unless Private mode or DANI_FREE_FEEDBACK=0. */
  feedbackEnabled?: boolean;
  /** Voice quick-ack budget: time to first byte across all attempts. Default 1500ms. */
  ackTimeoutMs?: number;
}

/** Output cap for the ack lane: a short spoken acknowledgment. */
export const ACK_MAX_TOKENS = 60;
const WARM_INTERVAL_MS = 30_000;
const ACK_HEDGE = 2;

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
/** Longest wait for a streaming attempt's first byte before trying the next model. */
export const STREAM_FIRST_BYTE_MS = 25_000;
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
  const lower = trimmed.toLowerCase();
  if (lower === "auto" || lower === "dani-free-auto" || lower === "dani free auto") return { auto: true };
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

function outputLimitError(request: ChatRequest, model: BackendModel, brandName?: string): Response | undefined {
  if (
    typeof request.max_tokens === "number" &&
    Number.isFinite(request.max_tokens) &&
    request.max_tokens > 0 &&
    model.maxTokens > 0 &&
    request.max_tokens > model.maxTokens
  ) {
    return structuredError(
      brandName
        ? `Requested max_tokens ${request.max_tokens} is more than ${brandName} can write in one reply`
        : `Requested max_tokens ${request.max_tokens} exceeds ${model.id} limit ${model.maxTokens}`,
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

/**
 * Cooldown hint carried on a thrown adapter error (e.g. KiloBackendError,
 * OpenCodeError) parsed from the upstream `Retry-After` header at throw time.
 * Adapters that throw on non-200 never hand the router a response, so this is
 * the only path by which a thrown 429 keeps its cooldown.
 */
function retryAfterFrom(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const hint = error.retryAfterMs;
  return typeof hint === "number" && Number.isFinite(hint) && hint > 0 ? hint : undefined;
}

function responseFromStatusError(error: unknown): Response | undefined {
  if (!isRecord(error)) return undefined;
  const status = statusFrom(error);
  if (!status) return undefined;
  const statusText = typeof error.statusText === "string" ? error.statusText : undefined;
  // The status text comes from the upstream gateway, so it gets the same
  // redaction pass as the failover reasons: a hostile gateway can smuggle a
  // signed URL or a leaked credential into the status line, and this
  // passthrough hands it straight to the client. The body itself is served
  // intact (the client needs the refusal); only the smuggled diagnostics are
  // masked.
  const redactedStatusText = statusText === undefined ? undefined : redactDiagnostics(statusText);
  const body = typeof error.body === "string" ? error.body : "";
  // An adapter-thrown typed error body (e.g. OpenCodeError.body) is JSON; serve
  // it as JSON so OpenAI-compatible clients can parse the refusal. Plain-text
  // bodies keep their text/plain label. Named isJson (not json) so it can't be
  // confused with the module-level json() response helper above.
  let isJson = false;
  if (body.trim() !== "") {
    try {
      JSON.parse(body);
      isJson = true;
    } catch {
      // Plain text stays plain text.
    }
  }
  return new Response(body, {
    status,
    statusText: redactedStatusText,
    headers: {
      "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
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

function withModelHeader(response: Response, selector: string, brand?: { id: string; names?: () => string[] }): Response {
  if (brand) return brandedResponse(response, brand.id, brand.names?.() ?? []);
  const headers = new Headers(response.headers);
  headers.set(ANSWERED_MODEL_HEADER, selector);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Drop fields that name the upstream (model, provider, fingerprint) and put the brand id in `model`. */
const UPSTREAM_WORDS = /\b(?:opencode(?: zen)?|kilo(?: ?code| gateway)?|openrouter|nvidia|zen|mimo|console)\b/gi;

/** Remove backend names and model ids from a message a client will see. */
export function scrubUpstreamText(text: string, names: readonly string[] = []): string {
  let out = text;
  for (const name of identityTokens(names).sort((a, b) => b.length - a.length)) {
    if (name.length >= 3) out = out.split(name).join("model");
  }
  out = out.replace(UPSTREAM_WORDS, "upstream").replace(VENDOR_PATTERN, "model");
  // Version-looking tokens (v2.6, 3.5-flash, 480b) can identify a model too.
  out = out.replace(/\b[a-z]*-?\d+(?:\.\d+)*[a-z]?(?:-[a-z0-9]+)*\b/gi, (token) => (/^\d{3}$/.test(token) || /^\d+(\.\d+)?s$/.test(token) ? token : /\d\.\d|\d+b\b|-/i.test(token) ? "model" : token));
  out = out.replace(/\b(upstream|model)[-:](?:free|model)\b/gi, "model").replace(/:free\b/gi, "");
  return out.replace(/\bmodel(?:[\s/:-]+model)+\b/gi, "model").replace(/\s{2,}/g, " ").trim();
}

const VENDOR_PATTERN = new RegExp(`(?<![a-z0-9])(?:${VENDOR_WORDS.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![a-z0-9])`, "gi");

const brandIds = new Map<string, string>();
/** Stable opaque id per upstream id, so every frame of one stream shares an id. */
function brandIdFor(upstreamId: string): string {
  let id = brandIds.get(upstreamId);
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    brandIds.set(upstreamId, id);
    if (brandIds.size > 500) brandIds.delete(brandIds.keys().next().value!);
  }
  return id;
}

const MESSAGE_KEYS = ["role", "content", "reasoning", "reasoning_content", "tool_calls", "refusal", "function_call"];

function opaqueToolCalls(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((call) => {
    if (!isRecord(call)) return call;
    const next: Record<string, unknown> = {};
    for (const key of ["index", "type"]) if (key in call) next[key] = call[key];
    if (typeof call.id === "string" && call.id) next.id = opaqueToolCallId(call.id);
    if (isRecord(call.function)) {
      const fn: Record<string, unknown> = {};
      for (const key of ["name", "arguments"]) if (key in call.function) fn[key] = call.function[key];
      next.function = fn;
    }
    return next;
  });
}

function opaqueMessage(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const key of MESSAGE_KEYS) if (key in value) next[key] = value[key];
  if ("tool_calls" in next) next.tool_calls = opaqueToolCalls(next.tool_calls);
  return next;
}

/**
 * Allowlist rewrite of one completion/chunk: only OpenAI-standard fields
 * survive, so provider extras (provider, system_fingerprint, reasoning_details
 * formats, logprobs/tokenizer detail, cost, native finish reasons) cannot
 * name or fingerprint the model. `model` becomes the brand id.
 */
function brandPayload(value: unknown, brandId: string, names: readonly string[] = []): unknown {
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = {};
  if (isRecord(value.error)) {
    const error: Record<string, unknown> = {};
    error.message = typeof value.error.message === "string" ? scrubUpstreamText(value.error.message, names) : "Request failed";
    if (typeof value.error.type === "string") error.type = value.error.type;
    if (typeof value.error.code === "string" && /^[a-z_]{1,40}$/.test(value.error.code)) error.code = value.error.code;
    copy.error = error;
  }
  if (typeof value.id === "string") copy.id = `chatcmpl-${brandIdFor(value.id)}`;
  if (typeof value.object === "string") copy.object = value.object;
  if (typeof value.created === "number") copy.created = value.created;
  if ("model" in value || Array.isArray(value.choices)) copy.model = brandId;
  if (Array.isArray(value.choices)) {
    copy.choices = value.choices.map((choice) => {
      if (!isRecord(choice)) return choice;
      const next: Record<string, unknown> = {};
      if ("index" in choice) next.index = choice.index;
      if ("message" in choice) next.message = opaqueMessage(choice.message);
      if ("delta" in choice) next.delta = opaqueMessage(choice.delta);
      if ("finish_reason" in choice) next.finish_reason = choice.finish_reason;
      return next;
    });
  }
  if (isRecord(value.usage)) {
    const usage: Record<string, unknown> = {};
    for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) if (typeof value.usage[key] === "number") usage[key] = value.usage[key];
    copy.usage = usage;
  } else if (value.usage === null) {
    copy.usage = null;
  }
  return copy;
}

/**
 * Rewrite a completion so it never names the model or backend that answered.
 * SSE is rewritten frame by frame (streaming is preserved); JSON is buffered
 * and rewritten once. Anything else passes through.
 */
function brandedResponse(response: Response, brandId: string, names: readonly string[] = []): Response {
  // Allowlist: upstream headers (CSP, server, request ids, rate-limit
  // counters) would name the gateway behind the answer.
  const headers = new Headers();
  for (const key of ["content-type", "cache-control", "retry-after"]) {
    const value = response.headers.get(key);
    if (value) headers.set(key, value);
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.body || (!type.includes("json") && !type.includes("event-stream"))) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const sse = type.includes("event-stream");
  const rewriteLine = (line: string): string => {
    if (!line.startsWith("data:")) return line;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return line;
    try {
      return `data: ${JSON.stringify(brandPayload(JSON.parse(data), brandId, names))}`;
    } catch {
      return line;
    }
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      if (!sse) return;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (lines.length) controller.enqueue(encoder.encode(lines.map(rewriteLine).join("\n") + "\n"));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (sse) {
        if (buffer) controller.enqueue(encoder.encode(rewriteLine(buffer)));
        return;
      }
      try {
        controller.enqueue(encoder.encode(JSON.stringify(brandPayload(JSON.parse(buffer), brandId, names))));
      } catch {
        controller.enqueue(encoder.encode(buffer));
      }
    },
  });
  return new Response(response.body.pipeThrough(transform), { status: response.status, statusText: response.statusText, headers });
}

function backendOf(selector: string): string {
  const separator = selector.indexOf("/");
  return separator > 0 ? selector.slice(0, separator) : "";
}

function retryAfterFromReason(reason: string): number | undefined {
  const match = reason.match(/\(retry after (\d+)s\)/);
  return match ? Number(match[1]) * 1_000 : undefined;
}

const QUOTA_REASON = /quota|usage limit|limit (?:reached|exceeded)|out of credits|insufficient credits|free tier limit/i;

function sanitizeReason(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = redactDiagnostics(raw).trim();
  const text = cleaned || fallback;
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function upstreamReason(status: number, statusText: string | undefined, detail: string): string {
  // The status text also comes from the upstream gateway, so it gets the same
  // redaction pass as the body: a hostile gateway can smuggle a signed URL or
  // a leaked credential into "502 Bad Gateway?token=..." and the reason is
  // handed back to the client.
  const head = `upstream ${status}${statusText ? ` ${redactDiagnostics(statusText)}` : ""}`;
  const trimmed = detail.trim();
  const short = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  return short ? `${head}: ${short}` : head;
}

/** Max error-body bytes read for failure diagnostics; the rest is discarded. */
const MAX_UPSTREAM_ERROR_SNIPPET_BYTES = 2_048;

// Re-exported for existing callers (adapters, tests) that read it via the
// router module.
export { retryAfterMs } from "./retry-after";

/**
 * Max upstream 200-body bytes buffered while checking for the empty-content
 * quirk. A real chat-completion payload is small; an anomalous multi-MB
 * body must fail over instead of being buffered into memory whole.
 */
export const MAX_UPSTREAM_RESPONSE_BYTES = 8_388_608;

/**
 * Read at most `maxBytes` of an upstream error body for the failover reason,
 * then stop the stream. A bloated upstream error page (multi-MB gateway HTML
 * on a 502) must not be fully buffered just to diagnose the failure. The
 * snippet is redacted before it reaches any failover reason: upstream error
 * bodies can carry signed URLs or leaked credentials, and failover reasons
 * are handed back to the client.
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
    // Enforce the byte cap exactly: one upstream chunk can be larger than
    // the cap on its own, so slice after concat rather than trusting chunk size.
    return redactDiagnostics(new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes)));
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
      // Check the cap before retaining the chunk: a single oversized chunk
      // must trip the cap without being buffered into memory whole first.
      if (bytes + part.value.byteLength > maxBytes) return { text: "", oversize: true };
      chunks.push(part.value);
      bytes += part.value.byteLength;
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
 * false when it is an empty chat completion (the Kilo empty-content quirk)
 * or carries a `choices` key that is not a valid completion list
 * (`{"choices": null}` — some gateways answer 200 with that on a backend
 * error; serving it as a successful 200 would hand the client a choice-less
 * "answer" with no failover), undefined when it carries no `choices` key at
 * all (opaque: pass through, the envelope scan decides).
 */
function chatCompletionHasContent(payload: unknown): boolean | undefined {
  if (!isRecord(payload)) return undefined;
  const choices = payload.choices;
  if (!Array.isArray(choices)) return "choices" in payload ? false : undefined;
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

/** Flatten a string, an error object, or a list mixing either, to one message.
 * Some gateways nest the refusal (`{ "error": { "errors": [{ "message": ... }] } }`),
 * so record nodes recurse into `error`/`errors` keys as well as `message`/`detail`.
 * FastAPI validation errors and some Python-style gateways carry the text
 * under `msg` instead of `message` (`{ "detail": [{ "loc": [...], "msg": ...,
 * "type": "missing" }] }`, `{ "error": { "msg": ... } }`), so `msg` is read
 * as a last-resort message key after the more standard ones. */
function envelopeText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (isRecord(value)) {
    return (
      envelopeText(value.message) ||
      envelopeText(value.detail) ||
      envelopeText(value.error) ||
      envelopeText(value.errors) ||
      envelopeText(value.msg)
    );
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => envelopeText(item))
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .join("; ");
  }
  return "";
}

/**
 * Extract the message from an upstream HTTP 200 body that is an error envelope
 * instead of a completion. Some gateways signal a refusal with a 200 using an
 * OpenAI-style envelope (`{ "error": { "message": ... } }`), others send the
 * refusal as a bare string (`{ "error": "quota exceeded" }`), as a list of
 * strings (`{ "error": ["quota exceeded", "retry later"] }`), as a list of
 * error objects (`{ "error": [{ "message": ... }] }`), as a nested envelope
 * (`{ "error": { "errors": [{ "message": ... }] } }`), or under the plural key
 * (`{ "errors": [{ "message": ... }] }`, the shape Google-style gateways use),
 * or under the FastAPI-style top-level `detail` key (`{ "detail": "rate limit
 * exceeded" }`); a Python-style gateways' code key is also read (`{ "error":
 * { "status_code": 429 } }` or `statusCode`); some gateways key the message
 * text as `msg` rather than `message` (FastAPI validation lists carry
 * `{ "detail": [{ "loc": [...], "msg": ..., "type": "missing" }] }`, and some
 * wrappers send `{ "error": { "msg": ... } }`) and `msg` is read as a
 * last-resort message key; some gateways key the whole refusal as a
 * top-level `message` (`{ "message": "capacity exhausted, try again" }`),
 * which is read first, mirroring `message`'s first-resort status inside
 * envelopeText; some gateways key the whole refusal as a top-level `msg`
 * (`{ "msg": "capacity exhausted, try again" }`), which is read last for
 * the same reason;
 * without this check the envelope would reach the client as a "successful" 200 and the attempt would
 * count as answered, so no failover would happen. Returns undefined for a
 * genuine completion: a real chat completion never carries a top-level error
 * envelope, so a contentful answer always wins over a stray "error" key. A
 * message-less envelope is still a refusal when it carries a numeric error
 * code/status (`{ "error": { "code": 429 } }`): an envelope with a 4xx/5xx
 * code and no message text would otherwise be served to the client as a
 * successful 200, with no failover and no 429 cooldown. A bare numeric
 * entry (`{ "error": 429 }`) is the same refusal in shorthand and gets the
 * same treatment.
 */
function errorEnvelopeMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  // A contentful answer always wins over a stray "error" key, whether or not
  // the envelope carries a message.
  if (chatCompletionHasContent(payload) === true) return undefined;
  // Some gateways carry the whole refusal as a top-level `message` key instead
  // of `error`/`errors`/`detail`/`msg` (`{ "message": "..." }`): without the
  // leading `message` scan the body is opaque (no `choices`), so it would be
  // served to the client as a successful 200 instead of failing over. `msg`
  // stays last, mirroring its last-resort status inside envelopeText.
  const message =
    envelopeText(payload.message) ||
    envelopeText(payload.error) ||
    envelopeText(payload.errors) ||
    envelopeText(payload.detail) ||
    envelopeText(payload.msg);
  if (message) return message;
  const status = envelopeStatus(payload);
  return status === undefined ? undefined : `upstream error ${status}`;
}

/**
 * Rate-limit refusal strings some gateways use instead of a numeric code
 * (`{ "error": { "code": "rate_limit_exceeded" } }` or, OpenAI-style,
 * `{ "error": { "type": "rate_limit_error" } }`). Only explicit
 * rate-limit signals map to 429: quota/billing strings (e.g.
 * "insufficient_quota", "quota_exceeded") stay unmapped because a quota
 * refusal is not a signal to wait before retrying — it still fails over
 * immediately like any other non-429 envelope.
 */
const RATE_LIMIT_CODE_STRINGS: ReadonlySet<string> = new Set([
  "rate_limit_exceeded",
  "rate_limited",
  "rate-limit-exceeded",
  "rate_limit_error",
  "too_many_requests",
  "too-many-requests",
  "throttled",
]);

/**
 * Pull a numeric error code out of an HTTP 200 error envelope
 * (`{ "error": { "code": 429 } }`, `{ "error": { "status": 429 } }`, or the
 * Python-style `{ "error": { "status_code": 429 } }`/`{ "error": {
 * "statusCode": 429 } }`, or the same shapes under the plural `errors` key
 * or the FastAPI-style `detail` key, including nested envelopes like
 * `{ "error": { "errors": [{ "code": 429 }] } }` or `{ "error": { "detail":
 * { "status_code": 429 } } }` (the descent reaches nested `detail` nodes
 * the same way it reaches nested `error`/`errors` nodes). Some gateways signal a refusal
 * with a 200 plus an error envelope instead of a real error status; spotting
 * the code lets the chain treat a 429-in-envelope like any other 429 (fail
 * over with the 429 cooldown) instead of advancing immediately after a rate
 * limit. A few gateways use a rate-limit string code instead of a number —
 * either in `code` or, OpenAI-style, in `type` (`"rate_limit_error"`) — and
 * the recognized strings map to 429 so they get the same cooldown rather
 * than burning the next attempt against the still rate-limited backend. A
 * bare string entry (`{ "error": "rate_limit_exceeded" }`) naming a
 * recognized rate-limit condition maps to 429 the same way, and a bare
 * numeric entry (`{ "error": 429 }`, or nested/inside a list) is taken as
 * that code directly. The scan seed also covers top-level `message` and `msg`
 * keys, so a gateway that carries the whole refusal as
 * `{ "message": "rate_limit_exceeded" }` or `{ "msg": "rate_limit_exceeded" }`
 * still gets the 429 cooldown. The descent also reaches nested `msg` and `message`
 * nodes, so a gateway that keys its refusal text as `msg` or `message`
 * (`{ "error": { "msg": "rate_limit_exceeded" } }` or
 * `{ "error": { "message": "rate_limit_exceeded" } }`) gets the 429 cooldown
 * just like a bare-string error entry instead of failing over immediately.
 * The seed also includes the payload record itself, so a gateway that keys
 * the refusal code on the envelope's top level (`{ "code": 429 }`, or
 * top-level `status`/`status_code`/`statusCode`, or a rate-limit string in
 * top-level `type`) gets the 429 cooldown the same way instead of being
 * served to the client as a successful 200. A genuine completion is
 * unaffected: errorEnvelopeMessage returns before the status scan whenever
 * the payload carries contentful choices, and real completions never carry
 * a top-level 4xx/5xx code or rate-limit type string.
 */
function envelopeStatus(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  // Gateways sometimes nest the refusal (`{ "error": { "errors": [{ "code": 429 }] } }`),
  // so the scan descends into nested `error`/`errors`/`detail`/`msg`/`message`
  // nodes after checking the code on each node. Payloads come from JSON.parse,
  // so there are no reference cycles and the queue walk always terminates.
  // A gateway that keys its whole refusal as a top-level `message` or `msg`
  // instead of `error`/`errors`/`detail`
  // (`{ "message": "rate_limit_exceeded" }`, `{ "msg": "rate_limit_exceeded" }`)
  // is included from the seed, so the 429 cooldown still applies there. The
  // payload record itself is also seeded, so a top-level numeric `code` (or
  // `status`/`status_code`/`statusCode`, or a rate-limit string in `type`)
  // is seen the same way as one nested under `error`: `{ "code": 429 }`
  // would otherwise be served to the client as a successful 200 with no
  // failover and no cooldown. Entries already in the seed are reached twice
  // via the payload's own descent, which is harmless.
  const queue: unknown[] = [payload, payload.message, payload.error, payload.errors, payload.detail, payload.msg];
  for (let i = 0; i < queue.length; i += 1) {
    const entry = queue[i];
    if (Array.isArray(entry)) {
      queue.push(...entry);
      continue;
    }
    // A bare string (or a string inside a string array) naming a recognized
    // rate-limit condition is a 429 like any record-carried code; without
    // this, {"error":"rate_limit_exceeded"} would fail over immediately and
    // burn the next attempt against the still rate-limited backend.
    if (typeof entry === "string") {
      if (RATE_LIMIT_CODE_STRINGS.has(entry.trim().toLowerCase())) return 429;
      continue;
    }
    // A bare numeric entry (`{ "error": 429 }`, or nested/inside a list) is a
    // gateway's shorthand for that error code; without this the envelope has
    // no message and no code and would be served as a successful 200.
    if (typeof entry === "number") {
      if (Number.isInteger(entry) && entry >= 400 && entry <= 599) return entry;
      continue;
    }
    if (!isRecord(entry)) continue;
    // Python-style gateways carry the code as `status_code` (or camelCase
    // `statusCode`) rather than `code`/`status`; those scan the same way.
    for (const candidate of [entry.code, entry.status, entry.type, entry.status_code, entry.statusCode]) {
      const text =
        typeof candidate === "number" ? String(candidate)
        : typeof candidate === "string" ? candidate.trim()
        : "";
      if (text === "") continue;
      const parsed = Number(text);
      if (Number.isInteger(parsed) && parsed >= 400 && parsed <= 599) return parsed;
      if (RATE_LIMIT_CODE_STRINGS.has(text.toLowerCase())) return 429;
    }
    // A record node can itself be a FastAPI-style refusal carried under
    // `detail`, and a gateway can key its refusal text as `msg` or `message`,
    // so the descent scans nested `error`, `errors`, `detail`, `msg`, and
    // `message` nodes alike: `{ "error": { "detail": { "status_code": 429 } } }`
    // and `{ "error": { "message": "rate_limit_exceeded" } }` must reach the
    // 429 cooldown just like a top-level `detail` key. Only exact recognized
    // rate-limit strings map to 429 (the bare-string entry check above), so
    // ordinary prose under `message` is unaffected.
    queue.push(entry.error, entry.errors, entry.detail, entry.msg, entry.message);
  }
  return undefined;
}

/**
 * Append the "(retry after Ns)" cooldown note to a 429 failover reason when
 * the upstream gave a Retry-After hint. Shared by the thrown-error and the
 * response paths so the wording cannot drift between them.
 */
function withRetryAfterNote(reason: string, hintMs: number | undefined): string {
  return hintMs !== undefined ? `${reason} (retry after ${Math.round(hintMs / 1_000)}s)` : reason;
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
  // Media types are case-insensitive (RFC 9110): normalize like isJsonResponse does.
  const sse = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
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

export function isLoopbackAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  return value === "::1" || value.startsWith("127.") || value.startsWith("::ffff:127.") || value === "localhost";
}

export class Router {
  readonly adapters: BackendAdapter[];
  readonly timeoutMs: number;
  readonly attemptTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly apiKey?: string;
  readonly primaryModel: string;
  readonly failoverBackoffMs: number;
  private readonly allowedModels?: ReadonlySet<string>;
  private readonly modelChain?: string[];
  readonly catalog?: ModelCatalog;
  readonly backendPriority: readonly string[];
  readonly probeTimeoutMs: number;
  readonly probeOnRefresh: boolean;
  readonly privateMode: boolean;
  readonly quotaBackends: ReadonlySet<string>;
  readonly brand?: { id: string; name: string };
  private readonly onQuotaChange?: (backend: string, exhausted: boolean) => void;
  readonly feedback: FeedbackStore;
  readonly feedbackEnabled: boolean;
  readonly ackTimeoutMs: number;
  private lastWarmAt = 0;
  /** Which selector produced a response, for request-id tracking. */
  private readonly answeredBy = new WeakMap<Response, string>();
  private readonly modelCache = new Map<string, {
    expiresAt: number;
    models?: BackendModel[];
    pending?: Promise<BackendModel[]>;
  }>();

  constructor(options: RouterOptions = {}) {
    this.adapters = options.adapters ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attemptTimeoutMs = Math.min(options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS, this.timeoutMs);
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.apiKey = options.apiKey ?? process.env.DANI_FREE_API_KEY;
    this.primaryModel = options.primaryModel ?? DEFAULT_PRIMARY_MODEL;
    this.allowedModels = options.allowedModels ? new Set(options.allowedModels) : undefined;
    this.modelChain = options.modelChain?.map((selector) => selector.trim()).filter((selector) => selector.length > 0);
    this.failoverBackoffMs = options.failoverBackoffMs ?? DEFAULT_FAILOVER_BACKOFF_MS;
    this.catalog = options.catalog;
    this.backendPriority = options.backendPriority ?? ["opencode", "kilo", "mimo"];
    this.quotaBackends = new Set(options.quotaBackends ?? ["opencode"]);
    this.brand = options.brand;
    this.onQuotaChange = options.onQuotaChange;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 12_000;
    this.probeOnRefresh = options.probeOnRefresh ?? true;
    this.privateMode = options.privateMode ?? false;
    this.feedback = options.feedback ?? new FeedbackStore();
    this.feedbackEnabled = options.feedbackEnabled ?? (!this.privateMode && process.env.DANI_FREE_FEEDBACK !== "0");
    this.ackTimeoutMs = options.ackTimeoutMs ?? 1_500;
  }

  private withLatency(routes: Route[]): Array<Route & { latencyMs?: number }> {
    return routes.map((route) => ({ ...route, latencyMs: this.catalog?.get(modelSelectorId(route.model))?.latencyMs }));
  }

  /** Task order, then the bounded feedback adjustment. */
  private routesForTask(task: Task | undefined, chain: Route[]): Route[] {
    const ordered = task ? orderForTask(task, this.withLatency(chain)) : chain;
    return this.feedback.adjust(task ?? "auto", ordered, (route) => modelSelectorId(route.model));
  }

  /**
   * Voice quick-ack lane. Streams from the fastest non-sidecar models, two at
   * a time; the first to send a byte wins and the other is cancelled. The
   * whole lane has ackTimeoutMs to produce a first byte, else 504
   * ack_timeout (the app plays a local acknowledgment).
   */
  private async completeAck(request: ChatRequest, routes: Route[], signal: AbortSignal): Promise<Response> {
    const budget = deadline(signal, this.ackTimeoutMs);
    const catalog = this.catalog;
    const brand = this.brandContext();
    try {
      for (let start = 0; start < routes.length; start += ACK_HEDGE) {
        if (budget.signal.aborted) break;
        const group = routes.slice(start, start + ACK_HEDGE);
        const controllers = group.map(() => new AbortController());
        const onBudget = () => controllers.forEach((controller) => controller.abort());
        budget.signal.addEventListener("abort", onBudget, { once: true });
        const startedAt = Date.now();
        const attempts = group.map(async (route, index) => {
          const scope = combineSignals(controllers[index].signal, signal);
          const selector = modelSelectorId(route.model);
          let pendingReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          try {
            const response = await raceWithSignal(route.backend.complete({ ...request, model: route.model.id }, route.model, scope.signal), scope.signal);
            if (response.status !== 200 || !response.body) {
              void response.body?.cancel().catch(() => undefined);
              if (!controllers[index].signal.aborted) {
                catalog?.recordFailure(selector, `HTTP ${response.status}`, { rateLimited: response.status === 429, retryAfterMs: retryAfterMs(response.headers) });
              }
              throw new Error("no answer");
            }
            const reader = response.body.getReader();
            pendingReader = reader;
            // The winner is the first to send spoken content, not just bytes:
            // reasoning models stream thinking deltas (empty content) first.
            const decoder = new TextDecoder();
            const chunks: Uint8Array[] = [];
            let seen = "";
            for (;;) {
              const next = await raceWithSignal(reader.read(), scope.signal);
              if (next.done) {
                if (chunks.length && /"content"\s*:\s*"(?:[^"\\]|\\.)+"/.test(seen)) break;
                throw new Error("empty");
              }
              if (!next.value?.length) continue;
              chunks.push(next.value);
              seen = (seen + decoder.decode(next.value, { stream: true })).slice(-4_096);
              if (/"content"\s*:\s*"(?:[^"\\]|\\.)+"/.test(seen)) break;
            }
            const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const first = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { first.set(chunk, offset); offset += chunk.length; }
            return { index, selector, response, reader, first };
          } catch (error) {
            // A cancelled loser (or failed attempt) must release its upstream stream.
            void pendingReader?.cancel().catch(() => undefined);
            if (!controllers[index].signal.aborted && !signal.aborted && !(error instanceof Error && error.message === "no answer")) {
              catalog?.recordFailure(selector, sanitizeReason(error, "network error"));
            }
            throw error;
          } finally {
            scope.dispose?.();
          }
        });
        let winner: Awaited<typeof attempts[number]> | undefined;
        try {
          winner = await Promise.any(attempts);
        } catch {
          winner = undefined;
        } finally {
          budget.signal.removeEventListener("abort", onBudget);
        }
        if (!winner) continue;
        const won = winner;
        controllers.forEach((controller, index) => { if (index !== won.index) controller.abort(); });
        // Losers that already answered: release their bodies.
        attempts.forEach((attempt, index) => {
          if (index === won.index) return;
          void attempt.then((other) => other.reader.cancel().catch(() => undefined), () => undefined);
        });
        catalog?.recordSuccess(won.selector, Date.now() - startedAt);
        this.noteAnswered(won.selector);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(won.first);
          },
          async pull(controller) {
            const next = await won.reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          cancel(reason) {
            void won.reader.cancel(reason).catch(() => undefined);
          },
        });
        const response = withModelHeader(new Response(body, { status: 200, headers: won.response.headers }), won.selector, brand);
        this.answeredBy.set(response, won.selector);
        return response;
      }
      if (signal.aborted) throw abortError(signal);
      return structuredError("No quick answer in time", 504, "ack_timeout", "api_error");
    } finally {
      budget.dispose();
    }
  }

  private warm(): void {
    const now = Date.now();
    if (now - this.lastWarmAt < WARM_INTERVAL_MS) return;
    this.lastWarmAt = now;
    for (const adapter of this.adapters) {
      if (adapter.id === "opencode") continue;
      const scope = abortAfter(10_000);
      void Promise.resolve().then(() => adapter.listModels(scope.signal)).catch(() => undefined).finally(() => scope.cancel());
    }
  }

  /** True when this failure means the backend's shared free quota is used up. */
  private isQuotaFailure(item: AttemptFailure): boolean {
    const backend = backendOf(item.model);
    if (this.quotaBackends.has(backend)) return isRateLimitFailure(item.status, item.reason) || QUOTA_REASON.test(item.reason);
    return QUOTA_REASON.test(item.reason);
  }

  private noteQuota(item: AttemptFailure): void {
    if (!this.catalog || !this.isQuotaFailure(item)) return;
    const backend = backendOf(item.model);
    const wasHeld = this.catalog.exhaustedBackends().includes(backend);
    this.catalog.recordBackendQuota(backend, item.reason, retryAfterFromReason(item.reason));
    if (!wasHeld) this.onQuotaChange?.(backend, true);
  }

  /** Model ids, selectors and names the brand must never reveal. */
  private brandContext(): { id: string; names: () => string[] } | undefined {
    if (!this.brand) return undefined;
    return {
      id: this.brand.id,
      names: () => (this.catalog?.entries() ?? []).flatMap((entry) => [entry.selector, entry.id, entry.name]),
    };
  }

  private noteAnswered(selector: string): void {
    if (!this.catalog) return;
    const backend = backendOf(selector);
    if (this.catalog.clearBackendQuota(backend)) this.onQuotaChange?.(backend, false);
  }

  /**
   * Check whether backends on a quota hold have their free quota back: one
   * tiny request to the backend's best model once the hold has passed.
   * Success lifts the hold (auto switches back); another quota answer extends it.
   */
  async probeRecovery(signal?: AbortSignal): Promise<string[]> {
    if (!this.catalog) return [];
    const recovered: string[] = [];
    for (const backendId of this.catalog.backendsDueForProbe()) {
      const adapter = this.findAdapter(backendId);
      if (!adapter) continue;
      let models: BackendModel[] = [];
      try {
        models = await this.modelsFor(adapter, signal);
      } catch (error) {
        if (isAbort(error)) throw error;
        continue;
      }
      const order = this.catalog.ranked(this.backendPriority).filter((selector) => backendOf(selector) === backendId);
      const model = order.map((selector) => models.find((candidate) => modelSelectorId(candidate) === selector)).find(Boolean) ?? models[0];
      if (!model) continue;
      const result = await this.probe(adapter, model, signal ?? new AbortController().signal);
      const selector = modelSelectorId(model);
      if (result.ok) {
        this.catalog.recordSuccess(selector, result.latencyMs);
        this.noteAnswered(selector);
        recovered.push(backendId);
      } else if (result.rateLimited || QUOTA_REASON.test(result.error ?? "")) {
        this.catalog.recordBackendQuota(backendId, result.error ?? "rate limited", result.retryAfterMs);
      }
    }
    return recovered;
  }

  /** Catalog ranking applies only when no explicit roster/chain pins the models. */
  private get catalogActive(): boolean {
    return Boolean(this.catalog?.populated) && !this.allowedModels && !this.modelChain;
  }

  /**
   * Re-list every backend now (bypassing the discovery cache), probe models
   * that have never answered, and persist. Safe to call concurrently.
   */
  async refreshCatalog(signal?: AbortSignal): Promise<RefreshSummary | undefined> {
    if (!this.catalog) return undefined;
    this.modelCache.clear();
    const prober = this.probeOnRefresh
      ? (adapter: BackendAdapter, model: BackendModel, probeSignal: AbortSignal) => this.probe(adapter, model, probeSignal)
      : undefined;
    const summary = await this.catalog.refresh(this.adapters, { signal, prober, probeConcurrency: 4 });
    this.modelCache.clear();
    return summary;
  }

  /** One tiny real completion: proves the model answers with content right now. */
  private async probe(adapter: BackendAdapter, model: BackendModel, signal: AbortSignal): Promise<ProbeResult> {
    const startedAt = Date.now();
    const scope = deadline(signal, this.probeTimeoutMs);
    try {
      const request: ChatRequest = {
        model: model.id,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 64,
        temperature: 0,
        stream: false,
      };
      const response = await raceWithSignal(adapter.complete(request, model, scope.signal), scope.signal);
      const latencyMs = Date.now() - startedAt;
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        return {
          ok: false,
          latencyMs,
          error: `HTTP ${response.status}`,
          rateLimited: response.status === 429,
          retryAfterMs: retryAfterMs(response.headers),
        };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(await raceWithSignal(response.text(), scope.signal));
      } catch {
        return { ok: false, latencyMs, error: "invalid JSON body" };
      }
      if (errorEnvelopeMessage(payload) !== undefined) {
        return { ok: false, latencyMs, error: "error envelope", rateLimited: envelopeStatus(payload) === 429 };
      }
      // Reasoning models may spend a tiny budget thinking; a well-formed choice counts as alive.
      const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : undefined;
      if (!choices || choices.length === 0) return { ok: false, latencyMs, error: "no choices" };
      // A model that says it does tools must return one well-formed call before tool turns go to it.
      const toolsOk = model.capabilities.includes("tools") ? await this.probeTools(adapter, model, scope.signal) : undefined;
      return { ok: true, latencyMs, ...(toolsOk === undefined ? {} : { toolsOk }) };
    } catch (error) {
      const status = statusFrom(error);
      if (isAbort(error) && signal.aborted) throw error;
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: status ? `HTTP ${status}` : sanitizeReason(error, "probe failed"),
        rateLimited: status === 429,
        retryAfterMs: retryAfterFrom(error),
      };
    } finally {
      scope.dispose();
    }
  }

  /** Tool-call smoke check: one forced call to a trivial function with valid JSON arguments. */
  private async probeTools(adapter: BackendAdapter, model: BackendModel, signal: AbortSignal): Promise<boolean | undefined> {
    const request: ChatRequest = {
      model: model.id,
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Current weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      }],
      tool_choice: "auto",
      max_tokens: 256,
      temperature: 0,
      stream: false,
    } as ChatRequest;
    try {
      const response = await raceWithSignal(adapter.complete(request, model, signal), signal);
      if (response.status === 429) {
        void response.body?.cancel().catch(() => undefined);
        return undefined; // capacity, not a verdict: check again next refresh
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        return false;
      }
      const payload = JSON.parse(await raceWithSignal(response.text(), signal)) as unknown;
      const choice = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
      const calls = isRecord(choice) && isRecord(choice.message) && Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
      return calls.some((call) => {
        if (!isRecord(call) || !isRecord(call.function) || call.function.name !== "get_weather") return false;
        try {
          const args = JSON.parse(String(call.function.arguments ?? "")) as unknown;
          return isRecord(args) && typeof args.city === "string" && args.city.length > 0;
        } catch {
          return false;
        }
      });
    } catch (error) {
      if (isAbort(error) && signal.aborted) return undefined;
      return statusFrom(error) === 429 ? undefined : false;
    }
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
    const listed = groups.flat().filter((model) => !this.allowedModels || this.allowedModels.has(modelSelectorId(model)));
    if (!this.catalogActive) return listed;
    const order = this.catalog!.ranked(this.backendPriority);
    const rank = new Map(order.map((selector, index) => [selector, index]));
    return listed
      .filter((model) => rank.has(modelSelectorId(model)))
      .sort((left, right) => rank.get(modelSelectorId(left))! - rank.get(modelSelectorId(right))!);
  }

  async health(signal?: AbortSignal): Promise<BackendHealth[]> {
    return Promise.all(
      this.adapters.map(async (adapter): Promise<BackendHealth> => {
        try {
          return await raceWithSignal(Promise.resolve().then(() => adapter.health(signal)), signal);
        } catch (error) {
          // A throwing health check means the check itself failed, not that the
          // backend is unconfigured: the adapter is registered with the router,
          // so configured stays true. (Adapters report configured: false
          // themselves when they genuinely lack configuration; that path
          // resolves rather than throws, so it never reaches this catch.)
          return {
            backend: adapter.id,
            configured: true,
            healthy: false,
            checkedAt: new Date().toISOString(),
            // Health reasons are exposed on GET /health, so a throwing health
            // check gets the same redaction pass as failover reasons: a
            // misbehaving sidecar can leak a signed URL or credential into its
            // error message.
            reason: error instanceof Error ? redactDiagnostics(error.message) : "health check failed",
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
    if (this.catalogActive) return this.catalog!.ranked(this.backendPriority);
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

  private async failoverBackoff(signal: AbortSignal, retryAfterHintMs?: number): Promise<void> {
    // An upstream-requested cooldown wins over the fixed base: the next
    // attempt usually targets the same rate-limited backend, so waiting what
    // it asked for beats burning an attempt on a guaranteed refusal.
    const base = Math.max(this.failoverBackoffMs, retryAfterHintMs ?? 0);
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
   * anomalous 204/1xx/3xx responses (no content, an interim status, or a
   * redirect — never a chat answer), and HTTP 200 with an error envelope,
   * invalid JSON, empty/no text content,
   * or a body exceeding the MAX_UPSTREAM_RESPONSE_BYTES buffer cap. Never fails over after response bytes
   * have been emitted to the client. Each attempt gets its own deadline
   * (attemptTimeoutMs): a hung backend is abandoned and the chain walks on
   * instead of burning the whole request deadline on the first attempt. All
   * attempts still share the caller's overall deadline via `signal`.
   */
  private async completeWithFailover(request: ChatRequest, attempts: Route[], signal: AbortSignal): Promise<Response> {
    const failures: AttemptFailure[] = [];
    const catalog = this.catalog;
    if (catalog) {
      const push = failures.push.bind(failures);
      failures.push = (...items: AttemptFailure[]) => {
        for (const item of items) {
          catalog.recordFailure(item.model, item.reason, { rateLimited: isRateLimitFailure(item.status, item.reason) });
          this.noteQuota(item);
        }
        return push(...items);
      };
    }
    let attemptStartedAt = Date.now();
    const answered = (response: Response, selector: string): Response => {
      catalog?.recordSuccess(selector, Date.now() - attemptStartedAt);
      this.noteAnswered(selector);
      const result = withModelHeader(response, selector, this.brandContext());
      this.answeredBy.set(result, selector);
      return result;
    };
    const required = requiredCapabilities(request);

    for (let index = 0; index < attempts.length; index += 1) {
      const route = attempts[index];
      const selector = modelSelectorId(route.model);
      // The backoff after a 429 exists so the next model starts clean. After
      // the final attempt there is no next model, so waiting would only delay
      // the 503 the caller is already going to get.
      const hasNext = index < attempts.length - 1;
      if (signal.aborted) throw abortError(signal);
      // A backend that ran out of free quota earlier in this request (or
      // before it) is skipped while anything else is left to try.
      const held = catalog?.exhaustedBackends() ?? [];
      if (held.includes(route.model.backend) && attempts.slice(index + 1).some((next) => !held.includes(next.model.backend))) continue;
      const usable = (candidate: Route) => supportsCapabilities(candidate.model, required)
        && !(required.includes("tools") && this.catalog?.toolsBroken(modelSelectorId(candidate.model)));
      if (!usable(route)) {
        if ((this.brand || supportsCapabilities(route.model, required)) && attempts.slice(index + 1).some(usable)) continue;
        return structuredError(
          this.brand
            ? `${this.brand.name} cannot handle this request right now (needs: ${required.join(", ")})`
            : `Model ${route.model.id} does not support required capabilities: ${required.join(", ")}`,
          422,
          "unsupported_capability",
        );
      }
      const limitError = outputLimitError(request, route.model, this.brand?.name);
      if (limitError) return limitError;

      let response: Response;
      // A hung backend must not consume the whole request deadline: each
      // attempt runs under its own shorter deadline so the chain can walk on.
      attemptStartedAt = Date.now();
      // A real stream sends headers with its first token, so a streaming
      // attempt with no first byte after STREAM_FIRST_BYTE_MS is hung: move on
      // instead of burning the full attempt deadline. (OpenCode buffers the
      // whole turn before answering, so it keeps the full deadline.)
      const firstByteLimit = request.stream === true && route.model.backend !== "opencode"
        ? Math.min(this.attemptTimeoutMs, STREAM_FIRST_BYTE_MS)
        : this.attemptTimeoutMs;
      const attemptScope = deadline(signal, firstByteLimit);
      try {
        const completion = route.backend.complete({ ...request, model: route.model.id }, route.model, attemptScope.signal);
        // An adapter may ignore cancellation and return a body after the caller has left.
        void completion.then((candidate) => {
          if (attemptScope.signal.aborted) void candidate.body?.cancel().catch(() => undefined);
        }, () => undefined);
        response = await raceWithSignal(completion, attemptScope.signal);
      } catch (error) {
        // Client cancellation and the overall deadline are never retried.
        if (signal.aborted) throw error;
        if (isAbort(error)) {
          // Only this attempt's deadline fired: the backend hung. Record it
          // and walk to the next model immediately. The failover backoff is
          // a 429 cooldown (honoring the upstream Retry-After); a hung
          // backend gave no rate-limit signal, so pausing here would only
          // delay the chain after the attempt already burned its deadline.
          failures.push({ model: selector, reason: "attempt timed out" });
          continue;
        }
        const status = statusFrom(error);
        if (status === 429) {
          const retryAfterHint = retryAfterFrom(error);
          const reason = retryableStatusReason(error, status, "rate limited");
          failures.push({
            model: selector,
            status,
            reason: withRetryAfterNote(reason, retryAfterHint),
          });
          // Switching to another backend needs no wait: the limit was not theirs.
          if (hasNext && attempts[index + 1].model.backend === route.model.backend && !catalog?.exhaustedBackends().includes(route.model.backend)) {
            await this.failoverBackoff(signal, retryAfterHint);
          }
          continue;
        }
        // 401/403 from a backend is that backend refusing us (key, tier,
        // region), not a bad request: another backend may well answer.
        const refusedByBackend = (status === 401 || status === 403)
          && attempts.slice(index + 1).some((next) => next.model.backend !== route.model.backend);
        if (status !== undefined && (status === 408 || status >= 500 || refusedByBackend)) {
          failures.push({ model: selector, status, reason: retryableStatusReason(error, status, "upstream error") });
          continue;
        }
        if (status !== undefined) {
          // Other 4xx are not retryable: pass the upstream refusal through.
          // responseFromStatusError always builds a Response in this branch:
          // statusFrom already found a status on this error above.
          return withModelHeader(responseFromStatusError(error)!, selector, this.brandContext());
        }
        failures.push({ model: selector, reason: sanitizeReason(error, "network error") });
        continue;
      } finally {
        attemptScope.dispose();
      }

      const status = response.status;
      if (status === 429) {
        const retryAfter = retryAfterMs(response.headers);
        const reason = upstreamReason(status, response.statusText || undefined, await readUpstreamSnippet(response, signal));
        failures.push({
          model: selector,
          status,
          reason: withRetryAfterNote(reason, retryAfter),
        });
        if (hasNext) await this.failoverBackoff(signal, retryAfter);
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
        return withModelHeader(response, selector, this.brandContext());
      }
      if (status === 204 || status < 200 || status >= 300) {
        // 204, 1xx, and 3xx are never chat answers: a gateway that hands back
        // no content, an interim status, or a redirect is anomalous, so fail
        // over instead of serving it to the client as a successful answer.
        failures.push({
          model: selector,
          status,
          reason: upstreamReason(status, response.statusText || undefined, await readUpstreamSnippet(response, signal)),
        });
        continue;
      }

      // 2xx: guard against the empty-content quirk, error envelopes, invalid
      // JSON, and oversized bodies on JSON responses — streaming requests
      // included. No response bytes have reached the client yet at this point,
      // so there is no failing-over-after-emission here: real SSE streams
      // still relay untouched below (isJsonResponse is false for
      // text/event-stream), while an anomalous JSON body fails over instead
      // of being served to the client as a successful answer.
      if (isJsonResponse(response)) {
        let text: string;
        let oversize = false;
        try {
          ({ text, oversize } = await readCappedResponseBody(response, signal));
        } catch (error) {
          if (isAbort(error)) throw error;
          // A mid-body upstream failure is handed to the client as-is rather
          // than failed over, preserving the upstream's error surface.
          return withModelHeader(failedBodyResponse(response, error), selector, this.brandContext());
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
        const envelopeError = errorEnvelopeMessage(payload);
        if (envelopeError !== undefined) {
          // A 200 carrying an OpenAI error envelope is a failed attempt, not
          // an answer: fail over like any other retryable upstream failure.
          // The message gets the same redaction pass as other failover
          // reasons, since failover reasons are handed back to the client in
          // the final 503. An envelope whose error code, status, or type is 429 gets
          // the same 429 cooldown as a real 429 response; without it the chain
          // would advance immediately after a rate limit.
          const rateLimited = envelopeStatus(payload) === 429;
          const retryAfter = rateLimited ? retryAfterMs(response.headers) : undefined;
          failures.push({
            model: selector,
            reason: withRetryAfterNote(
              upstreamReason(200, undefined, redactDiagnostics(envelopeError)),
              retryAfter,
            ),
          });
          if (rateLimited && hasNext) await this.failoverBackoff(signal, retryAfter);
          continue;
        }
        const content = chatCompletionHasContent(payload);
        if (content === false) {
          failures.push({ model: selector, reason: "upstream returned 200 with empty content" });
          continue;
        }
        return answered(new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }), selector);
      }
      // A 2xx whose body is neither JSON nor an SSE stream is not a chat
      // answer: gateways sometimes hand back an HTML error page (WAF blocks,
      // captive portals, misconfigured proxies) with a 200, and relaying it
      // would mark the attempt as answered. A missing content-type cannot be
      // classified, so it still relays; a present-but-wrong one fails over.
      const mediaType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (mediaType !== "" && !mediaType.includes("json") && !mediaType.includes("text/event-stream")) {
        failures.push({
          model: selector,
          reason: `upstream returned ${status} with a non-completion body (content-type: ${response.headers.get("content-type")})`,
        });
        continue;
      }
      return answered(response, selector);
    }
    if (this.brand) {
      return structuredError(`${this.brand.name} is busy right now. Try again in a moment.`, 503, "all_models_failed", "api_error");
    }
    return allModelsFailedResponse(failures);
  }

  private async complete(request: ChatRequest, signal: AbortSignal, task?: Task): Promise<Response> {
    const parsed = modelSelector(request.model);
    if (!parsed.auto && (!parsed.backendId || !parsed.id)) {
      if (this.brand) return this.complete({ ...request, model: "auto" }, signal, task);
      return structuredError("Model must use auto or backend/model syntax", 400, "invalid_model");
    }
    if (parsed.auto) {
      const chain = await this.resolveChain(signal);
      if (chain.length === 0 && this.catalog) {
        return structuredError(
          this.privateMode
            ? "No models are available in Private mode. Add a provider key, or turn Private mode off to use free models."
            : "No models are available right now. Try again shortly.",
          503,
          "no_models_available",
          "api_error",
        );
      }
      if (chain.length === 0) {
        // No usable chain: resolve the primary for a precise 404/503.
        const route = await this.resolveExplicit(this.primaryModel, signal);
        if (route instanceof Response) return route;
        return this.completeWithFailover(request, [route], signal);
      }
      const routes = this.routesForTask(task, chain);
      if (task === "ack") return this.completeAck(request, routes, signal);
      return this.completeWithFailover(request, routes, signal);
    }
    const selector = request.model.trim();
    const route = await this.resolveExplicit(selector, signal);
    if (route instanceof Response) {
      // Product mode has one public model: anything else a client sends is auto.
      if (this.brand) return this.complete({ ...request, model: "auto" }, signal, task);
      return route;
    }
    const first = modelSelectorId(route.model);
    const rest = (await this.resolveChain(signal)).filter((candidate) => modelSelectorId(candidate.model) !== first);
    // Pinned model on a backend that is out of free quota: go straight to the
    // next best free model, keeping the pinned one as a last resort.
    if (this.catalog?.exhaustedBackends().includes(route.model.backend)) {
      return this.completeWithFailover(request, [...rest, route], signal);
    }
    return this.completeWithFailover(request, [route, ...rest], signal);
  }

  async handle(request: Request, clientAddress?: string): Promise<Response> {
    const receivedAt = Date.now();
    if (this.apiKey && !constantTimeEqual(requestApiKey(request) ?? "", this.apiKey)) {
      return structuredError("Invalid API key", 401, "invalid_api_key", "authentication_error");
    }
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/warm") {
      this.warm();
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname === "/v1/feedback") {
      if (clientAddress !== undefined && !isLoopbackAddress(clientAddress)) {
        return structuredError("Feedback is only accepted from this machine", 403, "forbidden", "permission_error");
      }
      if (!this.feedbackEnabled) return new Response(null, { status: 204 });
      const body = await readBody(request, 4_096, request.signal);
      if (body instanceof Response) return body;
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return structuredError("Feedback must be JSON", 400, "invalid_feedback");
      }
      const item = isRecord(payload) ? payload : {};
      const requestId = typeof item.request_id === "string" ? item.request_id : "";
      const outcome = typeof item.outcome === "string" ? item.outcome : "";
      if (item.v !== 1 || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId) || !(OUTCOMES as readonly string[]).includes(outcome)
        || (item.task !== undefined && !(TASKS as readonly string[]).includes(String(item.task)))) {
        return structuredError("Invalid feedback", 400, "invalid_feedback");
      }
      this.feedback.record(requestId, outcome as Outcome);
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      const timeout = deadline(request.signal, this.timeoutMs);
      try {
        const backends = await this.health(timeout.signal);
        if (this.brand) {
          const usable = this.catalog ? this.catalog.ranked(this.backendPriority).length : 0;
          const ok = usable > 0 && backends.some((backend) => backend.healthy);
          return json({
            ok,
            status: ok ? "ok" : "degraded",
            checkedAt: new Date().toISOString(),
            api: API_VERSION,
            tasks: [...TASKS],
            feedback: this.feedbackEnabled,
            model: { id: this.brand.id, name: this.brand.name, available: usable > 0 },
            privateMode: this.privateMode,
            refreshedAt: this.catalog?.refreshedAt ?? null,
          });
        }
        const ok = backends.length > 0 && backends.every((backend) => backend.healthy);
        return json({
          ok,
          status: ok ? "ok" : "degraded",
          checkedAt: new Date().toISOString(),
          api: API_VERSION,
          tasks: [...TASKS],
          feedback: this.feedbackEnabled,
          backends,
          ...(this.catalog
            ? {
              catalog: {
                refreshedAt: this.catalog.refreshedAt ?? null,
                lastRefreshError: this.catalog.lastRefreshError ? redactDiagnostics(this.catalog.lastRefreshError) : null,
                privateMode: this.privateMode,
                models: this.catalog.entries().length,
                visible: this.catalog.ranked(this.backendPriority).length,
              },
            }
            : {}),
        });
      } finally {
        timeout.dispose();
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/models/refresh") {
      if (!this.catalog) return structuredError("Model catalog is not enabled", 404, "not_found");
      if (clientAddress !== undefined && !isLoopbackAddress(clientAddress)) {
        return structuredError("Refresh is only allowed from this machine", 403, "forbidden", "permission_error");
      }
      try {
        const summary = await this.refreshCatalog(request.signal);
        if (this.brand && summary) return json({ ok: true, refreshedAt: summary.refreshedAt, available: summary.visible > 0 });
        return json({ ok: true, ...summary });
      } catch (error) {
        if (isAbort(error)) return structuredError("Refresh cancelled", 504, "timeout", "api_error");
        return structuredError("Model refresh failed", 502, "refresh_failed", "api_error");
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      const timeout = deadline(request.signal, this.timeoutMs);
      try {
        const models = await this.models(timeout.signal);
        if (this.brand) {
          return json({
            object: "list",
            data: [{
              id: this.brand.id,
              object: "model",
              name: this.brand.name,
              owned_by: "dani",
              capabilities: [...new Set(models.flatMap((model) => model.capabilities))],
              contextWindow: Math.max(0, ...models.map((model) => model.contextWindow)),
              maxTokens: Math.max(0, ...models.map((model) => model.maxTokens)),
              healthy: models.length > 0,
              default: true,
            }],
          });
        }
        if (!this.catalog) return json({ object: "list", data: models.map(publicModel) });
        const catalog = this.catalog;
        const auto = {
          id: "auto",
          object: "model",
          name: "Auto",
          capabilities: [...new Set(models.flatMap((model) => model.capabilities))],
          contextWindow: Math.max(0, ...models.map((model) => model.contextWindow)),
          maxTokens: Math.max(0, ...models.map((model) => model.maxTokens)),
          healthy: models.length > 0,
          default: true,
        };
        return json({
          object: "list",
          refreshedAt: catalog.refreshedAt ?? null,
          data: [auto, ...models.map((model) => {
            const entry = catalog.get(modelSelectorId(model));
            return { ...publicModel(model), new: entry ? catalog.isNew(entry) : false };
          })],
        });
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
        const task = parseTask(request.headers.get(TASK_HEADER));
        if (task === "ack") {
          if ((Array.isArray(parsed.tools) && parsed.tools.length > 0) || (parsed.tool_choice !== undefined && parsed.tool_choice !== null && parsed.tool_choice !== "none")) {
            return structuredError("Quick acknowledgments cannot use tools", 400, "tools_not_allowed");
          }
          const cap = typeof parsed.max_tokens === "number" && parsed.max_tokens > 0 ? Math.min(parsed.max_tokens, ACK_MAX_TOKENS) : ACK_MAX_TOKENS;
          parsed.max_tokens = cap;
          // Thinking first would delay (or leak into) the spoken reply. Kilo
          // honors reasoning.effort "none"; a caller's own setting wins.
          if (parsed.reasoning === undefined && parsed.reasoning_effort === undefined) parsed.reasoning = { effort: "none" };
        }
        const requestId = crypto.randomUUID().replace(/-/g, "");
        const response = await this.complete(this.brand ? withIdentity(parsed) : parsed, scope.signal, task);
        if (scope.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw abortError(scope.signal);
        }
        const selector = this.answeredBy.get(response);
        if (selector && this.feedbackEnabled) this.feedback.track(requestId, selector, task);
        const result = responseWithDeadline(response, scope);
        transferred = true;
        const headers = new Headers(result.headers);
        headers.set(REQUEST_ID_HEADER, requestId);
        const clientId = request.headers.get(CLIENT_ID_HEADER);
        if (clientId && /^[A-Za-z0-9_.:-]{1,128}$/.test(clientId)) headers.set(CLIENT_ID_HEADER, clientId);
        return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
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
