import { describe, expect, it } from "bun:test";
import { OpenCodeError } from "../src/adapters/opencode";
import { parseToolOutput, toolInstructions } from "../src/adapters/tool-emulation";
import { ModelCatalog } from "../src/catalog";
import { createRouter, scrubUpstreamText } from "../src/router";
import type { BackendAdapter, BackendId, BackendModel, ChatRequest } from "../src/types";

function model(backend: BackendId, id: string): BackendModel {
  return { backend, id, name: `${id} name`, capabilities: ["text", "tools"], contextWindow: 100_000, maxTokens: 8_000, healthy: true, source: "discovered" } as BackendModel;
}

function completion(modelId: string, text = "hi"): Response {
  return Response.json({
    id: `chatcmpl-kilo-1`, object: "chat.completion", created: 1, model: modelId, provider: "SomeProvider",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  });
}

function fakeBackend(backend: BackendId, ids: string[], complete: (id: string) => Promise<Response>): BackendAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: backend,
    calls,
    async listModels() { return ids.map((id) => model(backend, id)); },
    async health() { return { backend, configured: true, healthy: true, checkedAt: new Date().toISOString() }; },
    async complete(request: ChatRequest, m: BackendModel) {
      calls.push(m.id);
      return complete(m.id);
    },
  } as BackendAdapter & { calls: string[] };
}

