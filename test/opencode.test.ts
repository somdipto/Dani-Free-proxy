import { describe, expect, it } from "bun:test";
import { OpenCodeAdapter, OpenCodeError } from "../src/adapters/opencode";
import type { BackendModel } from "../src/types";

const BASE = "http://127.0.0.1:4187";

const PROVIDERS_PAYLOAD = {
  providers: [
    {
      id: "opencode",
      name: "OpenCode Zen",
      models: {
        "nemotron-3-ultra-free": {
          id: "nemotron-3-ultra-free",
          name: "Nemotron 3 Ultra Free",
          capabilities: { temperature: true, reasoning: true, input: { text: true, image: false } },
          limit: { context: 1_000_000, output: 128_000 },
          status: "active",
        },
        "muse-spark-1.3-contributor-free": {
          id: "muse-spark-1.3-contributor-free",
          name: "Muse Spark 1.3 Free",
          capabilities: { temperature: true, reasoning: true, input: { text: true, image: true } },
          limit: { context: 1_048_576, output: 131_072 },
          status: "active",
        },
        "big-pickle": {
          id: "big-pickle",
          name: "Big Pickle",
          capabilities: { input: { text: true, image: false } },
          limit: { context: 200_000, output: 65_536 },
          status: "active",
        },
        "some-paid-model": {
          id: "some-paid-model",
          name: "Paid",
          capabilities: { input: { text: true, image: true } },
          limit: { context: 8_000, output: 4_000 },
          status: "active",
        },
      },
    },
    { id: "other", models: {} },
  ],
};

const MESSAGE_PAYLOAD = {
  info: { role: "assistant", cost: 0, modelID: "nemotron-3-ultra-free" },
  parts: [
    { type: "step-start", id: "prt_1" },
    { type: "reasoning", text: "thinking" },
    { type: "text", text: "PROXY_PROBE_OK" },
    { type: "step-finish", reason: "stop" },
  ],
  finish: "stop",
  tokens: { total: 30, input: 20, output: 10, reasoning: 5, cache: { write: 0, read: 0 } },
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  signal: AbortSignal | null | undefined;
}

