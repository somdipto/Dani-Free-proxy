import type {
  BackendAdapter,
  BackendHealth,
  BackendModel,
  ChatRequest,
} from "../types.ts";

const BACKEND_ID = "mimo" as const;
const DEFAULT_CONTEXT_WINDOW = 0;
const DEFAULT_MAX_TOKENS = 0;

type MimoProtocol = "openai" | "opencode";

/**
 * MiMo Code's CLI is an interactive terminal client. We must not guess
 * command-line flags for a machine transport. Use DANI_FREE_MIMO_PROTOCOL=opencode
 * only with the verified `mimo serve` HTTP API, or configure an OpenAI-compatible
 * endpoint explicitly.
 */
const CLI_UNAVAILABLE_REASON =
  "MiMo Code CLI transport is unavailable: its command protocol and flags are not verified; configure DANI_FREE_MIMO_BASE_URL for a verified HTTP endpoint";
const UNKNOWN_PROTOCOL_REASON =
  "MiMo Code transport is unavailable: DANI_FREE_MIMO_PROTOCOL must be openai or opencode";

function environment(name: string): string | undefined {
  const value = Bun.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function configuredBaseUrl(): string | undefined {
  const value = environment("DANI_FREE_MIMO_BASE_URL");
  if (!value) return undefined;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return value.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function configuredProtocol(): MimoProtocol | undefined {
  const value = environment("DANI_FREE_MIMO_PROTOCOL")?.toLowerCase();
  if (!value) return "openai";
  if (value === "openai") return "openai";
  if (value === "opencode") return "opencode";
  return undefined;
}

function commandPort(): number | undefined {
  const value = environment("DANI_FREE_MIMO_SERVE_PORT");
  if (!value) return 4191;
  const port = Number(value);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  return undefined;
}
/**
 * MiMo's official /provider response contains the full catalog in `all`,
 * including providers that are not the free channel. Advertise only the
 * explicit allowlist; the default is the official free provider `mimo`.
 */
function allowedProviderIds(): Set<string> {
  const value = environment("DANI_FREE_MIMO_PROVIDERS") ?? "mimo";
  return new Set(value.split(",").map((provider) => provider.trim()).filter(Boolean));
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl}/${path}`;
}

function headers(): HeadersInit {
  const result: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const apiKey = environment("DANI_FREE_MIMO_API_KEY");
  if (apiKey) {
    result.Authorization = /^Bearer\s+/i.test(apiKey)
      ? apiKey
      : `Bearer ${apiKey}`;
  }
  return result;
}

function numberField(record: Record<string, unknown>, ...names: string[]): number {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return 0;
}

function modelFromRecord(value: unknown): BackendModel | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return undefined;

  const name =
    typeof record.name === "string" && record.name.trim().length > 0
      ? record.name
      : id;
  const capabilities: BackendModel["capabilities"] = ["text"];
  if (record.vision === true || record.image === true) capabilities.push("image");
  if (record.tools === true || record.tool_use === true) capabilities.push("tools");
  if (record.reasoning === true || record.reasoning_content === true) {
    capabilities.push("reasoning");
  }

  return {
    id,
    backend: BACKEND_ID,
    name,
    capabilities,
    contextWindow: numberField(
      record,
      "context_window",
      "contextWindow",
      "max_context_length",
    ) || DEFAULT_CONTEXT_WINDOW,
    maxTokens: numberField(record, "max_tokens", "maxTokens") || DEFAULT_MAX_TOKENS,
    healthy: true,
    source: "discovered",
  };
}

function messageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null && "text" in part) {
          return typeof part.text === "string" ? part.text : "";
        }
        return "";
      })
      .filter((part) => part.length > 0)
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

function opencodeModelRef(modelID: string): { providerID: string; modelID: string } {
  const raw = modelID.startsWith(`${BACKEND_ID}/`)
    ? modelID.slice(`${BACKEND_ID}/`.length)
    : modelID;
  const separator = raw.indexOf("/");
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error(
      `MiMo OpenCode model ID must use provider/model syntax: ${modelID}`,
    );
  }
  return {
    providerID: raw.slice(0, separator),
    modelID: raw.slice(separator + 1),
  };

}
type OwnedProcess = {
  kill(): void;
  unref?(): void;
};

/**
 * The route and payload shapes below are from Xiaomi's official @mimo-ai/sdk
 * 0.1.14 (github.com/XiaomiMiMo/MiMo-Code, packages/sdk/js): GET /provider,
 * POST /session, POST /session/{id}/message, and DELETE /session/{id}.
 * The prompt body uses model { providerID, modelID }, agent, and text parts.
 */
export default class MimoAdapter implements BackendAdapter {
  readonly id = BACKEND_ID;

  private commandProcess?: OwnedProcess;
  private commandBaseUrl?: string;
  private commandStart?: Promise<string>;

  private async commandServerBase(signal?: AbortSignal): Promise<string> {
    if (this.commandBaseUrl) return this.commandBaseUrl;
    const command = environment("DANI_FREE_MIMO_COMMAND");
    const port = commandPort();
    if (!command) throw new Error(CLI_UNAVAILABLE_REASON);
    if (!port) {
      throw new Error(
        "MiMo Code command mode is unavailable: DANI_FREE_MIMO_SERVE_PORT must be an integer from 1 to 65535",
      );
    }
    if (this.commandStart) return this.commandStart;

    const startup = this.startCommandServer(command, port, signal);
    this.commandStart = startup;
    try {
      return await startup;
    } finally {
      if (this.commandStart === startup) this.commandStart = undefined;
    }
  }

  private async startCommandServer(
    command: string,
    port: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const baseUrl = `http://127.0.0.1:${port}`;
    let child: OwnedProcess;
    try {
      child = Bun.spawn(
        [
          command,
          "serve",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
          "--pure",
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
    } catch (error) {
      throw new Error(
        `MiMo Code command mode could not start ${command}: ${
          error instanceof Error ? error.message : "spawn failed"
        }`,
      );
    }
    this.commandProcess = child;
    child.unref?.();
    this.commandBaseUrl = baseUrl;
    process.once("exit", () => child.kill());

    try {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        const probe = new AbortController();
        const timer = setTimeout(() => probe.abort(), 500);
        const onAbort = () => probe.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const response = await fetch(endpoint(baseUrl, "provider"), {
            method: "GET",
            headers: headers(),
            signal: probe.signal,
          });
          await response.body?.cancel();
          if (signal?.aborted) {
            throw new DOMException("The operation was aborted", "AbortError");
          }
          return baseUrl;
        } catch (error) {
          if (signal?.aborted) throw error;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
        await Bun.sleep(100);
      }
      throw new Error(
        `MiMo Code command mode did not become ready at ${baseUrl}; check the installed CLI and authentication`,
      );
    } catch (error) {
      child.kill();
      this.commandProcess = undefined;
      this.commandBaseUrl = undefined;
      throw error;
    }
  }
  async listModels(signal?: AbortSignal): Promise<BackendModel[]> {
    const explicitBaseUrl = configuredBaseUrl();
    const baseConfigured = environment("DANI_FREE_MIMO_BASE_URL") !== undefined;
    const commandMode = !baseConfigured && environment("DANI_FREE_MIMO_COMMAND") !== undefined;
    if (baseConfigured && !explicitBaseUrl) {
      throw new Error("MiMo Code is unavailable: DANI_FREE_MIMO_BASE_URL is not a valid HTTP(S) URL");
    }
    const baseUrl = explicitBaseUrl ?? (commandMode ? await this.commandServerBase(signal) : undefined);
    const protocol = baseConfigured
      ? configuredProtocol()
      : commandMode
        ? "opencode"
        : configuredProtocol();
    if (!baseUrl) return [];
    if (!protocol) throw new Error(UNKNOWN_PROTOCOL_REASON);
    if (protocol === "opencode") {
      return this.listOpenCodeModels(baseUrl, signal);
    }

    const response = await fetch(endpoint(baseUrl, "models"), {
      method: "GET",
      headers: headers(),
      signal,
    });
    if (!response.ok) {
      throw new Error(`MiMo Code model discovery failed with HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("MiMo Code model discovery returned invalid JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("MiMo Code model discovery returned an invalid OpenAI response");
    }
    const data = "data" in body ? body.data : undefined;
    if (!Array.isArray(data)) {
      throw new Error("MiMo Code model discovery returned an invalid OpenAI response");
    }

    const models: BackendModel[] = [];
    for (const entry of data) {
      const model = modelFromRecord(entry);
      if (model) models.push(model);
    }
    return models;
  }

  private async listOpenCodeModels(
    baseUrl: string,
    signal?: AbortSignal,
  ): Promise<BackendModel[]> {
    const response = await fetch(endpoint(baseUrl, "provider"), {
      method: "GET",
      headers: headers(),
      signal,
    });
    if (!response.ok) {
      throw new Error(`MiMo OpenCode provider discovery failed with HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("MiMo OpenCode provider discovery returned invalid JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("MiMo OpenCode provider discovery returned an invalid response");
    }
    const all = "all" in body ? body.all : undefined;
    const connected = "connected" in body ? body.connected : undefined;
    if (!Array.isArray(all) || !Array.isArray(connected)) {
      throw new Error("MiMo OpenCode provider discovery returned an invalid response");
    }
    const connectedIDs = new Set(
      connected.filter((value): value is string => typeof value === "string"),
    );
    const allowedProviders = allowedProviderIds();

    const models: BackendModel[] = [];
    for (const provider of all) {
      if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
        continue;
      }
      const providerRecord = provider as Record<string, unknown>;
      const providerID = typeof providerRecord.id === "string" ? providerRecord.id : "";
      if (!allowedProviders.has(providerID)) continue;
      if (!providerID) continue;
      const providerName =
        typeof providerRecord.name === "string" ? providerRecord.name : providerID;
      const providerModels = providerRecord.models;
      if (
        typeof providerModels !== "object" ||
        providerModels === null ||
        Array.isArray(providerModels)
      ) {
        continue;
      }
      for (const [modelKey, value] of Object.entries(providerModels)) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const modelRecord = value as Record<string, unknown>;
        const modelID =
          typeof modelRecord.id === "string" && modelRecord.id.length > 0
            ? modelRecord.id
            : modelKey;
        if (!modelID) continue;
        const modelName =
          typeof modelRecord.name === "string" && modelRecord.name.length > 0
            ? modelRecord.name
            : `${providerName}/${modelID}`;
        const capabilities: BackendModel["capabilities"] = ["text"];
        if (modelRecord.attachment === true) capabilities.push("image");
        if (modelRecord.reasoning === true) capabilities.push("reasoning");
        if (modelRecord.tool_call === true) capabilities.push("tools");
        const limit = modelRecord.limit;
        const limits =
          typeof limit === "object" && limit !== null && !Array.isArray(limit)
            ? (limit as Record<string, unknown>)
            : undefined;
        models.push({
          id: `${providerID}/${modelID}`,
          backend: BACKEND_ID,
          name: modelName,
          capabilities,
          contextWindow: limits ? numberField(limits, "context") : 0,
          maxTokens: limits ? numberField(limits, "output") : 0,
          healthy: connectedIDs.has(providerID),
          source: "discovered",
        });
      }
    }
    return models;
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    const checkedAt = new Date().toISOString();
    const baseConfigured = environment("DANI_FREE_MIMO_BASE_URL") !== undefined;
    const commandConfigured = environment("DANI_FREE_MIMO_COMMAND") !== undefined;
    const protocol = baseConfigured ? configuredProtocol() : commandConfigured ? "opencode" : undefined;
    if (!baseConfigured && !commandConfigured) {
      return {
        backend: BACKEND_ID,
        configured: false,
        healthy: false,
        checkedAt,
        reason: "MiMo Code is not configured: set DANI_FREE_MIMO_BASE_URL or DANI_FREE_MIMO_COMMAND",
      };
    }
    if (!protocol) {
      return {
        backend: BACKEND_ID,
        configured: false,
        healthy: false,
        checkedAt,
        reason: UNKNOWN_PROTOCOL_REASON,
      };
    }

    const startedAt = performance.now();
    try {
      const models = await this.listModels(signal);
      if (protocol === "opencode" && models.length === 0) {
        return {
          backend: BACKEND_ID,
          configured: true,
          healthy: false,
          checkedAt,
          latencyMs: Math.round(performance.now() - startedAt),
          reason: "MiMo OpenCode has no connected models from DANI_FREE_MIMO_PROVIDERS",
        };
      }
      return {
        backend: BACKEND_ID,
        configured: true,
        healthy: true,
        checkedAt,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      return {
        backend: BACKEND_ID,
        configured: baseConfigured && configuredBaseUrl() !== undefined,
        healthy: false,
        checkedAt,
        latencyMs: Math.round(performance.now() - startedAt),
        reason: error instanceof Error ? error.message : "MiMo Code health check failed",
      };
    }
  }

  async complete(
    request: ChatRequest,
    model: BackendModel,
    signal: AbortSignal,
  ): Promise<Response> {
    const explicitBaseUrl = configuredBaseUrl();
    const baseConfigured = environment("DANI_FREE_MIMO_BASE_URL") !== undefined;
    const commandMode = !baseConfigured && environment("DANI_FREE_MIMO_COMMAND") !== undefined;
    if (baseConfigured && !explicitBaseUrl) {
      throw new Error("MiMo Code is unavailable: DANI_FREE_MIMO_BASE_URL is not a valid HTTP(S) URL");
    }
    const baseUrl = explicitBaseUrl ?? (commandMode ? await this.commandServerBase(signal) : undefined);
    const protocol = baseConfigured
      ? configuredProtocol()
      : commandMode
        ? "opencode"
        : configuredProtocol();
    if (!baseUrl) {
      throw new Error(`MiMo Code is unavailable: ${CLI_UNAVAILABLE_REASON}.`);
    }
    if (!protocol) throw new Error(UNKNOWN_PROTOCOL_REASON);
    if (protocol === "opencode") {
      return this.completeOpenCode(request, model, baseUrl, signal);
    }

    // Return fetch's Response untouched so callers retain SSE streaming and
    // can cancel the request through the supplied AbortSignal.
    return fetch(endpoint(baseUrl, "chat/completions"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ...request, model: model.id }),
      signal,
    });
  }

  private async completeOpenCode(
    request: ChatRequest,
    model: BackendModel,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const modelRef = opencodeModelRef(model.id);
    const created = await fetch(endpoint(baseUrl, "session"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "dani-free" }),
      signal,
    });
    if (!created.ok) return created;

    let session: unknown;
    try {
      session = await created.json();
    } catch {
      throw new Error("MiMo OpenCode session creation returned invalid JSON");
    }
    if (typeof session !== "object" || session === null || Array.isArray(session)) {
      throw new Error("MiMo OpenCode session creation returned an invalid response");
    }
    const sessionID = "id" in session && typeof session.id === "string" ? session.id : "";
    if (!sessionID) throw new Error("MiMo OpenCode session response did not include an ID");

    try {
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => messageContent(message.content))
        .filter((content) => content.length > 0)
        .join("\n\n");
      const parts = request.messages
        .filter((message) => message.role !== "system")
        .map((message) => {
          const content = messageContent(message.content);
          const prefix = message.role === "user" ? "" : `${message.role}: `;
          return { type: "text", text: `${prefix}${content}` };
        });
      if (parts.length === 0) parts.push({ type: "text", text: "" });
      const agent =
        environment("DANI_FREE_MIMO_AGENT") ??
        environment("DANI_FREE_MIMO_ORCHESTRATOR") ??
        "build";
      const prompt: Record<string, unknown> = {
        model: modelRef,
        agent,
        parts,
      };
      if (system) prompt.system = system;

      const messageResponse = await fetch(
        endpoint(baseUrl, `session/${encodeURIComponent(sessionID)}/message`),
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(prompt),
          signal,
        },
      );
      if (!messageResponse.ok) return messageResponse;

      let result: unknown;
      try {
        result = await messageResponse.json();
      } catch {
        throw new Error("MiMo OpenCode message response returned invalid JSON");
      }
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error("MiMo OpenCode message response returned an invalid response");
      }
      const responseParts = "parts" in result && Array.isArray(result.parts) ? result.parts : [];
      const content = responseParts
        .map((part) => {
          if (typeof part !== "object" || part === null || Array.isArray(part)) return "";
          return "type" in part && part.type === "text" && "text" in part && typeof part.text === "string"
            ? part.text
            : "";
        })
        .filter((part) => part.length > 0)
        .join("");
      const info = "info" in result && typeof result.info === "object" && result.info !== null
        ? result.info
        : undefined;
      const messageID =
        info && "id" in info && typeof info.id === "string" ? info.id : sessionID;
      const openAIResponse = {
        id: `chatcmpl-${messageID}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
      };
      return new Response(JSON.stringify(openAIResponse), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } finally {
      // The official prompt endpoint is request/response rather than SSE. Do
      // not let best-effort cleanup mask a caller cancellation or backend error.
      void fetch(endpoint(baseUrl, `session/${encodeURIComponent(sessionID)}`), {
        method: "DELETE",
        headers: headers(),
      }).catch(() => undefined);
    }
  }
}

export function createMimoAdapter(): BackendAdapter {
  return new MimoAdapter();
}