function chat(body: Partial<ChatRequest> = {}): Request {
  return new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

function clock(start = Date.parse("2026-09-25T00:00:00Z")) {
  let now = start;
  return { now: () => new Date(now), advance: (ms: number) => { now += ms; } };
}

async function setup(opencodeComplete: (id: string) => Promise<Response>, brand = true) {
  const time = clock();
  const catalog = new ModelCatalog({ now: time.now });
  const opencode = fakeBackend("opencode", ["nemotron-free", "big-pickle"], opencodeComplete);
  const kilo = fakeBackend("kilo", ["nex/pro:free"], async (id) => completion(id, "from fallback"));
  const router = createRouter({
    adapters: [opencode, kilo],
    catalog,
    probeOnRefresh: false,
    failoverBackoffMs: 1,
    ...(brand ? { brand: { id: "dani-free-auto", name: "Dani Free Auto" } } : {}),
  });
  await router.refreshCatalog();
  return { time, catalog, opencode, kilo, router };
}

describe("OpenCode primary, Kilo fallback", () => {
  it("auto uses OpenCode first", async () => {
    const { router, opencode, kilo } = await setup(async (id) => completion(id, "from primary"));
    const response = await router.handle(chat());
    expect((await response.json()).choices[0].message.content).toBe("from primary");
    expect(opencode.calls).toEqual(["nemotron-free"]);
    expect(kilo.calls).toEqual([]);
  });

  it("switches the whole OpenCode backend to Kilo when its free quota runs out, then switches back after a recovery probe", async () => {
    let quotaGone = true;
    const { router, opencode, kilo, catalog, time } = await setup(async (id) => {
      if (quotaGone) throw new OpenCodeError("OpenCode turn failed: free usage limit reached", { status: 429, code: "quota_exhausted" });
      return completion(id, "from primary");
    });
    const first = await router.handle(chat());
    expect((await first.json()).choices[0].message.content).toBe("from fallback");
    // The first quota answer holds the whole backend: big-pickle is not tried.
    expect(opencode.calls).toEqual(["nemotron-free"]);
    expect(catalog.exhaustedBackends()).toEqual(["opencode"]);

    const second = await router.handle(chat());
    expect((await second.json()).choices[0].message.content).toBe("from fallback");
    expect(opencode.calls).toEqual(["nemotron-free"]);
    expect(kilo.calls.length).toBe(2);

    // Not due yet: no probe.
    expect(await router.probeRecovery()).toEqual([]);
    time.advance(31 * 60_000);
    quotaGone = false;
    expect(await router.probeRecovery()).toEqual(["opencode"]);
    expect(catalog.exhaustedBackends()).toEqual([]);
    const third = await router.handle(chat());
    expect((await third.json()).choices[0].message.content).toBe("from primary");
  });

  it("a still-empty quota on the recovery probe extends the hold with a longer backoff", async () => {
    const { router, catalog, time } = await setup(async () => {
      throw new OpenCodeError("rate limited", { status: 429 });
    });
    await (await router.handle(chat())).text();
    const firstUntil = Date.parse(catalog.backendQuota("opencode")!.until);
    time.advance(31 * 60_000);
    expect(await router.probeRecovery()).toEqual([]);
    const quota = catalog.backendQuota("opencode")!;
    expect(quota.hits).toBe(2);
    expect(Date.parse(quota.until) - firstUntil).toBeGreaterThan(55 * 60_000);
  });

  it("honors Retry-After for the hold", async () => {
    const { router, catalog, time } = await setup(async () => {
      throw new OpenCodeError("quota", { status: 429, retryAfterMs: 3 * 60 * 60_000 });
    });
    await (await router.handle(chat())).text();
    expect(Date.parse(catalog.backendQuota("opencode")!.until) - time.now().getTime()).toBe(3 * 60 * 60_000);
  });

  it("a FreeTierError 403 from OpenCode falls over to Kilo instead of failing the request", async () => {
    const { router } = await setup(async () => {
      throw new OpenCodeError("OpenCode turn failed: free tier can only be used from within OpenCode", { status: 403, code: "free_tier_rejected" });
    });
    const response = await router.handle(chat());
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("from fallback");
  });

  it("a pinned model on a held backend goes straight to the next best free model", async () => {
    const { router, opencode, catalog } = await setup(async (id) => completion(id), false);
    catalog.recordBackendQuota("opencode", "quota");
    const response = await router.handle(chat({ model: "opencode/big-pickle" }));
    expect((await response.json()).choices[0].message.content).toBe("from fallback");
    expect(opencode.calls).toEqual([]);
  });
});

describe("Dani Free Auto branding", () => {
  it("lists only Dani Free Auto", async () => {
    const { router } = await setup(async (id) => completion(id));
    const listed = await (await router.handle(new Request("http://local/v1/models"))).json();
    expect(listed.data.map((item: { id: string; name: string }) => [item.id, item.name])).toEqual([["dani-free-auto", "Dani Free Auto"]]);
    expect(JSON.stringify(listed)).not.toMatch(/opencode|kilo|nemotron|pickle|nex/i);
  });

  it("answers as dani-free-auto with no model header, provider field or backend names", async () => {
    const { router } = await setup(async (id) => completion(id, "from primary"));
    const response = await router.handle(chat({ model: "dani-free-auto" }));
    expect(response.headers.get("x-dani-free-model")).toBeNull();
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.model).toBe("dani-free-auto");
    expect(text).not.toMatch(/opencode|kilo|nemotron|SomeProvider/i);
  });

  it("rewrites the model in every SSE frame", async () => {
    const sse = [
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "nemotron-free", choices: [{ index: 0, delta: { content: "a" } }] })}`,
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "nemotron-free", provider: "P", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const { router } = await setup(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const text = await (await router.handle(chat({ stream: true }))).text();
    expect(text).not.toContain("nemotron");
    expect(text).not.toContain('"provider"');
    expect(text.match(/"model":"dani-free-auto"/g)?.length).toBe(2);
    expect(text).toContain("data: [DONE]");
  });

  it("an unknown model name is treated as auto, and total failure never names a model", async () => {
    const time = clock();
    const catalog = new ModelCatalog({ now: time.now });
    const failing = fakeBackend("kilo", ["nex/pro:free"], async () => { throw new OpenCodeError("kilo nex/pro:free exploded", { status: 500 }); });
    const router = createRouter({ adapters: [failing], catalog, probeOnRefresh: false, failoverBackoffMs: 1, brand: { id: "dani-free-auto", name: "Dani Free Auto" } });
    await router.refreshCatalog();
    const response = await router.handle(chat({ model: "gpt-4o" }));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("Dani Free Auto");
    expect(text).not.toMatch(/kilo|nex/i);
  });

  it("/health does not list backends", async () => {
    const { router } = await setup(async (id) => completion(id));
    const health = await (await router.handle(new Request("http://local/health"))).json();
    expect(health.backends).toBeUndefined();
    expect(health.model).toEqual({ id: "dani-free-auto", name: "Dani Free Auto", available: true });
    expect(JSON.stringify(health)).not.toMatch(/opencode|kilo/i);
  });

  it("scrubs backend names and model ids from passthrough messages", () => {
    expect(scrubUpstreamText("OpenCode Zen said nemotron-free is over context", ["nemotron-free"])).toBe("upstream said model is over context");
  });
});

describe("text tool protocol", () => {
  const tools = [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
  const request = { model: "x", messages: [], tools } as unknown as ChatRequest;

  it("describes the host tools and switches off the built-in ones", () => {
    const text = toolInstructions(request);
    expect(text).toContain("## read_file");
    expect(text).toContain("<tool_call>");
    expect(text).toContain("switched off");
    expect(toolInstructions({ ...request, tool_choice: "none" })).toBe("");
  });

  it("parses tagged calls into OpenAI tool_calls and keeps leading text", () => {
    const parsed = parseToolOutput('Let me look.\n<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>', request);
    expect(parsed.content).toBe("Let me look.");
    expect(parsed.toolCalls.map((call) => [call.function.name, JSON.parse(call.function.arguments)])).toEqual([["read_file", { path: "a.ts" }]]);
  });

  it("ignores calls to tools the request did not offer", () => {
    const parsed = parseToolOutput('<tool_call>{"name": "bash", "arguments": {"cmd": "rm -rf /"}}</tool_call>', request);
    expect(parsed.toolCalls).toEqual([]);
  });

  it("accepts a fenced JSON call as a fallback", () => {
    const parsed = parseToolOutput('```json\n{"name": "read_file", "arguments": {"path": "b"}}\n```', request);
    expect(parsed.toolCalls.length).toBe(1);
  });
});

describe("catalog selectors", () => {
  it("does not double-prefix ids that already carry their backend (OpenCode)", async () => {
    const catalog = new ModelCatalog();
    const opencode = fakeBackend("opencode", ["opencode/big-pickle"], async (id) => completion(id));
    await catalog.refresh([opencode]);
    expect(catalog.ranked()).toEqual(["opencode/big-pickle"]);
  });
});