function makeStub(handlers: {
  onMessage?: (call: RecordedCall) => Promise<Response> | Response;
  messagePayload?: unknown;
} = {}) {
  const calls: RecordedCall[] = [];
  const stub = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = input.toString();
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: (init.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
      signal: init.signal ?? null,
    });
    const path = new URL(url).pathname;
    if (path === "/config/providers" && init.method !== "POST") return Response.json(PROVIDERS_PAYLOAD);
    if (path === "/global/health") return Response.json({ healthy: true, version: "1.18.31" });
    if (path === "/session" && (init.method ?? "GET").toUpperCase() === "POST") {
      return Response.json({ id: "ses_test" });
    }
    if (path === "/session/ses_test/message" && (init.method ?? "GET").toUpperCase() === "POST") {
      if (handlers.onMessage) return handlers.onMessage(calls[calls.length - 1]);
      return Response.json(handlers.messagePayload ?? MESSAGE_PAYLOAD);
    }
    if (path === "/session/ses_test/abort") return new Response("{}", { status: 200 });
    if (path === "/session/ses_test" && (init.method ?? "GET").toUpperCase() === "DELETE") {
      return new Response("{}", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return { stub: stub as unknown as typeof fetch, calls };
}

function testModel(): BackendModel {
  return {
    id: "opencode/nemotron-3-ultra-free",
    backend: "opencode",
    name: "Nemotron 3 Ultra Free",
    capabilities: ["text", "tools", "reasoning"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    healthy: true,
    source: "static",
  };
}

function sseTexts(sse: string): string {
  return sse
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => line.slice("data: ".length))
    .join("\n");
}

describe("OpenCodeAdapter", () => {
  it("discovers free models with declared capabilities only", async () => {
    const { stub } = makeStub();
    const adapter = new OpenCodeAdapter({ baseUrl: BASE, apiKey: "", fetch: stub });
    const models = await adapter.listModels();
    const ids = models.map((model) => model.id).sort();
    expect(ids).toEqual([
      "opencode/big-pickle",
      "opencode/muse-spark-1.3-contributor-free",
      "opencode/nemotron-3-ultra-free",
    ]);
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("opencode/nemotron-3-ultra-free")?.capabilities).toEqual(["text", "tools", "reasoning"]);
    expect(byId.get("opencode/muse-spark-1.3-contributor-free")?.capabilities).toEqual([
      "text",
      "tools",
      "reasoning",
      "image",
    ]);
    expect(byId.get("opencode/big-pickle")?.capabilities).toEqual(["text", "tools", "reasoning"]);
    expect(byId.get("opencode/nemotron-3-ultra-free")?.contextWindow).toBe(1_000_000);
    expect(byId.get("opencode/nemotron-3-ultra-free")?.maxTokens).toBe(128_000);
    expect(byId.get("opencode/big-pickle")?.name).toBe("Big Pickle");
    expect(models.every((model) => model.healthy)).toBe(true);
    expect(models.every((model) => model.source === "discovered")).toBe(true);
  });

  it("completes via the session API and returns valid OpenAI SSE", async () => {
    const { stub, calls } = makeStub();
    const adapter = new OpenCodeAdapter({ baseUrl: BASE, apiKey: "", fetch: stub });
    const controller = new AbortController();
    const response = await adapter.complete(
      {
        model: "opencode/nemotron-3-ultra-free",
        stream: true,
        messages: [
          { role: "system", content: "You are a test." },
          { role: "system", content: "Be brief." },
          { role: "user", content: "Reply with exactly: hello" },
          { role: "assistant", content: "saying hi" },
          { role: "tool", content: { ok: true } },
        ],
      },
      testModel(),
      controller.signal,
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const sse = await response.text();
    expect(sse).toContain('"content":"PROXY_PROBE_OK"');
    expect(sse.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // every data line parses as JSON and the stop chunk carries usage
    for (const line of sseTexts(sse).split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(sse).toContain('"prompt_tokens":20');

    const createCall = calls.find((call) => call.url.endsWith("/session") && call.method === "POST");
    expect(createCall).toBeDefined();
    const createBody = JSON.parse(createCall!.body!);
    expect(createBody.model.providerID).toBe("opencode");
    expect(createBody.model.modelID).toBe("nemotron-3-ultra-free");
    expect(createBody.title).toBe("dani-free");

    const messageCall = calls.find((call) => call.url.endsWith("/session/ses_test/message"));
    expect(messageCall).toBeDefined();
    const messageBody = JSON.parse(messageCall!.body!);
    expect(messageBody.system).toBe("You are a test.\n\nBe brief.");
    const texts = messageBody.parts.map((part: { text: string }) => part.text);
    expect(texts).toEqual([
      "user: Reply with exactly: hello",
      "assistant: saying hi",
      'tool: {"ok":true}',
    ]);

    // no auth header when no key is configured
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBeNull();
    }
    // session cleaned up
    expect(calls.some((call) => call.url.endsWith("/session/ses_test") && call.method === "DELETE")).toBe(true);
  });

  it("returns a single application/json chat.completion object when stream is false", async () => {
    const { stub } = makeStub();
    const adapter = new OpenCodeAdapter({ baseUrl: BASE, apiKey: "", fetch: stub });
    const response = await adapter.complete(
      {
        model: "opencode/nemotron-3-ultra-free",
        stream: false,
        messages: [{ role: "user", content: "Reply with exactly: hello" }],
      },
      testModel(),
      new AbortController().signal,
    );

    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("opencode/nemotron-3-ultra-free");
    const choices = body.choices as Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
    expect(choices).toHaveLength(1);
    expect(choices[0].message).toEqual({ role: "assistant", content: "PROXY_PROBE_OK" });
    expect(choices[0].finish_reason).toBe("stop");
    const usage = body.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(20);
    expect(usage.completion_tokens).toBe(10);
    expect(usage.total_tokens).toBe(30);
  });

  it("defaults to JSON (not SSE) when stream is absent", async () => {
    const { stub } = makeStub();
    const adapter = new OpenCodeAdapter({ baseUrl: BASE, apiKey: "", fetch: stub });
    const response = await adapter.complete(
      {
        model: "opencode/nemotron-3-ultra-free",
        messages: [{ role: "user", content: "hi" }],
      },
      testModel(),
      new AbortController().signal,
    );

    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    expect((body.choices as Array<{ message: { content: string } }>)[0].message.content).toBe(
      "PROXY_PROBE_OK",
    );
  });

  it("sends Basic auth opencode:<key> when a sidecar password is configured", async () => {
    const { stub, calls } = makeStub();
    const adapter = new OpenCodeAdapter({ baseUrl: BASE, apiKey: "test-key", fetch: stub });
    await adapter.complete(
      { model: "opencode/nemotron-3-ultra-free", messages: [{ role: "user", content: "hi" }] },
      testModel(),
      new AbortController().signal,
    );
    const expected = `Basic ${Buffer.from("opencode:test-key", "utf8").toString("base64")}`;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe(expected);
    }
  });

  it("throws instead of returning empty prose when the turn has no text", async () => {
    const { stub } = makeStub({
      messagePayload: { parts: [{ type: "step-finish", reason: "stop" }], finish: "stop" },
    });
    const adapter = new OpenCodeAdapter({ baseUrl: BASE, apiKey: "", fetch: stub });
    const error = await adapter
      .complete(
        { model: "opencode/nemotron-3-ultra-free", messages: [{ role: "user", content: "hi" }] },
        testModel(),
        new AbortController().signal,
      )
      .then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(OpenCodeError);
    expect((error as OpenCodeError).message).toBe("model produced no text output");
    expect((error as OpenCodeError).status).toBe(502);
  });

  it("aborts the turn and cleans up the session on cancellation", async () => {
    const { stub, calls } = makeStub({
      onMessage: (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    const adapter = new OpenCodeAdapter({ baseUrl: BASE, apiKey: "", fetch: stub });
    const controller = new AbortController();
    const pending = adapter.complete(
      { model: "opencode/nemotron-3-ultra-free", messages: [{ role: "user", content: "hi" }] },
      testModel(),
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const error = await pending.then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(
      calls.some((call) => call.url.endsWith("/session/ses_test/abort") && call.method === "POST"),
    ).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/session/ses_test") && call.method === "DELETE")).toBe(true);
  });

  it("reports unhealthy with a truthful reason when the sidecar is unreachable", async () => {
    const failing = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const adapter = new OpenCodeAdapter({ baseUrl: BASE, apiKey: "", fetch: failing });
    const health = await adapter.health();
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain("opencode serve not reachable at http://127.0.0.1:4187");
    expect(health.reason).toContain("opencode serve --port 4187");
  });

  it("reports healthy when /global/health is ok and the provider is listed", async () => {
    const { stub } = makeStub();
    const adapter = new OpenCodeAdapter({ baseUrl: BASE, apiKey: "", fetch: stub });
    const health = await adapter.health();
    expect(health.healthy).toBe(true);
    expect(health.configured).toBe(true);
    expect(health.reason).toBeUndefined();
  });
});
