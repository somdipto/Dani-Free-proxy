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

describe("first run", () => {
  it("ranks models that have answered ahead of never-answered ones", async () => {
    const catalog = new ModelCatalog();
    const kilo = fakeBackend("kilo", ["a:free", "b:free"], async (id) => completion(id));
    await catalog.refresh([kilo]);
    expect(catalog.ranked()).toEqual(["kilo/a:free", "kilo/b:free"]);
    catalog.recordSuccess("kilo/b:free", 100);
    expect(catalog.ranked()).toEqual(["kilo/b:free", "kilo/a:free"]);
  });

  it("a streaming attempt with no first byte moves to the next model", async () => {
    const catalog = new ModelCatalog();
    const hung = fakeBackend("kilo", ["hung:free", "fast:free"], (id) => id === "hung:free"
      ? new Promise<Response>(() => undefined)
      : Promise.resolve(new Response(`data: ${JSON.stringify({ id: "x", model: id, choices: [{ index: 0, delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })));
    const router = createRouter({ adapters: [hung], catalog, probeOnRefresh: false, attemptTimeoutMs: 150, brand: { id: "dani-free-auto", name: "Dani Free Auto" } });
    await router.refreshCatalog();
    const text = await (await router.handle(chat({ stream: true }))).text();
    expect(text).toContain('"content":"hi"');
    expect(hung.calls).toEqual(["hung:free", "fast:free"]);
  });
});

import { FeedbackStore, modelTier, orderForTask, parseTask } from "../src/tasks";

describe("task routing", () => {
  it("parses the task header: missing = none, unknown = reason", () => {
    expect(parseTask(null)).toBeUndefined();
    expect(parseTask("ack")).toBe("ack");
    expect(parseTask("TITLE")).toBe("title");
    expect(parseTask("something-new")).toBe("reason");
  });

  it("tiers models by size and name", () => {
    const tier = (id: string, contextWindow = 200_000) => modelTier({ id, contextWindow });
    expect(tier("liquid/lfm-2.5-2.6b:free", 65_536)).toBe("light");
    expect(tier("qwen/qwen3.8-27b:free")).toBe("ok");
    expect(tier("nvidia/nemotron-3-super-120b-a12b:free")).toBe("strong");
    expect(tier("nex-agi/nex-n2.5-mini:free")).toBe("light");
    expect(tier("nex-agi/nex-n2.5-pro:free")).toBe("strong");
    expect(tier("z-ai/glm-5.2:free", 32_768)).toBe("light");
    expect(tier("big-pickle")).toBe("ok");
  });

  it("reason keeps light models last; title puts them first; ack drops the sidecar and sorts by speed", () => {
    const routes = [
      { model: model("kilo", "tiny-2b:free"), latencyMs: 300 },
      { model: model("opencode", "opencode/big-pickle"), latencyMs: 100 },
      { model: model("kilo", "big-120b:free"), latencyMs: 900 },
    ];
    expect(orderForTask("reason", routes).map((r) => r.model.id)).toEqual(["opencode/big-pickle", "big-120b:free", "tiny-2b:free"]);
    expect(orderForTask("title", routes)[0].model.id).toBe("tiny-2b:free");
    expect(orderForTask("ack", routes).map((r) => r.model.id)).toEqual(["tiny-2b:free", "big-120b:free"]);
    expect(orderForTask("tool_repair", routes)[0].model.id).toBe("big-120b:free");
  });

  it("feedback moves a model at most 30% of the list and only after 20 events", () => {
    const store = new FeedbackStore({ minEvents: 20 });
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    for (let i = 0; i < 25; i++) {
      store.track(`req-bad-${i}0000`, "m0", "reason");
      store.record(`req-bad-${i}0000`, "bad_tool_json");
      store.track(`req-ok-${i}00000`, "m5", "reason");
      store.record(`req-ok-${i}00000`, "ok");
    }
    const out = store.adjust("reason", ids.map((id) => ({ model: model("kilo", id) })), (r) => r.model.id).map((r) => r.model.id);
    expect(out.indexOf("m0")).toBe(3);
    expect(out.length).toBe(10);
    expect(store.adjust("chat", ids.map((id) => ({ model: model("kilo", id) })), (r) => r.model.id).map((r) => r.model.id)).toEqual(ids);
  });

  it("feedback is idempotent and drops unknown request ids", () => {
    const store = new FeedbackStore({ minEvents: 1 });
    store.track("abcdefgh1", "m", "chat");
    expect(store.record("abcdefgh1", "ok")).toBe("recorded");
    expect(store.record("abcdefgh1", "ok")).toBe("duplicate");
    expect(store.record("zzzzzzzz9", "ok")).toBe("unknown_request");
    expect(store.badRate("chat", "m")).toBe(0);
  });
});

describe("api v1 endpoints", () => {
  async function brandRouter(kiloComplete: (id: string) => Promise<Response>, extra: Record<string, unknown> = {}) {
    const catalog = new ModelCatalog();
    const kilo = fakeBackend("kilo", ["slow:free", "fast:free", "third:free"], kiloComplete);
    const router = createRouter({ adapters: [kilo], catalog, probeOnRefresh: false, failoverBackoffMs: 1, brand: { id: "dani-free-auto", name: "Dani Free Auto" }, ...extra });
    await router.refreshCatalog();
    return { router, kilo, catalog };
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`http://local${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("/health reports api 1 and the task list", async () => {
    const { router } = await brandRouter(async (id) => completion(id));
    const health = await (await router.handle(new Request("http://local/health"))).json();
    expect(health.api).toBe(1);
    expect(health.tasks).toEqual(["ack", "reason", "tool_plan", "tool_repair", "summary", "chat", "title"]);
  });

  it("returns a request id and accepts feedback for it, once", async () => {
    const { router } = await brandRouter(async (id) => completion(id));
    const response = await router.handle(chat());
    const id = response.headers.get("x-dani-request-id")!;
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    const first = await router.handle(post("/v1/feedback", { v: 1, request_id: id, task: "chat", outcome: "ok" }), "127.0.0.1");
    expect(first.status).toBe(200);
    expect((await router.handle(post("/v1/feedback", { v: 1, request_id: id, outcome: "ok" }), "127.0.0.1")).status).toBe(200);
    expect((await router.handle(post("/v1/feedback", { v: 1, request_id: id, outcome: "great" }), "127.0.0.1")).status).toBe(400);
    expect((await router.handle(post("/v1/feedback", { v: 1, request_id: id, outcome: "ok" }), "10.0.0.2")).status).toBe(403);
  });

  it("feedback is off in Private mode", async () => {
    const { router } = await brandRouter(async (id) => completion(id), { privateMode: true });
    expect((await router.handle(post("/v1/feedback", { v: 1, request_id: "abcdefgh12", outcome: "ok" }), "127.0.0.1")).status).toBe(204);
  });

  it("ack rejects tools and caps output", async () => {
    let seenMax = 0;
    const { router } = await brandRouter(async (id) => completion(id));
    const refused = await router.handle(chat({ tools: [{ type: "function", function: { name: "x" } }] } as Partial<ChatRequest>));
    expect(refused.status).toBe(200); // no task header: normal auto
    const withTask = new Request("http://local/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-dani-task": "ack" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "x" } }] }),
    });
    const rejected = await router.handle(withTask);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe("tools_not_allowed");
    void seenMax;
  });

  it("ack hedges two routes, first byte wins, loser is cancelled and not marked failed", async () => {
    let slowAborted = false;
    const { router, catalog } = await brandRouter(async (id) => {
      if (id === "slow:free") {
        return new Response(new ReadableStream({ cancel() { slowAborted = true; } }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(`data: ${JSON.stringify({ id: "x", model: id, choices: [{ index: 0, delta: { content: "On it" } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const request = new Request("http://local/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-dani-task": "ack" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "book a table" }] }),
    });
    const response = await router.handle(request);
    const text = await response.text();
    expect(text).toContain("On it");
    expect(text).toContain('"model":"dani-free-auto"');
    await Bun.sleep(10);
    expect(slowAborted).toBe(true);
    expect(catalog.get("kilo/slow:free")!.failures).toBe(0);
  });

  it("ack times out with 504 ack_timeout", async () => {
    const { router } = await brandRouter(() => new Promise<Response>(() => undefined), { ackTimeoutMs: 100 });
    const request = new Request("http://local/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-dani-task": "ack" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const started = Date.now();
    const response = await router.handle(request);
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("ack_timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("warm answers 204 at once", async () => {
    const { router } = await brandRouter(async (id) => completion(id));
    expect((await router.handle(post("/v1/warm", { task: "ack" }))).status).toBe(204);
  });
});
