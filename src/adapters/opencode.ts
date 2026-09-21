import type {
  BackendAdapter,
  BackendHealth,
  BackendModel,
  Capability,
  ChatRequest,
} from "../types.ts";

const BACKEND = "opencode" as const;

type UnknownRecord = Record<string, unknown>;

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

function rawModelId(id: string): string {
  if (id.startsWith("opencode/")) return id.slice("opencode/".length);
  if (id.startsWith("opencode:")) return id.slice("opencode:".length);
  return id;
}

function normalizedModelId(id: string): string {
  return `opencode/${rawModelId(id)}`;
}

function stringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase()));
}

function modelCapabilities(record: UnknownRecord): Capability[] {
  const capabilities: Capability[] = ["text"];
  const advertised = new Set([
    ...stringSet(record.capabilities),
    ...stringSet(record.modalities),
    ...stringSet(record.input_modalities),
    ...stringSet(record.inputModalities),
  ]);
  if (advertised.has("tools") || advertised.has("tool") || advertised.has("function_calling")) capabilities.push("tools");
  if (advertised.has("reasoning")) capabilities.push("reasoning");
  const supportsImages =
    record.supports_images === true ||
    record.supportsImages === true ||
    record.vision === true ||
    advertised.has("image") ||
    advertised.has("images") ||
    advertised.has("vision");
  if (supportsImages) capabilities.push("image");
  return capabilities;
}

function modelsFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  return [];
}

function joinUrl(baseUrl: URL, path: string): URL {
  const url = new URL(baseUrl.toString());
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${basePath}${path}` || "/";
  url.search = "";
  return url;
}

function rootHealthUrl(baseUrl: URL): URL {
  const url = new URL(baseUrl.toString());
  const path = url.pathname.replace(/\/+$/, "");
  const rootPath = path === "/v1" || path.endsWith("/v1") ? path.slice(0, -3).replace(/\/+$/, "") : path;
  url.pathname = `${rootPath}/health` || "/health";
  url.search = "";
  return url;
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "request failed";
}

export class OpenCodeAdapter implements BackendAdapter {
  readonly id = BACKEND;
  private readonly baseUrl: URL | null;
  private readonly apiKey: string | undefined;

  constructor(options?: { baseUrl?: string; apiKey?: string }) {
    const configuredBase = options?.baseUrl ?? process.env.DANI_FREE_OPENCODE_BASE_URL;
    if (!configuredBase) {
      this.baseUrl = null;
    } else {
      try {
        const parsed = new URL(configuredBase.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported URL scheme");
        parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
        parsed.search = "";
        parsed.hash = "";
        this.baseUrl = parsed;
      } catch {
        this.baseUrl = null;
      }
    }

    const configuredKey = options?.apiKey ?? process.env.DANI_FREE_OPENCODE_API_KEY;
    this.apiKey = configuredKey?.trim() || undefined;
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<BackendModel[]> {
    if (!this.baseUrl) return [];

    let response: Response;
    try {
      response = await fetch(joinUrl(this.baseUrl, "/models"), {
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
      payload = await response.json();
    } catch {
      return [];
    }

    const models: BackendModel[] = [];
    for (const value of modelsFromPayload(payload)) {
      if (!isRecord(value) || typeof value.id !== "string" || value.id.trim() === "") continue;
      const upstreamId = rawModelId(value.id.trim());
      const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : upstreamId;
      const limits = isRecord(value.limits) ? value.limits : undefined;
      const limit = isRecord(value.limit) ? value.limit : undefined;
      models.push({
        id: normalizedModelId(value.id.trim()),
        backend: BACKEND,
        name,
        capabilities: modelCapabilities(value),
        contextWindow: asPositiveNumber(
          value.context_window,
          value.contextWindow,
          value.max_context,
          limits?.context,
          limit?.context,
        ),
        maxTokens: asPositiveNumber(
          value.max_tokens,
          value.maxTokens,
          value.max_output_tokens,
          value.output_limit,
          limits?.output,
          limit?.output,
        ),
        healthy: true,
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

    const startedAt = performance.now();
    let response: Response | undefined;
    let lastError: unknown;
    const urls = [rootHealthUrl(this.baseUrl), joinUrl(this.baseUrl, "/health")];
    const visited = new Set<string>();

    for (const url of urls) {
      if (visited.has(url.toString())) continue;
      visited.add(url.toString());
      try {
        response = await fetch(url, { method: "GET", headers: this.headers(), signal });
        if (response.status !== 404) break;
      } catch (error) {
        lastError = error;
        break;
      }
    }

    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (!response) {
      return {
        backend: BACKEND,
        configured: true,
        healthy: false,
        checkedAt,
        latencyMs,
        reason: errorReason(lastError),
      };
    }

    let payload: unknown;
    try {
      payload = await response.clone().json();
    } catch {
      payload = undefined;
    }
    const status = isRecord(payload) && typeof payload.status === "string" ? payload.status.toLowerCase() : undefined;
    const upstreamOk = isRecord(payload) && typeof payload.upstream_ok === "boolean" ? payload.upstream_ok : undefined;
    const healthy = response.ok && status !== "error" && upstreamOk !== false;

    return {
      backend: BACKEND,
      configured: true,
      healthy,
      checkedAt,
      latencyMs,
      ...(healthy ? {} : { reason: `health endpoint returned ${response.status}` }),
    };
  }

  async complete(request: ChatRequest, model: BackendModel, signal: AbortSignal): Promise<Response> {
    if (!this.baseUrl) throw new Error("OpenCode backend is not configured");

    const body: ChatRequest = {
      ...request,
      model: rawModelId(model.id),
    };
    const headers = new Headers(this.headers());
    headers.set("Content-Type", "application/json");
    return fetch(joinUrl(this.baseUrl, "/chat/completions"), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }
}
